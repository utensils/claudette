use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use claudette::agent::{
    self, AgentEvent, AgentSettings, ControlRequestInner, ImageAttachment, InnerStreamEvent,
    PersistentSession, StartContentBlock, StreamEvent,
};
use claudette::db::Database;
use claudette::env::WorkspaceEnv;
use claudette::git;
use claudette::mcp_supervisor::McpSupervisor;
use claudette::model::{
    Attachment, ChatMessage, ChatRole, CompletedTurnData, ConversationCheckpoint, TurnToolActivity,
};
use claudette::snapshot;
use claudette::{base64_decode, base64_encode};

use crate::state::{AgentSessionState, AppState, PendingPermission};

/// Frontend-facing input for an image attachment (base64-encoded).
#[derive(Clone, Deserialize)]
pub struct AttachmentInput {
    pub filename: String,
    pub media_type: String,
    pub data_base64: String,
}

/// Frontend-facing response for a stored attachment (base64-encoded data).
#[derive(Clone, Serialize)]
pub struct AttachmentResponse {
    pub id: String,
    pub message_id: String,
    pub filename: String,
    pub media_type: String,
    pub data_base64: String,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub size_bytes: i64,
}

#[derive(Clone, Serialize)]
struct AgentStreamPayload {
    workspace_id: String,
    event: AgentEvent,
}

use claudette::permissions::tools_for_level;

/// Detect whether the persistent session's spawn-time flags have drifted
/// from what the current turn is asking for. Both `--permission-mode` and
/// `--allowedTools` are only applied when the `claude` process starts, so
/// a drift means the running process cannot serve this turn correctly and
/// must be torn down.
fn persistent_session_flags_drifted(
    session_plan_mode: bool,
    session_allowed_tools: &[String],
    requested_plan_mode: bool,
    requested_allowed_tools: &[String],
) -> bool {
    session_plan_mode != requested_plan_mode || session_allowed_tools != requested_allowed_tools
}

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
    message_id: Option<String>,
    content: String,
    mentioned_files: Option<Vec<String>>,
    permission_level: Option<String>,
    model: Option<String>,
    fast_mode: Option<bool>,
    thinking_enabled: Option<bool>,
    plan_mode: Option<bool>,
    effort: Option<String>,
    chrome_enabled: Option<bool>,
    attachments: Option<Vec<AttachmentInput>>,
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

    // Save user message to DB. Use the frontend-provided ID so optimistic
    // UI state (attachments keyed by message ID) stays consistent.
    let user_msg = ChatMessage {
        id: message_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        workspace_id: workspace_id.clone(),
        role: ChatRole::User,
        content: content.clone(),
        cost_usd: None,
        duration_ms: None,
        created_at: now_iso(),
        thinking: None,
    };
    // Decode, validate, and persist attachments alongside the user message.
    // Both inserts share a transaction so the message and its attachments are
    // atomic — a failed attachment decode won't leave an orphaned message.
    const ALLOWED_MIME: &[&str] = &[
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "application/pdf",
    ];
    const MAX_IMAGE_BYTES: usize = 3_932_160; // 3.75 MB
    const MAX_PDF_BYTES: usize = 20_971_520; // 20 MB

    let mut att_models: Vec<Attachment> = Vec::new();
    let mut cli_atts: Vec<ImageAttachment> = Vec::new();

    if let Some(ref inputs) = attachments {
        for input in inputs {
            if !ALLOWED_MIME.contains(&input.media_type.as_str()) {
                return Err(format!("Unsupported attachment type: {}", input.media_type));
            }
            let data = base64_decode(&input.data_base64).map_err(|e| format!("Bad base64: {e}"))?;
            let max = if input.media_type == "application/pdf" {
                MAX_PDF_BYTES
            } else {
                MAX_IMAGE_BYTES
            };
            if data.len() > max {
                return Err(format!(
                    "Attachment too large: {} bytes (max {})",
                    data.len(),
                    max
                ));
            }
            if input.media_type == "application/pdf" && !data.starts_with(b"%PDF-") {
                return Err("Invalid PDF: missing %PDF- header".to_string());
            }
            let size_bytes = data.len() as i64;
            att_models.push(Attachment {
                id: uuid::Uuid::new_v4().to_string(),
                message_id: user_msg.id.clone(),
                filename: input.filename.clone(),
                media_type: input.media_type.clone(),
                width: None,
                height: None,
                size_bytes,
                data,
                created_at: now_iso(),
            });
            cli_atts.push(ImageAttachment {
                media_type: input.media_type.clone(),
                data_base64: input.data_base64.clone(),
            });
        }
    }

    // Atomic insert: message + attachments in one transaction.
    db.insert_chat_message(&user_msg)
        .map_err(|e| e.to_string())?;
    if !att_models.is_empty() {
        db.insert_attachments_batch(&att_models)
            .map_err(|e| e.to_string())?;
    }
    let image_attachments = cli_atts;

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

    // Load repository MCP configs for injection on every turn.
    // Each Claude CLI process is independent and needs the MCP config passed.
    // This is done BEFORE acquiring the agents lock to avoid blocking other workspaces.
    let db_rows = db
        .list_repository_mcp_servers(&ws.repository_id)
        .map_err(|e| {
            eprintln!(
                "[chat] Failed to load MCP servers for {}: {e}",
                ws.repository_id
            );
            e.to_string()
        })?;
    let mcp_config = claudette::mcp::cli_config_from_rows(&db_rows);

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
                needs_attention: false,
                attention_kind: None,
                persistent_session: None,
                mcp_config_dirty: false,
                session_plan_mode: false,
                session_allowed_tools: Vec::new(),
                pending_permissions: std::collections::HashMap::new(),
            };
        }

        AgentSessionState {
            session_id: uuid::Uuid::new_v4().to_string(),
            turn_count: 0,
            active_pid: None,
            custom_instructions: instructions,
            needs_attention: false,
            attention_kind: None,
            persistent_session: None,
            mcp_config_dirty: false,
            session_plan_mode: false,
            session_allowed_tools: Vec::new(),
            pending_permissions: std::collections::HashMap::new(),
        }
    });

    // Clear any unresolved permission requests so the CLI doesn't hang when
    // we send the next turn. This replaces the old behaviour where the
    // AgentQuestionCard dismissed on a new user message — the CLI is actually
    // blocked mid-turn and needs an explicit control_response. The drain is
    // synchronous (under the lock); the deny sends happen after we drop it.
    let to_deny_new_turn = drain_pending_permissions(session);

    // If a previous turn is still running and there's no persistent session,
    // stop the stale process. With a persistent session, the process is shared
    // and the CLI serializes turns internally.
    if session.persistent_session.is_none()
        && let Some(old_pid) = session.active_pid.take()
    {
        eprintln!("[chat] Stopping stale process {old_pid} before new turn");
        drop(agents); // release lock while waiting
        if let Some((ref ps, drained)) = to_deny_new_turn {
            deny_drained_permissions(drained, ps, "User sent a new message instead of answering.")
                .await;
        }
        let _ = agent::stop_agent(old_pid).await;
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        agents = state.agents.write().await;
        let session = agents.get_mut(&workspace_id).ok_or("Session lost")?;
        session.active_pid = None;
    } else if let Some((ref ps, drained)) = to_deny_new_turn {
        // No stale-pid teardown — release the lock just for the deny sends,
        // then re-acquire so the rest of this function can mutate the session.
        drop(agents);
        deny_drained_permissions(drained, ps, "User sent a new message instead of answering.")
            .await;
        agents = state.agents.write().await;
    }
    let session = agents.get_mut(&workspace_id).ok_or("Session lost")?;

    // MCP config changed while a previous turn was in flight — tear down the
    // persistent session so the next spawn picks up updated --mcp-config.
    // The session is idle between turns so a graceful SIGTERM is sufficient.
    if session.mcp_config_dirty {
        eprintln!("[chat] MCP config dirty — tearing down persistent session for {workspace_id}");
        let to_deny_mcp = drain_pending_permissions(session);
        let stale_pid = session.persistent_session.as_ref().map(|ps| ps.pid());
        session.persistent_session = None;
        // Clear active_pid alongside persistent_session so a failed respawn
        // can't leave the next turn with a stale PID that the kernel may
        // have recycled (would get SIGKILLed by the stale-process branch).
        session.active_pid = None;
        session.mcp_config_dirty = false;
        if stale_pid.is_some() || to_deny_mcp.is_some() {
            drop(agents);
            if let Some((ref ps, drained)) = to_deny_mcp {
                deny_drained_permissions(drained, ps, "Session restarted with new MCP config.")
                    .await;
            }
            if let Some(pid) = stale_pid {
                let _ = agent::stop_agent_graceful(pid).await;
            }
            agents = state.agents.write().await;
        }
    }
    let session = agents.get_mut(&workspace_id).ok_or("Session lost")?;

    let custom_instructions = session.custom_instructions.clone();
    session.turn_count += 1;
    session.needs_attention = false;
    session.attention_kind = None;

    // Build agent settings from frontend params.
    let agent_settings = AgentSettings {
        model,
        fast_mode: fast_mode.unwrap_or(false),
        thinking_enabled: thinking_enabled.unwrap_or(false),
        plan_mode: plan_mode.unwrap_or(false),
        effort,
        chrome_enabled: chrome_enabled.unwrap_or(false),
        mcp_config,
    };

    // `--permission-mode` and `--allowedTools` are baked into the persistent
    // `claude` process at spawn — subsequent stdin turns cannot change them.
    // If the caller's requested values no longer match what the current
    // process was spawned with, tear it down so the next spawn can apply the
    // new flags. The common case this fixes: user finishes plan mode, clicks
    // "Approve plan", and the next turn arrives with `plan_mode=false`.
    // Without a teardown the process stays in plan mode and every mutating
    // tool is silently auto-denied.
    if session.persistent_session.is_some()
        && persistent_session_flags_drifted(
            session.session_plan_mode,
            &session.session_allowed_tools,
            agent_settings.plan_mode,
            &allowed_tools,
        )
    {
        eprintln!(
            "[chat] session flags drifted (plan_mode {} -> {}, allowed_tools changed: {}) — tearing down persistent session for {workspace_id}",
            session.session_plan_mode,
            agent_settings.plan_mode,
            session.session_allowed_tools != allowed_tools,
        );
        // Resolve any pending permission requests against the doomed process
        // before we kill it, so the next turn doesn't carry stale tool_use_ids.
        let to_deny_drift = drain_pending_permissions(session);
        let stale_pid = session.persistent_session.as_ref().map(|ps| ps.pid());
        session.persistent_session = None;
        // Clear active_pid alongside persistent_session. A concurrent turn
        // streaming this process at drift time would leave active_pid set;
        // without this clear, a failed respawn + next turn would SIGKILL a
        // potentially recycled PID via the stale-process teardown branch.
        session.active_pid = None;
        if stale_pid.is_some() || to_deny_drift.is_some() {
            drop(agents);
            if let Some((ref ps, drained)) = to_deny_drift {
                deny_drained_permissions(drained, ps, "Session restarted with new flags.").await;
            }
            if let Some(pid) = stale_pid {
                let _ = agent::stop_agent_graceful(pid).await;
            }
            agents = state.agents.write().await;
        }
    }
    let session = agents.get_mut(&workspace_id).ok_or("Session lost")?;

    // Expand @-file mentions into inline file content for the agent prompt.
    let prompt = claudette::file_expand::expand_file_mentions(
        std::path::Path::new(&worktree_path),
        &content,
        mentioned_files.as_deref().unwrap_or(&[]),
    )
    .await;

    // Build workspace env vars for the agent subprocess.
    let repo_path = repo.as_ref().map(|r| r.path.as_str()).unwrap_or("");
    let default_branch = git::default_branch(repo_path)
        .await
        .unwrap_or_else(|_| "main".to_string());
    let ws_env = WorkspaceEnv::from_workspace(ws, repo_path, default_branch);

    // Use persistent session to keep MCP servers alive across turns.
    // First turn or after restart: start a PersistentSession.
    // Subsequent turns in same session: reuse the existing process via stdin.
    let existing_persistent = session.persistent_session.clone();
    let saved_session_id = session.session_id.clone();
    let saved_turn_count = session.turn_count;

    // Helper: start a persistent session, using --resume for restored sessions.
    let ws_env_for_persistent = ws_env.clone();
    let start_persistent = |worktree: String,
                            sid: String,
                            is_resume: bool,
                            tools: Vec<String>,
                            instructions: Option<String>,
                            settings: AgentSettings| {
        let env = ws_env_for_persistent.clone();
        async move {
            let ps = Arc::new(
                PersistentSession::start(
                    std::path::Path::new(&worktree),
                    &sid,
                    is_resume,
                    &tools,
                    instructions.as_deref(),
                    &settings,
                    Some(&env),
                )
                .await?,
            );
            Ok::<Arc<PersistentSession>, String>(ps)
        }
    };

    let turn_handle = if let Some(ref ps) = existing_persistent {
        // Reuse existing persistent process — send turn via stdin.
        match ps.send_turn(&prompt, &image_attachments).await {
            Ok(handle) => handle,
            Err(e) => {
                // Persistent session died — drop lock before async spawn to
                // avoid blocking other workspaces during process startup.
                eprintln!("[chat] Persistent session failed, respawning: {e}");
                session.persistent_session = None;
                drop(agents);

                let is_resume = saved_turn_count > 1;
                let (ps, final_sid) = match start_persistent(
                    worktree_path.clone(),
                    saved_session_id.clone(),
                    is_resume,
                    allowed_tools.clone(),
                    custom_instructions.clone(),
                    agent_settings.clone(),
                )
                .await
                {
                    Ok(ps) => (ps, saved_session_id.clone()),
                    Err(e2) if is_resume => {
                        eprintln!("[chat] --resume respawn failed ({e2}), starting fresh");
                        let fresh = uuid::Uuid::new_v4().to_string();
                        let ps = start_persistent(
                            worktree_path.clone(),
                            fresh.clone(),
                            false,
                            allowed_tools.clone(),
                            custom_instructions.clone(),
                            agent_settings.clone(),
                        )
                        .await?;
                        (ps, fresh)
                    }
                    Err(e2) => {
                        let _ = db.clear_agent_session(&workspace_id);
                        return Err(e2);
                    }
                };
                let handle = ps.send_turn(&prompt, &image_attachments).await?;

                agents = state.agents.write().await;
                let session = agents.get_mut(&workspace_id).ok_or("Session lost")?;
                session.persistent_session = Some(ps);
                session.session_id = final_sid;
                session.session_plan_mode = agent_settings.plan_mode;
                session.session_allowed_tools = allowed_tools.clone();
                handle
            }
        }
    } else {
        // No persistent session — start one. Use --resume if we have a saved
        // session from the DB (app restart), fresh ID if brand new.
        let is_resume = saved_turn_count > 1;
        let sid = if is_resume {
            saved_session_id.clone()
        } else {
            let fresh = uuid::Uuid::new_v4().to_string();
            session.session_id = fresh.clone();
            fresh
        };
        // Drop lock before async process spawn.
        drop(agents);

        let (ps, final_sid) = match start_persistent(
            worktree_path.clone(),
            sid.clone(),
            is_resume,
            allowed_tools.clone(),
            custom_instructions.clone(),
            agent_settings.clone(),
        )
        .await
        {
            Ok(ps) => (ps, sid),
            Err(e) if is_resume => {
                // Resume failed (stale/corrupt session) — start fresh instead.
                eprintln!("[chat] --resume failed ({e}), starting fresh session");
                let fresh_sid = uuid::Uuid::new_v4().to_string();
                let ps = start_persistent(
                    worktree_path.clone(),
                    fresh_sid.clone(),
                    false,
                    allowed_tools.clone(),
                    custom_instructions.clone(),
                    agent_settings.clone(),
                )
                .await?;
                (ps, fresh_sid)
            }
            Err(e) => {
                // Spawn failed entirely — clear stale session from DB so the
                // next attempt doesn't try --resume with a dead session ID.
                let _ = db.clear_agent_session(&workspace_id);
                agents = state.agents.write().await;
                if let Some(session) = agents.get_mut(&workspace_id) {
                    session.turn_count = 0;
                    session.session_id = String::new();
                }
                drop(agents);
                return Err(e);
            }
        };
        let handle = ps.send_turn(&prompt, &image_attachments).await?;

        agents = state.agents.write().await;
        let session = agents.get_mut(&workspace_id).ok_or("Session lost")?;
        session.persistent_session = Some(ps);
        session.session_id = final_sid.clone();
        session.session_plan_mode = agent_settings.plan_mode;
        session.session_allowed_tools = allowed_tools.clone();
        let _ = db.save_agent_session(&workspace_id, &final_sid, session.turn_count);
        handle
    };

    let spawned_pid = turn_handle.pid;
    {
        let session = agents.get_mut(&workspace_id).ok_or("Session lost")?;
        session.active_pid = Some(spawned_pid);
        let _ = db.save_agent_session(&workspace_id, &session.session_id, session.turn_count);
    }
    drop(agents);

    // Capture rename context before the bridge spawn.
    let has_repo = repo.is_some();
    let rename_old_branch = ws.branch_name.clone();
    let rename_old_name = ws.name.clone();
    let rename_prompt = content.clone();
    let rename_prefs = repo
        .as_ref()
        .and_then(|r| r.branch_rename_preferences.clone());
    let rename_ws_env = ws_env.clone();

    crate::tray::rebuild_tray(&app);

    // Bridge: read from mpsc receiver, emit Tauri events.
    let ws_id = workspace_id.clone();
    let db_path = state.db_path.clone();
    let wt_path = worktree_path.clone();
    let user_msg_id = user_msg.id.clone();
    let repo_id_for_mcp = ws.repository_id.clone();
    drop(ws_env); // consumed by rename_ws_env; notification path rebuilds from DB
    tokio::spawn(async move {
        // On the first turn, spawn a background task to auto-rename the branch
        // using Haiku. Gate on turn count (not persistent_session) because
        // persistent_session is in-memory only and is None after app restart
        // even for resumed sessions.
        if saved_turn_count <= 1 && has_repo {
            let ws_id2 = ws_id.clone();
            let wt_path2 = wt_path.clone();
            let old_branch2 = rename_old_branch.clone();
            let old_name2 = rename_old_name.clone();
            let prompt2 = rename_prompt.clone();
            let db_path2 = db_path.clone();
            let app2 = app.clone();
            let prefs2 = rename_prefs.clone();
            let ws_env2 = rename_ws_env.clone();
            tokio::spawn(async move {
                try_auto_rename(
                    &ws_id2,
                    &wt_path2,
                    &old_name2,
                    &old_branch2,
                    &prompt2,
                    prefs2.as_deref(),
                    &db_path2,
                    &app2,
                    &ws_env2,
                )
                .await;
            });
        }

        let mut rx = turn_handle.event_rx;
        let mut got_init = false;
        // MCP monitoring: map tool_use_id → tool_name for MCP error detection.
        let mut mcp_tool_names: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        // Track the last assistant message inserted in THIS turn. Falls back
        // to the user message ID for tool-only turns (AskUserQuestion, plan
        // approval) so that checkpoint creation isn't skipped entirely.
        let mut last_assistant_msg_id: Option<String> = None;
        // Accumulate thinking from thinking-only assistant events so it can
        // be attached to the next text-bearing assistant message. The CLI
        // may fire a thinking-only event followed by a text-only event.
        let mut pending_thinking: Option<String> = None;
        let mut pending_attention_notify: bool;
        while let Some(event) = rx.recv().await {
            pending_attention_notify = false;
            // Track whether the CLI initialized successfully.
            if let AgentEvent::Stream(StreamEvent::System { subtype, .. }) = &event
                && subtype == "init"
            {
                got_init = true;
            }

            // Handle control_request: can_use_tool from the CLI's stdio permission
            // prompt protocol. For AskUserQuestion / ExitPlanMode we remember the
            // request and surface it to the UI (the existing content_block_start
            // handler populated the AgentQuestion / PlanApproval card); the UI
            // then calls submit_agent_answer / submit_plan_approval to resolve.
            // For every OTHER tool, immediately deny — Claudette relies on
            // --allowedTools for normal approvals, so reaching this path means
            // a plan-mode or unknown-tool block we should report to the model.
            if let AgentEvent::Stream(StreamEvent::ControlRequest {
                request_id,
                request:
                    ControlRequestInner::CanUseTool {
                        tool_name,
                        tool_use_id,
                        input,
                    },
            }) = &event
            {
                if matches!(tool_name.as_str(), "AskUserQuestion" | "ExitPlanMode") {
                    let app_state = app.state::<AppState>();
                    let mut agents = app_state.agents.write().await;
                    if let Some(session) = agents.get_mut(&ws_id) {
                        session.pending_permissions.insert(
                            tool_use_id.clone(),
                            PendingPermission {
                                request_id: request_id.clone(),
                                tool_name: tool_name.clone(),
                                original_input: input.clone(),
                            },
                        );
                    }
                } else {
                    // Auto-deny any other tool that reaches the permission-prompt
                    // path — current Claudette behaviour is no interactive approval
                    // beyond the question/plan cards. Sending a structured deny
                    // unblocks the CLI turn instead of hanging.
                    let app_state = app.state::<AppState>();
                    let agents = app_state.agents.read().await;
                    let ps = agents
                        .get(&ws_id)
                        .and_then(|s| s.persistent_session.clone());
                    drop(agents);
                    if let Some(ps) = ps {
                        let msg = format!(
                            "Permission for {tool_name} is not granted in this Claudette session."
                        );
                        let deny = serde_json::json!({
                            "behavior": "deny",
                            "message": msg,
                        });
                        if let Err(e) = ps.send_control_response(request_id, deny).await {
                            eprintln!("[chat] Failed to auto-deny {tool_name}: {e}");
                        }
                    }
                }
            }

            // Detect tool calls that require user input (question, plan approval).
            // Capture whether we need to notify — the actual notification is
            // deferred until after the event is emitted to the frontend so the
            // UI updates before the system notification appears.
            if let AgentEvent::Stream(StreamEvent::Stream {
                event:
                    InnerStreamEvent::ContentBlockStart {
                        content_block: Some(StartContentBlock::ToolUse { name, .. }),
                        ..
                    },
            }) = &event
                && matches!(name.as_str(), "AskUserQuestion" | "ExitPlanMode")
            {
                let kind = if name == "AskUserQuestion" {
                    crate::state::AttentionKind::Ask
                } else {
                    crate::state::AttentionKind::Plan
                };
                let app_state = app.state::<AppState>();
                let mut agents = app_state.agents.write().await;
                let already_notified = agents.get(&ws_id).is_some_and(|s| s.needs_attention);
                if let Some(session) = agents.get_mut(&ws_id) {
                    session.needs_attention = true;
                    session.attention_kind = Some(kind);
                }
                drop(agents);
                // Only send notification once per attention cycle — skip if
                // we already notified the user about this workspace.
                if !already_notified {
                    pending_attention_notify = true;
                }
            }

            // MCP monitoring: track tool_use_id → tool_name for all MCP tool calls.
            if let AgentEvent::Stream(StreamEvent::Stream {
                event:
                    InnerStreamEvent::ContentBlockStart {
                        content_block: Some(StartContentBlock::ToolUse { id, name }),
                        ..
                    },
            }) = &event
                && claudette::mcp_supervisor::extract_mcp_server_name(name).is_some()
            {
                mcp_tool_names.insert(id.clone(), name.clone());
            }

            // MCP monitoring: check tool results for connection failure patterns.
            if let AgentEvent::Stream(StreamEvent::User { message }) = &event {
                for block in &message.content {
                    if let claudette::agent::UserContentBlock::ToolResult {
                        tool_use_id,
                        content,
                    } = block
                        && let Some(tool_name) = mcp_tool_names.get(tool_use_id)
                    {
                        let content_str = content.to_string();
                        if claudette::mcp_supervisor::is_terminal_mcp_error(&content_str)
                            && let Some(server_name) =
                                claudette::mcp_supervisor::extract_mcp_server_name(tool_name)
                        {
                            let sv = app.state::<Arc<McpSupervisor>>();
                            sv.report_tool_failure(&repo_id_for_mcp, server_name, &content_str)
                                .await;
                            if let Some(snapshot) = sv.get_status(&repo_id_for_mcp).await {
                                let _ = app.emit("mcp-status-changed", &snapshot);
                            }
                        }
                    }
                }
            }

            // When a persistent turn completes (Result event), clear active_pid
            // so the workspace shows as idle. The persistent process stays alive
            // for the next turn — only active_pid is cleared, not persistent_session.
            if let AgentEvent::Stream(StreamEvent::Result { .. }) = &event {
                let app_state = app.state::<AppState>();
                let mut agents = app_state.agents.write().await;
                if let Some(session) = agents.get_mut(&ws_id)
                    && session.active_pid == Some(spawned_pid)
                    && session.persistent_session.is_some()
                {
                    session.active_pid = None;
                }
                drop(agents);
                // Rebuild tray so it reflects the idle state. Without this,
                // the tray stays stuck on "Running" because the persistent
                // process doesn't exit (only ProcessExited triggered rebuild).
                crate::tray::rebuild_tray(&app);
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
                } else if let Some(session) = agents.get_mut(&ws_id)
                    && session.active_pid == Some(spawned_pid)
                {
                    // Only clear active_pid if it still matches the process that
                    // exited. A new turn may have already replaced it.
                    session.active_pid = None;
                    // Process died — clear persistent session so the next turn
                    // spawns a fresh one.
                    session.persistent_session = None;
                }
                // Play notification sound + run command if the window is not focused.
                // This runs on the Rust side so it works even when the webview
                // is suspended (window hidden / close-to-tray).
                let needs_attention_now = agents.get(&ws_id).is_some_and(|s| s.needs_attention);
                let window_focused = app
                    .get_webview_window("main")
                    .and_then(|w| w.is_focused().ok())
                    .unwrap_or(false);
                // Skip if user is actively watching (window focused) or if this
                // is an attention event (notify_attention already handled it).
                if !window_focused
                    && !needs_attention_now
                    && let Ok(db) = Database::open(&db_path)
                {
                    let sound = db
                        .get_app_setting("notification_sound")
                        .ok()
                        .flatten()
                        .or_else(|| {
                            // Honour legacy setting for users who disabled
                            // audio before the new notification_sound key existed.
                            match db.get_app_setting("audio_notifications").ok().flatten() {
                                Some(v) if v == "false" => Some("None".to_string()),
                                _ => None,
                            }
                        })
                        .unwrap_or_else(|| "Default".to_string());
                    if sound != "None" {
                        crate::commands::settings::play_notification_sound(sound);
                    }
                    // Run notification command if configured — uses the same
                    // tested helper as the settings test button and tray path.
                    // Rebuild WorkspaceEnv from the DB so it reflects any
                    // renames that happened during the turn (try_auto_rename).
                    if let Ok(Some(cmd)) = db.get_app_setting("notification_command")
                        && !cmd.is_empty()
                        && let Some(fresh_ws) = db
                            .list_workspaces()
                            .ok()
                            .and_then(|wss| wss.into_iter().find(|w| w.id == ws_id))
                    {
                        let repo_path = db
                            .get_repository(&fresh_ws.repository_id)
                            .ok()
                            .flatten()
                            .map(|r| r.path)
                            .unwrap_or_default();
                        let default_branch = git::default_branch(&repo_path)
                            .await
                            .unwrap_or_else(|_| "main".into());
                        let fresh_env =
                            WorkspaceEnv::from_workspace(&fresh_ws, &repo_path, default_branch);
                        if let Some(mut command) =
                            crate::commands::settings::build_notification_command(&cmd, &fresh_env)
                            && let Ok(child) = command.spawn()
                        {
                            crate::commands::settings::spawn_and_reap(child);
                        }
                    }
                }

                drop(agents);
                crate::tray::rebuild_tray(&app);
            }
            // Persist assistant messages to DB on completion.
            // The CLI may fire multiple assistant events per turn: one with
            // thinking blocks only, then one with text. We accumulate thinking
            // and only save when we have text content to attach it to.
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

                // Extract thinking from this event.
                let event_thinking: Option<String> = {
                    let parts: Vec<&str> = message
                        .content
                        .iter()
                        .filter_map(|block| {
                            if let claudette::agent::ContentBlock::Thinking { thinking } = block {
                                Some(thinking.as_str())
                            } else {
                                None
                            }
                        })
                        .collect();
                    if parts.is_empty() {
                        None
                    } else {
                        Some(parts.join(""))
                    }
                };

                // Accumulate thinking from this event.
                if let Some(t) = event_thinking {
                    pending_thinking = Some(match pending_thinking.take() {
                        Some(mut existing) => {
                            existing.push_str(&t);
                            existing
                        }
                        None => t,
                    });
                }

                // Only save when we have text content — attach accumulated thinking.
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
                        thinking: pending_thinking.take(),
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

                let checkpoint = ConversationCheckpoint {
                    id: uuid::Uuid::new_v4().to_string(),
                    workspace_id: ws_id.clone(),
                    message_id: anchor_msg_id.to_string(),
                    commit_hash: None,
                    has_file_state: false, // Updated after snapshot succeeds
                    turn_index,
                    message_count: 0, // Updated by frontend after finalizeTurn
                    created_at: now_iso(),
                };
                if db.insert_checkpoint(&checkpoint).is_ok() {
                    // Snapshot worktree files into SQLite.
                    let has_files =
                        match snapshot::save_snapshot(&db_path, &checkpoint.id, &wt_path).await {
                            Ok(()) => true,
                            Err(e) => {
                                eprintln!(
                                    "[chat] Snapshot failed for {ws_id}: {e} \
                                 — checkpoint recorded without file restore capability"
                                );
                                false
                            }
                        };

                    // Emit with up-to-date has_file_state so frontend knows.
                    let mut cp_payload = checkpoint.clone();
                    cp_payload.has_file_state = has_files;
                    let payload = serde_json::json!({
                        "workspace_id": &ws_id,
                        "checkpoint": &cp_payload,
                    });
                    let _ = app.emit("checkpoint-created", &payload);
                }
            }

            let payload = AgentStreamPayload {
                workspace_id: ws_id.clone(),
                event,
            };
            let _ = app.emit("agent-stream", &payload);

            // Send attention notification AFTER emitting the event to the
            // frontend — this gives the UI time to update before the system
            // notification / sound fires, so the badge is already visible
            // when the user sees the notification.
            if pending_attention_notify {
                crate::tray::notify_attention(&app, &ws_id);
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn stop_agent(
    workspace_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Drain pending permissions and snapshot the cleanup state synchronously
    // under the lock; deny sends + the kill happen after we release it.
    let (to_deny_stop, pid_to_kill) = {
        let mut agents = state.agents.write().await;
        match agents.get_mut(&workspace_id) {
            Some(session) => {
                let drained = drain_pending_permissions(session);
                // Clear persistent session and reset session state so the next
                // turn starts completely fresh (not --resume with a stale ID).
                session.persistent_session = None;
                session.turn_count = 0;
                session.session_id = String::new();
                (drained, session.active_pid.take())
            }
            None => (None, None),
        }
    };

    if let Some((ref ps, drained)) = to_deny_stop {
        deny_drained_permissions(drained, ps, "Session stopped by user.").await;
    }
    if let Some(pid) = pid_to_kill {
        agent::stop_agent(pid).await?;
    }

    // Clear persisted session from DB too.
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let _ = db.clear_agent_session(&workspace_id);

    crate::tray::rebuild_tray(&app);

    // Log stop message.
    let msg = ChatMessage {
        id: uuid::Uuid::new_v4().to_string(),
        workspace_id,
        role: ChatRole::System,
        content: "Agent stopped".to_string(),
        cost_usd: None,
        duration_ms: None,
        created_at: now_iso(),
        thinking: None,
    };
    db.insert_chat_message(&msg).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn reset_agent_session(
    workspace_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Drain pending permissions under the lock; deny sends happen after release.
    let to_deny_reset = {
        let mut agents = state.agents.write().await;
        let drained = agents
            .get_mut(&workspace_id)
            .and_then(drain_pending_permissions);
        agents.remove(&workspace_id);
        drained
    };

    if let Some((ref ps, drained)) = to_deny_reset {
        deny_drained_permissions(drained, ps, "Session reset.").await;
    }

    // Clear persisted session so the next turn starts fresh.
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.clear_agent_session(&workspace_id)
        .map_err(|e| e.to_string())?;

    crate::tray::rebuild_tray(&app);
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
#[allow(clippy::too_many_arguments)]
async fn try_auto_rename(
    ws_id: &str,
    worktree_path: &str,
    old_name: &str,
    old_branch: &str,
    prompt: &str,
    branch_rename_preferences: Option<&str>,
    db_path: &std::path::Path,
    app: &AppHandle,
    ws_env: &WorkspaceEnv,
) {
    // Ask Haiku for a branch name slug.
    let slug = match agent::generate_branch_name(
        prompt,
        worktree_path,
        branch_rename_preferences,
        Some(ws_env),
    )
    .await
    {
        Ok(s) => s,
        Err(_) => return,
    };

    // Resolve the configured branch prefix.
    let prefix = {
        let db = match Database::open(db_path) {
            Ok(db) => db,
            Err(_) => return,
        };
        let (mode, custom) = super::workspace::read_branch_prefix_settings(&db);
        // Drop db before the async call (Database is not Sync).
        drop(db);
        super::workspace::resolve_branch_prefix(&mode, &custom).await
    };

    // Try the slug, then slug-2, slug-3 on name collision.
    let candidates = [slug.clone(), format!("{slug}-2"), format!("{slug}-3")];
    for candidate in &candidates {
        let new_branch = format!("{prefix}{candidate}");

        let db = match Database::open(db_path) {
            Ok(db) => db,
            Err(_) => return,
        };

        match db.rename_workspace(ws_id, candidate, &new_branch) {
            Ok(()) => {
                // DB updated — now rename the git branch.
                if let Err(e) = git::rename_branch(worktree_path, old_branch, &new_branch).await {
                    let _ = db.rename_workspace(ws_id, old_name, old_branch);

                    // If the target branch already exists, fall back to the next
                    // candidate just like we do for DB unique constraint collisions.
                    if e.to_string().contains("already exists") {
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
                return;
            }
            Err(e) => {
                if e.to_string().contains("UNIQUE constraint failed") {
                    continue;
                }
                return;
            }
        }
    }
}

#[tauri::command]
pub async fn clear_attention(
    workspace_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut agents = state.agents.write().await;
    if let Some(session) = agents.get_mut(&workspace_id)
        && session.needs_attention
    {
        session.needs_attention = false;
        drop(agents);
        crate::tray::rebuild_tray(&app);
    }
    Ok(())
}

/// Resolve a pending AskUserQuestion `can_use_tool` request with the user's
/// answers. `answers` is keyed by question text (matching the CLI's
/// `mapToolResultToToolResultBlockParam` expectation) and layered onto the
/// original tool input as `updatedInput`. The CLI then runs the tool's
/// `call(updatedInput)` which produces the real tool_result.
#[tauri::command]
pub async fn submit_agent_answer(
    workspace_id: String,
    tool_use_id: String,
    answers: std::collections::HashMap<String, String>,
    annotations: Option<serde_json::Value>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Validate everything BEFORE removing the pending entry: if the session
    // has been torn down or the entry maps to the wrong tool, the entry must
    // stay so the user (or the correct submit_* command) can still see it.
    let (pending, ps) = {
        let mut agents = state.agents.write().await;
        let session = agents.get_mut(&workspace_id).ok_or("Session not found")?;
        // 1. Persistent session must be alive — otherwise nobody is reading
        //    stdin and the response would be discarded.
        let ps = session
            .persistent_session
            .clone()
            .ok_or("Agent session is not active")?;
        // 2. Tool kind must match — peek by reference.
        match session.pending_permissions.get(&tool_use_id) {
            None => return Err("No pending permission request for that tool_use_id".to_string()),
            Some(p) if p.tool_name != "AskUserQuestion" => {
                return Err(format!(
                    "Pending tool is {}, not AskUserQuestion",
                    p.tool_name
                ));
            }
            _ => {}
        }
        // 3. All checks passed — now it is safe to remove.
        let pending = session
            .pending_permissions
            .remove(&tool_use_id)
            .expect("checked above");
        (pending, ps)
    };

    // Layer answers (and annotations, if any) onto the original input.
    let mut updated_input = pending.original_input.clone();
    if !updated_input.is_object() {
        updated_input = serde_json::Value::Object(serde_json::Map::new());
    }
    if let Some(obj) = updated_input.as_object_mut() {
        let answers_value =
            serde_json::to_value(&answers).map_err(|e| format!("Failed to encode answers: {e}"))?;
        obj.insert("answers".to_string(), answers_value);
        if let Some(ann) = annotations {
            obj.insert("annotations".to_string(), ann);
        }
    }

    let response = serde_json::json!({
        "behavior": "allow",
        "updatedInput": updated_input,
    });
    ps.send_control_response(&pending.request_id, response)
        .await
}

/// Resolve a pending ExitPlanMode `can_use_tool` request.
/// `approved=true` → allow with the model's original input (the CLI's
/// `call()` will save the plan and emit the real tool_result).
/// `approved=false` → deny with the given reason (or a sensible default).
#[tauri::command]
pub async fn submit_plan_approval(
    workspace_id: String,
    tool_use_id: String,
    approved: bool,
    reason: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Same validate-before-remove pattern as submit_agent_answer — see that
    // function for the rationale.
    let (pending, ps) = {
        let mut agents = state.agents.write().await;
        let session = agents.get_mut(&workspace_id).ok_or("Session not found")?;
        let ps = session
            .persistent_session
            .clone()
            .ok_or("Agent session is not active")?;
        match session.pending_permissions.get(&tool_use_id) {
            None => return Err("No pending permission request for that tool_use_id".to_string()),
            Some(p) if p.tool_name != "ExitPlanMode" => {
                return Err(format!("Pending tool is {}, not ExitPlanMode", p.tool_name));
            }
            _ => {}
        }
        let pending = session
            .pending_permissions
            .remove(&tool_use_id)
            .expect("checked above");
        (pending, ps)
    };

    let response = if approved {
        serde_json::json!({
            "behavior": "allow",
            "updatedInput": pending.original_input,
        })
    } else {
        serde_json::json!({
            "behavior": "deny",
            "message": reason.unwrap_or_else(|| "Plan denied. Please revise the approach.".into()),
        })
    };
    ps.send_control_response(&pending.request_id, response)
        .await
}

/// Synchronously drain any pending permission requests from `session` and
/// snapshot the [`PersistentSession`] needed to deny them. Designed to be
/// called while holding the agents write lock — does no async work itself.
///
/// Returns `None` when there is nothing to do (no pending entries) or when
/// there is no live `PersistentSession` to receive the denies (entries are
/// dropped in that case, since nobody could read the response anyway).
fn drain_pending_permissions(
    session: &mut AgentSessionState,
) -> Option<(Arc<PersistentSession>, Vec<PendingPermission>)> {
    if session.pending_permissions.is_empty() {
        return None;
    }
    let Some(ps) = session.persistent_session.clone() else {
        session.pending_permissions.clear();
        return None;
    };
    let drained: Vec<PendingPermission> = session
        .pending_permissions
        .drain()
        .map(|(_, p)| p)
        .collect();
    Some((ps, drained))
}

/// Send a deny `control_response` for each drained permission. Caller must
/// have already released the agents lock — this performs async I/O against
/// the CLI's stdin and would otherwise serialize all other agent-state ops.
async fn deny_drained_permissions(
    drained: Vec<PendingPermission>,
    ps: &PersistentSession,
    reason: &str,
) {
    for pending in drained {
        let deny = serde_json::json!({
            "behavior": "deny",
            "message": reason,
        });
        if let Err(e) = ps.send_control_response(&pending.request_id, deny).await {
            eprintln!(
                "[chat] Failed to deny pending {} on cleanup: {e}",
                pending.tool_name
            );
        }
    }
}

/// Load attachment metadata for a workspace's chat history.
///
/// Images (< ~5 MB base64) include inline data for immediate rendering.
/// Documents (PDFs, potentially 20+ MB) omit the body — use
/// [`load_attachment_data`] to fetch on demand.
#[tauri::command]
pub async fn load_attachments_for_workspace(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<AttachmentResponse>, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let messages = db
        .list_chat_messages(&workspace_id)
        .map_err(|e| e.to_string())?;
    let message_ids: Vec<String> = messages.iter().map(|m| m.id.clone()).collect();
    let att_map = db
        .list_attachments_for_messages(&message_ids)
        .map_err(|e| e.to_string())?;

    let mut result = Vec::new();
    for (_, atts) in att_map {
        for a in atts {
            // Only inline base64 data for images — PDFs are too large to
            // push through IPC eagerly and would stall the renderer.
            let data_base64 = if a.media_type.starts_with("image/") {
                base64_encode(&a.data)
            } else {
                String::new()
            };
            result.push(AttachmentResponse {
                id: a.id,
                message_id: a.message_id,
                filename: a.filename,
                media_type: a.media_type,
                data_base64,
                width: a.width,
                height: a.height,
                size_bytes: a.size_bytes,
            });
        }
    }
    Ok(result)
}

/// Fetch the full base64-encoded body of a single attachment by ID.
/// Used for on-demand loading of large attachments (PDFs).
#[tauri::command]
pub async fn load_attachment_data(
    attachment_id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let att = db
        .get_attachment(&attachment_id)
        .map_err(|e| e.to_string())?
        .ok_or("Attachment not found")?;
    Ok(base64_encode(&att.data))
}

/// Read a file from disk and return it as base64 with metadata.
/// Used by the frontend file picker — avoids needing the `plugin-fs` dependency.
///
/// Supported types: PNG, JPEG, GIF, WebP (images), PDF (documents).
/// Images are capped at ~3.75 MB (encodes to ~5 MB base64).
/// PDFs are capped at 20 MB (the Anthropic API raw-PDF limit).
#[tauri::command]
pub async fn read_file_as_base64(path: String) -> Result<AttachmentResponse, String> {
    use std::path::Path;

    const MAX_IMAGE_SIZE: usize = 3_932_160; // 3.75 MB
    const MAX_PDF_SIZE: usize = 20_971_520; // 20 MB

    let file_path = Path::new(&path);
    let filename = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("attachment")
        .to_string();

    let ext = file_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let media_type = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "pdf" => "application/pdf",
        other => return Err(format!("Unsupported file type: .{other}")),
    }
    .to_string();

    let data = tokio::fs::read(&path)
        .await
        .map_err(|e| format!("Failed to read file: {e}"))?;

    let size_bytes = data.len() as i64;

    // Enforce size limits per content type.
    if media_type == "application/pdf" {
        if data.len() > MAX_PDF_SIZE {
            return Err(format!(
                "PDF too large: {:.1} MB (max {} MB)",
                data.len() as f64 / 1_048_576.0,
                MAX_PDF_SIZE / 1_048_576
            ));
        }
        // Validate PDF magic bytes (%PDF-) to prevent session poisoning.
        if !data.starts_with(b"%PDF-") {
            return Err("Invalid PDF file: missing %PDF- header".to_string());
        }
    } else if data.len() > MAX_IMAGE_SIZE {
        return Err(format!(
            "Image too large: {:.1} MB (max {:.1} MB)",
            data.len() as f64 / 1_048_576.0,
            MAX_IMAGE_SIZE as f64 / 1_048_576.0
        ));
    }

    let data_base64 = base64_encode(&data);

    Ok(AttachmentResponse {
        id: String::new(),
        message_id: String::new(),
        filename,
        media_type,
        data_base64,
        width: None,
        height: None,
        size_bytes,
    })
}

fn now_iso() -> String {
    let dur = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}", dur.as_secs())
}

#[cfg(test)]
mod tests {
    use super::persistent_session_flags_drifted;

    fn s(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| (*v).to_string()).collect()
    }

    #[test]
    fn no_drift_when_plan_mode_and_tools_match() {
        let tools = s(&["Read", "Write"]);
        assert!(!persistent_session_flags_drifted(
            false, &tools, false, &tools,
        ));
    }

    #[test]
    fn drift_when_plan_mode_flips_off_after_approval() {
        // Session was spawned with --permission-mode plan; next turn is not.
        let tools = s(&["Read", "Write"]);
        assert!(persistent_session_flags_drifted(
            true, &tools, false, &tools,
        ));
    }

    #[test]
    fn drift_when_plan_mode_flips_on() {
        let tools = s(&["Read"]);
        assert!(persistent_session_flags_drifted(
            false, &tools, true, &tools,
        ));
    }

    #[test]
    fn drift_when_permission_level_changes() {
        let before = s(&["Read", "Glob"]);
        let after = s(&["Read", "Write", "Edit"]);
        assert!(persistent_session_flags_drifted(
            false, &before, false, &after,
        ));
    }

    #[test]
    fn drift_when_allowed_tools_reordered() {
        // Strict equality: a different order counts as drift. Callers build
        // the list deterministically from the permission level, so any
        // observed diff signals a real configuration change.
        assert!(persistent_session_flags_drifted(
            false,
            &s(&["Read", "Write"]),
            false,
            &s(&["Write", "Read"]),
        ));
    }

    #[test]
    fn no_drift_when_wildcard_unchanged() {
        // Permission level "full" resolves to the wildcard sentinel; reusing
        // the same bypass-permissions session should not trigger a respawn.
        let full = s(&["*"]);
        assert!(!persistent_session_flags_drifted(
            false, &full, false, &full,
        ));
    }

    #[test]
    fn drift_when_escalating_to_wildcard() {
        // Switching from a concrete list ("standard"/"readonly") up to "full"
        // needs a respawn so `build_claude_args` can apply
        // `--permission-mode bypassPermissions`.
        let standard = s(&["Read", "Write", "Edit"]);
        let full = s(&["*"]);
        assert!(persistent_session_flags_drifted(
            false, &standard, false, &full,
        ));
    }

    #[test]
    fn drift_when_demoting_from_wildcard() {
        // Dropping from "full" back to a concrete list needs a respawn so
        // the bypass-permissions mode is cleared and `--allowedTools` is
        // constrained.
        let full = s(&["*"]);
        let readonly = s(&["Read", "Glob", "Grep"]);
        assert!(persistent_session_flags_drifted(
            false, &full, false, &readonly,
        ));
    }
}
