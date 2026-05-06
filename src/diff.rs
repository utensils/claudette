use std::collections::{HashMap, HashSet};
use std::fmt;
use std::path::Path;

use crate::process::CommandWindowExt as _;
use tokio::process::Command;

use crate::model::diff::{
    CommitEntry, DiffFile, DiffHunk, DiffLine, DiffLineType, FileDiff, FileStatus, GitFileLayer,
    GitStatusEntry, StagedDiffFiles,
};

#[derive(Debug, Clone)]
pub enum DiffError {
    CommandFailed(String),
}

impl fmt::Display for DiffError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::CommandFailed(msg) => write!(f, "Diff operation failed: {msg}"),
        }
    }
}

impl std::error::Error for DiffError {}

/// Validate that a file path is safe for diff operations: no path traversal,
/// no absolute paths, and no null bytes.
fn validate_file_path(file_path: &str) -> Result<(), DiffError> {
    if file_path.contains('\0') {
        return Err(DiffError::CommandFailed(
            "Invalid file path: contains null byte".into(),
        ));
    }
    // Reject platform-absolute paths AND Unix-style rooted paths on any
    // platform. `Path::is_absolute` on Windows considers only
    // drive-letter and UNC forms absolute — so `/etc/passwd` would pass
    // through `is_absolute()` as `false` on a Windows build, defeating
    // the path-traversal guard. Checking the leading byte directly
    // closes that gap regardless of host OS.
    let first_byte = file_path.as_bytes().first().copied();
    if Path::new(file_path).is_absolute() || first_byte == Some(b'/') || first_byte == Some(b'\\') {
        return Err(DiffError::CommandFailed(
            "Invalid file path: absolute paths are not allowed".into(),
        ));
    }
    if file_path.split(['/', '\\']).any(|c| c == "..") {
        return Err(DiffError::CommandFailed(
            "Invalid file path: path traversal is not allowed".into(),
        ));
    }
    Ok(())
}

async fn run_git(path: &str, args: &[&str]) -> Result<String, DiffError> {
    let output = Command::new(crate::git::resolve_git_path_blocking())
        .no_console_window()
        .args(["-C", path])
        .args(args)
        .output()
        .await
        .map_err(|e| DiffError::CommandFailed(e.to_string()))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(DiffError::CommandFailed(stderr))
    }
}

/// Get the merge base between two refs.
pub async fn merge_base(repo_path: &str, branch: &str, base: &str) -> Result<String, DiffError> {
    run_git(repo_path, &["merge-base", "--", base, branch]).await
}

/// Owned inputs extracted from the DB for [`resolve_workspace_merge_base`].
///
/// Returned by the synchronous extraction step so the `&Database` reference is
/// fully dropped before any `.await` — necessary because
/// `rusqlite::Connection` is not `Sync`, so `&Database` is not `Send`, and
/// Tauri requires command futures to be `Send`.
struct WorkspaceMergeBaseInputs {
    worktree_path: String,
    repo_path: String,
    base_branch: Option<String>,
    default_remote: Option<String>,
}

/// Resolve the workspace's merge-base SHA against its repository's base branch.
///
/// Returns `(merge_base_sha, worktree_path)` so callers that need the worktree
/// path (e.g. `load_diff_files`) don't need a second `list_workspaces` call.
///
/// Encapsulates the workspace + repository lookups and the base-branch
/// resolution (preferring `repo.base_branch`, falling back to
/// `git::default_branch`). Used by both the Changes panel's `load_diff_files`
/// command and the file viewer's lightweight `compute_workspace_merge_base`
/// command — keeping a single source of truth means the gutter and diff
/// viewer can never disagree about which SHA "the merge base" is.
///
/// # Send-safety
///
/// This function is intentionally **not** `async`. It performs the
/// synchronous DB extraction first, then returns a `Future` that owns only the
/// extracted data — so `&Database` is never held across an `.await` point.
/// This is required because `rusqlite::Connection` is not `Sync` (it contains
/// `RefCell`), which means `&Database` is not `Send`, and Tauri command futures
/// must be `Send`.
pub fn resolve_workspace_merge_base(
    db: &crate::db::Database,
    workspace_id: &str,
) -> impl std::future::Future<Output = Result<(String, String), String>> + Send {
    // Perform all synchronous DB work here, before the async block.
    // After this point the &Database reference is no longer needed.
    let inputs_result: Result<WorkspaceMergeBaseInputs, String> = (|| {
        let workspaces = db.list_workspaces().map_err(|e| e.to_string())?;
        let ws = workspaces
            .iter()
            .find(|w| w.id == workspace_id)
            .ok_or_else(|| "Workspace not found".to_string())?;
        let worktree_path = ws
            .worktree_path
            .as_ref()
            .ok_or_else(|| "Workspace has no worktree".to_string())?
            .clone();

        let repos = db.list_repositories().map_err(|e| e.to_string())?;
        let repo = repos
            .iter()
            .find(|r| r.id == ws.repository_id)
            .ok_or_else(|| "Repository not found".to_string())?;

        Ok(WorkspaceMergeBaseInputs {
            worktree_path,
            repo_path: repo.path.clone(),
            base_branch: repo.base_branch.clone(),
            default_remote: repo.default_remote.clone(),
        })
    })();

    // The returned async block owns only `inputs_result` (no &Database).
    async move {
        let inputs = inputs_result?;

        let base_branch = match inputs.base_branch {
            Some(b) => b,
            None => crate::git::default_branch(&inputs.repo_path, inputs.default_remote.as_deref())
                .await
                .map_err(|e| e.to_string())?,
        };

        let sha = merge_base(&inputs.worktree_path, "HEAD", &base_branch)
            .await
            .map_err(|e| e.to_string())?;

        Ok((sha, inputs.worktree_path))
    }
}

/// List all changed files between merge base and current working tree.
pub async fn changed_files(
    worktree_path: &str,
    merge_base: &str,
) -> Result<Vec<DiffFile>, DiffError> {
    let mut files =
        parse_name_status(&run_git(worktree_path, &["diff", "--name-status", merge_base]).await?);

    // Untracked files
    let untracked = parse_untracked(
        &run_git(
            worktree_path,
            &["ls-files", "--others", "--exclude-standard"],
        )
        .await?,
    );
    files.extend(untracked);

    apply_numstat(
        &mut files,
        &run_git(worktree_path, &["diff", "--numstat", merge_base]).await?,
    );
    sort_diff_files(&mut files);

    Ok(files)
}

/// List changed files grouped by git stage (committed, staged, unstaged, untracked).
pub async fn staged_changed_files(
    worktree_path: &str,
    merge_base: &str,
) -> Result<StagedDiffFiles, DiffError> {
    let range = format!("{merge_base}..HEAD");

    // Build arg arrays before the join so borrows live long enough
    let committed_ns_args = ["diff", "--name-status", &range];
    let committed_num_args = ["diff", "--numstat", &range];

    // Run all git commands concurrently
    let (
        committed_ns,
        committed_num,
        staged_ns,
        staged_num,
        unstaged_ns,
        unstaged_num,
        untracked_out,
    ) = tokio::join!(
        run_git(worktree_path, &committed_ns_args),
        run_git(worktree_path, &committed_num_args),
        run_git(worktree_path, &["diff", "--cached", "--name-status"]),
        run_git(worktree_path, &["diff", "--cached", "--numstat"]),
        run_git(worktree_path, &["diff", "--name-status"]),
        run_git(worktree_path, &["diff", "--numstat"]),
        run_git(
            worktree_path,
            &["ls-files", "--others", "--exclude-standard"],
        ),
    );

    let committed_ns = committed_ns?;
    let committed_num = committed_num?;
    let staged_ns = staged_ns?;
    let staged_num = staged_num?;
    let unstaged_ns = unstaged_ns?;
    let unstaged_num = unstaged_num?;
    let untracked_out = untracked_out?;

    let mut committed = parse_name_status(&committed_ns);
    apply_numstat(&mut committed, &committed_num);
    sort_diff_files(&mut committed);

    let mut staged = parse_name_status(&staged_ns);
    apply_numstat(&mut staged, &staged_num);
    sort_diff_files(&mut staged);

    let mut unstaged = parse_name_status(&unstaged_ns);
    apply_numstat(&mut unstaged, &unstaged_num);
    sort_diff_files(&mut unstaged);

    let mut untracked = parse_untracked(&untracked_out);
    sort_diff_files(&mut untracked);

    Ok(StagedDiffFiles {
        committed,
        staged,
        unstaged,
        untracked,
    })
}

/// Return current index/worktree git status, suitable for annotating a file tree.
///
/// This intentionally mirrors `git status` rather than the Changes tab's
/// branch-vs-merge-base view: staged changes, unstaged changes, and untracked
/// files only. Paths are repository-relative and keyed by their current path.
pub async fn file_tree_git_status(
    worktree_path: &str,
) -> Result<HashMap<String, GitStatusEntry>, DiffError> {
    let output = run_git(worktree_path, &["status", "--porcelain=v2", "-uall", "-z"]).await?;
    let mut parsed = parse_file_tree_git_status(&output, worktree_path);
    suppress_unstaged_rename_deletion_ghosts(
        worktree_path,
        &mut parsed.statuses,
        &parsed.unstaged_deleted_head_oids,
        &parsed.untracked_paths,
    )
    .await;
    Ok(parsed.statuses)
}

struct FileTreeStatusParse {
    statuses: HashMap<String, GitStatusEntry>,
    unstaged_deleted_head_oids: HashMap<String, String>,
    untracked_paths: Vec<String>,
}

fn parse_file_tree_git_status(output: &str, worktree_path: &str) -> FileTreeStatusParse {
    let mut statuses = HashMap::new();
    let mut unstaged_deleted_head_oids = HashMap::new();
    let mut untracked_paths = Vec::new();
    let mut records = output.split('\0');

    while let Some(record) = records.next() {
        if record.is_empty() {
            continue;
        }

        if let Some(path) = record.strip_prefix("? ") {
            untracked_paths.push(path.to_string());
            statuses.insert(
                path.to_string(),
                GitStatusEntry {
                    status: FileStatus::Added,
                    layer: GitFileLayer::Untracked,
                },
            );
            continue;
        }

        let Some(kind) = record.as_bytes().first().copied() else {
            continue;
        };
        match kind {
            b'1' => {
                let mut fields = record.splitn(9, ' ');
                let _kind = fields.next();
                let Some(xy) = fields.next() else {
                    continue;
                };
                let _sub = fields.next();
                let _mode_head = fields.next();
                let _mode_index = fields.next();
                let _mode_worktree = fields.next();
                let head_oid = fields.next();
                let _index_oid = fields.next();
                let Some(path) = fields.next() else {
                    continue;
                };
                let status = status_from_xy(xy, path, None, worktree_path);
                let layer = layer_from_xy(xy);
                if status == FileStatus::Deleted && layer == GitFileLayer::Unstaged {
                    if let Some(head_oid) = head_oid {
                        unstaged_deleted_head_oids.insert(path.to_string(), head_oid.to_string());
                    }
                }
                statuses.insert(path.to_string(), GitStatusEntry { status, layer });
            }
            b'2' => {
                let mut fields = record.splitn(10, ' ');
                let _kind = fields.next();
                let Some(xy) = fields.next() else {
                    continue;
                };
                for _ in 0..7 {
                    let _ = fields.next();
                }
                let Some(path) = fields.next() else {
                    continue;
                };
                let from = records.next().unwrap_or_default().to_string();
                statuses.insert(
                    path.to_string(),
                    GitStatusEntry {
                        status: status_from_xy(xy, path, Some(from), worktree_path),
                        layer: layer_from_xy(xy),
                    },
                );
            }
            _ => {}
        }
    }

    FileTreeStatusParse {
        statuses,
        unstaged_deleted_head_oids,
        untracked_paths,
    }
}

async fn suppress_unstaged_rename_deletion_ghosts(
    worktree_path: &str,
    statuses: &mut HashMap<String, GitStatusEntry>,
    deleted_head_oids: &HashMap<String, String>,
    untracked_paths: &[String],
) {
    if deleted_head_oids.is_empty() || untracked_paths.is_empty() {
        return;
    }

    let mut untracked_oids = HashSet::new();
    for path in untracked_paths {
        let Some(status) = statuses.get(path) else {
            continue;
        };
        if status.status != FileStatus::Added || status.layer != GitFileLayer::Untracked {
            continue;
        }
        if let Some(oid) = hash_worktree_file(worktree_path, path).await {
            untracked_oids.insert(oid);
        }
    }

    if untracked_oids.is_empty() {
        return;
    }

    let ghosts: Vec<String> = deleted_head_oids
        .iter()
        .filter_map(|(path, oid)| untracked_oids.contains(oid).then(|| path.clone()))
        .collect();
    for path in ghosts {
        statuses.remove(&path);
    }
}

async fn hash_worktree_file(worktree_path: &str, relative_path: &str) -> Option<String> {
    let output = Command::new(crate::git::resolve_git_path_blocking())
        .no_console_window()
        .args(["-C", worktree_path])
        .arg("hash-object")
        .arg(format!("--path={relative_path}"))
        .arg("--")
        .arg(relative_path)
        .output()
        .await
        .ok()?;

    if !output.status.success() {
        return None;
    }
    let oid = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!oid.is_empty()).then_some(oid)
}

fn layer_from_xy(xy: &str) -> GitFileLayer {
    let mut chars = xy.chars();
    let index = chars.next().unwrap_or('.');
    let worktree = chars.next().unwrap_or('.');

    match (index != '.', worktree != '.') {
        (true, true) => GitFileLayer::Mixed,
        (true, false) => GitFileLayer::Staged,
        (false, true) => GitFileLayer::Unstaged,
        (false, false) => GitFileLayer::Unstaged,
    }
}

fn status_from_xy(
    xy: &str,
    path: &str,
    rename_from: Option<String>,
    worktree_path: &str,
) -> FileStatus {
    let exists_on_disk = Path::new(worktree_path).join(path).exists();
    // Explorer rows represent what the user can open in the worktree. If the
    // path is gone, show it as deleted even for combinations like AD
    // (staged-add then removed) or staged-rename plus worktree-delete.
    if !exists_on_disk {
        return FileStatus::Deleted;
    }

    if let Some(from) = rename_from {
        return FileStatus::Renamed { from };
    }

    if xy.contains('A') {
        return FileStatus::Added;
    }
    if xy.contains('D') {
        return FileStatus::Deleted;
    }
    FileStatus::Modified
}

/// Parse `--name-status` output into a list of DiffFiles.
fn parse_name_status(output: &str) -> Vec<DiffFile> {
    output.lines().filter_map(parse_name_status_line).collect()
}

/// Parse `ls-files --others` output into untracked DiffFiles.
fn parse_untracked(output: &str) -> Vec<DiffFile> {
    output
        .lines()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(|path| DiffFile {
            path: path.to_string(),
            status: FileStatus::Added,
            additions: None,
            deletions: None,
        })
        .collect()
}

/// Apply `--numstat` output to enrich DiffFiles with addition/deletion counts.
fn apply_numstat(files: &mut [DiffFile], numstat_output: &str) {
    let stats: std::collections::HashMap<String, (u32, u32)> = numstat_output
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 3 {
                let adds = parts[0].parse::<u32>().ok()?;
                let dels = parts[1].parse::<u32>().ok()?;
                let path = parts[2..].join(" ");
                Some((path, (adds, dels)))
            } else {
                None
            }
        })
        .collect();

    for file in files.iter_mut() {
        if let Some((adds, dels)) = stats.get(&file.path) {
            file.additions = Some(*adds);
            file.deletions = Some(*dels);
        }
    }
}

/// Sort files: modified first, then added, renamed, deleted.
fn sort_diff_files(files: &mut [DiffFile]) {
    files.sort_by_key(|f| match &f.status {
        FileStatus::Modified => 0,
        FileStatus::Added => 1,
        FileStatus::Renamed { .. } => 2,
        FileStatus::Deleted => 3,
    });
}

fn parse_name_status_line(line: &str) -> Option<DiffFile> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }

    let mut parts = line.split('\t');
    let status_str = parts.next()?;
    let path = parts.next()?.to_string();

    let status = match status_str.chars().next()? {
        'A' => FileStatus::Added,
        'M' => FileStatus::Modified,
        'D' => FileStatus::Deleted,
        'R' => {
            let new_path = parts.next()?.to_string();
            // For renames, the format is "R###\told_path\tnew_path"
            // We want the DiffFile to represent the new path
            return Some(DiffFile {
                status: FileStatus::Renamed { from: path },
                path: new_path,
                additions: None,
                deletions: None,
            });
        }
        _ => return None,
    };

    Some(DiffFile {
        path,
        status,
        additions: None,
        deletions: None,
    })
}

/// Get the unified diff for a specific file.
pub async fn file_diff(
    worktree_path: &str,
    merge_base: &str,
    file_path: &str,
) -> Result<String, DiffError> {
    validate_file_path(file_path)?;

    // Check if the file is untracked
    let ls_output = run_git(
        worktree_path,
        &[
            "ls-files",
            "--others",
            "--exclude-standard",
            "--",
            file_path,
        ],
    )
    .await?;

    if !ls_output.trim().is_empty() {
        // Untracked file — diff against /dev/null
        let full_path = Path::new(worktree_path).join(file_path);
        let output = Command::new(crate::git::resolve_git_path_blocking())
            .no_console_window()
            .args(["-C", worktree_path])
            .args([
                "diff",
                "--no-index",
                "--",
                "/dev/null",
                full_path.to_str().unwrap_or(file_path),
            ])
            .output()
            .await
            .map_err(|e| DiffError::CommandFailed(e.to_string()))?;

        // git diff --no-index exits with 1 when files differ, which is expected
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        if stdout.trim().is_empty() && !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(DiffError::CommandFailed(stderr));
        }
        return Ok(stdout);
    }

    // Tracked file — diff against merge base
    run_git(worktree_path, &["diff", merge_base, "--", file_path]).await
}

/// Get the unified diff for a specific file within a particular git layer.
///
/// The layer determines which git diff variant is used:
/// - `"committed"` — diff between merge-base and HEAD (what's on the branch)
/// - `"staged"` — diff between HEAD and index (what's staged)
/// - `"unstaged"` — diff between index and working tree (what's modified)
/// - `"untracked"` — diff against /dev/null (new file)
/// - `None` — default behavior: diff between merge-base and working tree
pub async fn file_diff_for_layer(
    worktree_path: &str,
    merge_base: &str,
    file_path: &str,
    layer: Option<&str>,
) -> Result<String, DiffError> {
    validate_file_path(file_path)?;

    match layer {
        Some("committed") => {
            let range = format!("{merge_base}..HEAD");
            run_git(worktree_path, &["diff", &range, "--", file_path]).await
        }
        Some("staged") => run_git(worktree_path, &["diff", "--cached", "--", file_path]).await,
        Some("unstaged") => run_git(worktree_path, &["diff", "--", file_path]).await,
        Some("untracked") => {
            // Diff against /dev/null for untracked files
            let full_path = Path::new(worktree_path).join(file_path);
            let output = Command::new(crate::git::resolve_git_path_blocking())
                .no_console_window()
                .args(["-C", worktree_path])
                .args([
                    "diff",
                    "--no-index",
                    "--",
                    "/dev/null",
                    full_path.to_str().unwrap_or(file_path),
                ])
                .output()
                .await
                .map_err(|e| DiffError::CommandFailed(e.to_string()))?;

            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            if stdout.trim().is_empty() && !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                return Err(DiffError::CommandFailed(stderr));
            }
            Ok(stdout)
        }
        _ => {
            // Default: full diff from merge-base to working tree (existing behavior)
            file_diff(worktree_path, merge_base, file_path).await
        }
    }
}

/// Revert a file to its merge-base version.
pub async fn revert_file(
    worktree_path: &str,
    merge_base: &str,
    file_path: &str,
    status: &FileStatus,
) -> Result<(), DiffError> {
    validate_file_path(file_path)?;

    match status {
        FileStatus::Added => {
            // Delete the file
            let full_path = Path::new(worktree_path).join(file_path);
            tokio::fs::remove_file(&full_path)
                .await
                .map_err(|e| DiffError::CommandFailed(e.to_string()))?;
        }
        FileStatus::Modified | FileStatus::Deleted | FileStatus::Renamed { .. } => {
            // Restore from merge base
            run_git(worktree_path, &["checkout", merge_base, "--", file_path]).await?;
        }
    }
    Ok(())
}

/// Stage a single file (`git add -A -- <file>`). `-A` ensures additions,
/// modifications, and removals are all reflected — without it, staging an
/// unstaged deletion (the file is gone from the worktree) errors with
/// "pathspec did not match any files". Pathspec literal mode (`--`) prevents
/// glob expansion.
pub async fn stage_file(worktree_path: &str, file_path: &str) -> Result<(), DiffError> {
    validate_file_path(file_path)?;
    run_git(worktree_path, &["add", "-A", "--", file_path]).await?;
    Ok(())
}

/// Unstage a single file (`git restore --staged -- <file>`). Leaves the
/// worktree copy untouched.
pub async fn unstage_file(worktree_path: &str, file_path: &str) -> Result<(), DiffError> {
    validate_file_path(file_path)?;
    run_git(worktree_path, &["restore", "--staged", "--", file_path]).await?;
    Ok(())
}

/// Stage many files in a single `git add -A` invocation. Issuing one command
/// with N pathspecs avoids `.git/index.lock` contention that parallel
/// per-file `git add`s race on, and is also faster than serializing them.
/// `-A` is required so deleted paths in the batch stage as removals rather
/// than failing with "pathspec did not match any files".
pub async fn stage_files(worktree_path: &str, file_paths: &[String]) -> Result<(), DiffError> {
    if file_paths.is_empty() {
        return Ok(());
    }
    for p in file_paths {
        validate_file_path(p)?;
    }
    let mut args: Vec<&str> = vec!["add", "-A", "--"];
    args.extend(file_paths.iter().map(String::as_str));
    run_git(worktree_path, &args).await?;
    Ok(())
}

/// Unstage many files in a single `git restore --staged` invocation.
/// See [`stage_files`] for why this batches.
pub async fn unstage_files(worktree_path: &str, file_paths: &[String]) -> Result<(), DiffError> {
    if file_paths.is_empty() {
        return Ok(());
    }
    for p in file_paths {
        validate_file_path(p)?;
    }
    let mut args: Vec<&str> = vec!["restore", "--staged", "--"];
    args.extend(file_paths.iter().map(String::as_str));
    run_git(worktree_path, &args).await?;
    Ok(())
}

/// Discard worktree changes for many files in one go. Tracked paths are
/// passed to a single `git restore --` invocation; untracked paths are
/// removed from disk via `fs::remove_file` in series. Splitting by
/// `is_untracked` mirrors [`discard_file`]'s per-file branching, but
/// folds the tracked branch into one git call to avoid index-lock races.
pub async fn discard_files(
    worktree_path: &str,
    tracked: &[String],
    untracked: &[String],
) -> Result<(), DiffError> {
    for p in tracked.iter().chain(untracked.iter()) {
        validate_file_path(p)?;
    }
    if !tracked.is_empty() {
        let mut args: Vec<&str> = vec!["restore", "--"];
        args.extend(tracked.iter().map(String::as_str));
        run_git(worktree_path, &args).await?;
    }
    for p in untracked {
        let full_path = Path::new(worktree_path).join(p);
        tokio::fs::remove_file(&full_path)
            .await
            .map_err(|e| DiffError::CommandFailed(e.to_string()))?;
    }
    Ok(())
}

/// Discard worktree changes for a single file from the Changes sidebar.
///
/// - `is_untracked = false`: runs `git restore -- <file>`, which restores the
///   worktree copy from the index. Any staged changes are preserved.
/// - `is_untracked = true`: deletes the file from disk via `fs::remove_file`.
///
/// This is distinct from [`revert_file`], which restores all the way back to
/// the merge base and so also discards staged changes.
pub async fn discard_file(
    worktree_path: &str,
    file_path: &str,
    is_untracked: bool,
) -> Result<(), DiffError> {
    validate_file_path(file_path)?;

    if is_untracked {
        let full_path = Path::new(worktree_path).join(file_path);
        tokio::fs::remove_file(&full_path)
            .await
            .map_err(|e| DiffError::CommandFailed(e.to_string()))?;
    } else {
        run_git(worktree_path, &["restore", "--", file_path]).await?;
    }
    Ok(())
}

pub async fn commit_file_diff(
    worktree_path: &str,
    commit_hash: &str,
    file_path: &str,
) -> Result<String, DiffError> {
    validate_file_path(file_path)?;
    if commit_hash.is_empty()
        || commit_hash.len() > 40
        || !commit_hash.chars().all(|c| c.is_ascii_hexdigit())
    {
        return Err(DiffError::CommandFailed("Invalid commit hash".into()));
    }
    // --format= suppresses the commit header so only the patch is returned.
    run_git(
        worktree_path,
        &[
            "show",
            "--format=",
            "--no-color",
            commit_hash,
            "--",
            file_path,
        ],
    )
    .await
}

pub async fn commits_in_range(
    worktree_path: &str,
    merge_base: &str,
) -> Result<Vec<CommitEntry>, DiffError> {
    let range = format!("{merge_base}..HEAD");
    // \x01 (SOH) as field separator; extremely unlikely in commit messages.
    // "|||COMMIT|||" as commit separator within the log stream.
    let commit_marker = "|||COMMIT|||";
    let pretty_arg = format!("--pretty=format:{commit_marker}%H\x01%h\x01%s\x01%an\x01%cI",);

    let output = run_git(
        worktree_path,
        &["log", &pretty_arg, "--name-status", &range],
    )
    .await?;

    if output.is_empty() {
        return Ok(Vec::new());
    }

    let mut commits = Vec::new();
    for chunk in output.split(commit_marker) {
        let chunk = chunk.trim_start_matches('\n');
        if chunk.is_empty() {
            continue;
        }

        let newline_pos = chunk.find('\n').unwrap_or(chunk.len());
        let header = &chunk[..newline_pos];
        let rest = if newline_pos < chunk.len() {
            &chunk[newline_pos + 1..]
        } else {
            ""
        };

        let parts: Vec<&str> = header.splitn(5, '\x01').collect();
        if parts.len() < 5 {
            continue;
        }

        let files = rest
            .lines()
            .filter(|l| !l.trim().is_empty())
            .filter_map(parse_name_status_line)
            .collect();

        commits.push(CommitEntry {
            hash: parts[0].to_string(),
            short_hash: parts[1].to_string(),
            subject: parts[2].to_string(),
            author: parts[3].to_string(),
            date: parts[4].to_string(),
            files,
        });
    }

    Ok(commits)
}

/// Parse unified diff output into structured data.
pub fn parse_unified_diff(raw: &str, path: &str) -> FileDiff {
    if raw.contains("Binary files") && raw.contains("differ") {
        return FileDiff {
            path: path.to_string(),
            hunks: Vec::new(),
            is_binary: true,
        };
    }

    let mut hunks = Vec::new();
    let mut current_hunk: Option<HunkBuilder> = None;

    for line in raw.lines() {
        // Skip diff headers
        if line.starts_with("diff --git")
            || line.starts_with("index ")
            || line.starts_with("---")
            || line.starts_with("+++")
            || line.starts_with("new file mode")
            || line.starts_with("deleted file mode")
            || line.starts_with("old mode")
            || line.starts_with("new mode")
            || line.starts_with("similarity index")
            || line.starts_with("rename from")
            || line.starts_with("rename to")
        {
            continue;
        }

        // Hunk header
        if line.starts_with("@@") {
            if let Some(builder) = current_hunk.take() {
                hunks.push(builder.build());
            }
            if let Some(builder) = parse_hunk_header(line) {
                current_hunk = Some(builder);
            }
            continue;
        }

        // No-newline marker
        if line.starts_with("\\ No newline at end of file") {
            continue;
        }

        // Diff content lines
        if let Some(ref mut builder) = current_hunk
            && let Some(ch) = line.chars().next()
        {
            match ch {
                '+' => {
                    builder.lines.push(DiffLine {
                        line_type: DiffLineType::Added,
                        content: line[1..].to_string(),
                        old_line_number: None,
                        new_line_number: Some(builder.new_line),
                    });
                    builder.new_line += 1;
                }
                '-' => {
                    builder.lines.push(DiffLine {
                        line_type: DiffLineType::Removed,
                        content: line[1..].to_string(),
                        old_line_number: Some(builder.old_line),
                        new_line_number: None,
                    });
                    builder.old_line += 1;
                }
                ' ' => {
                    builder.lines.push(DiffLine {
                        line_type: DiffLineType::Context,
                        content: line[1..].to_string(),
                        old_line_number: Some(builder.old_line),
                        new_line_number: Some(builder.new_line),
                    });
                    builder.old_line += 1;
                    builder.new_line += 1;
                }
                _ => {}
            }
        }
    }

    // Flush last hunk
    if let Some(builder) = current_hunk {
        hunks.push(builder.build());
    }

    FileDiff {
        path: path.to_string(),
        hunks,
        is_binary: false,
    }
}

struct HunkBuilder {
    old_start: u32,
    new_start: u32,
    header: String,
    old_line: u32,
    new_line: u32,
    lines: Vec<DiffLine>,
}

impl HunkBuilder {
    fn build(self) -> DiffHunk {
        DiffHunk {
            old_start: self.old_start,
            new_start: self.new_start,
            header: self.header,
            lines: self.lines,
        }
    }
}

fn parse_hunk_header(line: &str) -> Option<HunkBuilder> {
    // Format: @@ -old_start,old_count +new_start,new_count @@ optional context
    let after_at = line.strip_prefix("@@ ")?;
    let end = after_at.find(" @@")?;
    let range_part = &after_at[..end];
    let _header_context = after_at[end + 3..].trim();

    let mut parts = range_part.split(' ');

    let old_range = parts.next()?.strip_prefix('-')?;
    let old_start: u32 = old_range.split(',').next()?.parse().ok()?;

    let new_range = parts.next()?.strip_prefix('+')?;
    let new_start: u32 = new_range.split(',').next()?.parse().ok()?;

    Some(HunkBuilder {
        old_start,
        new_start,
        header: line.to_string(),
        old_line: old_start,
        new_line: new_start,
        lines: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_file_path_rejects_traversal() {
        assert!(validate_file_path("../etc/passwd").is_err());
        assert!(validate_file_path("src/../../etc/passwd").is_err());
        assert!(validate_file_path("..").is_err());
        assert!(validate_file_path("foo/..").is_err());
        // Windows-style separators
        assert!(validate_file_path("src\\..\\..\\etc\\passwd").is_err());
    }

    #[test]
    fn test_validate_file_path_rejects_absolute() {
        assert!(validate_file_path("/etc/passwd").is_err());
    }

    #[test]
    fn test_validate_file_path_rejects_null_byte() {
        assert!(validate_file_path("src/foo\0bar").is_err());
    }

    #[test]
    fn test_validate_file_path_accepts_valid() {
        assert!(validate_file_path("src/app.rs").is_ok());
        assert!(validate_file_path("deeply/nested/path/file.txt").is_ok());
        assert!(validate_file_path("file.rs").is_ok());
        // ".." as part of a filename (not a component) is fine
        assert!(validate_file_path("src/foo..bar").is_ok());
    }

    #[test]
    fn test_parse_name_status_modified() {
        let file = parse_name_status_line("M\tsrc/app.rs").unwrap();
        assert_eq!(file.path, "src/app.rs");
        assert_eq!(file.status, FileStatus::Modified);
    }

    #[test]
    fn test_parse_name_status_added() {
        let file = parse_name_status_line("A\tsrc/new_file.rs").unwrap();
        assert_eq!(file.path, "src/new_file.rs");
        assert_eq!(file.status, FileStatus::Added);
    }

    #[test]
    fn test_parse_name_status_deleted() {
        let file = parse_name_status_line("D\tsrc/old_file.rs").unwrap();
        assert_eq!(file.path, "src/old_file.rs");
        assert_eq!(file.status, FileStatus::Deleted);
    }

    #[test]
    fn test_parse_name_status_renamed() {
        let file = parse_name_status_line("R100\tsrc/old.rs\tsrc/new.rs").unwrap();
        assert_eq!(file.path, "src/new.rs");
        assert_eq!(
            file.status,
            FileStatus::Renamed {
                from: "src/old.rs".to_string()
            }
        );
    }

    #[test]
    fn test_parse_name_status_empty() {
        assert!(parse_name_status_line("").is_none());
        assert!(parse_name_status_line("   ").is_none());
    }

    #[test]
    fn test_parse_simple_modification() {
        let diff = "\
diff --git a/src/app.rs b/src/app.rs
index abc123..def456 100644
--- a/src/app.rs
+++ b/src/app.rs
@@ -10,7 +10,8 @@ fn some_function() {
     context line 1
     context line 2
-    old line
+    new line
+    extra line
     context line 3
";
        let result = parse_unified_diff(diff, "src/app.rs");
        assert_eq!(result.path, "src/app.rs");
        assert!(!result.is_binary);
        assert_eq!(result.hunks.len(), 1);

        let hunk = &result.hunks[0];
        assert_eq!(hunk.old_start, 10);
        assert_eq!(hunk.new_start, 10);
        assert_eq!(hunk.lines.len(), 6);

        assert_eq!(hunk.lines[0].line_type, DiffLineType::Context);
        assert_eq!(hunk.lines[0].content, "    context line 1");
        assert_eq!(hunk.lines[0].old_line_number, Some(10));
        assert_eq!(hunk.lines[0].new_line_number, Some(10));

        assert_eq!(hunk.lines[1].line_type, DiffLineType::Context);
        assert_eq!(hunk.lines[1].old_line_number, Some(11));
        assert_eq!(hunk.lines[1].new_line_number, Some(11));

        assert_eq!(hunk.lines[2].line_type, DiffLineType::Removed);
        assert_eq!(hunk.lines[2].content, "    old line");
        assert_eq!(hunk.lines[2].old_line_number, Some(12));
        assert_eq!(hunk.lines[2].new_line_number, None);

        assert_eq!(hunk.lines[3].line_type, DiffLineType::Added);
        assert_eq!(hunk.lines[3].content, "    new line");
        assert_eq!(hunk.lines[3].old_line_number, None);
        assert_eq!(hunk.lines[3].new_line_number, Some(12));

        assert_eq!(hunk.lines[4].line_type, DiffLineType::Added);
        assert_eq!(hunk.lines[4].content, "    extra line");
        assert_eq!(hunk.lines[4].new_line_number, Some(13));

        assert_eq!(hunk.lines[5].line_type, DiffLineType::Context);
        assert_eq!(hunk.lines[5].content, "    context line 3");
        assert_eq!(hunk.lines[5].old_line_number, Some(13));
        assert_eq!(hunk.lines[5].new_line_number, Some(14));
    }

    #[test]
    fn test_parse_multi_hunk() {
        let diff = "\
diff --git a/src/lib.rs b/src/lib.rs
index 111..222 100644
--- a/src/lib.rs
+++ b/src/lib.rs
@@ -1,3 +1,4 @@
 line 1
+inserted
 line 2
 line 3
@@ -20,3 +21,3 @@ fn other() {
     keep
-    remove
+    replace
     keep
";
        let result = parse_unified_diff(diff, "src/lib.rs");
        assert_eq!(result.hunks.len(), 2);

        assert_eq!(result.hunks[0].old_start, 1);
        assert_eq!(result.hunks[0].new_start, 1);
        assert_eq!(result.hunks[0].lines.len(), 4);

        assert_eq!(result.hunks[1].old_start, 20);
        assert_eq!(result.hunks[1].new_start, 21);
        assert_eq!(result.hunks[1].lines.len(), 4);
    }

    #[test]
    fn test_parse_pure_addition() {
        let diff = "\
diff --git a/new_file.rs b/new_file.rs
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/new_file.rs
@@ -0,0 +1,3 @@
+line 1
+line 2
+line 3
";
        let result = parse_unified_diff(diff, "new_file.rs");
        assert!(!result.is_binary);
        assert_eq!(result.hunks.len(), 1);
        assert_eq!(result.hunks[0].lines.len(), 3);
        assert!(
            result.hunks[0]
                .lines
                .iter()
                .all(|l| l.line_type == DiffLineType::Added)
        );
        assert_eq!(result.hunks[0].lines[0].new_line_number, Some(1));
        assert_eq!(result.hunks[0].lines[2].new_line_number, Some(3));
    }

    #[test]
    fn test_parse_pure_deletion() {
        let diff = "\
diff --git a/old_file.rs b/old_file.rs
deleted file mode 100644
index abc1234..0000000
--- a/old_file.rs
+++ /dev/null
@@ -1,3 +0,0 @@
-line 1
-line 2
-line 3
";
        let result = parse_unified_diff(diff, "old_file.rs");
        assert!(!result.is_binary);
        assert_eq!(result.hunks.len(), 1);
        assert_eq!(result.hunks[0].lines.len(), 3);
        assert!(
            result.hunks[0]
                .lines
                .iter()
                .all(|l| l.line_type == DiffLineType::Removed)
        );
        assert_eq!(result.hunks[0].lines[0].old_line_number, Some(1));
    }

    #[test]
    fn test_parse_binary_file() {
        let diff = "\
diff --git a/image.png b/image.png
Binary files a/image.png and b/image.png differ
";
        let result = parse_unified_diff(diff, "image.png");
        assert!(result.is_binary);
        assert!(result.hunks.is_empty());
    }

    #[test]
    fn test_parse_no_newline_at_eof() {
        let diff = "\
diff --git a/file.txt b/file.txt
index abc..def 100644
--- a/file.txt
+++ b/file.txt
@@ -1,2 +1,2 @@
 line 1
-old last line
\\ No newline at end of file
+new last line
\\ No newline at end of file
";
        let result = parse_unified_diff(diff, "file.txt");
        assert_eq!(result.hunks.len(), 1);
        // The no-newline markers should be skipped
        assert_eq!(result.hunks[0].lines.len(), 3);
        assert_eq!(result.hunks[0].lines[0].line_type, DiffLineType::Context);
        assert_eq!(result.hunks[0].lines[1].line_type, DiffLineType::Removed);
        assert_eq!(result.hunks[0].lines[2].line_type, DiffLineType::Added);
    }

    #[test]
    fn test_parse_rename() {
        let diff = "\
diff --git a/old_name.rs b/new_name.rs
similarity index 95%
rename from old_name.rs
rename to new_name.rs
index abc..def 100644
--- a/old_name.rs
+++ b/new_name.rs
@@ -1,3 +1,3 @@
 keep
-old
+new
 keep
";
        let result = parse_unified_diff(diff, "new_name.rs");
        assert!(!result.is_binary);
        assert_eq!(result.hunks.len(), 1);
        assert_eq!(result.hunks[0].lines.len(), 4);
    }

    #[test]
    fn test_parse_empty_diff() {
        let result = parse_unified_diff("", "empty.rs");
        assert!(!result.is_binary);
        assert!(result.hunks.is_empty());
    }

    #[test]
    fn test_parse_context_line_numbers() {
        let diff = "\
diff --git a/f.rs b/f.rs
index a..b 100644
--- a/f.rs
+++ b/f.rs
@@ -5,4 +5,5 @@
 ctx1
 ctx2
+added
 ctx3
 ctx4
";
        let result = parse_unified_diff(diff, "f.rs");
        let lines = &result.hunks[0].lines;

        // ctx1: old=5, new=5
        assert_eq!(lines[0].old_line_number, Some(5));
        assert_eq!(lines[0].new_line_number, Some(5));

        // ctx2: old=6, new=6
        assert_eq!(lines[1].old_line_number, Some(6));
        assert_eq!(lines[1].new_line_number, Some(6));

        // added: old=None, new=7
        assert_eq!(lines[2].old_line_number, None);
        assert_eq!(lines[2].new_line_number, Some(7));

        // ctx3: old=7, new=8
        assert_eq!(lines[3].old_line_number, Some(7));
        assert_eq!(lines[3].new_line_number, Some(8));

        // ctx4: old=8, new=9
        assert_eq!(lines[4].old_line_number, Some(8));
        assert_eq!(lines[4].new_line_number, Some(9));
    }
}

#[cfg(test)]
mod integration_tests {
    use super::*;
    use std::process::Command as StdCommand;

    fn git_cmd(dir: &Path, args: &[&str]) -> String {
        let output = StdCommand::new(crate::git::resolve_git_path_blocking())
            .no_console_window()
            .args(["-C", dir.to_str().unwrap()])
            .args(args)
            .output()
            .expect("failed to run git");
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn setup_test_repo(dir: &Path) {
        git_cmd(dir, &["init", "-b", "main"]);
        git_cmd(dir, &["config", "user.email", "test@test.com"]);
        git_cmd(dir, &["config", "user.name", "Test"]);
        // Force LF line endings in the working tree. Git for Windows
        // defaults to `core.autocrlf=true` globally, which rewrites LF to
        // CRLF on checkout and would make the revert assertions compare
        // "keep\r\n" against "keep\n". The production worktree this
        // module manages is a git worktree created by the app, where we
        // control the config — so mirroring that in tests is closer to
        // real conditions, not less accurate.
        git_cmd(dir, &["config", "core.autocrlf", "false"]);

        // Create initial file and commit on main
        std::fs::write(dir.join("file.txt"), "line 1\nline 2\nline 3\n").unwrap();
        std::fs::write(dir.join("keep.txt"), "keep\n").unwrap();
        git_cmd(dir, &["add", "."]);
        git_cmd(dir, &["commit", "-m", "initial"]);

        // Create a feature branch
        git_cmd(dir, &["checkout", "-b", "feature"]);

        // Make changes on the feature branch
        std::fs::write(dir.join("file.txt"), "line 1\nmodified line 2\nline 3\n").unwrap();
        std::fs::write(dir.join("new_file.txt"), "new content\n").unwrap();
        std::fs::remove_file(dir.join("keep.txt")).unwrap();
        git_cmd(dir, &["add", "."]);
        git_cmd(dir, &["commit", "-m", "feature changes"]);
    }

    #[tokio::test]
    async fn test_merge_base() {
        let tmp = tempfile::tempdir().unwrap();
        setup_test_repo(tmp.path());

        let base = merge_base(tmp.path().to_str().unwrap(), "feature", "main")
            .await
            .unwrap();

        // Merge base should be the initial commit (main HEAD)
        let main_head = git_cmd(tmp.path(), &["rev-parse", "main"]);
        assert_eq!(base, main_head);
    }

    #[tokio::test]
    async fn test_changed_files_lists_all_changes() {
        let tmp = tempfile::tempdir().unwrap();
        setup_test_repo(tmp.path());

        let base = merge_base(tmp.path().to_str().unwrap(), "feature", "main")
            .await
            .unwrap();
        let files = changed_files(tmp.path().to_str().unwrap(), &base)
            .await
            .unwrap();

        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"file.txt"), "should contain modified file");
        assert!(paths.contains(&"new_file.txt"), "should contain added file");
        assert!(paths.contains(&"keep.txt"), "should contain deleted file");

        let file_txt = files.iter().find(|f| f.path == "file.txt").unwrap();
        assert_eq!(file_txt.status, FileStatus::Modified);

        let new_file = files.iter().find(|f| f.path == "new_file.txt").unwrap();
        assert_eq!(new_file.status, FileStatus::Added);

        let keep = files.iter().find(|f| f.path == "keep.txt").unwrap();
        assert_eq!(keep.status, FileStatus::Deleted);
    }

    #[tokio::test]
    async fn test_changed_files_includes_untracked() {
        let tmp = tempfile::tempdir().unwrap();
        setup_test_repo(tmp.path());

        let base = merge_base(tmp.path().to_str().unwrap(), "feature", "main")
            .await
            .unwrap();

        // Add an untracked file
        std::fs::write(tmp.path().join("untracked.txt"), "hello\n").unwrap();

        let files = changed_files(tmp.path().to_str().unwrap(), &base)
            .await
            .unwrap();

        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert!(
            paths.contains(&"untracked.txt"),
            "should contain untracked file"
        );

        let untracked = files.iter().find(|f| f.path == "untracked.txt").unwrap();
        assert_eq!(untracked.status, FileStatus::Added);
    }

    #[tokio::test]
    async fn test_file_diff_returns_parseable_output() {
        let tmp = tempfile::tempdir().unwrap();
        setup_test_repo(tmp.path());

        let base = merge_base(tmp.path().to_str().unwrap(), "feature", "main")
            .await
            .unwrap();

        let raw = file_diff(tmp.path().to_str().unwrap(), &base, "file.txt")
            .await
            .unwrap();

        let parsed = parse_unified_diff(&raw, "file.txt");
        assert!(!parsed.is_binary);
        assert!(!parsed.hunks.is_empty());

        // Should have removed "line 2" and added "modified line 2"
        let all_lines: Vec<_> = parsed.hunks.iter().flat_map(|h| &h.lines).collect();
        assert!(
            all_lines
                .iter()
                .any(|l| l.line_type == DiffLineType::Removed && l.content.contains("line 2"))
        );
        assert!(
            all_lines.iter().any(
                |l| l.line_type == DiffLineType::Added && l.content.contains("modified line 2")
            )
        );
    }

    #[tokio::test]
    async fn test_file_diff_deleted_file() {
        let tmp = tempfile::tempdir().unwrap();
        setup_test_repo(tmp.path());

        let base = merge_base(tmp.path().to_str().unwrap(), "feature", "main")
            .await
            .unwrap();

        let raw = file_diff(tmp.path().to_str().unwrap(), &base, "keep.txt")
            .await
            .unwrap();

        let parsed = parse_unified_diff(&raw, "keep.txt");
        assert!(!parsed.hunks.is_empty());
        // All lines should be removals
        assert!(
            parsed.hunks[0]
                .lines
                .iter()
                .all(|l| l.line_type == DiffLineType::Removed)
        );
    }

    #[tokio::test]
    async fn test_file_diff_added_file() {
        let tmp = tempfile::tempdir().unwrap();
        setup_test_repo(tmp.path());

        let base = merge_base(tmp.path().to_str().unwrap(), "feature", "main")
            .await
            .unwrap();

        let raw = file_diff(tmp.path().to_str().unwrap(), &base, "new_file.txt")
            .await
            .unwrap();

        let parsed = parse_unified_diff(&raw, "new_file.txt");
        assert!(!parsed.hunks.is_empty());
        // All lines should be additions
        assert!(
            parsed.hunks[0]
                .lines
                .iter()
                .all(|l| l.line_type == DiffLineType::Added)
        );
    }

    #[tokio::test]
    async fn test_revert_modified_file() {
        let tmp = tempfile::tempdir().unwrap();
        setup_test_repo(tmp.path());

        let base = merge_base(tmp.path().to_str().unwrap(), "feature", "main")
            .await
            .unwrap();

        revert_file(
            tmp.path().to_str().unwrap(),
            &base,
            "file.txt",
            &FileStatus::Modified,
        )
        .await
        .unwrap();

        let content = std::fs::read_to_string(tmp.path().join("file.txt")).unwrap();
        assert_eq!(content, "line 1\nline 2\nline 3\n");
    }

    #[tokio::test]
    async fn test_revert_added_file() {
        let tmp = tempfile::tempdir().unwrap();
        setup_test_repo(tmp.path());

        let base = merge_base(tmp.path().to_str().unwrap(), "feature", "main")
            .await
            .unwrap();

        revert_file(
            tmp.path().to_str().unwrap(),
            &base,
            "new_file.txt",
            &FileStatus::Added,
        )
        .await
        .unwrap();

        assert!(!tmp.path().join("new_file.txt").exists());
    }

    #[tokio::test]
    async fn test_discard_unstaged_modified_restores_from_index() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();

        git_cmd(dir, &["init", "-b", "main"]);
        git_cmd(dir, &["config", "user.email", "test@test.com"]);
        git_cmd(dir, &["config", "user.name", "Test"]);
        git_cmd(dir, &["config", "core.autocrlf", "false"]);
        std::fs::write(dir.join("file.txt"), "original\n").unwrap();
        git_cmd(dir, &["add", "."]);
        git_cmd(dir, &["commit", "-m", "initial"]);

        // Unstaged modification
        std::fs::write(dir.join("file.txt"), "modified\n").unwrap();

        discard_file(dir.to_str().unwrap(), "file.txt", false)
            .await
            .unwrap();

        let content = std::fs::read_to_string(dir.join("file.txt")).unwrap();
        assert_eq!(content, "original\n");
    }

    #[tokio::test]
    async fn test_discard_unstaged_modified_preserves_staged_changes() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();

        git_cmd(dir, &["init", "-b", "main"]);
        git_cmd(dir, &["config", "user.email", "test@test.com"]);
        git_cmd(dir, &["config", "user.name", "Test"]);
        git_cmd(dir, &["config", "core.autocrlf", "false"]);
        std::fs::write(dir.join("file.txt"), "v1\n").unwrap();
        git_cmd(dir, &["add", "."]);
        git_cmd(dir, &["commit", "-m", "initial"]);

        // Stage v2, then add an unstaged v3 layer on top
        std::fs::write(dir.join("file.txt"), "v2\n").unwrap();
        git_cmd(dir, &["add", "file.txt"]);
        std::fs::write(dir.join("file.txt"), "v3\n").unwrap();

        discard_file(dir.to_str().unwrap(), "file.txt", false)
            .await
            .unwrap();

        // Worktree restored to staged copy (v2), staged changes still present
        let content = std::fs::read_to_string(dir.join("file.txt")).unwrap();
        assert_eq!(content, "v2\n");

        // Confirm v2 is still staged
        let staged_diff = git_cmd(dir, &["diff", "--cached", "--", "file.txt"]);
        assert!(staged_diff.contains("+v2"));
    }

    #[tokio::test]
    async fn test_discard_unstaged_deleted_restores_file() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();

        git_cmd(dir, &["init", "-b", "main"]);
        git_cmd(dir, &["config", "user.email", "test@test.com"]);
        git_cmd(dir, &["config", "user.name", "Test"]);
        git_cmd(dir, &["config", "core.autocrlf", "false"]);
        std::fs::write(dir.join("keep.txt"), "keep\n").unwrap();
        git_cmd(dir, &["add", "."]);
        git_cmd(dir, &["commit", "-m", "initial"]);

        std::fs::remove_file(dir.join("keep.txt")).unwrap();

        discard_file(dir.to_str().unwrap(), "keep.txt", false)
            .await
            .unwrap();

        let content = std::fs::read_to_string(dir.join("keep.txt")).unwrap();
        assert_eq!(content, "keep\n");
    }

    #[tokio::test]
    async fn test_discard_untracked_file_removes_it() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();

        git_cmd(dir, &["init", "-b", "main"]);
        git_cmd(dir, &["config", "user.email", "test@test.com"]);
        git_cmd(dir, &["config", "user.name", "Test"]);
        std::fs::write(dir.join("base.txt"), "base\n").unwrap();
        git_cmd(dir, &["add", "."]);
        git_cmd(dir, &["commit", "-m", "initial"]);

        std::fs::write(dir.join("new.txt"), "untracked\n").unwrap();
        assert!(dir.join("new.txt").exists());

        discard_file(dir.to_str().unwrap(), "new.txt", true)
            .await
            .unwrap();

        assert!(!dir.join("new.txt").exists());
    }

    #[tokio::test]
    async fn test_discard_rejects_path_traversal() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        git_cmd(dir, &["init", "-b", "main"]);

        let err = discard_file(dir.to_str().unwrap(), "../etc/passwd", true)
            .await
            .unwrap_err();
        assert!(matches!(err, DiffError::CommandFailed(_)));
    }

    #[tokio::test]
    async fn test_revert_deleted_file() {
        let tmp = tempfile::tempdir().unwrap();
        setup_test_repo(tmp.path());

        let base = merge_base(tmp.path().to_str().unwrap(), "feature", "main")
            .await
            .unwrap();

        revert_file(
            tmp.path().to_str().unwrap(),
            &base,
            "keep.txt",
            &FileStatus::Deleted,
        )
        .await
        .unwrap();

        let content = std::fs::read_to_string(tmp.path().join("keep.txt")).unwrap();
        assert_eq!(content, "keep\n");
    }

    #[tokio::test]
    async fn test_no_changes_returns_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();

        git_cmd(dir, &["init", "-b", "main"]);
        git_cmd(dir, &["config", "user.email", "test@test.com"]);
        git_cmd(dir, &["config", "user.name", "Test"]);
        std::fs::write(dir.join("file.txt"), "content\n").unwrap();
        git_cmd(dir, &["add", "."]);
        git_cmd(dir, &["commit", "-m", "initial"]);

        let head = git_cmd(dir, &["rev-parse", "HEAD"]);
        let files = changed_files(dir.to_str().unwrap(), &head).await.unwrap();
        assert!(files.is_empty());
    }

    #[tokio::test]
    async fn test_staged_changed_files_categorizes_correctly() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();

        // Set up repo with initial commit on main
        git_cmd(dir, &["init", "-b", "main"]);
        git_cmd(dir, &["config", "user.email", "test@test.com"]);
        git_cmd(dir, &["config", "user.name", "Test"]);
        std::fs::write(dir.join("base.txt"), "base content\n").unwrap();
        std::fs::write(dir.join("will-modify.txt"), "original\n").unwrap();
        git_cmd(dir, &["add", "."]);
        git_cmd(dir, &["commit", "-m", "initial"]);

        // Create feature branch
        git_cmd(dir, &["checkout", "-b", "feature"]);

        // 1. Committed change: modify and commit a file
        std::fs::write(dir.join("will-modify.txt"), "committed change\n").unwrap();
        std::fs::write(dir.join("committed-new.txt"), "new file\n").unwrap();
        git_cmd(dir, &["add", "."]);
        git_cmd(dir, &["commit", "-m", "committed changes"]);

        // 2. Staged change: modify and stage (but don't commit)
        std::fs::write(dir.join("staged-new.txt"), "staged content\n").unwrap();
        git_cmd(dir, &["add", "staged-new.txt"]);

        // 3. Unstaged change: modify a committed file without staging
        std::fs::write(
            dir.join("will-modify.txt"),
            "committed change\nunstaged edit\n",
        )
        .unwrap();

        // 4. Untracked file
        std::fs::write(dir.join("untracked.txt"), "not tracked\n").unwrap();

        let base = merge_base(dir.to_str().unwrap(), "feature", "main")
            .await
            .unwrap();
        let staged = staged_changed_files(dir.to_str().unwrap(), &base)
            .await
            .unwrap();

        // Committed: will-modify.txt + committed-new.txt
        let committed_paths: Vec<&str> = staged.committed.iter().map(|f| f.path.as_str()).collect();
        assert!(
            committed_paths.contains(&"will-modify.txt"),
            "committed should contain will-modify.txt, got: {committed_paths:?}"
        );
        assert!(
            committed_paths.contains(&"committed-new.txt"),
            "committed should contain committed-new.txt, got: {committed_paths:?}"
        );

        // Staged: staged-new.txt
        let staged_paths: Vec<&str> = staged.staged.iter().map(|f| f.path.as_str()).collect();
        assert!(
            staged_paths.contains(&"staged-new.txt"),
            "staged should contain staged-new.txt, got: {staged_paths:?}"
        );

        // Unstaged: will-modify.txt (has uncommitted modifications)
        let unstaged_paths: Vec<&str> = staged.unstaged.iter().map(|f| f.path.as_str()).collect();
        assert!(
            unstaged_paths.contains(&"will-modify.txt"),
            "unstaged should contain will-modify.txt, got: {unstaged_paths:?}"
        );

        // Untracked: untracked.txt
        let untracked_paths: Vec<&str> = staged.untracked.iter().map(|f| f.path.as_str()).collect();
        assert!(
            untracked_paths.contains(&"untracked.txt"),
            "untracked should contain untracked.txt, got: {untracked_paths:?}"
        );

        // will-modify.txt appears in BOTH committed AND unstaged
        assert!(committed_paths.contains(&"will-modify.txt"));
        assert!(unstaged_paths.contains(&"will-modify.txt"));
    }

    #[tokio::test]
    async fn test_file_tree_git_status_covers_current_git_status() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();

        git_cmd(dir, &["init", "-b", "main"]);
        git_cmd(dir, &["config", "user.email", "test@test.com"]);
        git_cmd(dir, &["config", "user.name", "Test"]);
        git_cmd(dir, &["config", "core.autocrlf", "false"]);
        std::fs::write(dir.join("clean.txt"), "clean\n").unwrap();
        std::fs::write(dir.join("modified.txt"), "original\n").unwrap();
        std::fs::write(dir.join("deleted.txt"), "remove me\n").unwrap();
        std::fs::write(dir.join("renamed-old.txt"), "rename me\n").unwrap();
        std::fs::write(dir.join("mixed.txt"), "base\n").unwrap();
        git_cmd(dir, &["add", "."]);
        git_cmd(dir, &["commit", "-m", "initial"]);

        std::fs::write(dir.join("modified.txt"), "changed\n").unwrap();
        std::fs::remove_file(dir.join("deleted.txt")).unwrap();
        git_cmd(dir, &["mv", "renamed-old.txt", "renamed-new.txt"]);
        std::fs::write(dir.join("untracked.txt"), "new\n").unwrap();
        std::fs::write(dir.join("staged-new.txt"), "staged\n").unwrap();
        git_cmd(dir, &["add", "staged-new.txt"]);
        std::fs::write(dir.join("staged-then-removed.txt"), "staged\n").unwrap();
        git_cmd(dir, &["add", "staged-then-removed.txt"]);
        std::fs::remove_file(dir.join("staged-then-removed.txt")).unwrap();
        std::fs::write(dir.join("mixed.txt"), "staged\n").unwrap();
        git_cmd(dir, &["add", "mixed.txt"]);
        std::fs::write(dir.join("mixed.txt"), "staged\nunstaged\n").unwrap();

        let status = file_tree_git_status(dir.to_str().unwrap()).await.unwrap();

        assert!(!status.contains_key("clean.txt"));
        assert_eq!(
            status.get("modified.txt"),
            Some(&GitStatusEntry {
                status: FileStatus::Modified,
                layer: GitFileLayer::Unstaged,
            })
        );
        assert_eq!(
            status.get("deleted.txt"),
            Some(&GitStatusEntry {
                status: FileStatus::Deleted,
                layer: GitFileLayer::Unstaged,
            })
        );
        assert_eq!(
            status.get("renamed-new.txt"),
            Some(&GitStatusEntry {
                status: FileStatus::Renamed {
                    from: "renamed-old.txt".to_string(),
                },
                layer: GitFileLayer::Staged,
            })
        );
        assert_eq!(
            status.get("untracked.txt"),
            Some(&GitStatusEntry {
                status: FileStatus::Added,
                layer: GitFileLayer::Untracked,
            })
        );
        assert_eq!(
            status.get("staged-new.txt"),
            Some(&GitStatusEntry {
                status: FileStatus::Added,
                layer: GitFileLayer::Staged,
            })
        );
        assert_eq!(
            status.get("staged-then-removed.txt"),
            Some(&GitStatusEntry {
                status: FileStatus::Deleted,
                layer: GitFileLayer::Mixed,
            })
        );
        assert_eq!(
            status.get("mixed.txt"),
            Some(&GitStatusEntry {
                status: FileStatus::Modified,
                layer: GitFileLayer::Mixed,
            })
        );
    }

    #[tokio::test]
    async fn test_file_tree_git_status_hides_unstaged_rename_deleted_ghost() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();

        git_cmd(dir, &["init", "-b", "main"]);
        git_cmd(dir, &["config", "user.email", "test@test.com"]);
        git_cmd(dir, &["config", "user.name", "Test"]);
        git_cmd(dir, &["config", "core.autocrlf", "false"]);
        std::fs::write(dir.join("index.rs"), "fn main() {}\n").unwrap();
        git_cmd(dir, &["add", "."]);
        git_cmd(dir, &["commit", "-m", "initial"]);

        std::fs::rename(dir.join("index.rs"), dir.join("index2.rs")).unwrap();

        let status = file_tree_git_status(dir.to_str().unwrap()).await.unwrap();

        assert!(!status.contains_key("index.rs"));
        assert_eq!(
            status.get("index2.rs"),
            Some(&GitStatusEntry {
                status: FileStatus::Added,
                layer: GitFileLayer::Untracked,
            })
        );
    }

    #[tokio::test]
    async fn test_file_diff_for_layer_committed() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        setup_test_repo(dir);

        let base = merge_base(dir.to_str().unwrap(), "feature", "main")
            .await
            .unwrap();

        let raw = file_diff_for_layer(dir.to_str().unwrap(), &base, "file.txt", Some("committed"))
            .await
            .unwrap();
        let parsed = parse_unified_diff(&raw, "file.txt");
        assert!(!parsed.hunks.is_empty(), "committed layer should have diff");
    }

    #[tokio::test]
    async fn test_file_diff_for_layer_staged() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        setup_test_repo(dir);

        // Stage a change without committing
        std::fs::write(dir.join("file.txt"), "staged change\n").unwrap();
        git_cmd(dir, &["add", "file.txt"]);

        let raw = file_diff_for_layer(dir.to_str().unwrap(), "HEAD", "file.txt", Some("staged"))
            .await
            .unwrap();
        let parsed = parse_unified_diff(&raw, "file.txt");
        assert!(!parsed.hunks.is_empty(), "staged layer should have diff");
    }

    #[tokio::test]
    async fn test_file_diff_for_layer_unstaged() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        setup_test_repo(dir);

        // Modify without staging
        std::fs::write(dir.join("file.txt"), "unstaged edit\n").unwrap();

        let raw = file_diff_for_layer(dir.to_str().unwrap(), "HEAD", "file.txt", Some("unstaged"))
            .await
            .unwrap();
        let parsed = parse_unified_diff(&raw, "file.txt");
        assert!(!parsed.hunks.is_empty(), "unstaged layer should have diff");
    }

    #[tokio::test]
    async fn test_file_diff_for_layer_untracked() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        setup_test_repo(dir);

        std::fs::write(dir.join("brand-new.txt"), "hello\n").unwrap();

        let raw = file_diff_for_layer(
            dir.to_str().unwrap(),
            "HEAD",
            "brand-new.txt",
            Some("untracked"),
        )
        .await
        .unwrap();
        let parsed = parse_unified_diff(&raw, "brand-new.txt");
        assert!(!parsed.hunks.is_empty(), "untracked layer should have diff");
        assert!(
            parsed.hunks[0]
                .lines
                .iter()
                .all(|l| l.line_type == DiffLineType::Added)
        );
    }

    #[tokio::test]
    async fn test_file_diff_for_layer_default() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        setup_test_repo(dir);

        let base = merge_base(dir.to_str().unwrap(), "feature", "main")
            .await
            .unwrap();

        // None layer = default behavior (merge-base to working tree)
        let raw = file_diff_for_layer(dir.to_str().unwrap(), &base, "file.txt", None)
            .await
            .unwrap();
        let parsed = parse_unified_diff(&raw, "file.txt");
        assert!(!parsed.hunks.is_empty(), "default layer should have diff");
    }

    /// Like `setup_test_repo` but adds a post-divergence commit on `main` so that
    /// the true merge-base (the initial commit) is strictly *less than* both
    /// `main` HEAD and `feature` HEAD.  Without this, a buggy implementation that
    /// simply returned `main`'s HEAD would pass undetected.
    ///
    /// Final state
    /// -----------
    ///   main:    initial ── main-post-divergence
    ///   feature: initial ── feature-changes          ← worktree HEAD
    ///
    /// Expected merge-base: SHA of `initial`.
    fn setup_diverged_test_repo(dir: &Path) {
        // Reuse the shared helper: creates `initial` on main, then branches to
        // `feature` and commits `feature changes`.  Worktree is left on `feature`.
        setup_test_repo(dir);

        // Switch back to main and add a commit that diverges it past the branch point.
        git_cmd(dir, &["checkout", "main"]);
        std::fs::write(dir.join("main_extra.txt"), "main post-divergence\n").unwrap();
        git_cmd(dir, &["add", "main_extra.txt"]);
        git_cmd(dir, &["commit", "-m", "main post-divergence"]);

        // Return to feature so the worktree HEAD is the feature tip.
        git_cmd(dir, &["checkout", "feature"]);
    }

    #[tokio::test]
    async fn resolve_workspace_merge_base_matches_git_merge_base() {
        // Build a repo where both branches have diverged from the branch point so
        // that merge-base != main HEAD and merge-base != feature HEAD.
        let tmp = tempfile::tempdir().unwrap();
        setup_diverged_test_repo(tmp.path());

        // The expected SHA — git's ground truth.
        let expected = merge_base(tmp.path().to_str().unwrap(), "feature", "main")
            .await
            .expect("merge_base helper should succeed");
        assert!(!expected.is_empty(), "expected SHA must not be empty");

        // Sanity-check the divergence: the merge-base (initial commit) must be
        // strictly different from both branch tips so a buggy implementation that
        // returns either tip would fail this test.
        let main_head = git_cmd(tmp.path(), &["rev-parse", "main"]);
        let feature_head = git_cmd(tmp.path(), &["rev-parse", "feature"]);
        assert_ne!(
            expected, main_head,
            "merge-base must not equal main HEAD — divergence requires post-branch main commit"
        );
        assert_ne!(
            expected, feature_head,
            "merge-base must not equal feature HEAD — divergence requires post-branch feature commit"
        );

        // Build an in-memory database with one repo + one workspace.
        let db = crate::db::Database::open_in_memory().unwrap();
        let mut repo =
            crate::db::test_support::make_repo("r1", tmp.path().to_str().unwrap(), "test-repo");
        repo.base_branch = Some("main".into());
        db.insert_repository(&repo).unwrap();

        let mut ws = crate::db::test_support::make_workspace("w1", "r1", "feature-ws");
        ws.worktree_path = Some(tmp.path().to_str().unwrap().into());
        db.insert_workspace(&ws).unwrap();

        let (got_sha, _worktree_path) = resolve_workspace_merge_base(&db, "w1")
            .await
            .expect("resolve_workspace_merge_base should succeed");

        assert_eq!(got_sha, expected);
    }
}
