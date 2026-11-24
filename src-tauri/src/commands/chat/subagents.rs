use crate::state::AppState;
use claudette::agent::{AgentEvent, SubagentRunUpdate, subagent_tracking::SubagentTracker};
use claudette::db::Database;
use claudette::model::SubagentRun;
use std::path::Path;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::broadcast::{Receiver, error::RecvError};

#[tauri::command]
pub async fn get_subagent_runs(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<SubagentRun>, String> {
    Database::open(&state.db_path)
        .and_then(|db| db.list_subagent_runs(&session_id))
        .map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
pub struct PendingChildControl {
    tool_use_id: String,
    tool_name: String,
    input: serde_json::Value,
}

#[tauri::command]
pub async fn get_pending_subagent_controls(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<PendingChildControl>, String> {
    let agents = state.agents.read().await;
    let Some(session) = agents.get(&session_id) else {
        return Ok(vec![]);
    };
    let mut controls: Vec<_> = session
        .pending_permissions
        .iter()
        .filter(|(_, pending)| pending.child_owned)
        .map(|(id, pending)| PendingChildControl {
            tool_use_id: id.clone(),
            tool_name: pending.tool_name.clone(),
            input: pending.original_input.clone(),
        })
        .collect();
    controls.sort_by(|a, b| a.tool_use_id.cmp(&b.tool_use_id));
    Ok(controls)
}

pub(crate) fn persist(
    app: &AppHandle,
    path: &Path,
    session: &str,
    generation: i64,
    update: &SubagentRunUpdate,
) {
    match Database::open(path).and_then(|db| db.observe_subagent(session, generation, update)) {
        Ok(Some(row)) => {
            let _ = app.emit("subagent-run-updated", row);
        }
        Ok(None) => {}
        Err(error) => tracing::warn!(%error,"failed to persist subagent observation"),
    }
}

/// Subscribe before sending the first prompt; a background child can outlive
/// any individual turn listener, including while the parent is idle.
pub(super) fn observe_process(
    app: &AppHandle,
    workspace: &str,
    session: &str,
    pid: u32,
    generation: i64,
    mut rx: Receiver<AgentEvent>,
) {
    let app = app.clone();
    let workspace = workspace.to_owned();
    let session = session.to_owned();
    let path = app.state::<AppState>().db_path.clone();
    tokio::spawn(async move {
        let mut tracker = SubagentTracker::default();
        loop {
            match rx.recv().await {
                Ok(AgentEvent::SubagentControlResolved { tool_use_id }) => {
                    // Normal submissions remove the permission when claiming
                    // it. A process exit can close a still-unanswered prompt.
                    let state = app.state::<AppState>();
                    {
                        let mut agents = state.agents.write().await;
                        if let Some(agent) = agents.get_mut(&session)
                            && agent.pending_permissions.remove(&tool_use_id).is_some()
                            && agent.pending_permissions.is_empty()
                        {
                            agent.reset_attention();
                        }
                    }
                    let _ = app.emit(
                        "subagent-control-resolved",
                        serde_json::json!({"chat_session_id":session,"tool_use_id":tool_use_id}),
                    );
                }
                Ok(AgentEvent::SubagentControl(request)) => {
                    super::send::route_process_control_request(
                        &app,
                        &workspace,
                        &session,
                        &AgentEvent::Stream(request),
                        Some(pid),
                    )
                    .await;
                }
                Ok(AgentEvent::ProcessExited(_)) | Err(RecvError::Closed) => break,
                Err(RecvError::Lagged(count)) => {
                    tracing::warn!(count, "subagent observer missed process events")
                }
                Ok(event) => {
                    if let Some(update) = tracker.observe(&event) {
                        let state = app.state::<AppState>();
                        let agents = state.agents.read().await;
                        if agents
                            .get(&session)
                            .and_then(|s| s.persistent_session.as_ref())
                            .is_none_or(|ps| ps.pid() != pid)
                        {
                            // Keep receiving individual prompt invalidations from
                            // this connection until it exits after replacement.
                            continue;
                        }
                        persist(&app, &path, &session, generation, &update);
                    }
                }
            }
        }
        let state = app.state::<AppState>();
        let agents = state.agents.read().await;
        if agents
            .get(&session)
            .and_then(|s| s.persistent_session.as_ref())
            .is_some_and(|ps| ps.pid() != pid)
        {
            return;
        }
        match Database::open(&path)
            .and_then(|db| db.disconnect_subagent_process(&session, generation))
        {
            Ok(rows) => {
                for row in rows {
                    let _ = app.emit("subagent-run-updated", &row);
                }
            }
            Err(error) => tracing::warn!(%error,"failed to disconnect child observations"),
        }
    });
}
