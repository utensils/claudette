use serde::Serialize;
use tauri::State;
use tokio::process::Command;

use claudette::db::Database;
use claudette::file_expand;

use crate::state::AppState;
use claudette::process::CommandWindowExt as _;

const MAX_FILES: usize = 10_000;

#[derive(Clone, Serialize)]
pub struct FileEntry {
    pub path: String,
    pub is_directory: bool,
}

#[derive(Clone, Serialize)]
pub struct FileContent {
    pub path: String,
    pub content: Option<String>,
    pub is_binary: bool,
    pub size_bytes: u64,
    pub truncated: bool,
}

/// List files in a workspace's worktree using `git ls-files`.
///
/// Returns tracked files plus untracked-but-not-ignored files, capped at 10,000
/// entries. Paths are relative to the worktree root.
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

    let output = Command::new("git").no_console_window()
        .args(["-C", worktree_path])
        .args(["ls-files", "--cached", "--others", "--exclude-standard"])
        .output()
        .await
        .map_err(|e| format!("Failed to run git ls-files: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git ls-files failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);

    // Collect file entries and extract unique directory paths.
    let mut dirs = std::collections::BTreeSet::new();
    let mut entries: Vec<FileEntry> = stdout
        .lines()
        .filter(|line| !line.is_empty())
        .take(MAX_FILES)
        .map(|line| {
            // Extract all parent directories from the file path.
            let mut pos = 0;
            while let Some(slash) = line[pos..].find('/') {
                let dir_end = pos + slash;
                dirs.insert(line[..=dir_end].to_string());
                pos = dir_end + 1;
            }
            FileEntry {
                path: line.to_string(),
                is_directory: false,
            }
        })
        .collect();

    // Prepend directory entries (sorted alphabetically by BTreeSet).
    let dir_entries: Vec<FileEntry> = dirs
        .into_iter()
        .map(|path| FileEntry {
            path,
            is_directory: true,
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
