use tauri::State;

use claudette::db::Database;
use claudette::model::AgentConclusion;

use crate::state::AppState;

/// Load every conclusion the agent has presented in a chat session (oldest
/// first), so the chat surface can render the inline conclusion cards on
/// session open / reload. Live conclusions arrive separately via the
/// `agent-conclusion-created` event.
#[tauri::command]
pub async fn load_agent_conclusions_for_session(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<AgentConclusion>, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.list_agent_conclusions_for_session(&session_id)
        .map_err(|e| e.to_string())
}
