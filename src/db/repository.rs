//! Repository CRUD methods on `Database`.
//!
//! This file contributes a `impl Database { ... }` block to the type defined
//! in `super::Database`. Multiple `impl` blocks on the same type across files
//! are idiomatic Rust; the public method paths resolve identically to a
//! single-block layout.

use rusqlite::{OptionalExtension, params};

use crate::model::{Repository, RepositoryInputField};

use super::Database;

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

impl Database {
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
        let required_inputs_raw: Option<String> = row.get(15)?;
        // Tolerate corrupt / forward-version JSON by dropping the schema rather
        // than failing the entire SELECT — losing prompts is preferable to a
        // dead sidebar. A warning trace lets ops notice the regression.
        let required_inputs = required_inputs_raw.and_then(|s| {
            match serde_json::from_str::<Vec<RepositoryInputField>>(&s) {
                Ok(v) if !v.is_empty() => Some(v),
                Ok(_) => None,
                Err(e) => {
                    tracing::warn!(
                        target: "claudette::db",
                        error = %e,
                        "failed to parse repositories.required_inputs JSON; treating as empty"
                    );
                    None
                }
            }
        });
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
            archive_script: row.get(13)?,
            archive_script_auto_run: row.get::<_, i32>(14).unwrap_or(0) != 0,
            required_inputs,
            path_valid: true, // validated after load
        })
    }

    pub fn list_repositories(&self) -> Result<Vec<Repository>, rusqlite::Error> {
        let mut stmt = self.conn.prepare(
            "SELECT id, path, name, icon, path_slug, created_at, setup_script, custom_instructions, sort_order, branch_rename_preferences, setup_script_auto_run, base_branch, default_remote, archive_script, archive_script_auto_run, required_inputs
             FROM repositories ORDER BY sort_order, name",
        )?;
        let rows = stmt.query_map([], Self::parse_repo_row)?;
        rows.collect()
    }

    pub fn get_repository(&self, id: &str) -> Result<Option<Repository>, rusqlite::Error> {
        self.conn
            .query_row(
                "SELECT id, path, name, icon, path_slug, created_at, setup_script, custom_instructions, sort_order, branch_rename_preferences, setup_script_auto_run, base_branch, default_remote, archive_script, archive_script_auto_run, required_inputs
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

    pub fn update_repository_archive_script(
        &self,
        id: &str,
        script: Option<&str>,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE repositories SET archive_script = ?1 WHERE id = ?2",
            params![script, id],
        )?;
        Ok(())
    }

    pub fn update_repository_archive_script_auto_run(
        &self,
        id: &str,
        enabled: bool,
    ) -> Result<(), rusqlite::Error> {
        self.conn.execute(
            "UPDATE repositories SET archive_script_auto_run = ?1 WHERE id = ?2",
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

    /// Persist the per-repo schema of declared inputs.
    ///
    /// An empty schema (`Some(&[])` or `None`) clears the column — callers
    /// pass `None` to mean "this repo no longer prompts on workspace
    /// creation". JSON serialization is infallible for this enum and is
    /// surfaced as `rusqlite::Error::ToSqlConversionFailure` if it ever
    /// breaks so a corrupt row can't sneak in.
    pub fn update_repository_required_inputs(
        &self,
        id: &str,
        schema: Option<&[RepositoryInputField]>,
    ) -> Result<(), rusqlite::Error> {
        let serialized = match schema {
            Some(fields) if !fields.is_empty() => Some(
                serde_json::to_string(fields)
                    .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?,
            ),
            _ => None,
        };
        self.conn.execute(
            "UPDATE repositories SET required_inputs = ?1 WHERE id = ?2",
            params![serialized, id],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_support::*;

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
            is_duplicate_repository_path_error(&err),
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
            !is_duplicate_repository_path_error(&err),
            "id collision should not be mapped to the duplicate-path branch: {err:?}",
        );
    }

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
        let mut repo = make_repo("r1", "/tmp/my-project", "My Project");
        repo.path_slug = "my-project".into();
        db.insert_repository(&repo).unwrap();
        let repos = db.list_repositories().unwrap();
        assert_eq!(repos[0].name, "My Project");
        assert_eq!(repos[0].path_slug, "my-project");
    }

    #[test]
    fn required_inputs_roundtrip_via_update() {
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1", "/tmp/r1", "r1"))
            .unwrap();
        // Empty / unset → None on read.
        let repos = db.list_repositories().unwrap();
        assert!(repos[0].required_inputs.is_none());

        // Write a typed schema, read it back.
        let schema = vec![
            RepositoryInputField::String {
                key: "TICKET_ID".into(),
                label: "Ticket".into(),
                description: None,
                default: None,
                placeholder: Some("PROJ-123".into()),
            },
            RepositoryInputField::Number {
                key: "RETRIES".into(),
                label: "Retries".into(),
                description: None,
                default: Some(3.0),
                min: Some(0.0),
                max: Some(10.0),
                step: None,
                unit: None,
            },
        ];
        db.update_repository_required_inputs("r1", Some(&schema))
            .unwrap();
        let repos = db.list_repositories().unwrap();
        let loaded = repos[0]
            .required_inputs
            .as_ref()
            .expect("required_inputs should round-trip");
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].key(), "TICKET_ID");
        assert_eq!(loaded[1].key(), "RETRIES");

        // Empty slice clears the column back to NULL.
        db.update_repository_required_inputs("r1", Some(&[]))
            .unwrap();
        let repos = db.list_repositories().unwrap();
        assert!(repos[0].required_inputs.is_none());
    }
}
