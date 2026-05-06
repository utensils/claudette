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
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

/// Per-response line-length ceiling. Mirrors the server-side cap in
/// `src-tauri/src/ipc.rs`: a malformed or malicious peer can't drive
/// unbounded memory growth by streaming bytes without a `\n`.
const MAX_RESPONSE_BYTES: u64 = 1024 * 1024;

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
    let n = (&mut reader)
        .take(MAX_RESPONSE_BYTES + 1)
        .read_line(&mut line)
        .await
        .map_err(|e| CallError::Transport(e.to_string()))?;
    if n as u64 > MAX_RESPONSE_BYTES {
        return Err(CallError::Transport(format!(
            "response exceeds {MAX_RESPONSE_BYTES}-byte limit"
        )));
    }

    let response: RpcResponse = serde_json::from_str(line.trim())
        .map_err(|e| CallError::Transport(format!("malformed response: {e}")))?;

    match (response.result, response.error) {
        (_, Some(err)) => Err(CallError::Server(err)),
        (Some(value), None) => Ok(value),
        // JSON-RPC permits `result: null` for void-returning methods.
        // serde collapses a present `null` into `None` on the
        // `Option<serde_json::Value>` field, so we can't distinguish
        // missing from null here — but the absence of an `error` field
        // means the call succeeded, so treat both the same.
        (None, None) => Ok(serde_json::Value::Null),
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

#[cfg(test)]
mod tests {
    use claudette::rpc::{RpcError, RpcResponse};

    /// Regression: serde collapses a present `result: null` into
    /// `None` on `Option<Value>`, so the wire shapes "no result field"
    /// and "result: null" both surface here as `(None, None)`. Both
    /// must be treated as successful void responses, not transport
    /// errors. Methods like `archive_chat_session` return
    /// `Option<ChatSession>` and intentionally serialize `null` when
    /// archiving the last session; the CLI used to fail with
    /// "response had neither result nor error".
    #[test]
    fn null_result_is_treated_as_success() {
        // Round-trip via serde to mirror what the CLI sees on the wire.
        let on_wire = serde_json::to_string(&RpcResponse::ok(
            serde_json::json!(1),
            serde_json::Value::Null,
        ))
        .unwrap();
        let parsed: RpcResponse = serde_json::from_str(&on_wire).unwrap();
        assert!(parsed.error.is_none());
        // Whichever way serde parsed it, the CLI's match must accept it.
        let result = match (parsed.result, parsed.error) {
            (_, Some(_)) => panic!("expected success"),
            (Some(v), None) => v,
            (None, None) => serde_json::Value::Null,
        };
        assert_eq!(result, serde_json::Value::Null);
    }

    #[test]
    fn error_response_preserves_message() {
        let on_wire =
            serde_json::to_string(&RpcResponse::err(serde_json::json!(2), "boom".to_string()))
                .unwrap();
        let parsed: RpcResponse = serde_json::from_str(&on_wire).unwrap();
        let err: RpcError = parsed.error.expect("error must round-trip");
        assert_eq!(err.message, "boom");
        assert_eq!(err.code, -1);
    }
}
