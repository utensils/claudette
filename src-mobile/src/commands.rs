//! Tauri commands exposed to the mobile webview.
//!
//! Phase 4 ships only a minimal `version` probe so the webview can
//! confirm the Rust side is reachable. Phases 5+ extend this with:
//! - `pair` (parses claudette://, calls authenticate_pairing, stores in Keychain)
//! - `connect` (reconnect via stored session token)
//! - `send_rpc` (generic passthrough — takes method+params and forwards
//!   over the active Transport)
//! - `disconnect` (cleanly close the WSS)
//!
//! Keeping this file small now means Phase 5 can land its additions
//! without already-sprawling churn.

use serde::Serialize;

#[derive(Serialize)]
pub struct VersionInfo {
    pub version: &'static str,
    pub commit: Option<&'static str>,
}

/// Webview-callable handshake. The Phase 5 onboarding screen reads this
/// to decide whether to show "needs update" copy if the Rust side and the
/// JS bundle disagree on shape — for now it's just a liveness probe.
#[tauri::command]
pub fn version() -> VersionInfo {
    VersionInfo {
        version: env!("CARGO_PKG_VERSION"),
        // `option_env!` returns None at compile time when the env var is
        // unset, which is the common case for local dev. Release builds
        // can pass it through `RUSTC_BOOTSTRAP_GIT_SHA=$(git rev-parse ...)`
        // or similar — but that hookup is its own follow-up.
        commit: option_env!("CLAUDETTE_GIT_SHA"),
    }
}
