use std::ffi::OsString;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::process::CommandWindowExt as _;
use serde::Serialize;
use tokio::process::Command;

/// Resolve the `git` binary once and reuse the absolute path for every
/// subsequent call. Caching matters because git is invoked dozens of times
/// per user action (status / log / diff / branch / worktree / etc.) — doing
/// the PATH walk each time would dominate the cost on Windows where the
/// registry-backed PATH lookup is heavier than Unix.
///
/// Kept sync on purpose: the work is a handful of `Path::is_file` probes
/// plus one Windows registry read, all sub-millisecond, so `spawn_blocking`
/// would be more overhead than the operation itself.
///
/// The cache is only populated for absolute paths — a bare `"git"` (our
/// last-resort fallback) is re-evaluated on every call so retrying after
/// the user installs git actually works.
pub fn resolve_git_path_blocking() -> OsString {
    static RESOLVED: OnceLock<OsString> = OnceLock::new();
    if let Some(cached) = RESOLVED.get() {
        return cached.clone();
    }
    // On Unix, `enriched_path()` triggers `login_shell_path_probe()` the
    // first time it runs — that probe spawns `$SHELL -l -c ...` with a
    // 5 s timeout. `resolve_git_path_blocking` is called inline from
    // async code paths (every `run_git`), so we must not pay that cost
    // on a Tokio worker. When the cache is cold we fall back to the
    // process PATH — git is almost always in `/usr/bin` or
    // `/usr/local/bin` (both in process PATH on macOS/Linux), and the
    // well-known fallbacks below cover nix profiles, Homebrew, etc.
    // After the startup prewarm thread completes, subsequent calls hit
    // the enriched path.
    let path = if crate::env::shell_path_is_cached() {
        Some(crate::env::enriched_path())
    } else {
        std::env::var_os("PATH")
    };
    let resolved = resolve_git_path_inner(dirs::home_dir(), path, is_executable_file);
    if Path::new(&resolved).is_absolute() {
        let _ = RESOLVED.set(resolved.clone());
    }
    resolved
}

/// Regular-file + execute-permission check. Without the execute bit a
/// PATH hit can be a package-manager placeholder (pip-installed
/// launcher, empty `git` wrapper script dropped during a broken
/// upgrade, etc.) — caching that path would then make every git-backed
/// feature fail with `PermissionDenied` even though a real executable
/// exists further down PATH. On Windows the underlying FS doesn't
/// expose a POSIX exec bit, so we fall back to `is_file`.
#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.is_file()
        && path
            .metadata()
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

#[cfg(windows)]
fn git_binary_variants() -> &'static [&'static str] {
    &["git.exe", "git.cmd"]
}

#[cfg(not(windows))]
fn git_binary_variants() -> &'static [&'static str] {
    &["git"]
}

#[cfg(windows)]
fn git_bare_name() -> &'static str {
    "git.exe"
}

#[cfg(not(windows))]
fn git_bare_name() -> &'static str {
    "git"
}

/// Well-known git install locations per platform. Checked in order after
/// the PATH-based search misses.
fn git_fallback_paths(home: Option<&Path>) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();

    #[cfg(windows)]
    {
        // Git for Windows system installer (most common on both x64 and
        // ARM64 — the ARM64 installer also drops here).
        out.push(PathBuf::from(r"C:\Program Files\Git\cmd\git.exe"));
        // 32-bit installer on 64-bit Windows — rare today but still seen.
        out.push(PathBuf::from(r"C:\Program Files (x86)\Git\cmd\git.exe"));
        if let Some(home) = home {
            // Git for Windows user-scope installer.
            out.push(
                home.join("AppData")
                    .join("Local")
                    .join("Programs")
                    .join("Git")
                    .join("cmd")
                    .join("git.exe"),
            );
            // Scoop.
            out.push(
                home.join("scoop")
                    .join("apps")
                    .join("git")
                    .join("current")
                    .join("cmd")
                    .join("git.exe"),
            );
        }
        // Chocolatey — default install location.
        out.push(PathBuf::from(r"C:\ProgramData\chocolatey\bin\git.exe"));
    }

    #[cfg(not(windows))]
    {
        if let Some(home) = home {
            out.push(home.join(".nix-profile/bin/git"));
        }
        out.push(PathBuf::from("/usr/local/bin/git"));
        out.push(PathBuf::from("/opt/homebrew/bin/git")); // macOS Homebrew
        out.push(PathBuf::from("/usr/bin/git"));
        out.push(PathBuf::from("/run/current-system/sw/bin/git"));
        out.push(PathBuf::from("/nix/var/nix/profiles/default/bin/git"));
    }

    out
}

/// Pure resolution logic — identical shape to `resolve_claude_path_inner`.
/// 1. PATH search (enriched PATH passed by caller — registry on Windows,
///    login-shell + process PATH on Unix).
/// 2. Well-known install locations.
/// 3. Bare `git` / `git.exe` as the last-resort fallback.
fn resolve_git_path_inner(
    home: Option<PathBuf>,
    process_path: Option<OsString>,
    exists: impl Fn(&Path) -> bool,
) -> OsString {
    if let Some(process_path) = process_path {
        for dir in std::env::split_paths(&process_path) {
            if !dir.is_absolute() {
                continue;
            }
            for name in git_binary_variants() {
                let candidate = dir.join(name);
                if exists(&candidate) {
                    return candidate.into_os_string();
                }
            }
        }
    }
    for p in git_fallback_paths(home.as_deref()) {
        if exists(&p) {
            return p.into_os_string();
        }
    }
    OsString::from(git_bare_name())
}

#[derive(Debug, Clone)]
pub enum GitError {
    NotAGitRepo,
    CommandFailed(String),
    /// The `git` executable could not be located on PATH. The `Display` form
    /// uses the shared [`crate::missing_cli::format_err`] sentinel so Tauri
    /// wrappers can detect it via [`crate::missing_cli::parse_err`].
    CliNotFound,
}

impl GitError {
    /// Map an `io::Error` from a git-subprocess spawn/output call, preserving
    /// the `NotFound` signal as [`GitError::CliNotFound`] instead of folding
    /// it into a generic `CommandFailed` string.
    pub fn from_spawn_io(err: std::io::Error) -> Self {
        if crate::missing_cli::is_not_found(&err) {
            Self::CliNotFound
        } else {
            Self::CommandFailed(err.to_string())
        }
    }
}

impl fmt::Display for GitError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotAGitRepo => write!(f, "Not a git repository"),
            Self::CommandFailed(msg) => write!(f, "Git command failed: {msg}"),
            Self::CliNotFound => write!(f, "{}", crate::missing_cli::format_err("git")),
        }
    }
}

impl std::error::Error for GitError {}

async fn run_git(repo_path: &str, args: &[&str]) -> Result<String, GitError> {
    let output = Command::new(crate::git::resolve_git_path_blocking())
        .no_console_window()
        .args(["-C", repo_path])
        .args(args)
        .output()
        .await
        .map_err(GitError::from_spawn_io)?;

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
    let output = Command::new(crate::git::resolve_git_path_blocking())
        .no_console_window()
        .args(["config", "--global", "user.name"])
        .output()
        .await
        .map_err(GitError::from_spawn_io)?;

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

/// Resolve the default branch for a repository.
///
/// Tries, in order: remote HEAD symbolic-ref, remote-tracking `main`/`master`,
/// local `main`/`master`, and finally `symbolic-ref HEAD` (the currently
/// checked-out branch). The last fallback is a best-effort guess for local-only
/// repos with non-standard branch names — it may not reflect the true default
/// if HEAD has been moved to a feature branch.
pub async fn default_branch(
    repo_path: &str,
    remote_override: Option<&str>,
) -> Result<String, GitError> {
    let remote = match remote_override {
        Some(r) => r.to_string(),
        None => run_git(repo_path, &["remote"])
            .await
            .ok()
            .and_then(|out| out.lines().next().map(|l| l.to_string()))
            .unwrap_or_else(|| "origin".to_string()),
    };

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

    // Ultimate fallback: use the current branch (best guess for local repos
    // with non-standard branch names like "trunk" or "develop").
    if let Ok(current) = run_git(repo_path, &["symbolic-ref", "HEAD", "--short"]).await {
        return Ok(current);
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
pub async fn fetch_remote(repo_path: &str, remote_override: Option<&str>) -> Result<(), GitError> {
    let remote = match remote_override {
        Some(r) => r.to_string(),
        None => match run_git(repo_path, &["remote"]).await {
            Ok(output) => match output.lines().next() {
                Some(r) => r.to_string(),
                None => return Ok(()),
            },
            Err(e) => {
                eprintln!("[git] failed to list remotes: {e}");
                return Ok(());
            }
        },
    };

    // Spawn with kill_on_drop so the child is terminated if the timeout fires.
    let mut child = match Command::new(crate::git::resolve_git_path_blocking())
        .no_console_window()
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
    base_branch_override: Option<&str>,
    remote_override: Option<&str>,
) -> Result<String, GitError> {
    let base_branch_remote = base_branch_override
        .and_then(|b| b.split_once('/'))
        .map(|(r, _)| r.to_string());
    let effective_remote = remote_override
        .map(|r| r.to_string())
        .or_else(|| base_branch_remote.clone());

    let _ = fetch_remote(repo_path, effective_remote.as_deref()).await;
    if base_branch_remote.as_deref() != effective_remote.as_deref() {
        let _ = fetch_remote(repo_path, base_branch_remote.as_deref()).await;
    }
    let base = match base_branch_override {
        Some(b) => b.to_string(),
        None => default_branch(repo_path, effective_remote.as_deref()).await?,
    };

    // Verify the base ref points to a real commit (symbolic-ref HEAD returns
    // a branch name even on unborn branches with zero commits).
    if run_git(repo_path, &["rev-parse", "--verify", &base])
        .await
        .is_err()
    {
        return Err(GitError::CommandFailed(
            "Repository has no commits — create at least one commit before creating a workspace"
                .into(),
        ));
    }

    run_git(
        repo_path,
        &["worktree", "add", "-b", branch_name, worktree_path, &base],
    )
    .await?;

    canonicalize_worktree_path(worktree_path)
}

/// Create a worktree + new branch rooted at an explicit git ref (commit hash,
/// tag, or branch name). Unlike [`create_worktree`], this does NOT fetch or
/// resolve the default branch — the caller supplies the exact base ref.
///
/// Used by workspace forking to anchor a new worktree to a checkpoint's commit.
pub async fn create_worktree_from_ref(
    repo_path: &str,
    branch_name: &str,
    worktree_path: &str,
    base_ref: &str,
) -> Result<String, GitError> {
    run_git(
        repo_path,
        &[
            "worktree",
            "add",
            "-b",
            branch_name,
            worktree_path,
            base_ref,
        ],
    )
    .await?;

    canonicalize_worktree_path(worktree_path)
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
    canonicalize_worktree_path(worktree_path)
}

/// Canonicalize a freshly-created worktree path and strip Windows verbatim
/// `\\?\` prefixes so the result is a plain drive-letter path. The stored
/// path is later passed to shells as a CWD; `cmd.exe` refuses verbatim
/// paths, so we must normalize at the source.
fn canonicalize_worktree_path(worktree_path: &str) -> Result<String, GitError> {
    let abs_path = std::path::Path::new(worktree_path)
        .canonicalize()
        .map_err(|e| GitError::CommandFailed(e.to_string()))?;
    Ok(crate::path::strip_verbatim_prefix(&abs_path.to_string_lossy()).to_string())
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

/// Get the remote URL for a repository. When `remote_override` is provided,
/// uses that remote name; otherwise falls back to the first configured remote.
pub async fn get_remote_url(
    repo_path: &str,
    remote_override: Option<&str>,
) -> Result<String, GitError> {
    let remote = match remote_override {
        Some(r) => r.to_string(),
        None => {
            let output = run_git(repo_path, &["remote"]).await?;
            output
                .lines()
                .next()
                .map(|l| l.to_string())
                .ok_or_else(|| GitError::CommandFailed("No remote configured".into()))?
        }
    };

    run_git(repo_path, &["remote", "get-url", &remote]).await
}

/// List all configured remotes for a repository.
pub async fn list_remotes(repo_path: &str) -> Result<Vec<String>, GitError> {
    let output = run_git(repo_path, &["remote"]).await?;
    Ok(output.lines().map(|l| l.to_string()).collect())
}

/// List all remote-tracking branches (e.g. "origin/main", "upstream/develop").
pub async fn list_remote_tracking_branches(repo_path: &str) -> Result<Vec<String>, GitError> {
    let output = run_git(repo_path, &["branch", "-r", "--format=%(refname:short)"]).await?;
    Ok(output
        .lines()
        .filter(|l| !l.ends_with("/HEAD"))
        .map(|l| l.to_string())
        .collect())
}

/// Resolve HEAD to a commit hash for a worktree or repository. Works even in
/// detached HEAD state — unlike [`current_branch`] which only returns branch
/// names.
pub async fn head_commit(repo_path: &str) -> Result<String, GitError> {
    run_git(repo_path, &["rev-parse", "HEAD"]).await
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

/// A commit observed in a worktree, with line-change stats.
///
/// `committed_at` is the committer date in RFC3339 form (from `%cI`).
/// Parsed from `git log --pretty=format:"%H|%cI" --numstat`.
#[derive(Debug, Clone)]
pub struct CommitInfo {
    pub hash: String,
    pub committed_at: String,
    pub additions: i64,
    pub deletions: i64,
    pub files_changed: i64,
}

/// Returns `since` with an explicit UTC marker appended if it lacks one,
/// so `git log --since` doesn't fall back to local-time interpretation.
/// Recognizes trailing `Z`/`z` and `±HH:MM` / `±HHMM` offsets.
fn ensure_utc_tz(since: &str) -> String {
    let s = since.trim();
    if s.ends_with('Z') || s.ends_with('z') {
        return s.to_string();
    }
    let b = s.as_bytes();
    let has_colon_offset = b.len() >= 6 && {
        let t = &b[b.len() - 6..];
        (t[0] == b'+' || t[0] == b'-')
            && t[1].is_ascii_digit()
            && t[2].is_ascii_digit()
            && t[3] == b':'
            && t[4].is_ascii_digit()
            && t[5].is_ascii_digit()
    };
    let has_compact_offset = b.len() >= 5 && {
        let t = &b[b.len() - 5..];
        (t[0] == b'+' || t[0] == b'-') && t[1..].iter().all(|c| c.is_ascii_digit())
    };
    if has_colon_offset || has_compact_offset {
        s.to_string()
    } else {
        format!("{s} UTC")
    }
}

/// List commits in a worktree whose committer date is after `since`, with
/// per-commit aggregated additions/deletions/files_changed from numstat.
///
/// `since` is passed to `git log --since` and accepts any format git's
/// approxidate understands — RFC3339, ISO-8601, or SQLite's
/// `datetime('now')` output (`YYYY-MM-DD HH:MM:SS` UTC). Naive strings
/// (no `Z` or `±HH:MM` offset) are assumed UTC, since that matches how
/// SQLite stores timestamps; git's default interpretation would be local
/// time, which silently shifts the window.
///
/// Used for post-turn metric scraping in the agent lifecycle. Committer
/// date (not author date) is used so commits that were cherry-picked or
/// rebased into the worktree during the session are attributed to the
/// session that landed them, not the one that originally wrote them.
/// Binary files (numstat emits "-\t-\t") contribute 0 additions/deletions
/// but still count toward `files_changed`.
pub async fn commits_since(worktree_path: &str, since: &str) -> Result<Vec<CommitInfo>, GitError> {
    let since_utc = ensure_utc_tz(since);
    let raw = run_git(
        worktree_path,
        &[
            "log",
            &format!("--since={since_utc}"),
            "--pretty=format:COMMIT|%H|%cI",
            "--numstat",
        ],
    )
    .await?;

    let mut commits: Vec<CommitInfo> = Vec::new();
    let mut current: Option<CommitInfo> = None;

    for line in raw.lines() {
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("COMMIT|") {
            if let Some(c) = current.take() {
                commits.push(c);
            }
            let mut parts = rest.splitn(2, '|');
            let hash = parts.next().unwrap_or_default().to_string();
            let committed_at = parts.next().unwrap_or_default().to_string();
            current = Some(CommitInfo {
                hash,
                committed_at,
                additions: 0,
                deletions: 0,
                files_changed: 0,
            });
        } else if let Some(c) = current.as_mut() {
            // numstat line: "<added>\t<deleted>\t<path>", binary files use "-".
            let mut cols = line.split('\t');
            let adds = cols.next().unwrap_or("0");
            let dels = cols.next().unwrap_or("0");
            c.additions += adds.parse::<i64>().unwrap_or(0);
            c.deletions += dels.parse::<i64>().unwrap_or(0);
            c.files_changed += 1;
        }
    }
    if let Some(c) = current {
        commits.push(c);
    }
    Ok(commits)
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
        create_worktree(repo_path, "claudette/restore-test", wt_path, None, None)
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
        create_worktree(repo_path, "claudette/feature", wt_path, None, None)
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
        fetch_remote(path, None).await.unwrap();
    }

    #[tokio::test]
    async fn test_create_worktree_empty_repo() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_str().unwrap();
        run_git(path, &["init", "-b", "main"]).await.unwrap();

        let wt = dir.path().join("worktree");
        let err = create_worktree(path, "test-branch", wt.to_str().unwrap(), None, None)
            .await
            .unwrap_err();
        assert!(
            err.to_string().contains("no commits"),
            "expected 'no commits' error, got: {err}"
        );
    }

    #[tokio::test]
    async fn test_default_branch_nonstandard_local_branch() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_str().unwrap();
        run_git(path, &["init", "-b", "trunk"]).await.unwrap();
        run_git(path, &["config", "user.email", "test@test.com"])
            .await
            .unwrap();
        run_git(path, &["config", "user.name", "Test"])
            .await
            .unwrap();
        let readme = dir.path().join("README.md");
        std::fs::write(&readme, "# test").unwrap();
        run_git(path, &["add", "-A"]).await.unwrap();
        run_git(path, &["commit", "-m", "initial"]).await.unwrap();

        let branch = default_branch(path, None).await.unwrap();
        assert_eq!(branch, "trunk");
    }

    #[tokio::test]
    async fn test_get_remote_url_no_remote() {
        let dir = setup_temp_repo().await;
        let path = dir.path().to_str().unwrap();
        let err = get_remote_url(path, None).await.unwrap_err();
        assert!(
            err.to_string().contains("No remote configured"),
            "expected 'No remote configured', got: {err}"
        );
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
        let output = tokio::process::Command::new(crate::git::resolve_git_path_blocking())
            .no_console_window()
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
        let out = tokio::process::Command::new(crate::git::resolve_git_path_blocking())
            .no_console_window()
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
        create_worktree(clone_path, "test/fresh-branch", wt_path, None, None)
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
        create_worktree(
            repo_path,
            "feature-a",
            wt1.path().to_str().unwrap(),
            None,
            None,
        )
        .await
        .unwrap();
        create_worktree(
            repo_path,
            "feature-b",
            wt2.path().to_str().unwrap(),
            None,
            None,
        )
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
    async fn test_create_worktree_from_ref_anchors_to_commit() {
        let dir = setup_temp_repo().await;
        let repo_path = dir.path().to_str().unwrap();
        let file = dir.path().join("data.txt");

        // Commit v1 and capture hash.
        std::fs::write(&file, "v1").unwrap();
        run_git(repo_path, &["add", "-A"]).await.unwrap();
        run_git(repo_path, &["commit", "-m", "v1"]).await.unwrap();
        let hash1 = run_git(repo_path, &["rev-parse", "HEAD"]).await.unwrap();

        // Commit v2 on main.
        std::fs::write(&file, "v2").unwrap();
        run_git(repo_path, &["add", "-A"]).await.unwrap();
        run_git(repo_path, &["commit", "-m", "v2"]).await.unwrap();

        // Fork from the v1 commit — worktree should see "v1" not "v2".
        let fork_dir = tempfile::tempdir().unwrap();
        let fork_path = fork_dir.path().to_str().unwrap();
        let out = create_worktree_from_ref(repo_path, "forked", fork_path, &hash1)
            .await
            .unwrap();
        assert!(!out.is_empty());

        let forked_file = fork_dir.path().join("data.txt");
        assert_eq!(std::fs::read_to_string(&forked_file).unwrap(), "v1");

        let forked_head = run_git(fork_path, &["rev-parse", "HEAD"]).await.unwrap();
        assert_eq!(forked_head, hash1);

        remove_worktree(repo_path, fork_path, true).await.unwrap();
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

    #[tokio::test]
    async fn test_commits_since_captures_new_commits_with_numstat() {
        let dir = setup_temp_repo().await;
        let path = dir.path().to_str().unwrap();

        // Note the time BEFORE making new commits.
        let since = run_git(path, &["log", "-1", "--pretty=format:%aI"])
            .await
            .unwrap();

        // Two new commits: one adds lines, one deletes.
        let f1 = dir.path().join("a.txt");
        std::fs::write(&f1, "one\ntwo\nthree\n").unwrap();
        run_git(path, &["add", "-A"]).await.unwrap();
        run_git(path, &["commit", "-m", "add a.txt"]).await.unwrap();

        std::fs::write(&f1, "one\n").unwrap();
        run_git(path, &["add", "-A"]).await.unwrap();
        run_git(path, &["commit", "-m", "shrink a.txt"])
            .await
            .unwrap();

        let commits = commits_since(path, &since).await.unwrap();
        // --since is inclusive by timestamp, so the initial commit might or
        // might not appear depending on second resolution. Assert we got at
        // least the two new ones with numstat populated.
        assert!(commits.len() >= 2);
        let total_adds: i64 = commits.iter().map(|c| c.additions).sum();
        let total_dels: i64 = commits.iter().map(|c| c.deletions).sum();
        assert!(total_adds >= 3, "expected >=3 additions, got {total_adds}");
        assert!(total_dels >= 2, "expected >=2 deletions, got {total_dels}");
        for c in &commits {
            assert!(!c.hash.is_empty());
            assert!(!c.committed_at.is_empty());
        }
    }

    #[tokio::test]
    async fn test_commits_since_empty_when_nothing_new() {
        let dir = setup_temp_repo().await;
        let path = dir.path().to_str().unwrap();
        // Use a future timestamp so no commits qualify.
        let commits = commits_since(path, "2099-01-01T00:00:00Z").await.unwrap();
        assert!(commits.is_empty());
    }

    #[tokio::test]
    async fn test_commits_since_handles_binary_files() {
        let dir = setup_temp_repo().await;
        let path = dir.path().to_str().unwrap();

        let since = run_git(path, &["log", "-1", "--pretty=format:%aI"])
            .await
            .unwrap();

        // Commit a binary file (contains null bytes) — git --numstat emits
        // "-\t-\t<path>" for these, which must parse as 0 adds / 0 dels but
        // still bump files_changed.
        let bin = dir.path().join("data.bin");
        std::fs::write(&bin, [0u8, 1, 2, 3, 0, 5, 6, 0, 255]).unwrap();
        run_git(path, &["add", "-A"]).await.unwrap();
        run_git(path, &["commit", "-m", "add binary"])
            .await
            .unwrap();
        let bin_hash = run_git(path, &["rev-parse", "HEAD"]).await.unwrap();

        let commits = commits_since(path, &since).await.unwrap();
        let bin_commit = commits
            .iter()
            .find(|c| c.hash == bin_hash)
            .expect("binary commit should appear in results");
        assert_eq!(bin_commit.additions, 0, "binary file adds must be 0");
        assert_eq!(bin_commit.deletions, 0, "binary file dels must be 0");
        assert_eq!(
            bin_commit.files_changed, 1,
            "binary file must still count toward files_changed"
        );
    }

    #[test]
    fn test_ensure_utc_tz() {
        // Already-qualified strings pass through unchanged.
        assert_eq!(
            ensure_utc_tz("2026-04-18T03:36:10Z"),
            "2026-04-18T03:36:10Z"
        );
        assert_eq!(
            ensure_utc_tz("2026-04-18T03:36:10+00:00"),
            "2026-04-18T03:36:10+00:00"
        );
        assert_eq!(
            ensure_utc_tz("2026-04-17T23:36:10-04:00"),
            "2026-04-17T23:36:10-04:00"
        );
        assert_eq!(
            ensure_utc_tz("2026-04-18T03:36:10+0000"),
            "2026-04-18T03:36:10+0000"
        );
        // Naive SQLite format gets a UTC suffix.
        assert_eq!(
            ensure_utc_tz("2026-04-18 03:36:10"),
            "2026-04-18 03:36:10 UTC"
        );
        assert_eq!(
            ensure_utc_tz("2026-04-18T03:36:10"),
            "2026-04-18T03:36:10 UTC"
        );
    }

    // -----------------------------------------------------------------------
    // resolve_git_path_inner tests
    // -----------------------------------------------------------------------

    /// Happy path on Unix: process PATH hit wins before any fallback is
    /// consulted.
    #[cfg(unix)]
    #[test]
    fn test_resolve_git_process_path_wins_unix() {
        let result = resolve_git_path_inner(
            Some(PathBuf::from("/home/user")),
            Some(OsString::from("/usr/bin:/usr/local/bin")),
            |p| p == Path::new("/usr/bin/git"),
        );
        assert_eq!(result, OsString::from("/usr/bin/git"));
    }

    /// Fallback to a well-known system location when PATH misses.
    #[cfg(unix)]
    #[test]
    fn test_resolve_git_falls_back_system_unix() {
        let result = resolve_git_path_inner(None, None, |p| p == Path::new("/usr/local/bin/git"));
        assert_eq!(result, OsString::from("/usr/local/bin/git"));
    }

    /// Last resort: nothing exists anywhere — we return the bare name so
    /// the caller can surface a legible "git not installed" error instead
    /// of a phantom absolute path.
    #[cfg(unix)]
    #[test]
    fn test_resolve_git_falls_back_bare_name_unix() {
        let result = resolve_git_path_inner(None, None, |_| false);
        assert_eq!(result, OsString::from("git"));
    }

    /// On Windows, Git for Windows is by far the most likely install; its
    /// default location is `C:\Program Files\Git\cmd\git.exe` regardless
    /// of whether the user ran the x64 or ARM64 installer.
    #[cfg(windows)]
    #[test]
    fn test_resolve_git_falls_back_program_files_windows() {
        let expected = Path::new(r"C:\Program Files\Git\cmd\git.exe");
        let result = resolve_git_path_inner(None, None, |p| p == expected);
        assert_eq!(result, expected.as_os_str().to_os_string());
    }

    /// Scoop installs git under `%USERPROFILE%\scoop\apps\git\current\cmd`.
    /// Users who prefer Scoop shouldn't have to install Git for Windows
    /// just to use claudette.
    #[cfg(windows)]
    #[test]
    fn test_resolve_git_falls_back_scoop_windows() {
        let home = PathBuf::from(r"C:\Users\user");
        let expected = home.join(r"scoop\apps\git\current\cmd\git.exe");
        let expected_clone = expected.clone();
        let result = resolve_git_path_inner(Some(home), None, move |p| p == expected_clone);
        assert_eq!(result, expected.into_os_string());
    }

    /// Last-resort on Windows must be `git.exe`, not `git` — a bare `"git"`
    /// handed to `CreateProcessW` without PATHEXT completion would fail.
    #[cfg(windows)]
    #[test]
    fn test_resolve_git_bare_name_is_exe_on_windows() {
        let result = resolve_git_path_inner(None, None, |_| false);
        assert_eq!(result, OsString::from("git.exe"));
    }

    // -----------------------------------------------------------------------
    // Executable-bit check on Unix
    //
    // Regression guard: `is_executable_file` must reject regular files that
    // lack the execute bit. Without this, a non-exec placeholder earlier on
    // PATH (empty script left behind by a broken package upgrade, a build
    // artefact like `/target/git/Cargo.toml`, etc.) would beat the real
    // binary and poison the `OnceLock` cache — every subsequent git call
    // would then fail with `PermissionDenied`.
    // -----------------------------------------------------------------------

    #[cfg(unix)]
    #[test]
    fn is_executable_file_rejects_non_exec_file() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let placeholder = dir.path().join("git");
        std::fs::write(&placeholder, b"").unwrap();
        // Readable/writable but not executable — the exact shape of a
        // "leftover wrapper" file.
        std::fs::set_permissions(&placeholder, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(
            !is_executable_file(&placeholder),
            "non-exec regular file must be rejected",
        );
    }

    #[cfg(unix)]
    #[test]
    fn is_executable_file_accepts_exec_file() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("git");
        std::fs::write(&real, b"#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(
            is_executable_file(&real),
            "regular file with exec bit set must be accepted",
        );
    }

    /// End-to-end guard: with the production `is_executable_file` predicate
    /// wired in, a non-exec placeholder earlier in PATH must be skipped in
    /// favour of a real binary later in PATH. Before the executability
    /// check, `resolve_git_path_inner` returned the placeholder because
    /// `Path::is_file` was true, which is exactly the caching hazard we
    /// are guarding against.
    #[cfg(unix)]
    #[test]
    fn resolve_git_skips_non_executable_placeholder() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();

        let broken_dir = dir.path().join("broken");
        let real_dir = dir.path().join("real");
        std::fs::create_dir(&broken_dir).unwrap();
        std::fs::create_dir(&real_dir).unwrap();

        // Non-exec placeholder — what a corrupted install leaves behind.
        let broken = broken_dir.join("git");
        std::fs::write(&broken, b"").unwrap();
        std::fs::set_permissions(&broken, std::fs::Permissions::from_mode(0o644)).unwrap();

        // Real executable further down PATH.
        let real = real_dir.join("git");
        std::fs::write(&real, b"#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o755)).unwrap();

        let path = std::env::join_paths([&broken_dir, &real_dir]).unwrap();
        let resolved = resolve_git_path_inner(None, Some(path), is_executable_file);
        assert_eq!(
            resolved,
            real.into_os_string(),
            "resolver must skip the non-exec placeholder and pick the real binary",
        );
    }
}
