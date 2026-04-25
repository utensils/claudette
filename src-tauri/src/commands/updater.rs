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

/// Classifies an updater error: `Ok(())` means "downgrade to no update
/// available", `Err(...)` is a real transport/parse failure that should
/// bubble up to the UI.
///
/// `Error::ReleaseNotFound` covers two situations:
///   1. HTTP 404 on `latest.json` — the manifest does not exist (or is hidden
///      behind a draft release, as happens during an in-progress nightly build).
///   2. Any other non-success HTTP status (e.g. 5xx) where the response was
///      received but parsed nothing — the upstream plugin maps these to the
///      same variant.
///
/// Both are benign from the user's standpoint: their currently-installed build
/// is still working; the catalog is just temporarily uninformative. Surfacing a
/// red error banner for either is more alarming than the situation warrants.
/// True transport failures (DNS, TLS, connect) reach us as `Reqwest`/`Network`
/// variants and continue to error.
fn classify_check_error(err: tauri_plugin_updater::Error) -> Result<(), String> {
    match err {
        tauri_plugin_updater::Error::ReleaseNotFound => Ok(()),
        other => Err(other.to_string()),
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

    let result = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await;

    let update = match result {
        Ok(u) => u,
        Err(e) => match classify_check_error(e) {
            Ok(()) => {
                eprintln!(
                    "[updater] Release manifest unavailable for channel {channel:?}; \
                     treating as no update available"
                );
                None
            }
            Err(msg) => return Err(msg),
        },
    };

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
                let pct = downloaded
                    .checked_mul(100)
                    .and_then(|v| v.checked_div(total))
                    .unwrap_or(0)
                    .min(100) as u32;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_not_found_is_treated_as_no_update() {
        let result = classify_check_error(tauri_plugin_updater::Error::ReleaseNotFound);
        assert!(matches!(result, Ok(())));
    }

    #[test]
    fn other_errors_bubble_up_as_strings() {
        // Pick any non-ReleaseNotFound variant the upstream enum exposes.
        let err = tauri_plugin_updater::Error::EmptyEndpoints;
        let expected = err.to_string();
        match classify_check_error(err) {
            Err(msg) => assert_eq!(msg, expected),
            Ok(_) => panic!("EmptyEndpoints should not be downgraded"),
        }
    }

    #[test]
    fn endpoint_for_known_channels() {
        assert_eq!(endpoint_for("stable"), STABLE_URL);
        assert_eq!(endpoint_for("nightly"), NIGHTLY_URL);
        // Unknown channels fall back to stable (and log a warning).
        assert_eq!(endpoint_for("garbage"), STABLE_URL);
    }
}
