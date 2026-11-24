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

pub(crate) fn persist(app: &AppHandle, path: &Path, session: &str, update: &SubagentRunUpdate) {
    match Database::open(path).and_then(|db| db.observe_subagent(session, update)) {
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
                            break;
                        }
                        persist(&app, &path, &session, &update);
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
        for update in tracker.disconnected() {
            persist(&app, &path, &session, &update);
        }
    });
}
