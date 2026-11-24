//! Codex uses separate IDs for a collaboration call, a worker thread, and a turn.
use std::collections::HashSet;

use serde_json::Value;
use tokio::sync::broadcast;

use super::{JsonRpcMessage, codex_server_request_to_control_event};
use crate::agent::{AgentEvent, SubagentRunUpdate, provider_subagents::ChildApprovals};

#[derive(Default)]
pub(super) struct ChildThreads {
    known: HashSet<String>,
    approvals: ChildApprovals,
}

impl ChildThreads {
    pub(super) fn new(approvals: ChildApprovals) -> Self {
        Self {
            approvals,
            ..Self::default()
        }
    }

    /// Consume child traffic before it can mutate the active parent turn.
    /// The reader is owned by one app-server connection for one Claudette chat.
    pub fn route(
        &mut self,
        root: &str,
        message: &JsonRpcMessage,
        tx: &broadcast::Sender<AgentEvent>,
    ) -> bool {
        let (method, params) = match message {
            JsonRpcMessage::Notification(n) => (&n.method, &n.params),
            JsonRpcMessage::Request(r) => (&r.method, &r.params),
            _ => return false,
        };
        let Some(p) = params else { return false };
        if method == "thread/started"
            && let Some(spawn) = p.pointer("/thread/source/subAgent/thread_spawn")
            && let Some(parent) = spawn["parent_thread_id"].as_str()
            && (parent == root || self.known.contains(parent))
            && let Some(child) = p.pointer("/thread/id").and_then(Value::as_str)
        {
            self.known.insert(child.to_owned());
            let mut update = child_update(child);
            update.parent_run_id = (parent != root).then(|| parent.to_owned());
            update.assignment = string(&p["thread"]["agentNickname"]);
            emit(tx, update);
            return true;
        }
        let Some(thread) = p["threadId"].as_str() else {
            return false;
        };
        let child = thread != root;
        if matches!(method.as_str(), "item/started" | "item/completed") {
            let item = &p["item"];
            let known_sender = !child || self.known.contains(thread);
            match item["type"].as_str() {
                Some("subAgentActivity") => {
                    if known_sender {
                        self.activity(root, thread, item, tx);
                    }
                    return true;
                }
                Some("collabAgentToolCall") => {
                    if known_sender {
                        self.collaboration(root, thread, item, tx);
                    }
                    return true;
                }
                _ => {}
            }
        }
        if !child {
            return false;
        }
        if let JsonRpcMessage::Request(request) = message {
            if let Ok(Some(event)) = codex_server_request_to_control_event(request)
                && self.approvals.forward(event, "codex", thread, tx)
            {
                return true;
            }
            // Let the normal handler reply to unsupported JSON-RPC requests.
            return false;
        }
        if self.known.contains(thread) {
            let mut update = child_update(thread);
            match method.as_str() {
                "turn/started" => update.status = Some("resumed".into()),
                "turn/completed" => {
                    update.status = match p.pointer("/turn/status").and_then(Value::as_str) {
                        Some("completed") => Some("completed".into()),
                        Some("interrupted") => Some("stopped".into()),
                        Some("failed") => Some("failed".into()),
                        _ => None,
                    };
                    update.summary = p.pointer("/turn/error/message").and_then(string);
                }
                "item/completed" if p["item"]["type"] == "agentMessage" => {
                    update.summary = string(&p["item"]["text"]);
                }
                "thread/status/changed" if p["status"]["type"] == "active" => {
                    let approval = p["status"]["activeFlags"].as_array().is_some_and(|flags| {
                        flags
                            .iter()
                            .any(|f| f == "waitingOnApproval" || f == "waitingOnUserInput")
                    });
                    update.status = Some(
                        if approval {
                            "needs_approval"
                        } else {
                            "running"
                        }
                        .into(),
                    );
                }
                _ => {}
            }
            if update.status.is_some() || update.summary.is_some() {
                emit(tx, update);
            }
        }
        true
    }

    fn activity(
        &mut self,
        root: &str,
        parent: &str,
        item: &Value,
        tx: &broadcast::Sender<AgentEvent>,
    ) {
        let Some(id) = item["agentThreadId"]
            .as_str()
            .filter(|id| !id.is_empty() && *id != root)
        else {
            return;
        };
        // Live Codex emits item/started AND item/completed for kind=started.
        // Only the activity kind describes what happened to the worker.
        let mut update = child_update(id);
        update.parent_run_id = (parent != root).then(|| parent.to_owned());
        match item["kind"].as_str() {
            Some("started") => {
                update.status = Some("delegated".into());
                update.assignment = string(&item["agentPath"]);
                update.tool_use_id = string(&item["id"]);
            }
            Some("completed") => update.status = Some("completed".into()),
            Some("interrupted") => update.status = Some("stopped".into()),
            _ => return,
        }
        self.known.insert(id.to_owned());
        emit(tx, update);
    }

    fn collaboration(
        &mut self,
        root: &str,
        sender: &str,
        item: &Value,
        tx: &broadcast::Sender<AgentEvent>,
    ) {
        let mut ids = std::collections::BTreeSet::new();
        if let Some(receivers) = item["receiverThreadIds"].as_array() {
            ids.extend(receivers.iter().filter_map(Value::as_str));
        }
        if let Some(states) = item["agentsStates"].as_object() {
            ids.extend(states.keys().map(String::as_str));
        }
        let op = item["tool"].as_str();
        for id in ids {
            if id == root || id.is_empty() {
                continue;
            }
            // A nested agent may message its parent or sibling. Only spawn
            // establishes ownership; later calls refer to the existing worker.
            let spawn = op == Some("spawnAgent");
            if !spawn && !self.known.contains(id) && sender != root {
                continue;
            }
            self.known.insert(id.to_owned());
            let mut update = child_update(id);
            if spawn {
                update.parent_run_id = (sender != root).then(|| sender.to_owned());
                update.tool_use_id = string(&item["id"]);
                update.assignment = string(&item["prompt"]);
            }
            let state = &item["agentsStates"][id];
            let resumed =
                matches!(op, Some("resumeAgent" | "followupTask")) && item["status"] == "completed";
            update.status = match state["status"].as_str() {
                Some("running" | "pendingInit") if resumed => Some("resumed"),
                Some("running") => Some("running"),
                Some("pendingInit") => Some("delegated"),
                Some("completed") => Some("completed"),
                Some("interrupted" | "shutdown") => Some("stopped"),
                Some("errored") => Some("failed"),
                None if spawn => Some("delegated"),
                _ => None,
            }
            .map(str::to_owned);
            update.summary = string(&state["message"]);
            if spawn || update.status.is_some() || update.summary.is_some() {
                emit(tx, update);
            }
        }
    }
}

fn string(value: &Value) -> Option<String> {
    value.as_str().filter(|s| !s.is_empty()).map(str::to_owned)
}

fn child_update(id: &str) -> SubagentRunUpdate {
    SubagentRunUpdate {
        run_id: id.into(),
        harness: "codex".into(),
        ..Default::default()
    }
}

fn emit(tx: &broadcast::Sender<AgentEvent>, update: SubagentRunUpdate) {
    let _ = tx.send(AgentEvent::SubagentRun(update));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::{ControlRequestInner, StreamEvent};
    use serde_json::json;

    fn message(method: &str, params: Value) -> JsonRpcMessage {
        serde_json::from_value(json!({"method":method, "params":params})).unwrap()
    }

    #[test]
    fn interleaved_child_turns_and_approvals_never_finish_the_root_turn() {
        let mut children = ChildThreads::default();
        let (tx, mut rx) = broadcast::channel(16);
        for child in ["a", "b"] {
            assert!(children.route("parent",&message("item/completed", json!({
                "threadId":"parent", "item":{"type":"collabAgentToolCall","id":format!("spawn-{child}"),
                "status":"completed","tool":"spawnAgent","prompt":"Check tests","receiverThreadIds":[child],"agentsStates":{}}
            })), &tx));
            let AgentEvent::SubagentRun(run) = rx.try_recv().unwrap() else {
                panic!()
            };
            assert_eq!(run.run_id, child);
            assert_eq!(run.status.as_deref(), Some("delegated"));
        }
        assert!(children.route(
            "parent",
            &message(
                "item/agentMessage/delta",
                json!({"threadId":"b","delta":"child only"})
            ),
            &tx
        ));
        assert!(rx.try_recv().is_err());
        assert!(!children.route(
            "parent",
            &message(
                "item/agentMessage/delta",
                json!({"threadId":"parent","delta":"root only"})
            ),
            &tx
        ));
        let approval: JsonRpcMessage = serde_json::from_value(json!({"id":27,"method":"item/commandExecution/requestApproval","params":{"threadId":"b","itemId":"same-id"}})).unwrap();
        assert!(children.route("parent", &approval, &tx));
        let AgentEvent::SubagentRun(run) = rx.try_recv().unwrap() else {
            panic!()
        };
        assert_eq!(run.status.as_deref(), Some("needs_approval"));
        let AgentEvent::SubagentControl(StreamEvent::ControlRequest {
            request_id,
            request:
                ControlRequestInner::CanUseTool {
                    tool_use_id, input, ..
                },
        }) = rx.try_recv().unwrap()
        else {
            panic!()
        };
        assert_eq!(request_id, "27");
        assert_eq!(tool_use_id, "subagent-approval-27");
        assert_eq!(input["subagent_run_id"], "b");
        for (id, status) in [("a", "failed"), ("b", "completed")] {
            assert!(children.route(
                "parent",
                &message(
                    "turn/completed",
                    json!({"threadId":id,"turn":{"status":status}})
                ),
                &tx
            ));
            let AgentEvent::SubagentRun(run) = rx.try_recv().unwrap() else {
                panic!()
            };
            assert_eq!(
                (run.run_id.as_str(), run.status.as_deref()),
                (id, Some(status))
            );
        }
        assert!(!children.route(
            "parent",
            &message(
                "turn/completed",
                json!({"threadId":"parent","turn":{"status":"completed"}})
            ),
            &tx
        ));
    }

    #[test]
    fn captured_subagent_activity_tracks_a_worker_even_when_wait_has_no_receivers() {
        let mut children = ChildThreads::default();
        let (tx, mut rx) = broadcast::channel(8);
        for (kind, status) in [("started", "delegated"), ("completed", "completed")] {
            let event = message(
                "item/completed",
                json!({"threadId":"parent","item":{
                    "type":"subAgentActivity", "agentThreadId":"worker", "agentPath":"/root/color",
                    "kind":kind, "id":"provider-item"
                }}),
            );
            assert!(children.route("parent", &event, &tx));
            let AgentEvent::SubagentRun(run) = rx.try_recv().unwrap() else {
                panic!()
            };
            assert_eq!(run.status.as_deref(), Some(status));
            assert_eq!(run.run_id, "worker");
        }
        assert!(children.route(
            "parent",
            &message(
                "turn/completed",
                json!({"threadId":"worker","turn":{"status":"failed"}})
            ),
            &tx
        ));
        let AgentEvent::SubagentRun(run) = rx.try_recv().unwrap() else {
            panic!()
        };
        assert_eq!(run.status.as_deref(), Some("failed"));
    }

    #[test]
    fn wait_observes_each_receiver_without_reparenting_or_replacing_its_assignment() {
        let mut children = ChildThreads::default();
        let (tx, mut rx) = broadcast::channel(8);
        let wait = message(
            "item/completed",
            json!({"threadId":"parent","item":{
                "type":"collabAgentToolCall","tool":"wait","id":"wait-1","status":"completed","receiverThreadIds":["a","b"],
                "agentsStates":{"a":{"status":"completed","message":"Passed"},"b":{"status":"running"}}
            }}),
        );
        assert!(children.route("parent", &wait, &tx));
        for (id, status) in [("a", "completed"), ("b", "running")] {
            let AgentEvent::SubagentRun(run) = rx.try_recv().unwrap() else {
                panic!()
            };
            assert_eq!(
                (run.run_id.as_str(), run.status.as_deref()),
                (id, Some(status))
            );
            assert!(
                run.tool_use_id.is_none()
                    && run.assignment.is_none()
                    && run.parent_run_id.is_none()
            );
        }
        assert!(children.route("parent",&message("item/completed",json!({"threadId":"b","item":{
            "type":"collabAgentToolCall","tool":"spawnAgent","id":"launch","receiverThreadIds":["nested"]
        }})),&tx));
        let AgentEvent::SubagentRun(run) = rx.try_recv().unwrap() else {
            panic!()
        };
        assert_eq!(run.parent_run_id.as_deref(), Some("b"));
        assert_eq!(run.tool_use_id.as_deref(), Some("launch"));
    }
}
