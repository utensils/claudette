use std::sync::Arc;

use tauri::{AppHandle, State};

use claudette::agent::{self, AgentSession};
use claudette::db::Database;
use claudette::model::{ChatMessage, ChatRole};

use crate::state::{AgentSessionState, AppState, PendingPermission};

use super::interaction::{deny_drained_permissions, drain_pending_permissions};
use super::now_iso;

/// What `take_stop_snapshot` hands back: permissions to deny, optional harness
/// interrupt handle, pid fallback, and the session id to mark ended in the DB.
type StopSnapshot = (
    Option<(Arc<AgentSession>, Vec<PendingPermission>)>,
    Option<Arc<AgentSession>>,
    Option<u32>,
    Option<String>,
);

/// Mutations performed on an agent session when the user clicks Stop.
///
/// Stop interrupts the in-flight turn through the persistent harness handle
/// when available, then falls back to process termination for harnesses or
/// failure modes that still need it. It also drains pending permission
/// requests so the caller can deny them.
///
/// This deliberately does NOT clear `session_id`, `turn_count`, or
/// `persistent_session`: those are owned by `reset_agent_session` and
/// `clear_conversation`. Preserving them lets each harness keep its own
/// continuation contract. For Claude Code specifically, the next
/// `send_chat_message` can resume via `--resume` if the stopped process had to
/// be respawned.
fn take_stop_snapshot(session: &mut AgentSessionState) -> StopSnapshot {
    let drained = drain_pending_permissions(session);
    let ended_sid = Some(session.session_id.clone());
    let pid = session.active_pid.take();
    let interrupt_session = if pid.is_some() {
        session.persistent_session.clone()
    } else {
        None
    };
    // Stop interrupts the cycle outright — make sure a future prompt on the
    // same session can still fire its notification (full reset, not just
    // `needs_attention=false`).
    session.reset_attention();
    (drained, interrupt_session, pid, ended_sid)
}

#[tauri::command]
#[tracing::instrument(
    target = "claudette::chat",
    skip(app, state),
    fields(chat_session_id = %session_id),
)]
pub async fn stop_agent(
    session_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let chat_session_id = session_id;
    let chat_session = db
        .get_chat_session(&chat_session_id)
        .map_err(|e| e.to_string())?
        .ok_or("Chat session not found")?;
    let workspace_id = chat_session.workspace_id.clone();

    // Drain pending permissions and snapshot the cleanup state synchronously
    // under the lock; deny sends, the kill, and the DB session-end happen
    // after we release it.
    let (to_deny_stop, interrupt_session, pid_to_kill, ended_sid) = {
        let mut agents = state.agents.write().await;
        match agents.get_mut(&chat_session_id) {
            Some(session) => take_stop_snapshot(session),
            None => (None, None, None, None),
        }
    };

    if let Some((ref ps, drained)) = to_deny_stop {
        deny_drained_permissions(drained, ps, "Session stopped by user.").await;
    }
    if let Some(ps) = interrupt_session {
        if let Err(err) = ps.interrupt_turn().await {
            tracing::warn!(
                target: "claudette::chat",
                error = %err,
                "agent protocol interrupt failed; falling back to process kill"
            );
            if let Some(pid) = pid_to_kill {
                agent::stop_agent(pid).await?;
            }
        }
    } else if let Some(pid) = pid_to_kill {
        agent::stop_agent(pid).await?;
    }

    // Stop aborts an in-flight turn but deliberately preserves the persisted
    // Claude resume UUID and turn count so the next turn can continue the
    // conversation via `--resume`. Only the agent_sessions audit row is closed
    // out as a failure.
    if let Some(sid) = ended_sid.as_deref().filter(|s| !s.is_empty()) {
        let _ = db.end_agent_session(sid, false);
    }

    crate::tray::rebuild_tray(&app);

    // Log stop message on this chat session.
    let msg = ChatMessage {
        id: uuid::Uuid::new_v4().to_string(),
        workspace_id,
        chat_session_id,
        role: ChatRole::System,
        content: "Agent stopped".to_string(),
        cost_usd: None,
        duration_ms: None,
        created_at: now_iso(),
        thinking: None,
        input_tokens: None,
        output_tokens: None,
        cache_read_tokens: None,
        cache_creation_tokens: None,
    };
    db.insert_chat_message(&msg).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
#[tracing::instrument(
    target = "claudette::chat",
    skip(app, state),
    fields(chat_session_id = %session_id),
)]
pub async fn reset_agent_session(
    session_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let chat_session_id = session_id;

    // Drain pending permissions under the lock, remove the session, capture
    // its session_id and any active PID; the deny sends, process kill,
    // and DB session-end happen after release.
    let (to_deny_reset, ended_sid, pid_to_kill) = {
        let mut agents = state.agents.write().await;
        let drained = agents
            .get_mut(&chat_session_id)
            .and_then(drain_pending_permissions);
        let removed = agents.remove(&chat_session_id);
        let ended_sid = removed.as_ref().map(|s| s.session_id.clone());
        let pid_to_kill = removed.and_then(|s| s.active_pid);
        (drained, ended_sid, pid_to_kill)
    };

    if let Some((ref ps, drained)) = to_deny_reset {
        deny_drained_permissions(drained, ps, "Session reset.").await;
    }
    if let Some(pid) = pid_to_kill {
        let _ = agent::stop_agent(pid).await;
    }

    // Clear persisted claude state so the next turn starts fresh. Reset
    // discards in-flight state, so record as a failure.
    db.clear_chat_session_state(&chat_session_id)
        .map_err(|e| e.to_string())?;
    if let Some(sid) = ended_sid.as_deref().filter(|s| !s.is_empty()) {
        let _ = db.end_agent_session(sid, false);
    }

    crate::tray::rebuild_tray(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::take_stop_snapshot;
    use crate::state::AgentSessionState;
    use claudette::agent::{AgentHarnessKind, AgentSession, CodexAppServerSession};
    use std::collections::HashMap;
    use std::sync::Arc;

    fn fresh_session(session_id: &str, turn_count: u32, pid: Option<u32>) -> AgentSessionState {
        AgentSessionState {
            workspace_id: String::new(),
            session_id: session_id.to_string(),
            turn_count,
            active_pid: pid,
            custom_instructions: None,
            needs_attention: false,
            attention_kind: None,
            attention_notification_sent: false,
            persistent_session: None,
            claude_remote_control: crate::state::ClaudeRemoteControlStatus::disabled(),
            claude_remote_control_monitor_pid: None,
            local_user_message_uuids: Default::default(),
            mcp_config_dirty: false,
            session_plan_mode: false,
            session_allowed_tools: Vec::new(),
            session_disable_1m_context: false,
            session_backend_hash: String::new(),
            pending_permissions: HashMap::new(),
            running_background_tasks: Default::default(),
            background_wake_active: false,
            session_exited_plan: false,
            session_resolved_env: Default::default(),
            session_resolved_env_signature: String::new(),
            mcp_bridge: None,
            last_user_msg_id: None,
            posted_env_trust_warning: false,
        }
    }

    #[test]
    fn take_stop_snapshot_preserves_session_identity_for_resume() {
        // Regression guard for the bug where Stop wiped session_id/turn_count,
        // causing the next send to start a brand-new conversation instead of
        // resuming. Stop must leave those fields intact so send_chat_message
        // can spawn the CLI with --resume <session_id>.
        let mut session = fresh_session("sess-abc", 7, Some(12345));

        let (drained, interrupt_session, pid, ended_sid) = take_stop_snapshot(&mut session);

        // Caller receives the pid to kill and the sid to log.
        assert!(drained.is_none(), "no pending permissions to drain");
        assert!(interrupt_session.is_none());
        assert_eq!(pid, Some(12345));
        assert_eq!(ended_sid.as_deref(), Some("sess-abc"));

        // Session identity is preserved — this is the fix.
        assert_eq!(session.session_id, "sess-abc");
        assert_eq!(session.turn_count, 7);
        assert!(session.persistent_session.is_none());

        // active_pid is consumed so the caller can kill without racing.
        assert!(session.active_pid.is_none());
    }

    #[test]
    fn take_stop_snapshot_is_idempotent_when_already_stopped() {
        // A double-stop (e.g. user clicks Stop twice) must not corrupt state.
        let mut session = fresh_session("sess-abc", 7, None);

        let (_, interrupt_session, pid, ended_sid) = take_stop_snapshot(&mut session);

        assert!(interrupt_session.is_none());
        assert!(pid.is_none());
        assert_eq!(ended_sid.as_deref(), Some("sess-abc"));
        assert_eq!(session.session_id, "sess-abc");
        assert_eq!(session.turn_count, 7);
    }

    #[test]
    fn take_stop_snapshot_preserves_persistent_session_for_protocol_interrupt() {
        let mut session = fresh_session("sess-codex", 2, Some(4321));
        session.persistent_session = Some(Arc::new(AgentSession::from_codex_app_server(
            CodexAppServerSession::new_for_test(4321),
        )));

        let (_, interrupt_session, pid, _) = take_stop_snapshot(&mut session);

        assert_eq!(pid, Some(4321));
        assert_eq!(
            interrupt_session
                .expect("interrupt session should be captured")
                .kind(),
            AgentHarnessKind::CodexAppServer
        );
        assert!(session.persistent_session.is_some());
    }

    #[test]
    fn take_stop_snapshot_does_not_interrupt_idle_persistent_session() {
        let mut session = fresh_session("sess-codex", 2, None);
        session.persistent_session = Some(Arc::new(AgentSession::from_codex_app_server(
            CodexAppServerSession::new_for_test(4321),
        )));

        let (_, interrupt_session, pid, _) = take_stop_snapshot(&mut session);

        assert!(interrupt_session.is_none());
        assert!(pid.is_none());
        assert!(session.persistent_session.is_some());
    }

    #[test]
    fn take_stop_snapshot_clears_attention_flags() {
        use crate::state::AttentionKind;

        let mut session = fresh_session("sess-abc", 3, Some(999));
        session.needs_attention = true;
        session.attention_kind = Some(AttentionKind::Ask);
        // Stop must also reset the notification dedup flag so a future
        // prompt on this session can re-trigger its tray notification.
        session.attention_notification_sent = true;

        take_stop_snapshot(&mut session);

        assert!(!session.needs_attention);
        assert!(session.attention_kind.is_none());
        assert!(!session.attention_notification_sent);
    }
}
