use tauri::State;

use claudette::db::Database;
use claudette::diff;
use claudette::git;
use claudette::model::diff::{DiffFile, FileDiff, StagedDiffFiles};

use crate::state::AppState;

#[derive(serde::Serialize)]
pub struct DiffFilesResult {
    pub files: Vec<DiffFile>,
    pub merge_base: String,
    pub staged_files: Option<StagedDiffFiles>,
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

    let base_branch = match repo.base_branch.as_deref() {
        Some(b) => b.to_string(),
        None => git::default_branch(&repo.path, repo.default_remote.as_deref())
            .await
            .map_err(|e| e.to_string())?,
    };

    let merge_base = diff::merge_base(worktree_path, "HEAD", &base_branch)
        .await
        .map_err(|e| e.to_string())?;

    // Get both the flat file list (backward compat) and staged groups
    let (files, staged_files) = tokio::join!(
        diff::changed_files(worktree_path, &merge_base),
        diff::staged_changed_files(worktree_path, &merge_base),
    );

    let files = files.map_err(|e| e.to_string())?;
    let staged_files = staged_files.ok();

    Ok(DiffFilesResult {
        files,
        merge_base,
        staged_files,
    })
}

#[tauri::command]
pub async fn load_file_diff(
    worktree_path: String,
    merge_base: String,
    file_path: String,
    diff_layer: Option<String>,
) -> Result<FileDiff, String> {
    let raw = diff::file_diff_for_layer(
        &worktree_path,
        &merge_base,
        &file_path,
        diff_layer.as_deref(),
    )
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

#[tauri::command]
pub async fn stage_file(worktree_path: String, file_path: String) -> Result<(), String> {
    diff::stage_file(&worktree_path, &file_path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn unstage_file(worktree_path: String, file_path: String) -> Result<(), String> {
    diff::unstage_file(&worktree_path, &file_path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn stage_files(
    worktree_path: String,
    file_paths: Vec<String>,
) -> Result<(), String> {
    diff::stage_files(&worktree_path, &file_paths)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn unstage_files(
    worktree_path: String,
    file_paths: Vec<String>,
) -> Result<(), String> {
    diff::unstage_files(&worktree_path, &file_paths)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn discard_files(
    worktree_path: String,
    tracked: Vec<String>,
    untracked: Vec<String>,
) -> Result<(), String> {
    diff::discard_files(&worktree_path, &tracked, &untracked)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn discard_file(
    worktree_path: String,
    file_path: String,
    is_untracked: bool,
) -> Result<(), String> {
    diff::discard_file(&worktree_path, &file_path, is_untracked)
        .await
        .map_err(|e| e.to_string())
}
