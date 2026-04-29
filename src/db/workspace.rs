//! Workspace and agent session CRUD methods on `Database`.
//!
//! Includes workspace lifecycle, agent session metrics, agent-commit metrics,
//! and the materialize-on-delete summary path.
//!
//! This file contributes a `impl Database { ... }` block to the type defined
//! in `super::Database`. Multiple `impl` blocks on the same type across files
//! are idiomatic Rust; the public method paths resolve identically to a
//! single-block layout.

use rusqlite::{OptionalExtension, params};

use crate::model::{Workspace, WorkspaceStatus};

use super::Database;

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
            let status: WorkspaceStatus = status_str.parse().map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(
                    5,
                    rusqlite::types::Type::Text,
                    Box::new(e),
                )
            })?;
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::*;
    use crate::model::{ChatRole, WorkspaceStatus};

    fn count_rows(db: &Database, sql: &str) -> i64 {
        db.conn.query_row(sql, [], |r| r.get(0)).unwrap()
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

    // --- Metrics capture tests ---

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

    /// Regression: an unknown `status` string in the `workspaces` table must
    /// surface as a `FromSqlConversionFailure`, not silently coerce to a
    /// default. See issue #485.
    #[test]
    fn test_list_workspaces_unknown_status_returns_error() {
        let db = setup_db_with_workspace();
        db.conn
            .execute(
                "UPDATE workspaces SET status = 'frozen' WHERE id = 'w1'",
                [],
            )
            .unwrap();
        let result = db.list_workspaces();
        assert!(
            matches!(
                result,
                Err(rusqlite::Error::FromSqlConversionFailure(_, _, _))
            ),
            "expected FromSqlConversionFailure for unknown status, got: {result:?}",
        );
    }
}
