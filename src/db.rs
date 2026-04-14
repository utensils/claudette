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
            path_valid: true, // validated after load
        })
    }

    pub fn list_repositories(&self) -> Result<Vec<Repository>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, path, name, icon, path_slug, created_at, setup_script, custom_instructions, sort_order, branch_rename_preferences
             FROM repositories ORDER BY sort_order, name",
        )?;
        let rows = stmt.query_map([], Self::parse_repo_row)?;
        rows.collect()
    }

    pub fn get_repository(&self, id: &str) -> Result<Option<Repository>, rusqlite::Error> {
        self.conn
            .query_row(
                "SELECT id, path, name, icon, path_slug, created_at, setup_script, custom_instructions, sort_order, branch_rename_preferences
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

    pub fn delete_workspace(&self, id: &str) -> Result<(), rusqlite::Error> {
        self.conn
            .execute("DELETE FROM workspaces WHERE id = ?1", params![id])?;
        Ok(())
    }

    // --- Chat Messages ---

    #[allow(dead_code)]
    pub fn insert_chat_message(&self, msg: &ChatMessage) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO chat_messages (id, workspace_id, role, content, cost_usd, duration_ms, thinking)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                msg.id,
                msg.workspace_id,
                msg.role.as_str(),
                msg.content,
                msg.cost_usd,
                msg.duration_ms,
                msg.thinking,
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
            "SELECT id, workspace_id, role, content, cost_usd, duration_ms, created_at, thinking
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
            "SELECT m.id, m.workspace_id, m.role, m.content, m.cost_usd, m.duration_ms, m.created_at, m.thinking
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
            "SELECT id, repository_id, name, config_json, source, created_at
             FROM repository_mcp_servers
             WHERE repository_id = ?1
             ORDER BY name",
        )?;
        let rows = stmt.query_map(params![repository_id], |row| {
            Ok(RepositoryMcpServer {
                id: row.get(0)?,
                repository_id: row.get(1)?,
                name: row.get(2)?,
                config_json: row.get(3)?,
                source: row.get(4)?,
                created_at: row.get(5)?,
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
        self.conn.execute(
            "DELETE FROM repository_mcp_servers WHERE repository_id = ?1",
            params![repository_id],
        )?;
        for server in servers {
            self.conn.execute(
                "INSERT INTO repository_mcp_servers (id, repository_id, name, config_json, source)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    server.id,
                    server.repository_id,
                    server.name,
                    server.config_json,
                    server.source,
                ],
            )?;
        }
        Ok(())
    }

    /// Delete a single MCP server by ID.
    pub fn delete_repository_mcp_server(&self, id: &str) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "DELETE FROM repository_mcp_servers WHERE id = ?1",
            params![id],
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
}
