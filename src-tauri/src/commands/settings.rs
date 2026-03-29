use tauri::State;

use claudette_core::db::Database;

use crate::state::AppState;

#[tauri::command]
pub async fn get_app_setting(
    key: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.get_app_setting(&key).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_app_setting(
    key: String,
    value: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.set_app_setting(&key, &value)
        .map_err(|e| e.to_string())?;

    // If updating worktree base dir, also update in-memory state.
    if key == "worktree_base_dir" {
        let mut dir = state.worktree_base_dir.write().await;
        *dir = std::path::PathBuf::from(&value);
    }

    Ok(())
}
