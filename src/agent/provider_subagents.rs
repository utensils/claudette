//! Preserve worker identity and reply routing on the parent's JSON-RPC connection.
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;

use super::{AgentEvent, ControlRequestInner, StreamEvent, SubagentRunUpdate};

#[derive(Clone, Default)]
pub(super) struct ChildApprovals {
    // Server request IDs are unique across this connection, including children.
    pending: Arc<Mutex<HashMap<String, PendingChildRequest>>>,
}

struct PendingChildRequest {
    child: String,
    host_id: String,
    envelope: StreamEvent,
}

/// One desktop observer's view of pending requests. Retain the provider's
/// original envelopes independently of the lossy stream of text/tool deltas.
pub struct ChildControlReplay {
    approvals: ChildApprovals,
    shown: HashSet<String>,
    harness: &'static str,
}

impl ChildControlReplay {
    /// Diff current provider-owned requests against those already dispatched.
    /// A surviving broadcast signal after lag may describe an older state.
    pub fn reconcile(&mut self, after_lag: bool) -> Vec<AgentEvent> {
        let pending = self
            .approvals
            .pending
            .lock()
            .unwrap_or_else(|err| err.into_inner());
        let mut events = Vec::new();
        let active: HashSet<_> = pending.values().map(|request| &request.host_id).collect();
        self.shown.retain(|host_id| {
            if active.contains(host_id) {
                return true;
            }
            events.push(AgentEvent::SubagentControlResolved {
                tool_use_id: host_id.clone(),
            });
            false
        });
        let mut waiting = HashSet::new();
        for request in pending.values() {
            if after_lag && waiting.insert(&request.child) {
                // Restore the attention state after the host marks lossy run
                // observations disconnected. Each pending envelope is proof.
                events.push(AgentEvent::SubagentRun(SubagentRunUpdate {
                    harness: self.harness.into(),
                    run_id: request.child.clone(),
                    status: Some("needs_approval".into()),
                    ..Default::default()
                }));
            }
            if self.shown.insert(request.host_id.clone()) {
                events.push(AgentEvent::SubagentControl(request.envelope.clone()));
            }
        }
        events
    }

    pub fn finish(&mut self) -> Vec<AgentEvent> {
        self.shown
            .drain()
            .map(|tool_use_id| AgentEvent::SubagentControlResolved { tool_use_id })
            .collect()
    }
}

impl ChildApprovals {
    pub(super) fn replay(&self, harness: &'static str) -> ChildControlReplay {
        ChildControlReplay {
            approvals: self.clone(),
            shown: HashSet::new(),
            harness,
        }
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
        if pending.contains_key(&request_id) {
            return true;
        }
        // A provider may reuse a completed JSON-RPC ID even on the same
        // connection. Every distinct host card has a fresh identity.
        let host_id = format!("subagent-approval-{}-{request_id}", uuid::Uuid::new_v4());
        let envelope = StreamEvent::ControlRequest {
            request: ControlRequestInner::CanUseTool {
                tool_name,
                tool_use_id: host_id.clone(),
                input,
            },
            request_id: request_id.clone(),
        };
        pending.insert(
            request_id,
            PendingChildRequest {
                child: child.into(),
                host_id,
                envelope: envelope.clone(),
            },
        );
        Self::status(tx, harness, child, "needs_approval");
        let _ = tx.send(AgentEvent::SubagentControl(envelope));
        true
    }

    pub(super) fn answered(
        &self,
        request: &str,
        harness: &str,
        tx: &broadcast::Sender<AgentEvent>,
    ) {
        let mut pending = self.pending.lock().unwrap_or_else(|err| err.into_inner());
        if let Some(removed) = pending.remove(request) {
            let _ = tx.send(AgentEvent::SubagentControlResolved {
                tool_use_id: removed.host_id,
            });
            if !pending.values().any(|other| other.child == removed.child) {
                Self::status(tx, harness, &removed.child, "running");
            }
        }
    }

    /// A dead provider cannot accept answers. Remove every one of its cards,
    /// including requests made after the launching parent turn ended.
    pub(super) fn closed(&self, tx: &broadcast::Sender<AgentEvent>) {
        let mut pending = self.pending.lock().unwrap_or_else(|err| err.into_inner());
        for (_, request) in pending.drain() {
            let _ = tx.send(AgentEvent::SubagentControlResolved {
                tool_use_id: request.host_id,
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

    fn host_id(event: &AgentEvent) -> &str {
        let AgentEvent::SubagentControl(StreamEvent::ControlRequest {
            request: ControlRequestInner::CanUseTool { tool_use_id, .. },
            ..
        }) = event
        else {
            panic!("expected child control")
        };
        tool_use_id
    }

    #[test]
    fn lagged_observer_recovers_requests_and_replies_exactly_once() {
        let approvals = ChildApprovals::default();
        let mut replay = approvals.replay("codex");
        let (tx, mut rx) = broadcast::channel(1);
        let request = AgentEvent::Stream(StreamEvent::ControlRequest {
            request_id: "7".into(),
            request: ControlRequestInner::CanUseTool {
                tool_name: "CodexCommandApproval".into(),
                tool_use_id: "provider-item".into(),
                input: json!({"command":"echo ok"}),
            },
        });
        let force_lag = |rx: &mut broadcast::Receiver<AgentEvent>| {
            tx.send(AgentEvent::Stderr("noise".into())).unwrap();
            assert!(matches!(
                rx.try_recv(),
                Err(broadcast::error::TryRecvError::Lagged(_))
            ));
        };
        approvals.forward(request.clone(), "codex", "worker", &tx);
        force_lag(&mut rx);
        let recovered = replay.reconcile(true);
        assert!(
            matches!(&recovered[..], [AgentEvent::SubagentRun(run), AgentEvent::SubagentControl(StreamEvent::ControlRequest {
            request_id,request: ControlRequestInner::CanUseTool {input,..}
        })] if run.status.as_deref()==Some("needs_approval") && request_id=="7" && input["command"]=="echo ok" && input["subagent_run_id"]=="worker")
        );
        let first_card = host_id(&recovered[1]).to_owned();
        assert!(replay.reconcile(false).is_empty());
        approvals.answered("7", "codex", &tx);
        // Reuse of the provider's RPC ID between snapshots must retire the
        // old card and present the new prompt despite losing both signals.
        approvals.forward(request, "codex", "worker", &tx);
        force_lag(&mut rx);
        let next = replay.reconcile(true);
        assert!(
            matches!(&next[0], AgentEvent::SubagentControlResolved {tool_use_id} if tool_use_id==&first_card)
        );
        let second_card = host_id(&next[2]).to_owned();
        assert_ne!(first_card, second_card);
        approvals.closed(&tx);
        force_lag(&mut rx);
        assert!(
            matches!(&replay.reconcile(true)[..], [AgentEvent::SubagentControlResolved {tool_use_id}] if tool_use_id==&second_card)
        );
        assert!(replay.finish().is_empty());
    }

    #[test]
    fn respawned_provider_reusing_rpc_id_cannot_resolve_a_new_prompt_from_a_stale_card() {
        let first = ChildApprovals::default();
        let replacement = ChildApprovals::default();
        let (tx, mut rx) = broadcast::channel(4);
        let envelope = AgentEvent::Stream(StreamEvent::ControlRequest {
            request_id: "4".into(),
            request: ControlRequestInner::CanUseTool {
                tool_use_id: "t".into(),
                tool_name: "CodexCommandApproval".into(),
                input: json!({}),
            },
        });
        first.forward(envelope.clone(), "codex", "child", &tx);
        let mut first_replay = first.replay("codex");
        let first_id = host_id(&first_replay.reconcile(false)[0]).to_owned();
        replacement.forward(envelope, "codex", "child", &tx);
        let mut replacement_replay = replacement.replay("codex");
        assert_ne!(first_id, host_id(&replacement_replay.reconcile(false)[0]));
        while rx.try_recv().is_ok() {}
        first.closed(&tx);
        let AgentEvent::SubagentControlResolved { tool_use_id } = rx.try_recv().unwrap() else {
            panic!()
        };
        assert_eq!(tool_use_id, first_id);
        first.answered("4", "codex", &tx);
        assert!(rx.try_recv().is_err());
    }
}
