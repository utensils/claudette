//! Local IPC server the running GUI exposes for the `claudette` CLI.
//!
//! Mirrors [`claudette::agent_mcp::bridge`] in shape: a long-running
//! `interprocess` listener bound to a Unix domain socket (or Windows
//! named pipe), line-delimited JSON-RPC v2 framing, and a per-connection
//! task that authenticates via a shared bearer token before dispatching.
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

use claudette::db::Database;
use claudette::ops::workspace as ops_workspace;
use claudette::rpc::{Capabilities, RpcRequest, RpcResponse};
use interprocess::local_socket::tokio::{Stream, prelude::*};
#[cfg(unix)]
use interprocess::local_socket::{GenericFilePath, ToFsName};
#[cfg(windows)]
use interprocess::local_socket::{GenericNamespaced, ToNsName};
use interprocess::local_socket::{ListenerOptions, Name};
use rand::RngCore;
use serde_json::json;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use crate::ops_hooks::TauriHooks;
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
    "create_workspace",
    "archive_workspace",
    "send_chat_message",
];

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

/// Decide the socket address. Unix: short file under `${TMPDIR}/cclt/`
/// — `claudette-cli` would push past macOS's 104-byte `sun_path` limit
/// when TMPDIR is the long `/var/folders/.../T/` form, so a terse
/// directory + 8-char id is used. Windows: a namespaced pipe name.
fn make_socket_address(app_uuid: &str) -> Result<(String, Option<PathBuf>), String> {
    #[cfg(unix)]
    {
        let short_id: String = app_uuid.chars().take(8).collect();
        let dir = std::env::temp_dir().join("cclt");
        std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
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
        let n = reader.read_line(&mut line).await?;
        if n == 0 {
            return Ok(()); // peer closed
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
            methods: METHODS.iter().map(|s| s.to_string()).collect(),
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
        "list_chat_sessions" => handle_list_chat_sessions(app, &req.params),
        "create_workspace" => handle_create_workspace(app, &req.params).await,
        "archive_workspace" => handle_archive_workspace(app, &req.params).await,
        "send_chat_message" => handle_send_chat_message(app, &req.params).await,
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

    let state = app
        .try_state::<AppState>()
        .ok_or_else(|| "AppState not initialised".to_string())?;
    let mut db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let (mode, custom) = ops_workspace::read_branch_prefix_settings(&db);
    let prefix = ops_workspace::resolve_branch_prefix(&mode, &custom).await;
    let worktree_base = state.worktree_base_dir.read().await.clone();

    let hooks: Arc<TauriHooks> = TauriHooks::new(app.clone());
    let out = ops_workspace::create(
        &mut db,
        hooks.as_ref(),
        worktree_base.as_path(),
        ops_workspace::CreateParams {
            repo_id,
            name,
            branch_prefix: &prefix,
        },
    )
    .await
    .map_err(|e| e.to_string())?;

    Ok(json!({
        "workspace": out.workspace,
        "default_session_id": out.default_session_id,
        "worktree_path": out.worktree_path,
    }))
}

/// `list_chat_sessions` IPC method — read-only DB query for a single
/// workspace's sessions. CLI callers always have a workspace context
/// (CLI is workspace-scoped by convention), so we require `workspace_id`.
fn handle_list_chat_sessions(
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
    with_db(app, |db| {
        db.list_chat_sessions_for_workspace(&workspace_id, include_archived)
            .map(|v| serde_json::to_value(v).unwrap_or_default())
            .map_err(|e| e.to_string())
    })
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
    let model = params
        .get("model")
        .and_then(|v| v.as_str())
        .map(String::from);
    let plan_mode = params.get("plan_mode").and_then(|v| v.as_bool());
    let permission_level = params
        .get("permission_level")
        .and_then(|v| v.as_str())
        .map(String::from);

    let state: tauri::State<'_, AppState> = app.state::<AppState>();
    crate::commands::chat::send::send_chat_message(
        session_id,
        None,
        content,
        None,
        permission_level,
        model,
        None,
        None,
        plan_mode,
        None,
        None,
        None,
        None,
        app.clone(),
        state,
    )
    .await?;
    Ok(json!({ "ok": true }))
}

async fn handle_archive_workspace(
    app: &AppHandle,
    params: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let workspace_id = params
        .get("workspace_id")
        .and_then(|v| v.as_str())
        .ok_or("missing workspace_id")?;
    let delete_branch = params
        .get("delete_branch")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let state = app
        .try_state::<AppState>()
        .ok_or_else(|| "AppState not initialised".to_string())?;
    let mut db = Database::open(&state.db_path).map_err(|e| e.to_string())?;

    let hooks: Arc<TauriHooks> = TauriHooks::new(app.clone());
    let out = ops_workspace::archive(
        &mut db,
        hooks.as_ref(),
        ops_workspace::ArchiveParams {
            workspace_id,
            delete_branch,
        },
    )
    .await
    .map_err(|e| e.to_string())?;

    Ok(json!({
        "branch_deleted": out.branch_deleted,
        "was_last_workspace": out.was_last_workspace,
        "worktree_path": out.worktree_path,
        "repository_id": out.repository_id,
    }))
}
