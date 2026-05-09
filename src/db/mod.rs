use std::collections::HashSet;
use std::path::Path;

use rusqlite::{Connection, params};

use crate::migrations::{MIGRATIONS, Migration};

mod repository;
pub use repository::is_duplicate_repository_path_error;

mod settings;
pub use settings::RepositoryMcpServer;

mod scm;
pub use scm::ScmStatusCacheRow;

mod terminal;
pub use terminal::CLAUDETTE_TERMINAL_TITLE;

mod remote;

mod checkpoint;

mod chat;

mod workspace;
pub use workspace::WORKSPACE_ORDER_MODE_PREFIX;

mod commands;

#[cfg(test)]
pub(crate) mod test_support;

pub struct Database {
    conn: Connection,
}

impl Database {
    pub fn open(path: &Path) -> Result<Self, rusqlite::Error> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                rusqlite::Error::InvalidPath(
                    format!("Failed to create database directory: {e}").into(),
                )
            })?;
        }
        let conn = Connection::open(path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
        let db = Self { conn };
        db.migrate()?;
        Ok(db)
    }

    #[allow(dead_code)]
    pub fn open_in_memory() -> Result<Self, rusqlite::Error> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch("PRAGMA foreign_keys=ON;")?;
        let db = Self { conn };
        db.migrate()?;
        Ok(db)
    }

    /// Execute raw SQL. Intended for test setup only.
    #[cfg(test)]
    pub fn execute_batch(&self, sql: &str) -> Result<(), rusqlite::Error> {
        self.conn.execute_batch(sql)
    }

    /// Re-run migrations. Intended for test setup only — lets a test rewind
    /// the DB to an older `user_version` and exercise a specific migration.
    #[cfg(test)]
    pub fn run_migrations_for_test(&self) -> Result<(), rusqlite::Error> {
        self.migrate()
    }

    fn migrate(&self) -> Result<(), rusqlite::Error> {
        self.bootstrap_and_backfill(MIGRATIONS)?;
        Self::run_migrations(&self.conn, MIGRATIONS)?;
        self.heal_orphaned_sessions()
    }

    /// Ensure `schema_migrations` exists; seed it from `PRAGMA user_version`
    /// on pre-redesign databases. Idempotent: subsequent calls are no-ops.
    fn bootstrap_and_backfill(&self, migrations: &[Migration]) -> Result<(), rusqlite::Error> {
        let table_exists: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master
                           WHERE type='table' AND name='schema_migrations')",
            [],
            |r| r.get(0),
        )?;
        if table_exists {
            return Ok(());
        }

        let legacy_version: i32 = self
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))?;

        let tx = self.conn.unchecked_transaction()?;
        tx.execute_batch(
            "CREATE TABLE schema_migrations (
                 id         TEXT PRIMARY KEY,
                 applied_at TEXT NOT NULL DEFAULT (datetime('now'))
             );",
        )?;
        for m in migrations {
            if let Some(v) = m.legacy_version
                && v <= legacy_version
            {
                tx.execute(
                    "INSERT INTO schema_migrations (id) VALUES (?1)",
                    params![m.id],
                )?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Apply every migration in `migrations` that is not already recorded in
    /// `schema_migrations`. Each migration's SQL and its tracking-row insert
    /// run inside a single transaction, so a failure leaves no partial state.
    fn run_migrations(conn: &Connection, migrations: &[Migration]) -> Result<(), rusqlite::Error> {
        let mut seen: HashSet<&str> = HashSet::with_capacity(migrations.len());
        for m in migrations {
            assert!(
                seen.insert(m.id),
                "duplicate migration id in MIGRATIONS: {}",
                m.id,
            );
        }

        let applied: HashSet<String> = conn
            .prepare("SELECT id FROM schema_migrations")?
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<Result<_, _>>()?;

        for m in migrations {
            if applied.contains(m.id) {
                continue;
            }
            let tx = conn.unchecked_transaction()?;
            match tx.execute_batch(m.sql) {
                Ok(()) => {
                    // `OR IGNORE` makes the ledger write idempotent so two
                    // connections opened during first boot can't wedge each
                    // other on a UNIQUE-constraint failure if both compute
                    // `applied` before either commits.
                    tx.execute(
                        "INSERT OR IGNORE INTO schema_migrations (id) VALUES (?1)",
                        params![m.id],
                    )?;
                    tx.commit()?;
                }
                Err(e) if is_already_exists_error(&e) => {
                    // The schema object the migration tried to create (table /
                    // index / column) is already present — the most common
                    // cause is a developer who hand-applied the SQL or merged
                    // a branch whose migrations they had already run. Drop
                    // the aborted transaction and record the migration as
                    // applied so the runner doesn't wedge the app on every
                    // subsequent boot.
                    drop(tx);
                    eprintln!(
                        "[migrations] {} skipped: schema object already present ({e}); marking applied",
                        m.id,
                    );
                    let tx = conn.unchecked_transaction()?;
                    tx.execute(
                        "INSERT OR IGNORE INTO schema_migrations (id) VALUES (?1)",
                        params![m.id],
                    )?;
                    tx.commit()?;
                }
                Err(e) => return Err(e),
            }
        }
        Ok(())
    }

    fn heal_orphaned_sessions(&self) -> Result<(), rusqlite::Error> {
        let has_orphaned_ws = self
            .conn
            .query_row(
                "SELECT EXISTS(
                     SELECT 1 FROM workspaces w
                     WHERE NOT EXISTS (
                         SELECT 1 FROM chat_sessions cs WHERE cs.workspace_id = w.id
                     )
                 )",
                [],
                |row| row.get::<_, bool>(0),
            )
            .unwrap_or(false);

        if has_orphaned_ws {
            let tx = self.conn.unchecked_transaction()?;
            let orphaned: Vec<(String, Option<String>, i64)> = {
                let mut stmt = tx.prepare(
                    "SELECT w.id, w.session_id, w.turn_count
                     FROM workspaces w
                     WHERE NOT EXISTS (
                         SELECT 1 FROM chat_sessions cs WHERE cs.workspace_id = w.id
                     )",
                )?;
                stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
                    .collect::<Result<Vec<_>, _>>()?
            };
            for (ws_id, claude_sid, tc) in &orphaned {
                let sid = uuid::Uuid::new_v4().to_string();
                tx.execute(
                    "INSERT INTO chat_sessions
                        (id, workspace_id, session_id, name, name_edited,
                         turn_count, sort_order, status)
                     VALUES (?1, ?2, ?3, 'Main', 0, ?4, 0, 'active')",
                    params![sid, ws_id, claude_sid, tc],
                )?;
                tx.execute(
                    "UPDATE chat_messages SET chat_session_id = ?1
                     WHERE workspace_id = ?2 AND chat_session_id IS NULL",
                    params![sid, ws_id],
                )?;
                tx.execute(
                    "UPDATE conversation_checkpoints SET chat_session_id = ?1
                     WHERE workspace_id = ?2 AND chat_session_id IS NULL",
                    params![sid, ws_id],
                )?;
            }
            tx.commit()?;
        }

        let has_null_sessions: bool = self
            .conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM chat_messages WHERE chat_session_id IS NULL)",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);

        if has_null_sessions {
            self.conn.execute_batch(
                "UPDATE chat_messages SET chat_session_id = (
                     SELECT cs.id FROM chat_sessions cs
                     WHERE cs.workspace_id = chat_messages.workspace_id
                     ORDER BY cs.sort_order, cs.created_at LIMIT 1
                 )
                 WHERE chat_session_id IS NULL;

                 UPDATE conversation_checkpoints SET chat_session_id = (
                     SELECT cs.id FROM chat_sessions cs
                     WHERE cs.workspace_id = conversation_checkpoints.workspace_id
                     ORDER BY cs.sort_order, cs.created_at LIMIT 1
                 )
                 WHERE chat_session_id IS NULL;",
            )?;
        }

        Ok(())
    }
}

#[cfg(test)]
impl Database {
    /// Test-only accessor: expose the underlying connection for setup needs
    /// that don't fit `execute_batch` (e.g. parameterized queries).
    pub fn conn(&self) -> &Connection {
        &self.conn
    }

    /// Test-only: run the migration runner against a caller-supplied slice.
    /// Used to inject synthetic migrations for error-path and ordering tests.
    pub fn migrate_with(&self, migrations: &[Migration]) -> Result<(), rusqlite::Error> {
        self.bootstrap_and_backfill(migrations)?;
        Self::run_migrations(&self.conn, migrations)
    }
}

/// Returns true when `err` is a benign "object already exists" failure from a
/// DDL statement: `CREATE TABLE/INDEX/VIEW/TRIGGER` against an existing
/// object, or `ALTER TABLE ADD COLUMN` against an existing column. SQLite
/// reports all of these under the generic primary code `SQLITE_ERROR` (which
/// rusqlite maps to `ErrorCode::Unknown`), so we additionally match on the
/// message text. The error can surface as either `SqliteFailure` (step-time)
/// or `SqlInputError` (prepare-time, on `modern_sqlite` builds), so both
/// variants are checked.
fn is_already_exists_error(err: &rusqlite::Error) -> bool {
    let (code, msg) = match err {
        rusqlite::Error::SqliteFailure(code, Some(msg)) => (code.code, msg.as_str()),
        rusqlite::Error::SqlInputError { error, msg, .. } => (error.code, msg.as_str()),
        _ => return false,
    };
    if code != rusqlite::ErrorCode::Unknown {
        return false;
    }
    msg.contains("already exists") || msg.contains("duplicate column name")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::*;

    // --- Migration runner tests ---

    fn count_applied(db: &Database) -> i64 {
        db.conn()
            .query_row("SELECT COUNT(*) FROM schema_migrations", [], |r| r.get(0))
            .unwrap()
    }

    fn applied_ids(db: &Database) -> Vec<String> {
        let mut stmt = db
            .conn()
            .prepare("SELECT id FROM schema_migrations ORDER BY id")
            .unwrap();
        stmt.query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    }

    /// Apply the SQL bodies of the first N pre-redesign migrations directly,
    /// then set `PRAGMA user_version = N`, producing a DB that looks exactly
    /// like one from before the redesign at that version.
    fn build_legacy_db_at_version(n: i32) -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        for m in MIGRATIONS.iter().take(n as usize) {
            conn.execute_batch(m.sql).unwrap();
        }
        conn.execute_batch(&format!("PRAGMA user_version = {n};"))
            .unwrap();
        conn
    }

    #[test]
    fn test_migrations_unique_ids() {
        let mut seen = HashSet::new();
        for m in MIGRATIONS {
            assert!(
                seen.insert(m.id),
                "duplicate migration id in MIGRATIONS: {}",
                m.id,
            );
        }
    }

    #[test]
    fn test_migrations_timestamp_prefix_format() {
        for m in MIGRATIONS {
            let prefix: String = m.id.chars().take(14).collect();
            assert_eq!(
                prefix.len(),
                14,
                "migration id too short, expected 14-digit timestamp prefix: {}",
                m.id,
            );
            assert!(
                prefix.chars().all(|c| c.is_ascii_digit()),
                "migration id must start with 14 ASCII digits: {}",
                m.id,
            );
            assert_eq!(
                m.id.chars().nth(14),
                Some('_'),
                "migration id must have underscore after timestamp: {}",
                m.id,
            );
        }
    }

    #[test]
    fn test_fresh_db_applies_all_migrations() {
        let db = Database::open_in_memory().unwrap();
        assert_eq!(count_applied(&db) as usize, MIGRATIONS.len());
    }

    /// Pin the keybinding rename: after the renaming migration runs,
    /// any user-customized override of `keybinding:file-viewer.close-file-tab`
    /// must land at `keybinding:global.close-tab` and the legacy key
    /// must be gone. The migration is run as part of `Database::open_in_memory`
    /// alongside everything else, so this test seeds the *prior* state
    /// by inserting the legacy row and re-running the migration's SQL
    /// directly — exercising the same INSERT OR IGNORE / DELETE pair
    /// the runtime applies.
    #[test]
    fn test_close_tab_keybinding_rename_migration() {
        let db = Database::open_in_memory().unwrap();
        // Seed the legacy row that an existing user would have had
        // before pulling this build.
        db.conn()
            .execute(
                "INSERT INTO app_settings (key, value) VALUES (?1, ?2)",
                params!["keybinding:file-viewer.close-file-tab", "mod+x"],
            )
            .unwrap();
        // Re-execute the migration body. INSERT OR IGNORE is the
        // important guard — a user who already has a custom binding on
        // the new id keeps it; only orphaned legacy rows are migrated.
        let migration_sql =
            include_str!("../migrations/20260509000540_rename_close_file_tab_keybinding.sql");
        db.conn().execute_batch(migration_sql).unwrap();

        let new_value: Option<String> = db
            .conn()
            .query_row(
                "SELECT value FROM app_settings WHERE key = 'keybinding:global.close-tab'",
                [],
                |r| r.get(0),
            )
            .ok();
        assert_eq!(new_value.as_deref(), Some("mod+x"));

        let legacy_present: bool = db
            .conn()
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM app_settings WHERE key = 'keybinding:file-viewer.close-file-tab')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(!legacy_present, "legacy row must be removed");
    }

    /// `INSERT OR IGNORE` semantics: an explicit override under the
    /// new id wins over the legacy value when both are present (e.g.
    /// a user who customised the binding across both versions). The
    /// legacy row is still removed afterward.
    #[test]
    fn test_close_tab_keybinding_rename_preserves_existing_new_id() {
        let db = Database::open_in_memory().unwrap();
        db.conn()
            .execute_batch(
                "INSERT INTO app_settings (key, value) VALUES \
                 ('keybinding:file-viewer.close-file-tab', 'legacy-value'), \
                 ('keybinding:global.close-tab', 'new-value');",
            )
            .unwrap();
        let migration_sql =
            include_str!("../migrations/20260509000540_rename_close_file_tab_keybinding.sql");
        db.conn().execute_batch(migration_sql).unwrap();

        let new_value: String = db
            .conn()
            .query_row(
                "SELECT value FROM app_settings WHERE key = 'keybinding:global.close-tab'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            new_value, "new-value",
            "explicit new-id override must not be clobbered by INSERT OR IGNORE",
        );
    }

    #[test]
    fn test_migrate_is_idempotent() {
        let db = Database::open_in_memory().unwrap();
        let before = count_applied(&db);
        // Re-invoke — same MIGRATIONS slice, already-applied rows must be skipped.
        db.migrate_with(MIGRATIONS).unwrap();
        assert_eq!(before, count_applied(&db));
    }

    #[test]
    fn test_backfill_from_user_version_19() {
        let conn = build_legacy_db_at_version(19);
        let db = Database { conn };
        db.migrate().unwrap();

        let ids = applied_ids(&db);
        assert_eq!(ids.len(), MIGRATIONS.len());
        for m in MIGRATIONS {
            assert!(
                ids.contains(&m.id.to_string()),
                "missing backfilled id: {}",
                m.id,
            );
        }
    }

    #[test]
    fn test_backfill_from_user_version_0() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        let db = Database { conn };
        db.migrate().unwrap();
        assert_eq!(count_applied(&db) as usize, MIGRATIONS.len());
    }

    #[test]
    fn test_partial_backfill_from_mid_version() {
        let conn = build_legacy_db_at_version(10);
        let db = Database { conn };
        db.migrate().unwrap();

        // All 19 legacy + none extra: migrations 1-10 got backfilled rows,
        // 11-19 ran for real as fresh migrations. Either way the final row
        // count is MIGRATIONS.len() and all IDs are present.
        assert_eq!(count_applied(&db) as usize, MIGRATIONS.len());
        for m in MIGRATIONS {
            let present: bool = db
                .conn()
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE id = ?1)",
                    params![m.id],
                    |r| r.get(0),
                )
                .unwrap();
            assert!(present, "id not present after partial backfill: {}", m.id);
        }
    }

    #[test]
    fn test_skips_already_applied_migration() {
        // Synthetic migration: inject an id into schema_migrations and point
        // its SQL at something that would fail if re-run. The runner must
        // skip it because the id is already present.
        let db = Database::open_in_memory().unwrap();
        let synthetic = [Migration {
            id: "29991231235959_synthetic_broken_sql",
            sql: "this is not valid sql and would fail if executed",
            legacy_version: None,
        }];
        db.conn()
            .execute(
                "INSERT INTO schema_migrations (id) VALUES (?1)",
                params![synthetic[0].id],
            )
            .unwrap();
        db.migrate_with(&synthetic).unwrap();
    }

    #[test]
    fn test_migration_failure_is_atomic() {
        let db = Database::open_in_memory().unwrap();
        let bad = [Migration {
            id: "29991231235959_synthetic_bad",
            sql: "ALTER TABLE does_not_exist ADD COLUMN x INTEGER;",
            legacy_version: None,
        }];
        let err = db.migrate_with(&bad);
        assert!(err.is_err(), "expected migration failure to bubble up");

        let present: bool = db
            .conn()
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE id = ?1)",
                params![bad[0].id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            !present,
            "failed migration must not leave tracking row in schema_migrations",
        );
    }

    #[test]
    fn test_migration_skips_when_table_already_exists() {
        // Simulates the dev case: a migration's CREATE TABLE targets an object
        // a developer already created out of band. The runner must mark the
        // migration applied and continue, not propagate the error.
        let db = Database::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE dup_t (x INTEGER);").unwrap();
        let synthetic = [Migration {
            id: "29991231235959_synthetic_dup_table",
            sql: "CREATE TABLE dup_t (x INTEGER);",
            legacy_version: None,
        }];
        db.migrate_with(&synthetic)
            .expect("already-exists must be tolerated");
        let present: bool = db
            .conn()
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE id = ?1)",
                params![synthetic[0].id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            present,
            "tolerated migration must still be recorded in schema_migrations",
        );
    }

    #[test]
    fn test_migration_skips_when_column_already_exists() {
        // `repositories.icon` is added by the released migration #3, so it's
        // present after `open_in_memory`. A synthetic migration that tries to
        // add it again must be tolerated.
        let db = Database::open_in_memory().unwrap();
        let synthetic = [Migration {
            id: "29991231235959_synthetic_dup_column",
            sql: "ALTER TABLE repositories ADD COLUMN icon TEXT;",
            legacy_version: None,
        }];
        db.migrate_with(&synthetic)
            .expect("duplicate column must be tolerated");
        let present: bool = db
            .conn()
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE id = ?1)",
                params![synthetic[0].id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(present);
    }

    #[test]
    fn test_migration_propagates_non_already_exists_errors() {
        // Real schema mistakes (here: targeting a missing table) must still
        // surface as errors — leniency is scoped to "already exists" /
        // "duplicate column name" only.
        let db = Database::open_in_memory().unwrap();
        let bad = [Migration {
            id: "29991231235959_synthetic_no_such_table",
            sql: "INSERT INTO __no_such_table__ VALUES (1);",
            legacy_version: None,
        }];
        let err = db.migrate_with(&bad);
        assert!(err.is_err(), "non-tolerable errors must bubble up");
        let present: bool = db
            .conn()
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE id = ?1)",
                params![bad[0].id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(!present);
    }

    /// Regression: dev DBs that ran migration `20260505214219` before
    /// commit `2fc1b316` amended its SQL recorded the migration id as
    /// applied without ever picking up the late-added
    /// `agent_tool_calls_json` column. The follow-up healing migration
    /// `20260506170933_heal_turn_tool_activity_agent_tool_calls_json`
    /// restores the column on those DBs and is a no-op (via the
    /// runner's "already exists" leniency) on clean installs.
    #[test]
    fn test_heal_migration_restores_missing_agent_tool_calls_json_column() {
        let db = Database::open_in_memory().unwrap();

        // Simulate the broken state: drop the column that the amended
        // migration was supposed to add, and forget that the healing
        // migration ever ran so the runner replays it.
        db.execute_batch("ALTER TABLE turn_tool_activities DROP COLUMN agent_tool_calls_json;")
            .unwrap();
        db.conn()
            .execute(
                "DELETE FROM schema_migrations WHERE id = ?1",
                params!["20260506170933_heal_turn_tool_activity_agent_tool_calls_json"],
            )
            .unwrap();
        let column_exists = |name: &str| -> bool {
            db.conn()
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('turn_tool_activities') WHERE name = ?1",
                    params![name],
                    |r| r.get::<_, i64>(0),
                )
                .unwrap()
                > 0
        };
        assert!(!column_exists("agent_tool_calls_json"));

        // Re-running the canonical migrations should now heal the DB.
        db.run_migrations_for_test()
            .expect("healing migration must apply cleanly");
        assert!(column_exists("agent_tool_calls_json"));

        // And running it a second time on a healed DB must remain a
        // no-op via the runner's duplicate-column leniency.
        db.run_migrations_for_test()
            .expect("healing migration must be idempotent");
        assert!(column_exists("agent_tool_calls_json"));
    }

    #[test]
    fn test_is_already_exists_error_classifier() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE t (a INTEGER, b INTEGER UNIQUE);")
            .unwrap();

        // CREATE TABLE over an existing table.
        let err = conn
            .execute_batch("CREATE TABLE t (a INTEGER);")
            .unwrap_err();
        assert!(
            super::is_already_exists_error(&err),
            "expected duplicate-table error to be tolerated, got {err:?}",
        );

        // ALTER TABLE ADD COLUMN over an existing column.
        let err = conn
            .execute_batch("ALTER TABLE t ADD COLUMN a INTEGER;")
            .unwrap_err();
        assert!(
            super::is_already_exists_error(&err),
            "expected duplicate-column error to be tolerated, got {err:?}",
        );

        // CREATE INDEX over an existing index.
        conn.execute_batch("CREATE INDEX idx_t_a ON t(a);").unwrap();
        let err = conn
            .execute_batch("CREATE INDEX idx_t_a ON t(a);")
            .unwrap_err();
        assert!(
            super::is_already_exists_error(&err),
            "expected duplicate-index error to be tolerated, got {err:?}",
        );

        // No such table — must NOT be tolerated.
        let err = conn
            .execute_batch("INSERT INTO __no_such_table__ VALUES (1);")
            .unwrap_err();
        assert!(
            !super::is_already_exists_error(&err),
            "no-such-table is not an already-exists case, got {err:?}",
        );

        // UNIQUE constraint violation — must NOT be tolerated (different
        // primary code).
        conn.execute_batch("INSERT INTO t (a, b) VALUES (1, 1);")
            .unwrap();
        let err = conn
            .execute_batch("INSERT INTO t (a, b) VALUES (2, 1);")
            .unwrap_err();
        assert!(
            !super::is_already_exists_error(&err),
            "constraint violations are not already-exists, got {err:?}",
        );
    }

    #[test]
    fn test_chat_sessions_migration_backfills_sessions() {
        let db = Database::open_in_memory().unwrap();

        // Rewind: drop chat_sessions structures and remove the migration
        // tracking row so re-running migrations will re-apply it. We also
        // re-add the legacy `workspaces.session_id` / `workspaces.turn_count`
        // columns (dropped by 20260508142050) and clear that migration's
        // bookkeeping so its second run drops them again — this test
        // specifically exercises the original chat_sessions backfill, which
        // depends on the legacy columns being present at run time.
        db.execute_batch(
            "PRAGMA foreign_keys=OFF;
             DROP INDEX IF EXISTS idx_chat_messages_chat_session;
             DROP INDEX IF EXISTS idx_checkpoints_chat_session;
             DROP INDEX IF EXISTS idx_chat_sessions_ws;
             DROP INDEX IF EXISTS idx_chat_sessions_active;
             ALTER TABLE chat_messages DROP COLUMN chat_session_id;
             ALTER TABLE conversation_checkpoints DROP COLUMN chat_session_id;
             DROP TABLE chat_sessions;
             ALTER TABLE workspaces ADD COLUMN session_id TEXT;
             ALTER TABLE workspaces ADD COLUMN turn_count INTEGER NOT NULL DEFAULT 0;
             DELETE FROM schema_migrations WHERE id = '20260422000000_chat_sessions';
             DELETE FROM schema_migrations WHERE id = '20260508142050_drop_legacy_workspace_session_columns';
             PRAGMA foreign_keys=ON;",
        )
        .unwrap();

        // Seed: repo + two workspaces, one with an existing claude session
        // and turn count + messages + checkpoint; one fresh.
        db.insert_repository(&make_repo("r1", "/tmp/repo1", "repo1"))
            .unwrap();
        db.execute_batch(
            "INSERT INTO workspaces (id, repository_id, name, branch_name, worktree_path, status, status_line)
                 VALUES ('w1', 'r1', 'first-ws', 'r1/first-ws', NULL, 'active', '');
             INSERT INTO workspaces (id, repository_id, name, branch_name, worktree_path, status, status_line)
                 VALUES ('w2', 'r1', 'second-ws', 'r1/second-ws', NULL, 'active', '');
             UPDATE workspaces SET session_id = 'claude-abc', turn_count = 3 WHERE id = 'w1';
             INSERT INTO chat_messages (id, workspace_id, role, content)
                 VALUES ('m1', 'w1', 'user', 'hello');
             INSERT INTO chat_messages (id, workspace_id, role, content)
                 VALUES ('m2', 'w1', 'assistant', 'hi');
             INSERT INTO conversation_checkpoints (id, workspace_id, message_id, turn_index)
                 VALUES ('cp1', 'w1', 'm2', 0);",
        )
        .unwrap();

        // Re-run migrations — the chat_sessions migration should re-apply.
        db.run_migrations_for_test().unwrap();

        struct SessionRow {
            id: String,
            workspace_id: String,
            session_id: Option<String>,
            name: String,
            turn_count: i64,
            sort_order: i32,
            status: String,
        }

        // Both workspaces should now have exactly one "Main" session.
        let session_rows: Vec<SessionRow> = {
            let mut stmt = db
                .conn()
                .prepare(
                    "SELECT id, workspace_id, session_id, name, turn_count, sort_order, status
                     FROM chat_sessions ORDER BY workspace_id",
                )
                .unwrap();
            stmt.query_map([], |row| {
                Ok(SessionRow {
                    id: row.get(0)?,
                    workspace_id: row.get(1)?,
                    session_id: row.get(2)?,
                    name: row.get(3)?,
                    turn_count: row.get(4)?,
                    sort_order: row.get(5)?,
                    status: row.get(6)?,
                })
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
        };
        assert_eq!(session_rows.len(), 2);
        // w1: claude session and turn count forwarded.
        let w1 = session_rows
            .iter()
            .find(|r| r.workspace_id == "w1")
            .unwrap();
        assert_eq!(w1.session_id.as_deref(), Some("claude-abc"));
        assert_eq!(w1.name, "Main");
        assert_eq!(w1.turn_count, 3);
        assert_eq!(w1.sort_order, 0);
        assert_eq!(w1.status, "active");
        // w2: empty session + zero turns.
        let w2 = session_rows
            .iter()
            .find(|r| r.workspace_id == "w2")
            .unwrap();
        assert!(w2.session_id.is_none());
        assert_eq!(w2.turn_count, 0);

        // Messages and checkpoint point at w1's chat session.
        let w1_chat_session_id = w1.id.clone();
        let msg_sessions: Vec<Option<String>> = db
            .conn()
            .prepare("SELECT chat_session_id FROM chat_messages WHERE workspace_id = 'w1'")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(msg_sessions.len(), 2);
        assert!(
            msg_sessions
                .iter()
                .all(|s| s.as_deref() == Some(&w1_chat_session_id))
        );

        let cp_session: Option<String> = db
            .conn()
            .query_row(
                "SELECT chat_session_id FROM conversation_checkpoints WHERE id = 'cp1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(cp_session.as_deref(), Some(w1_chat_session_id.as_str()));
    }

    #[test]
    fn test_save_chat_session_state_persists_session_id() {
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1", "/tmp/repo1", "repo1"))
            .unwrap();
        db.insert_workspace(&make_workspace("w1", "r1", "ws"))
            .unwrap();
        let sess = db.create_chat_session("w1").unwrap();
        assert!(sess.session_id.is_none());

        db.save_chat_session_state(&sess.id, "claude-sid-1", 3)
            .unwrap();
        let reloaded = db.get_chat_session(&sess.id).unwrap().unwrap();
        assert_eq!(reloaded.session_id.as_deref(), Some("claude-sid-1"));
        assert_eq!(reloaded.turn_count, 3);
    }

    #[test]
    fn test_archive_chat_session_ensuring_active_creates_replacement() {
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1", "/tmp/repo1", "repo1"))
            .unwrap();
        db.insert_workspace(&make_workspace("w1", "r1", "ws"))
            .unwrap();
        // insert_workspace auto-creates one active session — archive it.
        let only = db
            .list_chat_sessions_for_workspace("w1", false)
            .unwrap()
            .into_iter()
            .next()
            .unwrap();

        let fresh = db
            .archive_chat_session_ensuring_active(&only.id, "w1")
            .unwrap();
        let fresh = fresh.expect("replacement session must be created");
        assert_ne!(fresh.id, only.id);

        let actives = db.list_chat_sessions_for_workspace("w1", false).unwrap();
        assert_eq!(actives.len(), 1);
        assert_eq!(actives[0].id, fresh.id);
    }

    #[test]
    fn test_archive_chat_session_ensuring_active_skips_when_siblings_exist() {
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1", "/tmp/repo1", "repo1"))
            .unwrap();
        db.insert_workspace(&make_workspace("w1", "r1", "ws"))
            .unwrap();
        let first = db
            .list_chat_sessions_for_workspace("w1", false)
            .unwrap()
            .into_iter()
            .next()
            .unwrap();
        let _second = db.create_chat_session("w1").unwrap();

        let fresh = db
            .archive_chat_session_ensuring_active(&first.id, "w1")
            .unwrap();
        assert!(
            fresh.is_none(),
            "should not create a replacement when siblings remain",
        );
        let actives = db.list_chat_sessions_for_workspace("w1", false).unwrap();
        assert_eq!(actives.len(), 1);
    }
}
