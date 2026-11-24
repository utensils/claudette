use crate::ws::ServerState;
use claudette::agent::{AgentEvent, subagent_tracking::SubagentTracker};
use claudette::db::Database;
use std::sync::Arc;
use tokio::sync::broadcast::{Receiver, error::RecvError};

pub(crate) fn observe_process(
    state: Arc<ServerState>,
    session: String,
    pid: u32,
    generation: i64,
    mut rx: Receiver<AgentEvent>,
) {
    tokio::spawn(async move {
        let mut tracker = SubagentTracker::default();
        let persist =
            |update: &claudette::agent::SubagentRunUpdate| match Database::open(&state.db_path)
                .and_then(|db| db.observe_subagent(&session, generation, update))
            {
                Ok(Some(row)) => {
                    state.emit(serde_json::json!({"event":"subagent-run-updated","payload":row}))
                }
                Ok(None) => {}
                Err(error) => tracing::warn!(%error,"failed to save subagent update"),
            };
        loop {
            match rx.recv().await {
                Ok(AgentEvent::ProcessExited(_)) | Err(RecvError::Closed) => break,
                Err(RecvError::Lagged(count)) => {
                    tracing::warn!(count, "subagent observer missed process events")
                }
                Ok(event) => {
                    if let Some(update) = tracker.observe(&event) {
                        persist(&update);
                    }
                }
            }
        }
        let agents = state.agents.read().await;
        if agents
            .get(&session)
            .and_then(|s| s.persistent_session.as_ref())
            .is_some_and(|ps| ps.pid() != pid)
        {
            return;
        }
        match Database::open(&state.db_path)
            .and_then(|db| db.disconnect_subagent_process(&session, generation))
        {
            Ok(rows) => {
                for row in rows {
                    state.emit(serde_json::json!({"event":"subagent-run-updated","payload":row}));
                }
            }
            Err(error) => tracing::warn!(%error,"failed to disconnect child observations"),
        }
    });
}
