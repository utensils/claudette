//! SCM status cache CRUD methods on `Database`.
//!
//! This file contributes a `impl Database { ... }` block to the type defined
//! in `super::Database`. Multiple `impl` blocks on the same type across files
//! are idiomatic Rust; the public method paths resolve identically to a
//! single-block layout.

use rusqlite::params;

use serde::{Deserialize, Serialize};

use super::Database;

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

impl Database {
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::*;

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
}
