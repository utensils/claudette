use std::fmt;
use std::path::Path;

use serde::Serialize;
use tokio::process::Command;

#[derive(Debug, Clone)]
pub enum GitError {
    NotAGitRepo,
    CommandFailed(String),
}

impl fmt::Display for GitError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotAGitRepo => write!(f, "Not a git repository"),
            Self::CommandFailed(msg) => write!(f, "Git command failed: {msg}"),
        }
    }
}

impl std::error::Error for GitError {}

async fn run_git(repo_path: &str, args: &[&str]) -> Result<String, GitError> {
    let output = Command::new("git")
        .args(["-C", repo_path])
        .args(args)
        .output()
        .await
        .map_err(|e| GitError::CommandFailed(e.to_string()))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(GitError::CommandFailed(stderr))
    }
}

/// Read `git config user.name` from global config (no repo required).
/// Returns `None` if not configured.
pub async fn get_git_username() -> Result<Option<String>, GitError> {
    let output = Command::new("git")
        .args(["config", "--global", "user.name"])
        .output()
        .await
        .map_err(|e| GitError::CommandFailed(e.to_string()))?;

    if output.status.success() {
        let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if name.is_empty() {
            Ok(None)
        } else {
            Ok(Some(name))
        }
    } else {
        Ok(None)
    }
}

pub async fn validate_repo(path: &str) -> Result<(), GitError> {
    if !Path::new(path).is_dir() {
        return Err(GitError::NotAGitRepo);
    }
    run_git(path, &["rev-parse", "--git-dir"]).await?;
    Ok(())
}

pub async fn default_branch(repo_path: &str) -> Result<String, GitError> {
    // Resolve the primary remote name (usually "origin", but could be "upstream"
    // in fork-and-PR workflows). Falls back to "origin" if no remote exists.
    let remote = run_git(repo_path, &["remote"])
        .await
        .ok()
        .and_then(|out| out.lines().next().map(|l| l.to_string()))
        .unwrap_or_else(|| "origin".to_string());

    // Try symbolic-ref of <remote>/HEAD first (returns e.g. "origin/main")
    if let Ok(remote_head) = run_git(
        repo_path,
        &[
            "symbolic-ref",
            &format!("refs/remotes/{remote}/HEAD"),
            "--short",
        ],
    )
    .await
        && !remote_head.is_empty()
    {
        return Ok(remote_head);
    }

    // Fall back to checking if remote-tracking main or master exists
    if run_git(
        repo_path,
        &[
            "rev-parse",
            "--verify",
            &format!("refs/remotes/{remote}/main"),
        ],
    )
    .await
    .is_ok()
    {
        return Ok(format!("{remote}/main"));
    }
    if run_git(
        repo_path,
        &[
            "rev-parse",
            "--verify",
            &format!("refs/remotes/{remote}/master"),
        ],
    )
    .await
    .is_ok()
    {
        return Ok(format!("{remote}/master"));
    }

    // Last resort: local branches (no remote configured)
    if run_git(repo_path, &["rev-parse", "--verify", "refs/heads/main"])
        .await
        .is_ok()
    {
        return Ok("main".into());
    }
    if run_git(repo_path, &["rev-parse", "--verify", "refs/heads/master"])
        .await
        .is_ok()
    {
        return Ok("master".into());
    }

    Err(GitError::CommandFailed(
        "Could not determine default branch".into(),
    ))
}

/// Fetch from the primary remote (best-effort).
///
/// Resolves the first configured remote and runs `git fetch` with a 15-second
/// timeout. Failures are logged but never propagated — callers can proceed with
/// potentially stale refs when the network is unavailable.
pub async fn fetch_remote(repo_path: &str) -> Result<(), GitError> {
    let remote = run_git(repo_path, &["remote"])
        .await
        .ok()
        .and_then(|out| out.lines().next().map(|l| l.to_string()))
        .unwrap_or_else(|| "origin".to_string());

    // Spawn with kill_on_drop so the child is terminated if the timeout fires.
    let mut child = match Command::new("git")
        .args(["-C", repo_path, "fetch", &remote])
        .kill_on_drop(true)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[git] failed to spawn fetch {remote}: {e}");
            return Ok(());
        }
    };

    match tokio::time::timeout(std::time::Duration::from_secs(15), child.wait()).await {
        Ok(Ok(status)) if status.success() => Ok(()),
        Ok(Ok(status)) => {
            eprintln!("[git] fetch {remote} exited with {status} (continuing with local refs)");
            Ok(())
        }
        Ok(Err(e)) => {
            eprintln!("[git] fetch {remote} failed (continuing with local refs): {e}");
            Ok(())
        }
        Err(_) => {
            eprintln!("[git] fetch {remote} timed out after 15s (continuing with local refs)");
            Ok(())
        }
    }
}

pub async fn create_worktree(
    repo_path: &str,
    branch_name: &str,
    worktree_path: &str,
) -> Result<String, GitError> {
    // Fetch latest remote state before branching (best-effort).
    let _ = fetch_remote(repo_path).await;
    let base = default_branch(repo_path).await?;
    run_git(
        repo_path,
        &["worktree", "add", "-b", branch_name, worktree_path, &base],
    )
    .await?;

    // Return the absolute worktree path
    let abs_path = std::path::Path::new(worktree_path)
        .canonicalize()
        .map_err(|e| GitError::CommandFailed(e.to_string()))?;
    Ok(abs_path.to_string_lossy().to_string())
}

/// Restore a worktree for an existing branch (no -b flag).
pub async fn restore_worktree(
    repo_path: &str,
    branch_name: &str,
    worktree_path: &str,
) -> Result<String, GitError> {
    run_git(
        repo_path,
        &["worktree", "add", worktree_path, "--", branch_name],
    )
    .await?;
    let abs_path = std::path::Path::new(worktree_path)
        .canonicalize()
        .map_err(|e| GitError::CommandFailed(e.to_string()))?;
    Ok(abs_path.to_string_lossy().to_string())
}

pub async fn remove_worktree(
    repo_path: &str,
    worktree_path: &str,
    force: bool,
) -> Result<(), GitError> {
    let args = if force {
        vec!["worktree", "remove", "--force", worktree_path]
    } else {
        vec!["worktree", "remove", worktree_path]
    };
    run_git(repo_path, &args).await?;
    Ok(())
}

#[allow(dead_code)]
pub async fn list_branches(repo_path: &str) -> Result<Vec<String>, GitError> {
    let output = run_git(repo_path, &["branch", "--format=%(refname:short)"]).await?;
    Ok(output.lines().map(|l| l.to_string()).collect())
}

#[allow(dead_code)]
pub async fn has_unmerged_commits(
    repo_path: &str,
    branch: &str,
    base: &str,
) -> Result<bool, GitError> {
    let output = run_git(
        repo_path,
        &["rev-list", "--count", &format!("{base}..{branch}")],
    )
    .await?;
    let count: u32 = output.parse().unwrap_or(0);
    Ok(count > 0)
}

/// Delete a branch. Tries safe `-d` first; falls back to force `-D`
/// if `-d` fails.
pub async fn branch_delete(repo_path: &str, branch: &str) -> Result<(), GitError> {
    if run_git(repo_path, &["branch", "-d", "--", branch])
        .await
        .is_ok()
    {
        return Ok(());
    }
    run_git(repo_path, &["branch", "-D", "--", branch]).await?;
    Ok(())
}

/// Hard-reset a worktree to a specific commit and clean untracked files.
pub async fn restore_to_commit(worktree_path: &str, commit_hash: &str) -> Result<(), GitError> {
    run_git(worktree_path, &["reset", "--hard", commit_hash]).await?;
    run_git(worktree_path, &["clean", "-fd"]).await?;
    Ok(())
}

/// Rename a branch. The worktree's HEAD follows automatically.
/// `path` can be a repo root or a worktree — when the branch is checked
/// out in a linked worktree, pass the worktree path to avoid errors.
pub async fn rename_branch(path: &str, old_name: &str, new_name: &str) -> Result<(), GitError> {
    run_git(path, &["branch", "-m", "--", old_name, new_name]).await?;
    Ok(())
}

/// Get the remote URL for a repository (typically `origin`).
pub async fn get_remote_url(repo_path: &str) -> Result<String, GitError> {
    // Resolve the primary remote name (same approach as default_branch)
    let remote = run_git(repo_path, &["remote"])
        .await
        .ok()
        .and_then(|out| out.lines().next().map(|l| l.to_string()))
        .unwrap_or_else(|| "origin".to_string());

    run_git(repo_path, &["remote", "get-url", &remote]).await
}

/// Get the current branch name for a worktree or repository.
/// Returns an error if in a detached HEAD state.
pub async fn current_branch(repo_path: &str) -> Result<String, GitError> {
    let branch = run_git(repo_path, &["rev-parse", "--abbrev-ref", "HEAD"]).await?;
    if branch == "HEAD" {
        // Detached HEAD state - not on a branch
        return Err(GitError::CommandFailed(
            "In detached HEAD state (not on a branch)".into(),
        ));
    }
    Ok(branch)
}

/// Information about a single git worktree, parsed from `git worktree list --porcelain`.
#[derive(Debug, Clone, Serialize)]
pub struct WorktreeInfo {
    pub path: String,
    pub head: String,
    pub branch: Option<String>,
    pub is_bare: bool,
}

/// List all worktrees for a repository.
///
/// The first entry is always the main worktree (the repository itself or, for
/// bare repos, the bare directory). Callers that only want linked worktrees
/// should skip entries whose path matches the repository path.
pub async fn list_worktrees(repo_path: &str) -> Result<Vec<WorktreeInfo>, GitError> {
    let output = run_git(repo_path, &["worktree", "list", "--porcelain"]).await?;

    let mut worktrees = Vec::new();
    let mut path = None;
    let mut head = None;
    let mut branch = None;
    let mut is_bare = false;

    for line in output.lines() {
        if line.is_empty() {
            if let (Some(p), Some(h)) = (path.take(), head.take()) {
                worktrees.push(WorktreeInfo {
                    path: p,
                    head: h,
                    branch: branch.take(),
                    is_bare,
                });
            }
            is_bare = false;
            continue;
        }
        if let Some(rest) = line.strip_prefix("worktree ") {
            path = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix("HEAD ") {
            head = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix("branch refs/heads/") {
            branch = Some(rest.to_string());
        } else if line == "bare" {
            is_bare = true;
        }
    }

    // Flush the last entry (porcelain output may not end with a blank line).
    if let (Some(p), Some(h)) = (path, head) {
        worktrees.push(WorktreeInfo {
            path: p,
            head: h,
            branch,
            is_bare,
        });
    }

    Ok(worktrees)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Create a temporary git repo for testing.
    async fn setup_temp_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_str().unwrap();
        run_git(path, &["init", "-b", "main"]).await.unwrap();
        run_git(path, &["config", "user.email", "test@test.com"])
            .await
            .unwrap();
        run_git(path, &["config", "user.name", "Test"])
            .await
            .unwrap();

        // Create an initial commit so HEAD exists.
        let readme = dir.path().join("README.md");
        std::fs::write(&readme, "# test").unwrap();
        run_git(path, &["add", "-A"]).await.unwrap();
        run_git(path, &["commit", "-m", "initial"]).await.unwrap();

        dir
    }

    #[tokio::test]
    async fn test_restore_to_commit() {
        let dir = setup_temp_repo().await;
        let path = dir.path().to_str().unwrap();
        let file = dir.path().join("data.txt");

        // Create a commit with known content.
        std::fs::write(&file, "version 1").unwrap();
        run_git(path, &["add", "-A"]).await.unwrap();
        run_git(path, &["commit", "-m", "v1"]).await.unwrap();
        let hash1 = run_git(path, &["rev-parse", "HEAD"]).await.unwrap();

        // Create another commit.
        std::fs::write(&file, "version 2").unwrap();
        run_git(path, &["add", "-A"]).await.unwrap();
        run_git(path, &["commit", "-m", "v2"]).await.unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "version 2");

        // Restore to first commit.
        restore_to_commit(path, &hash1).await.unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "version 1");
    }

    #[tokio::test]
    async fn test_restore_to_commit_cleans_untracked() {
        let dir = setup_temp_repo().await;
        let path = dir.path().to_str().unwrap();

        let head = run_git(path, &["rev-parse", "HEAD"]).await.unwrap();

        // Create an untracked file.
        let extra = dir.path().join("extra.txt");
        std::fs::write(&extra, "should be cleaned").unwrap();
        assert!(extra.exists());

        restore_to_commit(path, &head).await.unwrap();
        assert!(!extra.exists());
    }

    #[tokio::test]
    async fn test_branch_delete_force_deletes_checkpoint_only_branch() {
        let dir = setup_temp_repo().await;
        let path = dir.path().to_str().unwrap();

        // Create a branch with only checkpoint commits.
        run_git(path, &["checkout", "-b", "ws-branch"])
            .await
            .unwrap();
        std::fs::write(dir.path().join("a.txt"), "a").unwrap();
        run_git(path, &["add", "-A"]).await.unwrap();
        run_git(path, &["commit", "-m", "[checkpoint] Turn 0"])
            .await
            .unwrap();
        std::fs::write(dir.path().join("b.txt"), "b").unwrap();
        run_git(path, &["add", "-A"]).await.unwrap();
        run_git(path, &["commit", "-m", "[checkpoint] Turn 1"])
            .await
            .unwrap();
        run_git(path, &["checkout", "main"]).await.unwrap();

        // Branch has unmerged checkpoint commits — should force-delete.
        branch_delete(path, "ws-branch").await.unwrap();

        // Confirm branch is gone.
        let branches = run_git(path, &["branch", "--list", "ws-branch"])
            .await
            .unwrap();
        assert!(branches.trim().is_empty());
    }

    #[tokio::test]
    async fn test_branch_delete_force_deletes_branch_with_real_commits() {
        let dir = setup_temp_repo().await;
        let path = dir.path().to_str().unwrap();

        // Create a branch with a mix of checkpoint and real commits.
        run_git(path, &["checkout", "-b", "ws-branch"])
            .await
            .unwrap();
        std::fs::write(dir.path().join("a.txt"), "a").unwrap();
        run_git(path, &["add", "-A"]).await.unwrap();
        run_git(path, &["commit", "-m", "[checkpoint] Turn 0"])
            .await
            .unwrap();
        std::fs::write(dir.path().join("b.txt"), "b").unwrap();
        run_git(path, &["add", "-A"]).await.unwrap();
        run_git(path, &["commit", "-m", "feat: user's real commit"])
            .await
            .unwrap();
        run_git(path, &["checkout", "main"]).await.unwrap();

        // Branch has real commits — should still force-delete.
        branch_delete(path, "ws-branch").await.unwrap();

        // Confirm branch is gone.
        let branches = run_git(path, &["branch", "--list", "ws-branch"])
            .await
            .unwrap();
        assert!(branches.trim().is_empty());
    }

    #[tokio::test]
    async fn test_restore_worktree() {
        let dir = setup_temp_repo().await;
        let repo_path = dir.path().to_str().unwrap();

        // Create a branch via create_worktree, then remove the worktree.
        let wt_dir = tempfile::tempdir().unwrap();
        let wt_path = wt_dir.path().to_str().unwrap();
        create_worktree(repo_path, "claudette/restore-test", wt_path)
            .await
            .unwrap();
        remove_worktree(repo_path, wt_path, true).await.unwrap();

        // Restore the worktree for the existing branch.
        let wt_dir2 = tempfile::tempdir().unwrap();
        let wt_path2 = wt_dir2.path().to_str().unwrap();
        let abs = restore_worktree(repo_path, "claudette/restore-test", wt_path2)
            .await
            .unwrap();
        assert!(!abs.is_empty());

        // The restored worktree should be on the expected branch.
        let branch = current_branch(wt_path2).await.unwrap();
        assert_eq!(branch, "claudette/restore-test");

        // Clean up.
        remove_worktree(repo_path, wt_path2, true).await.unwrap();
    }

    #[tokio::test]
    async fn test_rename_branch() {
        let dir = setup_temp_repo().await;
        let path = dir.path().to_str().unwrap();

        // Create a feature branch.
        run_git(path, &["checkout", "-b", "claudette/old-name"])
            .await
            .unwrap();
        run_git(path, &["checkout", "main"]).await.unwrap();

        rename_branch(path, "claudette/old-name", "claudette/new-name")
            .await
            .unwrap();

        // Old branch should be gone, new branch should exist.
        let branches = list_branches(path).await.unwrap();
        assert!(!branches.contains(&"claudette/old-name".to_string()));
        assert!(branches.contains(&"claudette/new-name".to_string()));
    }

    #[tokio::test]
    async fn test_rename_branch_checked_out_in_worktree() {
        let dir = setup_temp_repo().await;
        let repo_path = dir.path().to_str().unwrap();

        // Create a worktree which checks out the branch.
        let wt_dir = tempfile::tempdir().unwrap();
        let wt_path = wt_dir.path().to_str().unwrap();
        create_worktree(repo_path, "claudette/feature", wt_path)
            .await
            .unwrap();

        // Renaming from the worktree (where the branch is checked out) should work.
        rename_branch(wt_path, "claudette/feature", "claudette/renamed")
            .await
            .unwrap();

        let branches = list_branches(repo_path).await.unwrap();
        assert!(!branches.contains(&"claudette/feature".to_string()));
        assert!(branches.contains(&"claudette/renamed".to_string()));

        // Clean up worktree before temp dirs are dropped.
        remove_worktree(repo_path, wt_path, true).await.unwrap();
    }

    #[tokio::test]
    async fn test_rename_branch_conflict() {
        let dir = setup_temp_repo().await;
        let path = dir.path().to_str().unwrap();

        run_git(path, &["checkout", "-b", "branch-a"])
            .await
            .unwrap();
        run_git(path, &["checkout", "main"]).await.unwrap();
        run_git(path, &["checkout", "-b", "branch-b"])
            .await
            .unwrap();
        run_git(path, &["checkout", "main"]).await.unwrap();

        // Renaming branch-a to branch-b should fail (already exists).
        let result = rename_branch(path, "branch-a", "branch-b").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_fetch_remote_no_remote() {
        // fetch_remote should succeed (best-effort) even with no remote.
        let dir = setup_temp_repo().await;
        let path = dir.path().to_str().unwrap();
        fetch_remote(path).await.unwrap();
    }

    #[tokio::test]
    async fn test_create_worktree_with_remote() {
        // Set up a bare "remote" and a clone that tracks it.
        let remote_dir = tempfile::tempdir().unwrap();
        let remote_path = remote_dir.path().to_str().unwrap();
        run_git(remote_path, &["init", "--bare", "-b", "main"])
            .await
            .unwrap();

        // Clone from bare remote.
        let clone_dir = tempfile::tempdir().unwrap();
        let clone_path = clone_dir.path().to_str().unwrap();
        let output = tokio::process::Command::new("git")
            .args(["clone", remote_path, clone_path])
            .output()
            .await
            .unwrap();
        assert!(output.status.success(), "clone failed");

        // Configure user for clone.
        run_git(clone_path, &["config", "user.email", "test@test.com"])
            .await
            .unwrap();
        run_git(clone_path, &["config", "user.name", "Test"])
            .await
            .unwrap();

        // Push an initial commit.
        let file = clone_dir.path().join("a.txt");
        std::fs::write(&file, "v1").unwrap();
        run_git(clone_path, &["add", "-A"]).await.unwrap();
        run_git(clone_path, &["commit", "-m", "v1"]).await.unwrap();
        run_git(clone_path, &["push", "origin", "main"])
            .await
            .unwrap();

        // Record the clone's current HEAD.
        let clone_head = run_git(clone_path, &["rev-parse", "origin/main"])
            .await
            .unwrap();

        // Push a new commit directly to the bare remote via a temp worktree.
        let pusher = tempfile::tempdir().unwrap();
        let pusher_path = pusher.path().to_str().unwrap();
        let out = tokio::process::Command::new("git")
            .args(["clone", remote_path, pusher_path])
            .output()
            .await
            .unwrap();
        assert!(out.status.success());
        run_git(pusher_path, &["config", "user.email", "test@test.com"])
            .await
            .unwrap();
        run_git(pusher_path, &["config", "user.name", "Test"])
            .await
            .unwrap();
        std::fs::write(pusher.path().join("b.txt"), "v2").unwrap();
        run_git(pusher_path, &["add", "-A"]).await.unwrap();
        run_git(pusher_path, &["commit", "-m", "v2"]).await.unwrap();
        run_git(pusher_path, &["push", "origin", "main"])
            .await
            .unwrap();

        // At this point the clone's origin/main is stale (v1), remote has v2.
        // create_worktree should fetch and branch from the latest commit.
        let wt_dir = tempfile::tempdir().unwrap();
        let wt_path = wt_dir.path().to_str().unwrap();
        create_worktree(clone_path, "test/fresh-branch", wt_path)
            .await
            .unwrap();

        // The worktree's HEAD should be the new v2 commit, not the stale v1.
        let wt_head = run_git(wt_path, &["rev-parse", "HEAD"]).await.unwrap();
        assert_ne!(
            wt_head, clone_head,
            "worktree should be based on the latest remote commit, not the stale one"
        );

        // Clean up.
        remove_worktree(clone_path, wt_path, true).await.unwrap();
    }

    #[tokio::test]
    async fn test_list_worktrees() {
        let dir = setup_temp_repo().await;
        let repo_path = dir.path().to_str().unwrap();

        // Initially just the main worktree.
        let wts = list_worktrees(repo_path).await.unwrap();
        assert_eq!(wts.len(), 1);
        assert_eq!(wts[0].branch.as_deref(), Some("main"));
        assert!(!wts[0].is_bare);

        // Add two linked worktrees.
        let wt1 = tempfile::tempdir().unwrap();
        let wt2 = tempfile::tempdir().unwrap();
        create_worktree(repo_path, "feature-a", wt1.path().to_str().unwrap())
            .await
            .unwrap();
        create_worktree(repo_path, "feature-b", wt2.path().to_str().unwrap())
            .await
            .unwrap();

        let wts = list_worktrees(repo_path).await.unwrap();
        assert_eq!(wts.len(), 3);

        let branches: Vec<_> = wts.iter().filter_map(|w| w.branch.as_deref()).collect();
        assert!(branches.contains(&"main"));
        assert!(branches.contains(&"feature-a"));
        assert!(branches.contains(&"feature-b"));

        // All should have non-empty head SHAs and paths.
        for wt in &wts {
            assert!(!wt.head.is_empty());
            assert!(!wt.path.is_empty());
        }

        // Clean up.
        remove_worktree(repo_path, wt1.path().to_str().unwrap(), true)
            .await
            .unwrap();
        remove_worktree(repo_path, wt2.path().to_str().unwrap(), true)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn test_list_worktrees_bare_repo() {
        let dir = tempfile::tempdir().unwrap();
        let bare_path = dir.path().to_str().unwrap();
        run_git(bare_path, &["init", "--bare", "-b", "main"])
            .await
            .unwrap();

        // Bare repos should return at least the main entry with is_bare=true.
        // Note: bare repos with no commits may have limited output, but should
        // not error.
        let result = list_worktrees(bare_path).await;
        assert!(result.is_ok());
    }
}
