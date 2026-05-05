use tauri::State;

use claudette::db::Database;
use claudette::diff;
use claudette::model::diff::{CommitEntry, DiffFile, FileDiff, StagedDiffFiles};

use crate::state::AppState;

#[derive(serde::Serialize)]
pub struct DiffFilesResult {
    pub files: Vec<DiffFile>,
    pub merge_base: String,
    pub staged_files: Option<StagedDiffFiles>,
    pub commits: Vec<CommitEntry>,
}

#[tauri::command]
pub async fn load_diff_files(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<DiffFilesResult, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;

    let (merge_base, worktree_path) =
        diff::resolve_workspace_merge_base(&db, &workspace_id).await?;
    let worktree_path = &worktree_path;

    // Get both the flat file list (backward compat) and staged groups
    let (files, staged_files, commits) = tokio::join!(
        diff::changed_files(worktree_path, &merge_base),
        diff::staged_changed_files(worktree_path, &merge_base),
        diff::commits_in_range(worktree_path, &merge_base),
    );

    let files = files.map_err(|e| e.to_string())?;
    let staged_files = staged_files.ok();
    let commits = commits.unwrap_or_default();

    Ok(DiffFilesResult {
        files,
        merge_base,
        staged_files,
        commits,
    })
}

/// Lightweight sibling of `load_diff_files` that returns only the workspace's
/// merge-base SHA. Used by the file viewer's git gutter when the user has
/// selected the "Workspace branch base" comparison and the SHA isn't already
/// cached in the diff slice (e.g. they opened a file before the Changes
/// panel ever ran).
#[tauri::command]
pub async fn compute_workspace_merge_base(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    diff::resolve_workspace_merge_base(&db, &workspace_id)
        .await
        .map(|(sha, _)| sha)
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
pub async fn stage_files(worktree_path: String, file_paths: Vec<String>) -> Result<(), String> {
    diff::stage_files(&worktree_path, &file_paths)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn unstage_files(worktree_path: String, file_paths: Vec<String>) -> Result<(), String> {
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

#[tauri::command]
pub async fn load_commit_file_diff(
    worktree_path: String,
    commit_hash: String,
    file_path: String,
) -> Result<FileDiff, String> {
    let raw = diff::commit_file_diff(&worktree_path, &commit_hash, &file_path)
        .await
        .map_err(|e| e.to_string())?;
    Ok(diff::parse_unified_diff(&raw, &file_path))
}
