use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};

use crate::model::{
    ChatMessage, RemoteConnection, Repository, TerminalTab, Workspace, WorkspaceStatus,
};

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

        Ok(())
    }

    // --- Repositories ---

    pub fn insert_repository(&self, repo: &Repository) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO repositories (id, path, name, path_slug) VALUES (?1, ?2, ?3, ?4)",
            params![repo.id, repo.path, repo.name, repo.path_slug],
        )?;
        Ok(())
    }

    pub fn list_repositories(&self) -> Result<Vec<Repository>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, path, name, icon, path_slug, created_at, setup_script, custom_instructions
             FROM repositories ORDER BY name",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Repository {
                id: row.get(0)?,
                path: row.get(1)?,
                name: row.get(2)?,
                icon: row.get(3)?,
                path_slug: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                created_at: row.get(5)?,
                setup_script: row.get(6)?,
                custom_instructions: row.get(7)?,
                path_valid: true, // validated after load
            })
        })?;
        rows.collect()
    }

    pub fn get_repository(&self, id: &str) -> Result<Option<Repository>, rusqlite::Error> {
        self.conn.query_row(
            "SELECT id, path, name, icon, path_slug, created_at, setup_script, custom_instructions
             FROM repositories WHERE id = ?1",
            params![id],
            |row| {
                Ok(Repository {
                    id: row.get(0)?,
                    path: row.get(1)?,
                    name: row.get(2)?,
                    icon: row.get(3)?,
                    path_slug: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                    created_at: row.get(5)?,
                    setup_script: row.get(6)?,
                    custom_instructions: row.get(7)?,
                    path_valid: true,
                })
            },
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

    pub fn delete_workspace(&self, id: &str) -> Result<(), rusqlite::Error> {
        self.conn
            .execute("DELETE FROM workspaces WHERE id = ?1", params![id])?;
        Ok(())
    }

    // --- Chat Messages ---

    #[allow(dead_code)]
    pub fn insert_chat_message(&self, msg: &ChatMessage) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "INSERT INTO chat_messages (id, workspace_id, role, content, cost_usd, duration_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                msg.id,
                msg.workspace_id,
                msg.role.as_str(),
                msg.content,
                msg.cost_usd,
                msg.duration_ms,
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
            "SELECT id, workspace_id, role, content, cost_usd, duration_ms, created_at
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
            "SELECT m.id, m.workspace_id, m.role, m.content, m.cost_usd, m.duration_ms, m.created_at
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
                port: row.get::<_, i32>(3)? as u16,
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
                        port: row.get::<_, i32>(3)? as u16,
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{AgentStatus, ChatRole, WorkspaceStatus};

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
}
