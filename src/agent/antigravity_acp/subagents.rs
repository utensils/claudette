//! agy 1.5.x exposes invoke_subagent on the parent ACP session. Its successful
//! tool return only acknowledges delegation; the worker can still be running.
use tokio::sync::broadcast;

use super::{AcpRpcMessage, acp_server_request_to_control_event};
use crate::agent::{AgentEvent, SubagentRunUpdate, provider_subagents::ChildApprovals};

/// Inspect the wire envelope before its sessionId is discarded by turn decoding.
pub(super) fn route(
    approvals: &ChildApprovals,
    root: &str,
    message: &AcpRpcMessage,
    tx: &broadcast::Sender<AgentEvent>,
) -> bool {
    match message {
        AcpRpcMessage::Notification(n) if n.method == "session/update" => {
            let Some(params) = &n.params else {
                return false;
            };
            let Some(sid) = params["sessionId"].as_str() else {
                return false;
            };
            let update = &params["update"];
            let kind = update["sessionUpdate"].as_str();
            if matches!(kind, Some("tool_call" | "tool_call_update"))
                && update["name"] == "invoke_subagent"
                && let Some(call) = update["toolCallId"].as_str().filter(|s| !s.is_empty())
            {
                let args = update.get("rawInput").or_else(|| update.get("args"));
                let assignment = args
                    .and_then(|a| a["Prompt"].as_str().or_else(|| a["Role"].as_str()))
                    .map(str::to_owned);
                let status = match update["status"].as_str() {
                    Some("failed") => Some("failed"),
                    Some("pending" | "in_progress") => Some("delegated"),
                    // A terminal-only notification can be the first one received.
                    // Preserve any subsequent real status in the host.
                    Some("completed") => Some("delegated"),
                    _ => None,
                };
                // Tool-call IDs have session scope. For parent calls the chat's
                // own scope suffices and the model can use the verbatim call ID.
                let id = if sid == root {
                    call.to_owned()
                } else {
                    format!("{sid}/{call}")
                };
                emit(
                    tx,
                    SubagentRunUpdate {
                        run_id: id,
                        harness: "antigravity".into(),
                        parent_run_id: (sid != root).then(|| sid.to_owned()),
                        assignment,
                        status: status.map(str::to_owned),
                        tool_use_id: Some(call.to_owned()),
                        ..Default::default()
                    },
                );
            }
            // Parent tool results still render in the ordinary transcript.
            // A foreign session's messages/usage must never feed this turn.
            sid != root
        }
        AcpRpcMessage::Request(r) => {
            let sid = r.params.as_ref().and_then(|p| p["sessionId"].as_str());
            if let Some(sid) = sid.filter(|s| *s != root)
                && let Ok(Some(event)) = acp_server_request_to_control_event(r)
                && approvals.forward(event, "antigravity", sid, tx)
            {
                return true;
            }
            false
        }
        _ => false,
    }
}

fn emit(tx: &broadcast::Sender<AgentEvent>, update: SubagentRunUpdate) {
    let _ = tx.send(AgentEvent::SubagentRun(update));
}

#[cfg(test)]
mod tests {
    use super::super::{AcpRpcId, AcpRpcNotification, AcpRpcRequest};
    use super::*;
    use crate::agent::{ControlRequestInner, StreamEvent};
    use serde_json::{Value, json};

    fn notification(session: &str, update: Value) -> AcpRpcMessage {
        AcpRpcMessage::Notification(AcpRpcNotification {
            method: "session/update".into(),
            params: Some(json!({"sessionId":session,"update":update})),
        })
    }

    #[test]
    fn captured_agy_delegation_return_leaves_the_worker_delegated() {
        let (tx, mut rx) = broadcast::channel(8);
        let approvals = ChildApprovals::default();
        for (kind, status) in [
            ("tool_call", "in_progress"),
            ("tool_call_update", "completed"),
        ] {
            // Field names/casing from agy acp 1.5.15 with a real self subagent.
            let message = notification(
                "parent",
                json!({"sessionUpdate":kind,"toolCallId":"call_2188173920729769838","name":"invoke_subagent","rawInput":{"Role":"Short Reply Assistant","TypeName":"self","Prompt":"Reply with blue."},"kind":"other","status":status,"title":"Run invoke_subagent"}),
            );
            assert!(!route(&approvals, "parent", &message, &tx));
            let AgentEvent::SubagentRun(run) = rx.try_recv().unwrap() else {
                panic!()
            };
            assert_eq!(run.run_id, "call_2188173920729769838");
            assert_eq!(run.assignment.as_deref(), Some("Reply with blue."));
            assert_eq!(run.status.as_deref(), Some("delegated"));
        }
        assert!(route(
            &approvals,
            "parent",
            &notification(
                "child",
                json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"private child output"}})
            ),
            &tx
        ));
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn child_approval_keeps_rpc_reply_id_and_session_identity() {
        let (tx, mut rx) = broadcast::channel(8);
        let approvals = ChildApprovals::default();
        let request = AcpRpcMessage::Request(AcpRpcRequest {
            id: AcpRpcId::Integer(4),
            method: "session/request_permission".into(),
            params: Some(
                json!({"sessionId":"child","toolCall":{"toolCallId":"t","kind":"execute"},"options":[]}),
            ),
        });
        assert!(route(&approvals, "parent", &request, &tx));
        let AgentEvent::SubagentRun(run) = rx.try_recv().unwrap() else {
            panic!()
        };
        assert_eq!(run.status.as_deref(), Some("needs_approval"));
        let AgentEvent::SubagentControl(StreamEvent::ControlRequest {
            request_id,
            request: ControlRequestInner::CanUseTool { input, .. },
        }) = rx.try_recv().unwrap()
        else {
            panic!()
        };
        assert_eq!(request_id, "4");
        assert_eq!(input["subagent_run_id"], "child");
        let AcpRpcMessage::Request(mut second) = request else {
            panic!()
        };
        second.id = AcpRpcId::Integer(5);
        assert!(route(
            &approvals,
            "parent",
            &AcpRpcMessage::Request(second),
            &tx
        ));
        rx.try_recv().unwrap();
        rx.try_recv().unwrap();
        approvals.answered("4", "antigravity", &tx);
        assert!(rx.try_recv().is_err());
        approvals.answered("5", "antigravity", &tx);
        let AgentEvent::SubagentRun(run) = rx.try_recv().unwrap() else {
            panic!()
        };
        assert_eq!(run.status.as_deref(), Some("running"));
    }
}
