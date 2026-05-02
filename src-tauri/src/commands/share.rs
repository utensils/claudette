//! Share-management Tauri commands.
//!
//! A *share* is a workspace-scoped authorization grant the host hands out
//! to remote users. Each share holds its own pairing token and a list of
//! workspace ids; remote clients pairing with that token are issued
//! session tokens whose RPCs are gated on the share's scope.
//!
//! All share mutations go through `with_share_config` so the in-memory
//! config seen by the in-process server and the on-disk `server.toml` stay
//! in sync. Stopping a share is a removal — every session token it issued
//! is invalidated, and the next request from any of those connections
//! fails the per-RPC revocation check in `handler.rs::handle_request`.

use serde::Serialize;
use tauri::{AppHandle, State};

#[cfg(feature = "server")]
use std::sync::Arc;

use crate::state::AppState;

#[derive(Serialize, Debug, Clone)]
pub struct ShareSummary {
    pub id: String,
    pub label: Option<String>,
    pub allowed_workspace_ids: Vec<String>,
    pub collaborative: bool,
    pub consensus_required: bool,
    pub created_at: String,
    /// Number of session tokens currently issued for this share — i.e. how
    /// many remote clients have paired. Useful for the UI's "1 connected /
    /// 0 connected" hint.
    pub session_count: usize,
    /// `claudette://host:port/<pairing_token>` — the string the user gives
    /// to people they want to grant this share's scope to.
    pub connection_string: String,
}

#[derive(Serialize, Debug)]
pub struct StartShareResult {
    pub share: ShareSummary,
    /// `true` if this call also booted the in-process server (first share
    /// of the app's lifetime). Subsequent shares return `false`.
    pub server_started: bool,
}

/// Mint a new workspace-scoped share. Boots the in-process server on
/// first call. Returns the new share including its connection string.
#[tauri::command]
pub async fn start_share(
    label: Option<String>,
    workspace_ids: Vec<String>,
    collaborative: bool,
    consensus_required: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<StartShareResult, String> {
    #[cfg(not(feature = "server"))]
    {
        let _ = (
            label,
            workspace_ids,
            collaborative,
            consensus_required,
            app,
            state,
        );
        return Err("Server feature disabled".into());
    }

    #[cfg(feature = "server")]
    {
        if workspace_ids.is_empty() {
            return Err("A share must include at least one workspace".into());
        }
        // Refuse to coexist with the legacy subprocess server — they bind
        // the same port. Users who had the subprocess running should stop
        // it first via the share modal.
        if state.local_server.read().await.is_some() {
            return Err(
                "Stop the legacy local server first (use 'Stop sharing' in the share modal)."
                    .into(),
            );
        }

        let server_started = ensure_share_server(&app, &state).await?;

        // Mutate the shared config: append the new share, persist to disk.
        let summary = {
            let cfg_arc = state
                .share_server_config
                .read()
                .await
                .clone()
                .ok_or("Share server not running")?;
            let mut cfg = cfg_arc.lock().await;
            let entry = cfg
                .create_share(label, workspace_ids, collaborative, consensus_required)
                .clone();
            // Persist so a restart preserves active shares. Failures here
            // are non-fatal: the in-memory share is still valid for this
            // session.
            let _ = cfg.save(&claudette_server::default_config_path());
            share_summary_from_entry(&entry, cfg.server.port)
        };

        Ok(StartShareResult {
            share: summary,
            server_started,
        })
    }
}

/// Revoke a share by id. Removes it from the live config (which makes the
/// per-RPC `share_id` lookup in `handler.rs` fail for every session token
/// issued from this share — that's our immediate-revocation guarantee).
#[tauri::command]
pub async fn stop_share(share_id: String, state: State<'_, AppState>) -> Result<(), String> {
    #[cfg(not(feature = "server"))]
    {
        let _ = (share_id, state);
        return Err("Server feature disabled".into());
    }

    #[cfg(feature = "server")]
    {
        let cfg_arc = state
            .share_server_config
            .read()
            .await
            .clone()
            .ok_or("No active shares")?;
        let mut cfg = cfg_arc.lock().await;
        if !cfg.revoke_share(&share_id) {
            return Err("Unknown share id".into());
        }
        let _ = cfg.save(&claudette_server::default_config_path());
        Ok(())
    }
}

/// Snapshot the active shares for the UI. Mostly read-only metadata —
/// the connection strings are recomputed on each call from the live
/// host name + port + pairing token.
#[tauri::command]
pub async fn list_shares(state: State<'_, AppState>) -> Result<Vec<ShareSummary>, String> {
    #[cfg(not(feature = "server"))]
    {
        let _ = state;
        return Ok(Vec::new());
    }

    #[cfg(feature = "server")]
    {
        let Some(cfg_arc) = state.share_server_config.read().await.clone() else {
            return Ok(Vec::new());
        };
        let cfg = cfg_arc.lock().await;
        Ok(cfg
            .list_shares()
            .iter()
            .map(|e| share_summary_from_entry(e, cfg.server.port))
            .collect())
    }
}

#[cfg(feature = "server")]
fn share_summary_from_entry(entry: &claudette_server::auth::ShareEntry, port: u16) -> ShareSummary {
    let host = gethostname::gethostname().to_string_lossy().to_string();
    ShareSummary {
        id: entry.id.clone(),
        label: entry.label.clone(),
        allowed_workspace_ids: entry.allowed_workspace_ids.clone(),
        collaborative: entry.collaborative,
        consensus_required: entry.consensus_required,
        created_at: entry.created_at.clone(),
        session_count: entry.sessions.len(),
        connection_string: format!("claudette://{}:{}/{}", host, port, entry.pairing_token),
    }
}

#[cfg(feature = "server")]
async fn ensure_share_server(app: &AppHandle, state: &AppState) -> Result<bool, String> {
    // Check & set the running flag inside one critical section so two
    // concurrent `start_share` calls don't both spawn a server.
    let mut running = state.collab_server_running.write().await;
    if *running {
        return Ok(false);
    }

    // Build (or load from disk) the shared config arc and stash it on
    // AppState so the new commands can mutate it.
    let cfg_path = claudette_server::default_config_path();
    let cfg = claudette_server::auth::ServerConfig::load_or_create(&cfg_path)
        .map_err(|e| format!("Failed to load server config: {e}"))?;
    let cfg_arc = Arc::new(tokio::sync::Mutex::new(cfg));
    *state.share_server_config.write().await = Some(Arc::clone(&cfg_arc));

    // Spawn the in-process server with the shared room registry AND the
    // shared config. Any future `start_share` mutates the config Arc; the
    // server's per-request revocation check sees the updated `shares`
    // list immediately because it's the same `Arc<Mutex>`.
    let rooms = std::sync::Arc::clone(&state.rooms);
    let cfg_for_server = Arc::clone(&cfg_arc);
    let opts = claudette_server::ServerOptions {
        existing_config: Some(cfg_for_server),
        ..Default::default()
    };
    tokio::spawn(async move {
        if let Err(e) = claudette_server::run_with_rooms(opts, rooms).await {
            eprintln!("[share] in-process server exited: {e}");
        }
    });

    // Spawn the host event subscriber once per app lifetime: it listens to
    // every room created (now or later) and re-emits events to the local
    // webview. Without this, the host's UI wouldn't see remote-originated
    // events. We attach to a sentinel "any-room" listener via the registry
    // — but the registry doesn't have that surface yet, so for now we
    // attach per-room when the room is first created. See
    // `crate::commands::remote::spawn_host_event_subscriber` for the
    // existing per-room pattern; in this simplified MVP version, the host
    // UI subscribes when it joins via the existing `start_collaborative_share`
    // flow — which we no longer recommend.
    //
    // TODO(follow-up): wire a global "RoomRegistry::on_room_created" hook
    // so the host event subscriber attaches automatically. For this PR
    // the host's chat events still flow through the existing
    // `commands::chat.rs` direct-emit path; only remote clients use the
    // share auth gate.
    let _ = app;

    *running = true;
    Ok(true)
}
