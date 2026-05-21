use std::collections::{BTreeSet, HashMap};

use tauri::State;

use claudette::db::Database;
use claudette::model::diff::{FileStatus, GitFileLayer};

use crate::state::AppState;

use super::types::FileEntry;

const MAX_FILES: usize = 10_000;

/// Per-top-level-directory cap on ignored entries.
///
/// Without a cap, a single noisy ignored tree (e.g. `.direnv/`, `.codex/`,
/// `tmp/cache/`) can fill `MAX_FILES` alphabetically before any tracked
/// file is emitted — `git ls-files` returns paths in collated order and
/// `.`-prefixed names sort before `A-z`. Bucketing by top-level directory
/// keeps every ignored tree below a fair-share cap so tracked content
/// always wins. Root-level ignored files (no `/` in path) share their own
/// bucket under the same cap.
pub(super) const MAX_IGNORED_FILES_PER_TOP_DIR: usize = 200;

/// Top-level directory names that are always excluded from file listings,
/// regardless of `.gitignore`, to avoid overwhelming the panel with
/// dependency/build trees.
const SKIP_DIR_PREFIXES: &[&str] = &[
    "node_modules/",
    "target/",
    ".gradle/",
    "Pods/",
    ".venv/",
    "venv/",
    "__pycache__/",
    ".next/",
    ".nuxt/",
];

pub(super) fn is_high_volume_path(path: &str) -> bool {
    SKIP_DIR_PREFIXES
        .iter()
        .any(|prefix| path.starts_with(prefix))
}

/// Return the top-level bucket key for a path: the segment before the
/// first `/`, including the trailing slash (e.g. `.direnv/`), or the
/// empty string for paths with no separator (root-level files).
pub(super) fn top_level_bucket(path: &str) -> &str {
    match path.find('/') {
        Some(idx) => &path[..=idx],
        None => "",
    }
}

/// List files in a workspace's worktree using `git ls-files`.
///
/// Returns all files — tracked, untracked, and gitignored — capped at 10,000
/// entries, excluding common high-volume build/dependency trees. Paths are
/// relative to the worktree root.
#[tauri::command]
pub async fn list_workspace_files(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<FileEntry>, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let workspaces = db.list_workspaces().map_err(|e| e.to_string())?;
    let ws = workspaces
        .iter()
        .find(|w| w.id == workspace_id)
        .ok_or("Workspace not found")?;
    let worktree_path = ws
        .worktree_path
        .as_ref()
        .ok_or("Workspace has no worktree")?;

    collect_workspace_file_entries(worktree_path).await
}

/// Stream `git ls-files` from `worktree_path` in two passes:
///
/// 1. **Tracked + untracked-not-ignored** via `--cached --others
///    --exclude-standard -z`. Capped at `MAX_FILES`. These are the files
///    the user is most likely to care about; they always win.
/// 2. **Ignored only** via `--others --ignored --exclude-standard -z`. Each
///    top-level directory bucket (e.g. `.direnv/`, `tmp/`, root) is capped
///    at `MAX_IGNORED_FILES_PER_TOP_DIR` so a single noisy ignored tree
///    can't starve pass 1 alphabetically — `.`-prefixed names sort before
///    `A-z` so without a per-bucket cap a huge `.direnv/` would consume
///    the cap before any tracked file is emitted (this was the regression
///    in #694).
///
/// Uses NUL-delimited output (`-z`) so filenames with newlines or special
/// characters are handled correctly without git's path quoting.
pub(super) async fn collect_workspace_file_entries(
    worktree_path: &str,
) -> Result<Vec<FileEntry>, String> {
    let file_tree_status = claudette::diff::file_tree_git_status_with_suppressed(worktree_path)
        .await
        .map_err(|e| format!("Failed to load git status: {e}"))?;
    let git_status = file_tree_status.statuses;
    let suppressed_paths = file_tree_status.suppressed_paths;

    let mut dirs = BTreeSet::new();
    let mut seen_files = BTreeSet::new();
    let mut entries: Vec<FileEntry> = Vec::new();

    // Pass 1: tracked + untracked-not-ignored. Annotate with git status.
    stream_ls_files(
        worktree_path,
        &[
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ],
        &mut |path| {
            if entries.len() >= MAX_FILES {
                return StreamCallback::Stop;
            }
            if suppressed_paths.contains(path) || is_high_volume_path(path) {
                return StreamCallback::Skip;
            }
            let status = git_status.get(path);
            record_file_entry(
                path,
                status.map(|s| s.status.clone()),
                status.map(|s| s.layer),
                &mut entries,
                &mut seen_files,
                &mut dirs,
            );
            StreamCallback::Keep
        },
    )
    .await?;

    // `git status` may surface paths that `git ls-files --cached --others
    // --exclude-standard` doesn't (e.g. unstaged deletions), so fold them
    // in before pass 2.
    for (path, status) in &git_status {
        if entries.len() >= MAX_FILES || seen_files.contains(path) || is_high_volume_path(path) {
            continue;
        }
        record_file_entry(
            path,
            Some(status.status.clone()),
            Some(status.layer),
            &mut entries,
            &mut seen_files,
            &mut dirs,
        );
    }

    // Pass 2: ignored entries with per-top-level-dir fair-share cap.
    let mut ignored_per_bucket: HashMap<String, usize> = HashMap::new();
    stream_ls_files(
        worktree_path,
        &[
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "-z",
        ],
        &mut |path| {
            if entries.len() >= MAX_FILES {
                return StreamCallback::Stop;
            }
            if seen_files.contains(path)
                || suppressed_paths.contains(path)
                || is_high_volume_path(path)
            {
                return StreamCallback::Skip;
            }
            let bucket = top_level_bucket(path).to_string();
            let count = ignored_per_bucket.entry(bucket).or_insert(0);
            if *count >= MAX_IGNORED_FILES_PER_TOP_DIR {
                return StreamCallback::Skip;
            }
            *count += 1;
            // Ignored entries get no git status badge — neither tracked
            // nor in `git status`'s untracked set.
            record_file_entry(path, None, None, &mut entries, &mut seen_files, &mut dirs);
            StreamCallback::Keep
        },
    )
    .await?;

    let dir_entries: Vec<FileEntry> = dirs
        .into_iter()
        .map(|path| FileEntry {
            path,
            is_directory: true,
            git_status: None,
            git_layer: None,
        })
        .collect();
    entries.splice(0..0, dir_entries);

    Ok(entries)
}

/// Outcome the streaming callback returns for each emitted path.
#[derive(Clone, Copy)]
enum StreamCallback {
    /// Path was accepted into the result set.
    Keep,
    /// Path was filtered out; keep streaming the next entry.
    Skip,
    /// Caller-imposed cap reached; stop reading and kill the child.
    Stop,
}

/// Spawn `git <args>` against `worktree_path` and feed each NUL-delimited
/// path to `on_path`. Returns when git exits or the callback returns
/// `Stop` (in which case the child is killed).
async fn stream_ls_files(
    worktree_path: &str,
    args: &[&str],
    on_path: &mut (dyn FnMut(&str) -> StreamCallback + Send),
) -> Result<(), String> {
    use tokio::io::{AsyncBufReadExt, BufReader};

    let mut child = claudette::process::command(claudette::git::resolve_git_path_blocking())
        .args(["-C", worktree_path])
        .args(args)
        .stdout(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn git ls-files: {e}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or("Failed to capture git ls-files stdout")?;
    let mut reader = BufReader::new(stdout);
    let mut buf = Vec::new();

    loop {
        buf.clear();
        let n = reader
            .read_until(0, &mut buf)
            .await
            .map_err(|e| format!("Failed to read git ls-files output: {e}"))?;
        if n == 0 {
            break;
        }
        if buf.last() == Some(&0) {
            buf.pop();
        }
        if buf.is_empty() {
            continue;
        }
        let path = match std::str::from_utf8(&buf) {
            Ok(s) => s,
            Err(_) => continue,
        };
        match on_path(path) {
            StreamCallback::Keep | StreamCallback::Skip => {}
            StreamCallback::Stop => {
                let _ = child.kill().await;
                break;
            }
        }
    }

    let _ = child.wait().await;
    Ok(())
}

/// Insert a file entry plus all of its parent directories into the
/// accumulator structures. Centralized so the two passes stay consistent
/// in how they extract the directory tree.
fn record_file_entry(
    path: &str,
    git_status: Option<FileStatus>,
    git_layer: Option<GitFileLayer>,
    entries: &mut Vec<FileEntry>,
    seen_files: &mut BTreeSet<String>,
    dirs: &mut BTreeSet<String>,
) {
    seen_files.insert(path.to_string());
    let mut pos = 0;
    while let Some(slash) = path[pos..].find('/') {
        let dir_end = pos + slash;
        dirs.insert(path[..=dir_end].to_string());
        pos = dir_end + 1;
    }
    entries.push(FileEntry {
        path: path.to_string(),
        is_directory: false,
        git_status,
        git_layer,
    });
}
