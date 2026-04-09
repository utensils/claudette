use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use claudette::agent::{self, AgentEvent, AgentSettings, StreamEvent};
use claudette::db::Database;
use claudette::git;
use claudette::model::{ChatMessage, ChatRole, ConversationCheckpoint};

use crate::state::{AgentSessionState, AppState};

#[derive(Clone, Serialize)]
struct AgentStreamPayload {
    workspace_id: String,
    event: AgentEvent,
}

use claudette::permissions::tools_for_level;

#[tauri::command]
pub async fn load_chat_history(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<ChatMessage>, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.list_chat_messages(&workspace_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn send_chat_message(
    workspace_id: String,
    content: String,
    permission_level: Option<String>,
    model: Option<String>,
    fast_mode: Option<bool>,
    thinking_enabled: Option<bool>,
    plan_mode: Option<bool>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;

    // Look up workspace for worktree path.
    let workspaces = db.list_workspaces().map_err(|e| e.to_string())?;
    let ws = workspaces
        .iter()
        .find(|w| w.id == workspace_id)
        .ok_or("Workspace not found")?;
    let worktree_path = ws
        .worktree_path
        .as_ref()
        .ok_or("Workspace has no worktree")?
        .clone();

    // Save user message to DB.
    let user_msg = ChatMessage {
        id: uuid::Uuid::new_v4().to_string(),
        workspace_id: workspace_id.clone(),
        role: ChatRole::User,
        content: content.clone(),
        cost_usd: None,
        duration_ms: None,
        created_at: now_iso(),
    };
    db.insert_chat_message(&user_msg)
        .map_err(|e| e.to_string())?;

    // Resolve allowed tools from permission level.
    let level = permission_level.as_deref().unwrap_or("full");
    if !matches!(level, "readonly" | "standard" | "full") {
        eprintln!("[chat] Unknown permission level {level:?}, falling back to readonly");
    }
    let allowed_tools = tools_for_level(level);

    // Resolve custom instructions: .claudette.json > repo settings > none.
    // Only resolved on the first turn — cached in the session for subsequent turns.
    let repo = db
        .get_repository(&ws.repository_id)
        .map_err(|e| e.to_string())?;

    // Get or create agent session. Custom instructions are resolved once on
    // the first turn and cached for the session lifetime.
    //
    // Session state is persisted to SQLite so that `--resume` survives app
    // restarts. The in-memory HashMap acts as a hot cache; on a cache miss we
    // restore from the database before falling back to creating a new session.
    // Resolve custom instructions once — used for both restored and new sessions.
    let instructions = {
        let from_config = repo.as_ref().and_then(|r| {
            let path = r.path.clone();
            claudette::config::load_config(std::path::Path::new(&path))
                .ok()
                .flatten()
                .and_then(|c| c.instructions)
        });
        from_config.or_else(|| repo.as_ref().and_then(|r| r.custom_instructions.clone()))
    };

    let mut agents = state.agents.write().await;
    let session = agents.entry(workspace_id.clone()).or_insert_with(|| {
        // Try restoring a persisted session from the database first.
        if let Ok(Some((sid, tc))) = db.get_agent_session(&workspace_id) {
            return AgentSessionState {
                session_id: sid,
                turn_count: tc,
                active_pid: None,
                custom_instructions: instructions.clone(),
            };
        }

        AgentSessionState {
            session_id: uuid::Uuid::new_v4().to_string(),
            turn_count: 0,
            active_pid: None,
            custom_instructions: instructions,
        }
    });

    let is_resume = session.turn_count > 0;
    let session_id = session.session_id.clone();
    let custom_instructions = session.custom_instructions.clone();
    session.turn_count += 1;

    // Build agent settings from frontend params.
    let agent_settings = AgentSettings {
        model: if !is_resume { model } else { None },
        fast_mode: fast_mode.unwrap_or(false),
        thinking_enabled: thinking_enabled.unwrap_or(false),
        plan_mode: plan_mode.unwrap_or(false),
    };

    // Spawn the agent turn.
    let turn_handle = agent::run_turn(
        std::path::Path::new(&worktree_path),
        &session_id,
        &content,
        is_resume,
        &allowed_tools,
        custom_instructions.as_deref(),
        &agent_settings,
    )
    .await?;

    // Persist session state only after the subprocess spawned successfully.
    // If run_turn fails (missing binary, spawn error), we avoid persisting a
    // turn_count > 0 for a session Claude never initialized.
    let _ = db.save_agent_session(&workspace_id, &session_id, session.turn_count);

    session.active_pid = Some(turn_handle.pid);
    drop(agents);

    // Bridge: read from mpsc receiver, emit Tauri events.
    let ws_id = workspace_id.clone();
    let db_path = state.db_path.clone();
    let wt_path = worktree_path.clone();
    tokio::spawn(async move {
        let mut rx = turn_handle.event_rx;
        let mut got_init = false;
        // Track the last assistant message inserted in THIS turn so that the
        // checkpoint anchors to the correct message (avoids P1: tool-only turns
        // like AskUserQuestion would otherwise pick up a stale assistant row).
        let mut last_assistant_msg_id: Option<String> = None;
        while let Some(event) = rx.recv().await {
            // Track whether the CLI initialized successfully.
            if let AgentEvent::Stream(StreamEvent::System { subtype, .. }) = &event
                && subtype == "init"
            {
                got_init = true;
            }

            // If the process exits without ever initializing, reset the session
            // so the next attempt starts fresh instead of trying --resume.
            // A non-zero exit AFTER successful init is normal (e.g. user stop,
            // transient error) — the session is still valid for resumption.
            if let AgentEvent::ProcessExited(_code) = &event
                && !got_init
            {
                let app_state = app.state::<AppState>();
                let mut agents = app_state.agents.write().await;
                agents.remove(&ws_id);
                // Also clear persisted session so restart doesn't try --resume.
                if let Ok(db) = Database::open(&db_path) {
                    let _ = db.clear_agent_session(&ws_id);
                }
            }
            // Persist assistant messages to DB on completion.
            if let AgentEvent::Stream(StreamEvent::Assistant { ref message }) = event {
                let full_text: String = message
                    .content
                    .iter()
                    .filter_map(|block| {
                        if let claudette::agent::ContentBlock::Text { text } = block {
                            Some(text.as_str())
                        } else {
                            None
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("");

                if !full_text.trim().is_empty()
                    && let Ok(db) = Database::open(&db_path)
                {
                    let msg_id = uuid::Uuid::new_v4().to_string();
                    let msg = ChatMessage {
                        id: msg_id.clone(),
                        workspace_id: ws_id.clone(),
                        role: ChatRole::Assistant,
                        content: full_text,
                        cost_usd: None,
                        duration_ms: None,
                        created_at: now_iso(),
                    };
                    if db.insert_chat_message(&msg).is_ok() {
                        last_assistant_msg_id = Some(msg_id);
                    }
                }
            }

            // Update cost/duration on result events, then create a checkpoint.
            if let AgentEvent::Stream(StreamEvent::Result {
                total_cost_usd,
                duration_ms,
                ..
            }) = &event
                && let Ok(db) = Database::open(&db_path)
            {
                // Update cost on the assistant message from this turn (if any).
                if let (Some(cost), Some(dur)) = (total_cost_usd, duration_ms)
                    && let Some(ref msg_id) = last_assistant_msg_id
                {
                    let _ = db.update_chat_message_cost(msg_id, *cost, *dur);
                }

                // Only create a checkpoint if this turn produced an assistant
                // message. Tool-only turns (AskUserQuestion, plan approval)
                // should not create checkpoints to avoid anchoring to a stale
                // message from a previous turn.
                if let Some(ref msg_id) = last_assistant_msg_id {
                    let turn_index = db
                        .latest_checkpoint(&ws_id)
                        .ok()
                        .flatten()
                        .map(|cp| cp.turn_index + 1)
                        .unwrap_or(0);

                    let commit_hash =
                        git::create_checkpoint_commit(&wt_path, &format!("Turn {turn_index}"))
                            .await
                            .ok();

                    let checkpoint = ConversationCheckpoint {
                        id: uuid::Uuid::new_v4().to_string(),
                        workspace_id: ws_id.clone(),
                        message_id: msg_id.clone(),
                        commit_hash,
                        turn_index,
                        created_at: now_iso(),
                    };
                    if db.insert_checkpoint(&checkpoint).is_ok() {
                        let payload = serde_json::json!({
                            "workspace_id": &ws_id,
                            "checkpoint": &checkpoint,
                        });
                        let _ = app.emit("checkpoint-created", &payload);
                    }
                }
            }

            let payload = AgentStreamPayload {
                workspace_id: ws_id.clone(),
                event,
            };
            let _ = app.emit("agent-stream", &payload);
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn stop_agent(workspace_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut agents = state.agents.write().await;
    if let Some(session) = agents.get_mut(&workspace_id)
        && let Some(pid) = session.active_pid.take()
    {
        agent::stop_agent(pid).await?;
    }

    // Log stop message.
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let msg = ChatMessage {
        id: uuid::Uuid::new_v4().to_string(),
        workspace_id,
        role: ChatRole::System,
        content: "Agent stopped".to_string(),
        cost_usd: None,
        duration_ms: None,
        created_at: now_iso(),
    };
    db.insert_chat_message(&msg).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn reset_agent_session(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut agents = state.agents.write().await;
    agents.remove(&workspace_id);

    // Clear persisted session so the next turn starts fresh.
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.clear_agent_session(&workspace_id)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn list_checkpoints(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<ConversationCheckpoint>, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.list_checkpoints(&workspace_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn rollback_to_checkpoint(
    workspace_id: String,
    checkpoint_id: String,
    restore_files: bool,
    state: State<'_, AppState>,
) -> Result<Vec<ChatMessage>, String> {
    // Guard: reject if agent is running.
    {
        let agents = state.agents.read().await;
        if let Some(session) = agents.get(&workspace_id)
            && session.active_pid.is_some()
        {
            return Err("Cannot rollback while the agent is running".into());
        }
    }

    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;

    // Load the target checkpoint and verify ownership.
    let checkpoint = db
        .get_checkpoint(&checkpoint_id)
        .map_err(|e| e.to_string())?
        .ok_or("Checkpoint not found")?;
    if checkpoint.workspace_id != workspace_id {
        return Err("Checkpoint does not belong to this workspace".into());
    }

    // Attempt file restore BEFORE any destructive DB writes so that a git
    // failure does not leave the DB truncated while the frontend still shows
    // the full conversation.
    if restore_files && let Some(ref commit_hash) = checkpoint.commit_hash {
        let workspaces = db.list_workspaces().map_err(|e| e.to_string())?;
        let ws = workspaces
            .iter()
            .find(|w| w.id == workspace_id)
            .ok_or("Workspace not found")?;
        let wt = ws
            .worktree_path
            .as_ref()
            .ok_or("Workspace has no worktree")?;
        git::restore_to_commit(wt, commit_hash)
            .await
            .map_err(|e| e.to_string())?;
    }

    // Now perform the destructive DB writes — safe because the risky git
    // operation (if requested) has already succeeded above.
    db.delete_messages_after(&workspace_id, &checkpoint.message_id)
        .map_err(|e| e.to_string())?;
    db.delete_checkpoints_after(&workspace_id, checkpoint.turn_index)
        .map_err(|e| e.to_string())?;

    // Reset agent session so the next turn starts fresh.
    {
        let mut agents = state.agents.write().await;
        agents.remove(&workspace_id);
    }
    db.clear_agent_session(&workspace_id)
        .map_err(|e| e.to_string())?;

    // Return the truncated message list.
    db.list_chat_messages(&workspace_id)
        .map_err(|e| e.to_string())
}

fn now_iso() -> String {
    let dur = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}", dur.as_secs())
}
