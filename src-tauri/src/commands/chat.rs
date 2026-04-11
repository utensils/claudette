use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use claudette::agent::{self, AgentEvent, AgentSettings, StreamEvent};
use claudette::db::Database;
use claudette::git;
use claudette::model::{
    ChatMessage, ChatRole, CompletedTurnData, ConversationCheckpoint, TurnToolActivity,
};

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

    // If a previous turn is still running, stop it before starting a new one.
    // This prevents overlapping processes for the same workspace.
    if let Some(old_pid) = session.active_pid.take() {
        eprintln!("[chat] Stopping stale process {old_pid} before new turn");
        drop(agents); // release lock while waiting
        let _ = agent::stop_agent(old_pid).await;
        // Brief wait for process cleanup.
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        agents = state.agents.write().await;
        // Re-borrow session after re-acquiring lock.
        let session = agents.get_mut(&workspace_id).ok_or("Session lost")?;
        session.active_pid = None;
    }
    let session = agents.get_mut(&workspace_id).ok_or("Session lost")?;

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

    // Capture rename context before the bridge spawn.
    let has_repo = repo.is_some();
    let rename_old_branch = ws.branch_name.clone();
    let rename_old_name = ws.name.clone();
    let rename_prompt = content.clone();

    // Bridge: read from mpsc receiver, emit Tauri events.
    let ws_id = workspace_id.clone();
    let db_path = state.db_path.clone();
    let wt_path = worktree_path.clone();
    let user_msg_id = user_msg.id.clone();
    tokio::spawn(async move {
        // On the first turn, spawn a background task to auto-rename the branch
        // using Haiku. This runs concurrently and does not block the event loop.
        if !is_resume && has_repo {
            let ws_id2 = ws_id.clone();
            let wt_path2 = wt_path.clone();
            let old_branch2 = rename_old_branch.clone();
            let old_name2 = rename_old_name.clone();
            let prompt2 = rename_prompt.clone();
            let db_path2 = db_path.clone();
            let app2 = app.clone();
            tokio::spawn(async move {
                try_auto_rename(
                    &ws_id2,
                    &wt_path2,
                    &old_name2,
                    &old_branch2,
                    &prompt2,
                    &db_path2,
                    &app2,
                )
                .await;
            });
        }

        let mut rx = turn_handle.event_rx;
        let mut got_init = false;
        // Track the last assistant message inserted in THIS turn. Falls back
        // to the user message ID for tool-only turns (AskUserQuestion, plan
        // approval) so that checkpoint creation isn't skipped entirely.
        let mut last_assistant_msg_id: Option<String> = None;
        while let Some(event) = rx.recv().await {
            // Track whether the CLI initialized successfully.
            if let AgentEvent::Stream(StreamEvent::System { subtype, .. }) = &event
                && subtype == "init"
            {
                got_init = true;
            }

            if let AgentEvent::ProcessExited(_code) = &event {
                let app_state = app.state::<AppState>();
                let mut agents = app_state.agents.write().await;
                if !got_init {
                    // Failed to initialize — clear the entire session so the
                    // next attempt starts fresh instead of trying --resume.
                    agents.remove(&ws_id);
                    if let Ok(db) = Database::open(&db_path) {
                        let _ = db.clear_agent_session(&ws_id);
                    }
                } else if let Some(session) = agents.get_mut(&ws_id) {
                    // Normal exit — clear active_pid so rollback isn't blocked.
                    session.active_pid = None;
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

                // Create a checkpoint anchored to the assistant message from
                // this turn, or the user message for tool-only turns.
                let anchor_msg_id = last_assistant_msg_id.as_deref().unwrap_or(&user_msg_id);

                let turn_index = db
                    .latest_checkpoint(&ws_id)
                    .ok()
                    .flatten()
                    .map(|cp| cp.turn_index + 1)
                    .unwrap_or(0);

                let commit_hash =
                    match git::create_checkpoint_commit(&wt_path, &format!("Turn {turn_index}"))
                        .await
                    {
                        Ok(hash) => Some(hash),
                        Err(e) => {
                            eprintln!(
                                "[chat] Checkpoint commit failed for {ws_id}: {e} \
                             — checkpoint will be recorded without file restore capability"
                            );
                            None
                        }
                    };

                let checkpoint = ConversationCheckpoint {
                    id: uuid::Uuid::new_v4().to_string(),
                    workspace_id: ws_id.clone(),
                    message_id: anchor_msg_id.to_string(),
                    commit_hash,
                    turn_index,
                    message_count: 0, // Updated by frontend after finalizeTurn
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

/// Clear the entire conversation for a workspace, optionally restoring files
/// to the merge-base (initial state before any agent work).
#[tauri::command]
pub async fn clear_conversation(
    workspace_id: String,
    restore_files: bool,
    state: State<'_, AppState>,
) -> Result<Vec<ChatMessage>, String> {
    // Guard: reject if agent is running.
    {
        let agents = state.agents.read().await;
        if let Some(session) = agents.get(&workspace_id)
            && session.active_pid.is_some()
        {
            return Err("Cannot clear conversation while the agent is running".into());
        }
    }

    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;

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
        let base = git::default_branch(&repo.path)
            .await
            .map_err(|e| e.to_string())?;
        let merge_base = claudette::diff::merge_base(wt, &ws.branch_name, &base)
            .await
            .map_err(|e| e.to_string())?;
        git::restore_to_commit(wt, &merge_base)
            .await
            .map_err(|e| e.to_string())?;
    }

    // Delete all messages and checkpoints.
    db.delete_chat_messages_for_workspace(&workspace_id)
        .map_err(|e| e.to_string())?;
    // Checkpoints cascade via FK, but delete explicitly for clarity.
    db.delete_checkpoints_after(&workspace_id, -1)
        .map_err(|e| e.to_string())?;

    // Reset agent session.
    {
        let mut agents = state.agents.write().await;
        agents.remove(&workspace_id);
    }
    db.clear_agent_session(&workspace_id)
        .map_err(|e| e.to_string())?;

    // Return empty list.
    db.list_chat_messages(&workspace_id)
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

#[tauri::command]
pub async fn load_completed_turns(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<CompletedTurnData>, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.list_completed_turns(&workspace_id)
        .map_err(|e| e.to_string())
}

/// Background task: generate a descriptive branch name via Haiku and rename
/// the workspace's branch + DB record. All failures are non-fatal.
async fn try_auto_rename(
    ws_id: &str,
    worktree_path: &str,
    old_name: &str,
    old_branch: &str,
    prompt: &str,
    db_path: &std::path::Path,
    app: &AppHandle,
) {
    // Ask Haiku for a branch name slug.
    let slug = match agent::generate_branch_name(prompt, worktree_path).await {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[rename] Haiku branch name generation failed: {e}");
            return;
        }
    };

    // Try the slug, then slug-2, slug-3 on name collision.
    let candidates = [slug.clone(), format!("{slug}-2"), format!("{slug}-3")];
    for candidate in &candidates {
        let new_branch = format!("claudette/{candidate}");

        let db = match Database::open(db_path) {
            Ok(db) => db,
            Err(e) => {
                eprintln!("[rename] Failed to open DB: {e}");
                return;
            }
        };

        match db.rename_workspace(ws_id, candidate, &new_branch) {
            Ok(()) => {
                // DB updated — now rename the git branch.
                if let Err(e) = git::rename_branch(worktree_path, old_branch, &new_branch).await {
                    let msg = e.to_string();
                    eprintln!("[rename] Git branch rename failed: {e} — rolling back DB");
                    let _ = db.rename_workspace(ws_id, old_name, old_branch);

                    // If the target branch already exists, fall back to the next
                    // candidate just like we do for DB unique constraint collisions.
                    if msg.contains("already exists") {
                        eprintln!("[rename] Branch {new_branch:?} collides, trying next");
                        continue;
                    }
                    return;
                }

                // Success — notify the frontend.
                let payload = serde_json::json!({
                    "workspace_id": ws_id,
                    "name": candidate,
                    "branch_name": new_branch,
                });
                let _ = app.emit("workspace-renamed", &payload);
                eprintln!("[rename] Workspace {ws_id} renamed to {candidate} ({new_branch})");
                return;
            }
            Err(e) => {
                // Check if this is a unique constraint violation by inspecting
                // the error message (rusqlite is not a direct dependency here).
                let msg = e.to_string();
                if msg.contains("UNIQUE constraint failed") {
                    eprintln!("[rename] Name {candidate:?} collides, trying next");
                    continue;
                }
                eprintln!("[rename] DB rename failed: {e}");
                return;
            }
        }
    }

    eprintln!("[rename] All name candidates exhausted for workspace {ws_id}");
}

fn now_iso() -> String {
    let dur = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}", dur.as_secs())
}
