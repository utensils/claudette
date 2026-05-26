//! Persistent storage for paired servers.
//!
//! Phase 5 ships with **file-based** credential storage: a JSON blob at
//! `<app-data-dir>/connections.json` containing the host, port,
//! session token, and TOFU fingerprint for each paired server. iOS's
//! Data Protection encrypts the per-app sandbox at rest, so this is
//! reasonable for the first release — but the long-term home for
//! these credentials is the iOS Keychain (a Swift plugin we wrap from
//! the Tauri side). Tracked as a follow-up; until that lands, the
//! lower-friction file approach unblocks the rest of the milestone.
//!
//! Designed to be cross-platform: same code path serves the desktop
//! fallback build (writes under `~/Library/Application Support/...`
//! on macOS), so UI work doesn't need a phone in the loop.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::Manager;

/// Persisted record of a paired server.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedConnection {
    /// App-generated UUID, used to key the connection in `ConnectionManager`.
    pub id: String,
    /// Server-supplied display name (e.g. the desktop machine hostname).
    pub name: String,
    pub host: String,
    pub port: u16,
    /// Long-lived session token issued in exchange for the one-time pairing
    /// token. Used by `authenticate_session` on subsequent reconnects.
    pub session_token: String,
    /// SHA-256 fingerprint of the server's TLS cert observed on first
    /// pair. Pinned so a later connection that returns a different cert
    /// (server reinstalled, MITM, IP reuse) is rejected.
    pub fingerprint: String,
    /// ISO-ish timestamp captured at pair time, used to sort the saved
    /// connections list newest-first.
    pub created_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ConnectionStore {
    #[serde(default)]
    pub connections: Vec<SavedConnection>,
}

fn store_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| format!("app_local_data_dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create app data dir: {e}"))?;
    Ok(dir.join("connections.json"))
}

pub fn load(app: &tauri::AppHandle) -> Result<ConnectionStore, String> {
    let path = store_path(app)?;
    if !path.exists() {
        return Ok(ConnectionStore::default());
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("parse connections.json: {e}"))
}

pub fn save(app: &tauri::AppHandle, store: &ConnectionStore) -> Result<(), String> {
    let path = store_path(app)?;
    let bytes = serde_json::to_vec_pretty(store).map_err(|e| format!("encode: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &bytes).map_err(|e| format!("write tmp: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

pub fn upsert(app: &tauri::AppHandle, conn: SavedConnection) -> Result<(), String> {
    let mut store = load(app)?;
    if let Some(existing) = store.connections.iter_mut().find(|c| c.id == conn.id) {
        *existing = conn;
    } else {
        store.connections.push(conn);
    }
    save(app, &store)
}

pub fn remove(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    let mut store = load(app)?;
    store.connections.retain(|c| c.id != id);
    save(app, &store)
}
