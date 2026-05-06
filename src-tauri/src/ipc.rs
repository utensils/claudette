//! Local IPC server the running GUI exposes for the `claudette` CLI.
//!
//! Mirrors [`claudette::agent_mcp::bridge`] in shape: a long-running
//! `interprocess` listener bound to a Unix domain socket (or Windows
//! named pipe), line-delimited JSON-RPC-inspired framing (see
//! [`claudette::rpc`] — request/response shapes match JSON-RPC 2.0 but
//! intentionally omit the `"jsonrpc": "2.0"` discriminator), and a
//! per-connection task that authenticates via a shared bearer token
//! before dispatching.
//!
//! The CLI discovers the socket + token by reading the discovery file
//! from [`crate::app_info`]. Authentication is defense in depth — the
//! socket file is created mode 0600 (Unix) or in the per-user pipe
//! namespace (Windows), so the primary boundary is filesystem
//! permissions, not the token.
//!
//! Method dispatch lives in [`dispatch`]; each method maps to a handler
//! that calls into [`claudette::ops`] (or the relevant DB query for
//! pure-read operations). The `capabilities` method advertises the full
//! method list so CLI users can discover available operations without
//! out-of-band documentation.

use std::path::PathBuf;
use std::sync::Arc;

use claudette::base64_encode;
use claudette::db::Database;
use claudette::model::{
    AgentStatus, Attachment, AttachmentOrigin, ChatMessage, ChatRole, ChatSession,
    CompletedTurnData,
};
use claudette::plugin_runtime::host_api::WorkspaceInfo;
use claudette::rpc::{Capabilities, RpcRequest, RpcResponse};
use claudette::scm::detect;
use interprocess::local_socket::tokio::{Stream, prelude::*};
#[cfg(unix)]
use interprocess::local_socket::{GenericFilePath, ToFsName};
#[cfg(windows)]
use interprocess::local_socket::{GenericNamespaced, ToNsName};
use interprocess::local_socket::{ListenerOptions, Name};
use rand::RngCore;
use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use crate::state::AppState;

/// Wire-protocol identifier sent in the `capabilities` response. Distinct
/// from the WS server's `"claudette-ws"` so a single client can detect
/// which surface it's talking to.
const PROTOCOL_NAME: &str = "claudette-ipc";
/// Bumps when the IPC wire format changes in a backwards-incompatible way.
const PROTOCOL_VERSION: u32 = 1;

/// All methods this server accepts. Listed once so [`capabilities`]
/// dispatch and the [`dispatch`] router stay in sync — adding a method
/// means appending to this list and adding a match arm in `dispatch`.
const METHODS: &[&str] = &[
    "capabilities",
    "version",
    "list_repositories",
    "list_workspaces",
    "list_chat_sessions",
    "get_chat_session",
    "get_chat_snapshot",
    "load_completed_turns",
    "load_attachments_for_session",
    "load_attachment_data",
    "create_chat_session",
    "rename_chat_session",
    "archive_chat_session",
    "create_workspace",
    "archive_workspace",
    "send_chat_message",
    "steer_queued_chat_message",
    "stop_agent",
    "reset_agent_session",
    "clear_attention",
    "submit_agent_answer",
    "submit_plan_approval",
    "plugin.list",
    "plugin.invoke",
    "scm.detect_provider",
];

const DEFAULT_CHAT_SNAPSHOT_LIMIT: i64 = 50;
const MAX_CHAT_SNAPSHOT_LIMIT: i64 = 200;
const MAX_TEXT_ATTACHMENT_INLINE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
struct ChatSnapshot {
    session: ChatSession,
    messages: Vec<ChatMessage>,
    attachments: Vec<IpcAttachment>,
    completed_turns: Vec<CompletedTurnData>,
    pending_controls: Vec<PendingAgentControl>,
    has_more: bool,
    total_count: i64,
}

#[derive(Debug, Clone, Serialize)]
struct IpcAttachment {
    id: String,
    message_id: String,
    filename: String,
    media_type: String,
    text_content: Option<String>,
    width: Option<i32>,
    height: Option<i32>,
    size_bytes: i64,
    origin: AttachmentOrigin,
    tool_use_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
struct PendingAgentControl {
    tool_use_id: String,
    tool_name: String,
    input: serde_json::Value,
    kind: PendingAgentControlKind,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum PendingAgentControlKind {
    AskUserQuestion,
    ExitPlanMode,
    Unknown,
}

/// Live IPC server. Drop to tear down the listener and remove the socket
/// file (Unix) — same RAII model as `agent_mcp::bridge::McpBridgeSession`.
pub struct IpcServer {
    /// Resolved socket address — Unix domain socket path or Windows
    /// named pipe name.
    pub socket: String,
    /// Bearer token clients pass on each request.
    pub token: String,
    cancel_tx: Option<oneshot::Sender<()>>,
    listener_task: Option<JoinHandle<()>>,
    /// Unix only: the socket file path so `Drop` can unlink it. `None`
    /// on Windows where named pipes vanish with the listener handle.
    socket_file_path: Option<PathBuf>,
}

impl IpcServer {
    /// Bind a per-app socket and start accepting CLI connections.
    /// Spawns one tokio task per accepted connection.
    pub async fn start(app: AppHandle) -> Result<Self, String> {
        let app_uuid = uuid::Uuid::new_v4().to_string();
        let token = generate_token();
        let (socket_addr, socket_file_path) = make_socket_address(&app_uuid)?;
        let name = name_for(&socket_addr)?;

        let listener = ListenerOptions::new()
            .name(name)
            .create_tokio()
            .map_err(|e| format!("bind socket {socket_addr}: {e}"))?;

        // Tighten the bound socket file to 0600 so only this user can
        // connect — the module-level threat model promises a filesystem
        // permission boundary, and `interprocess`'s default bind path
        // doesn't enforce it. Best-effort: a failure here is logged but
        // not fatal, since the bearer token still gates access.
        #[cfg(unix)]
        if let Some(ref path) = socket_file_path {
            use std::os::unix::fs::PermissionsExt;
            if let Err(e) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)) {
                eprintln!("[ipc] chmod 0600 {} failed: {e}", path.display());
            }
        }

        let (cancel_tx, cancel_rx) = oneshot::channel::<()>();
        let task_token = token.clone();
        let task_app = app.clone();
        let listener_task = tokio::spawn(async move {
            run_listener(listener, task_token, task_app, cancel_rx).await;
        });

        Ok(Self {
            socket: socket_addr,
            token,
            cancel_tx: Some(cancel_tx),
            listener_task: Some(listener_task),
            socket_file_path,
        })
    }
}

impl Drop for IpcServer {
    fn drop(&mut self) {
        if let Some(tx) = self.cancel_tx.take() {
            let _ = tx.send(());
        }
        if let Some(task) = self.listener_task.take() {
            task.abort();
        }
        if let Some(path) = self.socket_file_path.take() {
            let _ = std::fs::remove_file(&path);
        }
    }
}

fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Decide the socket address. Unix: short file under
/// `${TMPDIR}/cclt-<uid>/` — `claudette-cli` would push past macOS's
/// 104-byte `sun_path` limit when TMPDIR is the long
/// `/var/folders/.../T/` form, so a terse directory + 8-char id is used.
/// The uid suffix scopes the directory to a single user even when
/// TMPDIR is shared (e.g. `/tmp` on Linux), so chmod-to-0700 below
/// doesn't lock other users out of binding their own sockets.
/// Windows: a namespaced pipe name (per-user namespace by OS default).
fn make_socket_address(app_uuid: &str) -> Result<(String, Option<PathBuf>), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let short_id: String = app_uuid.chars().take(8).collect();
        // SAFETY: getuid() is async-signal-safe and never fails.
        let uid = unsafe { libc::getuid() };
        let dir = std::env::temp_dir().join(format!("cclt-{uid}"));
        std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
        // Tighten the directory to 0700. The module-level threat model
        // names filesystem permissions as the primary auth boundary;
        // a default-umask 0755 (or 0777 on some Linux setups) would let
        // other local users enumerate / DoS the socket dir even though
        // they couldn't read the bearer token.
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
        let path = dir.join(format!("{short_id}.sock"));
        // Pre-clean any stale file (e.g. from a crashed parent).
        let _ = std::fs::remove_file(&path);
        let path_str = path
            .to_str()
            .ok_or_else(|| "socket path is not valid UTF-8".to_string())?
            .to_string();
        Ok((path_str, Some(path)))
    }
    #[cfg(windows)]
    {
        let name = format!("claudette-cli-{app_uuid}");
        Ok((name, None))
    }
}

fn name_for(addr: &str) -> Result<Name<'static>, String> {
    let owned = addr.to_string();
    #[cfg(unix)]
    {
        owned
            .to_fs_name::<GenericFilePath>()
            .map_err(|e| format!("fs name {addr}: {e}"))
    }
    #[cfg(windows)]
    {
        owned
            .to_ns_name::<GenericNamespaced>()
            .map_err(|e| format!("ns name {addr}: {e}"))
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = owned;
        Err("unsupported platform".into())
    }
}

async fn run_listener(
    listener: interprocess::local_socket::tokio::Listener,
    token: String,
    app: AppHandle,
    mut cancel_rx: oneshot::Receiver<()>,
) {
    loop {
        let conn = tokio::select! {
            _ = &mut cancel_rx => return,
            res = listener.accept() => match res {
                Ok(c) => c,
                Err(_) => return,
            },
        };
        let token = token.clone();
        let app = app.clone();
        tokio::spawn(async move {
            let _ = handle_connection(conn, token, app).await;
        });
    }
}

/// Per-request line-length ceiling. Even on a 0700/0600 uid-scoped
/// socket, an unbounded `read_line` lets any same-uid process drive
/// memory growth by streaming bytes without a `\n`. 1 MiB is well above
/// any legitimate request shape (largest in flight today is a chat
/// `content` body, capped well below this client-side).
const MAX_REQUEST_BYTES: u64 = 1024 * 1024;

async fn handle_connection(
    conn: Stream,
    expected_token: String,
    app: AppHandle,
) -> std::io::Result<()> {
    let mut reader = BufReader::new(&conn);
    let mut writer = &conn;
    let mut line = String::new();

    loop {
        line.clear();
        let n = (&mut reader)
            .take(MAX_REQUEST_BYTES + 1)
            .read_line(&mut line)
            .await?;
        if n == 0 {
            return Ok(()); // peer closed
        }
        if n as u64 > MAX_REQUEST_BYTES {
            let resp = RpcResponse::err(
                serde_json::Value::Null,
                format!("request exceeds {MAX_REQUEST_BYTES}-byte limit"),
            );
            let mut bytes = serde_json::to_vec(&resp).unwrap_or_else(|_| b"{}".to_vec());
            bytes.push(b'\n');
            let _ = writer.write_all(&bytes).await;
            let _ = writer.flush().await;
            return Ok(());
        }

        let response = match serde_json::from_str::<TokenedRequest>(line.trim()) {
            Err(e) => RpcResponse::err(serde_json::Value::Null, format!("bad request: {e}")),
            Ok(req) if req.token != expected_token => {
                RpcResponse::err(req.request.id.clone(), "unauthorized")
            }
            Ok(req) => dispatch(&app, req.request).await,
        };

        let mut bytes = serde_json::to_vec(&response).unwrap_or_else(|_| b"{}".to_vec());
        bytes.push(b'\n');
        writer.write_all(&bytes).await?;
        writer.flush().await?;
    }
}

/// Wraps an [`RpcRequest`] with the bearer token expected by the IPC
/// server. The CLI client sends one of these per request — separating
/// transport auth from the inner JSON-RPC envelope keeps the protocol
/// useful as a base for future surfaces.
#[derive(Debug, serde::Deserialize)]
struct TokenedRequest {
    token: String,
    #[serde(flatten)]
    request: RpcRequest,
}

/// Method router. Each arm calls into `claudette::ops` (or a direct DB
/// query for pure-read operations) and returns an `RpcResponse`. Any
/// unknown method returns an error that the client surfaces as-is.
async fn dispatch(app: &AppHandle, req: RpcRequest) -> RpcResponse {
    let id = req.id.clone();
    let result = match req.method.as_str() {
        "capabilities" => Ok(serde_json::to_value(&Capabilities {
            protocol: PROTOCOL_NAME.to_string(),
            version: PROTOCOL_VERSION,
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            methods: {
                // `Capabilities.methods` is documented as a sorted list
                // (see `claudette::rpc`). `METHODS` is in declaration
                // order for readability — sort here so the wire response
                // matches the contract.
                let mut m: Vec<String> = METHODS.iter().map(|s| s.to_string()).collect();
                m.sort();
                m
            },
        })
        .unwrap_or(serde_json::Value::Null)),
        "version" => Ok(json!({ "version": env!("CARGO_PKG_VERSION") })),
        "list_repositories" => with_db(app, |db| {
            db.list_repositories()
                .map(|v| serde_json::to_value(v).unwrap_or_default())
                .map_err(|e| e.to_string())
        }),
        "list_workspaces" => with_db(app, |db| {
            db.list_workspaces()
                .map(|v| serde_json::to_value(v).unwrap_or_default())
                .map_err(|e| e.to_string())
        }),
        "list_chat_sessions" => handle_list_chat_sessions(app, &req.params).await,
        "get_chat_session" => handle_get_chat_session(app, &req.params).await,
        "get_chat_snapshot" => handle_get_chat_snapshot(app, &req.params).await,
        "load_completed_turns" => handle_load_completed_turns(app, &req.params),
        "load_attachments_for_session" => handle_load_attachments_for_session(app, &req.params),
        "load_attachment_data" => handle_load_attachment_data(app, &req.params),
        "create_chat_session" => handle_create_chat_session(app, &req.params).await,
        "rename_chat_session" => handle_rename_chat_session(app, &req.params).await,
        "archive_chat_session" => handle_archive_chat_session(app, &req.params).await,
        "create_workspace" => handle_create_workspace(app, &req.params).await,
        "archive_workspace" => handle_archive_workspace(app, &req.params).await,
        "send_chat_message" => handle_send_chat_message(app, &req.params).await,
        "steer_queued_chat_message" => handle_steer_queued_chat_message(app, &req.params).await,
        "stop_agent" => handle_stop_agent(app, &req.params).await,
        "reset_agent_session" => handle_reset_agent_session(app, &req.params).await,
        "clear_attention" => handle_clear_attention(app, &req.params).await,
        "submit_agent_answer" => handle_submit_agent_answer(app, &req.params).await,
        "submit_plan_approval" => handle_submit_plan_approval(app, &req.params).await,
        "plugin.list" => handle_plugin_list(app).await,
        "plugin.invoke" => handle_plugin_invoke(app, &req.params).await,
        "scm.detect_provider" => handle_scm_detect_provider(app, &req.params).await,
        other => Err(format!("Unknown method: {other}")),
    };
    match result {
        Ok(value) => RpcResponse::ok(id, value),
        Err(msg) => RpcResponse::err(id, msg),
    }
}

/// Helper for sync DB operations. Opens a fresh connection (mirrors the
/// convention in `commands/`), passes it to `f`, and converts the result.
fn with_db<F>(app: &AppHandle, f: F) -> Result<serde_json::Value, String>
where
    F: FnOnce(&Database) -> Result<serde_json::Value, String>,
{
    let state = app
        .try_state::<AppState>()
        .ok_or_else(|| "AppState not initialised".to_string())?;
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    f(&db)
}

/// Delegates to the shared `commands::workspace::create_workspace_inner`
/// helper so CLI- and remote-driven creates run the same setup-script +
/// env-provider pipeline as the GUI button. Without that, batch runs
/// would dispatch agent prompts into uninitialized worktrees.
async fn handle_create_workspace(
    app: &AppHandle,
    params: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let repo_id = params
        .get("repo_id")
        .and_then(|v| v.as_str())
        .ok_or("missing repo_id")?;
    let name = params
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or("missing name")?;
    let skip_setup = params
        .get("skip_setup")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let state = app
        .try_state::<AppState>()
        .ok_or_else(|| "AppState not initialised".to_string())?;

    let result =
        crate::commands::workspace::create_workspace_inner(repo_id, name, skip_setup, app, &state)
            .await?;

    Ok(json!({
        "workspace": result.workspace,
        "default_session_id": result.default_session_id,
        "setup_result": result.setup_result,
    }))
}

fn param_chat_session_id(params: &serde_json::Value) -> Result<String, String> {
    params
        .get("chat_session_id")
        .or_else(|| params.get("session_id"))
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or_else(|| "missing session_id".to_string())
}

fn hydrate_session(
    mut session: ChatSession,
    agents: &std::collections::HashMap<String, crate::state::AgentSessionState>,
) -> ChatSession {
    if let Some(agent) = agents.get(&session.id) {
        session.agent_status = if agent.active_pid.is_some() {
            AgentStatus::Running
        } else if !agent.running_background_tasks.is_empty() {
            AgentStatus::IdleWithBackground
        } else {
            AgentStatus::Idle
        };
        session.needs_attention = agent.needs_attention;
        session.attention_kind = agent.attention_kind.map(|k| match k {
            crate::state::AttentionKind::Ask => claudette::model::AttentionKind::Ask,
            crate::state::AttentionKind::Plan => claudette::model::AttentionKind::Plan,
        });
    }
    session
}

fn pending_controls_for_session(
    agent: Option<&crate::state::AgentSessionState>,
) -> Vec<PendingAgentControl> {
    let Some(agent) = agent else {
        return Vec::new();
    };
    let mut out: Vec<PendingAgentControl> = agent
        .pending_permissions
        .iter()
        .map(|(tool_use_id, pending)| PendingAgentControl {
            tool_use_id: tool_use_id.clone(),
            tool_name: pending.tool_name.clone(),
            input: pending.original_input.clone(),
            kind: match pending.tool_name.as_str() {
                "AskUserQuestion" => PendingAgentControlKind::AskUserQuestion,
                "ExitPlanMode" => PendingAgentControlKind::ExitPlanMode,
                _ => PendingAgentControlKind::Unknown,
            },
        })
        .collect();
    out.sort_by(|a, b| a.tool_use_id.cmp(&b.tool_use_id));
    out
}

fn safe_attachment(att: Attachment) -> IpcAttachment {
    let text_content = if is_text_attachment(&att.media_type)
        && att.data.len() <= MAX_TEXT_ATTACHMENT_INLINE_BYTES
    {
        std::str::from_utf8(&att.data).ok().map(str::to_owned)
    } else {
        None
    };
    IpcAttachment {
        id: att.id,
        message_id: att.message_id,
        filename: att.filename,
        media_type: att.media_type,
        text_content,
        width: att.width,
        height: att.height,
        size_bytes: att.size_bytes,
        origin: att.origin,
        tool_use_id: att.tool_use_id,
    }
}

fn is_text_attachment(media_type: &str) -> bool {
    matches!(
        media_type,
        "text/plain" | "text/csv" | "text/markdown" | "application/json"
    )
}

fn clamp_snapshot_limit(params: &serde_json::Value) -> i64 {
    params
        .get("limit")
        .and_then(|v| v.as_i64())
        .unwrap_or(DEFAULT_CHAT_SNAPSHOT_LIMIT)
        .clamp(1, MAX_CHAT_SNAPSHOT_LIMIT)
}

fn load_safe_attachments_for_message_ids(
    db: &Database,
    message_ids: &[String],
    carry_over_user_id: Option<&str>,
) -> Result<Vec<IpcAttachment>, String> {
    let att_map = db
        .list_attachments_for_messages(message_ids)
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for (msg_id, atts) in att_map {
        let is_carry_over = carry_over_user_id == Some(msg_id.as_str());
        for att in atts {
            if is_carry_over && att.origin != AttachmentOrigin::Agent {
                continue;
            }
            out.push(safe_attachment(att));
        }
    }
    out.sort_by(|a, b| {
        a.message_id
            .cmp(&b.message_id)
            .then_with(|| a.filename.cmp(&b.filename))
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(out)
}

fn build_chat_snapshot(
    db: &Database,
    session: ChatSession,
    messages: Vec<ChatMessage>,
    limit: i64,
    before_message_id: Option<&str>,
    pending_controls: Vec<PendingAgentControl>,
) -> Result<ChatSnapshot, String> {
    let total_count = db
        .count_chat_messages_for_session(&session.id)
        .map_err(|e| e.to_string())?;

    let has_more = match before_message_id {
        None => total_count > messages.len() as i64,
        Some(_) => messages.len() as i64 == limit,
    };

    let mut message_ids: Vec<String> = messages.iter().map(|m| m.id.clone()).collect();
    let mut carry_over_user_id: Option<String> = None;
    if let Some(first) = messages.first()
        && first.role != ChatRole::User
        && let Some(prev_user) = db
            .previous_user_message_id(&session.id, &first.id)
            .map_err(|e| e.to_string())?
    {
        message_ids.push(prev_user.clone());
        carry_over_user_id = Some(prev_user);
    }

    let attachments =
        load_safe_attachments_for_message_ids(db, &message_ids, carry_over_user_id.as_deref())?;
    let completed_turns = db
        .list_completed_turns_for_session(&session.id)
        .map_err(|e| e.to_string())?;

    Ok(ChatSnapshot {
        session,
        messages,
        attachments,
        completed_turns,
        pending_controls,
        has_more,
        total_count,
    })
}

/// `list_chat_sessions` IPC method — read-only DB query for a single
/// workspace's sessions, overlaid with live agent state.
async fn handle_list_chat_sessions(
    app: &AppHandle,
    params: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let workspace_id = params
        .get("workspace_id")
        .and_then(|v| v.as_str())
        .ok_or("missing workspace_id")?
        .to_string();
    let include_archived = params
        .get("include_archived")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let state = app
        .try_state::<AppState>()
        .ok_or_else(|| "AppState not initialised".to_string())?;
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let sessions = db
        .list_chat_sessions_for_workspace(&workspace_id, include_archived)
        .map_err(|e| e.to_string())?;
    let agents = state.agents.read().await;
    let hydrated: Vec<ChatSession> = sessions
        .into_iter()
        .map(|s| hydrate_session(s, &agents))
        .collect();
    serde_json::to_value(hydrated).map_err(|e| e.to_string())
}

async fn handle_get_chat_session(
    app: &AppHandle,
    params: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let chat_session_id = param_chat_session_id(params)?;
    let state = app
        .try_state::<AppState>()
        .ok_or_else(|| "AppState not initialised".to_string())?;
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let session = db
        .get_chat_session(&chat_session_id)
        .map_err(|e| e.to_string())?
        .ok_or("Session not found")?;
    let agents = state.agents.read().await;
    serde_json::to_value(hydrate_session(session, &agents)).map_err(|e| e.to_string())
}

async fn handle_get_chat_snapshot(
    app: &AppHandle,
    params: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let chat_session_id = param_chat_session_id(params)?;
    let limit = clamp_snapshot_limit(params);
    let before_message_id = params
        .get("before_message_id")
        .or_else(|| params.get("beforeMessageId"))
        .and_then(|v| v.as_str())
        .map(String::from);

    let state = app
        .try_state::<AppState>()
        .ok_or_else(|| "AppState not initialised".to_string())?;
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let session = db
        .get_chat_session(&chat_session_id)
        .map_err(|e| e.to_string())?
        .ok_or("Session not found")?;
    let messages = db
        .list_chat_messages_page(&chat_session_id, limit, before_message_id.as_deref())
        .map_err(|e| e.to_string())?;
    let agents = state.agents.read().await;
    let pending_controls = pending_controls_for_session(agents.get(&chat_session_id));
    let session = hydrate_session(session, &agents);
    drop(agents);

    let snapshot = build_chat_snapshot(
        &db,
        session,
        messages,
        limit,
        before_message_id.as_deref(),
        pending_controls,
    )?;
    serde_json::to_value(snapshot).map_err(|e| e.to_string())
}

fn handle_load_completed_turns(
    app: &AppHandle,
    params: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let chat_session_id = param_chat_session_id(params)?;
    with_db(app, |db| {
        db.list_completed_turns_for_session(&chat_session_id)
            .map(|v| serde_json::to_value(v).unwrap_or_default())
            .map_err(|e| e.to_string())
    })
}

fn handle_load_attachments_for_session(
    app: &AppHandle,
    params: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let chat_session_id = param_chat_session_id(params)?;
    with_db(app, |db| {
        let messages = db
            .list_chat_messages_for_session(&chat_session_id)
            .map_err(|e| e.to_string())?;
        let message_ids: Vec<String> = messages.iter().map(|m| m.id.clone()).collect();
        let attachments = load_safe_attachments_for_message_ids(db, &message_ids, None)?;
        serde_json::to_value(attachments).map_err(|e| e.to_string())
    })
}

fn handle_load_attachment_data(
    app: &AppHandle,
    params: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let attachment_id = params
        .get("attachment_id")
        .or_else(|| params.get("attachmentId"))
        .and_then(|v| v.as_str())
        .ok_or("missing attachment_id")?;
    with_db(app, |db| {
        let att = db
            .get_attachment(attachment_id)
            .map_err(|e| e.to_string())?
            .ok_or("Attachment not found")?;
        Ok(json!(base64_encode(&att.data)))
    })
}

async fn handle_create_chat_session(
    app: &AppHandle,
    params: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let workspace_id = params
        .get("workspace_id")
        .and_then(|v| v.as_str())
        .ok_or("missing workspace_id")?
        .to_string();
    let state: tauri::State<'_, AppState> = app.state::<AppState>();
    let session = crate::commands::chat::session::create_chat_session(workspace_id, state).await?;
    serde_json::to_value(session).map_err(|e| e.to_string())
}

async fn handle_rename_chat_session(
    app: &AppHandle,
    params: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let chat_session_id = param_chat_session_id(params)?;
    let name = params
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or("missing name")?
        .to_string();
    let state: tauri::State<'_, AppState> = app.state::<AppState>();
    crate::commands::chat::session::rename_chat_session(chat_session_id, name, state).await?;
    Ok(json!({ "ok": true }))
}

async fn handle_archive_chat_session(
    app: &AppHandle,
    params: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let chat_session_id = param_chat_session_id(params)?;
    let state: tauri::State<'_, AppState> = app.state::<AppState>();
    let fresh =
        crate::commands::chat::session::archive_chat_session(app.clone(), chat_session_id, state)
            .await?;
    serde_json::to_value(fresh).map_err(|e| e.to_string())
}

/// `send_chat_message` IPC method — delegates to the existing Tauri
/// command so CLI-driven prompts trigger the same agent-spawn flow,
/// streaming, and event emission as a GUI-driven send. Tauri commands
/// are callable from Rust as plain async fns; we construct the
/// `State` extractor from the `AppHandle` to satisfy the signature.
///
/// Only the most common params are surfaced today (`session_id`,
/// `content`, `model`, `plan_mode`). Adding more is just a matter of
/// pulling them off `params` and threading them through.
async fn handle_send_chat_message(
    app: &AppHandle,
    params: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let parsed = parse_send_chat_params(params)?;

    let state: tauri::State<'_, AppState> = app.state::<AppState>();
    crate::commands::chat::send::send_chat_message(
        parsed.session_id,
        parsed.message_id,
        parsed.content,
        parsed.mentioned_files,
        parsed.permission_level,
        parsed.model,
        parsed.fast_mode,
        parsed.thinking_enabled,
        parsed.plan_mode,
        parsed.effort,
        parsed.chrome_enabled,
        parsed.disable_1m_context,
        parsed.attachments,
        app.clone(),
        state,
    )
    .await?;
    Ok(json!({ "ok": true }))
}

/// Every agent setting the GUI's chat input bar can flip, modeled here
/// so the IPC surface (and therefore the `claudette` CLI) can drive a
/// turn with the same fidelity as the GUI's "Send" button. Mirrors
/// `AgentSettings` 1:1 — a new field there should grow a field here.
#[derive(Default)]
pub(crate) struct SendChatParams {
    pub session_id: String,
    pub message_id: Option<String>,
    pub content: String,
    pub mentioned_files: Option<Vec<String>>,
    pub model: Option<String>,
    pub fast_mode: Option<bool>,
    pub thinking_enabled: Option<bool>,
    pub plan_mode: Option<bool>,
    pub effort: Option<String>,
    pub chrome_enabled: Option<bool>,
    pub disable_1m_context: Option<bool>,
    pub permission_level: Option<String>,
    pub attachments: Option<Vec<crate::commands::chat::AttachmentInput>>,
}

/// Parse the JSON params object the IPC sends. Tolerant of both
/// `session_id` and `chat_session_id` so older clients (and the WS
/// server's wire shape) keep working. Omitted agent-setting booleans
/// default to `false` (the GUI toolbar lives in the React store and is
/// not visible from this dispatch path); pass them explicitly to
/// override.
pub(crate) fn parse_send_chat_params(params: &serde_json::Value) -> Result<SendChatParams, String> {
    let session_id = params
        .get("session_id")
        .or_else(|| params.get("chat_session_id"))
        .and_then(|v| v.as_str())
        .ok_or("missing session_id")?
        .to_string();
    let content = params
        .get("content")
        .and_then(|v| v.as_str())
        .ok_or("missing content")?
        .to_string();
    let str_param = |key: &str| params.get(key).and_then(|v| v.as_str()).map(String::from);
    let bool_param = |key: &str| params.get(key).and_then(|v| v.as_bool());
    Ok(SendChatParams {
        session_id,
        message_id: str_param("message_id").or_else(|| str_param("messageId")),
        content,
        mentioned_files: params
            .get("mentioned_files")
            .or_else(|| params.get("mentionedFiles"))
            .and_then(|v| serde_json::from_value(v.clone()).ok()),
        model: str_param("model"),
        fast_mode: bool_param("fast_mode"),
        thinking_enabled: bool_param("thinking_enabled"),
        plan_mode: bool_param("plan_mode"),
        effort: str_param("effort"),
        chrome_enabled: bool_param("chrome_enabled"),
        disable_1m_context: bool_param("disable_1m_context"),
        permission_level: str_param("permission_level"),
        attachments: params
            .get("attachments")
            .and_then(|v| serde_json::from_value(v.clone()).ok()),
    })
}

async fn handle_steer_queued_chat_message(
    app: &AppHandle,
    params: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let chat_session_id = param_chat_session_id(params)?;
    let content = params
        .get("content")
        .and_then(|v| v.as_str())
        .ok_or("missing content")?
        .to_string();
    let message_id = params
        .get("message_id")
        .or_else(|| params.get("messageId"))
        .and_then(|v| v.as_str())
        .map(String::from);
    let mentioned_files = params
        .get("mentioned_files")
        .or_else(|| params.get("mentionedFiles"))
        .and_then(|v| serde_json::from_value(v.clone()).ok());
    let attachments = params
        .get("attachments")
        .and_then(|v| serde_json::from_value(v.clone()).ok());
    let state: tauri::State<'_, AppState> = app.state::<AppState>();
    let checkpoint = crate::commands::chat::send::steer_queued_chat_message(
        chat_session_id,
        message_id,
        content,
        mentioned_files,
        attachments,
        state,
    )
    .await?;
    serde_json::to_value(checkpoint).map_err(|e| e.to_string())
}

async fn handle_stop_agent(
    app: &AppHandle,
    params: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let chat_session_id = param_chat_session_id(params)?;
    let state: tauri::State<'_, AppState> = app.state::<AppState>();
    crate::commands::chat::lifecycle::stop_agent(chat_session_id, app.clone(), state).await?;
    Ok(json!({ "ok": true }))
}

async fn handle_reset_agent_session(
    app: &AppHandle,
    params: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let chat_session_id = param_chat_session_id(params)?;
    let state: tauri::State<'_, AppState> = app.state::<AppState>();
    crate::commands::chat::lifecycle::reset_agent_session(chat_session_id, app.clone(), state)
        .await?;
    Ok(json!({ "ok": true }))
}

async fn handle_clear_attention(
    app: &AppHandle,
    params: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let chat_session_id = param_chat_session_id(params)?;
    let state: tauri::State<'_, AppState> = app.state::<AppState>();
    crate::commands::chat::interaction::clear_attention(chat_session_id, app.clone(), state)
        .await?;
    Ok(json!({ "ok": true }))
}

async fn handle_submit_agent_answer(
    app: &AppHandle,
    params: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let chat_session_id = param_chat_session_id(params)?;
    let tool_use_id = params
        .get("tool_use_id")
        .or_else(|| params.get("toolUseId"))
        .and_then(|v| v.as_str())
        .ok_or("missing tool_use_id")?
        .to_string();
    let answers: std::collections::HashMap<String, String> = params
        .get("answers")
        .cloned()
        .ok_or_else(|| "missing answers".to_string())
        .and_then(|v| serde_json::from_value(v).map_err(|e| e.to_string()))?;
    let annotations = params.get("annotations").cloned();
    let state: tauri::State<'_, AppState> = app.state::<AppState>();
    crate::commands::chat::interaction::submit_agent_answer(
        chat_session_id,
        tool_use_id,
        answers,
        annotations,
        state,
    )
    .await?;
    Ok(json!({ "ok": true }))
}

async fn handle_submit_plan_approval(
    app: &AppHandle,
    params: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let chat_session_id = param_chat_session_id(params)?;
    let tool_use_id = params
        .get("tool_use_id")
        .or_else(|| params.get("toolUseId"))
        .and_then(|v| v.as_str())
        .ok_or("missing tool_use_id")?
        .to_string();
    let approved = params
        .get("approved")
        .and_then(|v| v.as_bool())
        .ok_or("missing approved")?;
    let reason = params
        .get("reason")
        .and_then(|v| v.as_str())
        .map(String::from);
    let state: tauri::State<'_, AppState> = app.state::<AppState>();
    crate::commands::chat::interaction::submit_plan_approval(
        chat_session_id,
        tool_use_id,
        approved,
        reason,
        state,
    )
    .await?;
    Ok(json!({ "ok": true }))
}

/// Delegates to the shared `commands::workspace::archive_workspace_inner`
/// helper so CLI-driven archives perform the same agent process
/// teardown, env-watcher cleanup, and MCP supervisor shutdown the GUI
/// does. The optional `delete_branch` payload field overrides the GUI's
/// `git_delete_branch_on_archive` setting per-call — `claudette workspace
/// archive --delete-branch` must work even when the GUI setting is off.
/// Omit the field to let the GUI setting decide.
async fn handle_archive_workspace(
    app: &AppHandle,
    params: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let workspace_id = params
        .get("workspace_id")
        .and_then(|v| v.as_str())
        .ok_or("missing workspace_id")?;
    let delete_branch_override = params.get("delete_branch").and_then(|v| v.as_bool());

    let state = app
        .try_state::<AppState>()
        .ok_or_else(|| "AppState not initialised".to_string())?;
    let supervisor = app
        .try_state::<Arc<claudette::mcp_supervisor::McpSupervisor>>()
        .ok_or_else(|| "McpSupervisor not initialised".to_string())?;

    let out = crate::commands::workspace::archive_workspace_inner(
        workspace_id,
        delete_branch_override,
        app,
        &state,
        supervisor.inner(),
    )
    .await?;

    Ok(json!({
        "branch_deleted": out.branch_deleted,
        "was_last_workspace": out.was_last_workspace,
        "worktree_path": out.worktree_path,
        "repository_id": out.repository_id,
        "delete_branch": out.delete_branch,
    }))
}

/// `plugin.list` IPC method — snapshot of every discovered Lua plugin
/// the running GUI knows about. The CLI uses this to populate generic
/// `plugin invoke` tab-completion hints and to surface friendly per-kind
/// shortcuts (`claudette pr …`) only when a matching provider is loaded.
async fn handle_plugin_list(app: &AppHandle) -> Result<serde_json::Value, String> {
    let state = app
        .try_state::<AppState>()
        .ok_or_else(|| "AppState not initialised".to_string())?;
    let registry = state.plugins.read().await;
    let mut out: Vec<serde_json::Value> = registry
        .plugins
        .values()
        .map(|p| {
            json!({
                "name": p.manifest.name,
                "display_name": p.manifest.display_name,
                "version": p.manifest.version,
                "description": p.manifest.description,
                "kind": p.manifest.kind,
                "operations": p.manifest.operations,
                "remote_patterns": p.manifest.remote_patterns,
                "required_clis": p.manifest.required_clis,
                "cli_available": p.cli_available,
                "enabled": !registry.is_disabled(&p.manifest.name),
            })
        })
        .collect();
    out.sort_by(|a, b| {
        a.get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .cmp(b.get("name").and_then(|v| v.as_str()).unwrap_or(""))
    });
    Ok(serde_json::Value::Array(out))
}

/// `plugin.invoke` IPC method — calls a plugin operation in the running
/// GUI's `PluginRegistry`. The workspace context is required: plugins
/// resolve paths and arguments relative to a worktree, and the host_api
/// surface (`workspace.path`, `workspace.branch`, …) reads from
/// [`WorkspaceInfo`].
///
/// Errors propagate verbatim from [`claudette::plugin_runtime::PluginError`]
/// — `CliNotFound`, `NeedsReconsent`, `OperationNotSupported`, etc. are
/// already serialized via `Display`, so the CLI surfaces them unchanged.
async fn handle_plugin_invoke(
    app: &AppHandle,
    params: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let plugin_name = params
        .get("plugin")
        .and_then(|v| v.as_str())
        .ok_or("missing plugin")?
        .to_string();
    let operation = params
        .get("operation")
        .and_then(|v| v.as_str())
        .ok_or("missing operation")?
        .to_string();
    let workspace_id = params
        .get("workspace_id")
        .and_then(|v| v.as_str())
        .ok_or("missing workspace_id")?
        .to_string();
    let args = params.get("args").cloned().unwrap_or(json!({}));

    let state = app
        .try_state::<AppState>()
        .ok_or_else(|| "AppState not initialised".to_string())?;

    let ws_info = build_workspace_info(&state.db_path, &workspace_id)?;
    let registry = state.plugins.read().await;
    registry
        .call_operation(&plugin_name, &operation, args, ws_info)
        .await
        .map_err(|e| e.to_string())
}

/// `scm.detect_provider` IPC method — returns the active SCM provider
/// name for a repo, honoring any manual override the user set in
/// settings before falling back to remote-URL hostname matching.
///
/// Mirrors the resolution path in [`crate::commands::scm::get_scm_provider`]
/// so CLI and GUI agree on which plugin handles a given repo. Returns
/// `null` when no provider matches (e.g. plugin disabled, CLI missing,
/// remote unreachable).
async fn handle_scm_detect_provider(
    app: &AppHandle,
    params: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let repo_id = params
        .get("repo_id")
        .and_then(|v| v.as_str())
        .ok_or("missing repo_id")?
        .to_string();

    let state = app
        .try_state::<AppState>()
        .ok_or_else(|| "AppState not initialised".to_string())?;

    let (manual_override, repo_path, default_remote) = {
        let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
        let key = format!("repo:{repo_id}:scm_provider");
        let manual = db.get_app_setting(&key).map_err(|e| e.to_string())?;
        let repo = db
            .get_repository(&repo_id)
            .map_err(|e| e.to_string())?
            .ok_or("repository not found")?;
        (manual, repo.path, repo.default_remote)
    };

    if let Some(provider) = manual_override
        && !provider.is_empty()
    {
        return Ok(json!({ "provider": provider, "source": "manual" }));
    }

    let remote_url = claudette::git::get_remote_url(&repo_path, default_remote.as_deref())
        .await
        .ok();
    let detected = if let Some(url) = remote_url {
        let registry = state.plugins.read().await;
        detect::detect_provider(&url, &registry.plugins)
    } else {
        None
    };
    Ok(json!({ "provider": detected, "source": "auto" }))
}

/// Look up a workspace + its repository synchronously and assemble the
/// [`WorkspaceInfo`] that plugin operations expect. Mirrors
/// `commands::scm::make_workspace_info` minus the branch reconciliation
/// step (CLI-driven calls are short-lived; if a branch was renamed
/// out-of-band the next GUI poll will fix it).
fn build_workspace_info(
    db_path: &std::path::Path,
    workspace_id: &str,
) -> Result<WorkspaceInfo, String> {
    let db = Database::open(db_path).map_err(|e| e.to_string())?;
    let workspace = db
        .list_workspaces()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|w| w.id == workspace_id)
        .ok_or_else(|| format!("workspace not found: {workspace_id}"))?;
    let repo = db
        .get_repository(&workspace.repository_id)
        .map_err(|e| e.to_string())?
        .ok_or("repository not found")?;
    Ok(WorkspaceInfo {
        id: workspace.id.clone(),
        name: workspace.name.clone(),
        branch: workspace.branch_name.clone(),
        worktree_path: workspace
            .worktree_path
            .clone()
            .unwrap_or_else(|| repo.path.clone()),
        repo_path: repo.path,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use claudette::model::{Repository, Workspace, WorkspaceStatus};
    use serde_json::json;
    use std::collections::HashMap;

    fn make_repo(id: &str) -> Repository {
        Repository {
            id: id.into(),
            path: format!("/tmp/{id}"),
            name: id.into(),
            path_slug: id.into(),
            icon: None,
            created_at: String::new(),
            setup_script: None,
            custom_instructions: None,
            sort_order: 0,
            branch_rename_preferences: None,
            setup_script_auto_run: false,
            base_branch: None,
            default_remote: None,
            path_valid: true,
        }
    }

    fn make_workspace(id: &str, repo_id: &str) -> Workspace {
        Workspace {
            id: id.into(),
            repository_id: repo_id.into(),
            name: id.into(),
            branch_name: format!("claudette/{id}"),
            worktree_path: Some(format!("/tmp/{id}")),
            status: WorkspaceStatus::Active,
            agent_status: AgentStatus::Idle,
            status_line: String::new(),
            created_at: String::new(),
            sort_order: 0,
        }
    }

    fn make_chat_msg(
        id: &str,
        workspace_id: &str,
        chat_session_id: &str,
        role: ChatRole,
        content: &str,
    ) -> ChatMessage {
        ChatMessage {
            id: id.into(),
            workspace_id: workspace_id.into(),
            chat_session_id: chat_session_id.into(),
            role,
            content: content.into(),
            cost_usd: None,
            duration_ms: None,
            created_at: String::new(),
            thinking: None,
            input_tokens: None,
            output_tokens: None,
            cache_read_tokens: None,
            cache_creation_tokens: None,
        }
    }

    fn make_attachment(id: &str, message_id: &str, media_type: &str, data: &[u8]) -> Attachment {
        Attachment {
            id: id.into(),
            message_id: message_id.into(),
            filename: format!("{id}.dat"),
            media_type: media_type.into(),
            data: data.to_vec(),
            width: None,
            height: None,
            size_bytes: data.len() as i64,
            created_at: String::new(),
            origin: AttachmentOrigin::User,
            tool_use_id: None,
        }
    }

    fn fresh_agent_state(
        session_id: &str,
        active_pid: Option<u32>,
    ) -> crate::state::AgentSessionState {
        crate::state::AgentSessionState {
            workspace_id: "w1".into(),
            session_id: session_id.into(),
            turn_count: 1,
            active_pid,
            custom_instructions: None,
            needs_attention: false,
            attention_kind: None,
            attention_notification_sent: false,
            persistent_session: None,
            mcp_config_dirty: false,
            session_plan_mode: false,
            session_allowed_tools: Vec::new(),
            session_disable_1m_context: false,
            pending_permissions: HashMap::new(),
            running_background_tasks: Default::default(),
            background_wake_active: false,
            session_exited_plan: false,
            session_resolved_env: Default::default(),
            mcp_bridge: None,
            last_user_msg_id: None,
            posted_env_trust_warning: false,
        }
    }

    #[test]
    fn capabilities_methods_include_chat_orchestration_surface() {
        for method in [
            "get_chat_session",
            "get_chat_snapshot",
            "load_completed_turns",
            "load_attachments_for_session",
            "load_attachment_data",
            "create_chat_session",
            "rename_chat_session",
            "archive_chat_session",
            "stop_agent",
            "reset_agent_session",
            "clear_attention",
            "submit_agent_answer",
            "submit_plan_approval",
            "steer_queued_chat_message",
        ] {
            assert!(METHODS.contains(&method), "{method} missing from METHODS");
        }
    }

    #[test]
    fn build_chat_snapshot_returns_paginated_messages_and_safe_attachments() {
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1")).unwrap();
        db.insert_workspace(&make_workspace("w1", "r1")).unwrap();
        let session_id = db.default_session_id_for_workspace("w1").unwrap().unwrap();

        db.insert_chat_message(&make_chat_msg(
            "m1",
            "w1",
            &session_id,
            ChatRole::User,
            "first",
        ))
        .unwrap();
        db.insert_chat_message(&make_chat_msg(
            "m2",
            "w1",
            &session_id,
            ChatRole::Assistant,
            "second",
        ))
        .unwrap();
        db.insert_chat_message(&make_chat_msg(
            "m3",
            "w1",
            &session_id,
            ChatRole::User,
            "third",
        ))
        .unwrap();
        db.insert_attachment(&make_attachment("a-text", "m3", "text/plain", b"hello"))
            .unwrap();
        db.insert_attachment(&make_attachment("a-image", "m3", "image/png", b"\x89PNG"))
            .unwrap();

        let session = db.get_chat_session(&session_id).unwrap().unwrap();
        let messages = db.list_chat_messages_page(&session_id, 2, None).unwrap();
        let snapshot = build_chat_snapshot(&db, session, messages, 2, None, Vec::new()).unwrap();

        assert_eq!(snapshot.total_count, 3);
        assert!(snapshot.has_more);
        assert_eq!(
            snapshot
                .messages
                .iter()
                .map(|m| m.id.as_str())
                .collect::<Vec<_>>(),
            vec!["m2", "m3"]
        );
        let text = snapshot
            .attachments
            .iter()
            .find(|a| a.id == "a-text")
            .unwrap();
        assert_eq!(text.text_content.as_deref(), Some("hello"));
        let image = snapshot
            .attachments
            .iter()
            .find(|a| a.id == "a-image")
            .unwrap();
        assert!(image.text_content.is_none());
    }

    #[test]
    fn hydrate_session_overlays_live_agent_status_and_attention() {
        let mut session = ChatSession {
            id: "s1".into(),
            workspace_id: "w1".into(),
            session_id: None,
            name: "New chat".into(),
            name_edited: false,
            turn_count: 0,
            sort_order: 0,
            status: claudette::model::SessionStatus::Active,
            created_at: String::new(),
            archived_at: None,
            agent_status: AgentStatus::Idle,
            needs_attention: false,
            attention_kind: None,
        };
        let mut agent = fresh_agent_state("claude-s1", Some(123));
        agent.needs_attention = true;
        agent.attention_kind = Some(crate::state::AttentionKind::Ask);
        let agents = HashMap::from([(session.id.clone(), agent)]);

        session = hydrate_session(session, &agents);
        assert_eq!(session.agent_status, AgentStatus::Running);
        assert!(session.needs_attention);
        assert_eq!(
            session.attention_kind,
            Some(claudette::model::AttentionKind::Ask)
        );
    }

    #[test]
    fn pending_controls_serialize_input_and_kind() {
        let mut agent = fresh_agent_state("claude-s1", None);
        agent.pending_permissions.insert(
            "toolu_ask".into(),
            crate::state::PendingPermission {
                request_id: "req-1".into(),
                tool_name: "AskUserQuestion".into(),
                original_input: json!({"questions": [{"question": "Proceed?"}]}),
            },
        );
        agent.pending_permissions.insert(
            "toolu_plan".into(),
            crate::state::PendingPermission {
                request_id: "req-2".into(),
                tool_name: "ExitPlanMode".into(),
                original_input: json!({"plan": "Do it"}),
            },
        );

        let controls = pending_controls_for_session(Some(&agent));
        assert_eq!(controls.len(), 2);
        assert_eq!(controls[0].tool_use_id, "toolu_ask");
        assert_eq!(controls[0].kind, PendingAgentControlKind::AskUserQuestion);
        assert_eq!(controls[0].input["questions"][0]["question"], "Proceed?");
        assert_eq!(controls[1].kind, PendingAgentControlKind::ExitPlanMode);
    }

    /// Regression: the IPC handler historically dropped every agent-
    /// setting flag except model / plan_mode / permission_level. CLI
    /// users couldn't toggle thinking, fast mode, effort, chrome, or
    /// 1M-context from the command line even though the GUI exposes
    /// all of them. Asserts every field in `AgentSettings` round-trips.
    #[test]
    fn parse_send_chat_params_threads_every_setting_through() {
        let parsed = parse_send_chat_params(&json!({
            "session_id": "sess-1",
            "content": "hello",
            "model": "sonnet",
            "fast_mode": true,
            "thinking_enabled": true,
            "plan_mode": true,
            "effort": "high",
            "chrome_enabled": true,
            "disable_1m_context": true,
            "permission_level": "acceptEdits",
        }))
        .expect("must parse");
        assert_eq!(parsed.session_id, "sess-1");
        assert_eq!(parsed.content, "hello");
        assert_eq!(parsed.model.as_deref(), Some("sonnet"));
        assert_eq!(parsed.fast_mode, Some(true));
        assert_eq!(parsed.thinking_enabled, Some(true));
        assert_eq!(parsed.plan_mode, Some(true));
        assert_eq!(parsed.effort.as_deref(), Some("high"));
        assert_eq!(parsed.chrome_enabled, Some(true));
        assert_eq!(parsed.disable_1m_context, Some(true));
        assert_eq!(parsed.permission_level.as_deref(), Some("acceptEdits"));
    }

    #[test]
    fn parse_send_chat_params_omits_default_to_none() {
        let parsed = parse_send_chat_params(&json!({
            "session_id": "sess-1",
            "content": "hi",
        }))
        .expect("must parse");
        assert_eq!(parsed.model, None);
        assert_eq!(parsed.fast_mode, None);
        assert_eq!(parsed.thinking_enabled, None);
        assert_eq!(parsed.plan_mode, None);
        assert_eq!(parsed.effort, None);
        assert_eq!(parsed.chrome_enabled, None);
        assert_eq!(parsed.disable_1m_context, None);
        assert_eq!(parsed.permission_level, None);
    }

    /// Backwards compat: WS-server clients send `chat_session_id` for
    /// historical reasons. The parser must accept either spelling so
    /// the same client code talks to both surfaces.
    #[test]
    fn parse_send_chat_params_accepts_chat_session_id_alias() {
        let parsed = parse_send_chat_params(&json!({
            "chat_session_id": "sess-2",
            "content": "hi",
        }))
        .expect("must parse");
        assert_eq!(parsed.session_id, "sess-2");
    }

    #[test]
    fn parse_send_chat_params_rejects_missing_required_fields() {
        assert!(parse_send_chat_params(&json!({"content": "x"})).is_err());
        assert!(parse_send_chat_params(&json!({"session_id": "x"})).is_err());
    }

    /// Wrong types should drop to None for booleans and strings, not
    /// crash. (`as_bool` / `as_str` already handle this; the test
    /// pins the contract.)
    #[test]
    fn parse_send_chat_params_ignores_wrong_types() {
        let parsed = parse_send_chat_params(&json!({
            "session_id": "sess-1",
            "content": "hi",
            "plan_mode": "yes",   // wrong: string instead of bool
            "model": true,         // wrong: bool instead of string
        }))
        .expect("must parse");
        assert_eq!(parsed.plan_mode, None);
        assert_eq!(parsed.model, None);
    }
}
