//! Share-management Tauri commands.
//!
//! A *share* is a workspace-scoped authorization grant the host hands out
//! to remote users. Each share holds its own pairing token and a list of
//! workspace ids; remote clients pairing with that token are issued
//! session tokens whose RPCs are gated on the share's scope.
//!
//! Share mutations lock the shared `Arc<Mutex<ServerConfig>>` stored in
//! `AppState::share_server_config`, then persist the same config to
//! `server.toml`. Stopping a share removes it from that live config, which
//! invalidates its session tokens and causes both RPC handlers and long-lived
//! event forwarders to stop serving already-connected clients.

use serde::Serialize;
use tauri::{AppHandle, State};

#[cfg(feature = "server")]
use std::sync::Arc;
#[cfg(feature = "server")]
use tauri::Manager;

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
        // the same port. Restarting the app clears that legacy server state;
        // the current share modal manages only workspace-scoped shares.
        if state.local_server.read().await.is_some() {
            return Err(
                "Stop the legacy local server first by restarting Claudette, then create this workspace share.".into(),
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
    //
    // The workspace-event bus is also shared so `archive_workspace` (and
    // any future workspace lifecycle command) on the host side can push
    // events that reach connected remotes immediately, regardless of
    // whether they've joined any chat room yet.
    let rooms = std::sync::Arc::clone(&state.rooms);
    let workspace_events = std::sync::Arc::clone(&state.workspace_events);
    let cfg_for_server = Arc::clone(&cfg_arc);
    let app_for_server = app.clone();
    let opts = claudette_server::ServerOptions {
        existing_config: Some(cfg_for_server),
        ..Default::default()
    };
    tokio::spawn(async move {
        if let Err(e) =
            claudette_server::run_with_rooms_and_events(opts, rooms, Some(workspace_events)).await
        {
            eprintln!("[share] in-process server exited: {e}");
        }
        let state = app_for_server.state::<AppState>();
        *state.collab_server_running.write().await = false;
    });

    // The host event subscriber attaches via `RoomRegistry::set_on_create`,
    // installed once at app startup in `main.rs::setup`. Each new room
    // gets a host-side mirror task synchronously at creation time, before
    // any handler can publish into it (see the on_create hook docstring
    // in `src/room.rs` for why this ordering is load-bearing).
    *running = true;
    Ok(true)
}

/// Hydrate persisted shares from disk on app startup.
///
/// Without this, shares written to `~/.claudette/server.toml` from a prior
/// app run are durable on disk but invisible to `list_shares` (which reads
/// the in-memory `share_server_config`, only ever populated by
/// `ensure_share_server`). The user-facing symptom: opening the share
/// modal after relaunch shows "No active shares", but the saved pairing
/// strings still work, and the moment the user mints any new share the
/// old ones reappear "magically" because that flow finally loads disk.
///
/// We peek at the saved config first and only spawn the in-process
/// server if at least one share exists — avoiding an idle listener on
/// the share port for users who have never minted a share. If the user
/// later mints their first share, `ensure_share_server` handles the
/// boot path as before.
#[cfg(feature = "server")]
pub async fn hydrate_persisted_shares(app: &AppHandle, state: &AppState) -> Result<(), String> {
    let cfg_path = claudette_server::default_config_path();
    if !cfg_path.exists() {
        return Ok(());
    }
    let cfg = match claudette_server::auth::ServerConfig::load_or_create(&cfg_path) {
        Ok(c) => c,
        Err(e) => {
            // Non-fatal: corrupt / unreadable config shouldn't block app
            // launch. Surface to logs and let the user re-mint shares.
            eprintln!("[share] Failed to load persisted shares: {e}");
            return Ok(());
        }
    };
    if cfg.shares.is_empty() {
        return Ok(());
    }
    eprintln!(
        "[share] Hydrating {} persisted share(s); booting in-process server",
        cfg.shares.len()
    );
    ensure_share_server(app, state).await?;
    Ok(())
}

#[cfg(not(feature = "server"))]
pub async fn hydrate_persisted_shares(_app: &AppHandle, _state: &AppState) -> Result<(), String> {
    Ok(())
}
