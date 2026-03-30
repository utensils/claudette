use tauri::State;

use claudette::db::Database;
use claudette::diff;
use claudette::git;
use claudette::model::diff::{DiffFile, FileDiff};

use crate::state::AppState;

#[derive(serde::Serialize)]
pub struct DiffFilesResult {
    pub files: Vec<DiffFile>,
    pub merge_base: String,
}

#[tauri::command]
pub async fn load_diff_files(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<DiffFilesResult, String> {
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

    let repos = db.list_repositories().map_err(|e| e.to_string())?;
    let repo = repos
        .iter()
        .find(|r| r.id == ws.repository_id)
        .ok_or("Repository not found")?;

    let base_branch = git::default_branch(&repo.path)
        .await
        .map_err(|e| e.to_string())?;

    let merge_base = diff::merge_base(worktree_path, "HEAD", &base_branch)
        .await
        .map_err(|e| e.to_string())?;

    let files = diff::changed_files(worktree_path, &merge_base)
        .await
        .map_err(|e| e.to_string())?;

    Ok(DiffFilesResult { files, merge_base })
}

#[tauri::command]
pub async fn load_file_diff(
    worktree_path: String,
    merge_base: String,
    file_path: String,
) -> Result<FileDiff, String> {
    let raw = diff::file_diff(&worktree_path, &merge_base, &file_path)
        .await
        .map_err(|e| e.to_string())?;

    Ok(diff::parse_unified_diff(&raw, &file_path))
}

#[tauri::command]
pub async fn revert_file(
    worktree_path: String,
    merge_base: String,
    file_path: String,
    status: String,
) -> Result<(), String> {
    let file_status = match status.as_str() {
        "Added" => claudette::model::diff::FileStatus::Added,
        "Deleted" => claudette::model::diff::FileStatus::Deleted,
        _ => claudette::model::diff::FileStatus::Modified,
    };

    diff::revert_file(&worktree_path, &merge_base, &file_path, &file_status)
        .await
        .map_err(|e| e.to_string())
}
