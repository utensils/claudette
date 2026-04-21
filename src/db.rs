use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};

use serde::{Deserialize, Serialize};

use crate::model::{
    Attachment, ChatMessage, CheckpointFile, CompletedTurnData, ConversationCheckpoint,
    RemoteConnection, Repository, TerminalTab, TurnToolActivity, Workspace, WorkspaceStatus,
};

fn row_to_attachment(row: &rusqlite::Row) -> rusqlite::Result<Attachment> {
    let data: Vec<u8> = row.get(4)?;
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
    })
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

    fn migrate(&self) -> Result<(), rusqlite::Error> {
        let version: i32 = self
            .conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))?;

        if version < 1 {
            self.conn.execute_batch(
                "CREATE TABLE repositories (
                    id          TEXT PRIMARY KEY,
                    path        TEXT NOT NULL UNIQUE,
                    name        TEXT NOT NULL,
                    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
                );

                CREATE TABLE workspaces (
                    id              TEXT PRIMARY KEY,
                    repository_id   TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
                    name            TEXT NOT NULL,
                    branch_name     TEXT NOT NULL,
                    worktree_path   TEXT,
                    status          TEXT NOT NULL DEFAULT 'active',
                    status_line     TEXT NOT NULL DEFAULT '',
                    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
                    UNIQUE(repository_id, name)
                );

                PRAGMA user_version = 1;",
            )?;
        }

        if version < 2 {
            self.conn.execute_batch(
                "CREATE TABLE chat_messages (
                    id            TEXT PRIMARY KEY,
                    workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
                    role          TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
                    content       TEXT NOT NULL,
                    cost_usd      REAL,
                    duration_ms   INTEGER,
                    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
                );

                CREATE INDEX idx_chat_messages_workspace
                    ON chat_messages(workspace_id, created_at);

                PRAGMA user_version = 2;",
            )?;
        }

        if version < 3 {
            self.conn.execute_batch(
                "ALTER TABLE repositories ADD COLUMN icon TEXT;
                 ALTER TABLE repositories ADD COLUMN path_slug TEXT;
                 UPDATE repositories SET path_slug = name WHERE path_slug IS NULL;

                 CREATE TABLE app_settings (
                     key   TEXT PRIMARY KEY,
                     value TEXT NOT NULL
                 );

                 PRAGMA user_version = 3;",
            )?;
        }

        if version < 4 {
            self.conn.execute_batch(
                "CREATE TABLE terminal_tabs (
                    id               INTEGER PRIMARY KEY,
                    workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
                    title            TEXT NOT NULL DEFAULT 'Terminal',
                    is_script_output INTEGER NOT NULL DEFAULT 0,
                    sort_order       INTEGER NOT NULL DEFAULT 0,
                    created_at       TEXT NOT NULL DEFAULT (datetime('now'))
                );

                CREATE INDEX idx_terminal_tabs_workspace
                    ON terminal_tabs(workspace_id, sort_order);

                PRAGMA user_version = 4;",
            )?;
        }

        if version < 5 {
            self.conn.execute_batch(
                "ALTER TABLE repositories ADD COLUMN setup_script TEXT;

                 PRAGMA user_version = 5;",
            )?;
        }

        if version < 6 {
            self.conn.execute_batch(
                "ALTER TABLE repositories ADD COLUMN custom_instructions TEXT;

                 PRAGMA user_version = 6;",
            )?;
        }

        if version < 7 {
            self.conn.execute_batch(
                "CREATE TABLE remote_connections (
                    id                  TEXT PRIMARY KEY,
                    name                TEXT NOT NULL,
                    host                TEXT NOT NULL,
                    port                INTEGER DEFAULT 7683,
                    session_token       TEXT,
                    cert_fingerprint    TEXT,
                    auto_connect        INTEGER DEFAULT 0,
                    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
                );

                PRAGMA user_version = 7;",
            )?;
        }

        if version < 8 {
            self.conn.execute_batch(
                "CREATE TABLE slash_command_usage (
                    workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
                    command_name  TEXT NOT NULL,
                    use_count     INTEGER NOT NULL DEFAULT 1,
                    last_used_at  TEXT NOT NULL DEFAULT (datetime('now')),
                    PRIMARY KEY (workspace_id, command_name)
                );

                PRAGMA user_version = 8;",
            )?;
        }

        if version < 9 {
            self.conn.execute_batch(
                "ALTER TABLE workspaces ADD COLUMN session_id TEXT;
                 ALTER TABLE workspaces ADD COLUMN turn_count INTEGER NOT NULL DEFAULT 0;

                 PRAGMA user_version = 9;",
            )?;
        }

        if version < 10 {
            self.conn.execute_batch(
                "CREATE TABLE conversation_checkpoints (
                    id            TEXT PRIMARY KEY,
                    workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
                    message_id    TEXT NOT NULL,
                    commit_hash   TEXT,
                    turn_index    INTEGER NOT NULL,
                    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
                );

                CREATE INDEX idx_checkpoints_workspace
                    ON conversation_checkpoints(workspace_id, turn_index);

                PRAGMA user_version = 10;",
            )?;
        }

        if version < 11 {
            self.conn.execute_batch(
                "CREATE TABLE turn_tool_activities (
                    id              TEXT PRIMARY KEY,
                    checkpoint_id   TEXT NOT NULL REFERENCES conversation_checkpoints(id) ON DELETE CASCADE,
                    tool_use_id     TEXT NOT NULL,
                    tool_name       TEXT NOT NULL,
                    input_json      TEXT NOT NULL DEFAULT '',
                    result_text     TEXT NOT NULL DEFAULT '',
                    summary         TEXT NOT NULL DEFAULT '',
                    sort_order      INTEGER NOT NULL DEFAULT 0
                );

                CREATE INDEX idx_turn_tool_activities_checkpoint
                    ON turn_tool_activities(checkpoint_id, sort_order);

                ALTER TABLE conversation_checkpoints ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0;

                PRAGMA user_version = 11;",
            )?;
        }

        if version < 12 {
            // Single batch so the column add, backfill, and version bump are
            // atomic — a partial apply won't leave user_version stale.
            self.conn.execute_batch(
                "ALTER TABLE repositories ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

                UPDATE repositories SET sort_order = (
                    SELECT COUNT(*) FROM repositories r2 WHERE r2.name < repositories.name
                );

                PRAGMA user_version = 12;",
            )?;
        }

        if version < 13 {
            self.conn.execute_batch(
                "ALTER TABLE chat_messages ADD COLUMN thinking TEXT;
                 PRAGMA user_version = 13;",
            )?;
        }

        if version < 14 {
            self.conn.execute_batch(
                "ALTER TABLE repositories ADD COLUMN branch_rename_preferences TEXT;
                 PRAGMA user_version = 14;",
            )?;
        }

        if version < 15 {
            self.conn.execute_batch(
                "CREATE TABLE checkpoint_files (
                    id              TEXT PRIMARY KEY,
                    checkpoint_id   TEXT NOT NULL REFERENCES conversation_checkpoints(id) ON DELETE CASCADE,
                    file_path       TEXT NOT NULL,
                    content         BLOB,
                    file_mode       INTEGER NOT NULL DEFAULT 33188,
                    UNIQUE(checkpoint_id, file_path)
                );

                CREATE INDEX idx_checkpoint_files_checkpoint
                    ON checkpoint_files(checkpoint_id);

                PRAGMA user_version = 15;",
            )?;
        }

        if version < 16 {
            self.conn.execute_batch(
                "CREATE TABLE attachments (
                    id           TEXT PRIMARY KEY,
                    message_id   TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
                    filename     TEXT NOT NULL,
                    media_type   TEXT NOT NULL,
                    data         BLOB NOT NULL,
                    width        INTEGER,
                    height       INTEGER,
                    size_bytes   INTEGER NOT NULL,
                    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
                );

                CREATE INDEX idx_attachments_message
                    ON attachments(message_id);

                PRAGMA user_version = 16;",
            )?;
        }

        if version < 17 {
            self.conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS repository_mcp_servers (
                    id              TEXT PRIMARY KEY,
                    repository_id   TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
                    name            TEXT NOT NULL,
                    config_json     TEXT NOT NULL,
                    source          TEXT NOT NULL,
                    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
                    UNIQUE(repository_id, name)
                );

                PRAGMA user_version = 17;",
            )?;
        }

        if version < 18 {
            self.conn.execute_batch(
                "ALTER TABLE repository_mcp_servers ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;

                PRAGMA user_version = 18;",
            )?;
        }

        if version < 19 {
            self.conn.execute_batch(
                "ALTER TABLE repositories ADD COLUMN setup_script_auto_run INTEGER NOT NULL DEFAULT 0;

                PRAGMA user_version = 19;",
            )?;
        }

        if version < 20 {
            self.conn.execute_batch(
                "ALTER TABLE chat_messages ADD COLUMN input_tokens INTEGER;
                 ALTER TABLE chat_messages ADD COLUMN output_tokens INTEGER;
                 ALTER TABLE chat_messages ADD COLUMN cache_read_tokens INTEGER;
                 ALTER TABLE chat_messages ADD COLUMN cache_creation_tokens INTEGER;

                 PRAGMA user_version = 20;",
            )?;
        }

        if version < 21 {
            // Metrics capture foundation: per-session lifecycle rows, per-commit
            // rows, and a frozen-aggregates table for workspaces that get
            // hard-deleted (so lifetime dashboard stats survive `delete_workspace`).
            self.conn.execute_batch(
                "CREATE TABLE agent_sessions (
                    id              TEXT PRIMARY KEY,
                    workspace_id    TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
                    repository_id   TEXT NOT NULL,
                    started_at      TEXT NOT NULL DEFAULT (datetime('now')),
                    last_message_at TEXT NOT NULL DEFAULT (datetime('now')),
                    ended_at        TEXT,
                    turn_count      INTEGER NOT NULL DEFAULT 0,
                    completed_ok    INTEGER NOT NULL DEFAULT 0
                );
                CREATE INDEX idx_agent_sessions_workspace ON agent_sessions(workspace_id);
                CREATE INDEX idx_agent_sessions_started   ON agent_sessions(started_at);

                CREATE TABLE agent_commits (
                    commit_hash     TEXT NOT NULL,
                    workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
                    repository_id   TEXT NOT NULL,
                    session_id      TEXT,
                    additions       INTEGER NOT NULL DEFAULT 0,
                    deletions       INTEGER NOT NULL DEFAULT 0,
                    files_changed   INTEGER NOT NULL DEFAULT 0,
                    committed_at    TEXT NOT NULL,
                    PRIMARY KEY (workspace_id, commit_hash)
                );
                CREATE INDEX idx_agent_commits_workspace ON agent_commits(workspace_id);
                CREATE INDEX idx_agent_commits_committed ON agent_commits(committed_at);

                CREATE TABLE deleted_workspace_summaries (
                    id                        TEXT PRIMARY KEY,
                    workspace_id              TEXT NOT NULL,
                    workspace_name            TEXT NOT NULL,
                    repository_id             TEXT NOT NULL,
                    workspace_created_at      TEXT NOT NULL,
                    deleted_at                TEXT NOT NULL DEFAULT (datetime('now')),
                    sessions_started          INTEGER NOT NULL DEFAULT 0,
                    sessions_completed        INTEGER NOT NULL DEFAULT 0,
                    total_turns               INTEGER NOT NULL DEFAULT 0,
                    total_session_duration_ms INTEGER NOT NULL DEFAULT 0,
                    commits_made              INTEGER NOT NULL DEFAULT 0,
                    total_additions           INTEGER NOT NULL DEFAULT 0,
                    total_deletions           INTEGER NOT NULL DEFAULT 0,
                    total_files_changed       INTEGER NOT NULL DEFAULT 0,
                    messages_user             INTEGER NOT NULL DEFAULT 0,
                    messages_assistant        INTEGER NOT NULL DEFAULT 0,
                    messages_system           INTEGER NOT NULL DEFAULT 0,
                    total_cost_usd            REAL NOT NULL DEFAULT 0,
                    first_message_at          TEXT,
                    last_message_at           TEXT,
                    slash_commands_used       INTEGER NOT NULL DEFAULT 0
                );
                CREATE INDEX idx_deleted_ws_summaries_repo ON deleted_workspace_summaries(repository_id);

                PRAGMA user_version = 21;",
            )?;
        }

        if version < 22 {
            // Leaderboard and per-repo aggregations do correlated subquery
            // lookups like `WHERE s.repository_id = r.repository_id` and
            // `GROUP BY repository_id`. Without these indexes those scans are
            // full-table, which the 30s dashboard poll amplifies.
            self.conn.execute_batch(
                "CREATE INDEX idx_agent_sessions_repo ON agent_sessions(repository_id);
                 CREATE INDEX idx_agent_commits_repo  ON agent_commits(repository_id);

                 PRAGMA user_version = 22;",
            )?;
        }

        if version < 23 {
            // Gate the first-turn auto-rename on a persistent per-workspace
            // flag. The previous gate (`session.turn_count <= 1`) tripped
            // spuriously whenever the in-memory session was wiped — on
            // `stop_agent`, spawn failure, or `!got_init` CLI exits — letting
            // a later prompt rename a workspace that had already had its
            // first-prompt rename. The flag tracks the one-shot *claim*, not
            // the rename outcome: it's set on the prompt that reserves the
            // slot, so a Haiku/git failure leaves the workspace with its
            // original name but doesn't retry on later prompts. Backfill
            // existing workspaces with prior chat history so an upgrade
            // doesn't rename them on the next turn.
            self.conn.execute_batch(
                "ALTER TABLE workspaces ADD COLUMN branch_auto_rename_claimed INTEGER NOT NULL DEFAULT 0;

                 UPDATE workspaces SET branch_auto_rename_claimed = 1
                   WHERE id IN (SELECT DISTINCT workspace_id FROM chat_messages);

                 PRAGMA user_version = 23;",
            )?;
        }

        Ok(())
    }

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
            path_valid: true, // validated after load
        })
    }

    pub fn list_repositories(&self) -> Result<Vec<Repository>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, path, name, icon, path_slug, created_at, setup_script, custom_instructions, sort_order, branch_rename_preferences, setup_script_auto_run
             FROM repositories ORDER BY sort_order, name",
        )?;
        let rows = stmt.query_map([], Self::parse_repo_row)?;
        rows.collect()
    }

    pub fn get_repository(&self, id: &str) -> Result<Option<Repository>, rusqlite::Error> {
        self.conn
            .query_row(
                "SELECT id, path, name, icon, path_slug, created_at, setup_script, custom_instructions, sort_order, branch_rename_preferences, setup_script_auto_run
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

    // --- Workspaces ---

    pub fn insert_workspace(&self, ws: &Workspace) -> Result<(), rusqlite::Error> {
        self.conn.execute(
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
        Ok(())
    }

    /// Insert multiple workspaces atomically. All succeed or none are committed.
    pub fn insert_workspaces_batch(&self, workspaces: &[Workspace]) -> Result<(), rusqlite::Error> {
        let tx = self.conn.unchecked_transaction()?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO workspaces (id, repository_id, name, branch_name, worktree_path, status, status_line)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )?;
            for ws in workspaces {
                stmt.execute(params![
                    ws.id,
                    ws.repository_id,
                    ws.name,
                    ws.branch_name,
                    ws.worktree_path,
                    ws.status.as_str(),
                    ws.status_line,
                ])?;
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

        // Message aggregates by role + cost + date range.
        let (msgs_user, msgs_assistant, msgs_system, total_cost_usd, first_msg, last_msg): (
            i64,
            i64,
            i64,
            f64,
            Option<String>,
            Option<String>,
        ) = tx.query_row(
            "SELECT
                SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END),
                SUM(CASE WHEN role = 'assistant' THEN 1 ELSE 0 END),
                SUM(CASE WHEN role = 'system' THEN 1 ELSE 0 END),
                COALESCE(SUM(cost_usd), 0),
                MIN(created_at),
                MAX(created_at)
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
                first_message_at, last_message_at, slash_commands_used
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5,
                ?6, ?7, ?8, ?9,
                ?10, ?11, ?12, ?13,
                ?14, ?15, ?16, ?17,
                ?18, ?19, ?20
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
                id, workspace_id, role, content, cost_usd, duration_ms, thinking,
                input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                msg.id,
                msg.workspace_id,
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

    #[allow(dead_code)]
    pub fn list_chat_messages(
        &self,
        workspace_id: &str,
    ) -> Result<Vec<ChatMessage>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, workspace_id, role, content, cost_usd, duration_ms, created_at, thinking,
                    input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens
             FROM chat_messages WHERE workspace_id = ?1 ORDER BY created_at, rowid",
        )?;
        let rows = stmt.query_map(params![workspace_id], |row| {
            let role_str: String = row.get(2)?;
            Ok(ChatMessage {
                id: row.get(0)?,
                workspace_id: row.get(1)?,
                role: role_str.parse().unwrap(),
                content: row.get(3)?,
                cost_usd: row.get(4)?,
                duration_ms: row.get(5)?,
                created_at: row.get(6)?,
                thinking: row.get(7)?,
                input_tokens: row.get(8)?,
                output_tokens: row.get(9)?,
                cache_read_tokens: row.get(10)?,
                cache_creation_tokens: row.get(11)?,
            })
        })?;
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
        let mut stmt = self.conn.prepare(
            "SELECT m.id, m.workspace_id, m.role, m.content, m.cost_usd, m.duration_ms, m.created_at, m.thinking,
                    m.input_tokens, m.output_tokens, m.cache_read_tokens, m.cache_creation_tokens
             FROM chat_messages m
             WHERE m.rowid = (
                 SELECT rowid FROM chat_messages c2
                 WHERE c2.workspace_id = m.workspace_id
                 ORDER BY c2.created_at DESC, c2.rowid DESC
                 LIMIT 1
             )",
        )?;
        let rows = stmt.query_map([], |row| {
            let role_str: String = row.get(2)?;
            Ok(ChatMessage {
                id: row.get(0)?,
                workspace_id: row.get(1)?,
                role: role_str.parse().unwrap(),
                content: row.get(3)?,
                cost_usd: row.get(4)?,
                duration_ms: row.get(5)?,
                created_at: row.get(6)?,
                thinking: row.get(7)?,
                input_tokens: row.get(8)?,
                output_tokens: row.get(9)?,
                cache_read_tokens: row.get(10)?,
                cache_creation_tokens: row.get(11)?,
            })
        })?;
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

    // --- Attachments ---

    pub fn insert_attachment(&self, att: &Attachment) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO attachments (id, message_id, filename, media_type, data, width, height, size_bytes)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                att.id,
                att.message_id,
                att.filename,
                att.media_type,
                att.data,
                att.width,
                att.height,
                att.size_bytes,
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
                "INSERT INTO attachments (id, message_id, filename, media_type, data, width, height, size_bytes)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    att.id,
                    att.message_id,
                    att.filename,
                    att.media_type,
                    att.data,
                    att.width,
                    att.height,
                    att.size_bytes,
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn get_attachment(&self, id: &str) -> Result<Option<Attachment>, rusqlite::Error> {
        self.conn
            .query_row(
                "SELECT id, message_id, filename, media_type, data, width, height, size_bytes, created_at
                 FROM attachments WHERE id = ?1",
                params![id],
                row_to_attachment,
            )
            .optional()
    }

    pub fn list_attachments_for_message(
        &self,
        message_id: &str,
    ) -> Result<Vec<Attachment>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, message_id, filename, media_type, data, width, height, size_bytes, created_at
             FROM attachments WHERE message_id = ?1 ORDER BY created_at",
        )?;
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
            "SELECT id, message_id, filename, media_type, data, width, height, size_bytes, created_at
             FROM attachments WHERE message_id IN ({}) ORDER BY created_at",
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

    // --- Conversation Checkpoints ---

    pub fn insert_checkpoint(&self, cp: &ConversationCheckpoint) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO conversation_checkpoints (id, workspace_id, message_id, commit_hash, turn_index, message_count)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                cp.id,
                cp.workspace_id,
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
            message_id: row.get(2)?,
            commit_hash: row.get(3)?,
            has_file_state: row.get(4)?,
            turn_index: row.get(5)?,
            message_count: row.get(6)?,
            created_at: row.get(7)?,
        })
    }

    /// SQL column list for checkpoint queries, including a subquery for has_file_state.
    const CHECKPOINT_COLS: &str = "id, workspace_id, message_id, commit_hash, \
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

        let mut stmt = self.conn.prepare(
            "SELECT id, workspace_id, role, content, cost_usd, duration_ms, created_at, thinking,
                    input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens
             FROM chat_messages
             WHERE workspace_id = ?1
               AND (created_at < ?2 OR (created_at = ?2 AND rowid <= ?3))
             ORDER BY created_at, rowid",
        )?;
        let rows = stmt.query_map(params![workspace_id, created_at, rowid], |row| {
            let role_str: String = row.get(2)?;
            Ok(ChatMessage {
                id: row.get(0)?,
                workspace_id: row.get(1)?,
                role: role_str.parse().unwrap(),
                content: row.get(3)?,
                cost_usd: row.get(4)?,
                duration_ms: row.get(5)?,
                created_at: row.get(6)?,
                thinking: row.get(7)?,
                input_tokens: row.get(8)?,
                output_tokens: row.get(9)?,
                cache_read_tokens: row.get(10)?,
                cache_creation_tokens: row.get(11)?,
            })
        })?;
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
                "INSERT INTO turn_tool_activities (id, checkpoint_id, tool_use_id, tool_name, input_json, result_text, summary, sort_order)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
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
                "INSERT INTO turn_tool_activities (id, checkpoint_id, tool_use_id, tool_name, input_json, result_text, summary, sort_order)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
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
                    ta.input_json, ta.result_text, ta.summary, ta.sort_order
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
        assert!(result.is_err());
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
        db.insert_chat_message(&make_chat_msg("m1", "w1", ChatRole::User, "hi"))
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

    fn make_chat_msg(id: &str, ws_id: &str, role: ChatRole, content: &str) -> ChatMessage {
        ChatMessage {
            id: id.into(),
            workspace_id: ws_id.into(),
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
        db.insert_chat_message(&make_chat_msg("m1", "w1", ChatRole::User, "hello"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg("m2", "w1", ChatRole::Assistant, "hi there"))
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
        db.insert_chat_message(&make_chat_msg("m1", "w1", ChatRole::User, "for w1"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg("m2", "w2", ChatRole::User, "for w2"))
            .unwrap();
        let msgs = db.list_chat_messages("w1").unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].content, "for w1");
    }

    #[test]
    fn test_update_chat_message_content() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg("m1", "w1", ChatRole::Assistant, "partial"))
            .unwrap();
        db.update_chat_message_content("m1", "partial response complete")
            .unwrap();
        let msgs = db.list_chat_messages("w1").unwrap();
        assert_eq!(msgs[0].content, "partial response complete");
    }

    #[test]
    fn test_update_chat_message_cost() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg("m1", "w1", ChatRole::Assistant, "done"))
            .unwrap();
        db.update_chat_message_cost("m1", 0.005, 2000).unwrap();
        let msgs = db.list_chat_messages("w1").unwrap();
        assert!((msgs[0].cost_usd.unwrap() - 0.005).abs() < f64::EPSILON);
        assert_eq!(msgs[0].duration_ms.unwrap(), 2000);
    }

    #[test]
    fn test_delete_chat_messages_for_workspace() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg("m1", "w1", ChatRole::User, "msg1"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg("m2", "w1", ChatRole::Assistant, "msg2"))
            .unwrap();
        db.delete_chat_messages_for_workspace("w1").unwrap();
        let msgs = db.list_chat_messages("w1").unwrap();
        assert!(msgs.is_empty());
    }

    #[test]
    fn test_chat_messages_cascade_on_workspace_delete() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg("m1", "w1", ChatRole::User, "hello"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg("m2", "w1", ChatRole::Assistant, "hi"))
            .unwrap();
        db.delete_workspace("w1").unwrap();
        let msgs = db.list_chat_messages("w1").unwrap();
        assert!(msgs.is_empty());
    }

    #[test]
    fn test_chat_message_role_roundtrip() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg("m1", "w1", ChatRole::User, "user msg"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg("m2", "w1", ChatRole::Assistant, "asst msg"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg("m3", "w1", ChatRole::System, "sys msg"))
            .unwrap();
        let msgs = db.list_chat_messages("w1").unwrap();
        assert_eq!(msgs[0].role, ChatRole::User);
        assert_eq!(msgs[1].role, ChatRole::Assistant);
        assert_eq!(msgs[2].role, ChatRole::System);
    }

    #[test]
    fn test_chat_message_tokens_round_trip() {
        let db = setup_db_with_workspace();
        let mut msg = make_chat_msg("mt1", "w1", ChatRole::Assistant, "hello");
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
        db.insert_chat_message(&make_chat_msg("mt2", "w1", ChatRole::Assistant, "hi"))
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
        }
    }

    #[test]
    fn test_insert_and_list_attachments() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg("m1", "w1", ChatRole::User, "look at this"))
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
        db.insert_chat_message(&make_chat_msg("m1", "w1", ChatRole::User, "img"))
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
        db.insert_chat_message(&make_chat_msg("m1", "w1", ChatRole::User, "first"))
            .unwrap();
        db.insert_attachment(&make_attachment("a1", "m1", "first.png"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg("m2", "w1", ChatRole::User, "second"))
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
        db.insert_chat_message(&make_chat_msg("m1", "w1", ChatRole::User, "images"))
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
        db.insert_chat_message(&make_chat_msg("m1", "w1", ChatRole::User, "hello"))
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
        db.insert_chat_message(&make_chat_msg("m1", "w1", ChatRole::User, "msg1"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg("m2", "w1", ChatRole::User, "msg2"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg("m3", "w1", ChatRole::User, "msg3"))
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
        db.insert_chat_message(&make_chat_msg("m1", "w1", ChatRole::User, "first"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg("m2", "w1", ChatRole::Assistant, "second"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(
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
        let mut m1 = make_chat_msg("m1", "w1", ChatRole::User, "first");
        m1.created_at = "2026-01-01 00:00:00".into();
        let mut m2 = make_chat_msg("m2", "w1", ChatRole::Assistant, "second");
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

    fn make_checkpoint(id: &str, ws_id: &str, msg_id: &str, turn: i32) -> ConversationCheckpoint {
        ConversationCheckpoint {
            id: id.into(),
            workspace_id: ws_id.into(),
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
        db.insert_chat_message(&make_chat_msg("m1", "w1", ChatRole::User, "q1"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg("m2", "w1", ChatRole::Assistant, "a1"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg("m3", "w1", ChatRole::User, "q2"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg("m4", "w1", ChatRole::Assistant, "a2"))
            .unwrap();

        db.insert_checkpoint(&make_checkpoint("cp1", "w1", "m2", 0))
            .unwrap();
        db.insert_checkpoint(&make_checkpoint("cp2", "w1", "m4", 1))
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
        db.insert_chat_message(&make_chat_msg("m1", "w1", ChatRole::User, "q1"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg("m2", "w1", ChatRole::Assistant, "a1"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg("m3", "w1", ChatRole::User, "q2"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg("m4", "w1", ChatRole::Assistant, "a2"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg("m5", "w1", ChatRole::User, "q3"))
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
        db.insert_chat_message(&make_chat_msg("m1", "w1", ChatRole::User, "q1"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg("m2", "w1", ChatRole::Assistant, "a1"))
            .unwrap();

        let deleted = db.delete_messages_after("w1", "m2").unwrap();
        assert_eq!(deleted, 0);

        let msgs = db.list_chat_messages("w1").unwrap();
        assert_eq!(msgs.len(), 2);
    }

    #[test]
    fn test_delete_checkpoints_after() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg("m1", "w1", ChatRole::Assistant, "a1"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg("m2", "w1", ChatRole::Assistant, "a2"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg("m3", "w1", ChatRole::Assistant, "a3"))
            .unwrap();

        db.insert_checkpoint(&make_checkpoint("cp1", "w1", "m1", 0))
            .unwrap();
        db.insert_checkpoint(&make_checkpoint("cp2", "w1", "m2", 1))
            .unwrap();
        db.insert_checkpoint(&make_checkpoint("cp3", "w1", "m3", 2))
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
        db.insert_chat_message(&make_chat_msg("m1", "w1", ChatRole::Assistant, "a1"))
            .unwrap();
        db.insert_checkpoint(&make_checkpoint("cp1", "w1", "m1", 0))
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
        }
    }

    #[test]
    fn test_insert_and_list_tool_activities() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg("m1", "w1", ChatRole::Assistant, "a1"))
            .unwrap();
        db.insert_checkpoint(&make_checkpoint("cp1", "w1", "m1", 0))
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
        db.insert_chat_message(&make_chat_msg("m1", "w1", ChatRole::Assistant, "a1"))
            .unwrap();
        db.insert_checkpoint(&make_checkpoint("cp1", "w1", "m1", 0))
            .unwrap();
        db.insert_turn_tool_activities(&[make_tool_activity("a1", "cp1", "Read", 0)])
            .unwrap();

        db.delete_checkpoints_after("w1", -1).unwrap();

        let turns = db.list_completed_turns("w1").unwrap();
        assert!(turns.is_empty());
    }

    #[test]
    fn test_list_completed_turns_groups_by_checkpoint() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg("m1", "w1", ChatRole::Assistant, "a1"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg("m2", "w1", ChatRole::Assistant, "a2"))
            .unwrap();
        db.insert_checkpoint(&make_checkpoint("cp1", "w1", "m1", 0))
            .unwrap();
        db.insert_checkpoint(&make_checkpoint("cp2", "w1", "m2", 1))
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
        db.insert_chat_message(&make_chat_msg("m1", "w1", ChatRole::User, "a"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg("m2", "w1", ChatRole::Assistant, "b"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg("m3", "w1", ChatRole::User, "c"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg("m4", "w1", ChatRole::Assistant, "d"))
            .unwrap();

        let msgs = db.list_messages_up_to("w1", "m2").unwrap();
        let ids: Vec<_> = msgs.iter().map(|m| m.id.clone()).collect();
        assert_eq!(ids, vec!["m1".to_string(), "m2".to_string()]);
    }

    #[test]
    fn test_list_messages_up_to_missing_returns_empty() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg("m1", "w1", ChatRole::User, "a"))
            .unwrap();
        let msgs = db.list_messages_up_to("w1", "nonexistent").unwrap();
        assert!(msgs.is_empty());
    }

    #[test]
    fn test_list_checkpoints_up_to() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg("m1", "w1", ChatRole::Assistant, "a"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg("m2", "w1", ChatRole::Assistant, "b"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg("m3", "w1", ChatRole::Assistant, "c"))
            .unwrap();
        db.insert_checkpoint(&make_checkpoint("cp1", "w1", "m1", 0))
            .unwrap();
        db.insert_checkpoint(&make_checkpoint("cp2", "w1", "m2", 1))
            .unwrap();
        db.insert_checkpoint(&make_checkpoint("cp3", "w1", "m3", 2))
            .unwrap();

        let up_to_1 = db.list_checkpoints_up_to("w1", 1).unwrap();
        assert_eq!(up_to_1.len(), 2);
        assert_eq!(up_to_1[0].id, "cp1");
        assert_eq!(up_to_1[1].id, "cp2");
    }

    #[test]
    fn test_update_checkpoint_message_count() {
        let db = setup_db_with_workspace();
        db.insert_chat_message(&make_chat_msg("m1", "w1", ChatRole::Assistant, "a1"))
            .unwrap();
        db.insert_checkpoint(&make_checkpoint("cp1", "w1", "m1", 0))
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

        for (id, role) in [
            ("m1", "user"),
            ("m2", "assistant"),
            ("m3", "user"),
            ("m4", "system"),
        ] {
            db.conn
                .execute(
                    "INSERT INTO chat_messages (id, workspace_id, role, content, cost_usd)
                     VALUES (?1, 'w1', ?2, 'x', 0.01)",
                    params![id, role],
                )
                .unwrap();
        }
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
}
