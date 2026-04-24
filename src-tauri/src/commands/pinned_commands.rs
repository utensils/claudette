use tauri::State;

use claudette::db::Database;
use claudette::model::PinnedCommand;

use crate::state::AppState;

#[tauri::command]
pub async fn get_pinned_commands(
    repo_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<PinnedCommand>, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.list_pinned_commands(&repo_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pin_command(
    repo_id: String,
    command_name: String,
    state: State<'_, AppState>,
) -> Result<PinnedCommand, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.insert_pinned_command(&repo_id, &command_name)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn unpin_command(id: i64, state: State<'_, AppState>) -> Result<(), String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.delete_pinned_command(id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn reorder_pinned_commands(
    repo_id: String,
    ids: Vec<i64>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.reorder_pinned_commands(&repo_id, &ids)
        .map_err(|e| e.to_string())
}
