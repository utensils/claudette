use tauri::{AppHandle, State};

use claudette::agent;
use claudette::db::Database;
use claudette::model::ChatSession;

use crate::state::{AgentSessionState, AppState};

/// Overlay live runtime fields (agent_status, needs_attention, attention_kind)
/// from `AppState.agents` onto a `ChatSession` loaded from the DB. The DB
/// defaults are `Idle`/`false`/`None`; this replaces them with whatever the
/// running agent map reports.
fn hydrate_session(
    mut session: ChatSession,
    agents: &std::collections::HashMap<String, AgentSessionState>,
) -> ChatSession {
    if let Some(agent) = agents.get(&session.id) {
        session.agent_status = if agent.active_pid.is_some() {
            claudette::model::AgentStatus::Running
        } else {
            claudette::model::AgentStatus::Idle
        };
        session.needs_attention = agent.needs_attention;
        session.attention_kind = agent.attention_kind.map(|k| match k {
            crate::state::AttentionKind::Ask => claudette::model::AttentionKind::Ask,
            crate::state::AttentionKind::Plan => claudette::model::AttentionKind::Plan,
        });
    }
    session
}

#[tauri::command]
pub async fn list_chat_sessions(
    workspace_id: String,
    include_archived: Option<bool>,
    state: State<'_, AppState>,
) -> Result<Vec<ChatSession>, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let sessions = db
        .list_chat_sessions_for_workspace(&workspace_id, include_archived.unwrap_or(false))
        .map_err(|e| e.to_string())?;
    let agents = state.agents.read().await;
    Ok(sessions
        .into_iter()
        .map(|s| hydrate_session(s, &agents))
        .collect())
}

#[tauri::command]
pub async fn get_chat_session(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<ChatSession, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let session = db
        .get_chat_session(&session_id)
        .map_err(|e| e.to_string())?
        .ok_or("Session not found")?;
    let agents = state.agents.read().await;
    Ok(hydrate_session(session, &agents))
}

#[tauri::command]
pub async fn create_chat_session(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<ChatSession, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let session = db
        .create_chat_session(&workspace_id)
        .map_err(|e| e.to_string())?;
    let agents = state.agents.read().await;
    Ok(hydrate_session(session, &agents))
}

#[tauri::command]
pub async fn rename_chat_session(
    session_id: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let capped = claudette::model::validate_session_name(&name).map_err(String::from)?;
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.rename_chat_session(&session_id, &capped)
        .map_err(|e| e.to_string())
}

/// Archive a chat session (soft-delete). Stops its running agent first, then
/// marks the row archived. If this was the workspace's last active session,
/// a fresh `New chat` session is created so every workspace always has ≥1
/// active session. Returns the newly created session in that case, `None`
/// otherwise — the frontend uses the return value to select the new tab.
#[tauri::command]
pub async fn archive_chat_session(
    app: AppHandle,
    session_id: String,
    state: State<'_, AppState>,
) -> Result<Option<ChatSession>, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let session = db
        .get_chat_session(&session_id)
        .map_err(|e| e.to_string())?
        .ok_or("Session not found")?;
    let workspace_id = session.workspace_id.clone();

    // Stop and remove the live agent for this session.
    // Capture the PID under the lock, then drop the lock before the async stop.
    let pid_to_stop = {
        let mut agents = state.agents.write().await;
        agents
            .remove(&session_id)
            .and_then(|mut agent| agent.active_pid.take())
    };
    if let Some(pid) = pid_to_stop {
        let _ = agent::stop_agent(pid).await;
    }

    let fresh = db
        .archive_chat_session_ensuring_active(&session_id, &workspace_id)
        .map_err(|e| e.to_string())?;

    // Rebuild the tray so per-workspace running/attention aggregates reflect
    // the removed agent (and, if this was the last session, the auto-created
    // replacement). Without this, the tray can keep showing stale state until
    // another action triggers a rebuild.
    crate::tray::rebuild_tray(&app);

    if let Some(fresh) = fresh {
        let agents = state.agents.read().await;
        return Ok(Some(hydrate_session(fresh, &agents)));
    }

    Ok(None)
}
