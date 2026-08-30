use tauri::State;

use claudette::agent::history_seeder::build_migration_prelude;
use claudette::db::Database;
use claudette::model::{
    ChatMessage, ChatRole, CompletedTurnData, ConversationCheckpoint, TurnToolActivity,
};
use claudette::{agent, git, snapshot};

use crate::state::{AgentSessionState, AppState};

use super::interaction::deny_drained_permissions;
use super::lifecycle::apply_migration_to_session;

#[tauri::command]
pub async fn list_checkpoints(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<ConversationCheckpoint>, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.list_checkpoints_for_session(&session_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn rollback_to_checkpoint(
    session_id: String,
    checkpoint_id: String,
    restore_files: bool,
    state: State<'_, AppState>,
) -> Result<Vec<ChatMessage>, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let chat_session_id = session_id;

    // Load the target checkpoint and verify ownership.
    let checkpoint = db
        .get_checkpoint(&checkpoint_id)
        .map_err(|e| e.to_string())?
        .ok_or("Checkpoint not found")?;
    // Scope the rollback to the given session — prevents a rollback in tab A
    // from pruning messages in tab B. For pre-v20 checkpoints (empty
    // chat_session_id) we accept the caller's chat_session_id as
    // authoritative, since the backfill would have assigned all such
    // messages to a single session.
    if !checkpoint.chat_session_id.is_empty() && checkpoint.chat_session_id != chat_session_id {
        return Err("Checkpoint does not belong to this session".into());
    }

    // Look up the workspace for the file-restore branch below.
    let chat_session = db
        .get_chat_session(&chat_session_id)
        .map_err(|e| e.to_string())?
        .ok_or("Chat session not found")?;
    let workspace_id = chat_session.workspace_id.clone();
    // Capture the persisted prior session id + turn_count up front so
    // `or_insert_with` can seed the new `AgentSessionState` from the DB
    // (instead of stamping `session_id: String::new()`) — otherwise
    // `apply_migration_to_session` snapshots `prior_session_id` as
    // empty after an app restart, and the post-rollback cleanup
    // (`end_agent_session`) silently skips even though the DB knew
    // about the prior runtime sid.
    let persisted_prior_sid = chat_session.session_id.clone().unwrap_or_default();
    let persisted_prior_turn_count = chat_session.turn_count;

    // Guard: reject if agent is running.
    {
        let agents = state.agents.read().await;
        if let Some(session) = agents.get(&chat_session_id)
            && session.active_pid.is_some()
        {
            return Err("Cannot rollback while the agent is running".into());
        }
    }

    // Attempt file restore BEFORE any destructive DB writes so that a
    // failure does not leave the DB truncated while the frontend still shows
    // the full conversation.
    if restore_files {
        let workspaces = db.list_workspaces().map_err(|e| e.to_string())?;
        let ws = workspaces
            .iter()
            .find(|w| w.id == workspace_id)
            .ok_or("Workspace not found")?;
        let wt = ws
            .worktree_path
            .as_ref()
            .ok_or("Workspace has no worktree")?;

        if checkpoint.has_file_state {
            // New path: restore from SQLite snapshot.
            snapshot::restore_snapshot(&state.db_path, &checkpoint_id, wt)
                .await
                .map_err(|e| e.to_string())?;
        } else if let Some(ref commit_hash) = checkpoint.commit_hash {
            // Legacy path: restore from git commit.
            git::restore_to_commit(wt, commit_hash)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    // Now perform the destructive DB writes — safe because the risky git
    // operation (if requested) has already succeeded above. Scoped to this
    // session so sibling tabs are untouched.
    db.delete_session_messages_after(&chat_session_id, &checkpoint.message_id)
        .map_err(|e| e.to_string())?;
    db.delete_session_checkpoints_after(&chat_session_id, checkpoint.turn_index)
        .map_err(|e| e.to_string())?;

    // Rollback discards the messages *after* the checkpoint but the user
    // still wants the surviving turns to remain part of the agent's
    // memory on the next send. The prior session's JSONL / Codex /
    // Pi transcript can't be reused — it still contains the deleted
    // messages, and resuming it would replay them. So we mint a fresh
    // sid, zero the turn count, and queue a migration prelude built
    // from the surviving messages. The next turn's user content gets
    // the prelude prepended before reaching the harness, exactly the
    // same wiring as cross-harness migration. Without this step,
    // rollback would silently lose the agent's memory of everything,
    // not just the discarded turns — same family of regression as the
    // model-switch context loss this PR fixes.
    let surviving_messages: Vec<ChatMessage> = db
        .list_chat_messages_for_session(&chat_session_id)
        .map_err(|e| e.to_string())?
        .into_iter()
        // System rows are control-flow signals (agent stopped,
        // synthetic compaction summaries, etc.). They don't carry
        // conversation context the model should re-read, so filter
        // them out of the prelude the same way `prepare_cross_harness_migration`
        // does.
        .filter(|m| !matches!(m.role, ChatRole::System))
        .collect();
    let prelude = build_migration_prelude(&surviving_messages);

    let snapshot = {
        let mut agents = state.agents.write().await;
        let session = agents
            .entry(chat_session_id.clone())
            .or_insert_with(|| AgentSessionState {
                workspace_id: workspace_id.clone(),
                session_id: persisted_prior_sid.clone(),
                turn_count: persisted_prior_turn_count,
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
        deny_drained_permissions(drained, &ps, "Rolled back to an earlier checkpoint.").await;
    }
    if let Some(pid) = snapshot.pid_to_kill {
        let _ = agent::stop_agent(pid).await;
    }

    // Retire the prior session's audit row + Pi session dir; record the
    // new fresh sid (turn_count=0) in chat_sessions so subsequent
    // `send_chat_message` calls start from a clean slate under the new
    // sid and find the prelude on the in-memory `AgentSessionState`.
    // Belt-and-suspenders fallback: if the in-memory snapshot's prior
    // session id was empty (e.g. an `AgentSessionState` entry existed
    // but had never been wired to a runtime sid), trust the persisted
    // `chat_sessions.session_id` we captured up front so we still
    // retire the row the DB knew about.
    let prior_sid_for_cleanup = if snapshot.prior_session_id.is_empty() {
        persisted_prior_sid
    } else {
        snapshot.prior_session_id.clone()
    };
    if !prior_sid_for_cleanup.is_empty() {
        let _ = db.end_agent_session(&prior_sid_for_cleanup, false);
    }
    db.save_chat_session_state(&chat_session_id, &snapshot.new_session_id, 0)
        .map_err(|e| e.to_string())?;

    // Return the truncated message list for this session.
    db.list_chat_messages_for_session(&chat_session_id)
        .map_err(|e| e.to_string())
}

/// Clear the entire conversation for a workspace, optionally restoring files
/// to the merge-base (initial state before any agent work).
#[tauri::command]
pub async fn clear_conversation(
    session_id: String,
    restore_files: bool,
    state: State<'_, AppState>,
) -> Result<Vec<ChatMessage>, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let chat_session_id = session_id;
    let chat_session = db
        .get_chat_session(&chat_session_id)
        .map_err(|e| e.to_string())?
        .ok_or("Chat session not found")?;
    let workspace_id = chat_session.workspace_id.clone();

    // Guard: reject if agent is running.
    {
        let agents = state.agents.read().await;
        if let Some(session) = agents.get(&chat_session_id)
            && session.active_pid.is_some()
        {
            return Err("Cannot clear conversation while the agent is running".into());
        }
    }

    // Optionally restore files to the merge-base before clearing.
    if restore_files {
        let workspaces = db.list_workspaces().map_err(|e| e.to_string())?;
        let ws = workspaces
            .iter()
            .find(|w| w.id == workspace_id)
            .ok_or("Workspace not found")?;
        let wt = ws
            .worktree_path
            .as_ref()
            .ok_or("Workspace has no worktree")?;
        let repos = db.list_repositories().map_err(|e| e.to_string())?;
        let repo = repos
            .iter()
            .find(|r| r.id == ws.repository_id)
            .ok_or("Repository not found")?;
        let base = match repo.base_branch.as_deref() {
            Some(b) => b.to_string(),
            None => git::default_branch(&repo.path, repo.default_remote.as_deref())
                .await
                .map_err(|e| e.to_string())?,
        };
        let merge_base = claudette::diff::merge_base(wt, &ws.branch_name, &base)
            .await
            .map_err(|e| e.to_string())?;
        git::restore_to_commit(wt, &merge_base)
            .await
            .map_err(|e| e.to_string())?;
    }

    // Delete all messages and checkpoints for this session.
    db.delete_chat_messages_for_session(&chat_session_id)
        .map_err(|e| e.to_string())?;
    // Checkpoints cascade via FK, but delete explicitly for clarity.
    db.delete_session_checkpoints_after(&chat_session_id, -1)
        .map_err(|e| e.to_string())?;

    // Reset agent session. Clearing the conversation discards the session's
    // prior work, so it did not run to completion — record as a failure.
    let ended_sid = {
        let mut agents = state.agents.write().await;
        agents.remove(&chat_session_id).map(|s| s.session_id)
    };
    if let Some(sid) = ended_sid.as_deref() {
        let _ = db.end_agent_session(sid, false);
    }
    db.clear_chat_session_state(&chat_session_id)
        .map_err(|e| e.to_string())?;

    // Return empty list.
    db.list_chat_messages_for_session(&chat_session_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_turn_tool_activities(
    checkpoint_id: String,
    message_count: i32,
    activities: Vec<TurnToolActivity>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.save_turn_tool_activities(&checkpoint_id, message_count, &activities)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Persist the final workflow progress tree for an activity whose turn has
/// already been checkpointed. See
/// [`claudette::db::Database::update_turn_tool_activity_progress`] for why a
/// targeted update is needed rather than a re-save of the whole turn.
///
/// A terminal `agent_status` routes through
/// [`claudette::db::Database::finish_workflow_activity`] so the caller's tree
/// is reconciled against it. The webview holds the freshest snapshot (only it
/// sees the `task_progress` ticks that arrive after the turn was
/// checkpointed), but that snapshot predates the run's final transitions —
/// writing it verbatim would put back the stale "48/49" the Rust-side
/// notification handler had just resolved, since the two writers race.
/// Reconciling on both paths makes the outcome order-independent.
///
/// `chat_session_id` scopes that terminal write to one activity. Forking
/// copies `tool_use_id` verbatim into the fork's rows (`crate::fork`), so
/// without it a completion would rewrite the copied history in every fork.
/// Optional so the command's existing payload stays valid: callers that omit
/// it fall back to the unscoped update this command has always performed,
/// rather than silently writing nothing.
#[tauri::command]
pub async fn update_turn_tool_activity_progress(
    tool_use_id: String,
    workflow_progress_json: Option<String>,
    agent_status: Option<String>,
    chat_session_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    match (agent_status.as_deref(), chat_session_id.as_deref()) {
        (Some(status), Some(session_id))
            if claudette::agent::workflow_progress::is_terminal_task_status(status) =>
        {
            db.finish_workflow_activity(
                session_id,
                Some(&tool_use_id),
                None,
                status,
                workflow_progress_json.as_deref(),
            )
            .map_err(|e| e.to_string())?;
        }
        _ => {
            db.update_turn_tool_activity_progress(
                &tool_use_id,
                workflow_progress_json.as_deref(),
                agent_status.as_deref(),
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Whether a chat session still owns a CLI process that could be running
/// workflows for it.
///
/// **`persistent_session` is the signal that matters, not `active_pid`.**
/// `active_pid` is cleared at the end of every turn while the persistent
/// process stays alive for the next one, so a backgrounded workflow spends
/// almost its entire life with `active_pid == None`. Reading only that would
/// declare a live run dead and blank its pill — the exact hazard the boot
/// sweep's process-lifetime gate exists to avoid. `persistent_session` is the
/// process itself, and is what the background-task wake already trusts to
/// decide whether a task can still report.
///
/// `active_pid` is still consulted, as a strictly-narrowing belt: it can only
/// ever add "alive", never remove it. Desktop chat always runs through a
/// persistent session today, so the two agree in practice — but if any path
/// ever spawns a turn without one, a workflow launched inside it is live and
/// must not be swept.
///
/// Generic over the session handle purely so this is testable. The real
/// `AgentSession` wraps a live child process and cannot be constructed in a
/// unit test, while the decision here is about *which fields are consulted* —
/// nothing inside the handle is read.
fn session_owns_live_process<S>(active_pid: Option<u32>, persistent_session: Option<&S>) -> bool {
    active_pid.is_some() || persistent_session.is_some()
}

/// Resolve `Workflow` activities this session left mid-run, when the session
/// has no CLI process that could still own them.
///
/// The boot sweep in `main()` only runs at process start, so a wedged pill
/// survives a webview reload — the user has to fully quit and relaunch. This
/// gives the frontend a way to re-run the sweep on session hydrate.
///
/// Liveness is [`session_owns_live_process`]; see there for why `active_pid`
/// alone is not the signal.
///
/// Returns the number of rows resolved, so the caller can skip a reload when
/// there was nothing to fix.
#[tauri::command]
pub async fn resolve_stale_workflow_activities(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    {
        let agents = state.agents.read().await;
        let session = agents.get(&session_id);
        if session_owns_live_process(
            session.and_then(|s| s.active_pid),
            session.and_then(|s| s.persistent_session.as_ref()),
        ) {
            // A live process can still be running workflows for this session.
            return Ok(0);
        }
    }
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let resolved = db
        .resolve_orphaned_workflow_activities_for_session(&session_id)
        .map_err(|e| e.to_string())?;
    if resolved > 0 {
        tracing::info!(
            target: "claudette::chat",
            session_id,
            resolved,
            "resolved stale workflow activities for a session with no live process"
        );
    }
    Ok(resolved)
}

#[tauri::command]
pub async fn load_completed_turns(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<CompletedTurnData>, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.list_completed_turns_for_session(&session_id)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::session_owns_live_process;

    /// Stand-in for `AgentSession`, which wraps a live child process.
    const HANDLE: &() = &();

    /// The case the whole gate exists for. A backgrounded workflow spends
    /// almost its entire life here: the launching turn ended (so `active_pid`
    /// was cleared) while the persistent process — and the run inside it —
    /// carries on. Sweeping this session would blank a live run's pill.
    #[test]
    fn a_persistent_session_between_turns_is_live() {
        assert!(session_owns_live_process(None, Some(HANDLE)));
    }

    /// Guards the regression Copilot flagged: narrowing this back to
    /// `active_pid` would pass every other test here while stopping genuinely
    /// live background workflows.
    #[test]
    fn active_pid_alone_is_not_what_makes_a_session_live() {
        // Reading only `active_pid` would answer `false` above and `true`
        // here. Both answers are wrong for the case that matters.
        assert!(session_owns_live_process(None, Some(HANDLE)));
        // ...and a turn running without a persistent session is still live,
        // so the check can only ever widen "alive", never narrow it.
        assert!(session_owns_live_process(Some(4242), None::<&()>));
    }

    #[test]
    fn a_session_with_neither_is_sweepable() {
        assert!(!session_owns_live_process(None, None::<&()>));
    }

    /// No entry in `AppState.agents` at all — the common case after a restart,
    /// and exactly the state a wedged row is left in. Modelled the way the
    /// call site derives its arguments, so a session the map has never heard
    /// of cannot accidentally read as live.
    #[test]
    fn an_unknown_session_is_sweepable() {
        struct Session {
            active_pid: Option<u32>,
            persistent_session: Option<()>,
        }
        let session: Option<&Session> = None;
        assert!(!session_owns_live_process(
            session.and_then(|s| s.active_pid),
            session.and_then(|s| s.persistent_session.as_ref()),
        ));
    }
}
