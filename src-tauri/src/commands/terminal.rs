use tauri::State;

use claudette::db::Database;
use claudette::model::TerminalTab;

use crate::state::AppState;

#[tauri::command]
pub async fn create_terminal_tab(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<TerminalTab, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;

    let max_id = db.max_terminal_tab_id().map_err(|e| e.to_string())?;
    let new_id = max_id + 1;

    let existing = db
        .list_terminal_tabs_by_workspace(&workspace_id)
        .map_err(|e| e.to_string())?;
    let sort_order = existing.len() as i32;

    let tab = TerminalTab {
        id: new_id,
        workspace_id,
        title: format!("Terminal {new_id}"),
        is_script_output: false,
        sort_order,
        created_at: now_iso(),
    };

    db.insert_terminal_tab(&tab).map_err(|e| e.to_string())?;

    Ok(tab)
}

#[tauri::command]
pub async fn delete_terminal_tab(id: i64, state: State<'_, AppState>) -> Result<(), String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.delete_terminal_tab(id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_terminal_tabs(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<TerminalTab>, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.list_terminal_tabs_by_workspace(&workspace_id)
        .map_err(|e| e.to_string())
}

fn now_iso() -> String {
    let dur = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}", dur.as_secs())
}
