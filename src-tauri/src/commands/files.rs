use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;
use tokio::process::Command;

use claudette::db::Database;
use claudette::file_expand;
use claudette::model::diff::{FileStatus, GitFileLayer};

use crate::state::AppState;
use claudette::process::CommandWindowExt as _;

const MAX_FILES: usize = 10_000;

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

fn is_high_volume_path(path: &str) -> bool {
    SKIP_DIR_PREFIXES.iter().any(|prefix| path.starts_with(prefix))
}

#[derive(Clone, Serialize)]
pub struct FileEntry {
    pub path: String,
    pub is_directory: bool,
    pub git_status: Option<FileStatus>,
    pub git_layer: Option<GitFileLayer>,
}

#[derive(Clone, Serialize)]
pub struct FileContent {
    pub path: String,
    pub content: Option<String>,
    pub is_binary: bool,
    pub size_bytes: u64,
    pub truncated: bool,
}

#[derive(Clone, Serialize)]
pub struct FileBytesContent {
    pub path: String,
    /// Base64-encoded bytes. Used for image rendering in the file viewer
    /// where we want to embed the bytes as a data URL on the frontend.
    pub bytes_b64: String,
    pub size_bytes: u64,
    pub truncated: bool,
}

#[derive(Clone, Serialize)]
pub struct WorkspacePathMoveResult {
    pub old_path: String,
    pub new_path: String,
    pub is_directory: bool,
}

#[derive(Clone, Serialize)]
pub struct WorkspacePathTrashResult {
    pub old_path: String,
    pub is_directory: bool,
    pub undo_token: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct WorkspacePathCreateResult {
    pub path: String,
}

#[derive(Clone, Serialize)]
pub struct WorkspacePathRestoreResult {
    pub restored_path: String,
    pub is_directory: bool,
}

/// Hard cap for raw-bytes reads (e.g. image previews). Larger than the
/// editor cap because image files frequently exceed 5 MB but we still
/// want to bound memory pressure on a single open.
const MAX_VIEWER_BYTES_READ: usize = 25 * 1024 * 1024;

/// Hard cap for the file viewer's text reads. Beyond this we refuse to
/// open the file for editing — the user would have to use a different
/// editor for files this size, and Monaco/CodeMirror struggle past this
/// point too.
const MAX_VIEWER_FILE_SIZE: usize = 10 * 1024 * 1024;

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

/// Stream `git ls-files --cached --others -z` from `worktree_path`, stopping
/// after `MAX_FILES` accepted entries and skipping high-volume directory trees.
/// Uses NUL-delimited output (`-z`) so filenames with newlines or special
/// characters are handled correctly without git's path quoting.
async fn collect_workspace_file_entries(worktree_path: &str) -> Result<Vec<FileEntry>, String> {
    use tokio::io::{AsyncBufReadExt, BufReader};

    let mut child = Command::new(claudette::git::resolve_git_path_blocking())
        .no_console_window()
        .args(["-C", worktree_path])
        .args(["ls-files", "--cached", "--others", "-z"])
        .stdout(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn git ls-files: {e}"))?;

    let file_tree_status = claudette::diff::file_tree_git_status_with_suppressed(worktree_path)
        .await
        .map_err(|e| format!("Failed to load git status: {e}"))?;
    let git_status = file_tree_status.statuses;
    let suppressed_paths = file_tree_status.suppressed_paths;

    let stdout = child
        .stdout
        .take()
        .ok_or("Failed to capture git ls-files stdout")?;
    let mut reader = BufReader::new(stdout);

    let mut dirs = std::collections::BTreeSet::new();
    let mut seen_files = std::collections::BTreeSet::new();
    let mut entries: Vec<FileEntry> = Vec::new();
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
        let line = match std::str::from_utf8(&buf) {
            Ok(s) => s,
            Err(_) => continue,
        };

        if suppressed_paths.contains(line) || is_high_volume_path(line) {
            continue;
        }

        if entries.len() >= MAX_FILES {
            let _ = child.kill().await;
            break;
        }

        let status = git_status.get(line);
        seen_files.insert(line.to_string());
        let mut pos = 0;
        while let Some(slash) = line[pos..].find('/') {
            let dir_end = pos + slash;
            dirs.insert(line[..=dir_end].to_string());
            pos = dir_end + 1;
        }
        entries.push(FileEntry {
            path: line.to_string(),
            is_directory: false,
            git_status: status.map(|s| s.status.clone()),
            git_layer: status.map(|s| s.layer),
        });
    }

    let _ = child.wait().await;

    for (path, status) in &git_status {
        if entries.len() >= MAX_FILES
            || seen_files.contains(path)
            || is_high_volume_path(path)
        {
            continue;
        }
        let mut pos = 0;
        while let Some(slash) = path[pos..].find('/') {
            let dir_end = pos + slash;
            dirs.insert(path[..=dir_end].to_string());
            pos = dir_end + 1;
        }
        seen_files.insert(path.clone());
        entries.push(FileEntry {
            path: path.clone(),
            is_directory: false,
            git_status: Some(status.status.clone()),
            git_layer: Some(status.layer),
        });
    }

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

/// Read a file from a workspace's worktree.
///
/// Delegates to the shared `read_worktree_file` helper for path-traversal
/// protection, binary detection, and 100 KB truncation.
#[tauri::command]
pub async fn read_workspace_file(
    workspace_id: String,
    relative_path: String,
    state: State<'_, AppState>,
) -> Result<FileContent, String> {
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

    let read = file_expand::read_worktree_file(std::path::Path::new(worktree_path), &relative_path)
        .await
        .ok_or("File not found or path escapes worktree")?;

    Ok(FileContent {
        path: relative_path,
        content: read.content,
        is_binary: read.is_binary,
        size_bytes: read.size_bytes,
        truncated: read.truncated,
    })
}

/// Read a file from a workspace's worktree with the file-viewer/editor
/// truncation cap (10 MB) instead of the default 100 KB. Used by the
/// All-Files file viewer where the user has explicitly asked to open the
/// file. Binary detection still applies — binaries return
/// `content: None, is_binary: true`.
#[tauri::command]
pub async fn read_workspace_file_for_viewer(
    workspace_id: String,
    relative_path: String,
    state: State<'_, AppState>,
) -> Result<FileContent, String> {
    let worktree_path = resolve_worktree_path(&workspace_id, &state)?;
    let target =
        resolve_workspace_target_path_blocking(worktree_path.clone(), relative_path.clone())
            .await?;

    let read = file_expand::read_worktree_file_with_limit(
        std::path::Path::new(&worktree_path),
        &relative_path,
        MAX_VIEWER_FILE_SIZE,
    )
    .await;

    let Some(read) = read else {
        if !tokio::fs::try_exists(&target.absolute)
            .await
            .map_err(|e| format!("check file exists: {e}"))?
        {
            return Err("WORKSPACE_FILE_NOT_FOUND".to_string());
        }
        return Err("File not readable or path escapes worktree".to_string());
    };

    Ok(FileContent {
        path: relative_path,
        content: read.content,
        is_binary: read.is_binary,
        size_bytes: read.size_bytes,
        truncated: read.truncated,
    })
}

/// Read raw bytes from a file in a workspace's worktree, base64-encoded
/// for transport. Used by the file viewer to render image previews via a
/// data URL. The read is capped at `MAX_VIEWER_BYTES_READ` (25 MB) to
/// bound memory pressure.
#[tauri::command]
pub async fn read_workspace_file_bytes(
    workspace_id: String,
    relative_path: String,
    state: State<'_, AppState>,
) -> Result<FileBytesContent, String> {
    use base64::Engine as _;

    let worktree_path = resolve_worktree_path(&workspace_id, &state)?;

    let read = file_expand::read_worktree_file_bytes(
        std::path::Path::new(&worktree_path),
        &relative_path,
        MAX_VIEWER_BYTES_READ,
    )
    .await
    .ok_or("File not found or path escapes worktree")?;

    let bytes_b64 = base64::engine::general_purpose::STANDARD.encode(&read.bytes);
    Ok(FileBytesContent {
        path: relative_path,
        bytes_b64,
        size_bytes: read.size_bytes,
        truncated: read.truncated,
    })
}

#[derive(Clone, Serialize)]
pub struct BlobAtRevisionContent {
    pub path: String,
    /// The revision the blob was read at. Echoed back so the caller can
    /// distinguish responses across in-flight requests.
    pub revision: String,
    /// Some(text) for tracked text blobs; None for binary blobs at the
    /// revision, oversized blobs, or when the file doesn't exist at the
    /// revision.
    pub content: Option<String>,
    /// false when the path is not tracked at the revision (untracked /
    /// staged-only / not on the branch / not in the SHA's tree).
    pub exists_at_revision: bool,
}

/// Read a file's blob contents at the given `revision`. Used by the file
/// viewer's git gutter to compute per-line decorations against either HEAD
/// (default) or the workspace's merge-base with the repo's base branch.
///
/// `revision` must be either the literal string `"HEAD"` or a 40-char hex
/// SHA — anything else is rejected by `git::read_blob_at_revision` and
/// surfaces here as an `Err(String)`. The frontend treats errors as "gutter
/// unavailable for this revision" and silently disables markers — they are
/// not surfaced as toasts.
#[tauri::command]
pub async fn read_workspace_file_at_revision(
    workspace_id: String,
    relative_path: String,
    revision: String,
    state: State<'_, AppState>,
) -> Result<BlobAtRevisionContent, String> {
    let worktree_path = resolve_worktree_path(&workspace_id, &state)?;
    let result = claudette::git::read_blob_at_revision(&worktree_path, &relative_path, &revision)
        .await
        .map_err(|e| e.to_string())?;
    Ok(BlobAtRevisionContent {
        path: relative_path,
        revision,
        content: result.content,
        exists_at_revision: result.exists_at_revision,
    })
}

/// Write UTF-8 text to a file in a workspace's worktree. Path-traversal
/// protected. Creates the file if missing; truncates if it exists.
///
/// Returns an error string on failure (path escapes, IO error). The
/// frontend surfaces these via the toast notification system.
#[tauri::command]
pub async fn write_workspace_file(
    workspace_id: String,
    relative_path: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let worktree_path = resolve_worktree_path(&workspace_id, &state)?;

    file_expand::write_worktree_file(
        std::path::Path::new(&worktree_path),
        &relative_path,
        &content,
    )
    .await
}

#[tauri::command]
pub async fn resolve_workspace_path(
    workspace_id: String,
    relative_path: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let worktree_path = resolve_worktree_path(&workspace_id, &state)?;
    let resolved = resolve_existing_workspace_path_blocking(worktree_path, relative_path).await?;
    Ok(resolved.absolute.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn open_workspace_path(
    workspace_id: String,
    relative_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let worktree_path = resolve_worktree_path(&workspace_id, &state)?;
    let resolved = resolve_existing_workspace_path_blocking(worktree_path, relative_path).await?;
    crate::commands::shell::opener::open(&resolved.absolute.to_string_lossy())
        .map_err(|e| format!("open failed: {e}"))
}

#[tauri::command]
pub async fn reveal_workspace_path(
    workspace_id: String,
    relative_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let worktree_path = resolve_worktree_path(&workspace_id, &state)?;
    let resolved = resolve_existing_workspace_path_blocking(worktree_path, relative_path).await?;
    reveal_path(&resolved.absolute)
}

#[tauri::command]
pub async fn create_workspace_file(
    workspace_id: String,
    parent_relative_path: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<WorkspacePathCreateResult, String> {
    let worktree_path = resolve_worktree_path(&workspace_id, &state)?;
    let target =
        build_create_file_target_blocking(worktree_path, parent_relative_path, name).await?;
    let file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target.absolute)
        .await
        .map_err(|e| format!("create file: {e}"))?;
    drop(file);
    Ok(WorkspacePathCreateResult {
        path: target.relative,
    })
}

#[tauri::command]
pub async fn rename_workspace_path(
    workspace_id: String,
    relative_path: String,
    new_name: String,
    state: State<'_, AppState>,
) -> Result<WorkspacePathMoveResult, String> {
    let worktree_path = resolve_worktree_path(&workspace_id, &state)?;
    let resolved =
        resolve_existing_workspace_path_blocking(worktree_path.clone(), relative_path).await?;
    let rename =
        build_rename_target_blocking(worktree_path, resolved.relative.clone(), new_name).await?;
    let from = resolved.absolute;
    let to = rename.absolute;
    let old_path = resolved.relative;
    let new_path = rename.relative;
    let is_directory = resolved.is_directory;

    tokio::fs::rename(&from, &to)
        .await
        .map_err(|e| format!("rename: {e}"))?;

    Ok(WorkspacePathMoveResult {
        old_path,
        new_path,
        is_directory,
    })
}

#[tauri::command]
pub async fn trash_workspace_path(
    workspace_id: String,
    relative_path: String,
    state: State<'_, AppState>,
) -> Result<WorkspacePathTrashResult, String> {
    let worktree_path = resolve_worktree_path(&workspace_id, &state)?;
    let resolved = resolve_existing_workspace_path_blocking(worktree_path, relative_path).await?;
    let old_path = resolved.relative;
    let is_directory = resolved.is_directory;
    let absolute = resolved.absolute;

    #[cfg(target_os = "macos")]
    let undo_token = tokio::task::spawn_blocking(move || trash_path_macos(&absolute))
        .await
        .map_err(|e| format!("join error: {e}"))??;

    #[cfg(not(target_os = "macos"))]
    {
        let undo_token = tokio::task::spawn_blocking(move || {
            let absolute_for_token = absolute.clone();
            trash::delete(&absolute).map_err(|e| format!("move to trash: {e}"))?;
            Ok::<Option<String>, String>(find_trash_item_token_for_original(&absolute_for_token))
        })
        .await
        .map_err(|e| format!("join error: {e}"))??;
        return Ok(WorkspacePathTrashResult {
            old_path,
            is_directory,
            undo_token,
        });
    }

    #[cfg(target_os = "macos")]
    Ok(WorkspacePathTrashResult {
        old_path,
        is_directory,
        undo_token: Some(undo_token),
    })
}

#[tauri::command]
pub async fn restore_workspace_path_from_trash(
    workspace_id: String,
    relative_path: String,
    undo_token: Option<String>,
    state: State<'_, AppState>,
) -> Result<WorkspacePathRestoreResult, String> {
    let worktree_path = resolve_worktree_path(&workspace_id, &state)?;
    let target = resolve_workspace_target_path_blocking(worktree_path, relative_path).await?;
    ensure_restore_target_available_blocking(target.absolute.clone()).await?;

    let restored_path = target.relative;

    #[cfg(target_os = "macos")]
    {
        let token = undo_token.ok_or_else(|| "missing trash undo token".to_string())?;
        let target_abs = target.absolute.clone();
        tokio::task::spawn_blocking(move || restore_path_macos(&token, &target_abs))
            .await
            .map_err(|e| format!("join error: {e}"))??;
        let is_directory = metadata_is_dir_blocking(target.absolute).await?;
        Ok(WorkspacePathRestoreResult {
            restored_path,
            is_directory,
        })
    }

    #[cfg(any(
        target_os = "windows",
        all(
            unix,
            not(target_os = "macos"),
            not(target_os = "ios"),
            not(target_os = "android")
        )
    ))]
    {
        let target_abs = target.absolute.clone();
        tokio::task::spawn_blocking(move || {
            let items = trash::os_limited::list().map_err(|e| format!("list trash: {e}"))?;
            let item = select_trash_item(items, &target_abs, undo_token.as_deref())
                .ok_or_else(|| "trash item not found".to_string())?;
            trash::os_limited::restore_all(vec![item]).map_err(|e| format!("restore: {e}"))
        })
        .await
        .map_err(|e| format!("join error: {e}"))??;
        let is_directory = metadata_is_dir_blocking(target.absolute).await?;
        return Ok(WorkspacePathRestoreResult {
            restored_path,
            is_directory,
        });
    }

    #[cfg(not(any(
        target_os = "macos",
        target_os = "windows",
        all(unix, not(target_os = "ios"), not(target_os = "android"))
    )))]
    {
        let _ = undo_token;
        Err("trash restore is not supported on this platform".to_string())
    }
}

/// Resolve `workspace_id` to its worktree path, returning a string error
/// if the workspace is missing or has no worktree configured.
fn resolve_worktree_path(
    workspace_id: &str,
    state: &State<'_, AppState>,
) -> Result<String, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let workspaces = db.list_workspaces().map_err(|e| e.to_string())?;
    let ws = workspaces
        .iter()
        .find(|w| w.id == workspace_id)
        .ok_or("Workspace not found")?;
    ws.worktree_path
        .clone()
        .ok_or_else(|| "Workspace has no worktree".to_string())
}

async fn resolve_existing_workspace_path_blocking(
    worktree_path: String,
    relative_path: String,
) -> Result<ResolvedWorkspacePath, String> {
    tokio::task::spawn_blocking(move || {
        resolve_existing_workspace_path(Path::new(&worktree_path), &relative_path)
    })
    .await
    .map_err(|e| format!("path resolution task failed: {e}"))?
}

async fn resolve_workspace_target_path_blocking(
    worktree_path: String,
    relative_path: String,
) -> Result<ResolvedWorkspacePath, String> {
    tokio::task::spawn_blocking(move || {
        resolve_workspace_target_path(Path::new(&worktree_path), &relative_path)
    })
    .await
    .map_err(|e| format!("path resolution task failed: {e}"))?
}

async fn build_rename_target_blocking(
    worktree_path: String,
    old_relative: String,
    new_name: String,
) -> Result<RenameTarget, String> {
    tokio::task::spawn_blocking(move || {
        build_rename_target(Path::new(&worktree_path), &old_relative, &new_name)
    })
    .await
    .map_err(|e| format!("path resolution task failed: {e}"))?
}

async fn build_create_file_target_blocking(
    worktree_path: String,
    parent_relative_path: String,
    name: String,
) -> Result<RenameTarget, String> {
    tokio::task::spawn_blocking(move || {
        build_create_file_target(Path::new(&worktree_path), &parent_relative_path, &name)
    })
    .await
    .map_err(|e| format!("path resolution task failed: {e}"))?
}

async fn metadata_is_dir_blocking(path: PathBuf) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || {
        std::fs::metadata(path)
            .map(|metadata| metadata.is_dir())
            .map_err(|e| format!("metadata: {e}"))
    })
    .await
    .map_err(|e| format!("metadata task failed: {e}"))?
}

async fn ensure_restore_target_available_blocking(path: PathBuf) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        if path.exists() {
            return Err("restore target already exists".to_string());
        }
        let parent = path
            .parent()
            .ok_or_else(|| "restore target has no parent".to_string())?;
        if !parent.exists() {
            return Err("restore parent does not exist".to_string());
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("path validation task failed: {e}"))?
}

#[derive(Debug)]
struct ResolvedWorkspacePath {
    relative: String,
    absolute: PathBuf,
    is_directory: bool,
}

#[derive(Debug)]
struct RenameTarget {
    relative: String,
    absolute: PathBuf,
}

fn normalize_relative_path(relative_path: &str) -> Result<PathBuf, String> {
    let trimmed = relative_path.trim().trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        return Err("path is empty".to_string());
    }
    let path = Path::new(trimmed);
    if path.is_absolute() {
        return Err("absolute paths are not allowed".to_string());
    }
    if path.components().any(|component| {
        matches!(
            component,
            std::path::Component::ParentDir
                | std::path::Component::RootDir
                | std::path::Component::Prefix(_)
        )
    }) {
        return Err("path escapes worktree".to_string());
    }
    Ok(path.to_path_buf())
}

fn relative_path_string(path: &Path) -> Result<String, String> {
    path.to_str()
        .map(|s| s.replace('\\', "/"))
        .ok_or_else(|| "path is not valid UTF-8".to_string())
}

fn resolve_existing_workspace_path(
    worktree_path: &Path,
    relative_path: &str,
) -> Result<ResolvedWorkspacePath, String> {
    let relative = normalize_relative_path(relative_path)?;
    let worktree_canonical =
        std::fs::canonicalize(worktree_path).map_err(|e| format!("canonicalize worktree: {e}"))?;
    let absolute = std::fs::canonicalize(worktree_path.join(&relative))
        .map_err(|e| format!("path not found: {e}"))?;
    if !absolute.starts_with(&worktree_canonical) {
        return Err("path escapes worktree".to_string());
    }
    let metadata = std::fs::metadata(&absolute).map_err(|e| format!("metadata: {e}"))?;
    Ok(ResolvedWorkspacePath {
        relative: relative_path_string(&relative)?,
        absolute,
        is_directory: metadata.is_dir(),
    })
}

fn resolve_workspace_target_path(
    worktree_path: &Path,
    relative_path: &str,
) -> Result<ResolvedWorkspacePath, String> {
    let relative = normalize_relative_path(relative_path)?;
    let worktree_canonical =
        std::fs::canonicalize(worktree_path).map_err(|e| format!("canonicalize worktree: {e}"))?;
    let parent_relative = relative.parent().unwrap_or_else(|| Path::new(""));
    let parent_abs = if parent_relative.as_os_str().is_empty() {
        worktree_canonical.clone()
    } else {
        std::fs::canonicalize(worktree_path.join(parent_relative))
            .map_err(|e| format!("canonicalize parent: {e}"))?
    };
    if !parent_abs.starts_with(&worktree_canonical) {
        return Err("path escapes worktree".to_string());
    }
    let file_name = relative
        .file_name()
        .ok_or_else(|| "path has no file name".to_string())?;
    Ok(ResolvedWorkspacePath {
        relative: relative_path_string(&relative)?,
        absolute: parent_abs.join(file_name),
        is_directory: false,
    })
}

fn validate_rename_name(new_name: &str) -> Result<&str, String> {
    let trimmed = new_name.trim();
    if trimmed.is_empty() {
        return Err("name is empty".to_string());
    }
    if trimmed == "." || trimmed == ".." {
        return Err("name is reserved".to_string());
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err("name cannot contain path separators".to_string());
    }
    if trimmed.contains('\0') {
        return Err("name cannot contain null bytes".to_string());
    }
    Ok(trimmed)
}

fn build_rename_target(
    worktree_path: &Path,
    old_relative: &str,
    new_name: &str,
) -> Result<RenameTarget, String> {
    let old_relative_path = normalize_relative_path(old_relative)?;
    let parent_relative = old_relative_path.parent().unwrap_or_else(|| Path::new(""));
    let name = validate_rename_name(new_name)?;
    let new_relative_path = parent_relative.join(name);

    let worktree_canonical =
        std::fs::canonicalize(worktree_path).map_err(|e| format!("canonicalize worktree: {e}"))?;
    let parent_abs = if parent_relative.as_os_str().is_empty() {
        worktree_canonical.clone()
    } else {
        std::fs::canonicalize(worktree_path.join(parent_relative))
            .map_err(|e| format!("canonicalize parent: {e}"))?
    };
    if !parent_abs.starts_with(&worktree_canonical) {
        return Err("path escapes worktree".to_string());
    }

    let absolute = parent_abs.join(name);
    if absolute.exists() {
        return Err("target already exists".to_string());
    }

    Ok(RenameTarget {
        relative: relative_path_string(&new_relative_path)?,
        absolute,
    })
}

fn build_create_file_target(
    worktree_path: &Path,
    parent_relative_path: &str,
    name: &str,
) -> Result<RenameTarget, String> {
    let parent_trimmed = parent_relative_path.trim().trim_end_matches(['/', '\\']);
    let parent_relative = if parent_trimmed.is_empty() {
        PathBuf::new()
    } else {
        normalize_relative_path(parent_trimmed)?
    };
    let name = validate_rename_name(name)?;
    let worktree_canonical =
        std::fs::canonicalize(worktree_path).map_err(|e| format!("canonicalize worktree: {e}"))?;
    let parent_abs = if parent_relative.as_os_str().is_empty() {
        worktree_canonical.clone()
    } else {
        std::fs::canonicalize(worktree_path.join(&parent_relative))
            .map_err(|e| format!("canonicalize parent: {e}"))?
    };
    if !parent_abs.starts_with(&worktree_canonical) {
        return Err("path escapes worktree".to_string());
    }
    if !parent_abs.is_dir() {
        return Err("parent is not a directory".to_string());
    }
    let relative = parent_relative.join(name);
    let absolute = parent_abs.join(name);
    if absolute.exists() {
        return Err("target already exists".to_string());
    }
    Ok(RenameTarget {
        relative: relative_path_string(&relative)?,
        absolute,
    })
}

fn reveal_path(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("open")
            .no_console_window()
            .arg("-R")
            .arg(path)
            .output()
            .map_err(|e| format!("failed to run open: {e}"))?;
        if output.status.success() {
            return Ok(());
        }
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .no_console_window()
            .arg(format!("/select,{}", path.to_string_lossy()))
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("failed to run explorer: {e}"))
    }

    #[cfg(target_os = "linux")]
    {
        let target = if path.is_dir() {
            path
        } else {
            path.parent().unwrap_or(path)
        };
        crate::commands::shell::opener::open(&target.to_string_lossy())
            .map_err(|e| format!("open failed: {e}"))
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let target = if path.is_dir() {
            path
        } else {
            path.parent().unwrap_or(path)
        };
        crate::commands::shell::opener::open(&target.to_string_lossy())
            .map_err(|e| format!("open failed: {e}"))
    }
}

#[cfg(target_os = "macos")]
fn trash_path_macos(path: &Path) -> Result<String, String> {
    let trash_dir = home_trash_dir()?;
    std::fs::create_dir_all(&trash_dir).map_err(|e| format!("create trash dir: {e}"))?;
    let file_name = path
        .file_name()
        .ok_or_else(|| "path has no file name".to_string())?;
    let mut target = trash_dir.join(file_name);
    if target.exists() {
        let stem = path.file_stem().unwrap_or(file_name).to_string_lossy();
        let ext = path.extension().map(|ext| ext.to_string_lossy());
        for idx in 1..10_000 {
            let candidate_name = match &ext {
                Some(ext) if !ext.is_empty() => format!("{stem} {idx}.{ext}"),
                _ => format!("{stem} {idx}"),
            };
            let candidate = trash_dir.join(candidate_name);
            if !candidate.exists() {
                target = candidate;
                break;
            }
        }
    }
    if target.exists() {
        return Err("could not choose a unique trash name".to_string());
    }
    move_to_trash_path_macos(path, &target)?;
    Ok(target.to_string_lossy().into_owned())
}

#[cfg(target_os = "macos")]
fn move_to_trash_path_macos(path: &Path, target: &Path) -> Result<(), String> {
    match std::fs::rename(path, target) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::CrossesDevices => {
            copy_to_trash_path_macos(path, target)?;
            let remove_result = if path.is_dir() {
                std::fs::remove_dir_all(path).map_err(|e| format!("remove trashed dir: {e}"))
            } else {
                std::fs::remove_file(path).map_err(|e| format!("remove trashed file: {e}"))
            };
            if let Err(err) = remove_result {
                cleanup_trash_copy_macos(target);
                return Err(err);
            }
            Ok(())
        }
        Err(err) => Err(format!("move to trash: {err}")),
    }
}

#[cfg(target_os = "macos")]
fn copy_to_trash_path_macos(path: &Path, target: &Path) -> Result<(), String> {
    let result = if path.is_dir() {
        copy_dir_all_macos(path, target)
    } else {
        std::fs::copy(path, target)
            .map(|_| ())
            .map_err(|e| format!("copy to trash: {e}"))
    };
    if result.is_err() {
        let _ = if target.is_dir() {
            std::fs::remove_dir_all(target)
        } else {
            std::fs::remove_file(target)
        };
    }
    result
}

#[cfg(target_os = "macos")]
fn cleanup_trash_copy_macos(target: &Path) {
    let Ok(metadata) = std::fs::symlink_metadata(target) else {
        return;
    };
    let _ = if metadata.is_dir() {
        std::fs::remove_dir_all(target)
    } else {
        std::fs::remove_file(target)
    };
}

#[cfg(target_os = "macos")]
fn copy_dir_all_macos(source: &Path, target: &Path) -> Result<(), String> {
    std::fs::create_dir(target).map_err(|e| format!("copy trash dir: {e}"))?;
    for entry in std::fs::read_dir(source).map_err(|e| format!("read dir: {e}"))? {
        let entry = entry.map_err(|e| format!("read dir entry: {e}"))?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|e| format!("read file type: {e}"))?;
        if file_type.is_dir() {
            copy_dir_all_macos(&source_path, &target_path)?;
        } else if file_type.is_file() {
            std::fs::copy(&source_path, &target_path)
                .map_err(|e| format!("copy trash file: {e}"))?;
        } else if file_type.is_symlink() {
            let link_target =
                std::fs::read_link(&source_path).map_err(|e| format!("read symlink: {e}"))?;
            std::os::unix::fs::symlink(link_target, &target_path)
                .map_err(|e| format!("copy trash symlink: {e}"))?;
        } else {
            return Err(format!(
                "unsupported file type at {}",
                source_path.display()
            ));
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn restore_path_macos(undo_token: &str, target: &Path) -> Result<(), String> {
    let trash_dir = home_trash_dir()?;
    let trash_path = PathBuf::from(undo_token);
    // The undo token is a path supplied by the frontend, so canonicalize it and
    // verify Trash containment before restoring anything from it.
    let trash_canonical =
        std::fs::canonicalize(&trash_path).map_err(|e| format!("trash item not found: {e}"))?;
    let trash_dir_canonical =
        std::fs::canonicalize(&trash_dir).map_err(|e| format!("canonicalize trash dir: {e}"))?;
    if !trash_canonical.starts_with(&trash_dir_canonical) {
        return Err("trash undo token is outside the Trash".to_string());
    }
    std::fs::rename(&trash_canonical, target).map_err(|e| format!("restore from trash: {e}"))
}

#[cfg(target_os = "macos")]
fn home_trash_dir() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or_else(|| "HOME is not set".to_string())?;
    Ok(PathBuf::from(home).join(".Trash"))
}

#[cfg(not(target_os = "macos"))]
fn find_trash_item_token_for_original(original_path: &Path) -> Option<String> {
    #[cfg(any(
        target_os = "windows",
        all(unix, not(target_os = "ios"), not(target_os = "android"))
    ))]
    {
        let original = original_path
            .canonicalize()
            .unwrap_or_else(|_| original_path.to_path_buf());
        let mut items: Vec<_> = trash::os_limited::list()
            .ok()?
            .into_iter()
            .filter(|item| item.original_path() == original)
            .collect();
        // Some platforms expose coarse deletion timestamps, so two rapid
        // deletes of the same original path can be ambiguous. Prefer the
        // newest item as the best available restore token.
        items.sort_by_key(|item| item.time_deleted);
        return items
            .pop()
            .map(|item| item.id.to_string_lossy().into_owned());
    }

    #[cfg(not(any(
        target_os = "windows",
        all(unix, not(target_os = "ios"), not(target_os = "android"))
    )))]
    {
        let _ = original_path;
        None
    }
}

#[cfg(any(
    target_os = "windows",
    all(
        unix,
        not(target_os = "macos"),
        not(target_os = "ios"),
        not(target_os = "android")
    )
))]
fn select_trash_item(
    items: Vec<trash::TrashItem>,
    original_path: &Path,
    undo_token: Option<&str>,
) -> Option<trash::TrashItem> {
    let mut matches: Vec<_> = items
        .into_iter()
        .filter(|item| {
            let token_matches = undo_token
                .map(|token| item.id.to_string_lossy() == token)
                .unwrap_or(false);
            token_matches || item.original_path() == original_path
        })
        .collect();
    matches.sort_by_key(|item| item.time_deleted);
    matches.pop()
}

/// Write raw bytes to a filesystem path chosen by the user via a save dialog.
///
/// The frontend opens the OS save dialog itself (via `@tauri-apps/plugin-dialog`)
/// and passes the resulting absolute path plus the attachment bytes here. We
/// reject relative paths defensively — the dialog only ever yields absolute
/// paths, but accepting relatives would let callers write into the CWD of the
/// running app, which is rarely what the user expects.
pub fn write_bytes_to_absolute_path(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if !path.is_absolute() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "path must be absolute",
        ));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, bytes)
}

#[tauri::command]
pub async fn save_attachment_bytes(path: String, bytes: Vec<u8>) -> Result<(), String> {
    let target = PathBuf::from(&path);
    tokio::task::spawn_blocking(move || write_bytes_to_absolute_path(&target, &bytes))
        .await
        .map_err(|e| format!("join error: {e}"))?
        .map_err(|e| format!("failed to save to {path}: {e}"))
}

/// Write attachment bytes to a temp HTML wrapper and open it with the system
/// default handler (typically the user's browser).
///
/// Wrapping in HTML is deliberate: `open path.png` routes to the default image
/// viewer (e.g. Preview on macOS), but `open path.html` routes to the browser
/// on every platform we support. That matches the user's expectation of
/// "Open in New Window" — a web page containing the image.
pub fn write_image_as_html(
    dir: &Path,
    filename_stem: &str,
    media_type: &str,
    bytes: &[u8],
) -> std::io::Result<PathBuf> {
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    let safe_stem = sanitize_stem(filename_stem);
    let title = html_escape(filename_stem);
    let safe_media = html_escape(media_type);
    // Include a unique suffix so opening the same attachment twice (or two
    // differently-chatted files that share a filename stem) doesn't clobber
    // the previous wrapper while it's still open in the user's browser.
    let unique: u128 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let html = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>{title}</title>\
         <style>body{{margin:0;background:#111;display:flex;align-items:center;justify-content:center;min-height:100vh}}\
         img{{max-width:100vw;max-height:100vh}}</style>\
         <img src=\"data:{safe_media};base64,{b64}\" alt=\"{title}\">"
    );
    let path = dir.join(format!("{safe_stem}-{unique}.html"));
    std::fs::write(&path, html)?;
    Ok(path)
}

fn sanitize_stem(s: &str) -> String {
    let stem: String = s
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if stem.is_empty() {
        "attachment".to_string()
    } else {
        stem
    }
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

#[tauri::command]
pub async fn open_attachment_in_browser(
    bytes: Vec<u8>,
    filename: String,
    media_type: String,
) -> Result<(), String> {
    let dir = std::env::temp_dir().join("claudette-attachments");
    tokio::task::spawn_blocking(move || -> Result<PathBuf, String> {
        std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir temp dir: {e}"))?;
        let stem = Path::new(&filename)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("attachment");
        write_image_as_html(&dir, stem, &media_type, &bytes).map_err(|e| format!("write html: {e}"))
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
    .and_then(|path| {
        crate::commands::shell::opener::open(&path.to_string_lossy())
            .map_err(|e| format!("open failed: {e}"))
    })
}

/// Pick a sensible file extension for a media type. Used when staging an
/// attachment to a temp file so the OS routes the open-with handler to the
/// right app (e.g. `.pdf` → Preview / Adobe / etc).
///
/// Common types that have a canonical extension different from their MIME
/// subtype (`text/plain` → `txt`, `image/jpeg` → `jpg`, `+json` types → `json`)
/// get an explicit mapping. Everything else falls back to the subtype with
/// any `+xml` / `+json` suffix stripped.
///
/// Returns a `Cow<'static, str>` so the explicit-map cases (the common
/// path) cost nothing, while the catch-all case yields an owned `String`
/// without leaking memory across sessions.
fn extension_for_media_type(media_type: &str) -> std::borrow::Cow<'static, str> {
    use std::borrow::Cow;
    match media_type {
        "text/plain" => return Cow::Borrowed("txt"),
        "text/html" => return Cow::Borrowed("html"),
        "text/css" => return Cow::Borrowed("css"),
        "text/javascript" | "application/javascript" => return Cow::Borrowed("js"),
        "image/jpeg" => return Cow::Borrowed("jpg"),
        "image/svg+xml" => return Cow::Borrowed("svg"),
        "application/pdf" => return Cow::Borrowed("pdf"),
        "application/json" => return Cow::Borrowed("json"),
        "application/zip" => return Cow::Borrowed("zip"),
        _ => {}
    }
    // `+json` suffixed types (application/ld+json, application/vnd.api+json…)
    // route to the json viewer naturally.
    if media_type.ends_with("+json") {
        return Cow::Borrowed("json");
    }
    if media_type.ends_with("+xml") {
        return Cow::Borrowed("xml");
    }
    // Last-resort fallback: trust the subtype iff it looks safe.
    let after_slash = media_type.rsplit_once('/').map(|p| p.1).unwrap_or("");
    if !after_slash.is_empty()
        && after_slash
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
    {
        Cow::Owned(after_slash.to_string())
    } else {
        Cow::Borrowed("bin")
    }
}

/// Write attachment bytes to a temp file using the natural file extension
/// for the media type. Unlike [`write_image_as_html`], this writes the raw
/// bytes (no wrapper) so `open` routes to the system default handler for
/// the format — Preview / Adobe Reader for PDFs, etc.
///
/// On Unix the file is created with `0o600` (owner read/write only) so
/// other local accounts can't peek at potentially sensitive content
/// stashed under the shared temp dir.
pub fn write_attachment_to_temp_file(
    dir: &Path,
    filename: &str,
    media_type: &str,
    bytes: &[u8],
) -> std::io::Result<PathBuf> {
    let stem = Path::new(filename)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("attachment");
    let safe_stem = sanitize_stem(stem);
    let ext = extension_for_media_type(media_type);
    // Unique nanosecond suffix so re-opening the same attachment twice
    // doesn't overwrite a staged file that the system viewer may still
    // be holding open.
    let unique: u128 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path = dir.join(format!("{safe_stem}-{unique}.{ext}"));
    write_owner_only(&path, bytes)?;
    Ok(path)
}

#[cfg(target_os = "macos")]
fn copy_file_path_to_clipboard(path: &Path) -> Result<(), String> {
    let output = std::process::Command::new("osascript")
        .args([
            "-e",
            "on run argv",
            "-e",
            "set the clipboard to POSIX file (item 1 of argv)",
            "-e",
            "end run",
        ])
        .arg(path)
        .output()
        .map_err(|e| format!("failed to run osascript: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("osascript failed: {}", stderr.trim()))
    }
}

#[cfg(target_os = "linux")]
fn copy_file_path_to_clipboard(path: &Path) -> Result<(), String> {
    let uri = url::Url::from_file_path(path)
        .map_err(|_| format!("failed to create file URI for {}", path.display()))?
        .to_string();
    let gnome_files = format!("copy\n{uri}\n");
    let uri_list = format!("{uri}\n");

    let attempts: [(&str, &[&str], &str); 5] = [
        (
            "wl-copy",
            &["--type", "x-special/gnome-copied-files"],
            &gnome_files,
        ),
        ("wl-copy", &["--type", "text/uri-list"], &uri_list),
        (
            "xclip",
            &[
                "-selection",
                "clipboard",
                "-t",
                "x-special/gnome-copied-files",
            ],
            &gnome_files,
        ),
        (
            "xclip",
            &["-selection", "clipboard", "-t", "text/uri-list"],
            &uri_list,
        ),
        ("xclip", &["-selection", "clipboard"], &uri),
    ];

    let mut errors = Vec::new();
    for (program, args, input) in attempts {
        match pipe_to_command(program, args, input.as_bytes()) {
            Ok(()) => return Ok(()),
            Err(e) => errors.push(format!("{program}: {e}")),
        }
    }
    Err(format!(
        "copying files requires wl-copy or xclip on Linux ({})",
        errors.join("; ")
    ))
}

#[cfg(target_os = "linux")]
fn pipe_to_command(program: &str, args: &[&str], input: &[u8]) -> Result<(), String> {
    use std::io::Write as _;
    use std::process::Stdio;

    let mut child = std::process::Command::new(program)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "failed to open stdin".to_string())?;
    stdin.write_all(input).map_err(|e| e.to_string())?;
    drop(stdin);
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[cfg(windows)]
fn copy_file_path_to_clipboard(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt as _;
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
    };
    use windows_sys::Win32::System::Memory::{GHND, GlobalAlloc, GlobalLock, GlobalUnlock};
    use windows_sys::Win32::System::Ole::CF_HDROP;
    use windows_sys::Win32::UI::Shell::DROPFILES;

    struct ClipboardGuard;
    impl Drop for ClipboardGuard {
        fn drop(&mut self) {
            unsafe {
                CloseClipboard();
            }
        }
    }

    let mut wide_path: Vec<u16> = path.as_os_str().encode_wide().collect();
    // CF_HDROP expects one NUL after each path plus one extra NUL to end
    // the file list.
    wide_path.push(0);
    wide_path.push(0);

    let header_size = std::mem::size_of::<DROPFILES>();
    let bytes_len = header_size + wide_path.len() * std::mem::size_of::<u16>();
    unsafe {
        let hmem = GlobalAlloc(GHND, bytes_len);
        if hmem.is_null() {
            return Err("GlobalAlloc failed".to_string());
        }
        let ptr = GlobalLock(hmem);
        if ptr.is_null() {
            return Err("GlobalLock failed".to_string());
        }

        let header = DROPFILES {
            pFiles: header_size as u32,
            pt: std::mem::zeroed(),
            fNC: 0,
            fWide: 1,
        };
        std::ptr::copy_nonoverlapping(
            &header as *const DROPFILES as *const u8,
            ptr as *mut u8,
            header_size,
        );
        std::ptr::copy_nonoverlapping(
            wide_path.as_ptr() as *const u8,
            (ptr as *mut u8).add(header_size),
            wide_path.len() * std::mem::size_of::<u16>(),
        );
        GlobalUnlock(hmem);

        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return Err("OpenClipboard failed".to_string());
        }
        let _guard = ClipboardGuard;
        if EmptyClipboard() == 0 {
            return Err("EmptyClipboard failed".to_string());
        }
        if SetClipboardData(CF_HDROP as u32, hmem).is_null() {
            return Err("SetClipboardData failed".to_string());
        }
    }
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn copy_file_path_to_clipboard(_path: &Path) -> Result<(), String> {
    Err("file clipboard copy is not supported on this platform".to_string())
}

/// Write `bytes` to `path`, creating the file with restrictive permissions
/// on Unix (`0o600`). On Windows ACLs handle this differently — a regular
/// `fs::write` is fine.
fn write_owner_only(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write as _;
        use std::os::unix::fs::OpenOptionsExt as _;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        f.write_all(bytes)?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, bytes)
    }
}

/// Create the staging directory with restrictive permissions on Unix
/// (`0o700`) so other accounts can't list or read the staged files. If
/// the path already exists we verify it's a real directory (not a file
/// or symlink that could redirect writes elsewhere) and re-tighten the
/// permissions on Unix in case a previous run created it with a wider
/// umask.
fn create_staging_dir(dir: &Path) -> std::io::Result<()> {
    if dir.exists() {
        // `symlink_metadata` doesn't follow symlinks — it tells us
        // whether the *path entry* is a directory, so a malicious link
        // to /etc can't satisfy the check.
        let meta = std::fs::symlink_metadata(dir)?;
        if !meta.file_type().is_dir() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                format!(
                    "staging path {} exists and is not a directory",
                    dir.display()
                ),
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = meta.permissions().mode() & 0o777;
            if mode != 0o700 {
                std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
            }
        }
        return Ok(());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt as _;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(dir)
    }
}

/// Remove staged attachments older than `max_age` from `dir`. Used to keep
/// the temp staging directory from growing unboundedly across sessions —
/// PDFs in particular can be 10+ MB each. Errors during cleanup are
/// swallowed: a stale file that we couldn't delete this run will be tried
/// again on the next open.
pub fn cleanup_stale_attachments(dir: &Path, max_age: std::time::Duration) {
    cleanup_stale_attachments_at(dir, max_age, std::time::SystemTime::now());
}

/// Testable variant of [`cleanup_stale_attachments`] — `now` is injected
/// so the test doesn't need to manipulate file mtimes.
fn cleanup_stale_attachments_at(
    dir: &Path,
    max_age: std::time::Duration,
    now: std::time::SystemTime,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let Ok(modified) = meta.modified() else {
            continue;
        };
        let Ok(age) = now.duration_since(modified) else {
            continue;
        };
        if age >= max_age {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Open an attachment with the system's default handler for its media
/// type (e.g. PDF → Preview on macOS, the user's PDF reader on Linux /
/// Windows). Bytes are staged to a temp file under the OS temp dir with
/// owner-only permissions; stale stages older than 24 h are reaped on
/// each open so the directory doesn't grow without bound.
#[tauri::command]
pub async fn open_attachment_with_default_app(
    bytes: Vec<u8>,
    filename: String,
    media_type: String,
) -> Result<(), String> {
    let dir = std::env::temp_dir().join("claudette-attachments");
    tokio::task::spawn_blocking(move || -> Result<PathBuf, String> {
        create_staging_dir(&dir).map_err(|e| format!("mkdir temp dir: {e}"))?;
        // Reap files older than a day — keeps the directory bounded
        // without yanking the rug out from under an app the user may
        // still have open. Cleanup errors are non-fatal.
        cleanup_stale_attachments(&dir, std::time::Duration::from_secs(24 * 60 * 60));
        write_attachment_to_temp_file(&dir, &filename, &media_type, &bytes)
            .map_err(|e| format!("write attachment: {e}"))
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
    .and_then(|path| {
        crate::commands::shell::opener::open(&path.to_string_lossy())
            .map_err(|e| format!("open failed: {e}"))
    })
}

/// Stage an attachment to a temp file and put that file on the system
/// clipboard. Used for document-like attachments such as PDFs where the
/// browser ClipboardItem API either rejects the MIME type or reports success
/// without producing a useful paste target.
#[tauri::command]
pub async fn copy_attachment_file_to_clipboard(
    bytes: Vec<u8>,
    filename: String,
    media_type: String,
) -> Result<(), String> {
    let dir = std::env::temp_dir().join("claudette-attachments");
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        create_staging_dir(&dir).map_err(|e| format!("mkdir temp dir: {e}"))?;
        cleanup_stale_attachments(&dir, std::time::Duration::from_secs(24 * 60 * 60));
        let path = write_attachment_to_temp_file(&dir, &filename, &media_type, &bytes)
            .map_err(|e| format!("write attachment: {e}"))?;
        copy_file_path_to_clipboard(&path)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn list_includes_gitignored_files() {
        let dir = tempdir().unwrap();
        let root = dir.path();

        // Bootstrap a minimal git repo with one commit so HEAD exists.
        for args in [
            vec!["init"],
            vec!["config", "user.email", "test@test.com"],
            vec!["config", "user.name", "Test"],
        ] {
            std::process::Command::new("git")
                .args(&args)
                .current_dir(root)
                .output()
                .unwrap();
        }
        std::fs::write(root.join("tracked.txt"), "hello").unwrap();
        for args in [vec!["add", "tracked.txt"], vec!["commit", "-m", "init"]] {
            std::process::Command::new("git")
                .args(&args)
                .current_dir(root)
                .output()
                .unwrap();
        }

        // Create a gitignored file that an agent might produce for local use.
        std::fs::write(root.join(".gitignore"), "local-notes.md\n").unwrap();
        std::fs::write(root.join("local-notes.md"), "agent docs").unwrap();

        let entries = collect_workspace_file_entries(&root.to_string_lossy())
            .await
            .unwrap();

        let files: Vec<&str> = entries
            .iter()
            .filter(|e| !e.is_directory)
            .map(|e| e.path.as_str())
            .collect();
        assert!(files.contains(&"tracked.txt"), "tracked file must appear");
        assert!(
            files.contains(&"local-notes.md"),
            "gitignored file must appear; got: {files:?}"
        );

        let ignored = entries.iter().find(|e| e.path == "local-notes.md").unwrap();
        assert!(
            ignored.git_status.is_none(),
            "gitignored file should carry no git status badge"
        );
    }

    #[test]
    fn high_volume_path_matches_known_dirs() {
        assert!(is_high_volume_path("node_modules/react/index.js"));
        assert!(is_high_volume_path("target/debug/build/foo"));
        assert!(is_high_volume_path(".next/static/chunks/main.js"));
        assert!(!is_high_volume_path("src/node_modules_helper.rs"));
        assert!(!is_high_volume_path("mytarget/foo"));
    }

    #[test]
    fn write_bytes_to_absolute_path_creates_parent_dirs() {
        let dir = tempdir().unwrap();
        let nested = dir.path().join("sub").join("dir").join("out.bin");
        write_bytes_to_absolute_path(&nested, b"hello").unwrap();
        assert_eq!(std::fs::read(&nested).unwrap(), b"hello");
    }

    #[test]
    fn write_bytes_to_absolute_path_rejects_relative() {
        let err = write_bytes_to_absolute_path(Path::new("relative.bin"), b"x").unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput);
    }

    #[test]
    fn write_bytes_to_absolute_path_overwrites_existing() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("file.bin");
        write_bytes_to_absolute_path(&p, b"first").unwrap();
        write_bytes_to_absolute_path(&p, b"second").unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"second");
    }

    #[test]
    fn write_image_as_html_embeds_data_url() {
        let dir = tempdir().unwrap();
        let path =
            write_image_as_html(dir.path(), "cat photo.png", "image/png", b"\x89PNG").unwrap();
        assert_eq!(path.extension().unwrap(), "html");
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(
            content.contains("data:image/png;base64,iVBORw==")
                || content.contains("data:image/png;base64,")
        );
        assert!(content.contains("<title>cat photo.png</title>"));
    }

    #[test]
    fn write_image_as_html_escapes_hostile_media_type() {
        let dir = tempdir().unwrap();
        let path =
            write_image_as_html(dir.path(), "x", "image/png\" onload=\"alert(1)", b"\x89PNG")
                .unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(!content.contains("onload=\"alert(1)"));
        assert!(content.contains("&quot;"));
    }

    #[test]
    fn write_image_as_html_uses_unique_suffix() {
        let dir = tempdir().unwrap();
        let p1 = write_image_as_html(dir.path(), "x", "image/png", b"a").unwrap();
        std::thread::sleep(std::time::Duration::from_nanos(1));
        let p2 = write_image_as_html(dir.path(), "x", "image/png", b"b").unwrap();
        assert_ne!(p1, p2);
    }

    #[test]
    fn sanitize_stem_replaces_unsafe_chars() {
        assert_eq!(sanitize_stem("hello world.png"), "hello_world_png");
        assert_eq!(sanitize_stem("../../etc/passwd"), "______etc_passwd");
        assert_eq!(sanitize_stem(""), "attachment");
    }

    #[test]
    fn html_escape_handles_special_chars() {
        assert_eq!(html_escape(r#"a<b>&"c"#), "a&lt;b&gt;&amp;&quot;c");
    }

    #[test]
    fn extension_for_media_type_picks_pdf_for_pdf_type() {
        assert_eq!(extension_for_media_type("application/pdf"), "pdf");
    }

    #[test]
    fn extension_for_media_type_uses_real_extensions_not_subtypes() {
        // text/plain → txt (not "plain"); subtypes that aren't valid file
        // extensions get a sensible mapping so the OS routes to the right
        // viewer/editor.
        assert_eq!(extension_for_media_type("text/plain"), "txt");
        assert_eq!(extension_for_media_type("application/json"), "json");
        assert_eq!(extension_for_media_type("application/ld+json"), "json");
        assert_eq!(extension_for_media_type("text/html"), "html");
    }

    #[test]
    fn extension_for_media_type_strips_xml_suffix() {
        assert_eq!(extension_for_media_type("image/svg+xml"), "svg");
    }

    #[test]
    fn extension_for_media_type_falls_back_to_bin_for_opaque_types() {
        assert_eq!(
            extension_for_media_type("application/x-something weird"),
            "bin"
        );
    }

    #[test]
    fn write_attachment_to_temp_file_uses_natural_extension() {
        let dir = tempdir().unwrap();
        let path = write_attachment_to_temp_file(
            dir.path(),
            "claude-system-card.pdf",
            "application/pdf",
            b"%PDF-1.4 fake",
        )
        .unwrap();
        assert_eq!(path.extension().unwrap(), "pdf");
        assert_eq!(std::fs::read(&path).unwrap(), b"%PDF-1.4 fake");
    }

    #[test]
    fn write_attachment_to_temp_file_sanitizes_filename() {
        let dir = tempdir().unwrap();
        let path = write_attachment_to_temp_file(
            dir.path(),
            "hello world.pdf",
            "application/pdf",
            b"%PDF",
        )
        .unwrap();
        let stem = path.file_stem().unwrap().to_str().unwrap();
        assert!(!stem.contains(' '));
        assert!(stem.starts_with("hello_world"));
    }

    #[test]
    fn write_attachment_to_temp_file_uses_unique_suffix() {
        let dir = tempdir().unwrap();
        let p1 =
            write_attachment_to_temp_file(dir.path(), "doc.pdf", "application/pdf", b"a").unwrap();
        std::thread::sleep(std::time::Duration::from_nanos(1));
        let p2 =
            write_attachment_to_temp_file(dir.path(), "doc.pdf", "application/pdf", b"b").unwrap();
        assert_ne!(p1, p2);
    }

    #[cfg(unix)]
    #[test]
    fn write_attachment_to_temp_file_uses_owner_only_perms() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = tempdir().unwrap();
        let path =
            write_attachment_to_temp_file(dir.path(), "secret.pdf", "application/pdf", b"%PDF")
                .unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        // Only the owner should be able to read the staged file — these
        // can contain user data that other local accounts shouldn't see.
        assert_eq!(mode, 0o600, "expected 0o600, got {mode:o}");
    }

    #[test]
    fn cleanup_stale_attachments_removes_old_files() {
        use std::time::Duration;
        let dir = tempdir().unwrap();
        let old_path = dir.path().join("old.pdf");
        let fresh_path = dir.path().join("fresh.pdf");
        std::fs::write(&old_path, b"old").unwrap();
        // Sleep so the fresh file has a strictly newer mtime than the old
        // one (file system mtime resolution is ~1 ms on most platforms).
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(&fresh_path, b"fresh").unwrap();

        // Pretend "now" is far in the future, just past the fresh file's
        // mtime — the old file lands beyond the cleanup threshold while
        // the fresh one is still inside it.
        let fresh_mtime = std::fs::metadata(&fresh_path).unwrap().modified().unwrap();
        let now = fresh_mtime + Duration::from_millis(5);
        cleanup_stale_attachments_at(dir.path(), Duration::from_millis(15), now);

        assert!(!old_path.exists(), "old file should be removed");
        assert!(fresh_path.exists(), "fresh file should be kept");
    }

    #[test]
    fn cleanup_stale_attachments_is_noop_when_dir_missing() {
        // Must not panic / error when the staging directory hasn't been
        // created yet (first ever open after install).
        let dir = tempdir().unwrap();
        let missing = dir.path().join("does-not-exist");
        cleanup_stale_attachments_at(
            &missing,
            std::time::Duration::from_secs(0),
            std::time::SystemTime::now(),
        );
    }

    #[test]
    fn create_staging_dir_creates_when_missing() {
        let parent = tempdir().unwrap();
        let target = parent.path().join("claudette-staging");
        assert!(!target.exists());
        create_staging_dir(&target).unwrap();
        assert!(target.is_dir());
    }

    #[test]
    fn create_staging_dir_rejects_a_regular_file_at_the_path() {
        let parent = tempdir().unwrap();
        let target = parent.path().join("not-a-dir");
        std::fs::write(&target, b"oops").unwrap();
        let err = create_staging_dir(&target).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);
    }

    #[cfg(unix)]
    #[test]
    fn create_staging_dir_tightens_permissions_on_existing_dir() {
        use std::os::unix::fs::PermissionsExt as _;
        let parent = tempdir().unwrap();
        let target = parent.path().join("loose-dir");
        // Pre-create with a wider mode (e.g. a previous run with a
        // permissive umask).
        std::fs::create_dir(&target).unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).unwrap();
        create_staging_dir(&target).unwrap();
        let mode = std::fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700, "expected 0o700, got {mode:o}");
    }

    #[test]
    fn rename_target_rejects_invalid_names() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("file.txt"), "hello").unwrap();

        for name in ["", "   ", ".", "..", "a/b", r"a\b"] {
            let err = build_rename_target(dir.path(), "file.txt", name).unwrap_err();
            assert!(!err.is_empty());
        }
    }

    #[test]
    fn rename_target_rejects_path_escape() {
        let dir = tempdir().unwrap();
        let err = build_rename_target(dir.path(), "../file.txt", "next.txt").unwrap_err();
        assert!(err.contains("escapes worktree"), "got: {err}");
    }

    #[test]
    fn rename_target_rejects_absolute_source_paths() {
        let dir = tempdir().unwrap();
        let err = build_rename_target(dir.path(), "/file.txt", "next.txt").unwrap_err();
        assert!(err.contains("absolute paths"), "got: {err}");
    }

    #[test]
    fn rename_target_rejects_collisions() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("file.txt"), "hello").unwrap();
        std::fs::write(dir.path().join("other.txt"), "world").unwrap();

        let err = build_rename_target(dir.path(), "file.txt", "other.txt").unwrap_err();
        assert!(err.contains("already exists"), "got: {err}");
    }

    #[test]
    fn rename_target_keeps_file_in_same_parent() {
        let dir = tempdir().unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        std::fs::write(dir.path().join("sub").join("file.txt"), "hello").unwrap();

        let target = build_rename_target(dir.path(), "sub/file.txt", "other.txt").unwrap();

        assert_eq!(target.relative, "sub/other.txt");
        assert_eq!(
            target.absolute,
            dir.path()
                .join("sub")
                .canonicalize()
                .unwrap()
                .join("other.txt")
        );
    }

    #[test]
    fn rename_target_handles_directory_paths_with_trailing_slash() {
        let dir = tempdir().unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();

        let target = build_rename_target(dir.path(), "sub/", "renamed").unwrap();

        assert_eq!(target.relative, "renamed");
        assert_eq!(
            target.absolute,
            dir.path().canonicalize().unwrap().join("renamed")
        );
    }

    #[test]
    fn create_file_target_allows_root_parent() {
        let dir = tempdir().unwrap();

        let target = build_create_file_target(dir.path(), "", "new.txt").unwrap();

        assert_eq!(target.relative, "new.txt");
        assert_eq!(
            target.absolute,
            dir.path().canonicalize().unwrap().join("new.txt")
        );
    }

    #[test]
    fn create_file_target_rejects_collisions_and_nested_names() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("existing.txt"), "hello").unwrap();

        let collision = build_create_file_target(dir.path(), "", "existing.txt").unwrap_err();
        assert!(collision.contains("already exists"), "got: {collision}");

        let nested = build_create_file_target(dir.path(), "", "nested/file.txt").unwrap_err();
        assert!(nested.contains("separators"), "got: {nested}");
    }

    #[test]
    fn create_file_target_requires_existing_directory_parent() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("file.txt"), "hello").unwrap();

        let err = build_create_file_target(dir.path(), "file.txt", "child.txt").unwrap_err();

        assert!(err.contains("parent is not a directory"), "got: {err}");
    }

    #[test]
    fn resolve_existing_workspace_path_identifies_directories() {
        let dir = tempdir().unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();

        let resolved = resolve_existing_workspace_path(dir.path(), "sub/").unwrap();

        assert_eq!(resolved.relative, "sub");
        assert!(resolved.is_directory);
        assert_eq!(
            resolved.absolute,
            dir.path().join("sub").canonicalize().unwrap()
        );
    }

    #[test]
    fn resolve_workspace_target_path_allows_missing_leaf() {
        let dir = tempdir().unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();

        let resolved = resolve_workspace_target_path(dir.path(), "sub/restored.txt").unwrap();

        assert_eq!(resolved.relative, "sub/restored.txt");
        assert_eq!(
            resolved.absolute,
            dir.path()
                .join("sub")
                .canonicalize()
                .unwrap()
                .join("restored.txt")
        );
    }

    #[test]
    fn resolve_workspace_target_path_rejects_missing_parent() {
        let dir = tempdir().unwrap();

        let err = resolve_workspace_target_path(dir.path(), "missing/restored.txt").unwrap_err();

        assert!(err.contains("canonicalize parent"), "got: {err}");
    }
}
