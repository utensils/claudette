use tauri::State;

use claudette::db::Database;
use claudette::model::PinnedPrompt;

use crate::state::AppState;

/// Returns the merged list shown on the composer for the given repo
/// (`repo_id == None` returns globals only).
#[tauri::command]
pub async fn get_pinned_prompts(
    repo_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<PinnedPrompt>, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.list_pinned_prompts_for_composer(repo_id.as_deref())
        .map_err(|e| e.to_string())
}

/// Returns the prompts in a single scope. Used by the settings UIs.
#[tauri::command]
pub async fn list_pinned_prompts_in_scope(
    repo_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<PinnedPrompt>, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.list_pinned_prompts_in_scope(repo_id.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_pinned_prompt(
    repo_id: Option<String>,
    display_name: String,
    prompt: String,
    auto_send: bool,
    state: State<'_, AppState>,
) -> Result<PinnedPrompt, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.insert_pinned_prompt(repo_id.as_deref(), &display_name, &prompt, auto_send)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_pinned_prompt(
    id: i64,
    display_name: String,
    prompt: String,
    auto_send: bool,
    state: State<'_, AppState>,
) -> Result<PinnedPrompt, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.update_pinned_prompt(id, &display_name, &prompt, auto_send)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_pinned_prompt(id: i64, state: State<'_, AppState>) -> Result<(), String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.delete_pinned_prompt(id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn reorder_pinned_prompts(
    repo_id: Option<String>,
    ids: Vec<i64>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.reorder_pinned_prompts(repo_id.as_deref(), &ids)
        .map_err(|e| e.to_string())
}
