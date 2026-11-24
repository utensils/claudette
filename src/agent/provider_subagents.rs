//! Preserve worker identity and reply routing on the parent's JSON-RPC connection.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;

use super::{AgentEvent, ControlRequestInner, StreamEvent, SubagentRunUpdate};

#[derive(Clone)]
pub(super) struct ChildApprovals {
    connection: uuid::Uuid,
    // Server request IDs are unique across this connection, including children.
    pending: Arc<Mutex<HashMap<String, String>>>,
}

impl Default for ChildApprovals {
    fn default() -> Self {
        Self {
            connection: uuid::Uuid::new_v4(),
            pending: Default::default(),
        }
    }
}

impl ChildApprovals {
    fn host_id(&self, request: &str) -> String {
        // Providers may recycle request IDs when a session respawns.
        format!("subagent-approval-{}-{request}", self.connection)
    }

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
                tool_use_id: self.host_id(&request_id),
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
        if let Some(child) = pending.remove(request) {
            let _ = tx.send(AgentEvent::SubagentControlResolved {
                tool_use_id: self.host_id(request),
            });
            if !pending.values().any(|other| other == &child) {
                Self::status(tx, harness, &child, "running");
            }
        }
    }

    /// A dead provider cannot accept answers. Remove every one of its cards,
    /// including requests made after the launching parent turn ended.
    pub(super) fn closed(&self, tx: &broadcast::Sender<AgentEvent>) {
        let mut pending = self.pending.lock().unwrap_or_else(|err| err.into_inner());
        for (request, _) in pending.drain() {
            let _ = tx.send(AgentEvent::SubagentControlResolved {
                tool_use_id: self.host_id(&request),
            });
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn respawned_provider_reusing_rpc_id_cannot_resolve_a_new_prompt_from_a_stale_card() {
        let first = ChildApprovals::default();
        let replacement = ChildApprovals::default();
        assert_ne!(first.host_id("4"), replacement.host_id("4"));
        let (tx, mut rx) = broadcast::channel(4);
        first.forward(
            AgentEvent::Stream(StreamEvent::ControlRequest {
                request_id: "4".into(),
                request: ControlRequestInner::CanUseTool {
                    tool_use_id: "t".into(),
                    tool_name: "CodexCommandApproval".into(),
                    input: json!({}),
                },
            }),
            "codex",
            "child",
            &tx,
        );
        rx.try_recv().unwrap();
        rx.try_recv().unwrap();
        first.closed(&tx);
        let AgentEvent::SubagentControlResolved { tool_use_id } = rx.try_recv().unwrap() else {
            panic!()
        };
        assert_eq!(tool_use_id, first.host_id("4"));
        first.answered("4", "codex", &tx);
        assert!(rx.try_recv().is_err());
    }
}
