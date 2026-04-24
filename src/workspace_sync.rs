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
            db.update_workspace_branch_name(id, branch)
                .map_err(|e| e.to_string())?;
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

    fn run_git(path: &Path, args: &[&str], action: &str) {
        let git_path = crate::git::resolve_git_path_blocking();
        let output = Command::new(&git_path)
            .args(args)
            .current_dir(path)
            .output()
            .unwrap_or_else(|e| panic!("{action}: failed to spawn git: {e}"));
        assert!(
            output.status.success(),
            "{action} failed ({:?}): {}",
            output.status,
            String::from_utf8_lossy(&output.stderr),
        );
    }

    fn init_git_repo(path: &Path, branch: &str) {
        run_git(path, &["init", "-b", branch], "git init");
        run_git(
            path,
            &["config", "user.email", "test@test.com"],
            "git config user.email",
        );
        run_git(
            path,
            &["config", "user.name", "Test"],
            "git config user.name",
        );
        std::fs::write(path.join("README.md"), "# test").unwrap();
        run_git(path, &["add", "-A"], "git add");
        run_git(path, &["commit", "-m", "initial"], "git commit");
    }

    fn rename_branch(path: &Path, new_name: &str) {
        run_git(path, &["branch", "-m", new_name], "git branch -m");
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

    #[tokio::test]
    async fn reconcile_all_skips_archived_workspaces() {
        let repo_dir = tempfile::tempdir().unwrap();
        init_git_repo(repo_dir.path(), "claudette/stale");

        let db_dir = tempfile::tempdir().unwrap();
        let db_path = db_dir.path().join("test.db");
        let db = Database::open(&db_path).unwrap();
        db.insert_repository(&make_repo("r1", repo_dir.path()))
            .unwrap();
        db.insert_workspace(&make_ws("w1", "r1", "claudette/stale", repo_dir.path()))
            .unwrap();
        // Archive the workspace — subsequent reconciles should ignore it.
        db.update_workspace_status("w1", &WorkspaceStatus::Archived, None)
            .unwrap();
        drop(db);

        // Rename the branch on disk; an archived workspace must not drive an update.
        rename_branch(repo_dir.path(), "something/else");

        let updates = reconcile_all_workspace_branches(&db_path).await.unwrap();
        assert!(updates.is_empty());

        let db = Database::open(&db_path).unwrap();
        let ws = db
            .list_workspaces()
            .unwrap()
            .into_iter()
            .find(|w| w.id == "w1")
            .unwrap();
        assert_eq!(ws.branch_name, "claudette/stale");
    }

    #[tokio::test]
    async fn reconcile_all_handles_missing_worktree_path() {
        // Archived-style workspaces typically null out worktree_path, but a
        // workspace with no path must never panic or reach git.
        let db_dir = tempfile::tempdir().unwrap();
        let db_path = db_dir.path().join("test.db");
        let db = Database::open(&db_path).unwrap();
        db.insert_repository(&make_repo("r1", std::path::Path::new("/tmp/nonexistent")))
            .unwrap();
        let mut ws = make_ws("w1", "r1", "claudette/x", std::path::Path::new("/tmp"));
        ws.worktree_path = None;
        db.insert_workspace(&ws).unwrap();
        drop(db);

        let updates = reconcile_all_workspace_branches(&db_path).await.unwrap();
        assert!(updates.is_empty());
    }

    #[tokio::test]
    async fn reconcile_all_updates_only_drifted_workspaces() {
        // Two workspaces pointed at two separate repos; only one has been
        // renamed externally. The return value and the DB should only
        // reflect the drifted one.
        let stable = tempfile::tempdir().unwrap();
        init_git_repo(stable.path(), "claudette/stable");
        let drifted = tempfile::tempdir().unwrap();
        init_git_repo(drifted.path(), "claudette/original");

        let db_dir = tempfile::tempdir().unwrap();
        let db_path = db_dir.path().join("test.db");
        let db = Database::open(&db_path).unwrap();
        db.insert_repository(&make_repo("r1", stable.path()))
            .unwrap();
        db.insert_repository(&make_repo("r2", drifted.path()))
            .unwrap();
        db.insert_workspace(&make_ws("w1", "r1", "claudette/stable", stable.path()))
            .unwrap();
        db.insert_workspace(&make_ws("w2", "r2", "claudette/original", drifted.path()))
            .unwrap();
        drop(db);

        rename_branch(drifted.path(), "user/renamed");

        let updates = reconcile_all_workspace_branches(&db_path).await.unwrap();
        assert_eq!(
            updates,
            vec![("w2".to_string(), "user/renamed".to_string())]
        );

        let db = Database::open(&db_path).unwrap();
        let all = db.list_workspaces().unwrap();
        let w1 = all.iter().find(|w| w.id == "w1").unwrap();
        let w2 = all.iter().find(|w| w.id == "w2").unwrap();
        assert_eq!(w1.branch_name, "claudette/stable");
        assert_eq!(w2.branch_name, "user/renamed");
    }

    #[tokio::test]
    async fn reconcile_single_tolerates_detached_head() {
        // After `git checkout <sha>` the worktree is in detached HEAD and
        // `current_branch` returns an error. The reconcile must swallow that
        // and leave the DB alone — not propagate the error or blank the row.
        let repo_dir = tempfile::tempdir().unwrap();
        init_git_repo(repo_dir.path(), "main");

        // Detach HEAD at the current commit.
        let git_path = crate::git::resolve_git_path_blocking();
        let rev_parse = Command::new(&git_path)
            .args(["rev-parse", "HEAD"])
            .current_dir(repo_dir.path())
            .output()
            .expect("spawn git rev-parse");
        assert!(
            rev_parse.status.success(),
            "git rev-parse failed: {}",
            String::from_utf8_lossy(&rev_parse.stderr),
        );
        let head_sha = String::from_utf8(rev_parse.stdout)
            .unwrap()
            .trim()
            .to_string();
        run_git(
            repo_dir.path(),
            &["checkout", "--detach", &head_sha],
            "git checkout --detach",
        );

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

        let db = Database::open(&db_path).unwrap();
        let ws = db
            .list_workspaces()
            .unwrap()
            .into_iter()
            .find(|w| w.id == "w1")
            .unwrap();
        assert_eq!(ws.branch_name, "main");
    }
}
