use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use parking_lot::Mutex as ParkingMutex;
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
    /// The connection string printed by the server on startup.
    pub connection_string: String,
}

impl Drop for LocalServerState {
    fn drop(&mut self) {
        // Kill the server process when this state is dropped.
        // Use start_kill() instead of kill() since we're in a sync context.
        if let Err(e) = self.child.start_kill() {
            eprintln!("[cleanup] Failed to kill local server: {e}");
        } else {
            eprintln!("[cleanup] Stopped local claudette-server");
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
