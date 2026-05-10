//! CLI side of the GUI's discovery file. Reads `${state_dir}/Claudette/app.json`,
//! verifies the GUI's PID is still alive, and returns the IPC socket
//! address + auth token.
//!
//! Mirrors `claudette-tauri/src/app_info.rs` — both files target the
//! same on-disk location with the same JSON shape. Stale records (PID
//! gone, e.g. GUI crashed without unlinking) are reported as "GUI not
//! running" rather than blindly dialed.

use std::path::PathBuf;

use serde::Deserialize;

const APP_INFO_FILENAME: &str = "app.json";
const STATE_SUBDIR: &str = "Claudette";

/// Discovery record persisted by the running GUI.
///
/// Mirrors `claudette_tauri::app_info::AppInfo`. We re-declare the type
/// here rather than depending on the GUI crate so the CLI doesn't pull
/// `tauri` (and a webview) into its build.
#[derive(Debug, Clone, Deserialize)]
pub struct AppInfo {
    pub pid: u32,
    pub socket: String,
    pub token: String,
    /// `claudette` package version of the running GUI. Surfaced by
    /// `claudette version` for triage; not currently used for compat
    /// gating.
    #[serde(default)]
    #[allow(dead_code)]
    pub app_version: String,
    /// ISO 8601 (or epoch-prefixed) instant the GUI started writing
    /// this record. Surfaced by `claudette status` (future) for
    /// triage.
    #[serde(default)]
    #[allow(dead_code)]
    pub started_at: String,
}

#[derive(Debug)]
pub enum DiscoveryError {
    /// No `app.json` exists — GUI was never started, or shut down cleanly.
    NotRunning,
    /// `app.json` exists but the named PID is not alive — the GUI
    /// crashed or was killed without unlinking. CLI surfaces this
    /// distinctly so users know to start a fresh app instance.
    Stale { pid: u32 },
    /// `app.json` exists but is malformed or unreadable.
    Malformed(String),
}

impl std::fmt::Display for DiscoveryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotRunning => write!(
                f,
                "Claudette is not running. Open the desktop app first, then re-run this command."
            ),
            Self::Stale { pid } => write!(
                f,
                "Claudette discovery file is stale (pid {pid} is no longer alive). Open the desktop app to refresh."
            ),
            Self::Malformed(msg) => write!(f, "Claudette discovery file is malformed: {msg}"),
        }
    }
}

impl std::error::Error for DiscoveryError {}

/// Resolve the path to the discovery file, mirroring the GUI's logic.
pub fn discovery_path() -> PathBuf {
    let base = dirs::data_local_dir().unwrap_or_else(std::env::temp_dir);
    base.join(STATE_SUBDIR).join(APP_INFO_FILENAME)
}

/// Read + validate the discovery file. Returns the parsed [`AppInfo`]
/// when a live GUI is found, otherwise a structured error explaining
/// why we can't connect.
pub fn read_app_info() -> Result<AppInfo, DiscoveryError> {
    let path = discovery_path();
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(DiscoveryError::NotRunning);
        }
        Err(e) => return Err(DiscoveryError::Malformed(e.to_string())),
    };
    let info: AppInfo =
        serde_json::from_slice(&bytes).map_err(|e| DiscoveryError::Malformed(e.to_string()))?;

    if !pid_alive(info.pid) {
        // Don't auto-delete here — let the next GUI start overwrite it
        // atomically. CLI just refuses to dial.
        return Err(DiscoveryError::Stale { pid: info.pid });
    }

    Ok(info)
}

#[cfg(unix)]
fn pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    // SAFETY: kill(pid, 0) checks existence without sending a signal.
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

#[cfg(windows)]
fn pid_alive(pid: u32) -> bool {
    // Mirrors `claudette-tauri::boot_probation::is_pid_alive`: open the
    // process with the most narrowly scoped right that lets us call
    // `GetExitCodeProcess`, then treat `STILL_ACTIVE` (259) as "alive"
    // and any other exit code (or `OpenProcess` returning NULL because
    // the PID is gone or a security descriptor we can't probe) as
    // "dead". A failed probe collapses to "dead" so the caller surfaces
    // the cleaner `Stale { pid }` diagnostic instead of waiting for the
    // IPC dial to fail with a generic "connect refused".
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    if pid == 0 {
        return false;
    }
    // SAFETY: OpenProcess with a non-null PID either returns a valid
    // handle or NULL on failure. We always close a non-null handle.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return false;
    }
    let mut code: u32 = 0;
    // SAFETY: handle is a valid process handle; code is a writable u32.
    let ok = unsafe { GetExitCodeProcess(handle, &mut code) };
    // SAFETY: handle is non-null and we own it.
    unsafe {
        CloseHandle(handle);
    }
    if ok == 0 {
        return false;
    }
    code as i32 == STILL_ACTIVE
}

#[cfg(not(any(unix, windows)))]
fn pid_alive(_pid: u32) -> bool {
    true
}
