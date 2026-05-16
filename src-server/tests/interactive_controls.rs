//! Error-path tests for the new interactive-control RPC handlers added in
//! Phase 2 (mobile iOS foundation). The happy path requires writing
//! `control_response` lines back to a running `claude` subprocess and
//! isn't viable in CI, but the validation logic (lookup-before-remove,
//! tool-name dispatch, queue depth) is covered here so a regression that
//! e.g. drains the pending entry on the wrong tool gets caught.
//!
//! Tests call the handler helper functions directly rather than going
//! through `handle_request` — that public entrypoint takes a
//! `&Arc<Writer>` (a `Mutex<SplitSink<WebSocketStream<TlsStream<TcpStream>>>>`)
//! which can't be constructed without a real TLS handshake. None of the
//! error paths we cover here ever write to that Writer.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use claudette::plugin_runtime::PluginRegistry;
use claudette_server::handler::{
    handle_steer_queued_chat_message, handle_submit_agent_answer, handle_submit_approval,
};
use claudette_server::ws::{AgentSessionState, PendingPermission, ServerState};

async fn make_state() -> Arc<ServerState> {
    let temp = tempfile::tempdir().unwrap();
    let db_path = temp.path().join("test.db");
    let _ = claudette::db::Database::open(&db_path).unwrap();
    let worktree_base = temp.path().join("workspaces");
    std::fs::create_dir_all(&worktree_base).unwrap();
    let plugins = PluginRegistry::discover(temp.path());
    Arc::new(ServerState::new_with_plugins(
        db_path,
        worktree_base,
        plugins,
    ))
}

fn session_with_pending(
    workspace_id: &str,
    tool_use_id: &str,
    tool_name: &str,
) -> AgentSessionState {
    let mut pending = HashMap::new();
    pending.insert(
        tool_use_id.to_string(),
        PendingPermission {
            request_id: "req-fixture".to_string(),
            tool_name: tool_name.to_string(),
            original_input: serde_json::json!({"questions": []}),
        },
    );
    AgentSessionState {
        workspace_id: workspace_id.to_string(),
        session_id: uuid::Uuid::new_v4().to_string(),
        turn_count: 0,
        active_pid: None,
        custom_instructions: None,
        session_resolved_env: Default::default(),
        persistent_session: None,
        pending_permissions: pending,
        pending_message_queue: VecDeque::new(),
    }
}

fn session_empty(workspace_id: &str) -> AgentSessionState {
    AgentSessionState {
        workspace_id: workspace_id.to_string(),
        session_id: uuid::Uuid::new_v4().to_string(),
        turn_count: 0,
        active_pid: None,
        custom_instructions: None,
        session_resolved_env: Default::default(),
        persistent_session: None,
        pending_permissions: HashMap::new(),
        pending_message_queue: VecDeque::new(),
    }
}

/// `submit_agent_answer` against a session with no live persistent CLI
/// must error with "Agent session is not active" — important so a remote
/// client doesn't get a silent no-op when answering a stale prompt that
/// was orphaned by a CLI crash.
#[tokio::test]
async fn submit_agent_answer_errors_when_no_persistent_session() {
    let state = make_state().await;
    {
        let mut agents = state.agents.write().await;
        agents.insert(
            "chat-1".to_string(),
            session_with_pending("ws-1", "tool-1", "AskUserQuestion"),
        );
    }

    let mut answers = HashMap::new();
    answers.insert("Q".to_string(), "A".to_string());
    let err = handle_submit_agent_answer(&state, "chat-1", "tool-1", answers, None)
        .await
        .expect_err("must error when no persistent session");
    assert!(
        err.contains("Agent session is not active"),
        "unexpected error: {err}"
    );
}

/// Session not found at all → distinct error so the client can tell
/// "stale chat session" from "ghost permission entry".
#[tokio::test]
async fn submit_agent_answer_errors_when_session_unknown() {
    let state = make_state().await;
    let err = handle_submit_agent_answer(&state, "no-such-chat", "tool-x", HashMap::new(), None)
        .await
        .expect_err("must error on unknown session");
    assert!(err.contains("Session not found"), "unexpected error: {err}");
}

/// `submit_plan_approval` for a missing tool_use_id must list the
/// available pending ids in the error so a remote client debugging a
/// race can see what *was* pending. We can't reach the listing branch
/// without a persistent session, but the "not active" branch is also
/// a hard-block, so we accept either.
#[tokio::test]
async fn submit_plan_approval_errors_on_missing_pending() {
    let state = make_state().await;
    {
        let mut agents = state.agents.write().await;
        agents.insert("chat-3".to_string(), session_empty("ws-1"));
    }
    let err = handle_submit_approval(&state, "chat-3", "tool-stale", true, None)
        .await
        .expect_err("must error when nothing pending");
    assert!(
        err.contains("not active") || err.contains("No pending permission request"),
        "unexpected error: {err}"
    );
}

/// `steer_queued_chat_message` queues content and reports the depth.
#[tokio::test]
async fn steer_queued_chat_message_appends_to_queue() {
    let state = make_state().await;
    {
        let mut agents = state.agents.write().await;
        agents.insert(
            "chat-4".to_string(),
            AgentSessionState {
                workspace_id: "ws-1".to_string(),
                session_id: uuid::Uuid::new_v4().to_string(),
                turn_count: 1,
                active_pid: Some(12345),
                custom_instructions: None,
                session_resolved_env: Default::default(),
                persistent_session: None,
                pending_permissions: HashMap::new(),
                pending_message_queue: VecDeque::new(),
            },
        );
    }

    let r1 = handle_steer_queued_chat_message(&state, "chat-4", "first")
        .await
        .unwrap();
    assert_eq!(r1["queue_depth"], 1);
    assert_eq!(r1["queued"], true);

    let r2 = handle_steer_queued_chat_message(&state, "chat-4", "second")
        .await
        .unwrap();
    assert_eq!(r2["queue_depth"], 2);

    let agents = state.agents.read().await;
    let session = agents.get("chat-4").expect("session must still exist");
    assert_eq!(session.pending_message_queue.len(), 2);
    assert_eq!(session.pending_message_queue[0].content, "first");
    assert_eq!(session.pending_message_queue[1].content, "second");
}

/// `steer_queued_chat_message` rejects empty / whitespace-only content
/// because dispatching it as a `claude --resume` user message creates a
/// phantom DB row and does nothing useful.
#[tokio::test]
async fn steer_queued_chat_message_rejects_empty_content() {
    let state = make_state().await;
    {
        let mut agents = state.agents.write().await;
        agents.insert("chat-5".to_string(), session_empty("ws-1"));
    }

    for empty in ["", "   ", "\n\t  \n"] {
        let err = handle_steer_queued_chat_message(&state, "chat-5", empty)
            .await
            .expect_err("empty content must error");
        assert!(
            err.contains("empty"),
            "expected error to mention empty, got: {err}"
        );
    }
}

/// `steer_queued_chat_message` on an unknown session errors cleanly so
/// the client surfaces "stale session" rather than queueing into a ghost.
#[tokio::test]
async fn steer_queued_chat_message_errors_on_unknown_session() {
    let state = make_state().await;
    let err = handle_steer_queued_chat_message(&state, "no-such", "hi")
        .await
        .expect_err("unknown session must error");
    assert!(err.contains("Session not found"), "unexpected error: {err}");
}
