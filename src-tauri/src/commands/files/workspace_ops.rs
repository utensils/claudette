use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

use claudette::db::Database;
use claudette::file_expand;

use crate::state::AppState;

use super::types::{
    FileBytesContent, FileContent, WorkspacePathCreateResult, WorkspacePathMoveResult,
    WorkspacePathRestoreResult, WorkspacePathTrashResult,
};
use super::{platform, trash};

const MAX_VIEWER_BYTES_READ: usize = 25 * 1024 * 1024;
const MAX_VIEWER_FILE_SIZE: usize = 10 * 1024 * 1024;

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

    let absolute = std::path::Path::new(worktree_path).join(&relative_path);
    let is_symlink = is_path_symlink(absolute).await;

    Ok(FileContent {
        path: relative_path,
        content: read.content,
        is_binary: read.is_binary,
        size_bytes: read.size_bytes,
        truncated: read.truncated,
        is_symlink,
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

    let is_symlink = is_path_symlink(target.absolute.clone()).await;

    Ok(FileContent {
        path: relative_path,
        content: read.content,
        is_binary: read.is_binary,
        size_bytes: read.size_bytes,
        truncated: read.truncated,
        is_symlink,
    })
}

/// Probe whether `path` is itself a symlink on disk. Uses
/// `symlink_metadata` (not `metadata`) so it reports the link, not the
/// target. Errors (missing path, permission denied) collapse to `false`
/// — better to leave the gutter on than to silently mislabel a regular
/// file as a symlink and suppress real diff information.
async fn is_path_symlink(path: std::path::PathBuf) -> bool {
    tokio::fs::symlink_metadata(&path)
        .await
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
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
    platform::reveal_path(&resolved.absolute)
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
    let undo_token = trash::trash_path(absolute).await?;

    Ok(WorkspacePathTrashResult {
        old_path,
        is_directory,
        undo_token,
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

    trash::restore_path(target.absolute.clone(), undo_token).await?;
    let is_directory = metadata_is_dir_blocking(target.absolute).await?;
    Ok(WorkspacePathRestoreResult {
        restored_path,
        is_directory,
    })
}

/// Resolve `workspace_id` to its worktree path, returning a string error
/// if the workspace is missing or has no worktree configured.
pub(super) fn resolve_worktree_path(
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
pub(super) struct ResolvedWorkspacePath {
    pub(super) relative: String,
    pub(super) absolute: PathBuf,
    pub(super) is_directory: bool,
}

#[derive(Debug)]
pub(super) struct RenameTarget {
    pub(super) relative: String,
    pub(super) absolute: PathBuf,
}

pub(super) fn normalize_relative_path(relative_path: &str) -> Result<PathBuf, String> {
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

pub(super) fn resolve_existing_workspace_path(
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

pub(super) fn resolve_workspace_target_path(
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

pub(super) fn build_rename_target(
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

pub(super) fn build_create_file_target(
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
