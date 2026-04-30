//! Slash command usage tracking and pinned prompt CRUD methods on `Database`.
//!
//! This file contributes a `impl Database { ... }` block to the type defined
//! in `super::Database`. Multiple `impl` blocks on the same type across files
//! are idiomatic Rust; the public method paths resolve identically to a
//! single-block layout.

use rusqlite::params;

use crate::model::PinnedPrompt;

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

    // --- Pinned Prompts ---

    /// Returns prompts in a single scope (`Some(repo_id)` for repo-scoped,
    /// `None` for globals). Used by the settings UIs that manage each scope
    /// independently.
    pub fn list_pinned_prompts_in_scope(
        &self,
        repo_id: Option<&str>,
    ) -> Result<Vec<PinnedPrompt>, rusqlite::Error> {
        let mut stmt = match repo_id {
            Some(_) => self.conn.prepare(
                "SELECT id, repo_id, display_name, prompt, auto_send, sort_order, created_at
                 FROM pinned_prompts
                 WHERE repo_id = ?1
                 ORDER BY sort_order, id",
            )?,
            None => self.conn.prepare(
                "SELECT id, repo_id, display_name, prompt, auto_send, sort_order, created_at
                 FROM pinned_prompts
                 WHERE repo_id IS NULL
                 ORDER BY sort_order, id",
            )?,
        };
        let map_row = |row: &rusqlite::Row<'_>| {
            Ok(PinnedPrompt {
                id: row.get(0)?,
                repo_id: row.get(1)?,
                display_name: row.get(2)?,
                prompt: row.get(3)?,
                auto_send: row.get::<_, i64>(4)? != 0,
                sort_order: row.get(5)?,
                created_at: row.get(6)?,
            })
        };
        match repo_id {
            Some(rid) => stmt.query_map(params![rid], map_row)?.collect(),
            None => stmt.query_map([], map_row)?.collect(),
        }
    }

    /// Returns the merged list of pinned prompts shown on the composer.
    ///
    /// Repo-scoped prompts come first (in sort order), then any globals whose
    /// `display_name` is not already used by a repo prompt — repo entries
    /// silently shadow globals with the same display name.
    pub fn list_pinned_prompts_for_composer(
        &self,
        repo_id: Option<&str>,
    ) -> Result<Vec<PinnedPrompt>, rusqlite::Error> {
        let globals = self.list_pinned_prompts_in_scope(None)?;
        let Some(rid) = repo_id else {
            return Ok(globals);
        };
        let repo_prompts = self.list_pinned_prompts_in_scope(Some(rid))?;
        let used: std::collections::HashSet<String> = repo_prompts
            .iter()
            .map(|p| p.display_name.clone())
            .collect();
        let mut merged = repo_prompts;
        for g in globals {
            if !used.contains(&g.display_name) {
                merged.push(g);
            }
        }
        Ok(merged)
    }

    pub fn insert_pinned_prompt(
        &self,
        repo_id: Option<&str>,
        display_name: &str,
        prompt: &str,
        auto_send: bool,
    ) -> Result<PinnedPrompt, rusqlite::Error> {
        let max_order: i32 = match repo_id {
            Some(rid) => self.conn.query_row(
                "SELECT COALESCE(MAX(sort_order), -1) FROM pinned_prompts WHERE repo_id = ?1",
                params![rid],
                |row| row.get(0),
            )?,
            None => self.conn.query_row(
                "SELECT COALESCE(MAX(sort_order), -1) FROM pinned_prompts WHERE repo_id IS NULL",
                [],
                |row| row.get(0),
            )?,
        };
        let next_order = max_order + 1;
        let created_at: String = self
            .conn
            .query_row("SELECT datetime('now')", [], |row| row.get(0))?;
        let auto_send_int: i64 = if auto_send { 1 } else { 0 };
        self.conn.execute(
            "INSERT INTO pinned_prompts (repo_id, display_name, prompt, auto_send, sort_order, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![repo_id, display_name, prompt, auto_send_int, next_order, created_at],
        )?;
        Ok(PinnedPrompt {
            id: self.conn.last_insert_rowid(),
            repo_id: repo_id.map(|s| s.to_string()),
            display_name: display_name.to_string(),
            prompt: prompt.to_string(),
            auto_send,
            sort_order: next_order,
            created_at,
        })
    }

    pub fn update_pinned_prompt(
        &self,
        id: i64,
        display_name: &str,
        prompt: &str,
        auto_send: bool,
    ) -> Result<PinnedPrompt, rusqlite::Error> {
        let auto_send_int: i64 = if auto_send { 1 } else { 0 };
        self.conn.execute(
            "UPDATE pinned_prompts
             SET display_name = ?1, prompt = ?2, auto_send = ?3
             WHERE id = ?4",
            params![display_name, prompt, auto_send_int, id],
        )?;
        self.conn.query_row(
            "SELECT id, repo_id, display_name, prompt, auto_send, sort_order, created_at
             FROM pinned_prompts WHERE id = ?1",
            params![id],
            |row| {
                Ok(PinnedPrompt {
                    id: row.get(0)?,
                    repo_id: row.get(1)?,
                    display_name: row.get(2)?,
                    prompt: row.get(3)?,
                    auto_send: row.get::<_, i64>(4)? != 0,
                    sort_order: row.get(5)?,
                    created_at: row.get(6)?,
                })
            },
        )
    }

    pub fn delete_pinned_prompt(&self, id: i64) -> Result<(), rusqlite::Error> {
        self.conn
            .execute("DELETE FROM pinned_prompts WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn reorder_pinned_prompts(
        &self,
        repo_id: Option<&str>,
        ids: &[i64],
    ) -> Result<(), rusqlite::Error> {
        let tx = self.conn.unchecked_transaction()?;
        {
            let mut stmt_repo = tx.prepare(
                "UPDATE pinned_prompts SET sort_order = ?1 WHERE id = ?2 AND repo_id = ?3",
            )?;
            let mut stmt_global = tx.prepare(
                "UPDATE pinned_prompts SET sort_order = ?1 WHERE id = ?2 AND repo_id IS NULL",
            )?;
            for (i, id) in ids.iter().enumerate() {
                match repo_id {
                    Some(rid) => {
                        stmt_repo.execute(params![i as i32, id, rid])?;
                    }
                    None => {
                        stmt_global.execute(params![i as i32, id])?;
                    }
                }
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

    // --- Pinned prompt tests ---

    #[test]
    fn test_pinned_prompts_repo_crud() {
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1", "/tmp/repo1", "repo1"))
            .unwrap();

        let p1 = db
            .insert_pinned_prompt(Some("r1"), "Review", "/review", false)
            .unwrap();
        let p2 = db
            .insert_pinned_prompt(Some("r1"), "Run tests", "Run all unit tests", true)
            .unwrap();

        assert_eq!(p1.display_name, "Review");
        assert_eq!(p1.prompt, "/review");
        assert!(!p1.auto_send);
        assert_eq!(p2.display_name, "Run tests");
        assert!(p2.auto_send);
        assert!(p1.sort_order < p2.sort_order);

        let pins = db.list_pinned_prompts_in_scope(Some("r1")).unwrap();
        assert_eq!(pins.len(), 2);
        assert_eq!(pins[0].display_name, "Review");
        assert_eq!(pins[1].display_name, "Run tests");

        let updated = db
            .update_pinned_prompt(p1.id, "Code review", "/review --thorough", true)
            .unwrap();
        assert_eq!(updated.display_name, "Code review");
        assert_eq!(updated.prompt, "/review --thorough");
        assert!(updated.auto_send);

        db.delete_pinned_prompt(p1.id).unwrap();
        let pins = db.list_pinned_prompts_in_scope(Some("r1")).unwrap();
        assert_eq!(pins.len(), 1);
        assert_eq!(pins[0].display_name, "Run tests");
    }

    #[test]
    fn test_pinned_prompts_global_crud() {
        let db = Database::open_in_memory().unwrap();

        let g1 = db
            .insert_pinned_prompt(None, "Daily standup", "Summarize my recent commits", true)
            .unwrap();
        assert!(g1.repo_id.is_none());

        let globals = db.list_pinned_prompts_in_scope(None).unwrap();
        assert_eq!(globals.len(), 1);
        assert_eq!(globals[0].display_name, "Daily standup");
    }

    #[test]
    fn test_pinned_prompts_unique_constraint_per_scope() {
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1", "/tmp/repo1", "repo1"))
            .unwrap();

        db.insert_pinned_prompt(Some("r1"), "Review", "/review", false)
            .unwrap();
        let dup = db.insert_pinned_prompt(Some("r1"), "Review", "/review-2", false);
        assert!(dup.is_err());

        // Same name allowed at the global scope and in a different repo.
        db.insert_pinned_prompt(None, "Review", "/review", false)
            .unwrap();
        let dup_global = db.insert_pinned_prompt(None, "Review", "/review", false);
        assert!(dup_global.is_err());
    }

    #[test]
    fn test_pinned_prompts_per_repo_isolation() {
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1", "/tmp/repo1", "repo1"))
            .unwrap();
        db.insert_repository(&make_repo("r2", "/tmp/repo2", "repo2"))
            .unwrap();

        db.insert_pinned_prompt(Some("r1"), "Review", "/review", false)
            .unwrap();
        db.insert_pinned_prompt(Some("r2"), "Deploy", "/deploy", false)
            .unwrap();

        let r1 = db.list_pinned_prompts_in_scope(Some("r1")).unwrap();
        let r2 = db.list_pinned_prompts_in_scope(Some("r2")).unwrap();
        assert_eq!(r1.len(), 1);
        assert_eq!(r1[0].display_name, "Review");
        assert_eq!(r2.len(), 1);
        assert_eq!(r2[0].display_name, "Deploy");
    }

    #[test]
    fn test_pinned_prompts_cascade_on_repo_delete() {
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1", "/tmp/repo1", "repo1"))
            .unwrap();
        db.insert_pinned_prompt(Some("r1"), "Review", "/review", false)
            .unwrap();
        db.insert_pinned_prompt(Some("r1"), "Run tests", "Run tests", true)
            .unwrap();
        // A global should survive the repo deletion.
        db.insert_pinned_prompt(None, "Daily standup", "Standup", true)
            .unwrap();

        db.delete_repository("r1").unwrap();

        let repo_pins = db.list_pinned_prompts_in_scope(Some("r1")).unwrap();
        assert!(repo_pins.is_empty());
        let globals = db.list_pinned_prompts_in_scope(None).unwrap();
        assert_eq!(globals.len(), 1);
    }

    #[test]
    fn test_pinned_prompts_reorder_repo() {
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1", "/tmp/repo1", "repo1"))
            .unwrap();

        let p1 = db
            .insert_pinned_prompt(Some("r1"), "alpha", "a", false)
            .unwrap();
        let p2 = db
            .insert_pinned_prompt(Some("r1"), "beta", "b", false)
            .unwrap();
        let p3 = db
            .insert_pinned_prompt(Some("r1"), "gamma", "c", false)
            .unwrap();

        db.reorder_pinned_prompts(Some("r1"), &[p3.id, p1.id, p2.id])
            .unwrap();

        let pins = db.list_pinned_prompts_in_scope(Some("r1")).unwrap();
        assert_eq!(pins[0].display_name, "gamma");
        assert_eq!(pins[1].display_name, "alpha");
        assert_eq!(pins[2].display_name, "beta");
    }

    #[test]
    fn test_pinned_prompts_reorder_global() {
        let db = Database::open_in_memory().unwrap();
        let p1 = db.insert_pinned_prompt(None, "alpha", "a", false).unwrap();
        let p2 = db.insert_pinned_prompt(None, "beta", "b", false).unwrap();

        db.reorder_pinned_prompts(None, &[p2.id, p1.id]).unwrap();

        let pins = db.list_pinned_prompts_in_scope(None).unwrap();
        assert_eq!(pins[0].display_name, "beta");
        assert_eq!(pins[1].display_name, "alpha");
    }

    #[test]
    fn test_pinned_prompts_composer_merge_repo_overrides_global() {
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1", "/tmp/repo1", "repo1"))
            .unwrap();

        // Globals: "Review" and "Deploy".
        let g_review = db
            .insert_pinned_prompt(None, "Review", "/review --global", false)
            .unwrap();
        let _g_deploy = db
            .insert_pinned_prompt(None, "Deploy", "/deploy --global", false)
            .unwrap();
        // Repo: overrides "Review", adds "Test".
        let r_review = db
            .insert_pinned_prompt(Some("r1"), "Review", "/review --repo", false)
            .unwrap();
        let _r_test = db
            .insert_pinned_prompt(Some("r1"), "Test", "/test", true)
            .unwrap();

        let merged = db.list_pinned_prompts_for_composer(Some("r1")).unwrap();

        // Repo entries come first.
        assert_eq!(merged.len(), 3);
        assert_eq!(merged[0].id, r_review.id);
        assert_eq!(merged[0].prompt, "/review --repo");
        assert_eq!(merged[1].display_name, "Test");
        // Then non-shadowed globals.
        assert_eq!(merged[2].display_name, "Deploy");
        // The shadowed global is NOT present.
        assert!(merged.iter().all(|p| p.id != g_review.id));
    }

    #[test]
    fn test_pinned_prompts_composer_globals_only_when_no_repo() {
        let db = Database::open_in_memory().unwrap();
        db.insert_pinned_prompt(None, "Daily standup", "Standup", true)
            .unwrap();
        let merged = db.list_pinned_prompts_for_composer(None).unwrap();
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].display_name, "Daily standup");
    }
}
