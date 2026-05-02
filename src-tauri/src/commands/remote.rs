use serde::Serialize;
use tauri::{AppHandle, State};

use claudette::db::Database;

use crate::remote::{
    DiscoveredServer, RemoteConnectionInfo, RemoteConnectionManager, participant_id_for,
};
use crate::state::AppState;
#[cfg(feature = "server")]
use crate::state::LocalServerState;
use crate::transport::ws::WebSocketTransport;
use claudette::process::CommandWindowExt as _;
#[cfg(feature = "server")]
use tokio::io::{AsyncBufReadExt, BufReader};

#[derive(Serialize)]
pub struct PairResult {
    pub connection: RemoteConnectionInfo,
    pub server_name: String,
    pub initial_data: Option<serde_json::Value>,
    /// Participant id this connection has on the remote server.
    /// Frontend stores it and uses it to detect "this message is mine"
    /// in collaborative sessions.
    pub participant_id: Option<String>,
}

#[tauri::command]
pub async fn list_remote_connections(
    state: State<'_, AppState>,
) -> Result<Vec<RemoteConnectionInfo>, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let connections = db.list_remote_connections().map_err(|e| e.to_string())?;
    Ok(connections
        .into_iter()
        .map(|c| {
            let participant_id = participant_id_for(c.session_token.as_deref());
            RemoteConnectionInfo {
                id: c.id,
                name: c.name,
                host: c.host,
                port: c.port,
                session_token: c.session_token,
                cert_fingerprint: c.cert_fingerprint,
                auto_connect: c.auto_connect,
                created_at: c.created_at,
                participant_id,
            }
        })
        .collect())
}

#[tauri::command]
pub async fn pair_with_server(
    host: String,
    port: u16,
    pairing_token: String,
    app: AppHandle,
    state: State<'_, AppState>,
    manager: State<'_, RemoteConnectionManager>,
) -> Result<PairResult, String> {
    // Connect via WebSocket.
    let result = WebSocketTransport::connect(&host, port, None).await?;
    let transport = result.transport;
    let cert_fingerprint = result.cert_fingerprint;

    // Authenticate with pairing token.
    let hostname = gethostname::gethostname().to_string_lossy().to_string();
    let auth = transport
        .authenticate_pairing(&pairing_token, &hostname)
        .await?;

    let connection_id = uuid::Uuid::new_v4().to_string();

    // Persist to DB.
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let db_conn = claudette::model::RemoteConnection {
        id: connection_id.clone(),
        name: auth.server_name.clone(),
        host: host.clone(),
        port,
        session_token: auth.session_token.clone(),
        cert_fingerprint: Some(cert_fingerprint.clone()),
        auto_connect: false,
        created_at: String::new(),
    };
    db.insert_remote_connection(&db_conn)
        .map_err(|e| e.to_string())?;

    // Re-fetch to get the DB-generated created_at timestamp.
    let saved = db
        .get_remote_connection(&connection_id)
        .map_err(|e| e.to_string())?
        .ok_or("Failed to re-read saved connection")?;

    let info = RemoteConnectionInfo {
        id: saved.id,
        name: saved.name,
        host: saved.host,
        port: saved.port,
        // Prefer the auth-returned id when present; fall back to deriving
        // from the (just-issued) session token. They should always match.
        participant_id: auth
            .participant_id
            .clone()
            .or_else(|| participant_id_for(saved.session_token.as_deref())),
        session_token: saved.session_token,
        cert_fingerprint: saved.cert_fingerprint,
        auto_connect: saved.auto_connect,
        created_at: saved.created_at,
    };

    // Load remote data before handing off the transport.
    use crate::transport::Transport;
    let remote_data = transport
        .send(serde_json::json!({
            "method": "load_initial_data",
            "params": {}
        }))
        .await
        .ok()
        .and_then(|r| r.get("result").cloned());

    // Add to active connections.
    manager.add(info.clone(), transport, app).await;

    Ok(PairResult {
        connection: info,
        server_name: auth.server_name,
        initial_data: remote_data,
        participant_id: auth.participant_id,
    })
}

#[tauri::command]
pub async fn connect_remote(
    id: String,
    app: AppHandle,
    state: State<'_, AppState>,
    manager: State<'_, RemoteConnectionManager>,
) -> Result<serde_json::Value, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let conn = db
        .get_remote_connection(&id)
        .map_err(|e| e.to_string())?
        .ok_or("Remote connection not found")?;

    let session_token = conn
        .session_token
        .as_ref()
        .ok_or("No session token — need to re-pair")?;

    // Connect via WebSocket.
    let result =
        WebSocketTransport::connect(&conn.host, conn.port, conn.cert_fingerprint.as_deref())
            .await?;
    let transport = result.transport;

    // Authenticate with saved session token.
    let auth = transport.authenticate_session(session_token).await?;

    let info = RemoteConnectionInfo {
        id: conn.id.clone(),
        name: auth.server_name.clone(),
        host: conn.host.clone(),
        port: conn.port,
        participant_id: auth
            .participant_id
            .clone()
            .or_else(|| participant_id_for(conn.session_token.as_deref())),
        session_token: conn.session_token.clone(),
        cert_fingerprint: conn.cert_fingerprint.clone(),
        auto_connect: conn.auto_connect,
        created_at: conn.created_at.clone(),
    };

    // Load remote data.
    use crate::transport::Transport;
    let remote_data = transport
        .send(serde_json::json!({
            "method": "load_initial_data",
            "params": {}
        }))
        .await?;

    // Add to active connections.
    manager.add(info, transport, app).await;

    // Return the remote initial data.
    Ok(remote_data
        .get("result")
        .cloned()
        .unwrap_or(serde_json::Value::Null))
}

#[tauri::command]
pub async fn disconnect_remote(
    id: String,
    manager: State<'_, RemoteConnectionManager>,
) -> Result<(), String> {
    manager.remove(&id).await
}

#[tauri::command]
pub async fn remove_remote_connection(
    id: String,
    state: State<'_, AppState>,
    manager: State<'_, RemoteConnectionManager>,
) -> Result<(), String> {
    // Disconnect if active.
    let _ = manager.remove(&id).await;

    // Remove from DB.
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.delete_remote_connection(&id)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn list_discovered_servers(
    state: State<'_, AppState>,
) -> Result<Vec<DiscoveredServer>, String> {
    let servers = state.discovered_servers.read().await;
    Ok(servers.clone())
}

#[tauri::command]
pub async fn add_remote_connection(
    connection_string: String,
    app: AppHandle,
    state: State<'_, AppState>,
    manager: State<'_, RemoteConnectionManager>,
) -> Result<PairResult, String> {
    // Parse connection string: claudette://host:port/token
    let stripped = connection_string
        .strip_prefix("claudette://")
        .ok_or("Invalid connection string — must start with claudette://")?;

    let (host_port, token) = stripped
        .split_once('/')
        .ok_or("Invalid connection string — missing token")?;

    let (host, port) = if let Some((h, p)) = host_port.rsplit_once(':') {
        let port: u16 = p.parse().map_err(|_| "Invalid port number")?;
        (h.to_string(), port)
    } else {
        (host_port.to_string(), 7683)
    };

    pair_with_server(host, port, token.to_string(), app, state, manager).await
}

/// Forward a JSON-RPC command to a remote connection.
#[tauri::command]
pub async fn send_remote_command(
    connection_id: String,
    method: String,
    params: serde_json::Value,
    manager: State<'_, RemoteConnectionManager>,
) -> Result<serde_json::Value, String> {
    let request = serde_json::json!({
        "method": method,
        "params": params,
    });
    let response = manager.send(&connection_id, request).await?;
    Ok(response
        .get("result")
        .cloned()
        .unwrap_or(serde_json::Value::Null))
}

// -- Local server (Share this machine) --

#[derive(Serialize)]
pub struct LocalServerInfo {
    pub running: bool,
    pub connection_string: Option<String>,
}

#[tauri::command]
pub async fn start_local_server(state: State<'_, AppState>) -> Result<LocalServerInfo, String> {
    #[cfg(not(feature = "server"))]
    {
        let _ = &state;
        Err("Server not available: built without the 'server' feature".to_string())
    }

    #[cfg(feature = "server")]
    {
        // Hold write lock for the entire operation to prevent concurrent spawns.
        let mut server = state.local_server.write().await;

        if let Some(ref srv) = *server {
            return Ok(LocalServerInfo {
                running: true,
                connection_string: Some(srv.connection_string.clone()),
            });
        }

        // Spawn ourselves with `--server` to run the embedded server as a subprocess.
        let server_bin = std::env::current_exe()
            .map_err(|e| format!("Failed to locate current executable: {e}"))?;

        let mut child = tokio::process::Command::new(&server_bin)
            .no_console_window()
            .arg("--server")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("Failed to start embedded server: {e}"))?;

        // Capture PID eagerly — child.id() returns None after the process is
        // reaped, and we need the PID for synchronous cleanup on app exit.
        let pid = child.id().ok_or("Failed to get server process PID")?;

        let stdout = child
            .stdout
            .take()
            .ok_or("Failed to capture server stdout")?;
        let stderr_handle = child.stderr.take();
        let mut reader = BufReader::new(stdout).lines();

        // The server's startup banner used to include `claudette://...` —
        // a global pairing token that the watcher used as the ready signal.
        // With the share-scoped auth model that string is gone (every share
        // mints its own); we now wait for the new banner's terminal line
        // ("Ready for connections.") instead. There is no global connection
        // string to display; the share modal mints one per share.
        let mut ready = false;
        let timeout = tokio::time::Duration::from_secs(10);
        let deadline = tokio::time::Instant::now() + timeout;

        while tokio::time::Instant::now() < deadline {
            let line = tokio::time::timeout_at(deadline, reader.next_line())
                .await
                .map_err(|_| "Timed out waiting for server to start")?
                .map_err(|e| format!("Error reading server output: {e}"))?;

            if let Some(line) = line {
                let trimmed = line.trim();
                if trimmed.starts_with("Ready for connections") {
                    ready = true;
                    break;
                }
            } else {
                // Server exited — capture stderr for a useful error message.
                let detail = match stderr_handle {
                    Some(mut se) => {
                        let mut buf = String::new();
                        let _ = tokio::io::AsyncReadExt::read_to_string(&mut se, &mut buf).await;
                        let t = buf.trim();
                        if t.is_empty() {
                            String::new()
                        } else {
                            format!(": {t}")
                        }
                    }
                    None => String::new(),
                };
                // Reap the child so it doesn't become a zombie.
                let status = child.wait().await.ok();
                let code = status.and_then(|s| s.code());
                let exit_info = match code {
                    Some(c) => format!(" (exit code {c})"),
                    None => String::new(),
                };
                return Err(format!("Server exited before ready{exit_info}{detail}"));
            }
        }

        if !ready {
            let _ = child.kill().await;
            return Err("Server started but did not signal readiness in time".to_string());
        }

        // Spawn tasks to continuously drain stdout and stderr to prevent broken
        // pipe panics. If we don't read them, the pipe buffer fills and the server
        // will die with "Broken pipe" on its next write.
        tokio::spawn(async move { while let Ok(Some(_)) = reader.next_line().await {} });
        if let Some(se) = stderr_handle {
            tokio::spawn(async move {
                let mut stderr_reader = BufReader::new(se).lines();
                while let Ok(Some(_)) = stderr_reader.next_line().await {}
            });
        }

        // Connection strings are minted per-share by `start_share`, not by
        // the legacy subprocess server. The `LocalServerState.connection_string`
        // field is retained for ABI compatibility with the existing
        // `LocalServerInfo` shape and the `local_server` AppState slot,
        // but it is now always empty in the share-scoped world.
        let info = LocalServerInfo {
            running: true,
            connection_string: None,
        };

        *server = Some(LocalServerState {
            child,
            pid,
            connection_string: String::new(),
        });

        Ok(info)
    } // #[cfg(feature = "server")]
}

#[tauri::command]
pub async fn stop_local_server(state: State<'_, AppState>) -> Result<(), String> {
    let mut server = state.local_server.write().await;
    if let Some(mut srv) = server.take() {
        let _ = srv.child.kill().await;
        let _ = srv.child.wait().await;
    }
    Ok(())
}

#[tauri::command]
pub async fn get_local_server_status(
    state: State<'_, AppState>,
) -> Result<LocalServerInfo, String> {
    let server = state.local_server.read().await;
    match server.as_ref() {
        Some(srv) => Ok(LocalServerInfo {
            running: true,
            connection_string: Some(srv.connection_string.clone()),
        }),
        None => Ok(LocalServerInfo {
            running: false,
            connection_string: None,
        }),
    }
}

// `CollaborativeShareResult` and the `start_collaborative_share` /
// `stop_collaborative_share` Tauri commands were removed when sharing
// switched to the workspace-scoped `Share` model. See
// `crate::commands::share` for the replacement: `start_share`,
// `stop_share`, `list_shares`. The host subscriber + vote resolver
// helpers used by the old flow still live below as utilities.

/// Host-only: forcibly remove a participant from a collaborative session.
/// The participant's pending votes are dropped; the room rebroadcasts the
/// new participant list. The kicked client's WebSocket connection is left
/// open (they can re-join via UI), but the agent will never see their
/// future prompts/votes since they've been removed from the room.
#[tauri::command]
pub async fn kick_participant(
    chat_session_id: String,
    participant_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let room = state
        .rooms
        .get(&chat_session_id)
        .await
        .ok_or("Session is not collaborative")?;
    let pid = claudette::room::ParticipantId(participant_id);
    if pid.is_host() {
        return Err("Cannot kick the host".into());
    }
    room.remove_participant(&pid).await;
    room.publish(serde_json::json!({
        "event": "participants-changed",
        "payload": {
            "chat_session_id": &chat_session_id,
            "participants": room.participant_list().await,
        },
    }));
    room.publish(serde_json::json!({
        "event": "participant-kicked",
        "payload": {
            "chat_session_id": &chat_session_id,
            "participant_id": pid.as_str(),
        },
    }));
    Ok(())
}

/// Host-only: mute (or un-mute) a participant. Muted participants' RPCs
/// for `send_chat_message` and `vote_plan_approval` are rejected at the
/// server boundary, but they still receive room broadcasts so they can
/// observe what's happening.
#[tauri::command]
pub async fn mute_participant(
    chat_session_id: String,
    participant_id: String,
    muted: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let room = state
        .rooms
        .get(&chat_session_id)
        .await
        .ok_or("Session is not collaborative")?;
    let pid = claudette::room::ParticipantId(participant_id);
    if pid.is_host() {
        return Err("Cannot mute the host".into());
    }
    if !room.set_muted(&pid, muted).await {
        return Err("Participant not found in session".into());
    }
    room.publish(serde_json::json!({
        "event": "participants-changed",
        "payload": {
            "chat_session_id": &chat_session_id,
            "participants": room.participant_list().await,
        },
    }));
    Ok(())
}

// Removed: `start_collaborative_share`, `stop_collaborative_share`, and
// `build_collab_connection_string`. These were the per-chat-session
// collab-share entry points from the previous design. The new model
// (workspace-scoped `Share`s) supersedes them — see
// `crate::commands::share`. The `spawn_host_event_subscriber` and
// `spawn_host_vote_resolver` helpers below are still useful but currently
// unused; they'll be re-wired when the registry gains a "subscribe to
// every room" hook (see TODO in `commands/share.rs::ensure_share_server`).

/// Ensure both host-side subscribers (event mirror + vote resolver) are
/// spawned for `room`, idempotently. Safe to call from the bridge on
/// every turn — `state.host_room_subscribers` dedups on `chat_session_id`
/// so we end up with at most one subscriber pair per room.
#[cfg(feature = "server")]
pub async fn ensure_host_room_subscribers(
    app: &AppHandle,
    state: &AppState,
    chat_session_id: &str,
    room: std::sync::Arc<claudette::room::Room>,
) {
    let mut subs = state.host_room_subscribers.write().await;
    if !subs.insert(chat_session_id.to_string()) {
        return;
    }
    spawn_host_event_subscriber(app.clone(), room.clone());
    spawn_host_vote_resolver(app.clone(), room, chat_session_id.to_string());
}

#[cfg(feature = "server")]
fn spawn_host_event_subscriber(app: AppHandle, room: std::sync::Arc<claudette::room::Room>) {
    use tauri::Emitter;
    let mut rx = room.subscribe();
    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(evt) => {
                    let Some(name) = evt.0.get("event").and_then(|v| v.as_str()) else {
                        continue;
                    };
                    let payload = evt
                        .0
                        .get("payload")
                        .cloned()
                        .unwrap_or(serde_json::Value::Null);
                    let _ = app.emit(name, payload);
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    let _ = app.emit("resync-required", serde_json::Value::Null);
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

#[cfg(feature = "server")]
fn spawn_host_vote_resolver(
    app: AppHandle,
    room: std::sync::Arc<claudette::room::Room>,
    chat_session_id: String,
) {
    let mut rx = room.subscribe();
    tokio::spawn(async move {
        loop {
            let evt = match rx.recv().await {
                Ok(e) => e,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            };
            // We only care about non-host plan-vote-cast events. Host
            // votes flow through `submit_plan_approval` directly and run
            // resolution inline; remote votes arrive here and need to be
            // applied locally so resolution finalizes on the host side.
            let Some(name) = evt.0.get("event").and_then(|v| v.as_str()) else {
                continue;
            };
            if name != "plan-vote-cast" {
                continue;
            }
            let payload = match evt.0.get("payload") {
                Some(p) => p,
                None => continue,
            };
            let participant_id = payload
                .get("participant_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if participant_id == claudette::room::ParticipantId::HOST {
                continue;
            }
            let tool_use_id = payload
                .get("tool_use_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let session_id = payload
                .get("chat_session_id")
                .and_then(|v| v.as_str())
                .unwrap_or(&chat_session_id)
                .to_string();
            let vote: claudette::room::Vote = match payload
                .get("vote")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
            {
                Some(v) => v,
                None => continue,
            };
            let participant = claudette::room::ParticipantId(participant_id.to_string());
            let app_state = tauri::Manager::state::<AppState>(&app);
            if let Err(e) = crate::commands::chat::record_plan_vote(
                &app_state,
                &session_id,
                &tool_use_id,
                &participant,
                false, // is_host
                vote,
                false, // already broadcast by remote side
            )
            .await
            {
                eprintln!("[collab] resolver: record_plan_vote failed: {e}");
            }
        }
    });
}
