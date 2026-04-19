use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::UpdaterExt;

use crate::state::AppState;

const STABLE_URL: &str =
    "https://github.com/utensils/claudette/releases/latest/download/latest.json";
const NIGHTLY_URL: &str =
    "https://github.com/utensils/claudette/releases/download/nightly/latest.json";

/// Subset of [`tauri_plugin_updater::Update`] that we expose across the IPC boundary.
#[derive(Serialize)]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    pub body: Option<String>,
    pub date: Option<String>,
}

fn endpoint_for(channel: &str) -> &'static str {
    match channel {
        "stable" => STABLE_URL,
        "nightly" => NIGHTLY_URL,
        other => {
            eprintln!("[updater] Unknown channel {other:?}, falling back to stable");
            STABLE_URL
        }
    }
}

/// Check the configured channel's release feed for an update.
///
/// On success, the resulting [`tauri_plugin_updater::Update`] is stashed in
/// [`AppState::pending_update`] so that [`install_pending_update`] can hand it
/// off to the platform installer. The serializable [`UpdateInfo`] is returned
/// to JS so the UI can render the version banner.
#[tauri::command]
pub async fn check_for_updates_with_channel(
    app: AppHandle,
    state: State<'_, AppState>,
    channel: String,
) -> Result<Option<UpdateInfo>, String> {
    let endpoint = endpoint_for(&channel)
        .parse()
        .map_err(|e: url::ParseError| e.to_string())?;

    let update = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;

    let mut slot = state.pending_update.lock().await;
    match update {
        Some(u) => {
            let info = UpdateInfo {
                version: u.version.clone(),
                current_version: u.current_version.clone(),
                body: u.body.clone(),
                date: u.date.map(|d| d.to_string()),
            };
            *slot = Some(u);
            Ok(Some(info))
        }
        None => {
            *slot = None;
            Ok(None)
        }
    }
}

/// Download and install the pending update, then restart the app.
///
/// Emits `updater://progress` (u32, 0–100) as bytes arrive so the UI can drive
/// its progress bar. Returns an error if no update is pending.
#[tauri::command]
pub async fn install_pending_update(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let update = state
        .pending_update
        .lock()
        .await
        .take()
        .ok_or_else(|| "No pending update".to_string())?;

    let app_for_cb = app.clone();
    let mut total: u64 = 0;
    let mut downloaded: u64 = 0;

    update
        .download_and_install(
            move |chunk_len, content_len| {
                if let Some(c) = content_len {
                    total = c;
                }
                downloaded += chunk_len as u64;
                let pct = if total > 0 {
                    ((downloaded * 100) / total).min(100) as u32
                } else {
                    0
                };
                let _ = app_for_cb.emit("updater://progress", pct);
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;

    // `AppHandle::restart` returns `!` (it ends the process), so it satisfies
    // the `Result<(), String>` signature without an explicit `Ok(())`.
    app.restart();
}
