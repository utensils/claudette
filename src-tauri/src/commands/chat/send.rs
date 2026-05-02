use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, State};

use claudette::agent::{
    self, AgentEvent, AgentSettings, ControlRequestInner, FileAttachment, InnerStreamEvent,
    PersistentSession, StartContentBlock, StreamEvent,
};
use claudette::base64_decode;
use claudette::db::Database;
use claudette::env::WorkspaceEnv;
use claudette::mcp_supervisor::McpSupervisor;
use claudette::model::{ChatMessage, ChatRole, ConversationCheckpoint};
use claudette::permissions::{is_bypass_tools, tools_for_level};
use claudette::snapshot;

use crate::state::{AgentSessionState, AppState, PendingPermission};

use super::interaction::{deny_drained_permissions, drain_pending_permissions};
use super::naming::{try_auto_rename, try_generate_session_name};
use super::{
    ATTENTION_NOTIFY_DELAY_MS, AgentStreamPayload, AttachmentInput, fire_completion_notification,
    now_iso, start_bridge_and_inject_mcp,
};

/// Spawn-time flags of the currently running persistent session, plus the
/// backend-observed `exited_plan` latch (set when the agent emits
/// `ExitPlanMode` during this session).
pub(crate) struct SessionFlags<'a> {
    pub plan_mode: bool,
    pub allowed_tools: &'a [String],
    pub exited_plan: bool,
    pub disable_1m_context: bool,
}

/// Flags the next turn is asking for. Compared against [`SessionFlags`] to
/// decide whether the process must be torn down and respawned.
pub(crate) struct RequestedFlags<'a> {
    pub plan_mode: bool,
    pub allowed_tools: &'a [String],
    pub disable_1m_context: bool,
}

/// Detect whether the persistent session's spawn-time flags have drifted
/// from what the current turn is asking for. Both `--permission-mode` and
/// `--allowedTools` are only applied when the `claude` process starts, so
/// a drift means the running process cannot serve this turn correctly and
/// must be torn down.
///
/// `exited_plan` is a backend-observed signal that the agent called
/// `ExitPlanMode` during the current session. When set alongside
/// `plan_mode`, the plan phase is over regardless of whether the frontend
/// remembered to send `plan_mode=false` — force a teardown so the CLI
/// respawns without `--permission-mode plan`.
pub(crate) fn persistent_session_flags_drifted(
    session: SessionFlags<'_>,
    requested: RequestedFlags<'_>,
) -> bool {
    session.plan_mode != requested.plan_mode
        || session.allowed_tools != requested.allowed_tools
        || session.disable_1m_context != requested.disable_1m_context
        || (session.plan_mode && session.exited_plan)
}

/// Decide how to respond to a `can_use_tool` control_request that reached the
/// handler for a tool other than AskUserQuestion / ExitPlanMode.
///
/// Bypass mode + plan not active → allow (echo `updatedInput` — required by
/// the CLI's `PermissionPromptToolResultSchema`). This is the fix for "full"
/// sessions seeing spurious denials: the CLI still routes certain tools
/// (MCP servers, Skills, some built-in edge paths) through
/// `--permission-prompt-tool stdio` even under `--permission-mode
/// bypassPermissions`, so we must answer allow rather than fall through.
///
/// Plan mode is considered **inactive** once the agent has emitted
/// `ExitPlanMode` (`session_exited_plan = true`) — even though the
/// subprocess still runs with `--permission-mode plan` until the drift
/// detector respawns it on the next turn. Without this, a bypass session
/// that just had its plan approved would still deny every mutating tool
/// for the remainder of the current turn.
///
/// Otherwise (standard/readonly, or plan-mode genuinely active) → deny with
/// a message that names the escalation path; the model paraphrases this
/// string to the user.
///
/// Auto-allow in bypass mode does not bypass an MCP server's own
/// authorization — servers refuse at their layer via a normal tool_result,
/// not a control_request.
pub(crate) fn build_permission_response(
    session_allowed_tools: &[String],
    session_plan_mode: bool,
    session_exited_plan: bool,
    tool_name: &str,
    original_input: &serde_json::Value,
) -> serde_json::Value {
    let bypass = is_bypass_tools(session_allowed_tools);
    let plan_active = session_plan_mode && !session_exited_plan;
    if bypass && !plan_active {
        serde_json::json!({
            "behavior": "allow",
            "updatedInput": original_input,
        })
    } else {
        let msg = format!(
            "{tool_name} isn't enabled at the current permission level. Switch to 'full' in the chat toolbar (or run /permissions full) to allow it."
        );
        serde_json::json!({
            "behavior": "deny",
            "message": msg,
        })
    }
}

#[tauri::command]
pub async fn load_chat_history(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<ChatMessage>, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.list_chat_messages_for_session(&session_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn send_chat_message(
    session_id: String,
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
    disable_1m_context: Option<bool>,
    attachments: Option<Vec<AttachmentInput>>,
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
    let _is_first_session = chat_session.sort_order == 0;
    let session_name_already_edited = chat_session.name_edited;

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
        chat_session_id: chat_session_id.clone(),
        role: ChatRole::User,
        content: content.clone(),
        cost_usd: None,
        duration_ms: None,
        created_at: now_iso(),
        thinking: None,
        input_tokens: None,
        output_tokens: None,
        cache_read_tokens: None,
        cache_creation_tokens: None,
    };
    // Decode, validate, and persist attachments alongside the user message.
    // Both inserts share a transaction so the message and its attachments are
    // atomic — a failed attachment decode won't leave an orphaned message.
    // Mirrors the agent-side allow-list in
    // `src/agent_mcp/tools/send_to_user.rs::policy`. Keep the two in sync —
    // outbound (agent → user) symmetry with inbound (user → agent) is the
    // documented invariant.
    const ALLOWED_MIME: &[&str] = &[
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "image/svg+xml",
        "application/pdf",
        "text/plain",
        "text/csv",
        "text/markdown",
        "application/json",
    ];
    const MAX_IMAGE_BYTES: usize = 3_932_160; // 3.75 MB
    const MAX_PDF_BYTES: usize = 20 * 1024 * 1024; // 20 MB
    const MAX_TEXT_BYTES: usize = 1024 * 1024; // 1 MB
    const MAX_CSV_BYTES: usize = 2 * 1024 * 1024; // 2 MB
    const MAX_MARKDOWN_BYTES: usize = 1024 * 1024; // 1 MB
    const MAX_JSON_BYTES: usize = 1024 * 1024; // 1 MB

    fn is_text_kind(media_type: &str) -> bool {
        matches!(
            media_type,
            "text/plain" | "text/csv" | "text/markdown" | "application/json"
        )
    }

    let mut att_models: Vec<claudette::model::Attachment> = Vec::new();
    let mut cli_atts: Vec<FileAttachment> = Vec::new();

    if let Some(ref inputs) = attachments {
        for input in inputs {
            if !ALLOWED_MIME.contains(&input.media_type.as_str()) {
                return Err(format!("Unsupported attachment type: {}", input.media_type));
            }
            let data = base64_decode(&input.data_base64).map_err(|e| format!("Bad base64: {e}"))?;
            let max = match input.media_type.as_str() {
                "application/pdf" => MAX_PDF_BYTES,
                "text/plain" => MAX_TEXT_BYTES,
                "text/csv" => MAX_CSV_BYTES,
                "text/markdown" => MAX_MARKDOWN_BYTES,
                "application/json" => MAX_JSON_BYTES,
                _ => MAX_IMAGE_BYTES,
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
            let text_content = if is_text_kind(&input.media_type) {
                let check_len = data.len().min(8192);
                if data[..check_len].contains(&0) {
                    return Err(format!(
                        "Invalid {} attachment: binary content detected",
                        input.media_type
                    ));
                }
                let decoded = std::str::from_utf8(&data).map_err(|_| {
                    format!(
                        "Invalid {} attachment: payload is not valid UTF-8",
                        input.media_type
                    )
                })?;
                Some(
                    input
                        .text_content
                        .clone()
                        .unwrap_or_else(|| decoded.to_owned()),
                )
            } else {
                None
            };
            let size_bytes = data.len() as i64;
            att_models.push(claudette::model::Attachment {
                id: uuid::Uuid::new_v4().to_string(),
                message_id: user_msg.id.clone(),
                filename: input.filename.clone(),
                media_type: input.media_type.clone(),
                width: None,
                height: None,
                size_bytes,
                data,
                created_at: now_iso(),
                origin: claudette::model::AttachmentOrigin::User,
                tool_use_id: None,
            });
            cli_atts.push(FileAttachment {
                media_type: input.media_type.clone(),
                data_base64: input.data_base64.clone(),
                text_content,
                filename: Some(input.filename.clone()),
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

    // Agents are keyed by the `chat_sessions.id` of the target tab. The
    // workspace id is carried alongside so tray/notification code can group
    // per workspace.
    let mut agents = state.agents.write().await;
    let session = agents.entry(chat_session_id.clone()).or_insert_with(|| {
        // Try restoring a persisted session from the chat_sessions row.
        if let Ok(Some(chat_session)) = db.get_chat_session(&chat_session_id)
            && let Some(claude_sid) = chat_session.session_id.clone()
        {
            return AgentSessionState {
                workspace_id: workspace_id.clone(),
                session_id: claude_sid,
                turn_count: chat_session.turn_count,
                active_pid: None,
                custom_instructions: instructions.clone(),
                needs_attention: false,
                attention_kind: None,
                attention_notification_sent: false,
                persistent_session: None,
                mcp_config_dirty: false,
                session_plan_mode: false,
                session_allowed_tools: Vec::new(),
                session_disable_1m_context: false,
                pending_permissions: std::collections::HashMap::new(),
                session_exited_plan: false,
                session_resolved_env: Default::default(),
                mcp_bridge: None,
                last_user_msg_id: None,
                posted_env_trust_warning: false,
            };
        }

        AgentSessionState {
            workspace_id: workspace_id.clone(),
            session_id: uuid::Uuid::new_v4().to_string(),
            turn_count: 0,
            active_pid: None,
            custom_instructions: instructions,
            needs_attention: false,
            attention_kind: None,
            attention_notification_sent: false,
            persistent_session: None,
            mcp_config_dirty: false,
            session_plan_mode: false,
            session_allowed_tools: Vec::new(),
            session_disable_1m_context: false,
            pending_permissions: std::collections::HashMap::new(),
            session_exited_plan: false,
            session_resolved_env: Default::default(),
            mcp_bridge: None,
            last_user_msg_id: None,
            posted_env_trust_warning: false,
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
        let session = agents.get_mut(&chat_session_id).ok_or("Session lost")?;
        session.active_pid = None;
    } else if let Some((ref ps, drained)) = to_deny_new_turn {
        // No stale-pid teardown — release the lock just for the deny sends,
        // then re-acquire so the rest of this function can mutate the session.
        drop(agents);
        deny_drained_permissions(drained, ps, "User sent a new message instead of answering.")
            .await;
        agents = state.agents.write().await;
    }
    let session = agents.get_mut(&chat_session_id).ok_or("Session lost")?;

    // The user message has been persisted; record its id as the FK anchor
    // for any agent-authored attachments produced during this turn (see
    // `agent_mcp_sink::ChatBridgeSink`).
    session.last_user_msg_id = Some(user_msg.id.clone());

    // MCP config changed while a previous turn was in flight — tear down the
    // persistent session so the next spawn picks up updated --mcp-config.
    // The session is idle between turns so a graceful SIGTERM is sufficient.
    if session.mcp_config_dirty {
        eprintln!("[chat] MCP config dirty — tearing down persistent session for {workspace_id}");
        let to_deny_mcp = drain_pending_permissions(session);
        let stale_pid = session.persistent_session.as_ref().map(|ps| ps.pid());
        session.persistent_session = None;
        // Tear down the agent-MCP bridge alongside the persistent session.
        // Drop runs the listener cancellation + socket file unlink.
        session.mcp_bridge = None;
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
    let session = agents.get_mut(&chat_session_id).ok_or("Session lost")?;

    // The `send_to_user` built-in plugin is user-toggleable in Settings →
    // Plugins. When disabled we skip both the synthetic MCP injection
    // (further down, before spawn) and the system-prompt nudge here, so the
    // agent has neither the tool nor any hint it exists.
    let send_to_user_enabled = claudette::agent_mcp::is_builtin_plugin_enabled(&db, "send_to_user");

    // Prepend the agent-MCP nudge to the user's repo-level instructions so
    // the model knows to reach for `mcp__claudette__send_to_user` when the
    // user asks for an inline file delivery. The nudge is session-level
    // (only applied on fresh spawns via `--append-system-prompt`); on resume
    // turns the original spawn's prompt is already in the CLI process.
    let custom_instructions = if send_to_user_enabled {
        let nudge = claudette::agent_mcp::SYSTEM_PROMPT_NUDGE;
        match session.custom_instructions.as_deref() {
            Some(existing) if !existing.trim().is_empty() => Some(format!("{nudge}\n\n{existing}")),
            _ => Some(nudge.to_string()),
        }
    } else {
        session.custom_instructions.clone()
    };

    // Prepend the developer-bundled global system prompt to every fresh
    // session. The global prompt is compiled into the binary via include_str!
    // and sits outermost so it frames all per-repo and MCP instructions.
    let custom_instructions = {
        let global = claudette::global_prompt::GLOBAL_SYSTEM_PROMPT;
        if global.trim().is_empty() {
            custom_instructions
        } else {
            match custom_instructions.as_deref() {
                Some(existing) if !existing.trim().is_empty() => {
                    Some(format!("{global}\n\n{existing}"))
                }
                _ => Some(global.to_string()),
            }
        }
    };
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
        disable_1m_context: disable_1m_context.unwrap_or(false),
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
            SessionFlags {
                plan_mode: session.session_plan_mode,
                allowed_tools: &session.session_allowed_tools,
                exited_plan: session.session_exited_plan,
                disable_1m_context: session.session_disable_1m_context,
            },
            RequestedFlags {
                plan_mode: agent_settings.plan_mode,
                allowed_tools: &allowed_tools,
                disable_1m_context: agent_settings.disable_1m_context,
            },
        )
    {
        eprintln!(
            "[chat] session flags drifted (plan_mode {} -> {}, allowed_tools changed: {}, exited_plan: {}, disable_1m_context {} -> {}) — tearing down persistent session for {workspace_id}",
            session.session_plan_mode,
            agent_settings.plan_mode,
            session.session_allowed_tools != allowed_tools,
            session.session_exited_plan,
            session.session_disable_1m_context,
            agent_settings.disable_1m_context,
        );
        // Resolve any pending permission requests against the doomed process
        // before we kill it, so the next turn doesn't carry stale tool_use_ids.
        let to_deny_drift = drain_pending_permissions(session);
        let stale_pid = session.persistent_session.as_ref().map(|ps| ps.pid());
        session.persistent_session = None;
        session.mcp_bridge = None;
        // Clear active_pid alongside persistent_session. A concurrent turn
        // streaming this process at drift time would leave active_pid set;
        // without this clear, a failed respawn + next turn would SIGKILL a
        // potentially recycled PID via the stale-process teardown branch.
        session.active_pid = None;
        // The spawn-completion sites below also clear this alongside
        // `session_plan_mode`; resetting here too documents that drift-driven
        // teardown ends the plan observation at the teardown point, not the
        // respawn point.
        session.session_exited_plan = false;
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
    let session = agents.get_mut(&chat_session_id).ok_or("Session lost")?;

    // Expand @-file mentions into inline file content for the agent prompt.
    let prompt = claudette::file_expand::expand_file_mentions(
        std::path::Path::new(&worktree_path),
        &content,
        mentioned_files.as_deref().unwrap_or(&[]),
    )
    .await;

    let repo_path = repo.as_ref().map(|r| r.path.as_str()).unwrap_or("");
    let default_branch = match repo.as_ref().and_then(|r| r.base_branch.as_deref()) {
        Some(b) => b.to_string(),
        None => claudette::git::default_branch(
            repo_path,
            repo.as_ref().and_then(|r| r.default_remote.as_deref()),
        )
        .await
        .unwrap_or_else(|_| "main".to_string()),
    };
    let ws_env = WorkspaceEnv::from_workspace(ws, repo_path, default_branch);

    // Resolve the env-provider layer (direnv / mise / dotenv / nix-devshell)
    // once per turn. The mtime-keyed cache makes this essentially free on
    // turns where nothing changed; on the first turn or after the user
    // edits `.envrc` / `mise.toml` / etc., it re-runs the affected plugin.
    let ws_info_for_env = claudette::plugin_runtime::host_api::WorkspaceInfo {
        id: ws.id.clone(),
        name: ws.name.clone(),
        branch: ws.branch_name.clone(),
        worktree_path: worktree_path.clone(),
        repo_path: repo_path.to_string(),
    };
    let disabled_env_providers = {
        let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
        let repo_id = repo.as_ref().map(|r| r.id.as_str()).unwrap_or("");
        crate::commands::env::load_disabled_providers(&db, repo_id)
    };
    let resolved_env = {
        let registry = state.plugins.read().await;
        claudette::env_provider::resolve_with_registry(
            &registry,
            &state.env_cache,
            std::path::Path::new(&worktree_path),
            &ws_info_for_env,
            &disabled_env_providers,
        )
        .await
    };
    crate::commands::env::register_resolved_with_watcher(
        &state,
        std::path::Path::new(&worktree_path),
        &resolved_env.sources,
    )
    .await;

    // Env-provider drift teardown: the env baked into the current
    // persistent session is fixed at spawn time; Claude's subprocess
    // won't see `.envrc` / `mise.toml` / `direnv allow` changes until
    // it's respawned. Compare the freshly-resolved vars against the
    // snapshot stored at spawn and teardown on any divergence. The
    // mtime-keyed cache makes this re-resolve nearly free on quiet
    // turns, so the check costs nothing in the common case.
    if session.persistent_session.is_some() && session.session_resolved_env != resolved_env.vars {
        eprintln!(
            "[chat] env-provider output changed ({} vars before, {} after) — tearing down persistent session for {workspace_id}",
            session.session_resolved_env.len(),
            resolved_env.vars.len(),
        );
        let to_deny_env = drain_pending_permissions(session);
        let stale_pid = session.persistent_session.as_ref().map(|ps| ps.pid());
        session.persistent_session = None;
        session.mcp_bridge = None;
        session.active_pid = None;
        session.session_exited_plan = false;
        // Env vars changed → re-arm the trust-warning dedupe so a fresh
        // failure (e.g. user ran `mise trust` but `.envrc` is still
        // blocked) reposts exactly once for the new error set.
        session.posted_env_trust_warning = false;
        if stale_pid.is_some() || to_deny_env.is_some() {
            drop(agents);
            if let Some((ref ps, drained)) = to_deny_env {
                deny_drained_permissions(
                    drained,
                    ps,
                    "Session restarted because workspace env changed.",
                )
                .await;
            }
            if let Some(pid) = stale_pid {
                let _ = agent::stop_agent_graceful(pid).await;
            }
            agents = state.agents.write().await;
        }
    }
    let session = agents.get_mut(&chat_session_id).ok_or("Session lost")?;

    // If any env-provider reported a trust/priming error (`mise trust`,
    // `direnv allow`, …) surface it inline as a System message. Without
    // this the agent spawns with a degraded env and the user sees no
    // explanation for the resulting silent failure (#478). Dedupe via
    // `posted_env_trust_warning` so we don't spam every turn while the
    // user fixes it; the flag clears when the resolved env changes.
    if !session.posted_env_trust_warning
        && let Some(body) = resolved_env.format_trust_message()
    {
        let warning = ChatMessage {
            id: uuid::Uuid::new_v4().to_string(),
            workspace_id: workspace_id.clone(),
            chat_session_id: chat_session_id.clone(),
            role: ChatRole::System,
            content: body,
            cost_usd: None,
            duration_ms: None,
            created_at: now_iso(),
            thinking: None,
            input_tokens: None,
            output_tokens: None,
            cache_read_tokens: None,
            cache_creation_tokens: None,
        };
        if let Err(err) = db.insert_chat_message(&warning) {
            // Logging-only: a missing warning shouldn't block the turn.
            eprintln!("[chat] failed to post env-trust warning: {err}");
        } else {
            session.posted_env_trust_warning = true;
            // Emit so the open chat panel can render the warning
            // immediately without waiting for the failing turn to
            // finalize and trigger a history reload.
            let _ = app.emit("chat-system-message", &warning);
        }
    }

    // Use persistent session to keep MCP servers alive across turns.
    // First turn or after restart: start a PersistentSession.
    // Subsequent turns in same session: reuse the existing process via stdin.
    let existing_persistent = session.persistent_session.clone();
    let saved_session_id = session.session_id.clone();
    let saved_turn_count = session.turn_count;

    // Helper: start a persistent session, using --resume for restored sessions.
    // Routes claude-missing errors through the missing-CLI dialog emitter so
    // both the initial-start and respawn paths surface the same guidance.
    let ws_env_for_persistent = ws_env.clone();
    let resolved_env_for_persistent = resolved_env.clone();
    let app_for_persistent = app.clone();
    let start_persistent = move |worktree: String,
                                 sid: String,
                                 is_resume: bool,
                                 tools: Vec<String>,
                                 instructions: Option<String>,
                                 settings: AgentSettings| {
        let env = ws_env_for_persistent.clone();
        let resolved = resolved_env_for_persistent.clone();
        let app = app_for_persistent.clone();
        async move {
            let started = PersistentSession::start(
                std::path::Path::new(&worktree),
                &sid,
                is_resume,
                &tools,
                instructions.as_deref(),
                &settings,
                Some(&env),
                Some(&resolved),
            )
            .await
            .map_err(|e| crate::missing_cli::handle_err(&app, &e).unwrap_or(e))?;
            Ok::<Arc<PersistentSession>, String>(Arc::new(started))
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
                session.mcp_bridge = None;
                drop(agents);

                let mut respawn_settings = agent_settings.clone();
                let bridge = if send_to_user_enabled {
                    let (b, mcp_with_claudette) = start_bridge_and_inject_mcp(
                        &app,
                        &state.db_path,
                        &workspace_id,
                        &chat_session_id,
                        agent_settings.mcp_config.clone(),
                    )
                    .await?;
                    respawn_settings.mcp_config = mcp_with_claudette;
                    Some(b)
                } else {
                    None
                };

                let is_resume = saved_turn_count > 1;
                let (ps, final_sid) = match start_persistent(
                    worktree_path.clone(),
                    saved_session_id.clone(),
                    is_resume,
                    allowed_tools.clone(),
                    custom_instructions.clone(),
                    respawn_settings.clone(),
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
                            respawn_settings.clone(),
                        )
                        .await?;
                        (ps, fresh)
                    }
                    Err(e2) => {
                        let _ = db.clear_chat_session_state(&chat_session_id);
                        return Err(e2);
                    }
                };
                let handle = ps.send_turn(&prompt, &image_attachments).await?;

                agents = state.agents.write().await;
                let session = agents.get_mut(&chat_session_id).ok_or("Session lost")?;
                session.persistent_session = Some(ps);
                session.mcp_bridge = bridge;
                session.session_id = final_sid;
                session.session_plan_mode = agent_settings.plan_mode;
                session.session_allowed_tools = allowed_tools.clone();
                session.session_disable_1m_context = agent_settings.disable_1m_context;
                // Fresh process — any prior ExitPlanMode observation belongs
                // to the dead session. Keep this in lockstep with the
                // spawn-time flags above so the latch can't leak across
                // respawns (including paths that skip the drift branch).
                session.session_exited_plan = false;
                session.session_resolved_env = resolved_env.vars.clone();
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

        // Start the agent-MCP bridge and merge the synthetic `claudette`
        // server entry into the spawn-time `--mcp-config` JSON when the
        // built-in `send_to_user` plugin is enabled. The bridge is stored
        // on the session below so it lives exactly as long as the
        // persistent CLI process.
        let mut spawn_settings = agent_settings.clone();
        let bridge = if send_to_user_enabled {
            let (b, mcp_with_claudette) = start_bridge_and_inject_mcp(
                &app,
                &state.db_path,
                &workspace_id,
                &chat_session_id,
                agent_settings.mcp_config.clone(),
            )
            .await?;
            spawn_settings.mcp_config = mcp_with_claudette;
            Some(b)
        } else {
            None
        };

        let (ps, final_sid) = match start_persistent(
            worktree_path.clone(),
            sid.clone(),
            is_resume,
            allowed_tools.clone(),
            custom_instructions.clone(),
            spawn_settings.clone(),
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
                    spawn_settings.clone(),
                )
                .await?;
                (ps, fresh_sid)
            }
            Err(e) => {
                // Spawn failed entirely — clear the per-session Claude state
                // so the next attempt doesn't try --resume with a dead
                // session ID. Must be per-session (not workspace-scoped)
                // because other tabs in this workspace may still be live.
                let _ = db.clear_chat_session_state(&chat_session_id);
                agents = state.agents.write().await;
                if let Some(session) = agents.get_mut(&chat_session_id) {
                    session.turn_count = 0;
                    session.session_id = String::new();
                }
                drop(agents);
                let e = crate::missing_cli::handle_err(&app, &e).unwrap_or(e);
                return Err(e);
            }
        };
        let handle = ps.send_turn(&prompt, &image_attachments).await?;

        agents = state.agents.write().await;
        let session = agents.get_mut(&chat_session_id).ok_or("Session lost")?;
        session.persistent_session = Some(ps);
        session.mcp_bridge = bridge;
        session.session_id = final_sid.clone();
        session.session_plan_mode = agent_settings.plan_mode;
        session.session_allowed_tools = allowed_tools.clone();
        session.session_disable_1m_context = agent_settings.disable_1m_context;
        // See the sibling reset above — fresh process, fresh latch.
        session.session_exited_plan = false;
        session.session_resolved_env = resolved_env.vars.clone();
        let _ = db.save_chat_session_state(&chat_session_id, &final_sid, session.turn_count);
        handle
    };

    let spawned_pid = turn_handle.pid;
    {
        let session = agents.get_mut(&chat_session_id).ok_or("Session lost")?;
        session.active_pid = Some(spawned_pid);
        let _ =
            db.save_chat_session_state(&chat_session_id, &session.session_id, session.turn_count);
        let _ = db.insert_agent_session(&session.session_id, &workspace_id, &ws.repository_id);
        let _ = db.reopen_agent_session(&session.session_id);
        let _ = db.update_agent_session_turn(&session.session_id, session.turn_count);
        if db
            .get_app_setting("first_session_at")
            .ok()
            .flatten()
            .is_none()
        {
            let _ = db.set_app_setting("first_session_at", &chrono::Utc::now().to_rfc3339());
        }
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

    // Atomically claim the one-shot auto-rename slot here — on the calling
    // task's existing DB handle — so the spawned bridge doesn't need to
    // reopen the database just to flip a flag, and so any SQLite error
    // surfaces as a visible log rather than silently skipping the rename.
    // The flag is a persistent per-workspace marker; a session that restarts
    // for any reason (app reopen, stop_agent, spawn failure, `!got_init`
    // early exit) can't re-trigger a rename on a later prompt because the
    // claim has already been taken. The flag tracks the claim, not the
    // outcome: a Haiku/git failure below intentionally does not release it.
    let claimed_rename = if has_repo {
        match db.claim_branch_auto_rename(&workspace_id) {
            Ok(claimed) => claimed,
            Err(e) => {
                eprintln!("[chat] claim_branch_auto_rename failed for {workspace_id}: {e}");
                false
            }
        }
    } else {
        false
    };

    crate::tray::rebuild_tray(&app);

    // Bridge: read from mpsc receiver, emit Tauri events.
    let ws_id = workspace_id.clone();
    let chat_session_id_for_stream = chat_session_id.clone();
    let db_path = state.db_path.clone();
    let wt_path = worktree_path.clone();
    let user_msg_id = user_msg.id.clone();
    let repo_id_for_mcp = ws.repository_id.clone();
    drop(ws_env); // consumed by rename_ws_env; notification path rebuilds from DB
    tokio::spawn(async move {
        if claimed_rename {
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

        // Also spawn a background task to generate a human-readable session
        // name for the tab. Fires on every new session's first turn (not just
        // the first session of the workspace). Skipped if the user already
        // renamed the session manually.
        if saved_turn_count <= 1 && !session_name_already_edited {
            let sid2 = chat_session_id_for_stream.clone();
            let wt_path2 = wt_path.clone();
            let prompt2 = rename_prompt.clone();
            let db_path2 = db_path.clone();
            let app2 = app.clone();
            let ws_env2 = rename_ws_env.clone();
            tokio::spawn(async move {
                try_generate_session_name(&sid2, &wt_path2, &prompt2, &db_path2, &app2, &ws_env2)
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
        // Tracks the most recent per-message usage observed on a MessageDelta
        // event. Written into the next persisted assistant ChatMessage and reset
        // to None after each persistence so per-message counts stay distinct
        // across multi-message turns.
        let mut latest_usage: Option<claudette::agent::TokenUsage> = None;
        let mut notified_via_result = false;
        while let Some(event) = rx.recv().await {
            // Track whether the CLI initialized successfully.
            if let AgentEvent::Stream(StreamEvent::System { subtype, .. }) = &event
                && subtype == "init"
            {
                got_init = true;
            }

            // Compaction boundary event: the CLI emits this after context
            // compaction completes. Persist a structured sentinel system
            // message so the timeline renders a divider on live + reload,
            // and set the sentinel's cache_read_tokens to post_tokens so
            // Phase 2.5's extractLatestCallUsage picks up the new meter
            // baseline on workspace reload.
            if let AgentEvent::Stream(StreamEvent::System {
                subtype,
                compact_metadata: Some(meta),
                ..
            }) = &event
                && subtype == "compact_boundary"
                && let Ok(db) = Database::open(&db_path)
            {
                let sentinel = format!(
                    "COMPACTION:{}:{}:{}:{}",
                    meta.trigger, meta.pre_tokens, meta.post_tokens, meta.duration_ms
                );
                let msg = ChatMessage {
                    id: uuid::Uuid::new_v4().to_string(),
                    workspace_id: ws_id.clone(),
                    chat_session_id: chat_session_id_for_stream.clone(),
                    role: ChatRole::System,
                    content: sentinel,
                    cost_usd: None,
                    duration_ms: None,
                    created_at: now_iso(),
                    thinking: None,
                    input_tokens: None,
                    output_tokens: None,
                    cache_read_tokens: Some(meta.post_tokens as i64),
                    cache_creation_tokens: None,
                };
                let _ = db.insert_chat_message(&msg);
            }

            // Handle control_request: can_use_tool from the CLI's stdio
            // permission prompt protocol. Three branches:
            //   1. AskUserQuestion / ExitPlanMode — stash a pending record and
            //      emit `agent-permission-prompt` so the UI card renders only
            //      after the Rust side is ready to receive the answer.
            //      Needed even in bypass mode: the agent wants the user's
            //      *answer*, not just permission.
            //   2. Session spawned in bypass mode + plan mode OFF — auto-allow.
            //      The CLI still routes some tools (MCP, Skills, certain
            //      edge-path built-ins) through `--permission-prompt-tool
            //      stdio` even under `--permission-mode bypassPermissions`, so
            //      without this branch "full" users see spurious denials.
            //   3. Otherwise — deny with a message that names the escalation
            //      path (the model paraphrases this to the user).
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
                    if let Some(session) = agents.get_mut(&chat_session_id_for_stream) {
                        session.pending_permissions.insert(
                            tool_use_id.clone(),
                            PendingPermission {
                                request_id: request_id.clone(),
                                tool_name: tool_name.clone(),
                                original_input: input.clone(),
                            },
                        );
                    }
                    drop(agents);
                    let payload = serde_json::json!({
                        "workspace_id": &ws_id,
                        "chat_session_id": &chat_session_id_for_stream,
                        "tool_use_id": tool_use_id,
                        "tool_name": tool_name,
                        "input": input,
                    });
                    let _ = app.emit("agent-permission-prompt", &payload);

                    // Fire the system notification after the frontend has the
                    // data it needs to render the card. We emit
                    // `agent-permission-prompt` synchronously above; the
                    // short sleep gives the webview time to pick up the event
                    // and paint before the notification sound/banner arrives.
                    // Tied to ControlRequest (not the earlier ContentBlockStart)
                    // because the card is driven by this event, not the
                    // streaming tool_use block.
                    //
                    // The task is detached, so it must defend against state
                    // changes during the sleep:
                    //   - If the user already responded (or the session was
                    //     stopped/cleared), the matching pending_permission is
                    //     gone and a notification would be misleading.
                    //   - If a different pending prompt in the same cycle has
                    //     already triggered the notification, dedupe via
                    //     `attention_notification_sent`.
                    let kind = if tool_name == "AskUserQuestion" {
                        crate::state::AttentionKind::Ask
                    } else {
                        crate::state::AttentionKind::Plan
                    };
                    let app_for_notify = app.clone();
                    let ws_id_for_notify = ws_id.clone();
                    let session_id_for_notify = chat_session_id_for_stream.clone();
                    let tool_use_id_for_notify = tool_use_id.clone();
                    let request_id_for_notify = request_id.clone();
                    let tool_name_for_notify = tool_name.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_millis(
                            ATTENTION_NOTIFY_DELAY_MS,
                        ))
                        .await;

                        let app_state = app_for_notify.state::<AppState>();
                        let should_notify = {
                            let mut agents = app_state.agents.write().await;
                            let Some(session) = agents.get_mut(&session_id_for_notify) else {
                                return;
                            };
                            if session.attention_notification_sent {
                                false
                            } else {
                                let still_pending = session
                                    .pending_permissions
                                    .get(&tool_use_id_for_notify)
                                    .is_some_and(|p| {
                                        p.request_id == request_id_for_notify
                                            && p.tool_name == tool_name_for_notify
                                    });
                                if still_pending {
                                    session.attention_notification_sent = true;
                                }
                                still_pending
                            }
                        };

                        if should_notify {
                            crate::tray::notify_attention(&app_for_notify, &ws_id_for_notify, kind);
                        }
                    });
                } else {
                    let app_state = app.state::<AppState>();
                    let agents = app_state.agents.read().await;
                    let (ps, session_allowed_tools, session_plan_mode, session_exited_plan) =
                        agents
                            .get(&chat_session_id_for_stream)
                            .map(|s| {
                                (
                                    s.persistent_session.clone(),
                                    s.session_allowed_tools.clone(),
                                    s.session_plan_mode,
                                    s.session_exited_plan,
                                )
                            })
                            .unwrap_or_else(|| (None, Vec::new(), false, false));
                    drop(agents);
                    if let Some(ps) = ps {
                        let response = build_permission_response(
                            &session_allowed_tools,
                            session_plan_mode,
                            session_exited_plan,
                            tool_name,
                            input,
                        );
                        if let Err(e) = ps.send_control_response(request_id, response).await {
                            eprintln!(
                                "[chat] Failed to respond to control_request for {tool_name}: {e}"
                            );
                        }
                    }
                }
            }

            // Detect tool calls that require user input (question, plan approval).
            // The tray state flip happens here (on ContentBlockStart) so the
            // icon/menu update is immediate. The *notification* itself fires
            // later, from the ControlRequest branch, once the frontend has the
            // data it needs to render the question/plan card.
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
                if let Some(session) = agents.get_mut(&chat_session_id_for_stream) {
                    session.needs_attention = true;
                    session.attention_kind = Some(kind);
                    // Observed ExitPlanMode — the plan phase is ending. Mark
                    // so the next turn forces a subprocess teardown even if
                    // the frontend fails to flip `plan_mode=false`.
                    if name == "ExitPlanMode" {
                        session.session_exited_plan = true;
                    }
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

            // Synthetic user messages (post-compaction continuation). The
            // CLI sets isSynthetic: true at the top level of the user
            // event (sibling of `message`, not inside it). Persist as a
            // system-role message with a SYNTHETIC_SUMMARY sentinel so
            // the frontend can render a collapsed-by-default summary
            // block instead of a spurious user bubble.
            if let AgentEvent::Stream(StreamEvent::User {
                message,
                is_synthetic: true,
            }) = &event
                && let claudette::agent::UserMessageContent::Text(body) = &message.content
                && let Ok(db) = Database::open(&db_path)
            {
                let sentinel = format!("SYNTHETIC_SUMMARY:\n{body}");
                let msg = ChatMessage {
                    id: uuid::Uuid::new_v4().to_string(),
                    workspace_id: ws_id.clone(),
                    chat_session_id: chat_session_id_for_stream.clone(),
                    role: ChatRole::System,
                    content: sentinel,
                    cost_usd: None,
                    duration_ms: None,
                    created_at: now_iso(),
                    thinking: None,
                    input_tokens: None,
                    output_tokens: None,
                    cache_read_tokens: None,
                    cache_creation_tokens: None,
                };
                let _ = db.insert_chat_message(&msg);
            }

            // MCP monitoring: check tool results for connection failure patterns.
            // Text-content user events (local-command-stdout, synthetic
            // continuations) skip this block — they're handled by Task 4's
            // bridge logic and have no tool_result shape to monitor.
            if let AgentEvent::Stream(StreamEvent::User { message, .. }) = &event
                && let claudette::agent::UserMessageContent::Blocks(blocks) = &message.content
            {
                for block in blocks {
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
            if let AgentEvent::Stream(StreamEvent::Result { subtype, .. }) = &event {
                let app_state = app.state::<AppState>();
                let (session_id_for_capture, needs_attention) = {
                    let mut agents = app_state.agents.write().await;
                    if let Some(session) = agents.get_mut(&chat_session_id_for_stream)
                        && session.active_pid == Some(spawned_pid)
                        && session.persistent_session.is_some()
                    {
                        session.active_pid = None;
                    }
                    let sid = agents
                        .get(&chat_session_id_for_stream)
                        .map(|s| s.session_id.clone())
                        .unwrap_or_default();
                    let attn = agents
                        .get(&chat_session_id_for_stream)
                        .is_some_and(|s| s.needs_attention);
                    (sid, attn)
                };
                // Rebuild tray so it reflects the idle state. Without this,
                // the tray stays stuck on "Running" because the persistent
                // process doesn't exit (only ProcessExited triggered rebuild).
                crate::tray::rebuild_tray(&app);
                // Clear any per-message usage that survived this turn without being
                // consumed (e.g. a thinking-only final message with no text to persist).
                // Ensures the next turn starts with a clean slate.
                let _ = latest_usage.take();
                // Metrics: persistent sessions never trigger ProcessExited
                // between turns, so per-session commit scraping must run on
                // every Result event. Idempotent on (workspace_id, commit_hash).
                claudette::metrics::capture_session_commits(
                    &db_path,
                    &ws_id,
                    &session_id_for_capture,
                    &repo_id_for_mcp,
                    &wt_path,
                )
                .await;
                if !needs_attention {
                    let event = if subtype == "success" {
                        crate::tray::NotificationEvent::Finished
                    } else {
                        crate::tray::NotificationEvent::Error
                    };
                    fire_completion_notification(&db_path, &app_state.cesp_playback, event, &ws_id)
                        .await;
                    notified_via_result = true;
                }
            }

            // Track per-assistant-message cumulative usage as the CLI streams it.
            // The final MessageDelta before message_stop carries the authoritative
            // per-message total; we overwrite on every delta and consume it when the
            // assistant message is persisted below.
            if let AgentEvent::Stream(StreamEvent::Stream {
                event: InnerStreamEvent::MessageDelta { usage: Some(u) },
            }) = &event
            {
                latest_usage = Some(u.clone());
            }

            if let AgentEvent::ProcessExited(code) = &event {
                let exit_code = *code;
                let app_state = app.state::<AppState>();
                let mut agents = app_state.agents.write().await;
                // Snapshot session_id before any mutation so metrics hooks
                // below can reference the session we just finished.
                let ended_session_id: Option<String> = agents
                    .get(&chat_session_id_for_stream)
                    .map(|s| s.session_id.clone());
                // Track whether this exit actually belongs to the live session
                // in `agents` — if a newer turn has replaced `active_pid`, the
                // old exit is stale and we must not end the (now-new) session
                // row. Only set when we own the exit.
                let mut ended_own_session = false;
                if !got_init {
                    // Failed to initialize — clear the per-session Claude
                    // state so the next attempt starts fresh instead of
                    // trying --resume. Must be per-session (not
                    // workspace-scoped) because other tabs in this
                    // workspace may still be live.
                    agents.remove(&chat_session_id_for_stream);
                    if let Ok(db) = Database::open(&db_path) {
                        let _ = db.clear_chat_session_state(&chat_session_id_for_stream);
                        if let Some(ref sid) = ended_session_id {
                            let _ = db.end_agent_session(sid, false);
                        }
                    }
                } else if let Some(session) = agents.get_mut(&chat_session_id_for_stream)
                    && session.active_pid == Some(spawned_pid)
                {
                    // Only clear active_pid if it still matches the process that
                    // exited. A new turn may have already replaced it.
                    session.active_pid = None;
                    // Process died — clear persistent session so the next turn
                    // spawns a fresh one. Drop the agent-MCP bridge alongside
                    // (RAII unlinks the socket file) so a subsequent spawn
                    // gets a fresh socket + token rather than reusing a bridge
                    // whose grandchild is gone.
                    session.persistent_session = None;
                    session.mcp_bridge = None;
                    ended_own_session = true;
                }
                // Close out the agent_sessions row for post-init exits too, so
                // `active_sessions` doesn't inflate and `success_rate_30d`
                // doesn't silently drop crashed sessions. Only done when our
                // PID still owned the session (stale exits are left alone).
                if got_init
                    && ended_own_session
                    && let Some(ref sid) = ended_session_id
                    && !sid.is_empty()
                    && let Ok(db) = Database::open(&db_path)
                {
                    let completed_ok = exit_code == Some(0);
                    let _ = db.end_agent_session(sid, completed_ok);
                }
                // Metrics: final commit scrape on process exit. This catches
                // anything that wasn't captured by the per-turn `Result`-event
                // capture below — e.g. when the process dies mid-turn before
                // emitting a `Result`. Persistent sessions normally capture
                // via the `Result` path, since their subprocess never exits
                // between turns.
                if got_init && let Some(sid) = ended_session_id.as_deref() {
                    claudette::metrics::capture_session_commits(
                        &db_path,
                        &ws_id,
                        sid,
                        &repo_id_for_mcp,
                        &wt_path,
                    )
                    .await;
                }
                let needs_attention_now = agents
                    .get(&chat_session_id_for_stream)
                    .is_some_and(|s| s.needs_attention);
                let app_state = app.state::<crate::state::AppState>();
                if !needs_attention_now && !notified_via_result {
                    let event = if exit_code == Some(0) {
                        crate::tray::NotificationEvent::Finished
                    } else {
                        crate::tray::NotificationEvent::Error
                    };
                    fire_completion_notification(&db_path, &app_state.cesp_playback, event, &ws_id)
                        .await;
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
                    let taken_usage = latest_usage.take();
                    let msg = ChatMessage {
                        id: msg_id.clone(),
                        workspace_id: ws_id.clone(),
                        chat_session_id: chat_session_id_for_stream.clone(),
                        role: ChatRole::Assistant,
                        content: full_text,
                        cost_usd: None,
                        duration_ms: None,
                        created_at: now_iso(),
                        thinking: pending_thinking.take(),
                        input_tokens: taken_usage.as_ref().map(|u| u.input_tokens as i64),
                        output_tokens: taken_usage.as_ref().map(|u| u.output_tokens as i64),
                        cache_read_tokens: taken_usage
                            .as_ref()
                            .and_then(|u| u.cache_read_input_tokens.map(|n| n as i64)),
                        cache_creation_tokens: taken_usage
                            .as_ref()
                            .and_then(|u| u.cache_creation_input_tokens.map(|n| n as i64)),
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
                    chat_session_id: chat_session_id_for_stream.clone(),
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
                        "chat_session_id": &chat_session_id_for_stream,
                        "checkpoint": &cp_payload,
                    });
                    let _ = app.emit("checkpoint-created", &payload);
                }
            }

            let payload = AgentStreamPayload {
                workspace_id: ws_id.clone(),
                chat_session_id: chat_session_id_for_stream.clone(),
                event,
            };
            let _ = app.emit("agent-stream", &payload);
        }
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        RequestedFlags, SessionFlags, build_permission_response, persistent_session_flags_drifted,
    };

    fn s(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| (*v).to_string()).collect()
    }

    fn session<'a>(
        plan_mode: bool,
        allowed_tools: &'a [String],
        exited_plan: bool,
    ) -> SessionFlags<'a> {
        SessionFlags {
            plan_mode,
            allowed_tools,
            exited_plan,
            disable_1m_context: false,
        }
    }

    fn requested<'a>(plan_mode: bool, allowed_tools: &'a [String]) -> RequestedFlags<'a> {
        RequestedFlags {
            plan_mode,
            allowed_tools,
            disable_1m_context: false,
        }
    }

    #[test]
    fn no_drift_when_plan_mode_and_tools_match() {
        let tools = s(&["Read", "Write"]);
        assert!(!persistent_session_flags_drifted(
            session(false, &tools, false),
            requested(false, &tools),
        ));
    }

    #[test]
    fn drift_when_plan_mode_flips_off_after_approval() {
        // Session was spawned with --permission-mode plan; next turn is not.
        let tools = s(&["Read", "Write"]);
        assert!(persistent_session_flags_drifted(
            session(true, &tools, false),
            requested(false, &tools),
        ));
    }

    #[test]
    fn drift_when_plan_mode_flips_on() {
        let tools = s(&["Read"]);
        assert!(persistent_session_flags_drifted(
            session(false, &tools, false),
            requested(true, &tools),
        ));
    }

    #[test]
    fn drift_when_permission_level_changes() {
        let before = s(&["Read", "Glob"]);
        let after = s(&["Read", "Write", "Edit"]);
        assert!(persistent_session_flags_drifted(
            session(false, &before, false),
            requested(false, &after),
        ));
    }

    #[test]
    fn drift_when_allowed_tools_reordered() {
        // Strict equality: a different order counts as drift. Callers build
        // the list deterministically from the permission level, so any
        // observed diff signals a real configuration change.
        let before = s(&["Read", "Write"]);
        let after = s(&["Write", "Read"]);
        assert!(persistent_session_flags_drifted(
            session(false, &before, false),
            requested(false, &after),
        ));
    }

    #[test]
    fn no_drift_when_wildcard_unchanged() {
        // Permission level "full" resolves to the wildcard sentinel; reusing
        // the same bypass-permissions session should not trigger a respawn.
        let full = s(&["*"]);
        assert!(!persistent_session_flags_drifted(
            session(false, &full, false),
            requested(false, &full),
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
            session(false, &standard, false),
            requested(false, &full),
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
            session(false, &full, false),
            requested(false, &readonly),
        ));
    }

    #[test]
    fn drift_when_session_exited_plan_even_if_request_still_says_plan() {
        // Safety net: agent emitted ExitPlanMode so the plan phase is over.
        // Even if the frontend forgets to flip plan_mode=false on the next
        // turn (known bug class), the backend must still respawn so the CLI
        // no longer auto-denies mutating tools.
        let tools = s(&["Read", "Write"]);
        assert!(persistent_session_flags_drifted(
            session(true, &tools, true),
            requested(true, &tools),
        ));
    }

    #[test]
    fn no_drift_when_exited_plan_but_session_never_had_plan() {
        // Nonsense state defensively handled: if session_plan_mode is false
        // the exited-plan flag is irrelevant and should not trigger drift.
        let tools = s(&["Read"]);
        assert!(!persistent_session_flags_drifted(
            session(false, &tools, true),
            requested(false, &tools),
        ));
    }

    #[test]
    fn drift_when_disable_1m_context_flips() {
        // Switching between a 200k model SKU (disable_1m_context=true) and a
        // 1M SKU (false) must respawn: CLAUDE_CODE_DISABLE_1M_CONTEXT is baked
        // into the subprocess env at spawn and cannot be changed per-turn.
        let tools = s(&["Read", "Write"]);
        assert!(persistent_session_flags_drifted(
            SessionFlags {
                plan_mode: false,
                allowed_tools: &tools,
                exited_plan: false,
                disable_1m_context: false,
            },
            RequestedFlags {
                plan_mode: false,
                allowed_tools: &tools,
                disable_1m_context: true,
            },
        ));
        assert!(persistent_session_flags_drifted(
            SessionFlags {
                plan_mode: false,
                allowed_tools: &tools,
                exited_plan: false,
                disable_1m_context: true,
            },
            RequestedFlags {
                plan_mode: false,
                allowed_tools: &tools,
                disable_1m_context: false,
            },
        ));
    }

    #[test]
    fn no_drift_when_disable_1m_context_matches() {
        let tools = s(&["Read"]);
        assert!(!persistent_session_flags_drifted(
            SessionFlags {
                plan_mode: false,
                allowed_tools: &tools,
                exited_plan: false,
                disable_1m_context: true,
            },
            RequestedFlags {
                plan_mode: false,
                allowed_tools: &tools,
                disable_1m_context: true,
            },
        ));
    }

    use serde_json::json;

    #[test]
    fn permission_response_allows_bypass_session_non_plan() {
        let input = json!({ "path": "/tmp/foo" });
        let response = build_permission_response(&s(&["*"]), false, false, "Skill", &input);
        assert_eq!(response["behavior"], "allow");
        assert_eq!(response["updatedInput"], input);
    }

    #[test]
    fn permission_response_denies_bypass_session_during_active_plan() {
        let input = json!({});
        let response = build_permission_response(&s(&["*"]), true, false, "Edit", &input);
        assert_eq!(response["behavior"], "deny");
    }

    #[test]
    fn permission_response_allows_bypass_session_after_plan_exit() {
        // The agent emitted ExitPlanMode and the user approved, so the plan
        // phase is over. The subprocess still has --permission-mode plan
        // until the next turn's drift detection respawns it, but within
        // this turn we should auto-allow because the user chose bypass.
        let input = json!({ "file_path": "/tmp/fib.py", "content": "..." });
        let response = build_permission_response(&s(&["*"]), true, true, "Write", &input);
        assert_eq!(response["behavior"], "allow");
        assert_eq!(response["updatedInput"], input);
    }

    #[test]
    fn permission_response_denies_standard_session() {
        let input = json!({});
        let response =
            build_permission_response(&s(&["Read", "Write"]), false, false, "Edit", &input);
        assert_eq!(response["behavior"], "deny");
        let msg = response["message"].as_str().expect("message");
        assert!(
            msg.contains("full"),
            "message should name the escalation: {msg}"
        );
        assert!(
            msg.contains("/permissions"),
            "message should point at the slash command: {msg}"
        );
    }

    #[test]
    fn permission_response_denies_standard_session_after_plan_exit() {
        // Non-bypass sessions should still deny after ExitPlanMode — they
        // need the drift-triggered respawn to pick up the concrete
        // --allowedTools list, and auto-allowing any tool would exceed the
        // user's chosen permission scope.
        let input = json!({});
        let response =
            build_permission_response(&s(&["Read", "Write"]), true, true, "Bash", &input);
        assert_eq!(response["behavior"], "deny");
    }

    #[test]
    fn permission_response_denies_empty_session() {
        let input = json!({});
        let response = build_permission_response(&[], false, false, "Edit", &input);
        assert_eq!(response["behavior"], "deny");
    }

    #[test]
    fn permission_response_rejects_multi_element_wildcard() {
        let input = json!({});
        let response = build_permission_response(&s(&["*", "Read"]), false, false, "Edit", &input);
        assert_eq!(response["behavior"], "deny");
    }
}
