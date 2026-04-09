use std::fmt;
use std::path::Path;

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

pub async fn create_worktree(
    repo_path: &str,
    branch_name: &str,
    worktree_path: &str,
) -> Result<String, GitError> {
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
    run_git(repo_path, &["worktree", "add", worktree_path, branch_name]).await?;
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

/// Delete a branch. When `force` is false, uses `-d` which fails if the
/// branch has unmerged commits. When `force` is true, uses `-D` which
/// always succeeds (needed when checkpoint commits exist on the branch).
pub async fn branch_delete(repo_path: &str, branch: &str, force: bool) -> Result<(), GitError> {
    let flag = if force { "-D" } else { "-d" };
    run_git(repo_path, &["branch", flag, branch]).await?;
    Ok(())
}

/// Create a checkpoint commit in a worktree, staging all changes first.
/// If there are no changes to commit, returns the current HEAD hash.
pub async fn create_checkpoint_commit(
    worktree_path: &str,
    message: &str,
) -> Result<String, GitError> {
    // Stage all changes (including untracked files).
    run_git(worktree_path, &["add", "-A"]).await?;

    // Check if there are staged changes.
    let status = run_git(worktree_path, &["status", "--porcelain"]).await?;
    if !status.is_empty() {
        let commit_msg = format!("[checkpoint] {message}");
        run_git(worktree_path, &["commit", "-m", &commit_msg]).await?;
    }

    // Return current HEAD hash regardless.
    run_git(worktree_path, &["rev-parse", "HEAD"]).await
}

/// Hard-reset a worktree to a specific commit and clean untracked files.
pub async fn restore_to_commit(worktree_path: &str, commit_hash: &str) -> Result<(), GitError> {
    run_git(worktree_path, &["reset", "--hard", commit_hash]).await?;
    run_git(worktree_path, &["clean", "-fd"]).await?;
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Create a temporary git repo for testing.
    async fn setup_temp_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_str().unwrap();
        run_git(path, &["init"]).await.unwrap();
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
    async fn test_create_checkpoint_commit_with_changes() {
        let dir = setup_temp_repo().await;
        let path = dir.path().to_str().unwrap();

        // Create a new file.
        std::fs::write(dir.path().join("file.txt"), "hello").unwrap();

        let hash = create_checkpoint_commit(path, "Turn 0").await.unwrap();
        assert!(!hash.is_empty());

        // Verify the commit message.
        let log = run_git(path, &["log", "-1", "--format=%s"]).await.unwrap();
        assert_eq!(log, "[checkpoint] Turn 0");
    }

    #[tokio::test]
    async fn test_create_checkpoint_commit_no_changes() {
        let dir = setup_temp_repo().await;
        let path = dir.path().to_str().unwrap();

        let head_before = run_git(path, &["rev-parse", "HEAD"]).await.unwrap();
        let hash = create_checkpoint_commit(path, "Turn 0").await.unwrap();

        // No new commit should be created — hash should match HEAD.
        assert_eq!(hash, head_before);
    }

    #[tokio::test]
    async fn test_restore_to_commit() {
        let dir = setup_temp_repo().await;
        let path = dir.path().to_str().unwrap();
        let file = dir.path().join("data.txt");

        // First checkpoint.
        std::fs::write(&file, "version 1").unwrap();
        let hash1 = create_checkpoint_commit(path, "Turn 0").await.unwrap();

        // Second checkpoint.
        std::fs::write(&file, "version 2").unwrap();
        let _hash2 = create_checkpoint_commit(path, "Turn 1").await.unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "version 2");

        // Restore to first checkpoint.
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
}
