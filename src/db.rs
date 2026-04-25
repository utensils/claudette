use std::collections::HashSet;
use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};

use serde::{Deserialize, Serialize};

use crate::migrations::{MIGRATIONS, Migration};
use crate::model::{
    AgentStatus, Attachment, AttachmentOrigin, ChatMessage, ChatSession, CheckpointFile,
    CompletedTurnData, ConversationCheckpoint, PinnedCommand, RemoteConnection, Repository,
    TerminalTab, TurnToolActivity, Workspace, WorkspaceStatus,
};

fn row_to_attachment(row: &rusqlite::Row) -> rusqlite::Result<Attachment> {
    let data: Vec<u8> = row.get(4)?;
    let origin_str: String = row.get(9)?;
    Ok(Attachment {
        id: row.get(0)?,
        message_id: row.get(1)?,
        filename: row.get(2)?,
        media_type: row.get(3)?,
        size_bytes: row.get(7)?,
        data,
        width: row.get(5)?,
        height: row.get(6)?,
        created_at: row.get(8)?,
        origin: AttachmentOrigin::from_sql_str(&origin_str),
        tool_use_id: row.get(10)?,
    })
}

const ATTACHMENT_COLUMNS: &str = "id, message_id, filename, media_type, data, width, height, size_bytes, created_at, origin, tool_use_id";

/// Persisted SCM status for a workspace, loaded on app startup for instant display.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScmStatusCacheRow {
    pub workspace_id: String,
    pub repo_id: String,
    pub branch_name: String,
    pub provider: Option<String>,
    pub pr_json: Option<String>,
    pub ci_json: Option<String>,
    pub error: Option<String>,
    pub fetched_at: String,
}

/// A saved MCP server configuration for a repository.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepositoryMcpServer {
    pub id: String,
    pub repository_id: String,
    pub name: String,
    pub config_json: String,
    pub source: String,
    pub created_at: String,
    pub enabled: bool,
}

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

/// Returns true when `err` is the SQLite `UNIQUE` constraint failure on
/// `repositories.path` — i.e. the caller tried to insert a repo whose path
/// is already registered. Other constraint failures (including UNIQUE on
/// other columns) return false.
pub fn is_duplicate_repository_path_error(err: &rusqlite::Error) -> bool {
    if let rusqlite::Error::SqliteFailure(code, Some(msg)) = err {
        code.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE
            && msg.contains("repositories.path")
    } else {
        false
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

impl Database {
    // --- Repositories ---

    pub fn insert_repository(&self, repo: &Repository) -> Result<(), rusqlite::Error> {
        // New repos append at the end of the list.
        let max_order: i32 = self
            .conn
            .query_row(
                "SELECT COALESCE(MAX(sort_order), -1) FROM repositories",
                [],
                |row| row.get(0),
            )
            .unwrap_or(-1);
        self.conn.execute(
            "INSERT INTO repositories (id, path, name, path_slug, sort_order)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![repo.id, repo.path, repo.name, repo.path_slug, max_order + 1],
        )?;
        Ok(())
    }

    fn parse_repo_row(row: &rusqlite::Row) -> rusqlite::Result<Repository> {
        Ok(Repository {
            id: row.get(0)?,
            path: row.get(1)?,
            name: row.get(2)?,
            icon: row.get(3)?,
            path_slug: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
            created_at: row.get(5)?,
            setup_script: row.get(6)?,
            custom_instructions: row.get(7)?,
            sort_order: row.get(8)?,
            branch_rename_preferences: row.get(9)?,
            setup_script_auto_run: row.get::<_, i32>(10).unwrap_or(0) != 0,
            base_branch: row.get(11)?,
            default_remote: row.get(12)?,
            path_valid: true, // validated after load
        })
    }

    pub fn list_repositories(&self) -> Result<Vec<Repository>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, path, name, icon, path_slug, created_at, setup_script, custom_instructions, sort_order, branch_rename_preferences, setup_script_auto_run, base_branch, default_remote
             FROM repositories ORDER BY sort_order, name",
        )?;
        let rows = stmt.query_map([], Self::parse_repo_row)?;
        rows.collect()
    }

    pub fn get_repository(&self, id: &str) -> Result<Option<Repository>, rusqlite::Error> {
        self.conn
            .query_row(
                "SELECT id, path, name, icon, path_slug, created_at, setup_script, custom_instructions, sort_order, branch_rename_preferences, setup_script_auto_run, base_branch, default_remote
                 FROM repositories WHERE id = ?1",
                params![id],
                Self::parse_repo_row,
            )
            .optional()
    }

    pub fn update_repository_path(&self, id: &str, path: &str) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE repositories SET path = ?1 WHERE id = ?2",
            params![path, id],
        )?;
        Ok(())
    }

    /// Batch-update sort_order for repositories based on the provided ID order.
    pub fn reorder_repositories(&self, ids: &[String]) -> Result<(), rusqlite::Error> {
        let tx = self.conn.unchecked_transaction()?;
        {
            let mut stmt = tx.prepare("UPDATE repositories SET sort_order = ?1 WHERE id = ?2")?;
            for (i, id) in ids.iter().enumerate() {
                stmt.execute(params![i as i32, id])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn delete_repository(&self, id: &str) -> Result<(), rusqlite::Error> {
        self.conn
            .execute("DELETE FROM repositories WHERE id = ?1", params![id])?;
        Ok(())
    }

    #[allow(dead_code)]
    pub fn update_repository_name(&self, id: &str, name: &str) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE repositories SET name = ?1 WHERE id = ?2",
            params![name, id],
        )?;
        Ok(())
    }

    #[allow(dead_code)]
    pub fn update_repository_icon(
        &self,
        id: &str,
        icon: Option<&str>,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE repositories SET icon = ?1 WHERE id = ?2",
            params![icon, id],
        )?;
        Ok(())
    }

    pub fn update_repository_setup_script(
        &self,
        id: &str,
        script: Option<&str>,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE repositories SET setup_script = ?1 WHERE id = ?2",
            params![script, id],
        )?;
        Ok(())
    }

    pub fn update_repository_setup_script_auto_run(
        &self,
        id: &str,
        enabled: bool,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE repositories SET setup_script_auto_run = ?1 WHERE id = ?2",
            params![enabled as i32, id],
        )?;
        Ok(())
    }

    pub fn update_repository_base_branch(
        &self,
        id: &str,
        base_branch: Option<&str>,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE repositories SET base_branch = ?1 WHERE id = ?2",
            params![base_branch, id],
        )?;
        Ok(())
    }

    pub fn update_repository_default_remote(
        &self,
        id: &str,
        default_remote: Option<&str>,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE repositories SET default_remote = ?1 WHERE id = ?2",
            params![default_remote, id],
        )?;
        Ok(())
    }

    pub fn update_repository_custom_instructions(
        &self,
        id: &str,
        instructions: Option<&str>,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE repositories SET custom_instructions = ?1 WHERE id = ?2",
            params![instructions, id],
        )?;
        Ok(())
    }

    pub fn update_repository_branch_rename_preferences(
        &self,
        id: &str,
        preferences: Option<&str>,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE repositories SET branch_rename_preferences = ?1 WHERE id = ?2",
            params![preferences, id],
        )?;
        Ok(())
    }

    // --- App Settings ---

    #[allow(dead_code)]
    pub fn get_app_setting(&self, key: &str) -> Result<Option<String>, rusqlite::Error> {
        let mut stmt = self
            .conn
            .prepare("SELECT value FROM app_settings WHERE key = ?1")?;
        let mut rows = stmt.query(params![key])?;
        match rows.next()? {
            Some(row) => Ok(Some(row.get(0)?)),
            None => Ok(None),
        }
    }

    #[allow(dead_code)]
    pub fn set_app_setting(&self, key: &str, value: &str) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT OR REPLACE INTO app_settings (key, value) VALUES (?1, ?2)",
            params![key, value],
        )?;
        Ok(())
    }

    /// Delete a single app setting. Returns Ok(()) whether the key
    /// existed or not — callers using "absent means default" semantics
    /// (e.g. env-provider enable/disable) don't care.
    pub fn delete_app_setting(&self, key: &str) -> Result<(), rusqlite::Error> {
        self.conn
            .execute("DELETE FROM app_settings WHERE key = ?1", params![key])?;
        Ok(())
    }

    /// Return every `(key, value)` whose key starts with `prefix`.
    /// Used by features that namespace many related settings under one
    /// prefix (e.g. per-provider env-provider enable flags) and need to
    /// enumerate them efficiently.
    pub fn list_app_settings_with_prefix(
        &self,
        prefix: &str,
    ) -> Result<Vec<(String, String)>, rusqlite::Error> {
        // Escape LIKE metacharacters so a prefix containing % or _ doesn't
        // accidentally match unrelated keys. ESCAPE '\' designates the
        // backslash as the literal-escape marker.
        let escaped: String = prefix
            .chars()
            .flat_map(|c| match c {
                '%' | '_' | '\\' => vec!['\\', c],
                _ => vec![c],
            })
            .collect();
        let pattern = format!("{escaped}%");
        let mut stmt = self.conn.prepare(
            "SELECT key, value FROM app_settings WHERE key LIKE ?1 ESCAPE '\\' ORDER BY key",
        )?;
        let rows = stmt.query_map(params![pattern], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect()
    }

    // --- Workspaces ---

    pub fn insert_workspace(&self, ws: &Workspace) -> Result<(), rusqlite::Error> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO workspaces (id, repository_id, name, branch_name, worktree_path, status, status_line)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                ws.id,
                ws.repository_id,
                ws.name,
                ws.branch_name,
                ws.worktree_path,
                ws.status.as_str(),
                ws.status_line,
            ],
        )?;
        // Every workspace starts with one active session so the multi-session
        // invariant (≥1 active session per workspace) holds from creation.
        tx.execute(
            "INSERT INTO chat_sessions
                (id, workspace_id, session_id, name, name_edited,
                 turn_count, sort_order, status)
             VALUES (?1, ?2, NULL, 'New chat', 0, 0, 0, 'active')",
            params![uuid::Uuid::new_v4().to_string(), ws.id],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Insert multiple workspaces atomically. All succeed or none are committed.
    /// Each workspace is seeded with one active chat session.
    pub fn insert_workspaces_batch(&self, workspaces: &[Workspace]) -> Result<(), rusqlite::Error> {
        let tx = self.conn.unchecked_transaction()?;
        {
            let mut ws_stmt = tx.prepare(
                "INSERT INTO workspaces (id, repository_id, name, branch_name, worktree_path, status, status_line)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?;
            let mut session_stmt = tx.prepare(
                "INSERT INTO chat_sessions
                    (id, workspace_id, session_id, name, name_edited,
                     turn_count, sort_order, status)
                 VALUES (?1, ?2, NULL, 'New chat', 0, 0, 0, 'active')",
            )?;
            for ws in workspaces {
                ws_stmt.execute(params![
                    ws.id,
                    ws.repository_id,
                    ws.name,
                    ws.branch_name,
                    ws.worktree_path,
                    ws.status.as_str(),
                    ws.status_line,
                ])?;
                session_stmt.execute(params![uuid::Uuid::new_v4().to_string(), ws.id])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn list_workspaces(&self) -> Result<Vec<Workspace>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, repository_id, name, branch_name, worktree_path, status, status_line, created_at
             FROM workspaces ORDER BY created_at",
        )?;
        let rows = stmt.query_map([], |row| {
            let status_str: String = row.get(5)?;
            let status: WorkspaceStatus = status_str.parse().unwrap();
            let agent_status = if status == WorkspaceStatus::Archived {
                crate::model::AgentStatus::Stopped
            } else {
                crate::model::AgentStatus::Idle
            };
            Ok(Workspace {
                id: row.get(0)?,
                repository_id: row.get(1)?,
                name: row.get(2)?,
                branch_name: row.get(3)?,
                worktree_path: row.get(4)?,
                status,
                agent_status,
                status_line: row.get(6)?,
                created_at: row.get(7)?,
            })
        })?;
        rows.collect()
    }

    pub fn update_workspace_status(
        &self,
        id: &str,
        status: &WorkspaceStatus,
        worktree_path: Option<&str>,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE workspaces SET status = ?1, worktree_path = ?2 WHERE id = ?3",
            params![status.as_str(), worktree_path, id],
        )?;
        Ok(())
    }

    /// Persist agent session state so it survives app restarts.
    pub fn save_agent_session(
        &self,
        workspace_id: &str,
        session_id: &str,
        turn_count: u32,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE workspaces SET session_id = ?1, turn_count = ?2 WHERE id = ?3",
            params![session_id, turn_count, workspace_id],
        )?;
        Ok(())
    }

    /// Load persisted agent session state. Returns `(session_id, turn_count)`.
    pub fn get_agent_session(
        &self,
        workspace_id: &str,
    ) -> Result<Option<(String, u32)>, rusqlite::Error> {
        self.conn
            .query_row(
                "SELECT session_id, turn_count FROM workspaces WHERE id = ?1",
                params![workspace_id],
                |row| {
                    let sid: Option<String> = row.get(0)?;
                    let tc: u32 = row.get(1)?;
                    Ok(sid.map(|s| (s, tc)))
                },
            )
            .optional()
            .map(|opt| opt.flatten())
    }

    /// Clear persisted agent session (e.g. after a reset or failed init).
    pub fn clear_agent_session(&self, workspace_id: &str) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE workspaces SET session_id = NULL, turn_count = 0 WHERE id = ?1",
            params![workspace_id],
        )?;
        Ok(())
    }

    // --- Metrics: agent session lifecycle ---

    /// Record the start of an agent session. Idempotent (INSERT OR IGNORE) so
    /// that a retried first-turn path doesn't double-insert.
    pub fn insert_agent_session(
        &self,
        session_id: &str,
        workspace_id: &str,
        repository_id: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT OR IGNORE INTO agent_sessions (id, workspace_id, repository_id)
             VALUES (?1, ?2, ?3)",
            params![session_id, workspace_id, repository_id],
        )?;
        Ok(())
    }

    /// Bump turn_count + last_message_at on an in-flight session. No-op if the
    /// session row does not exist (e.g. pre-v20 sessions resumed from state).
    pub fn update_agent_session_turn(
        &self,
        session_id: &str,
        turn_count: u32,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE agent_sessions
             SET turn_count = ?1, last_message_at = datetime('now')
             WHERE id = ?2 AND ended_at IS NULL",
            params![turn_count, session_id],
        )?;
        Ok(())
    }

    /// Return a session's `started_at` timestamp if the row exists.
    /// Used by post-turn commit scraping to bound `git log --since=`.
    pub fn get_agent_session_started_at(
        &self,
        session_id: &str,
    ) -> Result<Option<String>, rusqlite::Error> {
        self.conn
            .query_row(
                "SELECT started_at FROM agent_sessions WHERE id = ?1",
                params![session_id],
                |r| r.get::<_, String>(0),
            )
            .optional()
    }

    /// Mark a session as ended. Idempotent — only updates rows with null
    /// `ended_at`, so multiple teardown paths (init failure, rollback,
    /// clear_conversation, archive) can all call this safely.
    pub fn end_agent_session(
        &self,
        session_id: &str,
        completed_ok: bool,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE agent_sessions
             SET ended_at = datetime('now'), completed_ok = ?1
             WHERE id = ?2 AND ended_at IS NULL",
            params![if completed_ok { 1 } else { 0 }, session_id],
        )?;
        Ok(())
    }

    /// Re-open a previously ended session so that `update_agent_session_turn`
    /// can track resumed turns. Called on the `--resume` path when a user
    /// sends a new message after stopping mid-turn.
    pub fn reopen_agent_session(&self, session_id: &str) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE agent_sessions
             SET ended_at = NULL
             WHERE id = ?1 AND ended_at IS NOT NULL",
            params![session_id],
        )?;
        Ok(())
    }

    // --- Metrics: agent commits ---

    /// Insert commits observed during an agent session. Idempotent per
    /// `(workspace_id, commit_hash)` — re-scraping the same session is safe,
    /// and the same hash observed in a different workspace is recorded
    /// separately so per-workspace attribution is preserved.
    pub fn insert_agent_commits_batch(
        &self,
        workspace_id: &str,
        repository_id: &str,
        session_id: Option<&str>,
        commits: &[crate::model::AgentCommit],
    ) -> Result<(), rusqlite::Error> {
        let tx = self.conn.unchecked_transaction()?;
        {
            let mut stmt = tx.prepare(
                "INSERT OR IGNORE INTO agent_commits
                 (commit_hash, workspace_id, repository_id, session_id,
                  additions, deletions, files_changed, committed_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )?;
            for c in commits {
                stmt.execute(params![
                    c.commit_hash,
                    workspace_id,
                    repository_id,
                    session_id,
                    c.additions,
                    c.deletions,
                    c.files_changed,
                    c.committed_at,
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    // --- Metrics: materialize-on-delete ---

    /// Compute aggregate stats for a workspace and insert a frozen summary row
    /// BEFORE the workspace is hard-deleted. Callers must invoke this in the
    /// same transaction as the delete (see `delete_workspace_with_summary`).
    ///
    /// Silently no-ops if the workspace row is missing — prevents a double-call
    /// from inserting a row with empty aggregates.
    fn materialize_workspace_summary_tx(
        tx: &rusqlite::Transaction<'_>,
        workspace_id: &str,
    ) -> Result<(), rusqlite::Error> {
        // Grab workspace identity fields; bail if already gone.
        let ws_row: Option<(String, String, String)> = tx
            .query_row(
                "SELECT name, repository_id, created_at FROM workspaces WHERE id = ?1",
                params![workspace_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let Some((ws_name, repo_id, ws_created_at)) = ws_row else {
            return Ok(());
        };

        // Session aggregates. duration_ms is computed from ISO timestamps.
        let (sessions_started, sessions_completed, total_turns, total_duration_ms): (
            i64,
            i64,
            i64,
            i64,
        ) = tx.query_row(
            "SELECT
                    COUNT(*),
                    COALESCE(SUM(completed_ok), 0),
                    COALESCE(SUM(turn_count), 0),
                    COALESCE(SUM(
                        CAST(
                            (julianday(COALESCE(ended_at, last_message_at)) - julianday(started_at))
                            * 86400000.0
                        AS INTEGER)
                    ), 0)
                 FROM agent_sessions WHERE workspace_id = ?1",
            params![workspace_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?;

        // Commit aggregates.
        let (commits_made, total_additions, total_deletions, total_files_changed): (
            i64,
            i64,
            i64,
            i64,
        ) = tx.query_row(
            "SELECT
                    COUNT(*),
                    COALESCE(SUM(additions), 0),
                    COALESCE(SUM(deletions), 0),
                    COALESCE(SUM(files_changed), 0)
                 FROM agent_commits WHERE workspace_id = ?1",
            params![workspace_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?;

        // Message aggregates by role + cost + date range + tokens.
        let (
            msgs_user,
            msgs_assistant,
            msgs_system,
            total_cost_usd,
            first_msg,
            last_msg,
            total_input_tokens,
            total_output_tokens,
        ): (i64, i64, i64, f64, Option<String>, Option<String>, i64, i64) = tx.query_row(
            "SELECT
                SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END),
                SUM(CASE WHEN role = 'assistant' THEN 1 ELSE 0 END),
                SUM(CASE WHEN role = 'system' THEN 1 ELSE 0 END),
                COALESCE(SUM(cost_usd), 0),
                MIN(created_at),
                MAX(created_at),
                COALESCE(SUM(COALESCE(input_tokens, 0)), 0),
                COALESCE(SUM(COALESCE(output_tokens, 0)), 0)
             FROM chat_messages WHERE workspace_id = ?1",
            params![workspace_id],
            |r| {
                Ok((
                    r.get::<_, Option<i64>>(0)?.unwrap_or(0),
                    r.get::<_, Option<i64>>(1)?.unwrap_or(0),
                    r.get::<_, Option<i64>>(2)?.unwrap_or(0),
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                ))
            },
        )?;

        // Slash command aggregate.
        let slash_commands_used: i64 = tx.query_row(
            "SELECT COALESCE(SUM(use_count), 0) FROM slash_command_usage WHERE workspace_id = ?1",
            params![workspace_id],
            |r| r.get(0),
        )?;

        let id = uuid::Uuid::new_v4().to_string();
        tx.execute(
            "INSERT INTO deleted_workspace_summaries (
                id, workspace_id, workspace_name, repository_id, workspace_created_at,
                sessions_started, sessions_completed, total_turns, total_session_duration_ms,
                commits_made, total_additions, total_deletions, total_files_changed,
                messages_user, messages_assistant, messages_system, total_cost_usd,
                first_message_at, last_message_at, slash_commands_used,
                total_input_tokens, total_output_tokens
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5,
                ?6, ?7, ?8, ?9,
                ?10, ?11, ?12, ?13,
                ?14, ?15, ?16, ?17,
                ?18, ?19, ?20,
                ?21, ?22
             )",
            params![
                id,
                workspace_id,
                ws_name,
                repo_id,
                ws_created_at,
                sessions_started,
                sessions_completed,
                total_turns,
                total_duration_ms,
                commits_made,
                total_additions,
                total_deletions,
                total_files_changed,
                msgs_user,
                msgs_assistant,
                msgs_system,
                total_cost_usd,
                first_msg,
                last_msg,
                slash_commands_used,
                total_input_tokens,
                total_output_tokens,
            ],
        )?;
        Ok(())
    }

    /// Hard-delete a workspace, materializing a frozen summary row first so
    /// lifetime dashboard stats survive the cascade.
    pub fn delete_workspace_with_summary(&self, id: &str) -> Result<(), rusqlite::Error> {
        let tx = self.conn.unchecked_transaction()?;
        Self::materialize_workspace_summary_tx(&tx, id)?;
        tx.execute("DELETE FROM workspaces WHERE id = ?1", params![id])?;
        tx.commit()?;
        Ok(())
    }

    /// Hard-delete a repository, materializing summaries for all its
    /// workspaces first. One atomic transaction — either every affected
    /// workspace produces a summary or none of the delete happens.
    pub fn delete_repository_with_summaries(&self, id: &str) -> Result<(), rusqlite::Error> {
        let tx = self.conn.unchecked_transaction()?;
        let ws_ids: Vec<String> = {
            let mut stmt = tx.prepare("SELECT id FROM workspaces WHERE repository_id = ?1")?;
            let rows = stmt.query_map(params![id], |r| r.get::<_, String>(0))?;
            rows.collect::<Result<_, _>>()?
        };
        for ws_id in &ws_ids {
            Self::materialize_workspace_summary_tx(&tx, ws_id)?;
        }
        tx.execute("DELETE FROM repositories WHERE id = ?1", params![id])?;
        tx.commit()?;
        Ok(())
    }

    /// Rename a workspace's name and branch. Relies on the
    /// `UNIQUE(repository_id, name)` constraint — callers should handle
    /// constraint-violation errors to retry with a suffix.
    pub fn rename_workspace(
        &self,
        id: &str,
        new_name: &str,
        new_branch_name: &str,
    ) -> Result<(), rusqlite::Error> {
        let rows_affected = self.conn.execute(
            "UPDATE workspaces SET name = ?1, branch_name = ?2 WHERE id = ?3",
            params![new_name, new_branch_name, id],
        )?;
        if rows_affected != 1 {
            return Err(rusqlite::Error::StatementChangedRows(rows_affected));
        }
        Ok(())
    }

    /// Atomically claim the one-shot branch auto-rename for this workspace.
    /// Returns `true` iff this call set the flag from `0` to `1` (i.e. the
    /// caller should proceed with the rename); `false` if the flag was already
    /// set or the workspace doesn't exist. The conditional UPDATE is the
    /// race-safe primitive that prevents two concurrent turns from both firing
    /// a Haiku rename on the same workspace. The flag tracks the claim, not
    /// the outcome — a later rename failure intentionally does not "release"
    /// it, matching the product rule that rename is a first-prompt-only event.
    pub fn claim_branch_auto_rename(&self, id: &str) -> Result<bool, rusqlite::Error> {
        let rows = self.conn.execute(
            "UPDATE workspaces SET branch_auto_rename_claimed = 1
             WHERE id = ?1 AND branch_auto_rename_claimed = 0",
            params![id],
        )?;
        Ok(rows == 1)
    }

    /// Peek at whether the first-turn auto-rename slot has already been
    /// claimed for this workspace. Returns `false` for nonexistent workspaces
    /// so callers can treat missing rows as "nothing to do".
    pub fn is_branch_auto_rename_claimed(&self, id: &str) -> Result<bool, rusqlite::Error> {
        match self.conn.query_row(
            "SELECT branch_auto_rename_claimed FROM workspaces WHERE id = ?1",
            params![id],
            |row| {
                let v: i64 = row.get(0)?;
                Ok(v != 0)
            },
        ) {
            Ok(v) => Ok(v),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// Reconcile the stored branch name with the worktree's actual branch.
    /// Only touches `branch_name` — the workspace's user-facing `name` is a
    /// human label that shouldn't shift when the underlying branch is
    /// renamed externally.
    pub fn update_workspace_branch_name(
        &self,
        id: &str,
        new_branch_name: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE workspaces SET branch_name = ?1 WHERE id = ?2",
            params![new_branch_name, id],
        )?;
        Ok(())
    }

    pub fn update_workspace_name(&self, id: &str, new_name: &str) -> Result<(), rusqlite::Error> {
        let rows_affected = self.conn.execute(
            "UPDATE workspaces SET name = ?1 WHERE id = ?2",
            params![new_name, id],
        )?;
        if rows_affected != 1 {
            return Err(rusqlite::Error::StatementChangedRows(rows_affected));
        }
        Ok(())
    }

    pub fn delete_workspace(&self, id: &str) -> Result<(), rusqlite::Error> {
        self.conn
            .execute("DELETE FROM workspaces WHERE id = ?1", params![id])?;
        Ok(())
    }

    // --- Chat Messages ---

    #[allow(dead_code)]
    pub fn insert_chat_message(&self, msg: &ChatMessage) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO chat_messages (
                id, workspace_id, chat_session_id, role, content, cost_usd, duration_ms, thinking,
                input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                msg.id,
                msg.workspace_id,
                msg.chat_session_id,
                msg.role.as_str(),
                msg.content,
                msg.cost_usd,
                msg.duration_ms,
                msg.thinking,
                msg.input_tokens,
                msg.output_tokens,
                msg.cache_read_tokens,
                msg.cache_creation_tokens,
            ],
        )?;
        Ok(())
    }

    fn parse_chat_message_row(row: &rusqlite::Row) -> rusqlite::Result<ChatMessage> {
        let role_str: String = row.get(3)?;
        let chat_session_id: String = row.get::<_, Option<String>>(2)?.unwrap_or_default();
        Ok(ChatMessage {
            id: row.get(0)?,
            workspace_id: row.get(1)?,
            chat_session_id,
            role: role_str.parse().unwrap(),
            content: row.get(4)?,
            cost_usd: row.get(5)?,
            duration_ms: row.get(6)?,
            created_at: row.get(7)?,
            thinking: row.get(8)?,
            input_tokens: row.get(9)?,
            output_tokens: row.get(10)?,
            cache_read_tokens: row.get(11)?,
            cache_creation_tokens: row.get(12)?,
        })
    }

    const CHAT_MESSAGE_COLS: &str = "id, workspace_id, chat_session_id, role, content, cost_usd, \
         duration_ms, created_at, thinking, input_tokens, output_tokens, cache_read_tokens, \
         cache_creation_tokens";

    #[allow(dead_code)]
    pub fn list_chat_messages(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<ChatMessage>, rusqlite::Error> {
        let sql = format!(
            "SELECT {} FROM chat_messages WHERE workspace_id = ?1 ORDER BY created_at, rowid",
            Self::CHAT_MESSAGE_COLS
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params![workspace_id], Self::parse_chat_message_row)?;
        rows.collect()
    }

    /// List all chat messages for a single chat session, ordered chronologically.
    pub fn list_chat_messages_for_session(
        &self,
        chat_session_id: &str,
    ) -> Result<Vec<ChatMessage>, rusqlite::Error> {
        let sql = format!(
            "SELECT {} FROM chat_messages WHERE chat_session_id = ?1 ORDER BY created_at, rowid",
            Self::CHAT_MESSAGE_COLS
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params![chat_session_id], Self::parse_chat_message_row)?;
        rows.collect()
    }

    #[allow(dead_code)]
    pub fn update_chat_message_content(
        &self,
        id: &str,
        content: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE chat_messages SET content = ?1 WHERE id = ?2",
            params![content, id],
        )?;
        Ok(())
    }

    #[allow(dead_code)]
    pub fn update_chat_message_cost(
        &self,
        id: &str,
        cost_usd: f64,
        duration_ms: i64,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE chat_messages SET cost_usd = ?1, duration_ms = ?2 WHERE id = ?3",
            params![cost_usd, duration_ms, id],
        )?;
        Ok(())
    }

    /// Get the most recent chat message for each workspace (for dashboard display).
    /// Uses a correlated subquery with rowid tie-breaking to guarantee exactly
    /// one row per workspace even when multiple messages share the same timestamp.
    pub fn last_message_per_workspace(&self) -> Result<Vec<ChatMessage>, rusqlite::Error> {
        // Prefix each column with `m.` so the correlated subquery references are unambiguous.
        let prefixed: String = Self::CHAT_MESSAGE_COLS
            .split(", ")
            .map(|c| format!("m.{}", c.trim()))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT {prefixed} FROM chat_messages m
             WHERE m.rowid = (
                 SELECT rowid FROM chat_messages c2
                 WHERE c2.workspace_id = m.workspace_id
                 ORDER BY c2.created_at DESC, c2.rowid DESC
                 LIMIT 1
             )"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map([], Self::parse_chat_message_row)?;
        rows.collect()
    }

    #[allow(dead_code)]
    pub fn delete_chat_messages_for_workspace(
        &self,
        workspace_id: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "DELETE FROM chat_messages WHERE workspace_id = ?1",
            params![workspace_id],
        )?;
        Ok(())
    }

    /// Delete all messages for a single chat session. Cascades to attachments.
    pub fn delete_chat_messages_for_session(
        &self,
        chat_session_id: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "DELETE FROM chat_messages WHERE chat_session_id = ?1",
            params![chat_session_id],
        )?;
        Ok(())
    }

    // --- Chat Sessions ---

    const CHAT_SESSION_COLS: &str = "id, workspace_id, session_id, name, name_edited, \
         turn_count, sort_order, status, created_at, archived_at";

    fn parse_chat_session_row(row: &rusqlite::Row) -> rusqlite::Result<ChatSession> {
        let status_str: String = row.get(7)?;
        Ok(ChatSession {
            id: row.get(0)?,
            workspace_id: row.get(1)?,
            session_id: row.get(2)?,
            name: row.get(3)?,
            name_edited: row.get::<_, i32>(4)? != 0,
            turn_count: row.get(5)?,
            sort_order: row.get(6)?,
            status: status_str.parse().unwrap(),
            created_at: row.get(8)?,
            archived_at: row.get(9)?,
            agent_status: AgentStatus::Idle,
            needs_attention: false,
            attention_kind: None,
        })
    }

    /// Insert a new active session. Returns the inserted row.
    pub fn create_chat_session(&self, workspace_id: &str) -> Result<ChatSession, rusqlite::Error> {
        // New sessions land at the end of the tab list. Surface DB errors so
        // a transient lock/read failure doesn't collapse the next sort_order
        // to 0 and produce duplicate tab-order values.
        let sort_order: i32 = self.conn.query_row(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM chat_sessions WHERE workspace_id = ?1",
            params![workspace_id],
            |row| row.get(0),
        )?;
        let id = uuid::Uuid::new_v4().to_string();
        self.conn.execute(
            "INSERT INTO chat_sessions
                (id, workspace_id, session_id, name, name_edited,
                 turn_count, sort_order, status)
             VALUES (?1, ?2, NULL, 'New chat', 0, 0, ?3, 'active')",
            params![id, workspace_id, sort_order],
        )?;
        self.get_chat_session(&id)?
            .ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)
    }

    pub fn get_chat_session(
        &self,
        chat_session_id: &str,
    ) -> Result<Option<ChatSession>, rusqlite::Error> {
        let sql = format!(
            "SELECT {} FROM chat_sessions WHERE id = ?1",
            Self::CHAT_SESSION_COLS
        );
        self.conn
            .query_row(&sql, params![chat_session_id], Self::parse_chat_session_row)
            .optional()
    }

    /// List sessions for a workspace. `include_archived` toggles whether
    /// archived sessions are returned. Active sessions are always first,
    /// then archived; within each group, ordered by sort_order, then
    /// created_at as a stable tie-break.
    pub fn list_chat_sessions_for_workspace(
        &self,
        workspace_id: &str,
        include_archived: bool,
    ) -> Result<Vec<ChatSession>, rusqlite::Error> {
        let sql = if include_archived {
            format!(
                "SELECT {} FROM chat_sessions WHERE workspace_id = ?1
                 ORDER BY (status = 'archived'), sort_order, created_at",
                Self::CHAT_SESSION_COLS
            )
        } else {
            format!(
                "SELECT {} FROM chat_sessions
                 WHERE workspace_id = ?1 AND status = 'active'
                 ORDER BY sort_order, created_at",
                Self::CHAT_SESSION_COLS
            )
        };
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params![workspace_id], Self::parse_chat_session_row)?;
        rows.collect()
    }

    /// Rename a session. Sets `name_edited = 1` so Haiku auto-naming never
    /// overwrites the new name.
    pub fn rename_chat_session(
        &self,
        chat_session_id: &str,
        name: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE chat_sessions SET name = ?1, name_edited = 1 WHERE id = ?2",
            params![name, chat_session_id],
        )?;
        Ok(())
    }

    /// Write a Haiku-generated session name — only if the user has not
    /// already renamed the session. Returns `true` if the name was written.
    pub fn set_session_name_from_haiku(
        &self,
        chat_session_id: &str,
        name: &str,
    ) -> Result<bool, rusqlite::Error> {
        let rows = self.conn.execute(
            "UPDATE chat_sessions SET name = ?1
             WHERE id = ?2 AND name_edited = 0",
            params![name, chat_session_id],
        )?;
        Ok(rows > 0)
    }

    /// Persist per-session Claude CLI state so turns can be resumed after a
    /// restart. Replaces the old workspace-scoped `save_agent_session`.
    pub fn save_chat_session_state(
        &self,
        chat_session_id: &str,
        session_id: &str,
        turn_count: u32,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE chat_sessions SET session_id = ?1, turn_count = ?2 WHERE id = ?3",
            params![session_id, turn_count, chat_session_id],
        )?;
        Ok(())
    }

    /// Clear Claude CLI state (e.g. after a reset or failed init).
    pub fn clear_chat_session_state(&self, chat_session_id: &str) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE chat_sessions
             SET session_id = NULL, turn_count = 0 WHERE id = ?1",
            params![chat_session_id],
        )?;
        Ok(())
    }

    /// Archive a session (soft-delete). Messages and checkpoints remain so
    /// they can be restored or purged later.
    pub fn archive_chat_session(&self, chat_session_id: &str) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE chat_sessions
             SET status = 'archived', archived_at = datetime('now')
             WHERE id = ?1",
            params![chat_session_id],
        )?;
        Ok(())
    }

    /// Archive a session while preserving the "workspace has ≥1 active
    /// session" invariant. Runs archive + remaining-count + conditional
    /// replacement create as a single transaction so observers never see a
    /// transient zero-sessions window and a crash mid-sequence can't persist
    /// a tab-less workspace. Returns the newly created session if a
    /// replacement was needed, `None` otherwise.
    pub fn archive_chat_session_ensuring_active(
        &self,
        chat_session_id: &str,
        workspace_id: &str,
    ) -> Result<Option<ChatSession>, rusqlite::Error> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "UPDATE chat_sessions
             SET status = 'archived', archived_at = datetime('now')
             WHERE id = ?1",
            params![chat_session_id],
        )?;
        let remaining: i64 = tx.query_row(
            "SELECT COUNT(*) FROM chat_sessions
             WHERE workspace_id = ?1 AND status = 'active'",
            params![workspace_id],
            |row| row.get(0),
        )?;
        let fresh = if remaining == 0 {
            let sort_order: i32 = tx.query_row(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM chat_sessions WHERE workspace_id = ?1",
                params![workspace_id],
                |row| row.get(0),
            )?;
            let id = uuid::Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO chat_sessions
                    (id, workspace_id, session_id, name, name_edited,
                     turn_count, sort_order, status)
                 VALUES (?1, ?2, NULL, 'New chat', 0, 0, ?3, 'active')",
                params![id, workspace_id, sort_order],
            )?;
            let sql = format!(
                "SELECT {} FROM chat_sessions WHERE id = ?1",
                Self::CHAT_SESSION_COLS
            );
            Some(tx.query_row(&sql, params![id], Self::parse_chat_session_row)?)
        } else {
            None
        };
        tx.commit()?;
        Ok(fresh)
    }

    /// Return the "default" session id for a workspace: the first active
    /// session, ordered by sort_order. Returns `None` when no active session
    /// exists (caller can create one to enforce the ≥1 invariant).
    pub fn default_session_id_for_workspace(
        &self,
        workspace_id: &str,
    ) -> Result<Option<String>, rusqlite::Error> {
        self.conn
            .query_row(
                "SELECT id FROM chat_sessions
                 WHERE workspace_id = ?1 AND status = 'active'
                 ORDER BY sort_order, created_at LIMIT 1",
                params![workspace_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
    }

    /// Count of active sessions for a workspace. Used to enforce the
    /// "every workspace has ≥1 active session" invariant when archiving.
    pub fn active_session_count_for_workspace(
        &self,
        workspace_id: &str,
    ) -> Result<i64, rusqlite::Error> {
        self.conn.query_row(
            "SELECT COUNT(*) FROM chat_sessions
             WHERE workspace_id = ?1 AND status = 'active'",
            params![workspace_id],
            |row| row.get(0),
        )
    }

    /// Is this session the first (sort_order = 0) session for its workspace?
    /// Used to gate workspace-level branch auto-rename.
    pub fn is_initial_session(&self, chat_session_id: &str) -> Result<bool, rusqlite::Error> {
        let sort_order: Option<i32> = self
            .conn
            .query_row(
                "SELECT sort_order FROM chat_sessions WHERE id = ?1",
                params![chat_session_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(sort_order == Some(0))
    }

    // --- Attachments ---

    pub fn insert_attachment(&self, att: &Attachment) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO attachments (id, message_id, filename, media_type, data, width, height, size_bytes, origin, tool_use_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                att.id,
                att.message_id,
                att.filename,
                att.media_type,
                att.data,
                att.width,
                att.height,
                att.size_bytes,
                att.origin.as_sql_str(),
                att.tool_use_id,
            ],
        )?;
        Ok(())
    }

    pub fn insert_attachments_batch(
        &self,
        attachments: &[Attachment],
    ) -> Result<(), rusqlite::Error> {
        if attachments.is_empty() {
            return Ok(());
        }
        let tx = self.conn.unchecked_transaction()?;
        for att in attachments {
            tx.execute(
                "INSERT INTO attachments (id, message_id, filename, media_type, data, width, height, size_bytes, origin, tool_use_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    att.id,
                    att.message_id,
                    att.filename,
                    att.media_type,
                    att.data,
                    att.width,
                    att.height,
                    att.size_bytes,
                    att.origin.as_sql_str(),
                    att.tool_use_id,
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn get_attachment(&self, id: &str) -> Result<Option<Attachment>, rusqlite::Error> {
        let sql = format!("SELECT {ATTACHMENT_COLUMNS} FROM attachments WHERE id = ?1");
        self.conn
            .query_row(&sql, params![id], row_to_attachment)
            .optional()
    }

    pub fn list_attachments_for_message(
        &self,
        message_id: &str,
    ) -> Result<Vec<Attachment>, rusqlite::Error> {
        let sql = format!(
            "SELECT {ATTACHMENT_COLUMNS} FROM attachments WHERE message_id = ?1 ORDER BY created_at"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params![message_id], row_to_attachment)?;
        rows.collect()
    }

    pub fn list_attachments_for_messages(
        &self,
        message_ids: &[String],
    ) -> Result<std::collections::HashMap<String, Vec<Attachment>>, rusqlite::Error> {
        use std::collections::HashMap;

        let mut result: HashMap<String, Vec<Attachment>> = HashMap::new();
        if message_ids.is_empty() {
            return Ok(result);
        }

        // Build a parameterised IN clause.
        let placeholders: Vec<String> = (1..=message_ids.len()).map(|i| format!("?{i}")).collect();
        let sql = format!(
            "SELECT {ATTACHMENT_COLUMNS} FROM attachments WHERE message_id IN ({})
             ORDER BY created_at",
            placeholders.join(", ")
        );

        let mut stmt = self.conn.prepare(&sql)?;
        let params: Vec<&dyn rusqlite::types::ToSql> = message_ids
            .iter()
            .map(|id| id as &dyn rusqlite::types::ToSql)
            .collect();
        let rows = stmt.query_map(&*params, row_to_attachment)?;

        for att in rows {
            let att = att?;
            result.entry(att.message_id.clone()).or_default().push(att);
        }
        Ok(result)
    }

    /// List agent-authored attachments associated with a specific MCP
    /// `tool_use_id`. Returns rows ordered by creation time so multiple
    /// `send_to_user` calls within a single tool activity render in order.
    pub fn list_attachments_by_tool_use(
        &self,
        tool_use_id: &str,
    ) -> Result<Vec<Attachment>, rusqlite::Error> {
        let sql = format!(
            "SELECT {ATTACHMENT_COLUMNS} FROM attachments
             WHERE tool_use_id = ?1 AND origin = 'agent' ORDER BY created_at"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params![tool_use_id], row_to_attachment)?;
        rows.collect()
    }

    // --- Conversation Checkpoints ---

    pub fn insert_checkpoint(&self, cp: &ConversationCheckpoint) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO conversation_checkpoints
                (id, workspace_id, chat_session_id, message_id, commit_hash, turn_index, message_count)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                cp.id,
                cp.workspace_id,
                cp.chat_session_id,
                cp.message_id,
                cp.commit_hash,
                cp.turn_index,
                cp.message_count
            ],
        )?;
        Ok(())
    }

    fn parse_checkpoint_row(row: &rusqlite::Row) -> rusqlite::Result<ConversationCheckpoint> {
        Ok(ConversationCheckpoint {
            id: row.get(0)?,
            workspace_id: row.get(1)?,
            chat_session_id: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
            message_id: row.get(3)?,
            commit_hash: row.get(4)?,
            has_file_state: row.get(5)?,
            turn_index: row.get(6)?,
            message_count: row.get(7)?,
            created_at: row.get(8)?,
        })
    }

    /// SQL column list for checkpoint queries, including a subquery for has_file_state.
    const CHECKPOINT_COLS: &str = "id, workspace_id, chat_session_id, message_id, commit_hash, \
         EXISTS(SELECT 1 FROM checkpoint_files WHERE checkpoint_id = conversation_checkpoints.id) AS has_file_state, \
         turn_index, message_count, created_at";

    pub fn list_checkpoints(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<ConversationCheckpoint>, rusqlite::Error> {
        let sql = format!(
            "SELECT {} FROM conversation_checkpoints WHERE workspace_id = ?1 ORDER BY turn_index",
            Self::CHECKPOINT_COLS
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params![workspace_id], Self::parse_checkpoint_row)?;
        rows.collect()
    }

    pub fn list_checkpoints_for_session(
        &self,
        chat_session_id: &str,
    ) -> Result<Vec<ConversationCheckpoint>, rusqlite::Error> {
        let sql = format!(
            "SELECT {} FROM conversation_checkpoints WHERE chat_session_id = ?1 ORDER BY turn_index",
            Self::CHECKPOINT_COLS
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(params![chat_session_id], Self::parse_checkpoint_row)?;
        rows.collect()
    }

    /// Delete checkpoints for a session after a given turn index. Used for
    /// rollback — everything after the chosen turn is pruned.
    pub fn delete_session_checkpoints_after(
        &self,
        chat_session_id: &str,
        turn_index: i32,
    ) -> Result<usize, rusqlite::Error> {
        let deleted = self.conn.execute(
            "DELETE FROM conversation_checkpoints WHERE chat_session_id = ?1 AND turn_index > ?2",
            params![chat_session_id, turn_index],
        )?;
        Ok(deleted)
    }

    pub fn get_checkpoint(
        &self,
        id: &str,
    ) -> Result<Option<ConversationCheckpoint>, rusqlite::Error> {
        let sql = format!(
            "SELECT {} FROM conversation_checkpoints WHERE id = ?1",
            Self::CHECKPOINT_COLS
        );
        self.conn
            .query_row(&sql, params![id], Self::parse_checkpoint_row)
            .optional()
    }

    pub fn latest_checkpoint(
        &self,
        workspace_id: &str,
    ) -> Result<Option<ConversationCheckpoint>, rusqlite::Error> {
        let sql = format!(
            "SELECT {} FROM conversation_checkpoints \
             WHERE workspace_id = ?1 ORDER BY turn_index DESC LIMIT 1",
            Self::CHECKPOINT_COLS
        );
        self.conn
            .query_row(&sql, params![workspace_id], Self::parse_checkpoint_row)
            .optional()
    }

    pub fn delete_checkpoints_after(
        &self,
        workspace_id: &str,
        turn_index: i32,
    ) -> Result<usize, rusqlite::Error> {
        let deleted = self.conn.execute(
            "DELETE FROM conversation_checkpoints WHERE workspace_id = ?1 AND turn_index > ?2",
            params![workspace_id, turn_index],
        )?;
        Ok(deleted)
    }

    /// Return checkpoints for `workspace_id` whose `turn_index` is at most
    /// `max_turn_index`, ordered by `turn_index`. Used by the fork
    /// orchestrator to copy only checkpoints up to (and including) the fork
    /// point.
    pub fn list_checkpoints_up_to(
        &self,
        workspace_id: &str,
        max_turn_index: i32,
    ) -> Result<Vec<ConversationCheckpoint>, rusqlite::Error> {
        let sql = format!(
            "SELECT {} FROM conversation_checkpoints \
             WHERE workspace_id = ?1 AND turn_index <= ?2 ORDER BY turn_index",
            Self::CHECKPOINT_COLS
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(
            params![workspace_id, max_turn_index],
            Self::parse_checkpoint_row,
        )?;
        rows.collect()
    }

    /// Return chat messages for `workspace_id` up to and including the row
    /// identified by `last_message_id`, ordered by (created_at, rowid). If
    /// `last_message_id` is not found, returns an empty vec. Used by the fork
    /// orchestrator to copy conversation history up to the fork point.
    pub fn list_messages_up_to(
        &self,
        workspace_id: &str,
        last_message_id: &str,
    ) -> Result<Vec<ChatMessage>, rusqlite::Error> {
        let boundary: Option<(String, i64)> = self
            .conn
            .query_row(
                "SELECT created_at, rowid FROM chat_messages \
                 WHERE id = ?1 AND workspace_id = ?2",
                params![last_message_id, workspace_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((created_at, rowid)) = boundary else {
            return Ok(Vec::new());
        };

        let sql = format!(
            "SELECT {} FROM chat_messages
             WHERE workspace_id = ?1
               AND (created_at < ?2 OR (created_at = ?2 AND rowid <= ?3))
             ORDER BY created_at, rowid",
            Self::CHAT_MESSAGE_COLS
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(
            params![workspace_id, created_at, rowid],
            Self::parse_chat_message_row,
        )?;
        rows.collect()
    }

    // --- Checkpoint Files ---

    pub fn insert_checkpoint_files(&self, files: &[CheckpointFile]) -> Result<(), rusqlite::Error> {
        let tx = self.conn.unchecked_transaction()?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO checkpoint_files (id, checkpoint_id, file_path, content, file_mode)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
            )?;
            for f in files {
                stmt.execute(params![
                    f.id,
                    f.checkpoint_id,
                    f.file_path,
                    f.content,
                    f.file_mode,
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn get_checkpoint_files(
        &self,
        checkpoint_id: &str,
    ) -> Result<Vec<CheckpointFile>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, checkpoint_id, file_path, content, file_mode
             FROM checkpoint_files WHERE checkpoint_id = ?1",
        )?;
        let rows = stmt.query_map(params![checkpoint_id], |row| {
            Ok(CheckpointFile {
                id: row.get(0)?,
                checkpoint_id: row.get(1)?,
                file_path: row.get(2)?,
                content: row.get(3)?,
                file_mode: row.get(4)?,
            })
        })?;
        rows.collect()
    }

    pub fn has_checkpoint_files(&self, checkpoint_id: &str) -> Result<bool, rusqlite::Error> {
        self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM checkpoint_files WHERE checkpoint_id = ?1)",
            params![checkpoint_id],
            |row| row.get(0),
        )
    }

    // --- Turn Tool Activities ---

    pub fn insert_turn_tool_activities(
        &self,
        activities: &[TurnToolActivity],
    ) -> Result<(), rusqlite::Error> {
        let tx = self.conn.unchecked_transaction()?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO turn_tool_activities (id, checkpoint_id, tool_use_id, tool_name, input_json, result_text, summary, sort_order, group_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            )?;
            for a in activities {
                stmt.execute(params![
                    a.id,
                    a.checkpoint_id,
                    a.tool_use_id,
                    a.tool_name,
                    a.input_json,
                    a.result_text,
                    a.summary,
                    a.sort_order,
                    a.group_id,
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn update_checkpoint_message_count(
        &self,
        checkpoint_id: &str,
        message_count: i32,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE conversation_checkpoints SET message_count = ?1 WHERE id = ?2",
            params![message_count, checkpoint_id],
        )?;
        Ok(())
    }

    /// Atomically update the checkpoint message count and insert tool activities.
    pub fn save_turn_tool_activities(
        &self,
        checkpoint_id: &str,
        message_count: i32,
        activities: &[TurnToolActivity],
    ) -> Result<(), rusqlite::Error> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "UPDATE conversation_checkpoints SET message_count = ?1 WHERE id = ?2",
            params![message_count, checkpoint_id],
        )?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO turn_tool_activities (id, checkpoint_id, tool_use_id, tool_name, input_json, result_text, summary, sort_order, group_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            )?;
            for a in activities {
                stmt.execute(params![
                    a.id,
                    a.checkpoint_id,
                    a.tool_use_id,
                    a.tool_name,
                    a.input_json,
                    a.result_text,
                    a.summary,
                    a.sort_order,
                    a.group_id,
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Load all completed turns for a workspace: checkpoints joined with their
    /// tool activities, grouped by checkpoint and ordered by turn_index.
    pub fn list_completed_turns(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<CompletedTurnData>, rusqlite::Error> {
        // First get the checkpoints.
        let checkpoints = self.list_checkpoints(workspace_id)?;

        // Then load all activities for this workspace in one query.
        let mut stmt = self.conn.prepare(
            "SELECT ta.id, ta.checkpoint_id, ta.tool_use_id, ta.tool_name,
                    ta.input_json, ta.result_text, ta.summary, ta.sort_order,
                    ta.group_id
             FROM turn_tool_activities ta
             JOIN conversation_checkpoints cp ON ta.checkpoint_id = cp.id
             WHERE cp.workspace_id = ?1
             ORDER BY cp.turn_index, ta.sort_order",
        )?;
        let activities: Vec<TurnToolActivity> = stmt
            .query_map(params![workspace_id], |row| {
                Ok(TurnToolActivity {
                    id: row.get(0)?,
                    checkpoint_id: row.get(1)?,
                    tool_use_id: row.get(2)?,
                    tool_name: row.get(3)?,
                    input_json: row.get(4)?,
                    result_text: row.get(5)?,
                    summary: row.get(6)?,
                    sort_order: row.get(7)?,
                    group_id: row.get(8)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        // Group activities by checkpoint_id.
        let mut activity_map: std::collections::HashMap<String, Vec<TurnToolActivity>> =
            std::collections::HashMap::new();
        for a in activities {
            activity_map
                .entry(a.checkpoint_id.clone())
                .or_default()
                .push(a);
        }

        Ok(checkpoints
            .into_iter()
            .filter_map(|cp| {
                let acts = activity_map.remove(&cp.id).unwrap_or_default();
                // Only return turns that actually had tool activities.
                // Checkpoints for assistant-only turns don't need summaries.
                if acts.is_empty() {
                    return None;
                }
                Some(CompletedTurnData {
                    checkpoint_id: cp.id,
                    message_id: cp.message_id,
                    turn_index: cp.turn_index,
                    message_count: cp.message_count,
                    commit_hash: cp.commit_hash,
                    activities: acts,
                })
            })
            .collect())
    }

    /// Delete all chat messages inserted after the given message (by rowid order).
    /// Returns the number of messages deleted.
    pub fn delete_messages_after(
        &self,
        workspace_id: &str,
        after_message_id: &str,
    ) -> Result<usize, rusqlite::Error> {
        let deleted = self.conn.execute(
            "DELETE FROM chat_messages
             WHERE workspace_id = ?1
               AND rowid > (SELECT rowid FROM chat_messages WHERE id = ?2)",
            params![workspace_id, after_message_id],
        )?;
        Ok(deleted)
    }

    /// Delete all messages inserted after `after_message_id` *within the
    /// given chat session*. The rowid-ordering match is scoped to that
    /// chat session so a rollback in tab A cannot prune messages in tab B.
    pub fn delete_session_messages_after(
        &self,
        chat_session_id: &str,
        after_message_id: &str,
    ) -> Result<usize, rusqlite::Error> {
        let deleted = self.conn.execute(
            "DELETE FROM chat_messages
             WHERE chat_session_id = ?1
               AND rowid > (SELECT rowid FROM chat_messages WHERE id = ?2)",
            params![chat_session_id, after_message_id],
        )?;
        Ok(deleted)
    }

    /// Session-scoped variant of [`Self::list_completed_turns`].
    pub fn list_completed_turns_for_session(
        &self,
        chat_session_id: &str,
    ) -> Result<Vec<CompletedTurnData>, rusqlite::Error> {
        let checkpoints = self.list_checkpoints_for_session(chat_session_id)?;

        let mut stmt = self.conn.prepare(
            "SELECT ta.id, ta.checkpoint_id, ta.tool_use_id, ta.tool_name,
                    ta.input_json, ta.result_text, ta.summary, ta.sort_order,
                    ta.group_id, ta.anchor_ordinal
             FROM turn_tool_activities ta
             JOIN conversation_checkpoints cp ON ta.checkpoint_id = cp.id
             WHERE cp.chat_session_id = ?1
             ORDER BY cp.turn_index, ta.sort_order",
        )?;
        let activities: Vec<TurnToolActivity> = stmt
            .query_map(params![chat_session_id], |row| {
                Ok(TurnToolActivity {
                    id: row.get(0)?,
                    checkpoint_id: row.get(1)?,
                    tool_use_id: row.get(2)?,
                    tool_name: row.get(3)?,
                    input_json: row.get(4)?,
                    result_text: row.get(5)?,
                    summary: row.get(6)?,
                    sort_order: row.get(7)?,
                    group_id: row.get(8)?,
                    anchor_ordinal: row.get(9)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let mut activity_map: std::collections::HashMap<String, Vec<TurnToolActivity>> =
            std::collections::HashMap::new();
        for a in activities {
            activity_map
                .entry(a.checkpoint_id.clone())
                .or_default()
                .push(a);
        }

        Ok(checkpoints
            .into_iter()
            .filter_map(|cp| {
                let acts = activity_map.remove(&cp.id).unwrap_or_default();
                if acts.is_empty() {
                    return None;
                }
                Some(CompletedTurnData {
                    checkpoint_id: cp.id,
                    message_id: cp.message_id,
                    turn_index: cp.turn_index,
                    message_count: cp.message_count,
                    commit_hash: cp.commit_hash,
                    activities: acts,
                })
            })
            .collect())
    }

    // --- Terminal Tabs ---

    pub fn insert_terminal_tab(&self, tab: &TerminalTab) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO terminal_tabs (id, workspace_id, title, is_script_output, sort_order)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                tab.id,
                tab.workspace_id,
                tab.title,
                tab.is_script_output as i32,
                tab.sort_order,
            ],
        )?;
        Ok(())
    }

    pub fn max_terminal_tab_id(&self) -> Result<i64, rusqlite::Error> {
        self.conn.query_row(
            "SELECT COALESCE(MAX(id), 0) FROM terminal_tabs",
            [],
            |row| row.get(0),
        )
    }

    pub fn list_terminal_tabs_by_workspace(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<TerminalTab>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, workspace_id, title, is_script_output, sort_order, created_at
             FROM terminal_tabs WHERE workspace_id = ?1 ORDER BY sort_order, id",
        )?;
        let rows = stmt.query_map(params![workspace_id], |row| {
            let is_script: i32 = row.get(3)?;
            Ok(TerminalTab {
                id: row.get(0)?,
                workspace_id: row.get(1)?,
                title: row.get(2)?,
                is_script_output: is_script != 0,
                sort_order: row.get(4)?,
                created_at: row.get(5)?,
            })
        })?;
        rows.collect()
    }

    pub fn delete_terminal_tab(&self, id: i64) -> Result<(), rusqlite::Error> {
        self.conn
            .execute("DELETE FROM terminal_tabs WHERE id = ?1", params![id])?;
        Ok(())
    }

    #[allow(dead_code)]
    pub fn delete_terminal_tabs_for_workspace(
        &self,
        workspace_id: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "DELETE FROM terminal_tabs WHERE workspace_id = ?1",
            params![workspace_id],
        )?;
        Ok(())
    }

    #[allow(dead_code)]
    pub fn update_terminal_tab_title(&self, id: i64, title: &str) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE terminal_tabs SET title = ?1 WHERE id = ?2",
            params![title, id],
        )?;
        Ok(())
    }

    // --- Remote Connections ---

    fn parse_port(row: &rusqlite::Row, idx: usize) -> rusqlite::Result<u16> {
        let p: i32 = row.get(idx)?;
        if !(0..=65535).contains(&p) {
            return Err(rusqlite::Error::IntegralValueOutOfRange(idx, p as i64));
        }
        Ok(p as u16)
    }

    pub fn insert_remote_connection(&self, conn: &RemoteConnection) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO remote_connections (id, name, host, port, session_token, cert_fingerprint, auto_connect)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                conn.id,
                conn.name,
                conn.host,
                conn.port as i32,
                conn.session_token,
                conn.cert_fingerprint,
                conn.auto_connect as i32,
            ],
        )?;
        Ok(())
    }

    pub fn list_remote_connections(&self) -> Result<Vec<RemoteConnection>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, host, port, session_token, cert_fingerprint, auto_connect, created_at
             FROM remote_connections ORDER BY created_at",
        )?;
        let rows = stmt.query_map([], |row| {
            let auto_connect_int: i32 = row.get(6)?;
            Ok(RemoteConnection {
                id: row.get(0)?,
                name: row.get(1)?,
                host: row.get(2)?,
                port: Self::parse_port(row, 3)?,
                session_token: row.get(4)?,
                cert_fingerprint: row.get(5)?,
                auto_connect: auto_connect_int != 0,
                created_at: row.get(7)?,
            })
        })?;
        rows.collect()
    }

    pub fn get_remote_connection(
        &self,
        id: &str,
    ) -> Result<Option<RemoteConnection>, rusqlite::Error> {
        self.conn
            .query_row(
                "SELECT id, name, host, port, session_token, cert_fingerprint, auto_connect, created_at
                 FROM remote_connections WHERE id = ?1",
                params![id],
                |row| {
                    let auto_connect_int: i32 = row.get(6)?;
                    Ok(RemoteConnection {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        host: row.get(2)?,
                        port: Self::parse_port(row, 3)?,
                        session_token: row.get(4)?,
                        cert_fingerprint: row.get(5)?,
                        auto_connect: auto_connect_int != 0,
                        created_at: row.get(7)?,
                    })
                },
            )
            .optional()
    }

    pub fn update_remote_connection_session(
        &self,
        id: &str,
        session_token: &str,
        cert_fingerprint: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE remote_connections SET session_token = ?1, cert_fingerprint = ?2 WHERE id = ?3",
            params![session_token, cert_fingerprint, id],
        )?;
        Ok(())
    }

    pub fn delete_remote_connection(&self, id: &str) -> Result<(), rusqlite::Error> {
        self.conn
            .execute("DELETE FROM remote_connections WHERE id = ?1", params![id])?;
        Ok(())
    }

    // --- Slash Command Usage ---

    pub fn record_slash_command_usage(
        &self,
        workspace_id: &str,
        command_name: &str,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO slash_command_usage (workspace_id, command_name, use_count, last_used_at)
             VALUES (?1, ?2, 1, datetime('now'))
             ON CONFLICT (workspace_id, command_name)
             DO UPDATE SET use_count = use_count + 1, last_used_at = datetime('now')",
            params![workspace_id, command_name],
        )?;
        Ok(())
    }

    pub fn get_slash_command_usage(
        &self,
        workspace_id: &str,
    ) -> Result<std::collections::HashMap<String, i64>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT command_name, use_count FROM slash_command_usage WHERE workspace_id = ?1",
        )?;
        let rows = stmt.query_map(params![workspace_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        let mut map = std::collections::HashMap::new();
        for row in rows {
            let (name, count) = row?;
            map.insert(name, count);
        }
        Ok(map)
    }

    // --- Repository MCP Servers ---

    /// List all saved MCP servers for a repository.
    pub fn list_repository_mcp_servers(
        &self,
        repository_id: &str,
    ) -> Result<Vec<RepositoryMcpServer>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, repository_id, name, config_json, source, created_at, enabled
             FROM repository_mcp_servers
             WHERE repository_id = ?1
             ORDER BY name",
        )?;
        let rows = stmt.query_map(params![repository_id], |row| {
            let enabled_int: i32 = row.get(6)?;
            Ok(RepositoryMcpServer {
                id: row.get(0)?,
                repository_id: row.get(1)?,
                name: row.get(2)?,
                config_json: row.get(3)?,
                source: row.get(4)?,
                created_at: row.get(5)?,
                enabled: enabled_int != 0,
            })
        })?;
        rows.collect()
    }

    /// Replace all MCP servers for a repository atomically (delete + re-insert).
    pub fn replace_repository_mcp_servers(
        &self,
        repository_id: &str,
        servers: &[RepositoryMcpServer],
    ) -> Result<(), rusqlite::Error> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "DELETE FROM repository_mcp_servers WHERE repository_id = ?1",
            params![repository_id],
        )?;
        for server in servers {
            tx.execute(
                "INSERT INTO repository_mcp_servers (id, repository_id, name, config_json, source, enabled)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    server.id,
                    server.repository_id,
                    server.name,
                    server.config_json,
                    server.source,
                    server.enabled as i32,
                ],
            )?;
        }
        tx.commit()
    }

    /// Delete a single MCP server by ID.
    pub fn delete_repository_mcp_server(&self, id: &str) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "DELETE FROM repository_mcp_servers WHERE id = ?1",
            params![id],
        )?;
        Ok(())
    }

    /// Update the enabled state of a single MCP server.
    pub fn set_mcp_server_enabled(&self, id: &str, enabled: bool) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE repository_mcp_servers SET enabled = ?1 WHERE id = ?2",
            params![enabled as i32, id],
        )?;
        Ok(())
    }

    // --- SCM Status Cache ---

    /// `row.fetched_at` is ignored; the database sets it to `datetime('now')` on every upsert.
    pub fn upsert_scm_status_cache(&self, row: &ScmStatusCacheRow) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT OR REPLACE INTO scm_status_cache
                (workspace_id, repo_id, branch_name, provider, pr_json, ci_json, error, fetched_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'))",
            params![
                row.workspace_id,
                row.repo_id,
                row.branch_name,
                row.provider,
                row.pr_json,
                row.ci_json,
                row.error
            ],
        )?;
        Ok(())
    }

    pub fn load_all_scm_status_cache(&self) -> Result<Vec<ScmStatusCacheRow>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT workspace_id, repo_id, branch_name, provider, pr_json, ci_json, error, fetched_at
             FROM scm_status_cache",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(ScmStatusCacheRow {
                workspace_id: row.get(0)?,
                repo_id: row.get(1)?,
                branch_name: row.get(2)?,
                provider: row.get(3)?,
                pr_json: row.get(4)?,
                ci_json: row.get(5)?,
                error: row.get(6)?,
                fetched_at: row.get(7)?,
            })
        })?;
        rows.collect()
    }

    pub fn delete_scm_status_cache(&self, workspace_id: &str) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "DELETE FROM scm_status_cache WHERE workspace_id = ?1",
            params![workspace_id],
        )?;
        Ok(())
    }

    // --- Pinned Commands ---

    pub fn list_pinned_commands(
        &self,
        repo_id: &str,
    ) -> Result<Vec<PinnedCommand>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT p.id, p.repo_id, p.command_name, p.sort_order, p.created_at,
                    COALESCE((
                        SELECT SUM(u.use_count)
                        FROM slash_command_usage u
                        JOIN workspaces w ON w.id = u.workspace_id
                        WHERE w.repository_id = p.repo_id
                          AND u.command_name = p.command_name
                    ), 0) AS use_count
             FROM pinned_commands p
             WHERE p.repo_id = ?1
             ORDER BY use_count DESC, p.sort_order, p.id",
        )?;
        let rows = stmt.query_map(params![repo_id], |row| {
            Ok(PinnedCommand {
                id: row.get(0)?,
                repo_id: row.get(1)?,
                command_name: row.get(2)?,
                sort_order: row.get(3)?,
                created_at: row.get(4)?,
                use_count: row.get(5)?,
            })
        })?;
        rows.collect()
    }

    pub fn insert_pinned_command(
        &self,
        repo_id: &str,
        command_name: &str,
    ) -> Result<PinnedCommand, rusqlite::Error> {
        let max_order: i32 = self.conn.query_row(
            "SELECT COALESCE(MAX(sort_order), -1) FROM pinned_commands WHERE repo_id = ?1",
            params![repo_id],
            |row| row.get(0),
        )?;
        let created_at: String = self
            .conn
            .query_row("SELECT datetime('now')", [], |row| row.get(0))?;
        self.conn.execute(
            "INSERT INTO pinned_commands (repo_id, command_name, sort_order, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![repo_id, command_name, max_order + 1, created_at],
        )?;
        Ok(PinnedCommand {
            id: self.conn.last_insert_rowid(),
            repo_id: repo_id.to_string(),
            command_name: command_name.to_string(),
            sort_order: max_order + 1,
            created_at,
            use_count: 0,
        })
    }

    pub fn delete_pinned_command(&self, id: i64) -> Result<(), rusqlite::Error> {
        self.conn
            .execute("DELETE FROM pinned_commands WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn reorder_pinned_commands(
        &self,
        repo_id: &str,
        ids: &[i64],
    ) -> Result<(), rusqlite::Error> {
        let tx = self.conn.unchecked_transaction()?;
        {
            let mut stmt = tx.prepare(
                "UPDATE pinned_commands SET sort_order = ?1 WHERE id = ?2 AND repo_id = ?3",
            )?;
            for (i, id) in ids.iter().enumerate() {
                stmt.execute(params![i as i32, id, repo_id])?;
            }
        }
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{AgentStatus, Attachment, ChatRole, WorkspaceStatus};

    fn make_repo(id: &str, path: &str, name: &str) -> Repository {
        Repository {
            id: id.into(),
            path: path.into(),
            name: name.into(),
            path_slug: name.into(),
            icon: None,
            created_at: String::new(),
            setup_script: None,
            custom_instructions: None,
            sort_order: 0,
            branch_rename_preferences: None,
            setup_script_auto_run: false,
            base_branch: None,
            default_remote: None,
            path_valid: true,
        }
    }

    fn make_workspace(id: &str, repo_id: &str, name: &str) -> Workspace {
        Workspace {
            id: id.into(),
            repository_id: repo_id.into(),
            name: name.into(),
            branch_name: format!("claudette/{name}"),
            worktree_path: None,
            status: WorkspaceStatus::Active,
            agent_status: AgentStatus::Idle,
            status_line: String::new(),
            created_at: String::new(),
        }
    }

    #[test]
    fn test_insert_and_list_repositories() {
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1", "/tmp/repo1", "repo1"))
            .unwrap();
        db.insert_repository(&make_repo("r2", "/tmp/repo2", "repo2"))
            .unwrap();
        let repos = db.list_repositories().unwrap();
        assert_eq!(repos.len(), 2);
        assert_eq!(repos[0].name, "repo1");
        assert_eq!(repos[1].name, "repo2");
    }

    #[test]
    fn test_duplicate_repo_path_rejected() {
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1", "/tmp/repo1", "repo1"))
            .unwrap();
        let result = db.insert_repository(&make_repo("r2", "/tmp/repo1", "repo1-dup"));
        let err = result.expect_err("expected UNIQUE constraint failure");
        assert!(
            super::is_duplicate_repository_path_error(&err),
            "expected duplicate-path error, got: {err:?}",
        );
    }

    #[test]
    fn test_duplicate_repo_id_not_flagged_as_duplicate_path() {
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1", "/tmp/repo1", "repo1"))
            .unwrap();
        let err = db
            .insert_repository(&make_repo("r1", "/tmp/repo2", "repo2"))
            .expect_err("expected PRIMARY KEY constraint failure on id");
        assert!(
            !super::is_duplicate_repository_path_error(&err),
            "id collision should not be mapped to the duplicate-path branch: {err:?}",
        );
    }

    #[test]
    fn test_insert_and_list_workspaces() {
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1", "/tmp/repo1", "repo1"))
            .unwrap();
        db.insert_workspace(&make_workspace("w1", "r1", "fix-bug"))
            .unwrap();
        db.insert_workspace(&make_workspace("w2", "r1", "add-feature"))
            .unwrap();
        let workspaces = db.list_workspaces().unwrap();
        assert_eq!(workspaces.len(), 2);
        assert_eq!(workspaces[0].name, "fix-bug");
        assert_eq!(workspaces[0].status, WorkspaceStatus::Active);
    }

    #[test]
    fn test_update_workspace_status() {
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1", "/tmp/repo1", "repo1"))
            .unwrap();
        db.insert_workspace(&make_workspace("w1", "r1", "fix-bug"))
            .unwrap();
        db.update_workspace_status("w1", &WorkspaceStatus::Archived, None)
            .unwrap();
        let workspaces = db.list_workspaces().unwrap();
        assert_eq!(workspaces[0].status, WorkspaceStatus::Archived);
        assert!(workspaces[0].worktree_path.is_none());
    }

    #[test]
    fn test_rename_workspace() {
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1", "/tmp/repo1", "repo1"))
            .unwrap();
        db.insert_workspace(&make_workspace("w1", "r1", "old-name"))
            .unwrap();
        db.rename_workspace("w1", "new-name", "claudette/new-name")
            .unwrap();
        let workspaces = db.list_workspaces().unwrap();
        assert_eq!(workspaces[0].name, "new-name");
        assert_eq!(workspaces[0].branch_name, "claudette/new-name");
    }

    #[test]
    fn test_update_workspace_branch_name() {
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1", "/tmp/repo1", "repo1"))
            .unwrap();
        db.insert_workspace(&make_workspace("w1", "r1", "friendly-name"))
            .unwrap();
        db.update_workspace_branch_name("w1", "eben/renamed-branch")
            .unwrap();
        let workspaces = db.list_workspaces().unwrap();
        assert_eq!(workspaces[0].name, "friendly-name");
        assert_eq!(workspaces[0].branch_name, "eben/renamed-branch");
    }

    #[test]
    fn test_rename_workspace_unique_conflict() {
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1", "/tmp/repo1", "repo1"))
            .unwrap();
        db.insert_workspace(&make_workspace("w1", "r1", "name-a"))
            .unwrap();
        db.insert_workspace(&make_workspace("w2", "r1", "name-b"))
            .unwrap();
        // Renaming w1 to "name-b" should fail (unique constraint).
        let result = db.rename_workspace("w1", "name-b", "claudette/name-b");
        assert!(result.is_err());
    }

    #[test]
    fn test_rename_workspace_nonexistent_id() {
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1", "/tmp/repo1", "repo1"))
            .unwrap();
        // Renaming a workspace that doesn't exist should fail.
        let result = db.rename_workspace("no-such-id", "new-name", "claudette/new-name");
        assert!(result.is_err());
    }

    #[test]
    fn test_update_workspace_name() {
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1", "/tmp/repo1", "repo1"))
            .unwrap();
        db.insert_workspace(&make_workspace("w1", "r1", "old-name"))
            .unwrap();
        db.update_workspace_name("w1", "new-name").unwrap();
        let workspaces = db.list_workspaces().unwrap();
        assert_eq!(workspaces[0].name, "new-name");
        assert_eq!(workspaces[0].branch_name, "claudette/old-name");
    }

    #[test]
    fn test_update_workspace_name_unique_conflict() {
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1", "/tmp/repo1", "repo1"))
            .unwrap();
        db.insert_workspace(&make_workspace("w1", "r1", "name-a"))
            .unwrap();
        db.insert_workspace(&make_workspace("w2", "r1", "name-b"))
            .unwrap();
        let result = db.update_workspace_name("w1", "name-b");
        assert!(result.is_err());
    }

    #[test]
    fn test_update_workspace_name_nonexistent() {
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1", "/tmp/repo1", "repo1"))
            .unwrap();
        let result = db.update_workspace_name("no-such-id", "new-name");
        assert!(result.is_err());
    }

    #[test]
    fn test_update_workspace_name_cross_repo_ok() {
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1", "/tmp/repo1", "repo1"))
            .unwrap();
        db.insert_repository(&make_repo("r2", "/tmp/repo2", "repo2"))
            .unwrap();
        db.insert_workspace(&make_workspace("w1", "r1", "shared-name"))
            .unwrap();
        db.insert_workspace(&make_workspace("w2", "r2", "other-name"))
            .unwrap();
        db.update_workspace_name("w2", "shared-name").unwrap();
    }

    #[test]
    fn test_is_branch_auto_rename_claimed_defaults_false() {
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1", "/tmp/repo1", "repo1"))
            .unwrap();
        db.insert_workspace(&make_workspace("w1", "r1", "fresh"))
            .unwrap();
        assert!(!db.is_branch_auto_rename_claimed("w1").unwrap());
    }

    #[test]
    fn test_is_branch_auto_rename_claimed_missing_returns_false() {
        // Nonexistent workspaces should read as "not claimed" rather than
        // erroring so callers can treat the missing row as a no-op.
        let db = Database::open_in_memory().unwrap();
        assert!(!db.is_branch_auto_rename_claimed("no-such-id").unwrap());
    }

    #[test]
    fn test_claim_branch_auto_rename_is_one_shot() {
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1", "/tmp/repo1", "repo1"))
            .unwrap();
        db.insert_workspace(&make_workspace("w1", "r1", "fresh"))
            .unwrap();
        // First claim wins, flag flips to 1.
        assert!(db.claim_branch_auto_rename("w1").unwrap());
        assert!(db.is_branch_auto_rename_claimed("w1").unwrap());
        // Second claim is rejected — this is the property that prevents a
        // session restart from re-triggering rename.
        assert!(!db.claim_branch_auto_rename("w1").unwrap());
    }

    #[test]
    fn test_claim_branch_auto_rename_nonexistent_workspace() {
        let db = Database::open_in_memory().unwrap();
        // No row to update, so nothing is claimed. Must not error.
        assert!(!db.claim_branch_auto_rename("no-such-id").unwrap());
    }

    #[test]
    fn test_migration_23_backfill_sql_marks_workspaces_with_chat_history() {
        // Verifies the backfill UPDATE the migration runs: workspaces that
        // already have chat messages at upgrade time get
        // `branch_auto_rename_claimed = 1` so a later turn won't rename them,
        // while chatless workspaces stay at 0 so their first-prompt rename
        // still fires. We exercise the exact UPDATE statement embedded in the
        // version-23 migration against a seeded DB — `open_in_memory` runs
        // migrations on an empty schema, so the only way to observe the
        // backfill path is to re-run its statement after seeding.
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1", "/tmp/repo1", "repo1"))
            .unwrap();
        db.insert_workspace(&make_workspace("w1", "r1", "talked"))
            .unwrap();
        db.insert_workspace(&make_workspace("w2", "r1", "never-talked"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::User, "hi"))
            .unwrap();
        db.conn
            .execute_batch(
                "UPDATE workspaces SET branch_auto_rename_claimed = 1
                   WHERE id IN (SELECT DISTINCT workspace_id FROM chat_messages);",
            )
            .unwrap();
        assert!(db.is_branch_auto_rename_claimed("w1").unwrap());
        assert!(!db.is_branch_auto_rename_claimed("w2").unwrap());
    }

    #[test]
    fn test_delete_workspace() {
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1", "/tmp/repo1", "repo1"))
            .unwrap();
        db.insert_workspace(&make_workspace("w1", "r1", "fix-bug"))
            .unwrap();
        db.delete_workspace("w1").unwrap();
        let workspaces = db.list_workspaces().unwrap();
        assert!(workspaces.is_empty());
    }

    #[test]
    fn test_delete_repository_cascades() {
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1", "/tmp/repo1", "repo1"))
            .unwrap();
        db.insert_workspace(&make_workspace("w1", "r1", "fix-bug"))
            .unwrap();
        db.insert_workspace(&make_workspace("w2", "r1", "feature"))
            .unwrap();
        db.delete_repository("r1").unwrap();
        let workspaces = db.list_workspaces().unwrap();
        assert!(workspaces.is_empty());
    }

    // --- Agent session persistence tests ---

    #[test]
    fn test_save_and_get_agent_session() {
        let db = setup_db_with_workspace();
        db.save_agent_session("w1", "sess-abc", 3).unwrap();
        let result = db.get_agent_session("w1").unwrap();
        assert_eq!(result, Some(("sess-abc".into(), 3)));
    }

    #[test]
    fn test_get_agent_session_returns_none_when_no_session() {
        let db = setup_db_with_workspace();
        let result = db.get_agent_session("w1").unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_get_agent_session_returns_none_for_missing_workspace() {
        let db = Database::open_in_memory().unwrap();
        let result = db.get_agent_session("nonexistent").unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_clear_agent_session() {
        let db = setup_db_with_workspace();
        db.save_agent_session("w1", "sess-abc", 5).unwrap();
        db.clear_agent_session("w1").unwrap();
        let result = db.get_agent_session("w1").unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_save_agent_session_overwrites() {
        let db = setup_db_with_workspace();
        db.save_agent_session("w1", "sess-1", 1).unwrap();
        db.save_agent_session("w1", "sess-2", 4).unwrap();
        let result = db.get_agent_session("w1").unwrap();
        assert_eq!(result, Some(("sess-2".into(), 4)));
    }

    // --- Chat message tests ---

    /// Build a `ChatMessage` anchored to the workspace's default active
    /// session. Tests use `insert_workspace`, which seeds one active session,
    /// so this resolves cleanly.
    fn make_chat_msg(
        db: &Database,
        id: &str,
        ws_id: &str,
        role: ChatRole,
        content: &str,
    ) -> ChatMessage {
        let chat_session_id = db
            .default_session_id_for_workspace(ws_id)
            .unwrap()
            .expect("workspace must have a default session for tests");
        ChatMessage {
            id: id.into(),
            workspace_id: ws_id.into(),
            chat_session_id,
            role,
            content: content.into(),
            cost_usd: None,
            duration_ms: None,
            created_at: String::new(),
            thinking: None,
            input_tokens: None,
            output_tokens: None,
            cache_read_tokens: None,
            cache_creation_tokens: None,
        }
    }

    fn setup_db_with_workspace() -> Database {
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1", "/tmp/repo1", "repo1"))
            .unwrap();
        db.insert_workspace(&make_workspace("w1", "r1", "fix-bug"))
            .unwrap();
        db
    }

    #[test]
    fn test_insert_and_list_chat_messages() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::User, "hello"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(
            &db,
            "m2",
            "w1",
            ChatRole::Assistant,
            "hi there",
        ))
        .unwrap();
        let msgs = db.list_chat_messages("w1").unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].content, "hello");
        assert_eq!(msgs[1].content, "hi there");
    }

    #[test]
    fn test_chat_messages_filtered_by_workspace() {
        let db = setup_db_with_workspace();
        db.insert_workspace(&make_workspace("w2", "r1", "feature"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::User, "for w1"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m2", "w2", ChatRole::User, "for w2"))
            .unwrap();
        let msgs = db.list_chat_messages("w1").unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].content, "for w1");
    }

    #[test]
    fn test_update_chat_message_content() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(
            &db,
            "m1",
            "w1",
            ChatRole::Assistant,
            "partial",
        ))
        .unwrap();
        db.update_chat_message_content("m1", "partial response complete")
            .unwrap();
        let msgs = db.list_chat_messages("w1").unwrap();
        assert_eq!(msgs[0].content, "partial response complete");
    }

    #[test]
    fn test_update_chat_message_cost() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::Assistant, "done"))
            .unwrap();
        db.update_chat_message_cost("m1", 0.005, 2000).unwrap();
        let msgs = db.list_chat_messages("w1").unwrap();
        assert!((msgs[0].cost_usd.unwrap() - 0.005).abs() < f64::EPSILON);
        assert_eq!(msgs[0].duration_ms.unwrap(), 2000);
    }

    #[test]
    fn test_delete_chat_messages_for_workspace() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::User, "msg1"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m2", "w1", ChatRole::Assistant, "msg2"))
            .unwrap();
        db.delete_chat_messages_for_workspace("w1").unwrap();
        let msgs = db.list_chat_messages("w1").unwrap();
        assert!(msgs.is_empty());
    }

    #[test]
    fn test_chat_messages_cascade_on_workspace_delete() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::User, "hello"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m2", "w1", ChatRole::Assistant, "hi"))
            .unwrap();
        db.delete_workspace("w1").unwrap();
        let msgs = db.list_chat_messages("w1").unwrap();
        assert!(msgs.is_empty());
    }

    #[test]
    fn test_chat_message_role_roundtrip() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::User, "user msg"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(
            &db,
            "m2",
            "w1",
            ChatRole::Assistant,
            "asst msg",
        ))
        .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m3", "w1", ChatRole::System, "sys msg"))
            .unwrap();
        let msgs = db.list_chat_messages("w1").unwrap();
        assert_eq!(msgs[0].role, ChatRole::User);
        assert_eq!(msgs[1].role, ChatRole::Assistant);
        assert_eq!(msgs[2].role, ChatRole::System);
    }

    #[test]
    fn test_chat_message_tokens_round_trip() {
        let db = setup_db_with_workspace();
        let mut msg = make_chat_msg(&db, "mt1", "w1", ChatRole::Assistant, "hello");
        msg.input_tokens = Some(1234);
        msg.output_tokens = Some(56);
        msg.cache_read_tokens = Some(100_000);
        msg.cache_creation_tokens = Some(7_000);
        db.insert_chat_message(&msg).unwrap();

        let msgs = db.list_chat_messages("w1").unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].input_tokens, Some(1234));
        assert_eq!(msgs[0].output_tokens, Some(56));
        assert_eq!(msgs[0].cache_read_tokens, Some(100_000));
        assert_eq!(msgs[0].cache_creation_tokens, Some(7_000));
    }

    #[test]
    fn test_chat_message_tokens_null_round_trip() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "mt2", "w1", ChatRole::Assistant, "hi"))
            .unwrap();

        let msgs = db.list_chat_messages("w1").unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].input_tokens, None);
        assert_eq!(msgs[0].output_tokens, None);
        assert_eq!(msgs[0].cache_read_tokens, None);
        assert_eq!(msgs[0].cache_creation_tokens, None);
    }

    // --- Attachment tests ---

    fn make_attachment(id: &str, message_id: &str, filename: &str) -> Attachment {
        Attachment {
            id: id.into(),
            message_id: message_id.into(),
            filename: filename.into(),
            media_type: "image/png".into(),
            data: vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], // PNG header
            width: Some(100),
            height: Some(200),
            size_bytes: 8,
            created_at: String::new(),
            origin: AttachmentOrigin::User,
            tool_use_id: None,
        }
    }

    #[test]
    fn test_insert_and_list_attachments() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(
            &db,
            "m1",
            "w1",
            ChatRole::User,
            "look at this",
        ))
        .unwrap();
        db.insert_attachment(&make_attachment("a1", "m1", "screenshot.png"))
            .unwrap();

        let atts = db.list_attachments_for_message("m1").unwrap();
        assert_eq!(atts.len(), 1);
        assert_eq!(atts[0].id, "a1");
        assert_eq!(atts[0].filename, "screenshot.png");
        assert_eq!(atts[0].media_type, "image/png");
        assert_eq!(
            atts[0].data,
            vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
        );
        assert_eq!(atts[0].width, Some(100));
        assert_eq!(atts[0].height, Some(200));
        assert_eq!(atts[0].size_bytes, 8);
    }

    #[test]
    fn test_attachment_cascade_on_message_delete() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::User, "img"))
            .unwrap();
        db.insert_attachment(&make_attachment("a1", "m1", "pic.png"))
            .unwrap();

        // Deleting all messages for the workspace should cascade to attachments.
        db.delete_chat_messages_for_workspace("w1").unwrap();
        let atts = db.list_attachments_for_message("m1").unwrap();
        assert!(atts.is_empty());
    }

    #[test]
    fn test_attachment_cascade_on_delete_messages_after() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::User, "first"))
            .unwrap();
        db.insert_attachment(&make_attachment("a1", "m1", "first.png"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m2", "w1", ChatRole::User, "second"))
            .unwrap();
        db.insert_attachment(&make_attachment("a2", "m2", "second.png"))
            .unwrap();

        // Delete messages after m1 — m2 and its attachment should be gone.
        db.delete_messages_after("w1", "m1").unwrap();

        let atts_m1 = db.list_attachments_for_message("m1").unwrap();
        assert_eq!(atts_m1.len(), 1, "first message attachment should survive");
        let atts_m2 = db.list_attachments_for_message("m2").unwrap();
        assert!(
            atts_m2.is_empty(),
            "second message attachment should be deleted"
        );
    }

    #[test]
    fn test_insert_attachments_batch() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::User, "images"))
            .unwrap();

        let attachments = vec![
            make_attachment("a1", "m1", "one.png"),
            make_attachment("a2", "m1", "two.jpg"),
            make_attachment("a3", "m1", "three.gif"),
        ];
        db.insert_attachments_batch(&attachments).unwrap();

        let atts = db.list_attachments_for_message("m1").unwrap();
        assert_eq!(atts.len(), 3);
    }

    #[test]
    fn test_insert_attachments_batch_empty() {
        let db = setup_db_with_workspace();
        // Should be a no-op, not an error.
        db.insert_attachments_batch(&[]).unwrap();
    }

    #[test]
    fn test_get_attachment_by_id() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::User, "hello"))
            .unwrap();
        db.insert_attachment(&make_attachment("a1", "m1", "doc.pdf"))
            .unwrap();

        let att = db.get_attachment("a1").unwrap().unwrap();
        assert_eq!(att.filename, "doc.pdf");
        assert_eq!(att.data.len(), 8); // PNG header bytes from make_attachment
    }

    #[test]
    fn test_get_attachment_not_found() {
        let db = setup_db_with_workspace();
        let result = db.get_attachment("nonexistent").unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_list_attachments_for_messages_batch() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::User, "msg1"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m2", "w1", ChatRole::User, "msg2"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m3", "w1", ChatRole::User, "msg3"))
            .unwrap();
        db.insert_attachment(&make_attachment("a1", "m1", "pic1.png"))
            .unwrap();
        db.insert_attachment(&make_attachment("a2", "m1", "pic2.png"))
            .unwrap();
        db.insert_attachment(&make_attachment("a3", "m2", "pic3.jpg"))
            .unwrap();
        // m3 has no attachments.

        let ids = vec!["m1".into(), "m2".into(), "m3".into()];
        let map = db.list_attachments_for_messages(&ids).unwrap();

        assert_eq!(map.get("m1").map(|v| v.len()), Some(2));
        assert_eq!(map.get("m2").map(|v| v.len()), Some(1));
        assert!(!map.contains_key("m3"), "m3 should have no entry");
    }

    #[test]
    fn test_insert_agent_attachment_round_trips_with_tool_use_id() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::Assistant, "here"))
            .unwrap();
        let att = Attachment {
            id: "ag1".into(),
            message_id: "m1".into(),
            filename: "shot.png".into(),
            media_type: "image/png".into(),
            data: vec![0x89, 0x50, 0x4E, 0x47],
            width: Some(640),
            height: Some(480),
            size_bytes: 4,
            created_at: String::new(),
            origin: AttachmentOrigin::Agent,
            tool_use_id: Some("toolu_42".into()),
        };
        db.insert_attachment(&att).unwrap();

        let got = db.get_attachment("ag1").unwrap().unwrap();
        assert_eq!(got.origin, AttachmentOrigin::Agent);
        assert_eq!(got.tool_use_id.as_deref(), Some("toolu_42"));
        assert_eq!(got.filename, "shot.png");
        assert_eq!(got.size_bytes, 4);
    }

    #[test]
    fn test_list_attachments_by_tool_use_id_filters_correctly() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::Assistant, "x"))
            .unwrap();
        let mk = |id: &str, tuid: Option<&str>| Attachment {
            id: id.into(),
            message_id: "m1".into(),
            filename: format!("{id}.png"),
            media_type: "image/png".into(),
            data: vec![0],
            width: None,
            height: None,
            size_bytes: 1,
            created_at: String::new(),
            origin: AttachmentOrigin::Agent,
            tool_use_id: tuid.map(String::from),
        };
        db.insert_attachment(&mk("a1", Some("toolu_1"))).unwrap();
        db.insert_attachment(&mk("a2", Some("toolu_1"))).unwrap();
        db.insert_attachment(&mk("a3", Some("toolu_2"))).unwrap();
        db.insert_attachment(&mk("a4", None)).unwrap();

        let one = db.list_attachments_by_tool_use("toolu_1").unwrap();
        assert_eq!(one.len(), 2);
        assert!(
            one.iter()
                .all(|a| a.tool_use_id.as_deref() == Some("toolu_1"))
        );

        let two = db.list_attachments_by_tool_use("toolu_2").unwrap();
        assert_eq!(two.len(), 1);

        let none = db.list_attachments_by_tool_use("missing").unwrap();
        assert!(none.is_empty());
    }

    #[test]
    fn test_existing_user_attachment_loads_with_user_origin() {
        // Verifies row_to_attachment correctly populates origin for legacy
        // rows inserted via the User-shaped path.
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::User, "hi"))
            .unwrap();
        db.insert_attachment(&make_attachment("a1", "m1", "u.png"))
            .unwrap();
        let got = db.get_attachment("a1").unwrap().unwrap();
        assert_eq!(got.origin, AttachmentOrigin::User);
        assert!(got.tool_use_id.is_none());
    }

    #[test]
    fn test_attachments_origin_defaults_to_user_for_existing_rows() {
        // Migration adds `origin TEXT NOT NULL DEFAULT 'user'` so any pre-
        // existing row is implicitly user-supplied without a backfill step.
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::User, "img"))
            .unwrap();
        db.insert_attachment(&make_attachment("a1", "m1", "u.png"))
            .unwrap();

        let origin: String = db
            .conn
            .query_row(
                "SELECT origin FROM attachments WHERE id = ?1",
                params!["a1"],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(origin, "user");

        let tool_use_id: Option<String> = db
            .conn
            .query_row(
                "SELECT tool_use_id FROM attachments WHERE id = ?1",
                params!["a1"],
                |r| r.get(0),
            )
            .unwrap();
        assert!(tool_use_id.is_none());
    }

    #[test]
    fn test_attachments_origin_check_rejects_invalid_values() {
        // The CHECK constraint enforces origin ∈ {'user','agent'}; arbitrary
        // strings must be rejected at write time so the column can be trusted
        // as an enum from Rust's side.
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::User, "x"))
            .unwrap();
        let res = db.conn.execute(
            "INSERT INTO attachments (id, message_id, filename, media_type, data, size_bytes, origin)
             VALUES ('a1', 'm1', 'x.png', 'image/png', x'00', 1, 'bogus')",
            [],
        );
        assert!(res.is_err(), "CHECK should reject bogus origin");
    }

    #[test]
    fn test_attachments_can_insert_agent_origin_with_tool_use_id() {
        // Direct-SQL canary: confirms an agent-origin row with a tool_use_id
        // can be written. The Rust API for this lands in slice 2.
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::Assistant, "here"))
            .unwrap();
        db.conn.execute(
            "INSERT INTO attachments (id, message_id, filename, media_type, data, size_bytes, origin, tool_use_id)
             VALUES ('a1', 'm1', 'shot.png', 'image/png', x'89504E47', 4, 'agent', 'toolu_123')",
            [],
        ).unwrap();

        let (origin, tool_use_id): (String, Option<String>) = db
            .conn
            .query_row(
                "SELECT origin, tool_use_id FROM attachments WHERE id = 'a1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(origin, "agent");
        assert_eq!(tool_use_id.as_deref(), Some("toolu_123"));
    }

    // --- Repository settings tests ---

    #[test]
    fn test_update_repository_name() {
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1", "/tmp/repo1", "repo1"))
            .unwrap();
        db.update_repository_name("r1", "My Custom Name").unwrap();
        let repos = db.list_repositories().unwrap();
        assert_eq!(repos[0].name, "My Custom Name");
        // path_slug should remain unchanged
        assert_eq!(repos[0].path_slug, "repo1");
    }

    #[test]
    fn test_update_repository_icon() {
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1", "/tmp/repo1", "repo1"))
            .unwrap();

        // Set icon
        db.update_repository_icon("r1", Some("rocket")).unwrap();
        let repos = db.list_repositories().unwrap();
        assert_eq!(repos[0].icon.as_deref(), Some("rocket"));

        // Clear icon
        db.update_repository_icon("r1", None).unwrap();
        let repos = db.list_repositories().unwrap();
        assert!(repos[0].icon.is_none());
    }

    #[test]
    fn test_repository_path_slug_persisted() {
        let db = Database::open_in_memory().unwrap();
        let repo = Repository {
            id: "r1".into(),
            path: "/tmp/my-project".into(),
            name: "My Project".into(),
            path_slug: "my-project".into(),
            icon: None,
            created_at: String::new(),
            setup_script: None,
            custom_instructions: None,
            sort_order: 0,
            branch_rename_preferences: None,
            setup_script_auto_run: false,
            base_branch: None,
            default_remote: None,
            path_valid: true,
        };
        db.insert_repository(&repo).unwrap();
        let repos = db.list_repositories().unwrap();
        assert_eq!(repos[0].name, "My Project");
        assert_eq!(repos[0].path_slug, "my-project");
    }

    // --- App settings tests ---

    #[test]
    fn test_get_set_app_setting() {
        let db = Database::open_in_memory().unwrap();
        db.set_app_setting("worktree_base_dir", "/custom/path")
            .unwrap();
        let val = db.get_app_setting("worktree_base_dir").unwrap();
        assert_eq!(val.as_deref(), Some("/custom/path"));
    }

    #[test]
    fn test_get_app_setting_missing() {
        let db = Database::open_in_memory().unwrap();
        let val = db.get_app_setting("nonexistent_key").unwrap();
        assert!(val.is_none());
    }

    #[test]
    fn test_set_app_setting_upsert() {
        let db = Database::open_in_memory().unwrap();
        db.set_app_setting("key1", "value1").unwrap();
        db.set_app_setting("key1", "value2").unwrap();
        let val = db.get_app_setting("key1").unwrap();
        assert_eq!(val.as_deref(), Some("value2"));
    }

    // --- Terminal tab tests ---

    fn make_terminal_tab(id: i64, ws_id: &str, title: &str) -> TerminalTab {
        TerminalTab {
            id,
            workspace_id: ws_id.into(),
            title: title.into(),
            is_script_output: false,
            sort_order: 0,
            created_at: String::new(),
        }
    }

    #[test]
    fn test_insert_and_list_terminal_tabs() {
        let db = setup_db_with_workspace();
        db.insert_terminal_tab(&make_terminal_tab(1, "w1", "Terminal 1"))
            .unwrap();
        db.insert_terminal_tab(&make_terminal_tab(2, "w1", "Terminal 2"))
            .unwrap();
        let tabs = db.list_terminal_tabs_by_workspace("w1").unwrap();
        assert_eq!(tabs.len(), 2);
        assert_eq!(tabs[0].title, "Terminal 1");
        assert_eq!(tabs[1].title, "Terminal 2");
    }

    #[test]
    fn test_terminal_tabs_filtered_by_workspace() {
        let db = setup_db_with_workspace();
        db.insert_workspace(&make_workspace("w2", "r1", "feature"))
            .unwrap();
        db.insert_terminal_tab(&make_terminal_tab(1, "w1", "T1"))
            .unwrap();
        db.insert_terminal_tab(&make_terminal_tab(2, "w2", "T2"))
            .unwrap();
        let tabs = db.list_terminal_tabs_by_workspace("w1").unwrap();
        assert_eq!(tabs.len(), 1);
        assert_eq!(tabs[0].title, "T1");
    }

    #[test]
    fn test_delete_terminal_tab() {
        let db = setup_db_with_workspace();
        db.insert_terminal_tab(&make_terminal_tab(1, "w1", "Terminal 1"))
            .unwrap();
        db.delete_terminal_tab(1).unwrap();
        let tabs = db.list_terminal_tabs_by_workspace("w1").unwrap();
        assert!(tabs.is_empty());
    }

    #[test]
    fn test_terminal_tabs_cascade_on_workspace_delete() {
        let db = setup_db_with_workspace();
        db.insert_terminal_tab(&make_terminal_tab(1, "w1", "Terminal 1"))
            .unwrap();
        db.insert_terminal_tab(&make_terminal_tab(2, "w1", "Terminal 2"))
            .unwrap();
        db.delete_workspace("w1").unwrap();
        let tabs = db.list_terminal_tabs_by_workspace("w1").unwrap();
        assert!(tabs.is_empty());
    }

    #[test]
    fn test_terminal_tab_script_output_flag() {
        let db = setup_db_with_workspace();
        let mut tab = make_terminal_tab(1, "w1", "npm run dev");
        tab.is_script_output = true;
        db.insert_terminal_tab(&tab).unwrap();
        let tabs = db.list_terminal_tabs_by_workspace("w1").unwrap();
        assert!(tabs[0].is_script_output);
    }

    #[test]
    fn test_update_terminal_tab_title() {
        let db = setup_db_with_workspace();
        db.insert_terminal_tab(&make_terminal_tab(1, "w1", "Terminal 1"))
            .unwrap();
        db.update_terminal_tab_title(1, "My Custom Terminal")
            .unwrap();
        let tabs = db.list_terminal_tabs_by_workspace("w1").unwrap();
        assert_eq!(tabs[0].title, "My Custom Terminal");
    }

    #[test]
    fn test_last_message_per_workspace() {
        let db = setup_db_with_workspace();
        db.insert_workspace(&make_workspace("w2", "r1", "feature"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::User, "first"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(
            &db,
            "m2",
            "w1",
            ChatRole::Assistant,
            "second",
        ))
        .unwrap();
        db.insert_chat_message(&make_chat_msg(
            &db,
            "m3",
            "w2",
            ChatRole::User,
            "other workspace",
        ))
        .unwrap();

        let last = db.last_message_per_workspace().unwrap();
        assert_eq!(last.len(), 2);

        let w1_msg = last.iter().find(|m| m.workspace_id == "w1").unwrap();
        assert_eq!(w1_msg.content, "second");

        let w2_msg = last.iter().find(|m| m.workspace_id == "w2").unwrap();
        assert_eq!(w2_msg.content, "other workspace");
    }

    #[test]
    fn test_last_message_per_workspace_same_timestamp() {
        let db = setup_db_with_workspace();
        // Insert two messages with identical timestamps — the later rowid should win.
        let mut m1 = make_chat_msg(&db, "m1", "w1", ChatRole::User, "first");
        m1.created_at = "2026-01-01 00:00:00".into();
        let mut m2 = make_chat_msg(&db, "m2", "w1", ChatRole::Assistant, "second");
        m2.created_at = "2026-01-01 00:00:00".into();
        db.insert_chat_message(&m1).unwrap();
        db.insert_chat_message(&m2).unwrap();

        let last = db.last_message_per_workspace().unwrap();
        assert_eq!(last.len(), 1);
        assert_eq!(last[0].content, "second");
    }

    #[test]
    fn test_last_message_empty_when_no_messages() {
        let db = setup_db_with_workspace();
        let last = db.last_message_per_workspace().unwrap();
        assert!(last.is_empty());
    }

    // --- Remote connection tests ---

    use crate::model::RemoteConnection as RemoteConn;

    fn make_remote_conn(id: &str, name: &str, host: &str, port: u16) -> RemoteConn {
        RemoteConn {
            id: id.into(),
            name: name.into(),
            host: host.into(),
            port,
            session_token: None,
            cert_fingerprint: None,
            auto_connect: false,
            created_at: String::new(),
        }
    }

    #[test]
    fn test_insert_and_list_remote_connections() {
        let db = Database::open_in_memory().unwrap();
        db.insert_remote_connection(&make_remote_conn("rc1", "Server A", "host-a.local", 7683))
            .unwrap();
        db.insert_remote_connection(&make_remote_conn("rc2", "Server B", "host-b.local", 9000))
            .unwrap();
        let conns = db.list_remote_connections().unwrap();
        assert_eq!(conns.len(), 2);
        assert_eq!(conns[0].name, "Server A");
        assert_eq!(conns[1].port, 9000);
    }

    #[test]
    fn test_get_remote_connection() {
        let db = Database::open_in_memory().unwrap();
        db.insert_remote_connection(&make_remote_conn("rc1", "Server A", "host-a.local", 7683))
            .unwrap();
        let conn = db.get_remote_connection("rc1").unwrap().unwrap();
        assert_eq!(conn.host, "host-a.local");
        assert!(!conn.created_at.is_empty()); // DB default fills this
    }

    #[test]
    fn test_get_remote_connection_missing() {
        let db = Database::open_in_memory().unwrap();
        let conn = db.get_remote_connection("nonexistent").unwrap();
        assert!(conn.is_none());
    }

    #[test]
    fn test_update_remote_connection_session() {
        let db = Database::open_in_memory().unwrap();
        db.insert_remote_connection(&make_remote_conn("rc1", "Server A", "host-a.local", 7683))
            .unwrap();
        db.update_remote_connection_session("rc1", "tok-123", "fp-abc")
            .unwrap();
        let conn = db.get_remote_connection("rc1").unwrap().unwrap();
        assert_eq!(conn.session_token.as_deref(), Some("tok-123"));
        assert_eq!(conn.cert_fingerprint.as_deref(), Some("fp-abc"));
    }

    #[test]
    fn test_delete_remote_connection() {
        let db = Database::open_in_memory().unwrap();
        db.insert_remote_connection(&make_remote_conn("rc1", "Server A", "host-a.local", 7683))
            .unwrap();
        db.delete_remote_connection("rc1").unwrap();
        let conns = db.list_remote_connections().unwrap();
        assert!(conns.is_empty());
    }

    #[test]
    fn test_remote_connection_auto_connect_flag() {
        let db = Database::open_in_memory().unwrap();
        let mut conn = make_remote_conn("rc1", "Server A", "host-a.local", 7683);
        conn.auto_connect = true;
        db.insert_remote_connection(&conn).unwrap();
        let fetched = db.get_remote_connection("rc1").unwrap().unwrap();
        assert!(fetched.auto_connect);
    }

    #[test]
    fn test_record_slash_command_usage_insert_and_increment() {
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1", "/tmp/r1", "repo1"))
            .unwrap();
        db.insert_workspace(&make_workspace("w1", "r1", "ws1"))
            .unwrap();

        // First use creates the row with count 1.
        db.record_slash_command_usage("w1", "commit").unwrap();
        let usage = db.get_slash_command_usage("w1").unwrap();
        assert_eq!(usage.get("commit"), Some(&1));

        // Second use increments to 2.
        db.record_slash_command_usage("w1", "commit").unwrap();
        let usage = db.get_slash_command_usage("w1").unwrap();
        assert_eq!(usage.get("commit"), Some(&2));
    }

    #[test]
    fn test_get_slash_command_usage_empty() {
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1", "/tmp/r1", "repo1"))
            .unwrap();
        db.insert_workspace(&make_workspace("w1", "r1", "ws1"))
            .unwrap();

        let usage = db.get_slash_command_usage("w1").unwrap();
        assert!(usage.is_empty());
    }

    #[test]
    fn test_slash_command_usage_per_workspace() {
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1", "/tmp/r1", "repo1"))
            .unwrap();
        db.insert_workspace(&make_workspace("w1", "r1", "ws1"))
            .unwrap();
        db.insert_workspace(&make_workspace("w2", "r1", "ws2"))
            .unwrap();

        db.record_slash_command_usage("w1", "commit").unwrap();
        db.record_slash_command_usage("w1", "commit").unwrap();
        db.record_slash_command_usage("w2", "commit").unwrap();

        let usage_w1 = db.get_slash_command_usage("w1").unwrap();
        let usage_w2 = db.get_slash_command_usage("w2").unwrap();
        assert_eq!(usage_w1.get("commit"), Some(&2));
        assert_eq!(usage_w2.get("commit"), Some(&1));
    }

    #[test]
    fn test_slash_command_usage_cascade_delete() {
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1", "/tmp/r1", "repo1"))
            .unwrap();
        db.insert_workspace(&make_workspace("w1", "r1", "ws1"))
            .unwrap();

        db.record_slash_command_usage("w1", "commit").unwrap();
        db.delete_workspace("w1").unwrap();

        // After workspace deletion, usage rows should be gone.
        let usage = db.get_slash_command_usage("w1").unwrap();
        assert!(usage.is_empty());
    }

    // --- Conversation checkpoint tests ---

    /// Build a `ConversationCheckpoint` anchored to the workspace's default
    /// active session.
    fn make_checkpoint(
        db: &Database,
        id: &str,
        ws_id: &str,
        msg_id: &str,
        turn: i32,
    ) -> ConversationCheckpoint {
        let chat_session_id = db
            .default_session_id_for_workspace(ws_id)
            .unwrap()
            .expect("workspace must have a default session for tests");
        ConversationCheckpoint {
            id: id.into(),
            workspace_id: ws_id.into(),
            chat_session_id,
            message_id: msg_id.into(),
            commit_hash: Some(format!("abc{turn}")),
            has_file_state: false,
            turn_index: turn,
            message_count: 1,
            created_at: String::new(),
        }
    }

    #[test]
    fn test_checkpoint_crud() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::User, "q1"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m2", "w1", ChatRole::Assistant, "a1"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m3", "w1", ChatRole::User, "q2"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m4", "w1", ChatRole::Assistant, "a2"))
            .unwrap();

        db.insert_checkpoint(&make_checkpoint(&db, "cp1", "w1", "m2", 0))
            .unwrap();
        db.insert_checkpoint(&make_checkpoint(&db, "cp2", "w1", "m4", 1))
            .unwrap();

        // list
        let cps = db.list_checkpoints("w1").unwrap();
        assert_eq!(cps.len(), 2);
        assert_eq!(cps[0].turn_index, 0);
        assert_eq!(cps[1].turn_index, 1);

        // get
        let cp = db.get_checkpoint("cp1").unwrap().unwrap();
        assert_eq!(cp.message_id, "m2");

        // latest
        let latest = db.latest_checkpoint("w1").unwrap().unwrap();
        assert_eq!(latest.id, "cp2");
        assert_eq!(latest.turn_index, 1);
    }

    #[test]
    fn test_delete_messages_after() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::User, "q1"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m2", "w1", ChatRole::Assistant, "a1"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m3", "w1", ChatRole::User, "q2"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m4", "w1", ChatRole::Assistant, "a2"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m5", "w1", ChatRole::User, "q3"))
            .unwrap();

        let deleted = db.delete_messages_after("w1", "m2").unwrap();
        assert_eq!(deleted, 3);

        let msgs = db.list_chat_messages("w1").unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].id, "m1");
        assert_eq!(msgs[1].id, "m2");
    }

    #[test]
    fn test_delete_messages_after_last_message_deletes_nothing() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::User, "q1"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m2", "w1", ChatRole::Assistant, "a1"))
            .unwrap();

        let deleted = db.delete_messages_after("w1", "m2").unwrap();
        assert_eq!(deleted, 0);

        let msgs = db.list_chat_messages("w1").unwrap();
        assert_eq!(msgs.len(), 2);
    }

    #[test]
    fn test_delete_checkpoints_after() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::Assistant, "a1"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m2", "w1", ChatRole::Assistant, "a2"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m3", "w1", ChatRole::Assistant, "a3"))
            .unwrap();

        db.insert_checkpoint(&make_checkpoint(&db, "cp1", "w1", "m1", 0))
            .unwrap();
        db.insert_checkpoint(&make_checkpoint(&db, "cp2", "w1", "m2", 1))
            .unwrap();
        db.insert_checkpoint(&make_checkpoint(&db, "cp3", "w1", "m3", 2))
            .unwrap();

        let deleted = db.delete_checkpoints_after("w1", 0).unwrap();
        assert_eq!(deleted, 2);

        let cps = db.list_checkpoints("w1").unwrap();
        assert_eq!(cps.len(), 1);
        assert_eq!(cps[0].id, "cp1");
    }

    #[test]
    fn test_checkpoint_cascade_on_workspace_delete() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::Assistant, "a1"))
            .unwrap();
        db.insert_checkpoint(&make_checkpoint(&db, "cp1", "w1", "m1", 0))
            .unwrap();

        db.delete_workspace("w1").unwrap();

        let cps = db.list_checkpoints("w1").unwrap();
        assert!(cps.is_empty());
    }

    #[test]
    fn test_latest_checkpoint_returns_none_when_empty() {
        let db = setup_db_with_workspace();
        let result = db.latest_checkpoint("w1").unwrap();
        assert!(result.is_none());
    }

    // --- Turn tool activity tests ---

    fn make_tool_activity(id: &str, cp_id: &str, tool: &str, order: i32) -> TurnToolActivity {
        TurnToolActivity {
            id: id.into(),
            checkpoint_id: cp_id.into(),
            tool_use_id: format!("tu_{id}"),
            tool_name: tool.into(),
            input_json: r#"{"file":"test.rs"}"#.to_string(),
            result_text: "ok".into(),
            summary: format!("{tool} test.rs"),
            sort_order: order,
            group_id: None,
        }
    }

    #[test]
    fn test_insert_and_list_tool_activities() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::Assistant, "a1"))
            .unwrap();
        db.insert_checkpoint(&make_checkpoint(&db, "cp1", "w1", "m1", 0))
            .unwrap();

        let activities = vec![
            make_tool_activity("a1", "cp1", "Read", 0),
            make_tool_activity("a2", "cp1", "Edit", 1),
        ];
        db.insert_turn_tool_activities(&activities).unwrap();

        let turns = db.list_completed_turns("w1").unwrap();
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].activities.len(), 2);
        assert_eq!(turns[0].activities[0].tool_name, "Read");
        assert_eq!(turns[0].activities[1].tool_name, "Edit");
    }

    #[test]
    fn test_tool_activities_cascade_on_checkpoint_delete() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::Assistant, "a1"))
            .unwrap();
        db.insert_checkpoint(&make_checkpoint(&db, "cp1", "w1", "m1", 0))
            .unwrap();
        db.insert_turn_tool_activities(&[make_tool_activity("a1", "cp1", "Read", 0)])
            .unwrap();

        db.delete_checkpoints_after("w1", -1).unwrap();

        let turns = db.list_completed_turns("w1").unwrap();
        assert!(turns.is_empty());
    }

    #[test]
    fn test_tool_activity_group_id_round_trip() {
        // `group_id` is a new (2026-04-24) column backing the turn-segment
        // feature. Inserting with assorted values — `Some(i)`, `None`, and a
        // repeated index — must read back identically; any loss here would
        // collapse segments in the UI (all rows grouped together).
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::Assistant, "a"))
            .unwrap();
        db.insert_checkpoint(&make_checkpoint(&db, "cp1", "w1", "m1", 0))
            .unwrap();

        let mk = |id: &str, order: i32, group: Option<i32>| TurnToolActivity {
            id: id.into(),
            checkpoint_id: "cp1".into(),
            tool_use_id: format!("tu_{id}"),
            tool_name: "Read".into(),
            input_json: "{}".into(),
            result_text: "".into(),
            summary: "".into(),
            sort_order: order,
            group_id: group,
        };

        db.insert_turn_tool_activities(&[
            mk("a1", 0, Some(0)),
            mk("a2", 1, Some(0)),
            mk("a3", 2, Some(1)),
            mk("a4", 3, None), // legacy-style row; nullable column
        ])
        .unwrap();

        let turns = db.list_completed_turns("w1").unwrap();
        assert_eq!(turns.len(), 1);
        let acts = &turns[0].activities;
        assert_eq!(acts.len(), 4);
        // Row-by-row: ordering preserved by sort_order, group_id preserved verbatim.
        assert_eq!(acts[0].group_id, Some(0));
        assert_eq!(acts[1].group_id, Some(0));
        assert_eq!(acts[2].group_id, Some(1));
        assert_eq!(acts[3].group_id, None);
    }

    #[test]
    fn test_list_completed_turns_groups_by_checkpoint() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::Assistant, "a1"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m2", "w1", ChatRole::Assistant, "a2"))
            .unwrap();
        db.insert_checkpoint(&make_checkpoint(&db, "cp1", "w1", "m1", 0))
            .unwrap();
        db.insert_checkpoint(&make_checkpoint(&db, "cp2", "w1", "m2", 1))
            .unwrap();

        db.insert_turn_tool_activities(&[
            make_tool_activity("a1", "cp1", "Read", 0),
            make_tool_activity("a2", "cp1", "Edit", 1),
        ])
        .unwrap();
        db.insert_turn_tool_activities(&[make_tool_activity("a3", "cp2", "Bash", 0)])
            .unwrap();

        let turns = db.list_completed_turns("w1").unwrap();
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].activities.len(), 2);
        assert_eq!(turns[1].activities.len(), 1);
        assert_eq!(turns[1].activities[0].tool_name, "Bash");
    }

    #[test]
    fn test_list_messages_up_to_includes_boundary() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::User, "a"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m2", "w1", ChatRole::Assistant, "b"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m3", "w1", ChatRole::User, "c"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m4", "w1", ChatRole::Assistant, "d"))
            .unwrap();

        let msgs = db.list_messages_up_to("w1", "m2").unwrap();
        let ids: Vec<_> = msgs.iter().map(|m| m.id.clone()).collect();
        assert_eq!(ids, vec!["m1".to_string(), "m2".to_string()]);
    }

    #[test]
    fn test_list_messages_up_to_missing_returns_empty() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::User, "a"))
            .unwrap();
        let msgs = db.list_messages_up_to("w1", "nonexistent").unwrap();
        assert!(msgs.is_empty());
    }

    #[test]
    fn test_list_checkpoints_up_to() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::Assistant, "a"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m2", "w1", ChatRole::Assistant, "b"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m3", "w1", ChatRole::Assistant, "c"))
            .unwrap();
        db.insert_checkpoint(&make_checkpoint(&db, "cp1", "w1", "m1", 0))
            .unwrap();
        db.insert_checkpoint(&make_checkpoint(&db, "cp2", "w1", "m2", 1))
            .unwrap();
        db.insert_checkpoint(&make_checkpoint(&db, "cp3", "w1", "m3", 2))
            .unwrap();

        let up_to_1 = db.list_checkpoints_up_to("w1", 1).unwrap();
        assert_eq!(up_to_1.len(), 2);
        assert_eq!(up_to_1[0].id, "cp1");
        assert_eq!(up_to_1[1].id, "cp2");
    }

    #[test]
    fn test_update_checkpoint_message_count() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::Assistant, "a1"))
            .unwrap();
        db.insert_checkpoint(&make_checkpoint(&db, "cp1", "w1", "m1", 0))
            .unwrap();

        db.update_checkpoint_message_count("cp1", 3).unwrap();

        let cp = db.get_checkpoint("cp1").unwrap().unwrap();
        assert_eq!(cp.message_count, 3);
    }

    // --- MCP server enabled field ---

    fn make_mcp_server(id: &str, repo_id: &str, name: &str) -> RepositoryMcpServer {
        RepositoryMcpServer {
            id: id.into(),
            repository_id: repo_id.into(),
            name: name.into(),
            config_json: r#"{"type":"stdio","command":"echo"}"#.into(),
            source: "user_project_config".into(),
            created_at: String::new(),
            enabled: true,
        }
    }

    #[test]
    fn test_mcp_server_enabled_default_true() {
        let db = setup_db_with_workspace();
        let server = make_mcp_server("mcp1", "r1", "test-server");
        db.replace_repository_mcp_servers("r1", &[server]).unwrap();

        let servers = db.list_repository_mcp_servers("r1").unwrap();
        assert_eq!(servers.len(), 1);
        assert!(servers[0].enabled);
    }

    #[test]
    fn test_set_mcp_server_enabled() {
        let db = setup_db_with_workspace();
        let server = make_mcp_server("mcp1", "r1", "test-server");
        db.replace_repository_mcp_servers("r1", &[server]).unwrap();

        // Disable
        db.set_mcp_server_enabled("mcp1", false).unwrap();
        let servers = db.list_repository_mcp_servers("r1").unwrap();
        assert!(!servers[0].enabled);

        // Re-enable
        db.set_mcp_server_enabled("mcp1", true).unwrap();
        let servers = db.list_repository_mcp_servers("r1").unwrap();
        assert!(servers[0].enabled);
    }

    #[test]
    fn test_mcp_server_replace_preserves_enabled() {
        let db = setup_db_with_workspace();
        let mut server = make_mcp_server("mcp1", "r1", "test-server");
        server.enabled = false;
        db.replace_repository_mcp_servers("r1", &[server]).unwrap();

        let servers = db.list_repository_mcp_servers("r1").unwrap();
        assert!(!servers[0].enabled);
    }

    #[test]
    fn test_set_mcp_server_enabled_nonexistent_id() {
        // Setting enabled on a nonexistent server ID should succeed silently
        // (UPDATE on 0 rows is not an error in SQLite).
        let db = setup_db_with_workspace();
        let result = db.set_mcp_server_enabled("nonexistent-id", false);
        assert!(result.is_ok());
    }

    #[test]
    fn test_list_mcp_servers_empty_repo() {
        let db = setup_db_with_workspace();
        let servers = db.list_repository_mcp_servers("r1").unwrap();
        assert!(servers.is_empty());
    }

    #[test]
    fn test_mcp_server_replace_clears_old_servers() {
        let db = setup_db_with_workspace();

        // Insert two servers.
        let servers = vec![
            make_mcp_server("mcp1", "r1", "server-a"),
            make_mcp_server("mcp2", "r1", "server-b"),
        ];
        db.replace_repository_mcp_servers("r1", &servers).unwrap();
        assert_eq!(db.list_repository_mcp_servers("r1").unwrap().len(), 2);

        // Replace with just one — the old ones should be gone.
        let new_servers = vec![make_mcp_server("mcp3", "r1", "server-c")];
        db.replace_repository_mcp_servers("r1", &new_servers)
            .unwrap();
        let result = db.list_repository_mcp_servers("r1").unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "server-c");
    }

    #[test]
    fn test_delete_mcp_server() {
        let db = setup_db_with_workspace();
        let servers = vec![
            make_mcp_server("mcp1", "r1", "server-a"),
            make_mcp_server("mcp2", "r1", "server-b"),
        ];
        db.replace_repository_mcp_servers("r1", &servers).unwrap();

        db.delete_repository_mcp_server("mcp1").unwrap();
        let result = db.list_repository_mcp_servers("r1").unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "server-b");
    }

    #[test]
    fn test_mcp_server_enabled_survives_roundtrip() {
        // Insert with enabled=true, disable, verify after fresh list.
        let db = setup_db_with_workspace();
        let server = make_mcp_server("mcp1", "r1", "test-server");
        db.replace_repository_mcp_servers("r1", &[server]).unwrap();

        db.set_mcp_server_enabled("mcp1", false).unwrap();
        let servers = db.list_repository_mcp_servers("r1").unwrap();
        assert!(!servers[0].enabled);

        db.set_mcp_server_enabled("mcp1", true).unwrap();
        let servers = db.list_repository_mcp_servers("r1").unwrap();
        assert!(servers[0].enabled);
    }

    #[test]
    fn test_mcp_servers_isolated_per_repo() {
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1", "/tmp/repo1", "repo1"))
            .unwrap();
        db.insert_repository(&make_repo("r2", "/tmp/repo2", "repo2"))
            .unwrap();

        let s1 = make_mcp_server("m1", "r1", "server-for-r1");
        let s2 = make_mcp_server("m2", "r2", "server-for-r2");
        db.replace_repository_mcp_servers("r1", &[s1]).unwrap();
        db.replace_repository_mcp_servers("r2", &[s2]).unwrap();

        let r1_servers = db.list_repository_mcp_servers("r1").unwrap();
        let r2_servers = db.list_repository_mcp_servers("r2").unwrap();
        assert_eq!(r1_servers.len(), 1);
        assert_eq!(r1_servers[0].name, "server-for-r1");
        assert_eq!(r2_servers.len(), 1);
        assert_eq!(r2_servers[0].name, "server-for-r2");
    }

    #[test]
    fn test_mcp_server_replace_with_empty_clears_all() {
        let db = setup_db_with_workspace();
        let servers = vec![
            make_mcp_server("mcp1", "r1", "server-a"),
            make_mcp_server("mcp2", "r1", "server-b"),
        ];
        db.replace_repository_mcp_servers("r1", &servers).unwrap();
        assert_eq!(db.list_repository_mcp_servers("r1").unwrap().len(), 2);

        // Replace with empty vec — should clear all.
        db.replace_repository_mcp_servers("r1", &[]).unwrap();
        assert!(db.list_repository_mcp_servers("r1").unwrap().is_empty());
    }

    // --- Metrics capture tests ---

    fn count_rows(db: &Database, sql: &str) -> i64 {
        db.conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn test_agent_session_lifecycle() {
        let db = setup_db_with_workspace();
        db.insert_agent_session("s1", "w1", "r1").unwrap();
        assert_eq!(count_rows(&db, "SELECT COUNT(*) FROM agent_sessions"), 1);

        // Idempotent insert.
        db.insert_agent_session("s1", "w1", "r1").unwrap();
        assert_eq!(count_rows(&db, "SELECT COUNT(*) FROM agent_sessions"), 1);

        db.update_agent_session_turn("s1", 3).unwrap();
        let tc: i64 = db
            .conn
            .query_row(
                "SELECT turn_count FROM agent_sessions WHERE id = 's1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tc, 3);

        db.end_agent_session("s1", true).unwrap();
        let (ended_at, completed): (Option<String>, i64) = db
            .conn
            .query_row(
                "SELECT ended_at, completed_ok FROM agent_sessions WHERE id = 's1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert!(ended_at.is_some());
        assert_eq!(completed, 1);

        // Idempotent end: second call with completed_ok=false must NOT overwrite.
        db.end_agent_session("s1", false).unwrap();
        let completed_after: i64 = db
            .conn
            .query_row(
                "SELECT completed_ok FROM agent_sessions WHERE id = 's1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(completed_after, 1);

        // Turn bump on an ended session is a no-op.
        db.update_agent_session_turn("s1", 99).unwrap();
        let tc_after: i64 = db
            .conn
            .query_row(
                "SELECT turn_count FROM agent_sessions WHERE id = 's1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tc_after, 3);

        // Reopen clears ended_at so resumed turns can update metrics.
        db.reopen_agent_session("s1").unwrap();
        let ended_after_reopen: Option<String> = db
            .conn
            .query_row(
                "SELECT ended_at FROM agent_sessions WHERE id = 's1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(ended_after_reopen.is_none());

        // Turn bump works again after reopen.
        db.update_agent_session_turn("s1", 10).unwrap();
        let tc_reopened: i64 = db
            .conn
            .query_row(
                "SELECT turn_count FROM agent_sessions WHERE id = 's1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tc_reopened, 10);

        // Reopen on an already-open session is a no-op.
        db.reopen_agent_session("s1").unwrap();
    }

    #[test]
    fn test_agent_commits_idempotent() {
        let db = setup_db_with_workspace();
        let commit = crate::model::AgentCommit {
            commit_hash: "abc123".into(),
            workspace_id: Some("w1".into()),
            repository_id: "r1".into(),
            session_id: Some("s1".into()),
            additions: 10,
            deletions: 2,
            files_changed: 3,
            committed_at: "2026-04-17T12:00:00Z".into(),
        };
        db.insert_agent_commits_batch("w1", "r1", Some("s1"), std::slice::from_ref(&commit))
            .unwrap();
        db.insert_agent_commits_batch("w1", "r1", Some("s1"), &[commit])
            .unwrap();
        assert_eq!(count_rows(&db, "SELECT COUNT(*) FROM agent_commits"), 1);
    }

    #[test]
    fn test_agent_commits_same_hash_across_workspaces() {
        let db = setup_db_with_workspace();
        db.insert_workspace(&make_workspace("w2", "r1", "other"))
            .unwrap();
        let shared_hash = "deadbeef".to_string();
        let commit_w1 = crate::model::AgentCommit {
            commit_hash: shared_hash.clone(),
            workspace_id: Some("w1".into()),
            repository_id: "r1".into(),
            session_id: Some("s1".into()),
            additions: 1,
            deletions: 0,
            files_changed: 1,
            committed_at: "2026-04-17T12:00:00Z".into(),
        };
        let commit_w2 = crate::model::AgentCommit {
            commit_hash: shared_hash,
            workspace_id: Some("w2".into()),
            repository_id: "r1".into(),
            session_id: Some("s2".into()),
            additions: 1,
            deletions: 0,
            files_changed: 1,
            committed_at: "2026-04-17T12:00:00Z".into(),
        };
        db.insert_agent_commits_batch("w1", "r1", Some("s1"), &[commit_w1])
            .unwrap();
        db.insert_agent_commits_batch("w2", "r1", Some("s2"), &[commit_w2])
            .unwrap();
        assert_eq!(count_rows(&db, "SELECT COUNT(*) FROM agent_commits"), 2);
    }

    #[test]
    fn test_materialize_summary_on_hard_delete() {
        let db = setup_db_with_workspace();
        // Seed: one session, one commit, a few messages, a slash command.
        db.insert_agent_session("s1", "w1", "r1").unwrap();
        db.update_agent_session_turn("s1", 5).unwrap();
        db.end_agent_session("s1", true).unwrap();

        let commit = crate::model::AgentCommit {
            commit_hash: "h1".into(),
            workspace_id: Some("w1".into()),
            repository_id: "r1".into(),
            session_id: Some("s1".into()),
            additions: 50,
            deletions: 10,
            files_changed: 4,
            committed_at: "2026-04-17T12:00:00Z".into(),
        };
        db.insert_agent_commits_batch("w1", "r1", Some("s1"), &[commit])
            .unwrap();

        let sess_id = db.default_session_id_for_workspace("w1").unwrap().unwrap();
        for (id, role) in [("m1", "user"), ("m3", "user"), ("m4", "system")] {
            db.conn
                .execute(
                    "INSERT INTO chat_messages (id, workspace_id, chat_session_id, role, content, cost_usd)
                     VALUES (?1, 'w1', ?2, ?3, 'x', 0.01)",
                    params![id, sess_id, role],
                )
                .unwrap();
        }
        db.conn
            .execute(
                "INSERT INTO chat_messages (id, workspace_id, chat_session_id, role, content, cost_usd, input_tokens, output_tokens)
                 VALUES ('m2', 'w1', ?1, 'assistant', 'x', 0.01, 12000, 3000)",
                params![sess_id],
            )
            .unwrap();
        db.conn
            .execute(
                "INSERT INTO slash_command_usage (workspace_id, command_name, use_count)
                 VALUES ('w1', '/foo', 7)",
                [],
            )
            .unwrap();

        // Hard-delete with materialization.
        db.delete_workspace_with_summary("w1").unwrap();

        // Workspace and child rows gone; summary present.
        assert_eq!(
            count_rows(&db, "SELECT COUNT(*) FROM workspaces WHERE id = 'w1'"),
            0
        );
        assert_eq!(count_rows(&db, "SELECT COUNT(*) FROM agent_sessions"), 0);
        assert_eq!(count_rows(&db, "SELECT COUNT(*) FROM agent_commits"), 0);
        assert_eq!(count_rows(&db, "SELECT COUNT(*) FROM chat_messages"), 0);
        assert_eq!(
            count_rows(&db, "SELECT COUNT(*) FROM slash_command_usage"),
            0
        );
        assert_eq!(
            count_rows(&db, "SELECT COUNT(*) FROM deleted_workspace_summaries"),
            1
        );

        let (sessions, turns, commits, adds, dels, msgs_u, msgs_a, msgs_s, slash_used): (
            i64,
            i64,
            i64,
            i64,
            i64,
            i64,
            i64,
            i64,
            i64,
        ) = db
            .conn
            .query_row(
                "SELECT sessions_started, total_turns, commits_made, total_additions,
                        total_deletions, messages_user, messages_assistant, messages_system,
                        slash_commands_used
                 FROM deleted_workspace_summaries WHERE workspace_id = 'w1'",
                [],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                        r.get(7)?,
                        r.get(8)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(sessions, 1);
        assert_eq!(turns, 5);
        assert_eq!(commits, 1);
        assert_eq!(adds, 50);
        assert_eq!(dels, 10);
        assert_eq!(msgs_u, 2);
        assert_eq!(msgs_a, 1);
        assert_eq!(msgs_s, 1);
        assert_eq!(slash_used, 7);

        let (total_in, total_out): (i64, i64) = db
            .conn
            .query_row(
                "SELECT total_input_tokens, total_output_tokens
                 FROM deleted_workspace_summaries WHERE workspace_id = 'w1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(total_in, 12000);
        assert_eq!(total_out, 3000);
    }

    #[test]
    fn test_delete_workspace_idempotent() {
        let db = setup_db_with_workspace();
        db.delete_workspace_with_summary("w1").unwrap();
        // Second delete of the same workspace must succeed (no-op).
        db.delete_workspace_with_summary("w1").unwrap();
        assert_eq!(
            count_rows(
                &db,
                "SELECT COUNT(*) FROM deleted_workspace_summaries WHERE workspace_id = 'w1'"
            ),
            1
        );
    }

    #[test]
    fn test_archive_leaves_metrics_untouched() {
        let db = setup_db_with_workspace();
        db.insert_agent_session("s1", "w1", "r1").unwrap();
        db.end_agent_session("s1", true).unwrap();
        let commit = crate::model::AgentCommit {
            commit_hash: "h1".into(),
            workspace_id: Some("w1".into()),
            repository_id: "r1".into(),
            session_id: Some("s1".into()),
            additions: 1,
            deletions: 0,
            files_changed: 1,
            committed_at: "2026-04-17T12:00:00Z".into(),
        };
        db.insert_agent_commits_batch("w1", "r1", Some("s1"), &[commit])
            .unwrap();

        db.update_workspace_status("w1", &WorkspaceStatus::Archived, None)
            .unwrap();

        // Archive is soft-delete: metric rows stay put, no summary is written.
        assert_eq!(count_rows(&db, "SELECT COUNT(*) FROM agent_sessions"), 1);
        assert_eq!(count_rows(&db, "SELECT COUNT(*) FROM agent_commits"), 1);
        assert_eq!(
            count_rows(&db, "SELECT COUNT(*) FROM deleted_workspace_summaries"),
            0
        );
    }

    #[test]
    fn test_delete_repository_materializes_summary_for_each_workspace() {
        let db = setup_db_with_workspace();
        db.insert_workspace(&make_workspace("w2", "r1", "feature"))
            .unwrap();

        // Seed both workspaces with a session + a commit so the per-workspace
        // aggregates are non-trivially distinct.
        for (sid, wid, turns, adds) in [("s1", "w1", 4, 12), ("s2", "w2", 9, 30)] {
            db.insert_agent_session(sid, wid, "r1").unwrap();
            db.update_agent_session_turn(sid, turns).unwrap();
            db.end_agent_session(sid, true).unwrap();
            let commit = crate::model::AgentCommit {
                commit_hash: format!("hash-{wid}"),
                workspace_id: Some(wid.into()),
                repository_id: "r1".into(),
                session_id: Some(sid.into()),
                additions: adds,
                deletions: 1,
                files_changed: 1,
                committed_at: "2026-04-17T12:00:00Z".into(),
            };
            db.insert_agent_commits_batch(wid, "r1", Some(sid), &[commit])
                .unwrap();
        }

        db.delete_repository_with_summaries("r1").unwrap();

        // Repository + both workspaces gone, raw metric rows cascaded away.
        assert_eq!(count_rows(&db, "SELECT COUNT(*) FROM repositories"), 0);
        assert_eq!(count_rows(&db, "SELECT COUNT(*) FROM workspaces"), 0);
        assert_eq!(count_rows(&db, "SELECT COUNT(*) FROM agent_sessions"), 0);
        assert_eq!(count_rows(&db, "SELECT COUNT(*) FROM agent_commits"), 0);
        // One frozen summary per pre-existing workspace.
        assert_eq!(
            count_rows(&db, "SELECT COUNT(*) FROM deleted_workspace_summaries"),
            2
        );
        // Per-workspace aggregates are preserved distinctly (not co-mingled).
        let (turns_w1, adds_w1): (i64, i64) = db
            .conn
            .query_row(
                "SELECT total_turns, total_additions FROM deleted_workspace_summaries
                 WHERE workspace_id = 'w1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        let (turns_w2, adds_w2): (i64, i64) = db
            .conn
            .query_row(
                "SELECT total_turns, total_additions FROM deleted_workspace_summaries
                 WHERE workspace_id = 'w2'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((turns_w1, adds_w1), (4, 12));
        assert_eq!((turns_w2, adds_w2), (9, 30));
    }

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

    fn make_scm_cache(
        workspace_id: &str,
        repo_id: &str,
        branch: &str,
        pr_json: Option<&str>,
    ) -> ScmStatusCacheRow {
        ScmStatusCacheRow {
            workspace_id: workspace_id.into(),
            repo_id: repo_id.into(),
            branch_name: branch.into(),
            provider: Some("github".into()),
            pr_json: pr_json.map(Into::into),
            ci_json: Some("[]".into()),
            error: None,
            fetched_at: String::new(),
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
    fn test_upsert_scm_status_cache() {
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1", "/tmp/repo1", "repo1"))
            .unwrap();
        db.insert_workspace(&make_workspace("w1", "r1", "fix-bug"))
            .unwrap();

        let pr = r#"{"number":1,"title":"Fix","state":"open","url":"","author":"me","branch":"fix-bug","base":"main","draft":false,"ci_status":null}"#;
        db.upsert_scm_status_cache(&make_scm_cache("w1", "r1", "fix-bug", Some(pr)))
            .unwrap();

        let rows = db.load_all_scm_status_cache().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].workspace_id, "w1");
        assert_eq!(rows[0].provider, Some("github".into()));
        assert!(rows[0].pr_json.is_some());
        assert!(rows[0].error.is_none());

        // Upsert same workspace — should replace, not duplicate.
        db.upsert_scm_status_cache(&make_scm_cache("w1", "r1", "fix-bug", Some("null")))
            .unwrap();
        let rows = db.load_all_scm_status_cache().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].pr_json, Some("null".into()));
    }

    #[test]
    fn test_scm_status_cache_cascade_delete() {
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1", "/tmp/repo1", "repo1"))
            .unwrap();
        db.insert_workspace(&make_workspace("w1", "r1", "fix-bug"))
            .unwrap();
        db.upsert_scm_status_cache(&make_scm_cache("w1", "r1", "fix-bug", Some("null")))
            .unwrap();

        db.delete_workspace("w1").unwrap();
        let rows = db.load_all_scm_status_cache().unwrap();
        assert!(rows.is_empty());
    }

    #[test]
    fn test_delete_scm_status_cache() {
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1", "/tmp/repo1", "repo1"))
            .unwrap();
        db.insert_workspace(&make_workspace("w1", "r1", "fix-bug"))
            .unwrap();
        db.upsert_scm_status_cache(&make_scm_cache("w1", "r1", "fix-bug", Some("null")))
            .unwrap();

        db.delete_scm_status_cache("w1").unwrap();
        let rows = db.load_all_scm_status_cache().unwrap();
        assert!(rows.is_empty());
    }

    #[test]
    fn test_scm_status_cache_nullable_pr() {
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1", "/tmp/repo1", "repo1"))
            .unwrap();
        db.insert_workspace(&make_workspace("w1", "r1", "fix-bug"))
            .unwrap();

        // NULL pr_json = never fetched
        db.upsert_scm_status_cache(&make_scm_cache("w1", "r1", "fix-bug", None))
            .unwrap();
        let rows = db.load_all_scm_status_cache().unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].pr_json.is_none());

        // "null" string pr_json = fetched, no PR found
        db.upsert_scm_status_cache(&make_scm_cache("w1", "r1", "fix-bug", Some("null")))
            .unwrap();
        let rows = db.load_all_scm_status_cache().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].pr_json, Some("null".into()));
    }

    #[test]
    fn test_chat_sessions_migration_backfills_sessions() {
        let db = Database::open_in_memory().unwrap();

        // Rewind: drop chat_sessions structures and remove the migration
        // tracking row so re-running migrations will re-apply it.
        db.execute_batch(
            "PRAGMA foreign_keys=OFF;
             DROP INDEX IF EXISTS idx_chat_messages_chat_session;
             DROP INDEX IF EXISTS idx_checkpoints_chat_session;
             DROP INDEX IF EXISTS idx_chat_sessions_ws;
             DROP INDEX IF EXISTS idx_chat_sessions_active;
             ALTER TABLE chat_messages DROP COLUMN chat_session_id;
             ALTER TABLE conversation_checkpoints DROP COLUMN chat_session_id;
             DROP TABLE chat_sessions;
             DELETE FROM schema_migrations WHERE id = '20260422000000_chat_sessions';
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

    // --- Pinned command tests ---

    #[test]
    fn test_pinned_commands_crud() {
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1", "/tmp/repo1", "repo1"))
            .unwrap();

        let p1 = db.insert_pinned_command("r1", "review").unwrap();
        let p2 = db.insert_pinned_command("r1", "run-tests").unwrap();

        assert_eq!(p1.command_name, "review");
        assert_eq!(p2.command_name, "run-tests");
        assert!(p1.sort_order < p2.sort_order);

        let pins = db.list_pinned_commands("r1").unwrap();
        assert_eq!(pins.len(), 2);
        assert_eq!(pins[0].command_name, "review");
        assert_eq!(pins[1].command_name, "run-tests");

        db.delete_pinned_command(p1.id).unwrap();
        let pins = db.list_pinned_commands("r1").unwrap();
        assert_eq!(pins.len(), 1);
        assert_eq!(pins[0].command_name, "run-tests");
    }

    #[test]
    fn test_pinned_commands_unique_constraint() {
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1", "/tmp/repo1", "repo1"))
            .unwrap();
        db.insert_pinned_command("r1", "review").unwrap();
        let dup = db.insert_pinned_command("r1", "review");
        assert!(dup.is_err());
    }

    #[test]
    fn test_pinned_commands_per_repo() {
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1", "/tmp/repo1", "repo1"))
            .unwrap();
        db.insert_repository(&make_repo("r2", "/tmp/repo2", "repo2"))
            .unwrap();

        db.insert_pinned_command("r1", "review").unwrap();
        db.insert_pinned_command("r2", "deploy").unwrap();

        let r1_pins = db.list_pinned_commands("r1").unwrap();
        let r2_pins = db.list_pinned_commands("r2").unwrap();
        assert_eq!(r1_pins.len(), 1);
        assert_eq!(r1_pins[0].command_name, "review");
        assert_eq!(r2_pins.len(), 1);
        assert_eq!(r2_pins[0].command_name, "deploy");
    }

    #[test]
    fn test_pinned_commands_cascade_on_repo_delete() {
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1", "/tmp/repo1", "repo1"))
            .unwrap();
        db.insert_pinned_command("r1", "review").unwrap();
        db.insert_pinned_command("r1", "run-tests").unwrap();

        db.delete_repository("r1").unwrap();
        let pins = db.list_pinned_commands("r1").unwrap();
        assert!(pins.is_empty());
    }

    #[test]
    fn test_pinned_commands_reorder() {
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1", "/tmp/repo1", "repo1"))
            .unwrap();

        let p1 = db.insert_pinned_command("r1", "alpha").unwrap();
        let p2 = db.insert_pinned_command("r1", "beta").unwrap();
        let p3 = db.insert_pinned_command("r1", "gamma").unwrap();

        db.reorder_pinned_commands("r1", &[p3.id, p1.id, p2.id])
            .unwrap();

        let pins = db.list_pinned_commands("r1").unwrap();
        assert_eq!(pins[0].command_name, "gamma");
        assert_eq!(pins[1].command_name, "alpha");
        assert_eq!(pins[2].command_name, "beta");
    }
}
