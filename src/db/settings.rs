//! App settings and repository MCP server CRUD methods on `Database`.
//!
//! This file contributes a `impl Database { ... }` block to the type defined
//! in `super::Database`. Multiple `impl` blocks on the same type across files
//! are idiomatic Rust; the public method paths resolve identically to a
//! single-block layout.

use rusqlite::params;

use serde::{Deserialize, Serialize};

use super::Database;

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

impl Database {
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
    use crate::db::test_support::*;

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
}
