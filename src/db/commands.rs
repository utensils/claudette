//! Slash command usage tracking and pinned command CRUD methods on `Database`.
//!
//! Pinned commands JOIN against slash_command_usage to compute use_count,
//! which is why these two domains share a module.
//!
//! This file contributes a `impl Database { ... }` block to the type defined
//! in `super::Database`. Multiple `impl` blocks on the same type across files
//! are idiomatic Rust; the public method paths resolve identically to a
//! single-block layout.

use rusqlite::params;

use crate::model::PinnedCommand;

use super::Database;

impl Database {
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
