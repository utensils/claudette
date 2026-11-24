//! Preserve worker identity and reply routing on the parent's JSON-RPC connection.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;

use super::{AgentEvent, ControlRequestInner, StreamEvent, SubagentRunUpdate};

#[derive(Clone, Default)]
pub(super) struct ChildApprovals {
    // Server request IDs are unique across this connection, including children.
    pending: Arc<Mutex<HashMap<String, String>>>,
}

impl ChildApprovals {
    pub(super) fn forward(
        &self,
        event: AgentEvent,
        harness: &str,
        child: &str,
        tx: &broadcast::Sender<AgentEvent>,
    ) -> bool {
        let AgentEvent::Stream(StreamEvent::ControlRequest {
            request_id,
            request:
                ControlRequestInner::CanUseTool {
                    tool_name,
                    mut input,
                    ..
                },
        }) = event
        else {
            return false;
        };
        if let Some(input) = input.as_object_mut() {
            input.insert("subagent_run_id".into(), child.into());
        }
        let mut pending = self.pending.lock().unwrap_or_else(|err| err.into_inner());
        pending.insert(request_id.clone(), child.into());
        Self::status(tx, harness, child, "needs_approval");
        let _ = tx.send(AgentEvent::SubagentControl(StreamEvent::ControlRequest {
            // ACP tool-call IDs are session-local. Keep the host prompt key
            // unique while retaining the original RPC ID used for replies.
            request: ControlRequestInner::CanUseTool {
                tool_name,
                tool_use_id: format!("subagent-approval-{request_id}"),
                input,
            },
            request_id,
        }));
        true
    }

    pub(super) fn answered(
        &self,
        request: &str,
        harness: &str,
        tx: &broadcast::Sender<AgentEvent>,
    ) {
        let mut pending = self.pending.lock().unwrap_or_else(|err| err.into_inner());
        if let Some(child) = pending.remove(request)
            && !pending.values().any(|other| other == &child)
        {
            Self::status(tx, harness, &child, "running");
        }
    }

    fn status(tx: &broadcast::Sender<AgentEvent>, harness: &str, child: &str, status: &str) {
        let _ = tx.send(AgentEvent::SubagentRun(SubagentRunUpdate {
            run_id: child.into(),
            harness: harness.into(),
            status: Some(status.into()),
            ..Default::default()
        }));
    }
}
