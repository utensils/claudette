use std::sync::Arc;

use claudette::agent::{self, AgentEvent, AgentSettings, InnerStreamEvent, StreamEvent};
use claudette::chat::{
    BuildAssistantArgs, CheckpointArgs, build_assistant_chat_message, create_turn_checkpoint,
    extract_assistant_text, extract_event_thinking,
};
use claudette::db::Database;
use claudette::model::{ChatMessage, ChatRole};
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use serde_json::json;

use crate::ws::{AgentSessionState, PtyHandle, ServerState, Writer, send_message};

use claudette::permissions::tools_for_level;

/// Dispatch a JSON-RPC request and return a JSON-RPC response.
pub async fn handle_request(
    state: &Arc<ServerState>,
    writer: &Arc<Writer>,
    request: &serde_json::Value,
) -> serde_json::Value {
    let id = request
        .get("id")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let method = request.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let params = request.get("params").cloned().unwrap_or_default();

    let result = match method {
        "load_initial_data" => handle_load_initial_data(state).await,
        "load_chat_history" => {
            let chat_session_id = param_chat_session_id(&params);
            handle_load_chat_history(state, &chat_session_id).await
        }
        "send_chat_message" => {
            let chat_session_id = param_chat_session_id(&params);
            let content = param_str(&params, "content");
            let permission_level = params
                .get("permission_level")
                .and_then(|v| v.as_str())
                .map(String::from);
            let model = params
                .get("model")
                .and_then(|v| v.as_str())
                .map(String::from);
            let fast_mode = params.get("fast_mode").and_then(|v| v.as_bool());
            let thinking_enabled = params.get("thinking_enabled").and_then(|v| v.as_bool());
            let plan_mode = params.get("plan_mode").and_then(|v| v.as_bool());
            let effort = params
                .get("effort")
                .and_then(|v| v.as_str())
                .map(String::from);
            let chrome_enabled = params.get("chrome_enabled").and_then(|v| v.as_bool());
            let disable_1m_context = params.get("disable_1m_context").and_then(|v| v.as_bool());
            let backend_id = params
                .get("backend_id")
                .and_then(|v| v.as_str())
                .map(String::from);
            let mentioned_files: Option<Vec<String>> = params
                .get("mentioned_files")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            handle_send_chat_message(
                state,
                writer,
                &chat_session_id,
                &content,
                permission_level.as_deref(),
                model,
                fast_mode,
                thinking_enabled,
                plan_mode,
                effort,
                chrome_enabled,
                disable_1m_context,
                backend_id,
                mentioned_files,
            )
            .await
        }
        "steer_queued_chat_message" => {
            Err("Mid-turn steering is not yet supported for remote sessions".to_string())
        }
        "stop_agent" => {
            let chat_session_id = param_chat_session_id(&params);
            handle_stop_agent(state, &chat_session_id).await
        }
        "reset_agent_session" => {
            let chat_session_id = param_chat_session_id(&params);
            let mut agents = state.agents.write().await;
            agents.remove(&chat_session_id);
            Ok(json!(null))
        }
        "list_repositories" => {
            let db = open_db(state).map_err(|e| e.to_string());
            match db {
                Ok(db) => db
                    .list_repositories()
                    .map(|repos| serde_json::to_value(repos).unwrap_or_default())
                    .map_err(|e| e.to_string()),
                Err(e) => Err(e),
            }
        }
        "list_workspaces" => {
            let db = open_db(state).map_err(|e| e.to_string());
            match db {
                Ok(db) => db
                    .list_workspaces()
                    .map(|ws| serde_json::to_value(ws).unwrap_or_default())
                    .map_err(|e| e.to_string()),
                Err(e) => Err(e),
            }
        }
        "create_workspace" => {
            let repository_id = param_str(&params, "repository_id");
            let name = param_str(&params, "name");
            let preserve_supplied_name = params
                .get("preserve_name")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            handle_create_workspace(state, &repository_id, &name, preserve_supplied_name).await
        }
        "archive_workspace" => {
            let workspace_id = param_str(&params, "workspace_id");
            handle_archive_workspace(state, &workspace_id).await
        }
        "load_diff_files" => {
            let workspace_id = param_str(&params, "workspace_id");
            handle_load_diff_files(state, &workspace_id).await
        }
        "load_file_diff" => {
            let worktree_path = param_str(&params, "worktree_path");
            let file_path = param_str(&params, "file_path");
            let merge_base = param_str(&params, "merge_base");
            let diff_layer = params
                .get("diff_layer")
                .and_then(|v| v.as_str())
                .map(String::from);
            handle_load_file_diff(
                &worktree_path,
                &file_path,
                &merge_base,
                diff_layer.as_deref(),
            )
            .await
        }
        "spawn_pty" => {
            let workspace_id = param_str(&params, "workspace_id");
            let cwd = param_str(&params, "cwd");
            let rows = params.get("rows").and_then(|v| v.as_u64()).unwrap_or(24) as u16;
            let cols = params.get("cols").and_then(|v| v.as_u64()).unwrap_or(80) as u16;
            handle_spawn_pty(state, writer, &workspace_id, &cwd, rows, cols).await
        }
        "write_pty" => {
            let pty_id = params.get("pty_id").and_then(|v| v.as_u64()).unwrap_or(0);
            let data: Vec<u8> = params
                .get("data")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|b| b.as_u64().map(|n| n as u8))
                        .collect()
                })
                .unwrap_or_default();
            handle_write_pty(state, pty_id, &data).await
        }
        "resize_pty" => {
            let pty_id = params.get("pty_id").and_then(|v| v.as_u64()).unwrap_or(0);
            let rows = params.get("rows").and_then(|v| v.as_u64()).unwrap_or(24) as u16;
            let cols = params.get("cols").and_then(|v| v.as_u64()).unwrap_or(80) as u16;
            handle_resize_pty(state, pty_id, rows, cols).await
        }
        "close_pty" => {
            let pty_id = params.get("pty_id").and_then(|v| v.as_u64()).unwrap_or(0);
            handle_close_pty(state, pty_id).await
        }
        "get_app_setting" => {
            let key = param_str(&params, "key");
            handle_get_app_setting(state, &key)
        }
        "set_app_setting" => {
            let key = param_str(&params, "key");
            let value = param_str(&params, "value");
            handle_set_app_setting(state, &key, &value).await
        }
        "list_chat_sessions" => {
            let workspace_id = param_str(&params, "workspace_id");
            let include_archived = params
                .get("include_archived")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            handle_list_chat_sessions(state, &workspace_id, include_archived)
        }
        "get_chat_session" => {
            let chat_session_id = param_chat_session_id(&params);
            handle_get_chat_session(state, &chat_session_id)
        }
        "create_chat_session" => {
            let workspace_id = param_str(&params, "workspace_id");
            handle_create_chat_session(state, &workspace_id)
        }
        "rename_chat_session" => {
            let chat_session_id = param_chat_session_id(&params);
            let name = param_str(&params, "name");
            handle_rename_chat_session(state, &chat_session_id, &name)
        }
        "archive_chat_session" => {
            let chat_session_id = param_chat_session_id(&params);
            handle_archive_chat_session(state, &chat_session_id).await
        }
        _ => Err(format!("Unknown method: {method}")),
    };

    match result {
        Ok(value) => json!({"id": id, "result": value}),
        Err(msg) => json!({"id": id, "error": {"code": -1, "message": msg}}),
    }
}

fn param_str(params: &serde_json::Value, key: &str) -> String {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

/// Read a chat session id from JSON-RPC params. Prefers the canonical
/// `chat_session_id` key (which the multi-session UI sends) and falls back
/// to the legacy `session_id` key so older clients keep working.
fn param_chat_session_id(params: &serde_json::Value) -> String {
    params
        .get("chat_session_id")
        .or_else(|| params.get("session_id"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn open_db(state: &ServerState) -> Result<Database, String> {
    Database::open(&state.db_path).map_err(|e| e.to_string())
}

/// Mirror of `commands::env::load_disabled_providers` from the Tauri side.
/// Reads per-repo env-provider toggles persisted in `app_settings` under
/// keys of the form `repo:{repo_id}:env_provider:{plugin}:enabled`. The
/// dispatcher consults this set to skip the matching plugin without
/// running its detect/export operations.
fn load_disabled_providers(db: &Database, repo_id: &str) -> std::collections::HashSet<String> {
    let prefix = format!("repo:{repo_id}:env_provider:");
    db.list_app_settings_with_prefix(&prefix)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(key, value)| {
            if value == "false" {
                let rest = key.strip_prefix(&prefix)?;
                rest.strip_suffix(":enabled").map(|n| n.to_string())
            } else {
                None
            }
        })
        .collect()
}

/// Resolve the merged env-provider activation for a workspace turn.
/// When the server's plugin registry is `None` (no bundled or
/// user-installed plugins) this returns a default `ResolvedEnv`, which
/// applies as a no-op on the spawned command. That matches the
/// behaviour of `resolve_with_registry` against an empty registry and
/// keeps deployments without plugins working unchanged.
///
/// `disabled` is the per-repo set of disabled env-provider names
/// (typically from [`load_disabled_providers`]). Computing it
/// synchronously in the caller avoids holding `&Database` (which is
/// not `Sync`) across the `.await` on the plugin-registry lock —
/// `handle_request` is invoked from inside `tokio::spawn`, so its
/// future tree must stay `Send`.
pub async fn resolve_workspace_env(
    state: &ServerState,
    ws: &claudette::model::Workspace,
    repo: Option<&claudette::model::Repository>,
    worktree_path: &str,
    disabled: std::collections::HashSet<String>,
) -> claudette::env_provider::ResolvedEnv {
    let Some(plugins_lock) = state.plugins.as_ref() else {
        return claudette::env_provider::ResolvedEnv::default();
    };

    let ws_info = claudette::plugin_runtime::host_api::WorkspaceInfo {
        id: ws.id.clone(),
        name: ws.name.clone(),
        branch: ws.branch_name.clone(),
        worktree_path: worktree_path.to_string(),
        repo_path: repo.map(|r| r.path.clone()).unwrap_or_default(),
    };
    let registry = plugins_lock.read().await;
    claudette::env_provider::resolve_with_registry(
        &registry,
        &state.env_cache,
        std::path::Path::new(worktree_path),
        &ws_info,
        &disabled,
    )
    .await
}

fn now_iso() -> String {
    let dur = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = dur.as_secs();
    let days = secs / 86400;
    let time_secs = secs % 86400;
    let h = time_secs / 3600;
    let m = (time_secs % 3600) / 60;
    let s = time_secs % 60;
    // Hinnant's algorithm for epoch days → calendar date.
    let z = days + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    format!("{y:04}-{mo:02}-{d:02} {h:02}:{m:02}:{s:02}")
}

// ---- Command handlers ----

async fn handle_load_initial_data(state: &ServerState) -> Result<serde_json::Value, String> {
    let db = open_db(state)?;
    let repositories = db.list_repositories().map_err(|e| e.to_string())?;
    let workspaces = db.list_workspaces().map_err(|e| e.to_string())?;

    let worktree_base_dir = {
        let dir = state.worktree_base_dir.read().await;
        dir.to_string_lossy().to_string()
    };

    // Check repo path validity.
    let repositories: Vec<_> = repositories
        .into_iter()
        .map(|mut r| {
            r.path_valid = std::path::Path::new(&r.path).is_dir();
            r
        })
        .collect();

    // Resolve default branches concurrently.
    let branch_futures: Vec<_> = repositories
        .iter()
        .filter(|r| r.path_valid)
        .map(|r| {
            let id = r.id.clone();
            let path = r.path.clone();
            let base = r.base_branch.clone();
            let remote = r.default_remote.clone();
            async move {
                let branch = match base {
                    Some(b) => Some(b),
                    None => claudette::git::default_branch(&path, remote.as_deref())
                        .await
                        .ok(),
                };
                branch.map(|b| (id, b))
            }
        })
        .collect();
    let branch_results = futures_util::future::join_all(branch_futures).await;
    let default_branches: std::collections::HashMap<String, String> =
        branch_results.into_iter().flatten().collect();

    // Resolve current branch for each active workspace with a valid worktree path.
    let workspace_branch_futures: Vec<_> = workspaces
        .iter()
        .filter(|ws| ws.status == claudette::model::WorkspaceStatus::Active)
        .filter_map(|ws| {
            ws.worktree_path
                .as_ref()
                .filter(|path| std::path::Path::new(path).is_dir())
                .map(|path| {
                    let id = ws.id.clone();
                    let path = path.clone();
                    async move {
                        match claudette::git::current_branch(&path).await {
                            Ok(branch) => (id, branch),
                            Err(_) => (id, "(detached)".to_string()),
                        }
                    }
                })
        })
        .collect();
    let workspace_branch_results = futures_util::future::join_all(workspace_branch_futures).await;
    let workspace_current_branches: std::collections::HashMap<String, String> =
        workspace_branch_results.into_iter().collect();

    // Update workspace branch_name with current branch from worktree.
    let workspaces: Vec<_> = workspaces
        .into_iter()
        .map(|mut ws| {
            if let Some(current) = workspace_current_branches.get(&ws.id) {
                ws.branch_name = current.clone();
            }
            ws
        })
        .collect();

    let last_messages = db.last_message_per_workspace().map_err(|e| e.to_string())?;

    Ok(json!({
        "repositories": repositories,
        "workspaces": workspaces,
        "worktree_base_dir": worktree_base_dir,
        "default_branches": default_branches,
        "last_messages": last_messages,
    }))
}

async fn handle_load_chat_history(
    state: &ServerState,
    chat_session_id: &str,
) -> Result<serde_json::Value, String> {
    let db = open_db(state)?;
    let messages = db
        .list_chat_messages_for_session(chat_session_id)
        .map_err(|e| e.to_string())?;
    Ok(serde_json::to_value(messages).unwrap_or_default())
}

#[allow(clippy::too_many_arguments)]
async fn handle_send_chat_message(
    state: &Arc<ServerState>,
    writer: &Arc<Writer>,
    chat_session_id: &str,
    content: &str,
    permission_level: Option<&str>,
    model: Option<String>,
    fast_mode: Option<bool>,
    thinking_enabled: Option<bool>,
    plan_mode: Option<bool>,
    effort: Option<String>,
    chrome_enabled: Option<bool>,
    disable_1m_context: Option<bool>,
    backend_id: Option<String>,
    mentioned_files: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    let db = open_db(state)?;

    let chat_session_id = chat_session_id.to_string();
    let chat_session = db
        .get_chat_session(&chat_session_id)
        .map_err(|e| e.to_string())?
        .ok_or("Chat session not found")?;
    let workspace_id = chat_session.workspace_id.clone();

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

    // Save user message.
    let user_msg = ChatMessage {
        id: uuid::Uuid::new_v4().to_string(),
        workspace_id: workspace_id.clone(),
        chat_session_id: chat_session_id.clone(),
        role: ChatRole::User,
        content: content.to_string(),
        cost_usd: None,
        duration_ms: None,
        created_at: now_iso(),
        thinking: None,
        input_tokens: None,
        output_tokens: None,
        cache_read_tokens: None,
        cache_creation_tokens: None,
    };
    db.insert_chat_message(&user_msg)
        .map_err(|e| e.to_string())?;

    let level = permission_level.unwrap_or("full");
    let allowed_tools = tools_for_level(level);

    let repo = db
        .get_repository(&ws.repository_id)
        .map_err(|e| e.to_string())?;

    // Expand @-file mentions into inline file content for the agent prompt.
    let prompt = claudette::file_expand::expand_file_mentions(
        std::path::Path::new(&worktree_path),
        content,
        mentioned_files.as_deref().unwrap_or(&[]),
    )
    .await;

    // Build workspace env vars for the agent subprocess.
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
    let ws_env = claudette::env::WorkspaceEnv::from_workspace(ws, repo_path, default_branch);

    // Resolve the env-provider layer (direnv / mise / dotenv / nix-devshell)
    // once per turn. Mirrors the Tauri path in src-tauri/src/commands/chat.rs:
    // the mtime-keyed cache makes this essentially free on quiet turns; on
    // the first turn or after the user edits `.envrc` / `mise.toml` / etc.,
    // it re-runs the affected plugin. Resolution happens before any
    // `state.agents` lock is taken so the registry RwLock can be acquired
    // without nested-lock concerns. The disabled-provider set is read
    // synchronously here from the already-open `db` so we avoid both a
    // duplicate SQLite connection and a non-`Send` borrow across `.await`.
    let disabled_env_providers =
        load_disabled_providers(&db, repo.as_ref().map(|r| r.id.as_str()).unwrap_or(""));
    let resolved_env = resolve_workspace_env(
        state,
        ws,
        repo.as_ref(),
        &worktree_path,
        disabled_env_providers,
    )
    .await;

    let mut agents = state.agents.write().await;
    let workspace_id_owned = workspace_id.clone();
    let session = agents.entry(chat_session_id.clone()).or_insert_with(|| {
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
        AgentSessionState {
            workspace_id: workspace_id_owned,
            session_id: uuid::Uuid::new_v4().to_string(),
            turn_count: 0,
            active_pid: None,
            custom_instructions: instructions,
            session_resolved_env: Default::default(),
        }
    });

    // Env-provider drift teardown: the env baked into a running agent's
    // env is fixed at spawn time, so the subprocess won't see `.envrc` /
    // `mise.toml` / `direnv allow` changes until it's respawned. Compare
    // the freshly-resolved vars against the snapshot stored at spawn and
    // reset the session on divergence so this turn launches with the new
    // env. The Tauri path uses a long-lived PersistentSession; the remote
    // handler re-launches `claude --print` per turn, so a reset just means
    // clearing turn_count / session_id before the rest of this function
    // continues with `is_resume = false` and re-runs the session-init
    // branch (`run_turn` is called below with the fresh state).
    if session.turn_count > 0 && session.session_resolved_env != resolved_env.vars {
        eprintln!(
            "[handler] env-provider output changed ({} vars before, {} after) — resetting session for {workspace_id}",
            session.session_resolved_env.len(),
            resolved_env.vars.len(),
        );
        session.session_id = uuid::Uuid::new_v4().to_string();
        session.turn_count = 0;
        session.active_pid = None;
        session.session_resolved_env = Default::default();
    }

    let is_resume = session.turn_count > 0;
    let session_id = session.session_id.clone();
    let custom_instructions = session.custom_instructions.clone();
    session.turn_count += 1;

    // Load repository MCP configs for injection on EVERY turn. Each `claude
    // --print` is an independent process — MCP connections are per-process and
    // NOT restored from session state on `--resume`.
    let mcp_config = {
        let db_rows = db
            .list_repository_mcp_servers(&ws.repository_id)
            .unwrap_or_default();
        claudette::mcp::cli_config_from_rows(&db_rows)
    };

    let agent_settings = AgentSettings {
        model: if !is_resume { model } else { None },
        fast_mode: fast_mode.unwrap_or(false),
        thinking_enabled: thinking_enabled.unwrap_or(false),
        plan_mode: plan_mode.unwrap_or(false),
        effort,
        chrome_enabled: chrome_enabled.unwrap_or(false),
        mcp_config,
        disable_1m_context: disable_1m_context.unwrap_or(false),
        backend_runtime: Default::default(),
        hook_bridge: None,
    };
    if backend_id.as_deref().is_some_and(|id| id != "anthropic") {
        eprintln!("[handler] alternate backends are not supported over remote transport yet");
    }

    let turn_handle = agent::run_turn(
        std::path::Path::new(&worktree_path),
        &session_id,
        &prompt,
        is_resume,
        &allowed_tools,
        custom_instructions.as_deref(),
        &agent_settings,
        &[], // Attachments not yet supported over remote transport
        Some(&ws_env),
        Some(&resolved_env),
    )
    .await?;

    session.active_pid = Some(turn_handle.pid);
    session.session_resolved_env = resolved_env.vars.clone();
    drop(agents);

    // Bridge agent events to WebSocket.
    let ws_id = workspace_id.clone();
    let chat_session_id_for_stream = chat_session_id.clone();
    let db_path = state.db_path.clone();
    let wt_path = worktree_path.clone();
    let user_msg_id = user_msg.id.clone();
    let state = Arc::clone(state);
    let writer = Arc::clone(writer);
    tokio::spawn(async move {
        let mut rx = turn_handle.event_rx;
        let mut got_init = false;
        let mut pending_thinking: Option<String> = None;
        // Tracks the most recent per-message usage observed on a MessageDelta
        // event. Written into the next persisted assistant ChatMessage and
        // reset to None after each persistence so per-message counts stay
        // distinct across multi-message turns. Mirrors the Tauri bridge.
        let mut latest_usage: Option<claudette::agent::TokenUsage> = None;
        // Tracks the most recently persisted assistant message id so the
        // Result-event arm can update its cost/duration and use it as the
        // checkpoint anchor without re-querying the DB. Mirrors the Tauri
        // bridge.
        let mut last_assistant_msg_id: Option<String> = None;
        while let Some(event) = rx.recv().await {
            if let AgentEvent::Stream(StreamEvent::System { ref subtype, .. }) = event
                && subtype == "init"
            {
                got_init = true;
            }

            if let AgentEvent::ProcessExited(code) = &event
                && (!got_init || *code != Some(0))
            {
                let mut agents = state.agents.write().await;
                agents.remove(&chat_session_id_for_stream);
            }

            // Track per-assistant-message cumulative usage as the CLI streams
            // it. The final MessageDelta before message_stop carries the
            // authoritative per-message total; we overwrite on every delta and
            // consume it when the assistant message is persisted below.
            if let AgentEvent::Stream(StreamEvent::Stream {
                event: InnerStreamEvent::MessageDelta { usage: Some(u) },
            }) = &event
            {
                latest_usage = Some(u.clone());
            }

            // Persist assistant messages. The CLI may fire multiple assistant
            // events per turn (thinking-only, then text). Accumulate thinking
            // and save only when text content arrives.
            if let AgentEvent::Stream(StreamEvent::Assistant { ref message }) = event {
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
                        workspace_id: &ws_id,
                        chat_session_id: &chat_session_id_for_stream,
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

            // Update cost/duration on result events, then create a checkpoint.
            if let AgentEvent::Stream(StreamEvent::Result {
                ref total_cost_usd,
                ref duration_ms,
                ..
            }) = event
            {
                if let (Some(cost), Some(dur)) = (total_cost_usd, duration_ms)
                    && let Some(ref msg_id) = last_assistant_msg_id
                    && let Ok(db) = Database::open(&db_path)
                {
                    let _ = db.update_chat_message_cost(msg_id, *cost, *dur);
                }

                let anchor_msg_id = last_assistant_msg_id.as_deref().unwrap_or(&user_msg_id);
                if let Some(cp) = create_turn_checkpoint(CheckpointArgs {
                    db_path: &db_path,
                    workspace_id: &ws_id,
                    chat_session_id: &chat_session_id_for_stream,
                    anchor_msg_id,
                    worktree_path: &wt_path,
                    created_at: now_iso(),
                })
                .await
                {
                    let event_msg = json!({
                        "event": "checkpoint-created",
                        "payload": {
                            "workspace_id": &ws_id,
                            "chat_session_id": &chat_session_id_for_stream,
                            "checkpoint": &cp,
                        }
                    });
                    send_message(&writer, &event_msg).await;
                }
            }

            // Emit event over WebSocket.
            let event_msg = json!({
                "event": "agent-stream",
                "payload": {
                    "workspace_id": ws_id,
                    "session_id": chat_session_id_for_stream,
                    "event": event,
                }
            });
            send_message(&writer, &event_msg).await;
        }
    });

    Ok(json!(null))
}

async fn handle_stop_agent(
    state: &ServerState,
    chat_session_id: &str,
) -> Result<serde_json::Value, String> {
    let db = open_db(state)?;
    let chat_session_id = chat_session_id.to_string();
    let chat_session = db
        .get_chat_session(&chat_session_id)
        .map_err(|e| e.to_string())?
        .ok_or("Chat session not found")?;
    let workspace_id = chat_session.workspace_id.clone();

    let mut agents = state.agents.write().await;
    if let Some(session) = agents.get_mut(&chat_session_id)
        && let Some(pid) = session.active_pid.take()
    {
        agent::stop_agent(pid).await?;
    }
    drop(agents);

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
    Ok(json!(null))
}

async fn handle_create_workspace(
    state: &ServerState,
    repository_id: &str,
    name: &str,
    preserve_supplied_name: bool,
) -> Result<serde_json::Value, String> {
    use claudette::ops::{NoopHooks, workspace as ops_workspace};

    let mut db = open_db(state)?;
    let repo = db
        .get_repository(repository_id)
        .map_err(|e| e.to_string())?
        .ok_or("Repository not found")?;

    let worktree_base_dir = state.worktree_base_dir.read().await.clone();
    // Server uses the repo's path_slug as the prefix — historical behavior
    // that survives the refactor unchanged. The GUI resolves a per-user
    // prefix from app settings; harmonizing the two is a follow-up.
    let branch_prefix = format!("{}/", repo.path_slug);

    let out = ops_workspace::create(
        &mut db,
        &NoopHooks,
        worktree_base_dir.as_path(),
        ops_workspace::CreateParams {
            repo_id: repository_id,
            name,
            branch_prefix: &branch_prefix,
            preserve_supplied_name,
        },
    )
    .await
    .map_err(|e| e.to_string())?;

    // Run the setup script (if configured) for parity with the GUI path.
    // The server has no plugin registry, so env-provider stack is not
    // applied — adding that requires loading plugins server-side.
    let setup_result = ops_workspace::resolve_and_run_setup(
        &out.workspace,
        std::path::Path::new(&repo.path),
        std::path::Path::new(&out.worktree_path),
        repo.setup_script.as_deref(),
        repo.base_branch.as_deref(),
        repo.default_remote.as_deref(),
        None,
    )
    .await;

    Ok(json!({
        "workspace": out.workspace,
        "default_session_id": out.default_session_id,
        "setup_result": setup_result,
    }))
}

async fn handle_archive_workspace(
    state: &ServerState,
    workspace_id: &str,
) -> Result<serde_json::Value, String> {
    use claudette::ops::{NoopHooks, workspace as ops_workspace};

    // Stop any running agents for sessions in this workspace. Collect the
    // PIDs to stop under the lock, then drop the lock before awaiting any
    // process teardowns to avoid blocking unrelated requests. Agent state
    // is per-process; this part can't move into the shared op.
    let pids_to_stop: Vec<u32> = {
        let mut agents = state.agents.write().await;
        let to_remove: Vec<String> = agents
            .iter()
            .filter(|(_, s)| s.workspace_id == workspace_id)
            .map(|(k, _)| k.clone())
            .collect();
        to_remove
            .into_iter()
            .filter_map(|key| agents.remove(&key).and_then(|s| s.active_pid))
            .collect()
    };
    for pid in pids_to_stop {
        let _ = agent::stop_agent(pid).await;
    }

    let mut db = open_db(state)?;
    let _ = ops_workspace::archive(
        &mut db,
        &NoopHooks,
        ops_workspace::ArchiveParams {
            workspace_id,
            // The server doesn't surface a delete-branch toggle today;
            // archive without branch deletion mirrors prior behavior so
            // remote clients can still restore archived workspaces.
            delete_branch: false,
        },
    )
    .await
    .map_err(|e| e.to_string())?;

    Ok(json!(null))
}

async fn handle_load_diff_files(
    state: &ServerState,
    workspace_id: &str,
) -> Result<serde_json::Value, String> {
    let db = open_db(state)?;
    let workspaces = db.list_workspaces().map_err(|e| e.to_string())?;
    let ws = workspaces
        .iter()
        .find(|w| w.id == workspace_id)
        .ok_or("Workspace not found")?;
    let worktree_path = ws
        .worktree_path
        .as_ref()
        .ok_or("Workspace has no worktree")?;

    let repo = db
        .get_repository(&ws.repository_id)
        .map_err(|e| e.to_string())?
        .ok_or("Repository not found")?;

    let base_branch = match repo.base_branch.as_deref() {
        Some(b) => b.to_string(),
        None => claudette::git::default_branch(&repo.path, repo.default_remote.as_deref())
            .await
            .map_err(|e| format!("{e:?}"))?,
    };

    let merge_base = claudette::diff::merge_base(worktree_path, "HEAD", &base_branch)
        .await
        .map_err(|e| format!("{e:?}"))?;

    let (files, staged_files) = tokio::join!(
        claudette::diff::changed_files(worktree_path, &merge_base),
        claudette::diff::staged_changed_files(worktree_path, &merge_base),
    );

    let files = files.map_err(|e| format!("{e:?}"))?;
    let staged_files = staged_files.ok();

    Ok(json!({
        "files": files,
        "merge_base": merge_base,
        "staged_files": staged_files,
    }))
}

async fn handle_load_file_diff(
    worktree_path: &str,
    file_path: &str,
    merge_base: &str,
    diff_layer: Option<&str>,
) -> Result<serde_json::Value, String> {
    let raw =
        claudette::diff::file_diff_for_layer(worktree_path, merge_base, file_path, diff_layer)
            .await
            .map_err(|e| format!("{e:?}"))?;
    let parsed = claudette::diff::parse_unified_diff(&raw, file_path);
    Ok(serde_json::to_value(parsed).unwrap_or_default())
}

async fn handle_spawn_pty(
    state: &Arc<ServerState>,
    writer: &Arc<Writer>,
    workspace_id: &str,
    cwd: &str,
    rows: u16,
    cols: u16,
) -> Result<serde_json::Value, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let mut cmd = CommandBuilder::new(&shell);
    cmd.cwd(cwd);

    // Inject workspace context env vars (best-effort — DB lookup may fail).
    if let Ok(db) = open_db(state)
        && let Ok(wss) = db.list_workspaces()
        && let Some(ws) = wss.iter().find(|w| w.id == workspace_id)
    {
        let repo = db.get_repository(&ws.repository_id).ok().flatten();
        let repo_path = repo.as_ref().map(|r| r.path.as_str()).unwrap_or_default();
        let default_branch = match repo.as_ref().and_then(|r| r.base_branch.as_deref()) {
            Some(b) => b.to_string(),
            None => claudette::git::default_branch(
                repo_path,
                repo.as_ref().and_then(|r| r.default_remote.as_deref()),
            )
            .await
            .unwrap_or_else(|_| "main".into()),
        };
        let ws_env = claudette::env::WorkspaceEnv::from_workspace(ws, repo_path, default_branch);
        for (k, v) in ws_env.vars() {
            cmd.env(k, v);
        }
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let pty_reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let pty_writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let pty_id = state.next_pty_id();

    {
        let mut ptys = state.ptys.write().await;
        ptys.insert(
            pty_id,
            PtyHandle {
                writer: std::sync::Mutex::new(pty_writer),
                master: std::sync::Mutex::new(pair.master),
                child: std::sync::Mutex::new(child),
            },
        );
    }

    // Spawn a reader task that forwards PTY output over WebSocket.
    let writer = Arc::clone(writer);
    let state_clone = Arc::clone(state);
    tokio::task::spawn_blocking(move || {
        use std::io::Read;
        let mut reader = pty_reader;
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data: Vec<u8> = buf[..n].to_vec();
                    let writer = writer.clone();
                    let rt = tokio::runtime::Handle::current();
                    rt.block_on(async {
                        let msg = json!({
                            "event": "pty-output",
                            "payload": {
                                "pty_id": pty_id,
                                "data": data,
                            }
                        });
                        send_message(&writer, &msg).await;
                    });
                }
                Err(_) => break,
            }
        }
        // Clean up PTY on exit.
        let rt = tokio::runtime::Handle::current();
        rt.block_on(async {
            let mut ptys = state_clone.ptys.write().await;
            ptys.remove(&pty_id);
        });
    });

    Ok(json!({"pty_id": pty_id}))
}

async fn handle_write_pty(
    state: &ServerState,
    pty_id: u64,
    data: &[u8],
) -> Result<serde_json::Value, String> {
    let ptys = state.ptys.read().await;
    let handle = ptys.get(&pty_id).ok_or("PTY not found")?;
    let mut writer = handle.writer.lock().map_err(|e| e.to_string())?;
    writer.write_all(data).map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())?;
    Ok(json!(null))
}

async fn handle_resize_pty(
    state: &ServerState,
    pty_id: u64,
    rows: u16,
    cols: u16,
) -> Result<serde_json::Value, String> {
    let ptys = state.ptys.read().await;
    let handle = ptys.get(&pty_id).ok_or("PTY not found")?;
    let master = handle.master.lock().map_err(|e| e.to_string())?;
    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    Ok(json!(null))
}

async fn handle_close_pty(state: &ServerState, pty_id: u64) -> Result<serde_json::Value, String> {
    let mut ptys = state.ptys.write().await;
    if let Some(handle) = ptys.remove(&pty_id)
        && let Ok(mut child) = handle.child.lock()
    {
        let _ = child.kill();
    }
    Ok(json!(null))
}

fn handle_get_app_setting(state: &ServerState, key: &str) -> Result<serde_json::Value, String> {
    let db = open_db(state)?;
    let value = db.get_app_setting(key).map_err(|e| e.to_string())?;
    Ok(json!(value))
}

async fn handle_set_app_setting(
    state: &ServerState,
    key: &str,
    value: &str,
) -> Result<serde_json::Value, String> {
    let db = open_db(state)?;
    db.set_app_setting(key, value).map_err(|e| e.to_string())?;
    if key == "worktree_base_dir" {
        let mut dir = state.worktree_base_dir.write().await;
        *dir = std::path::PathBuf::from(value);
    }
    Ok(json!(null))
}

fn handle_list_chat_sessions(
    state: &ServerState,
    workspace_id: &str,
    include_archived: bool,
) -> Result<serde_json::Value, String> {
    let db = open_db(state)?;
    let sessions = db
        .list_chat_sessions_for_workspace(workspace_id, include_archived)
        .map_err(|e| e.to_string())?;
    serde_json::to_value(sessions).map_err(|e| e.to_string())
}

fn handle_get_chat_session(
    state: &ServerState,
    chat_session_id: &str,
) -> Result<serde_json::Value, String> {
    let db = open_db(state)?;
    let session = db
        .get_chat_session(chat_session_id)
        .map_err(|e| e.to_string())?
        .ok_or("Session not found")?;
    serde_json::to_value(session).map_err(|e| e.to_string())
}

fn handle_create_chat_session(
    state: &ServerState,
    workspace_id: &str,
) -> Result<serde_json::Value, String> {
    let db = open_db(state)?;
    let session = db
        .create_chat_session(workspace_id)
        .map_err(|e| e.to_string())?;
    serde_json::to_value(session).map_err(|e| e.to_string())
}

fn handle_rename_chat_session(
    state: &ServerState,
    chat_session_id: &str,
    name: &str,
) -> Result<serde_json::Value, String> {
    let capped = claudette::model::validate_session_name(name).map_err(String::from)?;
    let db = open_db(state)?;
    db.rename_chat_session(chat_session_id, &capped)
        .map_err(|e| e.to_string())?;
    Ok(json!(null))
}

async fn handle_archive_chat_session(
    state: &ServerState,
    chat_session_id: &str,
) -> Result<serde_json::Value, String> {
    let db = open_db(state)?;
    let session = db
        .get_chat_session(chat_session_id)
        .map_err(|e| e.to_string())?
        .ok_or("Session not found")?;
    let workspace_id = session.workspace_id.clone();

    // Stop and remove the live agent for this session.
    // Capture the PID under the lock, then drop the lock before the async stop.
    let pid_to_stop = {
        let mut agents = state.agents.write().await;
        agents
            .remove(chat_session_id)
            .and_then(|mut agent| agent.active_pid.take())
    };
    if let Some(pid) = pid_to_stop {
        let _ = agent::stop_agent(pid).await;
    }

    let fresh = db
        .archive_chat_session_ensuring_active(chat_session_id, &workspace_id)
        .map_err(|e| e.to_string())?;
    if let Some(fresh) = fresh {
        return serde_json::to_value(fresh).map_err(|e| e.to_string());
    }

    Ok(json!(null))
}
