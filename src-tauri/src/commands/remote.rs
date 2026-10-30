use serde::Serialize;
use tauri::{AppHandle, State};

use claudette::db::Database;

use crate::remote::{DiscoveredServer, RemoteConnectionInfo, RemoteConnectionManager};
use crate::state::AppState;
#[cfg(feature = "server")]
use crate::state::LocalServerState;
#[cfg(feature = "server")]
use claudette::transport::ws::WebSocketTransport;

#[derive(Serialize)]
pub struct PairResult {
    pub connection: RemoteConnectionInfo,
    pub server_name: String,
    pub initial_data: Option<serde_json::Value>,
}

fn connection_info(c: claudette::model::RemoteConnection) -> RemoteConnectionInfo {
    RemoteConnectionInfo {
        id: c.id,
        name: c.name,
        host: c.host,
        port: c.port,
        // The session token is a bearer credential for the remote machine;
        // it never needs to leave the Rust side.
        session_token: None,
        cert_fingerprint: c.cert_fingerprint,
        auto_connect: c.auto_connect,
        created_at: c.created_at,
    }
}

#[tauri::command]
pub async fn list_remote_connections(
    state: State<'_, AppState>,
) -> Result<Vec<RemoteConnectionInfo>, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let connections = db.list_remote_connections().map_err(|e| e.to_string())?;
    Ok(connections.into_iter().map(connection_info).collect())
}

/// IDs of connections the Rust side currently holds open. Lets the
/// frontend resync after a webview reload, when its own state is empty but
/// the sockets are still up.
#[tauri::command]
pub async fn list_active_remote_connections(
    manager: State<'_, RemoteConnectionManager>,
) -> Result<Vec<String>, String> {
    Ok(manager
        .list_active()
        .await
        .into_iter()
        .map(|info| info.id)
        .collect())
}

#[tauri::command]
pub async fn set_remote_auto_connect(
    id: String,
    auto_connect: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.set_remote_connection_auto_connect(&id, auto_connect)
        .map_err(|e| e.to_string())
}

/// Pair with a server using its pairing token.
///
/// `expected_fingerprint_prefix` is the certificate fingerprint prefix the
/// server advertised over mDNS. When present, the TLS certificate must
/// match it, so a machine impersonating the server on the LAN can't
/// capture the pairing token.
///
/// Pairing again with a host:port that is already saved (e.g. after the
/// server regenerated its certificate or token) updates that entry instead
/// of adding a duplicate.
#[tauri::command]
pub async fn pair_with_server(
    host: String,
    port: u16,
    pairing_token: String,
    expected_fingerprint_prefix: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
    manager: State<'_, RemoteConnectionManager>,
) -> Result<PairResult, String> {
    let result = WebSocketTransport::connect(&host, port, None).await?;
    let transport = result.transport;
    let cert_fingerprint = result.cert_fingerprint;

    if let Some(prefix) = expected_fingerprint_prefix
        .as_deref()
        .filter(|p| !p.is_empty())
        && !cert_fingerprint.starts_with(prefix)
    {
        use claudette::transport::Transport;
        let _ = transport.close().await;
        return Err(format!(
            "The server's certificate ({}) doesn't match the one it advertised on the \
             network ({prefix}). Not sending the pairing token.",
            &cert_fingerprint[..cert_fingerprint.len().min(16)]
        ));
    }

    let hostname = gethostname::gethostname().to_string_lossy().to_string();
    let auth = transport
        .authenticate_pairing(&pairing_token, &hostname)
        .await?;
    let session_token = auth
        .session_token
        .clone()
        .ok_or("Server did not issue a session token")?;

    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let existing = db
        .list_remote_connections()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|c| c.host == host && c.port == port);
    let connection_id = match existing {
        Some(existing) => {
            db.update_remote_connection_session(&existing.id, &session_token, &cert_fingerprint)
                .map_err(|e| e.to_string())?;
            db.rename_remote_connection(&existing.id, &auth.server_name)
                .map_err(|e| e.to_string())?;
            existing.id
        }
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            db.insert_remote_connection(&claudette::model::RemoteConnection {
                id: id.clone(),
                name: auth.server_name.clone(),
                host: host.clone(),
                port,
                session_token: Some(session_token),
                cert_fingerprint: Some(cert_fingerprint.clone()),
                // A server you just paired with is one you want back on
                // the next launch; the sidebar can turn this off.
                auto_connect: true,
                created_at: String::new(),
            })
            .map_err(|e| e.to_string())?;
            id
        }
    };

    let saved = db
        .get_remote_connection(&connection_id)
        .map_err(|e| e.to_string())?
        .ok_or("Failed to re-read saved connection")?;
    let info = connection_info(saved);

    // Load remote data before handing off the transport.
    use claudette::transport::Transport;
    let remote_data = transport
        .send(serde_json::json!({
            "method": "load_initial_data",
            "params": {}
        }))
        .await
        .and_then(crate::remote::rpc_result)
        .ok();

    manager.add(info.clone(), transport, app).await;

    Ok(PairResult {
        connection: info,
        server_name: auth.server_name,
        initial_data: remote_data,
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
        name: auth.server_name.clone(),
        ..connection_info(conn.clone())
    };

    // Load remote data.
    use claudette::transport::Transport;
    let remote_data = crate::remote::rpc_result(
        transport
            .send(serde_json::json!({
                "method": "load_initial_data",
                "params": {}
            }))
            .await?,
    )?;

    // Add to active connections.
    manager.add(info, transport, app).await;

    Ok(remote_data)
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
    // Revoke this device's session on the server (best effort — it may be
    // offline), then disconnect.
    let _ = manager
        .call(&id, "revoke_session", serde_json::json!({}))
        .await;
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
    // Paired-ness is computed per call so a server paired a moment ago moves
    // out of "Nearby" right away.
    let saved_fingerprints: Vec<String> = Database::open(&state.db_path)
        .ok()
        .and_then(|db| db.list_remote_connections().ok())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|c| c.cert_fingerprint)
        .collect();
    let servers = state.discovered_servers.read().await;
    Ok(servers
        .iter()
        .cloned()
        .map(|mut server| {
            server.is_paired = crate::remote::fingerprint_matches_any(
                &server.cert_fingerprint_prefix,
                &saved_fingerprints,
            );
            server
        })
        .collect())
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

    pair_with_server(host, port, token.to_string(), None, app, state, manager).await
}

/// Forward a JSON-RPC command to a remote connection.
#[tauri::command]
pub async fn send_remote_command(
    connection_id: String,
    method: String,
    params: serde_json::Value,
    manager: State<'_, RemoteConnectionManager>,
) -> Result<serde_json::Value, String> {
    manager.call(&connection_id, &method, params).await
}

// -- Local server (Share this machine) --

#[derive(Serialize)]
pub struct LocalServerInfo {
    pub running: bool,
    pub connection_string: Option<String>,
}

#[tauri::command]
pub async fn start_local_server(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<LocalServerInfo, String> {
    #[cfg(not(feature = "server"))]
    {
        let _ = (&app, &state);
        Err("Server not available: built without the 'server' feature".to_string())
    }

    #[cfg(feature = "server")]
    {
        // Hold write lock for the entire operation to prevent concurrent starts.
        let mut server = state.local_server.write().await;

        if let Some(ref srv) = *server {
            return Ok(LocalServerInfo {
                running: true,
                connection_string: Some(srv.connection_string.clone()),
            });
        }

        // Serve in-process so paired clients drive this window's own agent
        // sessions (and see them live) rather than a second runtime.
        let host = crate::remote_host::TauriRpcHost::attach(app.clone());
        let handle =
            match claudette_server::start(claudette_server::ServerOptions::default(), host.clone())
                .await
            {
                Ok(handle) => handle,
                Err(e) => {
                    host.detach();
                    return Err(format!("Failed to start server: {e}"));
                }
            };
        let connection_string = handle.connection_string.clone();

        *server = Some(LocalServerState {
            connection_string: connection_string.clone(),
            handle,
            host,
        });

        Ok(LocalServerInfo {
            running: true,
            connection_string: Some(connection_string),
        })
    }
}

#[tauri::command]
pub async fn stop_local_server(state: State<'_, AppState>) -> Result<(), String> {
    let previous = state.local_server.write().await.take();
    #[cfg(feature = "server")]
    if let Some(mut srv) = previous {
        // Wait for the port to free up so sharing can restart right away;
        // dropping `srv` then detaches the event bridge.
        srv.handle.stop_and_wait().await;
    }
    #[cfg(not(feature = "server"))]
    drop(previous);
    Ok(())
}

/// Issue a new pairing token and revoke every paired device. When sharing
/// is on, the server restarts with the new token (dropping connected
/// clients); the returned info carries the new connection string.
#[tauri::command]
pub async fn reset_local_server_pairing(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<LocalServerInfo, String> {
    #[cfg(not(feature = "server"))]
    {
        let _ = (&app, &state);
        Err("Server not available: built without the 'server' feature".to_string())
    }

    #[cfg(feature = "server")]
    {
        let previous = state.local_server.write().await.take();
        let was_running = previous.is_some();
        if let Some(mut srv) = previous {
            srv.handle.stop_and_wait().await;
        }
        let config_path = claudette_server::default_config_path();
        let mut config = claudette_server::auth::ServerConfig::load_or_create(&config_path)
            .map_err(|e| e.to_string())?;
        config.regenerate_token();
        config.save(&config_path).map_err(|e| e.to_string())?;
        if was_running {
            start_local_server(app, state).await
        } else {
            Ok(LocalServerInfo {
                running: false,
                connection_string: None,
            })
        }
    }
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
