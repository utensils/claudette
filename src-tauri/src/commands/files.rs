use serde::Serialize;
use tauri::State;
use tokio::process::Command;

use claudette::db::Database;

use crate::state::AppState;

const MAX_FILES: usize = 10_000;
const MAX_FILE_SIZE: u64 = 100 * 1024; // 100 KB

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

    let output = Command::new("git")
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
/// Validates that the resolved path stays within the worktree (path traversal
/// protection). Detects binary files by scanning the first 8 KB for null bytes.
/// Truncates content at 100 KB.
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

    // Path traversal protection: canonicalize both paths and verify containment.
    let worktree_canonical = tokio::fs::canonicalize(worktree_path)
        .await
        .map_err(|e| format!("Failed to resolve worktree path: {e}"))?;
    let joined = std::path::Path::new(worktree_path).join(&relative_path);
    let file_canonical = tokio::fs::canonicalize(&joined)
        .await
        .map_err(|e| format!("File not found: {e}"))?;

    if !file_canonical.starts_with(&worktree_canonical) {
        return Err("Path traversal denied: path escapes worktree".to_string());
    }

    let metadata = tokio::fs::metadata(&file_canonical)
        .await
        .map_err(|e| format!("Cannot read file metadata: {e}"))?;
    let size_bytes = metadata.len();

    // Read file bytes (cap read at MAX_FILE_SIZE + 1 to detect truncation).
    let raw = tokio::fs::read(&file_canonical)
        .await
        .map_err(|e| format!("Failed to read file: {e}"))?;

    // Binary detection: check first 8 KB for null bytes.
    let check_len = raw.len().min(8192);
    if raw[..check_len].contains(&0) {
        return Ok(FileContent {
            path: relative_path,
            content: None,
            is_binary: true,
            size_bytes,
            truncated: false,
        });
    }

    let truncated = raw.len() as u64 > MAX_FILE_SIZE;
    let usable = if truncated {
        &raw[..MAX_FILE_SIZE as usize]
    } else {
        &raw[..]
    };

    let text = String::from_utf8_lossy(usable).into_owned();

    Ok(FileContent {
        path: relative_path,
        content: Some(text),
        is_binary: false,
        size_bytes,
        truncated,
    })
}
