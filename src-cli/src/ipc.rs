//! IPC client that dials the local socket the GUI advertises in its
//! discovery file.
//!
//! Wire format mirrors `src-tauri/src/ipc.rs`: line-delimited JSON,
//! each request prefixed with `{"token": "...", "id": ..., "method":
//! "...", "params": ...}`. Each [`call`] is a single request/response
//! round trip — we don't keep the connection alive across calls
//! because the CLI is short-lived and stateless.

use claudette::rpc::{RpcError, RpcRequest, RpcResponse};
use interprocess::local_socket::Name;
use interprocess::local_socket::tokio::{Stream, prelude::*};
#[cfg(unix)]
use interprocess::local_socket::{GenericFilePath, ToFsName};
#[cfg(windows)]
use interprocess::local_socket::{GenericNamespaced, ToNsName};
use serde::Serialize;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::discovery::AppInfo;

#[derive(Debug)]
pub enum CallError {
    /// Failed to connect to the socket (GUI crashed between discovery
    /// and dial, or the socket was unlinked).
    Connect(String),
    /// Network-level transport error after the connection was open
    /// (write/read failure, peer disconnect, malformed JSON).
    Transport(String),
    /// The server returned a JSON-RPC `error` payload. The inner shape
    /// is preserved so callers can inspect `code` / `message`.
    Server(RpcError),
}

impl std::fmt::Display for CallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Connect(msg) => write!(f, "connect failed: {msg}"),
            Self::Transport(msg) => write!(f, "transport error: {msg}"),
            Self::Server(err) => write!(f, "{}", err.message),
        }
    }
}

impl std::error::Error for CallError {}

/// Wraps an [`RpcRequest`] with the bearer token expected by the IPC
/// server. The server requires the token on every request — we don't
/// have a session-establish step.
#[derive(Serialize)]
struct TokenedRequest<'a> {
    token: &'a str,
    #[serde(flatten)]
    request: RpcRequest,
}

/// Single round-trip RPC. Connects, sends one request, reads the
/// response, closes. Cheap enough on local sockets that connection
/// reuse isn't worth the complexity for a one-shot CLI.
pub async fn call(
    info: &AppInfo,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, CallError> {
    let name = name_for(&info.socket).map_err(CallError::Connect)?;
    let conn = Stream::connect(name)
        .await
        .map_err(|e| CallError::Connect(e.to_string()))?;
    let mut reader = BufReader::new(&conn);
    let mut writer = &conn;

    let request = TokenedRequest {
        token: &info.token,
        request: RpcRequest {
            id: serde_json::json!(uuid::new_v4_string()),
            method: method.to_string(),
            params,
        },
    };
    let mut bytes =
        serde_json::to_vec(&request).map_err(|e| CallError::Transport(e.to_string()))?;
    bytes.push(b'\n');
    writer
        .write_all(&bytes)
        .await
        .map_err(|e| CallError::Transport(e.to_string()))?;
    writer
        .flush()
        .await
        .map_err(|e| CallError::Transport(e.to_string()))?;

    let mut line = String::new();
    reader
        .read_line(&mut line)
        .await
        .map_err(|e| CallError::Transport(e.to_string()))?;

    let response: RpcResponse = serde_json::from_str(line.trim())
        .map_err(|e| CallError::Transport(format!("malformed response: {e}")))?;

    match (response.result, response.error) {
        (Some(value), None) => Ok(value),
        (_, Some(err)) => Err(CallError::Server(err)),
        (None, None) => Err(CallError::Transport(
            "response had neither result nor error".into(),
        )),
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

/// Tiny shim because the `uuid` crate isn't a CLI dep — we just need
/// a unique-enough identifier per request for response correlation.
/// The IPC server echoes whatever we send.
mod uuid {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    pub fn new_v4_string() -> String {
        format!("c{}", COUNTER.fetch_add(1, Ordering::Relaxed))
    }
}
