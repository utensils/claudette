use std::collections::HashSet;
use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};

use crate::migrations::{MIGRATIONS, Migration};
use crate::model::{PinnedCommand, Workspace, WorkspaceStatus};

mod repository;
pub use repository::is_duplicate_repository_path_error;

mod settings;
pub use settings::RepositoryMcpServer;

mod scm;
pub use scm::ScmStatusCacheRow;

mod terminal;

mod remote;

mod checkpoint;

mod chat;

#[cfg(test)]
mod test_support;

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

impl Database {
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
    use crate::db::test_support::*;
    use crate::model::{ChatRole, Repository, WorkspaceStatus};

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
