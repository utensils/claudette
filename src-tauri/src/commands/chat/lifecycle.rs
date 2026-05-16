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
    let persisted_sid = db
        .get_chat_session(&chat_session_id)
        .map_err(|e| e.to_string())?
        .and_then(|session| session.session_id);

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
    let pi_sid = ended_sid.or(persisted_sid);
    if let Some(sid) = pi_sid.as_deref().filter(|s| !s.is_empty()) {
        #[cfg(feature = "pi-sdk")]
        super::remove_pi_session_dir(&state.db_path, sid).await;
        let _ = db.end_agent_session(sid, false);
    }

    crate::tray::rebuild_tray(&app);
    Ok(())
}

/// Result of applying a cross-harness migration to an
/// `AgentSessionState`.
///
/// Caller releases the agents-map lock between this snapshot and the
/// awaits that act on its fields (subprocess kill, permission denies,
/// DB writes) — matching `take_stop_snapshot`'s pattern.
pub(super) struct MigrationSnapshot {
    /// Session id the prior harness was using. Empty if the session
    /// had never reached a first turn under any harness. Caller
    /// retires this in the DB and (when Pi is compiled in) removes
    /// the matching session directory.
    pub prior_session_id: String,
    /// Fresh UUID the new harness will use for its session id.
    /// Already written into the in-memory `AgentSessionState` —
    /// caller persists it via `save_chat_session_state`.
    pub new_session_id: String,
    /// PID of the prior persistent subprocess, if one was running.
    /// Caller terminates it after releasing the lock.
    pub pid_to_kill: Option<u32>,
    /// Pending permission requests draining the prior harness, paired
    /// with the harness handle they belong to. Caller denies them
    /// with a "session migrated" reason.
    pub drained_permissions: Option<(Arc<AgentSession>, Vec<PendingPermission>)>,
}

/// Mutate `session` so the next turn flows through a new harness
/// with the prior conversation queued as a prelude.
///
/// Pure on `session` — does no I/O. Splits the lock-held mutation
/// out of [`prepare_cross_harness_migration`] so the test suite can
/// pin the contract without standing up an `AppState`.
pub(super) fn apply_migration_to_session(
    session: &mut AgentSessionState,
    prelude: Option<String>,
) -> MigrationSnapshot {
    let drained_permissions = drain_pending_permissions(session);
    let prior_persistent = session.persistent_session.clone();
    let pid_to_kill = session.active_pid.take();
    let prior_session_id = std::mem::take(&mut session.session_id);

    let new_session_id = uuid::Uuid::new_v4().to_string();
    session.session_id = new_session_id.clone();
    session.turn_count = 0;
    session.persistent_session = None;
    session.session_backend_hash = String::new();
    session.pending_history_prelude = prelude;

    // `prior_persistent` is needed both for `agent::stop_agent`
    // (handled via `pid_to_kill`) and for `deny_drained_permissions`
    // (handled via `drained_permissions` below). We surface the
    // `Arc<AgentSession>` only for the permission-deny path; the
    // process kill path uses pid alone.
    let drained_permissions = match (drained_permissions, prior_persistent) {
        (Some((_, drained)), Some(ps)) => Some((ps, drained)),
        _ => None,
    };

    MigrationSnapshot {
        prior_session_id,
        new_session_id,
        pid_to_kill,
        drained_permissions,
    }
}

/// Queue a cross-harness migration so the next turn carries the prior
/// conversation as a prelude.
///
/// Used by the frontend `applySelectedModel` helper when the model
/// swap crosses harnesses (e.g. Anthropic Claude Code -> Codex
/// app-server, or Codex -> Pi SDK). The destination harness's native
/// transcript format is incompatible with the source's, so we can't
/// hand `claude --resume <sid>` or Codex `thread/resume` a transcript
/// it understands. Instead we:
///
/// 1. Load every persisted `chat_messages` row for this session.
/// 2. Render them as a single user-message prelude (see
///    `agent::history_seeder::build_migration_prelude`).
/// 3. Stash the prelude on the in-memory `AgentSessionState`.
/// 4. Mint a fresh `session_id` and zero `turn_count` so the next
///    spawn under the new harness starts cleanly (no stale JSONL or
///    Pi session-dir collision).
/// 5. Tear down any persistent subprocess so the next turn respawns
///    under the new harness.
///
/// The user's chat history (the rows in `chat_messages`) is
/// untouched: the UI keeps showing every prior turn as normal. The
/// prelude is invisible to the UI — it only reaches the new harness
/// as the leading text of turn 1.
///
/// If there are no messages to seed (a brand-new chat being switched
/// before its first turn), this command still mints a fresh session
/// id so the harness change is honored cleanly.
#[tauri::command]
#[tracing::instrument(
    target = "claudette::chat",
    skip(app, state),
    fields(chat_session_id = %session_id),
)]
pub async fn prepare_cross_harness_migration(
    session_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let chat_session_id = session_id;

    // Pull every persisted message for this chat session, ordered by
    // creation. Use the session-scoped DB API so we don't scan the
    // whole workspace; ordering is preserved by the underlying
    // `ORDER BY created_at, rowid` in the DB layer.
    let chat_session = db
        .get_chat_session(&chat_session_id)
        .map_err(|e| e.to_string())?
        .ok_or("Chat session not found")?;
    let workspace_id = chat_session.workspace_id.clone();
    let messages: Vec<ChatMessage> = db
        .list_chat_messages_for_session(&chat_session_id)
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|m| !matches!(m.role, ChatRole::System))
        .collect();

    let prelude = agent::history_seeder::build_migration_prelude(&messages);

    // Tear down the prior harness's persistent subprocess (if any).
    // The new harness can't reuse it — different binary, different
    // protocol. Capturing the snapshot under the lock then releasing
    // before the awaits keeps the lock window tight (mirrors
    // `reset_agent_session`'s pattern).
    let snapshot = {
        let mut agents = state.agents.write().await;
        let session = agents
            .entry(chat_session_id.clone())
            .or_insert_with(|| AgentSessionState {
                workspace_id: workspace_id.clone(),
                session_id: String::new(),
                turn_count: 0,
                active_pid: None,
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
                session_fast_mode: false,
                session_disable_1m_context: false,
                session_backend_hash: String::new(),
                pending_permissions: Default::default(),
                running_background_tasks: Default::default(),
                background_wake_active: false,
                background_task_output_paths: Default::default(),
                session_exited_plan: false,
                session_resolved_env: Default::default(),
                session_resolved_env_signature: String::new(),
                mcp_bridge: None,
                last_user_msg_id: None,
                posted_env_trust_warning: false,
                pending_history_prelude: None,
            });

        apply_migration_to_session(session, prelude)
    };

    if let Some((ps, drained)) = snapshot.drained_permissions {
        deny_drained_permissions(drained, &ps, "Session migrated to a different runtime.").await;
    }
    if let Some(pid) = snapshot.pid_to_kill {
        let _ = agent::stop_agent(pid).await;
    }

    // Persist the fresh session_id + turn_count so
    // `send_chat_message`'s session-restore branch starts the new
    // harness from a clean slate.
    db.save_chat_session_state(&chat_session_id, &snapshot.new_session_id, 0)
        .map_err(|e| e.to_string())?;
    // Retire the prior session id (if any) so the agent_sessions
    // table doesn't accumulate orphan rows pointing at the old
    // transcript, and the Pi session dir for that id is cleaned up.
    if !snapshot.prior_session_id.is_empty() {
        let _ = db.end_agent_session(&snapshot.prior_session_id, false);
        #[cfg(feature = "pi-sdk")]
        super::remove_pi_session_dir(&state.db_path, &snapshot.prior_session_id).await;
    }

    crate::tray::rebuild_tray(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{apply_migration_to_session, take_stop_snapshot};
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
            session_fast_mode: false,
            session_disable_1m_context: false,
            session_backend_hash: String::new(),
            pending_permissions: HashMap::new(),
            running_background_tasks: Default::default(),
            background_wake_active: false,
            background_task_output_paths: std::collections::HashMap::new(),
            session_exited_plan: false,
            session_resolved_env: Default::default(),
            session_resolved_env_signature: String::new(),
            mcp_bridge: None,
            last_user_msg_id: None,
            posted_env_trust_warning: false,
            pending_history_prelude: None,
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

    #[test]
    fn apply_migration_mints_fresh_session_id_and_zeroes_turn_count() {
        // Regression pin for the cross-harness contract: the new
        // harness must start with a fresh sid + turn_count=0 so its
        // own resume mechanism (`--resume`, Codex thread/resume, Pi
        // continueRecent) decides "no prior history" — the prelude
        // we'll merge into the next user turn IS the resume payload.
        let mut session = fresh_session("sess-claude-old", 5, Some(11111));
        let prior = session.session_id.clone();

        let snapshot = apply_migration_to_session(&mut session, Some("PRELUDE".into()));

        assert_eq!(snapshot.prior_session_id, prior);
        assert_ne!(session.session_id, prior, "must mint a new sid");
        assert!(!session.session_id.is_empty());
        assert_eq!(session.turn_count, 0);
        assert!(session.persistent_session.is_none());
        assert!(
            session.session_backend_hash.is_empty(),
            "blanking the hash forces the drift check to respawn under the new harness"
        );
        assert_eq!(
            session.pending_history_prelude.as_deref(),
            Some("PRELUDE"),
            "prelude must be queued so send_chat_message prepends it"
        );
    }

    #[test]
    fn apply_migration_handles_empty_prelude() {
        // Migrating a brand-new chat (no prior messages) still needs
        // to honour the harness switch — fresh sid, zero turn count,
        // but no prelude (no history to seed).
        let mut session = fresh_session("sess-fresh", 0, None);
        let snapshot = apply_migration_to_session(&mut session, None);

        assert_eq!(snapshot.prior_session_id, "sess-fresh");
        assert!(!session.session_id.is_empty());
        assert_eq!(session.turn_count, 0);
        assert!(
            session.pending_history_prelude.is_none(),
            "no history to seed means no prelude"
        );
    }

    #[test]
    fn apply_migration_captures_pid_for_teardown() {
        // The Tauri command awaits `agent::stop_agent(pid)` outside
        // the lock; if the snapshot loses the pid the prior harness
        // keeps running in the background and consuming resources.
        let mut session = fresh_session("sess-running", 3, Some(42));
        let snapshot = apply_migration_to_session(&mut session, Some("p".into()));
        assert_eq!(snapshot.pid_to_kill, Some(42));
        assert!(
            session.active_pid.is_none(),
            "active_pid must move to the snapshot so the caller can kill without racing"
        );
    }

    #[test]
    fn apply_migration_preserves_attention_state() {
        // Attention flags are UI-side. The user can still respond to
        // an outstanding question even after migrating models — the
        // question itself was persisted to chat_messages and is
        // re-served on the next render. Migration must not silently
        // wipe needs_attention.
        let mut session = fresh_session("sess-with-q", 4, Some(99));
        session.needs_attention = true;
        session.attention_kind = Some(crate::state::AttentionKind::Ask);
        session.attention_notification_sent = true;

        let _snapshot = apply_migration_to_session(&mut session, Some("p".into()));

        assert!(session.needs_attention);
        assert!(matches!(
            session.attention_kind,
            Some(crate::state::AttentionKind::Ask)
        ));
        assert!(session.attention_notification_sent);
    }
}
