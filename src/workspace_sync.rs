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
use std::sync::Arc;

use tokio::sync::Semaphore;

use crate::db::Database;
use crate::git;
use crate::model::WorkspaceStatus;

/// Caps concurrent `git rev-parse` invocations driven by the periodic
/// branch reconcile. Bounded so a user with dozens of active workspaces
/// doesn't fan-out a fresh `git` process per workspace every poll tick.
const RECONCILE_GIT_PROBE_CONCURRENCY: usize = 6;

/// Re-read the current branch for every active workspace and return the
/// `(workspace_id, current_branch)` pair for each one we could probe. The
/// caller (the frontend store) is expected to overwrite its in-memory branch
/// label with whatever we return, regardless of whether the DB row needed
/// updating — this is **level-triggered** by design so a store that has
/// somehow drifted from the DB can self-heal on the next poll. See issue
/// #538 for the divergence trap this avoids.
///
/// Workspaces whose worktree is missing, that aren't active, or that are in
/// detached HEAD (where `git::current_branch` errors) are silently omitted —
/// we have nothing authoritative to publish for them.
///
/// DB writes are still gated on actual diff so the polling path doesn't
/// rewrite identical values every tick.
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

    // Bounded-concurrent fan-out — capped by `RECONCILE_GIT_PROBE_CONCURRENCY`
    // so a user with many active workspaces doesn't trigger an unbounded
    // wave of `git rev-parse` processes on every poll tick.
    let sem = Arc::new(Semaphore::new(RECONCILE_GIT_PROBE_CONCURRENCY));
    let probe_futures: Vec<_> = workspaces
        .iter()
        .filter(|ws| ws.status == WorkspaceStatus::Active)
        .filter_map(|ws| {
            ws.worktree_path.as_ref().map(|wt_path| {
                let id = ws.id.clone();
                let wt_path = wt_path.clone();
                let stored_branch = ws.branch_name.clone();
                let sem = Arc::clone(&sem);
                async move {
                    let _permit = sem.acquire_owned().await.ok();
                    match git::current_branch(&wt_path).await {
                        Ok(branch) => {
                            let drifted = branch != stored_branch;
                            Some((id, branch, drifted))
                        }
                        Err(_) => None,
                    }
                }
            })
        })
        .collect();

    let probes: Vec<(String, String, bool)> = futures::future::join_all(probe_futures)
        .await
        .into_iter()
        .flatten()
        .collect();

    let drifted: Vec<(&String, &String)> = probes
        .iter()
        .filter_map(|(id, branch, drifted)| if *drifted { Some((id, branch)) } else { None })
        .collect();
    if !drifted.is_empty() {
        let db = Database::open(db_path).map_err(|e| e.to_string())?;
        for (id, branch) in &drifted {
            db.update_workspace_branch_name(id, branch)
                .map_err(|e| e.to_string())?;
        }
    }

    Ok(probes
        .into_iter()
        .map(|(id, branch, _)| (id, branch))
        .collect())
}

/// Re-read the current branch for a single workspace and return whatever git
/// reports — `Some(branch)` is **always the current branch**, not just on
/// drift, so the frontend can overwrite its store value unconditionally.
/// `None` means we have nothing authoritative to publish: the workspace is
/// archived, has no worktree path, or git refused to name a branch (e.g.
/// detached HEAD). A missing workspace id surfaces as `Err("Workspace not
/// found")` rather than `None`. See issue #538.
///
/// The DB write is still gated on diff so a no-op refresh costs only a
/// `git rev-parse`.
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

    if branch != ws.branch_name {
        let db = Database::open(db_path).map_err(|e| e.to_string())?;
        db.update_workspace_branch_name(&ws.id, &branch)
            .map_err(|e| e.to_string())?;
    }
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
            sort_order: 0,
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
            archive_script: None,
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

        // First pass: DB already matches git. Level-triggered reconcile still
        // reports the current branch so a stale store can self-heal.
        let updates = reconcile_all_workspace_branches(&db_path).await.unwrap();
        assert_eq!(
            updates,
            vec![("w1".to_string(), "claudette/original".to_string())]
        );

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
    async fn reconcile_single_reports_branch_when_unchanged() {
        // Level-triggered semantics (#538): when DB and git agree, still
        // return the current branch so a stale store can be overwritten.
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
        assert_eq!(result, Some("main".to_string()));
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

        // Rename the branch on disk; an archived workspace must not drive an
        // update or appear in the level-triggered result set.
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
    async fn reconcile_all_reports_every_active_workspace_writes_only_drifted() {
        // Level-triggered semantics (#538): both workspaces appear in the
        // result, but only the drifted one is written back to the DB.
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

        let mut updates = reconcile_all_workspace_branches(&db_path).await.unwrap();
        updates.sort();
        assert_eq!(
            updates,
            vec![
                ("w1".to_string(), "claudette/stable".to_string()),
                ("w2".to_string(), "user/renamed".to_string()),
            ]
        );

        let db = Database::open(&db_path).unwrap();
        let all = db.list_workspaces().unwrap();
        let w1 = all.iter().find(|w| w.id == "w1").unwrap();
        let w2 = all.iter().find(|w| w.id == "w2").unwrap();
        assert_eq!(w1.branch_name, "claudette/stable");
        assert_eq!(w2.branch_name, "user/renamed");
    }

    #[tokio::test]
    async fn reconcile_all_handles_more_workspaces_than_concurrency_cap() {
        // Spin up more workspaces than RECONCILE_GIT_PROBE_CONCURRENCY so the
        // semaphore is genuinely exercised. Every odd-indexed workspace is
        // renamed externally; under level-triggered semantics every active
        // workspace appears in the result (even ones that haven't drifted),
        // while DB writes still happen only for those that actually changed.
        let total = RECONCILE_GIT_PROBE_CONCURRENCY * 2 + 1;
        let db_dir = tempfile::tempdir().unwrap();
        let db_path = db_dir.path().join("test.db");
        let db = Database::open(&db_path).unwrap();

        let mut repo_dirs = Vec::with_capacity(total);
        let mut expected_results: Vec<(String, String)> = Vec::new();
        let mut expected_db: Vec<(String, String)> = Vec::new();
        for i in 0..total {
            let dir = tempfile::tempdir().unwrap();
            init_git_repo(dir.path(), "claudette/orig");
            let repo_id = format!("r{i}");
            let ws_id = format!("w{i}");
            db.insert_repository(&make_repo(&repo_id, dir.path()))
                .unwrap();
            db.insert_workspace(&make_ws(&ws_id, &repo_id, "claudette/orig", dir.path()))
                .unwrap();
            let final_branch = if i % 2 == 1 {
                let new_branch = format!("user/r{i}");
                rename_branch(dir.path(), &new_branch);
                new_branch
            } else {
                "claudette/orig".to_string()
            };
            expected_results.push((ws_id.clone(), final_branch.clone()));
            expected_db.push((ws_id, final_branch));
            repo_dirs.push(dir);
        }
        drop(db);

        let mut updates = reconcile_all_workspace_branches(&db_path).await.unwrap();
        updates.sort();
        expected_results.sort();
        assert_eq!(updates, expected_results);

        let db = Database::open(&db_path).unwrap();
        let all = db.list_workspaces().unwrap();
        for (id, branch) in &expected_db {
            let ws = all.iter().find(|w| &w.id == id).unwrap();
            assert_eq!(&ws.branch_name, branch);
        }
    }

    #[tokio::test]
    async fn reconcile_all_self_heals_stale_caller_when_db_matches_git() {
        // Regression for #538: even when DB and git agree, the result must
        // contain a non-empty entry per active workspace so a frontend store
        // that has somehow drifted can be overwritten on the next poll.
        let repo_dir = tempfile::tempdir().unwrap();
        init_git_repo(repo_dir.path(), "claudette/agreed");

        let db_dir = tempfile::tempdir().unwrap();
        let db_path = db_dir.path().join("test.db");
        let db = Database::open(&db_path).unwrap();
        db.insert_repository(&make_repo("r1", repo_dir.path()))
            .unwrap();
        db.insert_workspace(&make_ws("w1", "r1", "claudette/agreed", repo_dir.path()))
            .unwrap();
        drop(db);

        let updates = reconcile_all_workspace_branches(&db_path).await.unwrap();
        assert_eq!(
            updates,
            vec![("w1".to_string(), "claudette/agreed".to_string())]
        );
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
