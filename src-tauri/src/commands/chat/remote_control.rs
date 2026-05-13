use std::sync::Arc;

use claudette::agent::{
    AgentEvent, AgentSettings, PersistentSession, StreamEvent, TokenUsage, UserContentBlock,
    UserEventMessage, UserMessageContent,
};
use claudette::chat::{
    BuildAssistantArgs, CheckpointArgs, assistant_usage_fields_from_result,
    build_assistant_chat_message, create_turn_checkpoint, extract_assistant_text,
    extract_event_thinking,
};
use claudette::db::Database;
use claudette::env::WorkspaceEnv;
use claudette::model::{ChatMessage, ChatRole, ChatSession, Workspace};
use claudette::permissions::tools_for_level;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::state::{
    AgentSessionState, AppState, ClaudeRemoteControlLifecycle, ClaudeRemoteControlStatus,
};

use super::{
    AgentStreamPayload, build_agent_hook_bridge, now_iso, start_bridge_and_inject_mcp,
    start_chat_bridge,
};

const CLAUDE_REMOTE_CONTROL_ENABLED_KEY: &str = "claude_remote_control_enabled";

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteChatTurnStartedPayload<'a> {
    workspace_id: &'a str,
    chat_session_id: &'a str,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeRemoteControlStatusPayload {
    workspace_id: String,
    chat_session_id: String,
    status: ClaudeRemoteControlStatus,
}

#[derive(Debug, Clone, Default)]
struct RemoteControlLaunchOptions {
    permission_level: Option<String>,
    model: Option<String>,
    fast_mode: Option<bool>,
    thinking_enabled: Option<bool>,
    plan_mode: Option<bool>,
    effort: Option<String>,
    chrome_enabled: Option<bool>,
    disable_1m_context: Option<bool>,
    backend_id: Option<String>,
}

#[tauri::command]
pub async fn get_claude_remote_control_status(
    chat_session_id: String,
    state: State<'_, AppState>,
) -> Result<ClaudeRemoteControlStatus, String> {
    if !remote_control_feature_enabled(&state)? {
        return Ok(ClaudeRemoteControlStatus::disabled());
    }
    let agents = state.agents.read().await;
    Ok(agents
        .get(&chat_session_id)
        .map(|session| session.claude_remote_control.clone())
        .unwrap_or_else(ClaudeRemoteControlStatus::disabled))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn set_claude_remote_control(
    chat_session_id: String,
    enabled: bool,
    permission_level: Option<String>,
    model: Option<String>,
    fast_mode: Option<bool>,
    thinking_enabled: Option<bool>,
    plan_mode: Option<bool>,
    effort: Option<String>,
    chrome_enabled: Option<bool>,
    disable_1m_context: Option<bool>,
    backend_id: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ClaudeRemoteControlStatus, String> {
    if enabled && !remote_control_feature_enabled(&state)? {
        return Err("Claude Remote Control is disabled in Experimental settings".to_string());
    }

    let launch_options = RemoteControlLaunchOptions {
        permission_level,
        model,
        fast_mode,
        thinking_enabled,
        plan_mode,
        effort,
        chrome_enabled,
        disable_1m_context,
        backend_id,
    };
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let chat_session = db
        .get_chat_session(&chat_session_id)
        .map_err(|e| e.to_string())?
        .ok_or("Chat session not found")?;
    let workspace_id = chat_session.workspace_id.clone();
    let workspace = db
        .list_workspaces()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|ws| ws.id == workspace_id)
        .ok_or("Workspace not found")?;
    let worktree_path = workspace
        .worktree_path
        .clone()
        .ok_or("Workspace has no worktree")?;
    drop(db);

    let (ps, pid) = if enabled {
        if let Some((ps, pid)) = existing_persistent_session(&state, &chat_session_id).await {
            let enabling = ClaudeRemoteControlStatus {
                state: ClaudeRemoteControlLifecycle::Enabling,
                detail: Some("Starting Claude Remote Control.".to_string()),
                last_error: None,
                ..get_stored_status(&state, &chat_session_id).await
            };
            store_remote_control_status(&app, &state, &workspace_id, &chat_session_id, enabling)
                .await;
            (ps, pid)
        } else if should_defer_enable_until_first_turn(&chat_session) {
            let status = store_deferred_enable_status(
                &app,
                &state,
                &workspace_id,
                &chat_session_id,
                chat_session.turn_count,
            )
            .await;
            return Ok(status);
        } else {
            ensure_persistent_session_for_remote_control(
                &app,
                &state,
                &state.db_path,
                &chat_session,
                &workspace,
                &worktree_path,
                launch_options,
            )
            .await?
        }
    } else {
        let Some((ps, pid)) = existing_persistent_session(&state, &chat_session_id).await else {
            let disabled = ClaudeRemoteControlStatus::disabled();
            store_remote_control_status(&app, &state, &workspace_id, &chat_session_id, disabled)
                .await;
            return Ok(get_stored_status(&state, &chat_session_id).await);
        };
        (ps, pid)
    };

    if enabled && should_pin_title_before_control_request(&chat_session) {
        let title_messages = {
            let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
            db.list_chat_messages_for_session(&chat_session_id)
                .unwrap_or_default()
        };
        let title = remote_control_title(&chat_session, &workspace, &title_messages);
        let session_id = {
            let agents = state.agents.read().await;
            agents
                .get(&chat_session_id)
                .map(|session| session.session_id.clone())
                .unwrap_or_default()
        };
        if let Err(err) =
            claudette::agent::persist_claude_custom_title(&worktree_path, &session_id, &title)
        {
            tracing::warn!(target: "claudette::remote", error = %err, "failed to pin Claude session title");
        }
        emit_remote_control_status(&app, &workspace_id, &chat_session_id, &state).await;
    }

    match ps.set_remote_control(enabled).await {
        Ok(response) => {
            let status = if enabled {
                status_from_control_response(response.response.as_ref())
            } else {
                ClaudeRemoteControlStatus::disabled()
            };
            store_remote_control_status(&app, &state, &workspace_id, &chat_session_id, status)
                .await;
            if enabled {
                ensure_remote_control_monitor(
                    app.clone(),
                    state.db_path.clone(),
                    workspace_id.clone(),
                    chat_session_id.clone(),
                    worktree_path,
                    pid,
                    ps,
                )
                .await;
            }
            Ok(get_stored_status(&state, &chat_session_id).await)
        }
        Err(err) => {
            let status = ClaudeRemoteControlStatus {
                state: ClaudeRemoteControlLifecycle::Error,
                session_url: None,
                connect_url: None,
                environment_id: None,
                detail: None,
                last_error: Some(err.clone()),
            };
            store_remote_control_status(&app, &state, &workspace_id, &chat_session_id, status)
                .await;
            Err(err)
        }
    }
}

fn remote_control_feature_enabled_from_value(value: Option<&str>) -> bool {
    value != Some("false")
}

fn remote_control_feature_enabled(state: &State<'_, AppState>) -> Result<bool, String> {
    remote_control_feature_enabled_for_db_path(&state.db_path)
}

pub(super) fn remote_control_feature_enabled_for_db_path(
    db_path: &std::path::Path,
) -> Result<bool, String> {
    let db = Database::open(db_path).map_err(|e| e.to_string())?;
    let value = db
        .get_app_setting(CLAUDE_REMOTE_CONTROL_ENABLED_KEY)
        .map_err(|e| e.to_string())?;
    Ok(remote_control_feature_enabled_from_value(value.as_deref()))
}

fn should_defer_enable_until_first_turn(chat_session: &ChatSession) -> bool {
    chat_session.turn_count == 0
}

fn should_pin_title_before_control_request(chat_session: &ChatSession) -> bool {
    chat_session.turn_count > 0
}

fn first_user_message_text(messages: &[ChatMessage]) -> Option<String> {
    messages.iter().find_map(|message| {
        if message.role == ChatRole::User {
            let text = message
                .content
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            (!text.is_empty()).then_some(text)
        } else {
            None
        }
    })
}

fn remote_control_title(
    chat_session: &ChatSession,
    workspace: &Workspace,
    messages: &[ChatMessage],
) -> String {
    let name = chat_session.name.trim();
    if !name.is_empty() && name != "New chat" {
        return name.to_string();
    }
    if let Some(first_user_text) = first_user_message_text(messages) {
        return first_user_text.chars().take(75).collect();
    }
    workspace.name.clone()
}

async fn existing_persistent_session(
    state: &State<'_, AppState>,
    chat_session_id: &str,
) -> Option<(Arc<PersistentSession>, u32)> {
    let agents = state.agents.read().await;
    let ps = agents.get(chat_session_id)?.persistent_session.clone()?;
    let pid = ps.pid();
    Some((ps, pid))
}

async fn store_deferred_enable_status(
    app: &AppHandle,
    state: &State<'_, AppState>,
    workspace_id: &str,
    chat_session_id: &str,
    turn_count: u32,
) -> ClaudeRemoteControlStatus {
    let status = ClaudeRemoteControlStatus {
        state: ClaudeRemoteControlLifecycle::Enabling,
        session_url: None,
        connect_url: None,
        environment_id: None,
        detail: Some("Send your first message to start Claude Remote Control.".to_string()),
        last_error: None,
    };
    {
        let mut agents = state.agents.write().await;
        let session = agents
            .entry(chat_session_id.to_string())
            .or_insert_with(|| AgentSessionState {
                workspace_id: workspace_id.to_string(),
                session_id: String::new(),
                turn_count,
                active_pid: None,
                custom_instructions: None,
                needs_attention: false,
                attention_kind: None,
                attention_notification_sent: false,
                persistent_session: None,
                claude_remote_control: ClaudeRemoteControlStatus::disabled(),
                claude_remote_control_monitor_pid: None,
                local_user_message_uuids: Default::default(),
                mcp_config_dirty: false,
                session_plan_mode: false,
                session_allowed_tools: Vec::new(),
                session_disable_1m_context: false,
                session_backend_hash: String::new(),
                pending_permissions: std::collections::HashMap::new(),
                running_background_tasks: std::collections::HashSet::new(),
                background_wake_active: false,
                session_exited_plan: false,
                session_resolved_env: Default::default(),
                session_resolved_env_signature: String::new(),
                mcp_bridge: None,
                last_user_msg_id: None,
                posted_env_trust_warning: false,
            });
        session.workspace_id = workspace_id.to_string();
        session.turn_count = turn_count;
        session.claude_remote_control = status.clone();
    }
    emit_remote_control_status(app, workspace_id, chat_session_id, state).await;
    status
}

async fn ensure_persistent_session_for_remote_control(
    app: &AppHandle,
    state: &State<'_, AppState>,
    db_path: &std::path::Path,
    chat_session: &ChatSession,
    workspace: &Workspace,
    worktree_path: &str,
    launch_options: RemoteControlLaunchOptions,
) -> Result<(Arc<PersistentSession>, u32), String> {
    let chat_session_id = chat_session.id.clone();
    let workspace_id = chat_session.workspace_id.clone();
    {
        let mut agents = state.agents.write().await;
        if let Some(session) = agents.get_mut(&chat_session_id) {
            session.claude_remote_control = ClaudeRemoteControlStatus {
                state: ClaudeRemoteControlLifecycle::Enabling,
                detail: Some("Starting Claude Remote Control.".to_string()),
                last_error: None,
                ..session.claude_remote_control.clone()
            };
            if let Some(ps) = session.persistent_session.clone() {
                let pid = ps.pid();
                return Ok((ps, pid));
            }
        }
    }

    emit_remote_control_status(app, &workspace_id, &chat_session_id, state).await;

    let repo = {
        let db = Database::open(db_path).map_err(|e| e.to_string())?;
        db.get_repository(&workspace.repository_id)
            .map_err(|e| e.to_string())?
    };
    let repo_path = repo.as_ref().map(|r| r.path.as_str()).unwrap_or("");
    let default_branch = match repo.as_ref().and_then(|r| r.base_branch.as_deref()) {
        Some(branch) => branch.to_string(),
        None => claudette::git::default_branch(
            repo_path,
            repo.as_ref().and_then(|r| r.default_remote.as_deref()),
        )
        .await
        .unwrap_or_else(|_| "main".to_string()),
    };
    let ws_env = WorkspaceEnv::from_workspace(workspace, repo_path, default_branch);
    let ws_info_for_env = claudette::plugin_runtime::host_api::WorkspaceInfo {
        id: workspace.id.clone(),
        name: workspace.name.clone(),
        branch: workspace.branch_name.clone(),
        worktree_path: worktree_path.to_string(),
        repo_path: repo_path.to_string(),
        repo_id: repo.as_ref().map(|r| r.id.clone()),
    };
    let disabled_env_providers = {
        let db = Database::open(db_path).map_err(|e| e.to_string())?;
        crate::commands::env::load_disabled_providers(
            &db,
            repo.as_ref().map_or("", |r| r.id.as_str()),
        )
    };
    let resolved_env = {
        // Snapshot — see `plugins_snapshot` doc.
        let registry = state.plugins_snapshot().await;
        let progress = crate::commands::env::TauriEnvProgressSink::new(
            app.clone(),
            ws_info_for_env.id.clone(),
        );
        claudette::env_provider::resolve_with_registry_and_progress(
            &registry,
            &state.env_cache,
            std::path::Path::new(worktree_path),
            &ws_info_for_env,
            &disabled_env_providers,
            Some(&progress),
        )
        .await
    };
    crate::commands::env::register_resolved_with_watcher(
        state,
        std::path::Path::new(worktree_path),
        &resolved_env.sources,
    )
    .await;

    let db_rows = {
        let db = Database::open(db_path).map_err(|e| e.to_string())?;
        db.list_repository_mcp_servers(&workspace.repository_id)
            .map_err(|e| e.to_string())?
    };
    let mcp_config = claudette::mcp::cli_config_from_rows(&db_rows);
    let (send_to_user_enabled, team_agent_session_tabs_enabled) = {
        let db = Database::open(db_path).map_err(|e| e.to_string())?;
        (
            claudette::agent_mcp::is_builtin_plugin_enabled(&db, "send_to_user"),
            super::send::team_agent_session_tabs_enabled(&db),
        )
    };
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
    let nudge = send_to_user_enabled.then_some(claudette::agent_mcp::SYSTEM_PROMPT_NUDGE);
    let custom_instructions =
        claudette::global_prompt::compose_system_prompt(instructions.as_deref(), nudge);
    let level = launch_options.permission_level.as_deref().unwrap_or("full");
    if !matches!(level, "readonly" | "standard" | "full") {
        tracing::warn!(
            target: "claudette::remote",
            level = %level,
            "unknown permission level — falling back to readonly"
        );
    }
    let allowed_tools = tools_for_level(level);
    let (resolved_backend_id, resolved_model) = {
        let db = Database::open(db_path).map_err(|e| e.to_string())?;
        crate::commands::agent_backends::resolve_backend_request_defaults(
            &db,
            launch_options.backend_id.as_deref(),
            launch_options.model.as_deref(),
        )?
    };
    let backend_runtime = crate::commands::agent_backends::resolve_backend_runtime(
        state,
        resolved_backend_id.as_deref(),
        resolved_model.as_deref(),
    )
    .await?;
    let extra_claude_flags = {
        let db = Database::open(db_path).map_err(|e| e.to_string())?;
        let guard = state.claude_flag_defs.read().await;
        match &*guard {
            crate::state::ClaudeFlagDiscovery::Ok(defs) => {
                match claudette::claude_flags_store::resolve_for_repo(
                    &db,
                    defs,
                    Some(workspace.repository_id.as_str()),
                ) {
                    Ok(v) => v,
                    Err(e) => {
                        tracing::warn!(
                            target: "claudette::remote",
                            repo_id = %workspace.repository_id,
                            error = %e,
                            "failed to resolve claude flags"
                        );
                        Vec::new()
                    }
                }
            }
            crate::state::ClaudeFlagDiscovery::Err(msg) => {
                tracing::warn!(target: "claudette::remote", error = %msg, "claude flag discovery failed");
                Vec::new()
            }
            crate::state::ClaudeFlagDiscovery::Loading => Vec::new(),
        }
    };
    let mut agent_settings = AgentSettings {
        model: resolved_model,
        fast_mode: launch_options.fast_mode.unwrap_or(false),
        thinking_enabled: launch_options.thinking_enabled.unwrap_or(false),
        plan_mode: launch_options.plan_mode.unwrap_or(false),
        effort: launch_options.effort,
        chrome_enabled: launch_options.chrome_enabled.unwrap_or(false),
        mcp_config,
        disable_1m_context: launch_options.disable_1m_context.unwrap_or(false),
        team_agent_session_tabs_enabled,
        backend_runtime,
        hook_bridge: None,
        extra_claude_flags,
    };
    let bridge = if send_to_user_enabled {
        let (bridge, mcp_with_claudette) = start_bridge_and_inject_mcp(
            app,
            &state.db_path,
            &workspace_id,
            &chat_session_id,
            agent_settings.mcp_config.clone(),
        )
        .await?;
        agent_settings.mcp_config = mcp_with_claudette;
        bridge
    } else {
        start_chat_bridge(app, &state.db_path, &workspace_id, &chat_session_id).await?
    };
    agent_settings.hook_bridge = Some(build_agent_hook_bridge(&bridge)?);

    let persisted_sid = chat_session
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|sid| !sid.is_empty())
        .map(ToOwned::to_owned);
    let is_resume = persisted_sid.is_some();
    let claude_session_id = persisted_sid.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let ps = PersistentSession::start(
        std::path::Path::new(worktree_path),
        &claude_session_id,
        is_resume,
        &allowed_tools,
        custom_instructions.as_deref(),
        &agent_settings,
        Some(&ws_env),
        Some(&resolved_env),
    )
    .await
    .map_err(|err| crate::missing_cli::handle_err(app, &err).unwrap_or(err))?;
    let ps = Arc::new(ps);
    let pid = ps.pid();

    {
        let mut agents = state.agents.write().await;
        let session = agents
            .entry(chat_session_id.clone())
            .or_insert_with(|| AgentSessionState {
                workspace_id: workspace_id.clone(),
                session_id: claude_session_id.clone(),
                turn_count: chat_session.turn_count,
                active_pid: None,
                custom_instructions: instructions.clone(),
                needs_attention: false,
                attention_kind: None,
                attention_notification_sent: false,
                persistent_session: None,
                claude_remote_control: ClaudeRemoteControlStatus::disabled(),
                claude_remote_control_monitor_pid: None,
                local_user_message_uuids: Default::default(),
                mcp_config_dirty: false,
                session_plan_mode: false,
                session_allowed_tools: Vec::new(),
                session_disable_1m_context: false,
                session_backend_hash: String::new(),
                pending_permissions: std::collections::HashMap::new(),
                running_background_tasks: std::collections::HashSet::new(),
                background_wake_active: false,
                session_exited_plan: false,
                session_resolved_env: Default::default(),
                session_resolved_env_signature: String::new(),
                mcp_bridge: None,
                last_user_msg_id: None,
                posted_env_trust_warning: false,
            });
        session.workspace_id = workspace_id.clone();
        session.session_id = claude_session_id.clone();
        session.custom_instructions = instructions;
        session.persistent_session = Some(ps.clone());
        session.mcp_bridge = Some(bridge);
        session.claude_remote_control = ClaudeRemoteControlStatus {
            state: ClaudeRemoteControlLifecycle::Enabling,
            detail: Some("Starting Claude Remote Control.".to_string()),
            last_error: None,
            ..session.claude_remote_control.clone()
        };
        session.claude_remote_control_monitor_pid = None;
        session.session_plan_mode = agent_settings.plan_mode;
        session.session_allowed_tools = allowed_tools.clone();
        session.session_disable_1m_context = agent_settings.disable_1m_context;
        session.session_backend_hash = agent_settings.backend_runtime.hash.clone();
        session.session_exited_plan = false;
        session.session_resolved_env = resolved_env.vars.clone();
        session.session_resolved_env_signature = resolved_env.source_signature();
    }
    if let Ok(db) = Database::open(db_path) {
        let _ = db.save_chat_session_state(
            &chat_session_id,
            &claude_session_id,
            chat_session.turn_count,
        );
        let _ =
            db.insert_agent_session(&claude_session_id, &workspace_id, &workspace.repository_id);
        let _ = db.reopen_agent_session(&claude_session_id);
        let _ = db.update_agent_session_turn(&claude_session_id, chat_session.turn_count);
    }
    Ok((ps, pid))
}

async fn get_stored_status(
    state: &State<'_, AppState>,
    chat_session_id: &str,
) -> ClaudeRemoteControlStatus {
    let agents = state.agents.read().await;
    agents
        .get(chat_session_id)
        .map(|session| session.claude_remote_control.clone())
        .unwrap_or_else(ClaudeRemoteControlStatus::disabled)
}

async fn store_remote_control_status(
    app: &AppHandle,
    state: &State<'_, AppState>,
    workspace_id: &str,
    chat_session_id: &str,
    status: ClaudeRemoteControlStatus,
) {
    {
        let mut agents = state.agents.write().await;
        if let Some(session) = agents.get_mut(chat_session_id) {
            session.claude_remote_control = status;
        }
    }
    emit_remote_control_status(app, workspace_id, chat_session_id, state).await;
}

#[allow(clippy::too_many_arguments)]
pub(super) fn reenable_remote_control_after_respawn(
    app: AppHandle,
    db_path: std::path::PathBuf,
    workspace_id: String,
    chat_session_id: String,
    worktree_path: String,
    pid: u32,
    ps: Arc<PersistentSession>,
    title: String,
) {
    tokio::spawn(async move {
        let state = app.state::<AppState>();
        let enabling = ClaudeRemoteControlStatus {
            state: ClaudeRemoteControlLifecycle::Enabling,
            ..get_stored_status(&state, &chat_session_id).await
        };
        store_remote_control_status(&app, &state, &workspace_id, &chat_session_id, enabling).await;
        let session_id = {
            let agents = state.agents.read().await;
            agents
                .get(&chat_session_id)
                .map(|session| session.session_id.clone())
                .unwrap_or_default()
        };
        if let Err(err) =
            claudette::agent::persist_claude_custom_title(&worktree_path, &session_id, &title)
        {
            tracing::warn!(target: "claudette::remote", error = %err, "failed to pin Claude session title");
        }

        match ps.set_remote_control(true).await {
            Ok(response) => {
                if matches!(
                    get_stored_status(&state, &chat_session_id).await.state,
                    ClaudeRemoteControlLifecycle::Disabled
                ) {
                    return;
                }
                let status = status_from_control_response(response.response.as_ref());
                store_remote_control_status(&app, &state, &workspace_id, &chat_session_id, status)
                    .await;
                ensure_remote_control_monitor(
                    app,
                    db_path,
                    workspace_id,
                    chat_session_id,
                    worktree_path,
                    pid,
                    ps,
                )
                .await;
            }
            Err(err) => {
                if matches!(
                    get_stored_status(&state, &chat_session_id).await.state,
                    ClaudeRemoteControlLifecycle::Disabled
                ) {
                    return;
                }
                let status = ClaudeRemoteControlStatus {
                    state: ClaudeRemoteControlLifecycle::Error,
                    session_url: None,
                    connect_url: None,
                    environment_id: None,
                    detail: None,
                    last_error: Some(err),
                };
                store_remote_control_status(&app, &state, &workspace_id, &chat_session_id, status)
                    .await;
            }
        }
    });
}

async fn emit_remote_control_status(
    app: &AppHandle,
    workspace_id: &str,
    chat_session_id: &str,
    state: &State<'_, AppState>,
) {
    let status = get_stored_status(state, chat_session_id).await;
    let payload = ClaudeRemoteControlStatusPayload {
        workspace_id: workspace_id.to_string(),
        chat_session_id: chat_session_id.to_string(),
        status,
    };
    let _ = app.emit("claude-remote-control-status", &payload);
}

fn status_from_control_response(response: Option<&serde_json::Value>) -> ClaudeRemoteControlStatus {
    ClaudeRemoteControlStatus {
        state: ClaudeRemoteControlLifecycle::Ready,
        session_url: response.and_then(|v| url_field(v, "session_url")),
        connect_url: response.and_then(|v| connect_url_field(v, "connect_url")),
        environment_id: response.and_then(|v| non_empty_string_field(v, "environment_id")),
        detail: None,
        last_error: None,
    }
}

fn non_empty_string_field(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned)
}

fn url_field(value: &serde_json::Value, key: &str) -> Option<String> {
    non_empty_string_field(value, key)
}

fn connect_url_field(value: &serde_json::Value, key: &str) -> Option<String> {
    let url = non_empty_string_field(value, key)?;
    if has_empty_bridge_query(&url) {
        return None;
    }
    Some(url)
}

fn has_empty_bridge_query(raw_url: &str) -> bool {
    let Ok(url) = url::Url::parse(raw_url) else {
        return false;
    };
    url.query_pairs()
        .any(|(key, value)| matches!(key.as_ref(), "bridge" | "environment") && value.is_empty())
}

async fn ensure_remote_control_monitor(
    app: AppHandle,
    db_path: std::path::PathBuf,
    workspace_id: String,
    chat_session_id: String,
    worktree_path: String,
    pid: u32,
    ps: Arc<PersistentSession>,
) {
    let app_state = app.state::<AppState>();
    {
        let mut agents = app_state.agents.write().await;
        let Some(session) = agents.get_mut(&chat_session_id) else {
            return;
        };
        if session.claude_remote_control_monitor_pid == Some(pid) {
            return;
        }
        session.claude_remote_control_monitor_pid = Some(pid);
    }

    tokio::spawn(async move {
        let mut rx = ps.subscribe();
        let mut remote_turn_active = false;
        let mut remote_user_msg_id: Option<String> = None;
        let mut last_assistant_msg_id: Option<String> = None;
        let mut pending_thinking: Option<String> = None;
        let mut latest_usage: Option<TokenUsage> = None;

        loop {
            let event = match rx.recv().await {
                Ok(event) => event,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            };
            if !remote_control_feature_enabled_for_db_path(&db_path).unwrap_or(false) {
                let _ = ps.set_remote_control(false).await;
                clear_monitor_when_feature_disabled(&app, &workspace_id, &chat_session_id, pid)
                    .await;
                break;
            }

            if let AgentEvent::Stream(StreamEvent::System {
                subtype,
                state,
                detail,
                ..
            }) = &event
                && subtype == "bridge_state"
            {
                update_status_from_bridge_state(
                    &app,
                    &workspace_id,
                    &chat_session_id,
                    pid,
                    state.as_deref(),
                    detail.as_deref(),
                )
                .await;
            }

            if let AgentEvent::ProcessExited(_) = &event {
                clear_monitor_on_exit(&app, &workspace_id, &chat_session_id, pid).await;
                if remote_turn_active {
                    emit_agent_stream(&app, &workspace_id, &chat_session_id, event);
                }
                break;
            }

            if !remote_turn_active {
                if let AgentEvent::Stream(StreamEvent::User {
                    uuid: Some(uuid), ..
                }) = &event
                {
                    match take_local_user_message_uuid(&app, &chat_session_id, pid, uuid).await {
                        LocalUserMessageReplay::Local => continue,
                        LocalUserMessageReplay::RemoteOrUnknown => {}
                        LocalUserMessageReplay::Stale => break,
                    }
                }
                match remote_monitor_turn_gate(&app, &chat_session_id, pid).await {
                    RemoteMonitorTurnGate::Idle => {}
                    RemoteMonitorTurnGate::Busy => continue,
                    RemoteMonitorTurnGate::Stale => break,
                }
                let AgentEvent::Stream(StreamEvent::User {
                    message,
                    is_synthetic: false,
                    ..
                }) = &event
                else {
                    continue;
                };
                let Some(text) = user_visible_text(message) else {
                    continue;
                };
                if text.trim().is_empty() {
                    continue;
                }
                let msg = ChatMessage {
                    id: uuid::Uuid::new_v4().to_string(),
                    workspace_id: workspace_id.clone(),
                    chat_session_id: chat_session_id.clone(),
                    role: ChatRole::User,
                    content: text,
                    cost_usd: None,
                    duration_ms: None,
                    created_at: now_iso(),
                    thinking: None,
                    input_tokens: None,
                    output_tokens: None,
                    cache_read_tokens: None,
                    cache_creation_tokens: None,
                };
                if let Ok(db) = Database::open(&db_path) {
                    let _ = db.insert_chat_message(&msg);
                }
                {
                    let app_state = app.state::<AppState>();
                    let mut agents = app_state.agents.write().await;
                    if let Some(session) = agents.get_mut(&chat_session_id) {
                        session.active_pid = Some(pid);
                        session.turn_count = session.turn_count.saturating_add(1);
                        session.last_user_msg_id = Some(msg.id.clone());
                        if let Ok(db) = Database::open(&db_path) {
                            let _ = db.save_chat_session_state(
                                &chat_session_id,
                                &session.session_id,
                                session.turn_count,
                            );
                            let _ = db
                                .update_agent_session_turn(&session.session_id, session.turn_count);
                        }
                    }
                }
                let _ = app.emit("chat-message", &msg);
                let _ = app.emit(
                    "chat-turn-started",
                    &RemoteChatTurnStartedPayload {
                        workspace_id: &workspace_id,
                        chat_session_id: &chat_session_id,
                    },
                );
                crate::tray::rebuild_tray(&app);
                remote_turn_active = true;
                remote_user_msg_id = Some(msg.id);
            }

            if let AgentEvent::Stream(StreamEvent::Stream {
                event: claudette::agent::InnerStreamEvent::MessageDelta { usage: Some(u) },
            }) = &event
            {
                latest_usage = Some(u.clone());
            }

            if let AgentEvent::Stream(StreamEvent::System {
                subtype,
                compact_metadata: Some(meta),
                ..
            }) = &event
                && subtype == "compact_boundary"
                && let Ok(db) = Database::open(&db_path)
            {
                let msg = claudette::chat::build_compaction_sentinel(
                    &workspace_id,
                    &chat_session_id,
                    meta,
                    now_iso(),
                );
                let _ = db.insert_chat_message(&msg);
            }

            if let AgentEvent::Stream(StreamEvent::User {
                message,
                is_synthetic: true,
                ..
            }) = &event
                && let UserMessageContent::Text(body) = &message.content
                && let Ok(db) = Database::open(&db_path)
            {
                let msg = ChatMessage {
                    id: uuid::Uuid::new_v4().to_string(),
                    workspace_id: workspace_id.clone(),
                    chat_session_id: chat_session_id.clone(),
                    role: ChatRole::System,
                    content: format!("SYNTHETIC_SUMMARY:\n{body}"),
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

            if let AgentEvent::Stream(StreamEvent::Assistant { message }) = &event {
                let full_text = extract_assistant_text(message);
                if let Some(t) = extract_event_thinking(message) {
                    pending_thinking = Some(match pending_thinking.take() {
                        Some(mut existing) => {
                            existing.push_str(&t);
                            existing
                        }
                        None => t,
                    });
                }
                if !full_text.trim().is_empty()
                    && let Ok(db) = Database::open(&db_path)
                {
                    let msg = build_assistant_chat_message(BuildAssistantArgs {
                        workspace_id: &workspace_id,
                        chat_session_id: &chat_session_id,
                        content: full_text,
                        thinking: pending_thinking.take(),
                        usage: latest_usage.take(),
                        created_at: now_iso(),
                    });
                    let msg_id = msg.id.clone();
                    if db.insert_chat_message(&msg).is_ok() {
                        last_assistant_msg_id = Some(msg_id);
                    }
                }
            }

            if let AgentEvent::Stream(StreamEvent::Result {
                total_cost_usd,
                duration_ms,
                usage,
                ..
            }) = &event
            {
                if let Ok(db) = Database::open(&db_path)
                    && let Some(ref msg_id) = last_assistant_msg_id
                {
                    if let Some(usage) = usage {
                        let usage = assistant_usage_fields_from_result(usage);
                        let _ = db.update_chat_message_usage_if_missing(
                            msg_id,
                            usage.input_tokens,
                            usage.output_tokens,
                            usage.cache_read_input_tokens,
                            usage.cache_creation_input_tokens,
                        );
                    }
                    if let (Some(cost), Some(dur)) = (total_cost_usd, duration_ms) {
                        let _ = db.update_chat_message_cost(msg_id, *cost, *dur);
                    }
                }

                let anchor_msg_id = last_assistant_msg_id
                    .as_deref()
                    .or(remote_user_msg_id.as_deref())
                    .unwrap_or("");
                if !anchor_msg_id.is_empty()
                    && let Some(cp) = create_turn_checkpoint(CheckpointArgs {
                        db_path: &db_path,
                        workspace_id: &workspace_id,
                        chat_session_id: &chat_session_id,
                        anchor_msg_id,
                        worktree_path: &worktree_path,
                        created_at: now_iso(),
                    })
                    .await
                {
                    let payload = serde_json::json!({
                        "workspace_id": &workspace_id,
                        "chat_session_id": &chat_session_id,
                        "checkpoint": &cp,
                    });
                    let _ = app.emit("checkpoint-created", &payload);
                }
            }

            let is_done = matches!(&event, AgentEvent::Stream(StreamEvent::Result { .. }));
            emit_agent_stream(&app, &workspace_id, &chat_session_id, event);

            if is_done {
                {
                    let app_state = app.state::<AppState>();
                    let mut agents = app_state.agents.write().await;
                    if let Some(session) = agents.get_mut(&chat_session_id)
                        && session.active_pid == Some(pid)
                    {
                        session.active_pid = None;
                    }
                }
                crate::tray::rebuild_tray(&app);
                remote_turn_active = false;
                remote_user_msg_id = None;
                last_assistant_msg_id = None;
                pending_thinking = None;
                latest_usage = None;
            }
        }
    });
}

enum RemoteMonitorTurnGate {
    Idle,
    Busy,
    Stale,
}

enum LocalUserMessageReplay {
    Local,
    RemoteOrUnknown,
    Stale,
}

async fn take_local_user_message_uuid(
    app: &AppHandle,
    chat_session_id: &str,
    pid: u32,
    uuid: &str,
) -> LocalUserMessageReplay {
    let app_state = app.state::<AppState>();
    let mut agents = app_state.agents.write().await;
    let Some(session) = agents.get_mut(chat_session_id) else {
        return LocalUserMessageReplay::Stale;
    };
    if session.claude_remote_control_monitor_pid != Some(pid)
        || session
            .persistent_session
            .as_ref()
            .is_none_or(|ps| ps.pid() != pid)
    {
        return LocalUserMessageReplay::Stale;
    }
    if session.take_local_user_message_uuid(uuid) {
        LocalUserMessageReplay::Local
    } else {
        LocalUserMessageReplay::RemoteOrUnknown
    }
}

async fn remote_monitor_turn_gate(
    app: &AppHandle,
    chat_session_id: &str,
    pid: u32,
) -> RemoteMonitorTurnGate {
    let app_state = app.state::<AppState>();
    let agents = app_state.agents.read().await;
    let Some(session) = agents.get(chat_session_id) else {
        return RemoteMonitorTurnGate::Stale;
    };
    if session.claude_remote_control_monitor_pid != Some(pid)
        || session
            .persistent_session
            .as_ref()
            .is_none_or(|ps| ps.pid() != pid)
    {
        return RemoteMonitorTurnGate::Stale;
    }
    if session.active_pid == Some(pid) {
        RemoteMonitorTurnGate::Busy
    } else {
        RemoteMonitorTurnGate::Idle
    }
}

fn user_visible_text(message: &UserEventMessage) -> Option<String> {
    match &message.content {
        UserMessageContent::Text(text) => Some(text.clone()),
        UserMessageContent::Blocks(blocks) => {
            let text = blocks
                .iter()
                .filter_map(|block| match block {
                    UserContentBlock::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n");
            (!text.is_empty()).then_some(text)
        }
    }
}

fn emit_agent_stream(
    app: &AppHandle,
    workspace_id: &str,
    chat_session_id: &str,
    event: AgentEvent,
) {
    let payload = AgentStreamPayload {
        workspace_id: workspace_id.to_string(),
        chat_session_id: chat_session_id.to_string(),
        event,
    };
    let _ = app.emit("agent-stream", &payload);
}

async fn update_status_from_bridge_state(
    app: &AppHandle,
    workspace_id: &str,
    chat_session_id: &str,
    pid: u32,
    bridge_state: Option<&str>,
    detail: Option<&str>,
) {
    let app_state = app.state::<AppState>();
    let status = {
        let mut agents = app_state.agents.write().await;
        let Some(session) = agents.get_mut(chat_session_id) else {
            return;
        };
        if session.claude_remote_control_monitor_pid != Some(pid) {
            return;
        }
        if matches!(
            session.claude_remote_control.state,
            ClaudeRemoteControlLifecycle::Disabled
        ) {
            return;
        }
        let next_state = match bridge_state.unwrap_or_default() {
            "connected" => ClaudeRemoteControlLifecycle::Connected,
            "reconnecting" | "retrying" => ClaudeRemoteControlLifecycle::Reconnecting,
            "error" | "failed" => ClaudeRemoteControlLifecycle::Error,
            "ready" | "listening" | "initialized" => ClaudeRemoteControlLifecycle::Ready,
            _ => session.claude_remote_control.state,
        };
        session.claude_remote_control.state = next_state;
        session.claude_remote_control.detail = detail.map(ToOwned::to_owned);
        if next_state != ClaudeRemoteControlLifecycle::Error {
            session.claude_remote_control.last_error = None;
        } else if session.claude_remote_control.last_error.is_none() {
            session.claude_remote_control.last_error = detail.map(ToOwned::to_owned);
        }
        session.claude_remote_control.clone()
    };
    let payload = ClaudeRemoteControlStatusPayload {
        workspace_id: workspace_id.to_string(),
        chat_session_id: chat_session_id.to_string(),
        status,
    };
    let _ = app.emit("claude-remote-control-status", &payload);
}

async fn clear_monitor_on_exit(
    app: &AppHandle,
    workspace_id: &str,
    chat_session_id: &str,
    pid: u32,
) {
    let app_state = app.state::<AppState>();
    let status = {
        let mut agents = app_state.agents.write().await;
        let Some(session) = agents.get_mut(chat_session_id) else {
            return;
        };
        let owns_monitor = session.claude_remote_control_monitor_pid == Some(pid);
        let owns_process = session
            .persistent_session
            .as_ref()
            .is_some_and(|ps| ps.pid() == pid);
        if !owns_monitor && !owns_process {
            return;
        }
        if owns_monitor {
            session.claude_remote_control_monitor_pid = None;
        }
        if owns_process {
            session.persistent_session = None;
            session.mcp_bridge = None;
            session.active_pid = None;
            session.claude_remote_control = ClaudeRemoteControlStatus::disabled();
        }
        session.claude_remote_control.clone()
    };
    let payload = ClaudeRemoteControlStatusPayload {
        workspace_id: workspace_id.to_string(),
        chat_session_id: chat_session_id.to_string(),
        status,
    };
    let _ = app.emit("claude-remote-control-status", &payload);
    crate::tray::rebuild_tray(app);
}

async fn clear_monitor_when_feature_disabled(
    app: &AppHandle,
    workspace_id: &str,
    chat_session_id: &str,
    pid: u32,
) {
    let app_state = app.state::<AppState>();
    let status = {
        let mut agents = app_state.agents.write().await;
        let Some(session) = agents.get_mut(chat_session_id) else {
            return;
        };
        if session.claude_remote_control_monitor_pid != Some(pid) {
            return;
        }
        session.claude_remote_control_monitor_pid = None;
        session.claude_remote_control = ClaudeRemoteControlStatus::disabled();
        session.claude_remote_control.clone()
    };
    let payload = ClaudeRemoteControlStatusPayload {
        workspace_id: workspace_id.to_string(),
        chat_session_id: chat_session_id.to_string(),
        status,
    };
    let _ = app.emit("claude-remote-control-status", &payload);
    crate::tray::rebuild_tray(app);
}

#[cfg(test)]
mod tests {
    use super::{
        remote_control_feature_enabled_from_value, remote_control_title,
        should_defer_enable_until_first_turn, should_pin_title_before_control_request,
        status_from_control_response, user_visible_text,
    };
    use crate::state::ClaudeRemoteControlLifecycle;
    use claudette::agent::{UserContentBlock, UserEventMessage, UserMessageContent};
    use claudette::model::{
        AgentStatus, ChatMessage, ChatRole, ChatSession, SessionStatus, Workspace, WorkspaceStatus,
    };

    fn chat_session_with_turn_count(turn_count: u32) -> ChatSession {
        ChatSession {
            id: "chat-1".to_string(),
            workspace_id: "workspace-1".to_string(),
            session_id: None,
            name: "New chat".to_string(),
            name_edited: false,
            turn_count,
            sort_order: 0,
            status: SessionStatus::Active,
            created_at: "2026-05-08T00:00:00Z".to_string(),
            archived_at: None,
            cli_invocation: None,
            agent_status: AgentStatus::Idle,
            needs_attention: false,
            attention_kind: None,
        }
    }

    fn workspace_named(name: &str) -> Workspace {
        Workspace {
            id: "workspace-1".to_string(),
            repository_id: "repo-1".to_string(),
            name: name.to_string(),
            branch_name: format!("claudette/{name}"),
            worktree_path: None,
            status: WorkspaceStatus::Active,
            agent_status: AgentStatus::Idle,
            status_line: String::new(),
            created_at: "2026-05-08T00:00:00Z".to_string(),
            sort_order: 0,
        }
    }

    fn test_chat_message(role: ChatRole, content: &str) -> ChatMessage {
        ChatMessage {
            id: uuid::Uuid::new_v4().to_string(),
            workspace_id: "workspace-1".to_string(),
            chat_session_id: "chat-1".to_string(),
            role,
            content: content.to_string(),
            cost_usd: None,
            duration_ms: None,
            created_at: "2026-05-08T00:00:00Z".to_string(),
            thinking: None,
            input_tokens: None,
            output_tokens: None,
            cache_read_tokens: None,
            cache_creation_tokens: None,
        }
    }

    #[test]
    fn status_from_control_response_extracts_urls() {
        let response = serde_json::json!({
            "session_url": "https://claude.ai/session/abc",
            "connect_url": "https://claude.ai/connect/abc",
            "environment_id": "env_123"
        });

        let status = status_from_control_response(Some(&response));

        assert_eq!(status.state, ClaudeRemoteControlLifecycle::Ready);
        assert_eq!(
            status.session_url.as_deref(),
            Some("https://claude.ai/session/abc")
        );
        assert_eq!(
            status.connect_url.as_deref(),
            Some("https://claude.ai/connect/abc")
        );
        assert_eq!(status.environment_id.as_deref(), Some("env_123"));
    }

    #[test]
    fn status_from_control_response_drops_empty_bridge_connect_url() {
        let response = serde_json::json!({
            "session_url": "https://claude.ai/code/session_123",
            "connect_url": "https://claude.ai/code?environment=",
            "environment_id": ""
        });

        let status = status_from_control_response(Some(&response));

        assert_eq!(
            status.session_url.as_deref(),
            Some("https://claude.ai/code/session_123")
        );
        assert_eq!(status.connect_url, None);
        assert_eq!(status.environment_id, None);
    }

    #[test]
    fn status_from_control_response_keeps_non_empty_bridge_connect_url() {
        let response = serde_json::json!({
            "connect_url": "https://claude.ai/code?bridge=env_123",
            "environment_id": "env_123"
        });

        let status = status_from_control_response(Some(&response));

        assert_eq!(
            status.connect_url.as_deref(),
            Some("https://claude.ai/code?bridge=env_123")
        );
        assert_eq!(status.environment_id.as_deref(), Some("env_123"));
    }

    #[test]
    fn user_visible_text_extracts_text_blocks() {
        let message = UserEventMessage {
            content: UserMessageContent::Blocks(vec![
                UserContentBlock::Text {
                    text: "one".to_string(),
                },
                UserContentBlock::Text {
                    text: "two".to_string(),
                },
            ]),
        };

        assert_eq!(user_visible_text(&message).as_deref(), Some("one\ntwo"));
    }

    #[test]
    fn user_visible_text_extracts_replayed_remote_text() {
        let message = UserEventMessage {
            content: UserMessageContent::Text("ping from remote".to_string()),
        };

        assert_eq!(
            user_visible_text(&message).as_deref(),
            Some("ping from remote")
        );
    }

    #[test]
    fn remote_control_enable_defers_until_first_turn_for_new_chat() {
        assert!(should_defer_enable_until_first_turn(
            &chat_session_with_turn_count(0)
        ));
    }

    #[test]
    fn remote_control_enable_does_not_defer_after_first_turn() {
        assert!(!should_defer_enable_until_first_turn(
            &chat_session_with_turn_count(1)
        ));
    }

    #[test]
    fn remote_control_does_not_pin_title_before_first_turn_transcript_exists() {
        assert!(!should_pin_title_before_control_request(
            &chat_session_with_turn_count(0)
        ));
        assert!(should_pin_title_before_control_request(
            &chat_session_with_turn_count(1)
        ));
    }

    #[test]
    fn remote_control_title_falls_back_to_workspace_for_new_chat() {
        let mut chat_session = chat_session_with_turn_count(1);
        let workspace = workspace_named("muddy-willow");

        assert_eq!(
            remote_control_title(&chat_session, &workspace, &[]),
            "muddy-willow"
        );

        chat_session.name = "Ping Session".to_string();
        assert_eq!(
            remote_control_title(&chat_session, &workspace, &[]),
            "Ping Session"
        );
    }

    #[test]
    fn remote_control_title_prefers_first_user_prompt_for_new_chat() {
        let chat_session = chat_session_with_turn_count(3);
        let workspace = workspace_named("muddy-willow");
        let messages = vec![
            test_chat_message(ChatRole::User, "ping 1"),
            test_chat_message(ChatRole::Assistant, "pong"),
            test_chat_message(ChatRole::User, "ping 3"),
        ];

        assert_eq!(
            remote_control_title(&chat_session, &workspace, &messages),
            "ping 1"
        );
    }

    #[test]
    fn remote_control_feature_flag_defaults_on() {
        assert!(remote_control_feature_enabled_from_value(None));
        assert!(remote_control_feature_enabled_from_value(Some("true")));
    }

    #[test]
    fn remote_control_feature_flag_disables_only_on_false() {
        assert!(!remote_control_feature_enabled_from_value(Some("false")));
    }
}
