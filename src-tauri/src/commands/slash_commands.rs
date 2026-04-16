use std::path::PathBuf;

use tauri::State;

use claudette::db::Database;
use claudette::slash_commands::{self, SlashCommand};

use crate::state::AppState;

#[tauri::command]
pub async fn list_slash_commands(
    project_path: Option<String>,
    workspace_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<SlashCommand>, String> {
    let path = project_path.map(PathBuf::from);
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let plugin_management_enabled = db
        .get_app_setting("plugin_management_enabled")
        .map_err(|e| e.to_string())?
        .as_deref()
        == Some("true");
    let mut commands =
        slash_commands::discover_slash_commands(path.as_deref(), plugin_management_enabled);

    if let Some(ws_id) = workspace_id {
        let usage = db
            .get_slash_command_usage(&ws_id)
            .map_err(|e| e.to_string())?;
        slash_commands::sort_commands_by_usage(&mut commands, &usage);
    }

    Ok(commands)
}

#[tauri::command]
pub async fn record_slash_command_usage(
    workspace_id: String,
    command_name: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.record_slash_command_usage(&workspace_id, &command_name)
        .map_err(|e| e.to_string())
}
