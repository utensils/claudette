use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use tokio::sync::RwLock;

/// Per-workspace agent session state managed on the Rust side.
pub struct AgentSessionState {
    pub session_id: String,
    pub turn_count: u32,
    /// PID of the currently running agent process, if any.
    pub active_pid: Option<u32>,
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
}

impl AppState {
    pub fn new(db_path: PathBuf, worktree_base_dir: PathBuf) -> Self {
        Self {
            db_path,
            worktree_base_dir: RwLock::new(worktree_base_dir),
            agents: RwLock::new(HashMap::new()),
            ptys: RwLock::new(HashMap::new()),
            next_pty_id: AtomicU64::new(1),
        }
    }

    pub fn next_pty_id(&self) -> u64 {
        self.next_pty_id.fetch_add(1, Ordering::Relaxed)
    }
}
