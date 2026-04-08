use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use tokio::sync::RwLock;

use crate::remote::DiscoveredServer;

/// Per-workspace agent session state managed on the Rust side.
pub struct AgentSessionState {
    pub session_id: String,
    pub turn_count: u32,
    /// PID of the currently running agent process, if any.
    pub active_pid: Option<u32>,
    /// Cached custom instructions resolved on first turn.
    pub custom_instructions: Option<String>,
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
}

/// State of the embedded claudette-server subprocess.
pub struct LocalServerState {
    /// Handle to the running server process (from tauri-plugin-shell sidecar).
    /// Wrapped in Option so we can take ownership in Drop.
    pub child: Option<tauri_plugin_shell::process::CommandChild>,
    /// The connection string printed by the server on startup.
    pub connection_string: String,
}

impl Drop for LocalServerState {
    fn drop(&mut self) {
        // Kill the server process when this state is dropped.
        if let Some(child) = self.child.take() {
            if let Err(e) = child.kill() {
                eprintln!("[cleanup] Failed to kill local server: {e}");
            } else {
                eprintln!("[cleanup] Stopped local claudette-server");
            }
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
        }
    }

    pub fn next_pty_id(&self) -> u64 {
        self.next_pty_id.fetch_add(1, Ordering::Relaxed)
    }
}
