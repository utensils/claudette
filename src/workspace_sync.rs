//! Sync workspace metadata with the on-disk git state.
//!
//! The DB stores each workspace's `branch_name` at creation time, but users
//! can rename the branch in the integrated terminal (`git branch -m`) or
//! switch branches with `git checkout -b`. Those external operations bypass
//! the auto-rename path in the chat command, so the DB drifts from reality.
//!
//! These helpers re-read the current branch from git and persist any drift
//! back to the DB, keeping the sidebar and other DB-backed UI in sync. They
//! are driven from the Tauri command layer both periodically and on workspace
//! selection.

use std::path::Path;

use crate::db::Database;
use crate::git;
use crate::model::WorkspaceStatus;

/// Re-read the current branch for every active workspace. For each workspace
/// whose stored `branch_name` no longer matches the worktree's HEAD, persist
/// the fresh value to the DB and return the `(workspace_id, new_branch)` pair
/// so the caller can mirror the change into in-memory UI state.
///
/// DB access is split into short synchronous blocks around the async git
/// calls, because `rusqlite::Connection` is not `Send`.
pub async fn reconcile_all_workspace_branches(
    db_path: &Path,
) -> Result<Vec<(String, String)>, String> {
    let workspaces = {
        let db = Database::open(db_path).map_err(|e| e.to_string())?;
        db.list_workspaces().map_err(|e| e.to_string())?
    };

    let mut updates = Vec::new();
    for ws in &workspaces {
        if ws.status != WorkspaceStatus::Active {
            continue;
        }
        if let Some(ref wt_path) = ws.worktree_path
            && let Ok(branch) = git::current_branch(wt_path).await
            && branch != ws.branch_name
        {
            updates.push((ws.id.clone(), branch));
        }
    }

    if !updates.is_empty() {
        let db = Database::open(db_path).map_err(|e| e.to_string())?;
        for (id, branch) in &updates {
            let _ = db.update_workspace_branch_name(id, branch);
        }
    }

    Ok(updates)
}

/// Re-read the current branch for a single workspace. Returns the new branch
/// name if the DB was stale (and was just updated), or `None` when nothing
/// needed to change, the workspace isn't active, or the worktree is missing.
pub async fn reconcile_single_workspace_branch(
    db_path: &Path,
    workspace_id: &str,
) -> Result<Option<String>, String> {
    let ws = {
        let db = Database::open(db_path).map_err(|e| e.to_string())?;
        db.list_workspaces()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|w| w.id == workspace_id)
            .ok_or("Workspace not found")?
    };

    if ws.status != WorkspaceStatus::Active {
        return Ok(None);
    }
    let Some(wt_path) = ws.worktree_path.as_ref() else {
        return Ok(None);
    };
    let Ok(branch) = git::current_branch(wt_path).await else {
        return Ok(None);
    };
    if branch == ws.branch_name {
        return Ok(None);
    }

    let db = Database::open(db_path).map_err(|e| e.to_string())?;
    db.update_workspace_branch_name(&ws.id, &branch)
        .map_err(|e| e.to_string())?;
    Ok(Some(branch))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{AgentStatus, Repository, Workspace};
    use std::process::Command;

    fn init_git_repo(path: &Path, branch: &str) {
        Command::new("git")
            .args(["init", "-b", branch])
            .current_dir(path)
            .output()
            .expect("git init");
        Command::new("git")
            .args(["config", "user.email", "test@test.com"])
            .current_dir(path)
            .output()
            .expect("git config");
        Command::new("git")
            .args(["config", "user.name", "Test"])
            .current_dir(path)
            .output()
            .expect("git config");
        std::fs::write(path.join("README.md"), "# test").unwrap();
        Command::new("git")
            .args(["add", "-A"])
            .current_dir(path)
            .output()
            .expect("git add");
        Command::new("git")
            .args(["commit", "-m", "initial"])
            .current_dir(path)
            .output()
            .expect("git commit");
    }

    fn rename_branch(path: &Path, new_name: &str) {
        Command::new("git")
            .args(["branch", "-m", new_name])
            .current_dir(path)
            .output()
            .expect("git branch -m");
    }

    fn make_ws(id: &str, repo_id: &str, branch: &str, worktree: &Path) -> Workspace {
        Workspace {
            id: id.into(),
            repository_id: repo_id.into(),
            name: id.into(),
            branch_name: branch.into(),
            worktree_path: Some(worktree.to_string_lossy().to_string()),
            status: WorkspaceStatus::Active,
            agent_status: AgentStatus::Idle,
            status_line: String::new(),
            created_at: String::new(),
        }
    }

    fn make_repo(id: &str, path: &Path) -> Repository {
        Repository {
            id: id.into(),
            path: path.to_string_lossy().to_string(),
            name: id.into(),
            path_slug: id.into(),
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
        }
    }

    #[tokio::test]
    async fn reconcile_all_persists_external_rename() {
        let repo_dir = tempfile::tempdir().unwrap();
        init_git_repo(repo_dir.path(), "claudette/original");

        let db_dir = tempfile::tempdir().unwrap();
        let db_path = db_dir.path().join("test.db");
        let db = Database::open(&db_path).unwrap();
        db.insert_repository(&make_repo("r1", repo_dir.path()))
            .unwrap();
        db.insert_workspace(&make_ws("w1", "r1", "claudette/original", repo_dir.path()))
            .unwrap();
        drop(db);

        // First pass: DB already matches git, no updates expected.
        let updates = reconcile_all_workspace_branches(&db_path).await.unwrap();
        assert!(updates.is_empty());

        // Simulate the user renaming the branch externally.
        rename_branch(repo_dir.path(), "user/renamed-branch");

        let updates = reconcile_all_workspace_branches(&db_path).await.unwrap();
        assert_eq!(
            updates,
            vec![("w1".to_string(), "user/renamed-branch".to_string())]
        );

        // DB now reflects the new branch name — the fix that closes #354.
        let db = Database::open(&db_path).unwrap();
        let ws = db
            .list_workspaces()
            .unwrap()
            .into_iter()
            .find(|w| w.id == "w1")
            .unwrap();
        assert_eq!(ws.branch_name, "user/renamed-branch");
    }

    #[tokio::test]
    async fn reconcile_single_returns_none_when_unchanged() {
        let repo_dir = tempfile::tempdir().unwrap();
        init_git_repo(repo_dir.path(), "main");

        let db_dir = tempfile::tempdir().unwrap();
        let db_path = db_dir.path().join("test.db");
        let db = Database::open(&db_path).unwrap();
        db.insert_repository(&make_repo("r1", repo_dir.path()))
            .unwrap();
        db.insert_workspace(&make_ws("w1", "r1", "main", repo_dir.path()))
            .unwrap();
        drop(db);

        let result = reconcile_single_workspace_branch(&db_path, "w1")
            .await
            .unwrap();
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn reconcile_single_persists_on_drift() {
        let repo_dir = tempfile::tempdir().unwrap();
        init_git_repo(repo_dir.path(), "main");

        let db_dir = tempfile::tempdir().unwrap();
        let db_path = db_dir.path().join("test.db");
        let db = Database::open(&db_path).unwrap();
        db.insert_repository(&make_repo("r1", repo_dir.path()))
            .unwrap();
        db.insert_workspace(&make_ws("w1", "r1", "main", repo_dir.path()))
            .unwrap();
        drop(db);

        rename_branch(repo_dir.path(), "feature/new");

        let result = reconcile_single_workspace_branch(&db_path, "w1")
            .await
            .unwrap();
        assert_eq!(result, Some("feature/new".to_string()));

        let db = Database::open(&db_path).unwrap();
        let ws = db
            .list_workspaces()
            .unwrap()
            .into_iter()
            .find(|w| w.id == "w1")
            .unwrap();
        assert_eq!(ws.branch_name, "feature/new");
    }

    #[tokio::test]
    async fn reconcile_single_missing_workspace_errors() {
        let db_dir = tempfile::tempdir().unwrap();
        let db_path = db_dir.path().join("test.db");
        let _db = Database::open(&db_path).unwrap();
        let err = reconcile_single_workspace_branch(&db_path, "nope")
            .await
            .unwrap_err();
        assert!(err.contains("not found"));
    }
}
