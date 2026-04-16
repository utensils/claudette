use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use claudette::agent::PersistentSession;
use parking_lot::Mutex as ParkingMutex;
use tokio::sync::{RwLock, Semaphore};

use claudette::scm_provider::PluginRegistry;
use claudette::scm_provider::scm::{CiCheck, PullRequest};

use crate::commands::apps::DetectedApp;
use crate::remote::DiscoveredServer;
use crate::usage::UsageCacheEntry;

/// Re-export for use in tray module without direct tauri::tray import.
pub type TrayIcon = tauri::tray::TrayIcon;

/// What kind of attention the agent needs from the user.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AttentionKind {
    /// Agent asked a question (AskUserQuestion).
    Ask,
    /// Agent wants plan approval (ExitPlanMode).
    Plan,
}

/// Per-workspace agent session state managed on the Rust side.
pub struct AgentSessionState {
    pub session_id: String,
    pub turn_count: u32,
    /// PID of the currently running agent process, if any.
    pub active_pid: Option<u32>,
    /// Cached custom instructions resolved on first turn.
    pub custom_instructions: Option<String>,
    /// True when the agent is waiting for user input (question, plan approval, permissions).
    pub needs_attention: bool,
    /// What kind of input the agent needs, if any.
    pub attention_kind: Option<AttentionKind>,
    /// Long-lived process that persists MCP servers across turns.
    /// When present, subsequent turns write to this process's stdin instead of
    /// spawning new processes.
    pub persistent_session: Option<Arc<PersistentSession>>,
    /// Set when MCP server config changes while a turn is in flight.
    /// The next call to `send_chat_message` tears down the persistent session
    /// and starts a fresh one with updated `--mcp-config`, then clears
    /// the flag. This avoids killing an agent mid-turn.
    pub mcp_config_dirty: bool,
    /// `--permission-mode plan` flag baked into the current `persistent_session`.
    /// Checked each turn against the requested `plan_mode`; a mismatch forces
    /// a teardown + respawn so the CLI actually exits plan mode after approval.
    pub session_plan_mode: bool,
    /// `--allowedTools` list the current `persistent_session` was spawned with.
    /// A mismatch on the next turn (e.g. permission level changed, or plan
    /// approval elevates access) forces a teardown + respawn.
    pub session_allowed_tools: Vec<String>,
}

/// Handle to an active PTY process.
/// The inner fields are `Send` but not `Sync`, so we wrap them in `Mutex`
/// to satisfy Tauri's `State<AppState>: Send + Sync` requirement.
pub struct PtyHandle {
    /// Writer for sending input to the PTY.
    pub writer: Mutex<Box<dyn std::io::Write + Send>>,
    /// Master side — kept alive for resize operations.
    pub master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    pub child: Mutex<Box<dyn portable_pty::Child + Send>>,

    /// OSC 133 state tracking (kept for potential future use, e.g., PTY status queries)
    #[allow(dead_code)]
    pub current_command: Arc<ParkingMutex<Option<String>>>,
    #[allow(dead_code)]
    pub command_running: Arc<ParkingMutex<bool>>,
    #[allow(dead_code)]
    pub last_exit_code: Arc<ParkingMutex<Option<i32>>>,
}

/// State of the embedded claudette-server subprocess.
pub struct LocalServerState {
    /// Handle to the running server process.
    pub child: tokio::process::Child,
    /// The PID captured at spawn time for reliable synchronous cleanup.
    /// `tokio::process::Child::id()` returns `None` after the child is reaped,
    /// so we store the PID eagerly.
    pub pid: u32,
    /// The connection string printed by the server on startup.
    pub connection_string: String,
}

impl Drop for LocalServerState {
    fn drop(&mut self) {
        // If tokio can still reach the child, check whether it already exited
        // (e.g. crash, external kill). If so, skip the PID-based cleanup to
        // avoid signaling a recycled PID that now belongs to another process.
        if let Ok(Some(_status)) = self.child.try_wait() {
            eprintln!("[cleanup] Server process already exited");
            return;
        }
        // Best-effort tokio-level kill (may fail if runtime is gone).
        let _ = self.child.start_kill();
        // Synchronous POSIX kill — works even during process teardown when the
        // tokio runtime is no longer available.
        kill_process_sync(self.pid);
    }
}

/// Synchronously try to terminate a process and wait for it to exit.
///
/// On Unix, this first sends `SIGTERM` and allows a short grace period for
/// graceful shutdown. If the process does not exit in time, it escalates to
/// `SIGKILL` and reaps the process. This is safe to call from `Drop` impls
/// and the `RunEvent::Exit` handler where async code cannot run. Uses raw
/// libc calls so it does not depend on the tokio runtime.
pub fn kill_process_sync(pid: u32) {
    use std::time::{Duration, Instant};
    let pid = pid as i32;
    // A pid of 0 would signal our own process group — guard against it.
    if pid <= 0 {
        return;
    }

    // First try SIGTERM for a graceful shutdown.
    // SAFETY: pid is a valid positive i32.
    let ret = unsafe { libc::kill(pid, libc::SIGTERM) };
    if ret != 0 {
        let err = std::io::Error::last_os_error();
        if err.raw_os_error() == Some(libc::ESRCH) {
            eprintln!("[cleanup] Server process {pid} already exited");
        } else {
            eprintln!("[cleanup] Failed to send SIGTERM to server process {pid}: {err}");
        }
        return;
    }

    // Give the server up to 500ms to exit gracefully.
    let deadline = Instant::now() + Duration::from_millis(500);
    while Instant::now() < deadline {
        // SAFETY: waitpid with WNOHANG is a standard POSIX call.
        let mut status: libc::c_int = 0;
        let ret = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
        if ret == pid {
            eprintln!("[cleanup] Stopped local claudette-server (pid {pid})");
            return;
        }
        if ret == -1 {
            let err = std::io::Error::last_os_error();
            if err.raw_os_error() == Some(libc::ECHILD) {
                // No such child — already reaped.
                eprintln!("[cleanup] Stopped local claudette-server (pid {pid})");
                return;
            }
            // EINTR or other transient error — retry.
        }
        std::thread::sleep(Duration::from_millis(10));
    }

    // Graceful shutdown timed out — force kill.
    // SAFETY: pid is a valid positive i32.
    unsafe { libc::kill(pid, libc::SIGKILL) };

    // Try to reap the process without blocking indefinitely. If it does not
    // become waitable in time (e.g. stuck in uninterruptible sleep), give up
    // so app shutdown cannot hang forever.
    let reap_deadline = Instant::now() + Duration::from_millis(500);
    while Instant::now() < reap_deadline {
        let mut status: libc::c_int = 0;
        // SAFETY: waitpid with WNOHANG is a standard POSIX call.
        let ret = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
        if ret == pid {
            eprintln!("[cleanup] Force-killed local claudette-server (pid {pid})");
            return;
        }
        if ret == -1 {
            let err = std::io::Error::last_os_error();
            match err.raw_os_error() {
                Some(libc::ECHILD) => {
                    eprintln!("[cleanup] Force-killed local claudette-server (pid {pid})");
                    return;
                }
                Some(libc::EINTR) => {} // Retry.
                _ => {
                    eprintln!(
                        "[cleanup] Sent SIGKILL to claudette-server (pid {pid}) but could not reap: {err}"
                    );
                    return;
                }
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    eprintln!(
        "[cleanup] Sent SIGKILL to claudette-server (pid {pid}) but timed out waiting to reap"
    );
}

/// Cached SCM data for a specific (repo_id, branch) pair.
pub struct ScmCacheEntry {
    pub pull_request: Option<PullRequest>,
    pub ci_checks: Vec<CiCheck>,
    pub last_fetched: Instant,
    pub error: Option<String>,
}

/// In-memory cache for SCM data, keyed by (repo_id, branch_name).
pub struct ScmCache {
    pub entries: RwLock<HashMap<(String, String), ScmCacheEntry>>,
}

impl ScmCache {
    pub fn new() -> Self {
        Self {
            entries: RwLock::new(HashMap::new()),
        }
    }
}

/// Application-wide managed state, shared across all Tauri commands.
pub struct AppState {
    pub db_path: PathBuf,
    pub worktree_base_dir: RwLock<PathBuf>,
    /// Agent sessions keyed by workspace_id.
    pub agents: RwLock<HashMap<String, AgentSessionState>>,
    /// Active PTY processes keyed by pty_id.
    pub ptys: RwLock<HashMap<u64, PtyHandle>>,
    /// Counter for generating unique PTY IDs.
    pub next_pty_id: AtomicU64,
    /// mDNS-discovered servers on the local network.
    pub discovered_servers: RwLock<Vec<DiscoveredServer>>,
    /// Embedded local claudette-server process (when "Share this machine" is active).
    pub local_server: RwLock<Option<LocalServerState>>,
    /// Detected apps cache (populated on startup, read by open_workspace_in_app for TUI wrapping).
    pub detected_apps: RwLock<Vec<DetectedApp>>,
    /// System tray icon handle (None when tray is disabled).
    pub tray_handle: Mutex<Option<TrayIcon>>,
    /// Monotonic counter for generating unique tray IDs. Each call to
    /// `setup_tray` uses a new id so that Linux/libayatana-appindicator
    /// does not see a DBus-path collision when the user toggles the tray
    /// off then on (the previous tray's DBus objects release asynchronously
    /// on the GLib main loop, which can race with our re-registration).
    pub next_tray_seq: AtomicU64,
    /// Cached Claude Code OAuth token and usage data.
    pub usage_cache: RwLock<Option<UsageCacheEntry>>,
    /// SCM provider plugin registry.
    pub plugins: RwLock<PluginRegistry>,
    /// Cached PR/CI status data keyed by (repo_id, branch_name).
    pub scm_cache: ScmCache,
    /// Limits concurrent SCM CLI invocations.
    pub scm_semaphore: Arc<Semaphore>,
}

impl AppState {
    pub fn new(db_path: PathBuf, worktree_base_dir: PathBuf, plugins: PluginRegistry) -> Self {
        Self {
            db_path,
            worktree_base_dir: RwLock::new(worktree_base_dir),
            agents: RwLock::new(HashMap::new()),
            ptys: RwLock::new(HashMap::new()),
            next_pty_id: AtomicU64::new(1),
            discovered_servers: RwLock::new(Vec::new()),
            local_server: RwLock::new(None),
            detected_apps: RwLock::new(Vec::new()),
            tray_handle: Mutex::new(None),
            next_tray_seq: AtomicU64::new(1),
            usage_cache: RwLock::new(None),
            plugins: RwLock::new(plugins),
            scm_cache: ScmCache::new(),
            scm_semaphore: Arc::new(Semaphore::new(4)),
        }
    }

    pub fn next_pty_id(&self) -> u64 {
        self.next_pty_id.fetch_add(1, Ordering::Relaxed)
    }
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use super::*;

    /// Helper: spawn a long-running `sleep` process and return its PID.
    fn spawn_sleep() -> (tokio::process::Child, u32) {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let child = tokio::process::Command::new("sleep")
                .arg("3600")
                .kill_on_drop(true)
                .spawn()
                .expect("failed to spawn sleep");
            let pid = child.id().expect("missing pid");
            (child, pid)
        })
    }

    /// Returns true if the given PID is still alive.
    fn is_alive(pid: u32) -> bool {
        // kill(pid, 0) checks existence without sending a signal.
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }

    #[test]
    fn kill_process_sync_terminates_running_process() {
        let (child, pid) = spawn_sleep();
        assert!(is_alive(pid), "process should be alive after spawn");

        // Forget the tokio child so kill_on_drop doesn't interfere.
        std::mem::forget(child);

        kill_process_sync(pid);

        // Give the OS a moment to update process table.
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert!(
            !is_alive(pid),
            "process should be dead after kill_process_sync"
        );
    }

    #[test]
    fn kill_process_sync_noop_for_dead_process() {
        let (child, pid) = spawn_sleep();
        std::mem::forget(child);

        // Kill it once.
        kill_process_sync(pid);
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert!(!is_alive(pid));

        // Calling again on a dead PID should not panic.
        kill_process_sync(pid);
    }

    #[test]
    fn kill_process_sync_noop_for_zero_pid() {
        // pid 0 would signal our own process group — must be a no-op.
        kill_process_sync(0);
    }

    #[test]
    fn local_server_state_drop_kills_child() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let (child, pid) = rt.block_on(async {
            let child = tokio::process::Command::new("sleep")
                .arg("3600")
                .kill_on_drop(true)
                .spawn()
                .expect("failed to spawn sleep");
            let pid = child.id().expect("missing pid");
            (child, pid)
        });
        assert!(is_alive(pid));

        let state = LocalServerState {
            child,
            pid,
            connection_string: String::new(),
        };
        // Dropping the state should kill the process.
        drop(state);

        std::thread::sleep(std::time::Duration::from_millis(50));
        assert!(
            !is_alive(pid),
            "child should be dead after LocalServerState is dropped"
        );
    }
}
