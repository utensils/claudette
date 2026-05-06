//! Discovery file the running Claudette GUI advertises so the
//! `claudette` CLI can find its IPC socket.
//!
//! On startup the GUI writes `${state_dir}/Claudette/app.json` containing
//! its pid, IPC socket address, auth token, and version. On shutdown the
//! file is removed via the [`AppInfoFile`] RAII guard. The directory
//! name is `Claudette` (capitalized) to match `STATE_SUBDIR` below.
//!
//! `${state_dir}` is `dirs::data_local_dir()` (e.g.
//! `~/Library/Application Support` on macOS, `~/.local/share` on Linux,
//! `%LOCALAPPDATA%` on Windows). Stale files (process no longer alive)
//! are detected by the CLI via `kill(pid, 0)` and ignored.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Filename used for the discovery file inside the per-app state dir.
const APP_INFO_FILENAME: &str = "app.json";
/// Subdirectory inside `${state_dir}` for Claudette's discovery files.
/// Mirrors the layout other tools follow under `Application Support`.
const STATE_SUBDIR: &str = "Claudette";

/// JSON shape persisted to `app.json`. Versioned via the `version` field
/// of the embedded protocol header — bumps when the discovery shape itself
/// changes (not when the app version changes).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppInfo {
    /// PID of the running GUI. CLI uses `kill(pid, 0)` to detect stale
    /// files (the GUI crashed without unlinking the discovery record).
    pub pid: u32,
    /// Socket address — Unix domain socket path or Windows named pipe
    /// name — to dial for IPC.
    pub socket: String,
    /// Bearer token CLI passes on each request as defense in depth on
    /// top of filesystem permissions.
    pub token: String,
    /// `claudette` package version (`env!("CARGO_PKG_VERSION")` at the
    /// time the app started).
    pub app_version: String,
    /// ISO 8601 timestamp of when the app started writing this file.
    /// Surfaced in `claudette-cli status` for triage.
    pub started_at: String,
}

/// Resolve the path to the discovery file. Always returns a path even if
/// the parent directory doesn't exist yet — [`AppInfoFile::write`] creates
/// it.
pub fn app_info_path() -> PathBuf {
    let base = dirs::data_local_dir().unwrap_or_else(std::env::temp_dir);
    base.join(STATE_SUBDIR).join(APP_INFO_FILENAME)
}

/// RAII guard around the discovery file. Writes on construction, removes
/// on `Drop`. The GUI holds one of these for its full lifetime; if the
/// process panics, `Drop` still runs and the file goes away.
pub struct AppInfoFile {
    path: PathBuf,
}

impl AppInfoFile {
    /// Serialize `info` to disk at [`app_info_path`]. Creates parent
    /// directories as needed. Tightens permissions to 0600 on Unix so
    /// only the user who launched the GUI can read the auth token.
    pub fn write(info: &AppInfo) -> Result<Self, std::io::Error> {
        let path = app_info_path();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let bytes = serde_json::to_vec_pretty(info)?;
        // Atomic publish: write to a sibling temp file, fsync the
        // permissions, then rename into place. A CLI client racing
        // discovery against a write-in-progress GUI would otherwise see
        // a half-written file and report a malformed JSON error.
        // `rename` is atomic on POSIX and on Windows when the target
        // already exists or doesn't (NTFS ReplaceFile semantics).
        let tmp_path = path.with_extension("json.tmp");
        std::fs::write(&tmp_path, &bytes)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&tmp_path)?.permissions();
            perms.set_mode(0o600);
            std::fs::set_permissions(&tmp_path, perms)?;
        }
        std::fs::rename(&tmp_path, &path)?;
        Ok(Self { path })
    }
}

impl Drop for AppInfoFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}
