use std::sync::Arc;

use claudette::agent::{self, AgentEvent, AgentSettings, StreamEvent};
use claudette::db::Database;
use claudette::model::{ChatMessage, ChatRole, Workspace, WorkspaceStatus};
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
            let workspace_id = param_str(&params, "workspace_id");
            handle_load_chat_history(state, &workspace_id).await
        }
        "send_chat_message" => {
            let workspace_id = param_str(&params, "workspace_id");
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
            let mentioned_files: Option<Vec<String>> = params
                .get("mentioned_files")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            handle_send_chat_message(
                state,
                writer,
                &workspace_id,
                &content,
                permission_level.as_deref(),
                model,
                fast_mode,
                thinking_enabled,
                plan_mode,
                effort,
                chrome_enabled,
                mentioned_files,
            )
            .await
        }
        "stop_agent" => {
            let workspace_id = param_str(&params, "workspace_id");
            handle_stop_agent(state, &workspace_id).await
        }
        "reset_agent_session" => {
            let workspace_id = param_str(&params, "workspace_id");
            let mut agents = state.agents.write().await;
            agents.remove(&workspace_id);
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
            handle_create_workspace(state, &repository_id, &name).await
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
            handle_load_file_diff(&worktree_path, &file_path, &merge_base).await
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

fn open_db(state: &ServerState) -> Result<Database, String> {
    Database::open(&state.db_path).map_err(|e| e.to_string())
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
            async move {
                claudette::git::default_branch(&path)
                    .await
                    .ok()
                    .map(|b| (id, b))
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
    workspace_id: &str,
) -> Result<serde_json::Value, String> {
    let db = open_db(state)?;
    let messages = db
        .list_chat_messages(workspace_id)
        .map_err(|e| e.to_string())?;
    Ok(serde_json::to_value(messages).unwrap_or_default())
}

#[allow(clippy::too_many_arguments)]
async fn handle_send_chat_message(
    state: &Arc<ServerState>,
    writer: &Arc<Writer>,
    workspace_id: &str,
    content: &str,
    permission_level: Option<&str>,
    model: Option<String>,
    fast_mode: Option<bool>,
    thinking_enabled: Option<bool>,
    plan_mode: Option<bool>,
    effort: Option<String>,
    chrome_enabled: Option<bool>,
    mentioned_files: Option<Vec<String>>,
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
        .ok_or("Workspace has no worktree")?
        .clone();

    // Save user message.
    let user_msg = ChatMessage {
        id: uuid::Uuid::new_v4().to_string(),
        workspace_id: workspace_id.to_string(),
        role: ChatRole::User,
        content: content.to_string(),
        cost_usd: None,
        duration_ms: None,
        created_at: now_iso(),
        thinking: None,
    };
    db.insert_chat_message(&user_msg)
        .map_err(|e| e.to_string())?;

    let level = permission_level.unwrap_or("full");
    let allowed_tools = tools_for_level(level);

    let repo = db
        .get_repository(&ws.repository_id)
        .map_err(|e| e.to_string())?;

    let mut agents = state.agents.write().await;
    let session = agents.entry(workspace_id.to_string()).or_insert_with(|| {
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
    };

    // Expand @-file mentions into inline file content for the agent prompt.
    let prompt = claudette::file_expand::expand_file_mentions(
        std::path::Path::new(&worktree_path),
        content,
        mentioned_files.as_deref().unwrap_or(&[]),
    )
    .await;

    // Build workspace env vars for the agent subprocess.
    let repo_path = repo.as_ref().map(|r| r.path.as_str()).unwrap_or("");
    let default_branch = claudette::git::default_branch(repo_path)
        .await
        .unwrap_or_else(|_| "main".to_string());
    let ws_env = claudette::env::WorkspaceEnv::from_workspace(ws, repo_path, default_branch);

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
    )
    .await?;

    session.active_pid = Some(turn_handle.pid);
    drop(agents);

    // Bridge agent events to WebSocket.
    let ws_id = workspace_id.to_string();
    let db_path = state.db_path.clone();
    let state = Arc::clone(state);
    let writer = Arc::clone(writer);
    tokio::spawn(async move {
        let mut rx = turn_handle.event_rx;
        let mut got_init = false;
        let mut pending_thinking: Option<String> = None;
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
                agents.remove(&ws_id);
            }

            // Persist assistant messages. The CLI may fire multiple assistant
            // events per turn (thinking-only, then text). Accumulate thinking
            // and save only when text content arrives.
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

                if let Some(t) = event_thinking {
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
                    let msg = ChatMessage {
                        id: uuid::Uuid::new_v4().to_string(),
                        workspace_id: ws_id.clone(),
                        role: ChatRole::Assistant,
                        content: full_text,
                        cost_usd: None,
                        duration_ms: None,
                        created_at: now_iso(),
                        thinking: pending_thinking.take(),
                    };
                    let _ = db.insert_chat_message(&msg);
                }
            }

            // Update cost/duration.
            if let AgentEvent::Stream(StreamEvent::Result {
                ref total_cost_usd,
                ref duration_ms,
                ..
            }) = event
                && let (Some(cost), Some(dur)) = (total_cost_usd, duration_ms)
                && let Ok(db) = Database::open(&db_path)
                && let Ok(msgs) = db.list_chat_messages(&ws_id)
                && let Some(last) = msgs.iter().rfind(|m| m.role == ChatRole::Assistant)
            {
                let _ = db.update_chat_message_cost(&last.id, *cost, *dur);
            }

            // Emit event over WebSocket.
            let event_msg = json!({
                "event": "agent-stream",
                "payload": {
                    "workspace_id": ws_id,
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
    workspace_id: &str,
) -> Result<serde_json::Value, String> {
    let mut agents = state.agents.write().await;
    if let Some(session) = agents.get_mut(workspace_id)
        && let Some(pid) = session.active_pid.take()
    {
        agent::stop_agent(pid).await?;
    }

    let db = open_db(state)?;
    let msg = ChatMessage {
        id: uuid::Uuid::new_v4().to_string(),
        workspace_id: workspace_id.to_string(),
        role: ChatRole::System,
        content: "Agent stopped".to_string(),
        cost_usd: None,
        duration_ms: None,
        created_at: now_iso(),
        thinking: None,
    };
    db.insert_chat_message(&msg).map_err(|e| e.to_string())?;
    Ok(json!(null))
}

async fn handle_create_workspace(
    state: &ServerState,
    repository_id: &str,
    name: &str,
) -> Result<serde_json::Value, String> {
    let db = open_db(state)?;
    let repo = db
        .get_repository(repository_id)
        .map_err(|e| e.to_string())?
        .ok_or("Repository not found")?;

    let worktree_base_dir = state.worktree_base_dir.read().await;
    let branch_name = format!("{}/{}", repo.path_slug, name);
    let worktree_path = worktree_base_dir.join(&repo.path_slug).join(name);

    // Create git worktree.
    claudette::git::create_worktree(&repo.path, &branch_name, &worktree_path.to_string_lossy())
        .await
        .map_err(|e| format!("{e:?}"))?;

    let workspace = Workspace {
        id: uuid::Uuid::new_v4().to_string(),
        repository_id: repository_id.to_string(),
        name: name.to_string(),
        branch_name,
        worktree_path: Some(worktree_path.to_string_lossy().to_string()),
        status: WorkspaceStatus::Active,
        agent_status: claudette::model::AgentStatus::Idle,
        status_line: String::new(),
        created_at: now_iso(),
    };
    db.insert_workspace(&workspace).map_err(|e| e.to_string())?;

    Ok(serde_json::to_value(&workspace).unwrap_or_default())
}

async fn handle_archive_workspace(
    state: &ServerState,
    workspace_id: &str,
) -> Result<serde_json::Value, String> {
    // Stop any running agent before removing the worktree.
    {
        let mut agents = state.agents.write().await;
        if let Some(session) = agents.get_mut(workspace_id)
            && let Some(pid) = session.active_pid.take()
        {
            let _ = agent::stop_agent(pid).await;
        }
        agents.remove(workspace_id);
    }

    let db = open_db(state)?;
    db.update_workspace_status(workspace_id, &WorkspaceStatus::Archived, None)
        .map_err(|e| e.to_string())?;

    // Remove worktree.
    let workspaces = db.list_workspaces().map_err(|e| e.to_string())?;
    if let Some(ws) = workspaces.iter().find(|w| w.id == workspace_id)
        && let Some(ref path) = ws.worktree_path
    {
        let repo = db
            .get_repository(&ws.repository_id)
            .map_err(|e| e.to_string())?;
        if let Some(repo) = repo {
            let _ = claudette::git::remove_worktree(&repo.path, path, false).await;
        }
    }

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

    let base_branch = claudette::git::default_branch(&repo.path)
        .await
        .map_err(|e| format!("{e:?}"))?;

    let merge_base = claudette::diff::merge_base(worktree_path, "HEAD", &base_branch)
        .await
        .map_err(|e| format!("{e:?}"))?;

    let files = claudette::diff::changed_files(worktree_path, &merge_base)
        .await
        .map_err(|e| format!("{e:?}"))?;

    Ok(json!({
        "files": files,
        "merge_base": merge_base,
    }))
}

async fn handle_load_file_diff(
    worktree_path: &str,
    file_path: &str,
    merge_base: &str,
) -> Result<serde_json::Value, String> {
    let raw = claudette::diff::file_diff(worktree_path, merge_base, file_path)
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
        let repo_path = db
            .get_repository(&ws.repository_id)
            .ok()
            .flatten()
            .map(|r| r.path)
            .unwrap_or_default();
        let default_branch = claudette::git::default_branch(&repo_path)
            .await
            .unwrap_or_else(|_| "main".into());
        let ws_env = claudette::env::WorkspaceEnv::from_workspace(ws, &repo_path, default_branch);
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
