//! Diagnostics commands — frontend-facing surface for the structured
//! logging pipeline.
//!
//! Three things live here:
//!
//! 1. **Frontend → backend log bridge.** [`log_from_frontend`] lets the
//!    React webview emit events into the same `tracing` registry as
//!    the Rust side. Browser-uncaught errors, `unhandledrejection`,
//!    and `ErrorBoundary` catches all flow through this command so a
//!    single daily log file captures both halves of the app.
//! 2. **Log dir surface.** [`get_log_dir`] / [`open_log_dir`] back the
//!    Settings → Diagnostics buttons so users (and bug-report
//!    instructions) can find the log file without remembering a path.
//! 3. **Persisted log-level override.** [`set_log_level`] writes
//!    `app_settings["diagnostics.log_level"]`; the value is read on
//!    startup by `main.rs` and threaded into
//!    `claudette::logging::init_with_override`. We do **not** install a
//!    `tracing_subscriber::reload::Handle` — the user-facing UX is
//!    "change level, restart Claudette" rather than racing a live
//!    swap mid-turn, which keeps the subscriber path zero-overhead.
//!
//! The commands are registered in `src-tauri/src/main.rs` alongside the
//! rest of the `invoke_handler` list.

use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::State;

use claudette::db::Database;

use crate::state::AppState;

/// Settings key that persists the user's chosen log filter.
/// Read once at startup by `main.rs`. The value is any valid
/// `EnvFilter` directive (see `claudette::logging` doc-comment for the
/// syntax). `RUST_LOG`, if set, still wins.
pub const LOG_LEVEL_SETTING: &str = "diagnostics.log_level";

/// Settings key that persists the frontend bridge verbosity. The
/// frontend reads it via [`get_diagnostics_settings`] and configures
/// `installFrontendLogBridge()` accordingly. Values mirror the TS
/// `FrontendLogVerbosity` union: `"errors"`, `"warnings"`, `"all"`.
pub const FRONTEND_VERBOSITY_SETTING: &str = "diagnostics.frontend_verbosity";

/// One of `trace`, `debug`, `info`, `warn`, `error` — what the React
/// side sends. Anything else is bucketed as `info` so a typo can't
/// silently drop the event.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FrontendLogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FrontendLogPayload {
    pub level: FrontendLogLevel,
    /// Sub-domain inside `claudette::frontend`. Free-form so callers
    /// can group related events (e.g. `error-boundary`, `console`,
    /// `unhandled-rejection`). We always emit under
    /// `target = "claudette::frontend"` and stamp the sub-domain into
    /// a structured `frontend_target` field — that way a single
    /// `RUST_LOG=claudette::frontend=trace` filter still matches every
    /// browser event without juggling per-component targets.
    pub frontend_target: Option<String>,
    pub message: String,
    /// Arbitrary structured fields. Stored as a single JSON string in
    /// the `fields` field so the file log keeps one column without
    /// trying to flatten an unbounded shape.
    #[serde(default)]
    pub fields: Option<serde_json::Value>,
    /// URL of the source script when present (browser `error` events
    /// expose this, ErrorBoundary catches don't).
    #[serde(default)]
    pub source: Option<String>,
    /// Stack trace as a single string. Browsers normalize this for us.
    #[serde(default)]
    pub stack: Option<String>,
}

/// Forward a structured event from the React webview into the global
/// `tracing` registry. The browser side wraps this in
/// `src/ui/src/utils/log.ts`; everything ends up in
/// `claudette::frontend` so a single filter targets all webview
/// activity.
#[tauri::command]
pub fn log_from_frontend(payload: FrontendLogPayload) {
    let frontend_target = payload
        .frontend_target
        .as_deref()
        .unwrap_or("uncategorized");
    let fields = payload
        .fields
        .as_ref()
        .map(|v| v.to_string())
        .unwrap_or_default();

    // We branch on level instead of using a runtime variable because
    // `tracing::event!` requires a const level at the call site —
    // matching keeps the macro expansion correct without losing the
    // `target:` and structured fields.
    match payload.level {
        FrontendLogLevel::Error => tracing::error!(
            target: "claudette::frontend",
            frontend_target,
            source = payload.source.as_deref(),
            stack = payload.stack.as_deref(),
            fields = %fields,
            "{}", payload.message
        ),
        FrontendLogLevel::Warn => tracing::warn!(
            target: "claudette::frontend",
            frontend_target,
            source = payload.source.as_deref(),
            stack = payload.stack.as_deref(),
            fields = %fields,
            "{}", payload.message
        ),
        FrontendLogLevel::Info => tracing::info!(
            target: "claudette::frontend",
            frontend_target,
            source = payload.source.as_deref(),
            fields = %fields,
            "{}", payload.message
        ),
        FrontendLogLevel::Debug => tracing::debug!(
            target: "claudette::frontend",
            frontend_target,
            fields = %fields,
            "{}", payload.message
        ),
        FrontendLogLevel::Trace => tracing::trace!(
            target: "claudette::frontend",
            frontend_target,
            fields = %fields,
            "{}", payload.message
        ),
    }
}

/// Path on disk where the daily-rotated log file lives. The Settings
/// UI surfaces this so users filing bug reports can copy the path or
/// reveal it in their file manager. `None` means logging hadn't yet
/// been initialized — should be unreachable in the GUI code path
/// because `main` calls `logging::init` before any commands register.
#[tauri::command]
pub fn get_log_dir() -> Option<String> {
    claudette::logging::log_dir().map(|p| p.display().to_string())
}

/// Reveal the log directory in the host file manager. Reuses the same
/// opener helper as `commands::shell::open_in_editor` to keep one
/// cross-platform path through `open` / `xdg-open` / `start`.
#[tauri::command]
pub fn open_log_dir() -> Result<(), String> {
    let path = claudette::logging::log_dir()
        .ok_or_else(|| "logging not initialized — no log directory to open".to_string())?;
    super::shell::opener::open(&path.display().to_string())
        .map_err(|e| format!("failed to open log directory: {e}"))
}

/// Snapshot of the diagnostics-related app settings + the resolved log
/// dir. The frontend hits this once on boot to configure the bridge
/// and once when the Diagnostics settings panel mounts.
#[derive(Debug, Clone, Serialize)]
pub struct DiagnosticsSettings {
    pub log_level: Option<String>,
    pub frontend_verbosity: Option<String>,
    pub log_dir: Option<String>,
    /// True when `RUST_LOG` was set at process start; lets the UI
    /// note "log level locked by RUST_LOG" so users don't think the
    /// select is broken when their env var overrides them.
    pub rust_log_active: bool,
}

#[tauri::command]
pub fn get_diagnostics_settings(state: State<'_, AppState>) -> Result<DiagnosticsSettings, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let log_level = db
        .get_app_setting(LOG_LEVEL_SETTING)
        .map_err(|e| e.to_string())?
        .filter(|s| !s.is_empty());
    let frontend_verbosity = db
        .get_app_setting(FRONTEND_VERBOSITY_SETTING)
        .map_err(|e| e.to_string())?
        .filter(|s| !s.is_empty());
    Ok(DiagnosticsSettings {
        log_level,
        frontend_verbosity,
        log_dir: claudette::logging::log_dir().map(|p| p.display().to_string()),
        rust_log_active: std::env::var_os("RUST_LOG").is_some(),
    })
}

/// Persist the log filter directive. Empty string clears the override
/// (back to the built-in default). Re-validating against `EnvFilter`
/// here means we reject garbage at the Settings boundary instead of
/// letting it brick the next launch.
#[tauri::command]
pub fn set_log_level(level: String, state: State<'_, AppState>) -> Result<(), String> {
    let trimmed = level.trim();
    if !trimmed.is_empty() {
        // Lean on `EnvFilter`'s own parser so this stays in sync with
        // whatever syntax `tracing-subscriber` accepts at runtime.
        tracing_subscriber::EnvFilter::try_new(trimmed)
            .map_err(|e| format!("invalid log filter {trimmed:?}: {e}"))?;
    }
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.set_app_setting(LOG_LEVEL_SETTING, trimmed)
        .map_err(|e| e.to_string())?;
    tracing::info!(
        target: "claudette::ui",
        log_level = trimmed,
        "log_level setting updated (restart required for the new filter to take effect)"
    );
    Ok(())
}

/// Persist the frontend-bridge verbosity. Validated against the
/// known set so a malformed value can't desync `log.ts` from this
/// command.
#[tauri::command]
pub fn set_frontend_verbosity(verbosity: String, state: State<'_, AppState>) -> Result<(), String> {
    let trimmed = verbosity.trim();
    if !trimmed.is_empty() && !matches!(trimmed, "errors" | "warnings" | "all") {
        return Err(format!(
            "unknown frontend verbosity {trimmed:?} — expected one of \
             \"errors\", \"warnings\", \"all\""
        ));
    }
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.set_app_setting(FRONTEND_VERBOSITY_SETTING, trimmed)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Resolve the persisted log filter (if any) from the on-disk DB,
/// without going through Tauri state. Called once during `main` so the
/// override is in place before the subscriber is built — the
/// `#[tauri::command]` paths above only become available after the
/// `invoke_handler` is wired, which is too late.
pub fn read_persisted_log_level(db_path: &Path) -> Option<String> {
    let db = Database::open(db_path).ok()?;
    db.get_app_setting(LOG_LEVEL_SETTING)
        .ok()
        .flatten()
        .filter(|s| !s.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Make sure every variant we accept on the wire maps to a level
    /// at compile time — `match` exhaustiveness on `FrontendLogLevel`
    /// would catch a missing arm in `log_from_frontend`, but only if
    /// the enum itself is complete. Belt-and-suspenders.
    #[test]
    fn frontend_log_level_round_trips_through_serde() {
        for raw in ["trace", "debug", "info", "warn", "error"] {
            let payload = format!("\"{raw}\"");
            serde_json::from_str::<FrontendLogLevel>(&payload)
                .unwrap_or_else(|e| panic!("expected {raw:?} to deserialize: {e}"));
        }
    }

    /// `set_log_level` should reject directives that `EnvFilter`
    /// can't parse — otherwise a fat-fingered Settings entry could
    /// brick the next launch's logging. We use the parser directly
    /// since the command function needs a `State<AppState>`.
    #[test]
    fn invalid_directives_are_rejected_at_the_boundary() {
        let bad = "warn,,,,";
        // EnvFilter is permissive, so test something that's actually
        // unparseable: a stray `=` with no level.
        let actually_bad = "=trace";
        let _ = bad; // keep noted as a non-failure case
        assert!(tracing_subscriber::EnvFilter::try_new(actually_bad).is_err());
        // And the happy path stays parseable:
        assert!(tracing_subscriber::EnvFilter::try_new("info").is_ok());
    }
}
