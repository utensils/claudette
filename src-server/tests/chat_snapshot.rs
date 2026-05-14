//! Integration tests for the `get_chat_snapshot` RPC handler. Tests call
//! `snapshot::build` directly — the public `handle_request` entrypoint
//! takes an `Arc<Writer>` (a real TLS-wrapped WebSocket sink) which can't
//! be constructed without a live handshake. Same pattern as
//! `interactive_controls.rs`.
//!
//! These tests pin: the unknown-session error shape, the limit clamp's
//! boundary behavior, that `pending_controls` round-trips the in-memory
//! `pending_permissions` map (with deterministic ordering and the desktop
//! `kind` enum), pagination semantics (`has_more` + `total_count`), and
//! the safe-inline attachment rules (small text inlined, binary metadata-only).
//! A regression in any of these would silently break a mobile client's
//! ability to recover after a disconnect or lagged broadcast.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use claudette::db::Database;
use claudette::model::{
    AgentStatus, Attachment, AttachmentOrigin, AttentionKind, ChatMessage, ChatRole, Repository,
    Workspace, WorkspaceStatus,
};
use claudette::plugin_runtime::PluginRegistry;
use claudette_server::snapshot::{self, PendingAgentControlKind};
use claudette_server::ws::{AgentSessionState, PendingPermission, ServerState};

async fn make_state() -> (Arc<ServerState>, tempfile::TempDir) {
    let temp = tempfile::tempdir().unwrap();
    let db_path = temp.path().join("test.db");
    Database::open(&db_path).unwrap();
    let worktree_base = temp.path().join("workspaces");
    std::fs::create_dir_all(&worktree_base).unwrap();
    let plugins = PluginRegistry::discover(temp.path());
    let state = Arc::new(ServerState::new_with_plugins(
        db_path,
        worktree_base,
        plugins,
    ));
    (state, temp)
}

fn make_repo(id: &str) -> Repository {
    Repository {
        id: id.into(),
        path: format!("/tmp/{id}"),
        name: id.into(),
        path_slug: id.into(),
        icon: None,
        created_at: String::new(),
        setup_script: None,
        custom_instructions: None,
        sort_order: 0,
        branch_rename_preferences: None,
        setup_script_auto_run: false,
        archive_script: None,
        archive_script_auto_run: false,
        base_branch: None,
        default_remote: None,
        required_inputs: None,
        path_valid: true,
    }
}

fn make_workspace(id: &str, repo_id: &str) -> Workspace {
    Workspace {
        id: id.into(),
        repository_id: repo_id.into(),
        name: id.into(),
        branch_name: "main".into(),
        worktree_path: Some(format!("/tmp/{id}")),
        status: WorkspaceStatus::Active,
        agent_status: claudette::model::AgentStatus::Idle,
        status_line: String::new(),
        created_at: String::new(),
        sort_order: 0,
        input_values: None,
    }
}

fn make_message(id: &str, workspace_id: &str, session_id: &str, role: ChatRole) -> ChatMessage {
    ChatMessage {
        id: id.into(),
        workspace_id: workspace_id.into(),
        chat_session_id: session_id.into(),
        role,
        content: format!("hello from {id}"),
        cost_usd: None,
        duration_ms: None,
        // `created_at` is filled by the schema DEFAULT on INSERT.
        created_at: String::new(),
        thinking: None,
        input_tokens: None,
        output_tokens: None,
        cache_read_tokens: None,
        cache_creation_tokens: None,
    }
}

fn make_attachment(id: &str, message_id: &str, media_type: &str, data: Vec<u8>) -> Attachment {
    let size = data.len() as i64;
    Attachment {
        id: id.into(),
        message_id: message_id.into(),
        filename: format!("{id}.bin"),
        media_type: media_type.into(),
        data,
        width: None,
        height: None,
        size_bytes: size,
        // Filled by the schema DEFAULT on INSERT.
        created_at: String::new(),
        origin: AttachmentOrigin::User,
        tool_use_id: None,
    }
}

fn empty_session(workspace_id: &str) -> AgentSessionState {
    AgentSessionState {
        workspace_id: workspace_id.into(),
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

/// Seed a repository + workspace + chat session and return the session id.
fn seed_session(db: &Database) -> (String, String) {
    db.insert_repository(&make_repo("repo-1")).unwrap();
    db.insert_workspace(&make_workspace("ws-1", "repo-1"))
        .unwrap();
    let session = db.create_chat_session("ws-1").unwrap();
    (session.id, "ws-1".to_string())
}

#[tokio::test]
async fn snapshot_unknown_session_errors() {
    let (state, _temp) = make_state().await;
    let err = snapshot::build(&state, "nope", 50, None)
        .await
        .expect_err("unknown session must error");
    assert_eq!(err, "Session not found");
}

#[tokio::test]
async fn snapshot_empty_session_round_trips() {
    let (state, _temp) = make_state().await;
    let db = Database::open(&state.db_path).unwrap();
    let (session_id, _ws_id) = seed_session(&db);

    let snap = snapshot::build(&state, &session_id, 50, None)
        .await
        .unwrap();
    assert_eq!(snap.session.id, session_id);
    assert!(snap.messages.is_empty());
    assert!(snap.attachments.is_empty());
    assert!(snap.completed_turns.is_empty());
    assert!(snap.pending_controls.is_empty());
    assert!(!snap.has_more);
    assert_eq!(snap.total_count, 0);
}

#[tokio::test]
async fn snapshot_round_trips_pending_controls_sorted_by_tool_use_id() {
    let (state, _temp) = make_state().await;
    let db = Database::open(&state.db_path).unwrap();
    let (session_id, ws_id) = seed_session(&db);

    let mut pending = HashMap::new();
    pending.insert(
        "tool-b".into(),
        PendingPermission {
            request_id: "req-b".into(),
            tool_name: "ExitPlanMode".into(),
            original_input: serde_json::json!({"plan": "do the thing"}),
        },
    );
    pending.insert(
        "tool-a".into(),
        PendingPermission {
            request_id: "req-a".into(),
            tool_name: "AskUserQuestion".into(),
            original_input: serde_json::json!({"questions": [{"question": "ok?"}]}),
        },
    );
    pending.insert(
        "tool-c".into(),
        PendingPermission {
            request_id: "req-c".into(),
            tool_name: "SomeFutureTool".into(),
            original_input: serde_json::json!({}),
        },
    );

    {
        let mut agents = state.agents.write().await;
        let mut s = empty_session(&ws_id);
        s.pending_permissions = pending;
        agents.insert(session_id.clone(), s);
    }

    let snap = snapshot::build(&state, &session_id, 50, None)
        .await
        .unwrap();
    let kinds: Vec<_> = snap
        .pending_controls
        .iter()
        .map(|c| (c.tool_use_id.as_str(), c.kind.clone()))
        .collect();
    assert_eq!(
        kinds,
        vec![
            ("tool-a", PendingAgentControlKind::AskUserQuestion),
            ("tool-b", PendingAgentControlKind::ExitPlanMode),
            ("tool-c", PendingAgentControlKind::Unknown),
        ]
    );
    // request_id stays internal — verify it does NOT round-trip through the wire shape.
    let json = serde_json::to_value(&snap.pending_controls).unwrap();
    assert!(
        !json.to_string().contains("req-a"),
        "request_id must not appear in pending_controls wire shape"
    );
    // original_input is renamed to `input` on the wire.
    assert_eq!(
        json[0]["input"]["questions"][0]["question"],
        serde_json::json!("ok?")
    );
}

#[tokio::test]
async fn snapshot_limit_cap_and_pagination_metadata() {
    let (state, _temp) = make_state().await;
    let db = Database::open(&state.db_path).unwrap();
    let (session_id, ws_id) = seed_session(&db);

    // Insert 3 messages so total_count = 3 and a limit < 3 forces has_more.
    for i in 0..3 {
        let msg = make_message(
            &format!("m{i}"),
            &ws_id,
            &session_id,
            if i % 2 == 0 {
                ChatRole::User
            } else {
                ChatRole::Assistant
            },
        );
        db.insert_chat_message(&msg).unwrap();
    }

    // Request the absolute max — clamp lets it through unchanged.
    let snap = snapshot::build(&state, &session_id, snapshot::MAX_SNAPSHOT_LIMIT, None)
        .await
        .unwrap();
    assert_eq!(snap.messages.len(), 3);
    assert_eq!(snap.total_count, 3);
    assert!(!snap.has_more);

    // Request fewer than exist — has_more must flip true.
    let snap = snapshot::build(&state, &session_id, 2, None).await.unwrap();
    assert_eq!(snap.messages.len(), 2);
    assert_eq!(snap.total_count, 3);
    assert!(snap.has_more);

    // The clamp helper itself caps oversized requests at MAX (200).
    assert_eq!(
        snapshot::clamp_limit(Some(500)),
        snapshot::MAX_SNAPSHOT_LIMIT
    );
}

#[tokio::test]
async fn snapshot_inlines_small_text_attachments_skips_binary() {
    let (state, _temp) = make_state().await;
    let db = Database::open(&state.db_path).unwrap();
    let (session_id, ws_id) = seed_session(&db);

    let msg = make_message("m1", &ws_id, &session_id, ChatRole::User);
    db.insert_chat_message(&msg).unwrap();

    let text_att = {
        let mut att = make_attachment("a-text", "m1", "text/markdown", b"# hello".to_vec());
        att.filename = "note.md".into();
        att
    };
    let binary_att = {
        // 4-byte fake PNG. Well under per-attachment cap; still must NOT inline.
        let mut att = make_attachment("a-bin", "m1", "image/png", vec![0x89, b'P', b'N', b'G']);
        att.filename = "img.png".into();
        att
    };
    db.insert_attachment(&text_att).unwrap();
    db.insert_attachment(&binary_att).unwrap();

    let snap = snapshot::build(&state, &session_id, 50, None)
        .await
        .unwrap();
    assert_eq!(snap.attachments.len(), 2);

    let text = snap
        .attachments
        .iter()
        .find(|a| a.id == "a-text")
        .expect("text attachment present");
    assert_eq!(text.text_content.as_deref(), Some("# hello"));
    assert_eq!(text.media_type, "text/markdown");
    assert_eq!(text.filename, "note.md");

    let bin = snap
        .attachments
        .iter()
        .find(|a| a.id == "a-bin")
        .expect("binary attachment present");
    assert!(
        bin.text_content.is_none(),
        "binary attachments must never be inlined as text"
    );
    assert_eq!(bin.media_type, "image/png");
    assert_eq!(bin.size_bytes, 4);
}

/// Attachments returned by the snapshot must be ordered by the position of
/// their owning message in the page (then created_at, filename, id) — not
/// by HashMap iteration order. A snapshot that reorders attachments across
/// reconnects breaks any client logic that diffs the snapshot against
/// already-rendered state.
#[tokio::test]
async fn snapshot_attachments_follow_message_order() {
    let (state, _temp) = make_state().await;
    let db = Database::open(&state.db_path).unwrap();
    let (session_id, ws_id) = seed_session(&db);

    // Two messages, inserted in chronological order so `messages` arrives as
    // [m1, m2] in the snapshot.
    db.insert_chat_message(&make_message("m1", &ws_id, &session_id, ChatRole::User))
        .unwrap();
    db.insert_chat_message(&make_message(
        "m2",
        &ws_id,
        &session_id,
        ChatRole::Assistant,
    ))
    .unwrap();

    // Insert attachments in REVERSE message order (m2 first, then m1) so a
    // naive insertion-order or HashMap iteration would put m2's attachment
    // ahead of m1's. The snapshot must reorder them by message position.
    db.insert_attachment(&make_attachment(
        "att-m2",
        "m2",
        "text/plain",
        b"on m2".to_vec(),
    ))
    .unwrap();
    db.insert_attachment(&make_attachment(
        "att-m1",
        "m1",
        "text/plain",
        b"on m1".to_vec(),
    ))
    .unwrap();

    let snap = snapshot::build(&state, &session_id, 50, None)
        .await
        .unwrap();
    let order: Vec<&str> = snap.attachments.iter().map(|a| a.id.as_str()).collect();
    assert_eq!(
        order,
        vec!["att-m1", "att-m2"],
        "attachments must be ordered by message position, not insertion order"
    );
}

/// `ChatSession` has runtime-only fields (`agent_status`, `needs_attention`,
/// `attention_kind`) the DB always loads as defaults. Snapshot must overlay
/// live `AgentSessionState` so a recovery call returns the actual status —
/// otherwise the mobile client sees `Idle` for a running agent and may
/// incorrectly assume the turn ended.
#[tokio::test]
async fn snapshot_hydrates_runtime_fields_from_live_agent() {
    let (state, _temp) = make_state().await;
    let db = Database::open(&state.db_path).unwrap();
    let (session_id, ws_id) = seed_session(&db);

    // No agent in state.agents → DB defaults pass through untouched.
    let snap = snapshot::build(&state, &session_id, 50, None)
        .await
        .unwrap();
    assert_eq!(snap.session.agent_status, AgentStatus::Idle);
    assert!(!snap.session.needs_attention);
    assert_eq!(snap.session.attention_kind, None);

    // Live agent with an active subprocess + a pending AskUserQuestion.
    let mut pending = HashMap::new();
    pending.insert(
        "tool-ask".into(),
        PendingPermission {
            request_id: "r1".into(),
            tool_name: "AskUserQuestion".into(),
            original_input: serde_json::json!({}),
        },
    );
    {
        let mut agents = state.agents.write().await;
        let mut s = empty_session(&ws_id);
        s.active_pid = Some(4242);
        s.pending_permissions = pending;
        agents.insert(session_id.clone(), s);
    }

    let snap = snapshot::build(&state, &session_id, 50, None)
        .await
        .unwrap();
    assert_eq!(snap.session.agent_status, AgentStatus::Running);
    assert!(snap.session.needs_attention);
    assert_eq!(snap.session.attention_kind, Some(AttentionKind::Ask));

    // Add an ExitPlanMode — it must outrank Ask in attention_kind.
    {
        let mut agents = state.agents.write().await;
        let s = agents.get_mut(&session_id).unwrap();
        s.pending_permissions.insert(
            "tool-plan".into(),
            PendingPermission {
                request_id: "r2".into(),
                tool_name: "ExitPlanMode".into(),
                original_input: serde_json::json!({"plan": "x"}),
            },
        );
    }
    let snap = snapshot::build(&state, &session_id, 50, None)
        .await
        .unwrap();
    assert_eq!(snap.session.attention_kind, Some(AttentionKind::Plan));
}
