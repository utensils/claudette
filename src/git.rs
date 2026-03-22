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
    // Try symbolic-ref of origin/HEAD first
    if let Ok(remote_head) = run_git(
        repo_path,
        &["symbolic-ref", "refs/remotes/origin/HEAD", "--short"],
    )
    .await
        && let Some(branch) = remote_head.strip_prefix("origin/")
    {
        return Ok(branch.to_string());
    }

    // Fall back to checking if main or master exists
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

pub async fn remove_worktree(repo_path: &str, worktree_path: &str) -> Result<(), GitError> {
    run_git(repo_path, &["worktree", "remove", worktree_path]).await?;
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

/// Safe branch delete — fails if the branch has unmerged commits.
/// Callers should treat failure as non-fatal (the branch is preserved).
pub async fn branch_delete(repo_path: &str, branch: &str) -> Result<(), GitError> {
    run_git(repo_path, &["branch", "-d", branch]).await?;
    Ok(())
}
