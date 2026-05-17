//! Tauri commands exposed to the mobile webview.
//!
//! Phase 5 ships the pair / connect / list / forget surface. Phases 6-8
//! extend this with `send_rpc` (generic JSON-RPC passthrough over the
//! active Transport) and event-stream forwarding.

use std::sync::Arc;

use claudette::transport::Transport;
use claudette::transport::ws::WebSocketTransport;
use serde::Serialize;
use tauri::Emitter;

use crate::state::{Connection, ConnectionManager};
use crate::storage::{self, SavedConnection};

/// Spawn the per-connection event-forwarder task. Consumes
/// `transport.event_stream()` (a `broadcast::Receiver`) and re-emits
/// each `ServerEvent` to the webview as a Tauri event named after the
/// wire event (`agent-stream`, `pty-output`, `checkpoint-created`,
/// `agent-permission-prompt`). Each payload carries the originating
/// `connection_id` so screens can filter to the active server when
/// multiple connections are paired.
fn spawn_event_forwarder(
    app: tauri::AppHandle,
    connection_id: String,
    transport: Arc<dyn Transport>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut rx = transport.event_stream();
        loop {
            match rx.recv().await {
                Ok(event) => {
                    let payload = serde_json::json!({
                        "connection_id": connection_id,
                        "payload": event.payload,
                    });
                    if let Err(e) = app.emit(&event.event, payload) {
                        tracing::warn!(
                            target: "claudette::mobile",
                            event = %event.event,
                            error = %e,
                            "failed to emit server event to webview"
                        );
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    tracing::info!(
                        target: "claudette::mobile",
                        connection_id = %connection_id,
                        "event stream closed"
                    );
                    break;
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(
                        target: "claudette::mobile",
                        dropped = n,
                        "event stream lag — receiver dropped events"
                    );
                }
            }
        }
    })
}

#[derive(Serialize)]
pub struct VersionInfo {
    pub version: &'static str,
    pub commit: Option<&'static str>,
}

#[tauri::command]
pub fn version() -> VersionInfo {
    VersionInfo {
        version: env!("CARGO_PKG_VERSION"),
        commit: option_env!("CLAUDETTE_GIT_SHA"),
    }
}

/// Parsed components of a `claudette://host:port/token` connection
/// string. Lives here (rather than as a generic URL parse) so the
/// error messages are tuned to the pairing UX — "Invalid scheme",
/// "Missing token", etc. — rather than a generic url-crate error.
#[derive(Debug)]
struct ParsedConnectionString {
    host: String,
    port: u16,
    token: String,
}

fn parse_connection_string(input: &str) -> Result<ParsedConnectionString, String> {
    let stripped = input
        .trim()
        .strip_prefix("claudette://")
        .ok_or_else(|| "Invalid connection string — must start with claudette://".to_string())?;

    let (host_port, token) = stripped
        .split_once('/')
        .ok_or_else(|| "Invalid connection string — missing pairing token".to_string())?;

    if token.is_empty() {
        return Err("Invalid connection string — pairing token is empty".to_string());
    }
    // The server-issued pairing token is base64-URL-safe (no `/`) — see
    // `src-server/src/auth.rs::generate_pairing_token`. Reject embedded
    // slashes so a malformed string like `claudette://host/abc/def`
    // doesn't silently parse with `abc/def` as the token (split_once
    // stops at the first `/`).
    if token.contains('/') {
        return Err("Invalid connection string — pairing token must not contain '/'".to_string());
    }

    let (host, port) = if let Some((h, p)) = host_port.rsplit_once(':') {
        let port: u16 = p
            .parse()
            .map_err(|_| format!("Invalid port number in connection string: {p}"))?;
        if h.is_empty() {
            return Err("Invalid connection string — host is empty".to_string());
        }
        (h.to_string(), port)
    } else {
        // Bare host with no `:port` — fall back to the documented
        // default port. Mirrors `claudette-tauri/src/commands/remote.rs`
        // so the parsing is consistent across desktop and mobile.
        (host_port.to_string(), 7683)
    };

    Ok(ParsedConnectionString {
        host,
        port,
        token: token.to_string(),
    })
}

#[derive(Serialize)]
pub struct PairResult {
    pub connection: SavedConnection,
}

/// Pair this phone with a Claudette server. Parses the
/// `claudette://host:port/token` string, opens a WSS connection, calls
/// `authenticate_pairing` to exchange the one-time pairing token for a
/// long-lived session token, persists the pair (host + port + session
/// token + cert fingerprint) to local storage, and registers the live
/// `Transport` in `ConnectionManager` so subsequent RPC calls can reuse
/// it without reconnecting.
#[tauri::command]
pub async fn pair_with_connection_string(
    app: tauri::AppHandle,
    manager: tauri::State<'_, ConnectionManager>,
    connection_string: String,
) -> Result<PairResult, String> {
    let parsed = parse_connection_string(&connection_string)?;

    let result = WebSocketTransport::connect(&parsed.host, parsed.port, None).await?;
    let transport = result.transport;
    let fingerprint = result.cert_fingerprint;

    let device_name = gethostname::gethostname().to_string_lossy().to_string();
    let auth = transport
        .authenticate_pairing(&parsed.token, &device_name)
        .await?;
    let session_token = auth
        .session_token
        .ok_or_else(|| "Server did not return a session token after pairing".to_string())?;

    let saved = SavedConnection {
        id: uuid::Uuid::new_v4().to_string(),
        name: auth.server_name,
        host: parsed.host,
        port: parsed.port,
        session_token,
        fingerprint: fingerprint.clone(),
        created_at: chrono::Utc::now().to_rfc3339(),
    };

    storage::upsert(&app, saved.clone())?;

    let transport_arc: Arc<dyn Transport> = Arc::from(transport);
    let forwarder =
        spawn_event_forwarder(app.clone(), saved.id.clone(), Arc::clone(&transport_arc));

    manager
        .insert(Connection {
            id: saved.id.clone(),
            host: saved.host.clone(),
            port: saved.port,
            server_name: saved.name.clone(),
            fingerprint,
            transport: transport_arc,
            event_forwarder: Some(forwarder),
        })
        .await;

    Ok(PairResult { connection: saved })
}

/// List previously-paired servers. Order is newest first (most recent
/// `created_at`) so the user's last-used server lands at the top.
#[tauri::command]
pub fn list_saved_connections(app: tauri::AppHandle) -> Result<Vec<SavedConnection>, String> {
    let mut store = storage::load(&app)?;
    store
        .connections
        .sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(store.connections)
}

/// Re-open a WSS connection to a previously-paired server using the
/// stored session token. The fingerprint is compared against the
/// server's current cert; a mismatch returns the standard TOFU error
/// from `WebSocketTransport::connect`.
#[tauri::command]
pub async fn connect_saved(
    app: tauri::AppHandle,
    manager: tauri::State<'_, ConnectionManager>,
    id: String,
) -> Result<SavedConnection, String> {
    let store = storage::load(&app)?;
    let saved = store
        .connections
        .iter()
        .find(|c| c.id == id)
        .cloned()
        .ok_or_else(|| format!("No saved connection with id {id}"))?;

    let result =
        WebSocketTransport::connect(&saved.host, saved.port, Some(&saved.fingerprint)).await?;
    let transport = result.transport;

    transport.authenticate_session(&saved.session_token).await?;

    // If a connection already exists for this id (e.g. user tapped the
    // saved-server row twice), close the old transport explicitly
    // before replacing it. The `Connection::Drop` impl already aborts
    // the event-forwarder task, but `WebSocketTransport`'s underlying
    // tungstenite write half only closes when its last `Arc` clone is
    // dropped — and any RPC commands mid-flight may still hold clones.
    // An explicit `close()` here sends the WS close frame immediately
    // so the server doesn't see a lingering peer.
    if let Some(old) = manager.remove(&saved.id).await
        && let Err(e) = old.transport.close().await
    {
        tracing::warn!(
            target: "claudette::mobile",
            error = %e,
            "failed to close prior transport on reconnect"
        );
    }

    let transport_arc: Arc<dyn Transport> = Arc::from(transport);
    let forwarder =
        spawn_event_forwarder(app.clone(), saved.id.clone(), Arc::clone(&transport_arc));

    manager
        .insert(Connection {
            id: saved.id.clone(),
            host: saved.host.clone(),
            port: saved.port,
            server_name: saved.name.clone(),
            fingerprint: saved.fingerprint.clone(),
            transport: transport_arc,
            event_forwarder: Some(forwarder),
        })
        .await;

    Ok(saved)
}

/// Generic JSON-RPC passthrough. The webview drives the protocol — the
/// Rust side only knows how to ferry `{method, params}` over the active
/// `Transport` and surface the result back. Keeping this generic means
/// new server-side RPC methods (Phase 7+) work end-to-end without a
/// matching `#[tauri::command]` per method on the mobile side.
#[tauri::command]
pub async fn send_rpc(
    manager: tauri::State<'_, ConnectionManager>,
    connection_id: String,
    method: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let conn = manager
        .get(&connection_id)
        .await
        .ok_or_else(|| format!("No active connection with id {connection_id}"))?;
    let request = serde_json::json!({
        "method": method,
        "params": params,
    });
    let response = conn.transport.send(request).await?;

    // Unwrap the `{id, result}` / `{id, error}` envelope so the webview
    // sees a clean value or a plain Err. Mirrors the desktop's
    // `send_remote_command` in `src-tauri/src/commands/remote.rs`.
    if let Some(error) = response.get("error") {
        let msg = error
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("Remote returned an error");
        return Err(msg.to_string());
    }
    Ok(response
        .get("result")
        .cloned()
        .unwrap_or(serde_json::Value::Null))
}

/// Forget a paired server — closes the live transport (if any) and
/// removes the persisted entry. The session token cannot be revoked
/// from the phone side; if you suspect compromise, also run
/// `claudette-server regenerate-token` on the host.
#[tauri::command]
pub async fn forget_connection(
    app: tauri::AppHandle,
    manager: tauri::State<'_, ConnectionManager>,
    id: String,
) -> Result<(), String> {
    if let Some(conn) = manager.remove(&id).await
        && let Err(e) = conn.transport.close().await
    {
        tracing::warn!(target: "claudette::mobile", error = %e, "close transport on forget");
    }
    storage::remove(&app, &id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_standard_connection_string() {
        let parsed = parse_connection_string("claudette://host.local:7683/sometoken").unwrap();
        assert_eq!(parsed.host, "host.local");
        assert_eq!(parsed.port, 7683);
        assert_eq!(parsed.token, "sometoken");
    }

    #[test]
    fn parses_with_default_port() {
        let parsed = parse_connection_string("claudette://my-host/abc123").unwrap();
        assert_eq!(parsed.host, "my-host");
        assert_eq!(parsed.port, 7683);
        assert_eq!(parsed.token, "abc123");
    }

    #[test]
    fn rejects_missing_scheme() {
        assert!(parse_connection_string("wss://host/token").is_err());
        assert!(parse_connection_string("host:7683/token").is_err());
    }

    #[test]
    fn rejects_empty_token() {
        assert!(parse_connection_string("claudette://host:7683/").is_err());
    }

    #[test]
    fn rejects_token_with_embedded_slash() {
        // A malformed string with extra slashes must error rather than
        // silently parsing `abc/def` as the token — matches the server's
        // base64-URL-safe token guarantee.
        let err = parse_connection_string("claudette://host:7683/abc/def").unwrap_err();
        assert!(err.contains("must not contain '/'"), "unexpected: {err}");
    }

    #[test]
    fn rejects_missing_token() {
        assert!(parse_connection_string("claudette://host:7683").is_err());
    }

    #[test]
    fn rejects_bad_port() {
        assert!(parse_connection_string("claudette://host:notaport/token").is_err());
    }

    #[test]
    fn trims_whitespace() {
        let parsed = parse_connection_string("  claudette://h:1/t  \n").unwrap();
        assert_eq!(parsed.host, "h");
        assert_eq!(parsed.port, 1);
    }
}
