use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use claudette::agent::PersistentSession;
use parking_lot::Mutex as ParkingMutex;
use tokio::sync::RwLock;

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

/// Synchronously send SIGKILL to a process and wait for it to exit.
///
/// This is safe to call from `Drop` impls and the `RunEvent::Exit` handler
/// where async code cannot run. Uses raw libc calls so it does not depend on
/// the tokio runtime.
pub fn kill_process_sync(pid: u32) {
    #[cfg(unix)]
    {
        use std::time::{Duration, Instant};
        let pid = pid as i32;
        // SAFETY: libc::kill with SIGKILL is a standard POSIX call.
        // A pid of 0 would signal our own process group — guard against it.
        if pid <= 0 {
            return;
        }

        // First try SIGTERM for a graceful shutdown.
        // SAFETY: pid is a valid positive i32.
        let ret = unsafe { libc::kill(pid, libc::SIGTERM) };
        if ret != 0 {
            // Process already gone — nothing to do.
            eprintln!("[cleanup] Server process {pid} already exited");
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

        // Reap the zombie so the PID is released to the OS. Loop to handle
        // EINTR — only stop when waitpid returns the pid or ECHILD.
        loop {
            // SAFETY: waitpid is a standard POSIX call.
            let ret = unsafe { libc::waitpid(pid, std::ptr::null_mut(), 0) };
            if ret == pid {
                break;
            }
            if ret == -1 {
                let err = std::io::Error::last_os_error();
                if err.raw_os_error() != Some(libc::EINTR) {
                    break; // ECHILD or unexpected error — stop.
                }
                // EINTR — retry waitpid.
            }
        }
        eprintln!("[cleanup] Force-killed local claudette-server (pid {pid})");
    }

    #[cfg(not(unix))]
    {
        let _ = pid;
        // On non-Unix, fall through to tokio's start_kill() in the Drop impl.
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
    /// Cached Claude Code OAuth token and usage data.
    pub usage_cache: RwLock<Option<UsageCacheEntry>>,
}

impl AppState {
    pub fn new(db_path: PathBuf, worktree_base_dir: PathBuf) -> Self {
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
            usage_cache: RwLock::new(None),
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
            let mut child = tokio::process::Command::new("sleep")
                .arg("3600")
                .kill_on_drop(true)
                .spawn()
                .expect("failed to spawn sleep");
            let pid = child.id().expect("missing pid");
            // Detach stdout/stderr ownership so kill_on_drop doesn't race.
            let _ = child.stdout.take();
            let _ = child.stderr.take();
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
            let mut child = tokio::process::Command::new("sleep")
                .arg("3600")
                .kill_on_drop(true)
                .spawn()
                .expect("failed to spawn sleep");
            let pid = child.id().expect("missing pid");
            let _ = child.stdout.take();
            let _ = child.stderr.take();
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
