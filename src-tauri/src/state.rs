use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use claudette::agent::PersistentSession;
use parking_lot::Mutex as ParkingMutex;
use tokio::sync::{RwLock, Semaphore};

use claudette::env_provider::{EnvCache, EnvWatcher};
use claudette::plugin_runtime::PluginRegistry;
use claudette::scm::types::{CiCheck, PullRequest};

use crate::commands::apps::DetectedApp;
use crate::remote::DiscoveredServer;
use crate::usage::UsageCacheEntry;
use crate::voice::VoiceProviderRegistry;

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

/// A `control_request: can_use_tool` the CLI is waiting on the host to
/// resolve via `control_response`. Keyed in `AgentSessionState::pending_permissions`
/// by tool_use_id so UI callbacks (AgentQuestionCard, PlanApprovalCard) can
/// resolve them using the tool_use_id they already track.
#[derive(Debug, Clone)]
pub struct PendingPermission {
    pub request_id: String,
    pub tool_name: String,
    /// Original tool input sent by the model — used verbatim as the base for
    /// `updatedInput` when approving (we layer user-collected answers on top).
    pub original_input: serde_json::Value,
}

/// Per-session agent state managed on the Rust side. One of these per
/// active chat session (i.e. per tab). The parent workspace is tracked so
/// tray/notification code can aggregate across sessions in the same worktree.
pub struct AgentSessionState {
    /// The workspace this session belongs to. Used for reverse lookups:
    /// worktree path for spawning, tray grouping, notification routing.
    pub workspace_id: String,
    /// Claude CLI `--resume` UUID. Empty until the first turn completes.
    /// This is the CLI session ID; the `chat_sessions.id` that keys
    /// `AppState.agents` is referred to as `chat_session_id` throughout
    /// the codebase to keep the two distinct.
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
    /// Set when the deferred attention notification has been fired for the
    /// current attention cycle. Cleared whenever `needs_attention` is cleared
    /// (i.e. when the user responds). Prevents repeated banner/sound when
    /// multiple `can_use_tool` prompts queue inside a single cycle.
    pub attention_notification_sent: bool,
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
    /// `CLAUDE_CODE_DISABLE_1M_CONTEXT` value baked into the current
    /// `persistent_session` at spawn. A mismatch on the next turn (user
    /// switched from 200k to 1M model variant, or vice versa) forces a
    /// teardown + respawn so the env var matches the new selection.
    pub session_disable_1m_context: bool,
    /// Outstanding `can_use_tool` control requests awaiting a `control_response`,
    /// keyed by tool_use_id. See [`PendingPermission`].
    pub pending_permissions: HashMap<String, PendingPermission>,
    /// Set when the agent emits `ExitPlanMode` during the current persistent
    /// session. The plan phase is over even if the frontend fails to flip
    /// `plan_mode=false` on the next turn, so we force a teardown regardless
    /// of the requested flag. Reset after teardown.
    pub session_exited_plan: bool,
    /// Snapshot of the env-provider resolved env `vars` map baked into
    /// the current persistent session at spawn. Each new turn re-resolves
    /// and compares; any divergence (user edited `.envrc`, ran
    /// `direnv allow`, toggled a provider, changed a plugin setting)
    /// forces a teardown so the fresh env reaches the agent subprocess.
    /// Stored as a plain map because `EnvMap` already is one; keeping a
    /// snapshot lets the comparison be a single equality check.
    pub session_resolved_env: claudette::env_provider::types::EnvMap,
    /// Lifecycle handle for the in-process MCP server bridge that powers
    /// `mcp__claudette__send_to_user`. Created alongside `persistent_session`
    /// at spawn time; dropped when `persistent_session = None` so the listener
    /// task is cancelled and the socket file unlinked. `None` between spawns.
    pub mcp_bridge: Option<Arc<claudette::agent_mcp::bridge::McpBridgeSession>>,
    /// `id` of the user message that triggered the most recent turn, used as
    /// the FK anchor for any agent-authored attachments produced during that
    /// turn. Updated each time a new user message is inserted; cleared on
    /// session teardown. See `agent_mcp_sink::ChatBridgeSink`.
    pub last_user_msg_id: Option<String>,
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
    /// so we store the PID eagerly. Only read on Unix, where `Drop` passes
    /// it to `kill_process_sync` to send SIGTERM/SIGKILL + reap; on Windows
    /// `child.start_kill()` alone suffices and this field is held only to
    /// keep the struct layout consistent across platforms.
    #[cfg_attr(windows, allow(dead_code))]
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
        // Best-effort tokio-level kill (may fail if runtime is gone). On
        // Windows this invokes `TerminateProcess`, which is immediate and
        // leaves no zombie state — so the extra synchronous cleanup below
        // is only meaningful on Unix where SIGTERM → grace → SIGKILL →
        // `waitpid` is needed to reap the child.
        let _ = self.child.start_kill();
        #[cfg(unix)]
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
#[cfg(unix)]
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
    /// Agent sessions keyed by `chat_sessions.id` (the tab/session id).
    /// Each value carries its owning `workspace_id` for reverse lookups
    /// (tray aggregation, notifications, worktree path resolution).
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
    /// Native voice provider registry and model cache metadata.
    pub voice: Arc<VoiceProviderRegistry>,
    /// mtime-keyed cache of env-provider exports. One entry per
    /// `(worktree, plugin_name)` pair, invalidated when any watched
    /// file (`.envrc`, `mise.toml`, `.env`, `flake.lock`, etc.) changes.
    pub env_cache: Arc<EnvCache>,
    /// Filesystem watcher that proactively evicts `env_cache` entries
    /// when any plugin's `watched` paths change on disk. Set at
    /// startup from `main.rs` once the `AppHandle` is available so
    /// the change callback can emit an `env-cache-invalidated` Tauri
    /// event; `None` before setup finishes or if watcher construction
    /// failed (logged, lazy mtime invalidation still covers).
    pub env_watcher: RwLock<Option<Arc<EnvWatcher>>>,
    /// Cached PR/CI status data keyed by (repo_id, branch_name).
    pub scm_cache: ScmCache,
    /// Limits concurrent SCM CLI invocations.
    pub scm_semaphore: Arc<Semaphore>,
    /// Pending updater handle from the most recent `check_for_updates_with_channel`
    /// call. The Update struct holds the downloaded payload + signature context
    /// and is not Serialize, so it lives here instead of crossing the IPC boundary.
    pub pending_update: tokio::sync::Mutex<Option<tauri_plugin_updater::Update>>,
    /// CESP sound pack playback state (no-repeat + debounce tracking).
    pub cesp_playback: Mutex<claudette::cesp::SoundPlaybackState>,
    /// Cancellation signal for an in-flight `claude auth login` subprocess.
    /// The waiter task owns the `Child` directly and selects between
    /// `child.wait()` and this receiver; sending on the paired sender asks
    /// the waiter to kill the process and emit a cancelled completion event.
    /// `Some` while a flow is running, `None` otherwise.
    pub auth_login_cancel: tokio::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
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
            voice: Arc::new(VoiceProviderRegistry::new(
                VoiceProviderRegistry::default_model_root(),
            )),
            env_cache: Arc::new(EnvCache::new()),
            env_watcher: RwLock::new(None),
            scm_cache: ScmCache::new(),
            scm_semaphore: Arc::new(Semaphore::new(4)),
            pending_update: tokio::sync::Mutex::new(None),
            cesp_playback: Mutex::new(claudette::cesp::SoundPlaybackState::new()),
            auth_login_cancel: tokio::sync::Mutex::new(None),
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
    use claudette::process::CommandWindowExt as _;

    /// Helper: spawn a long-running `sleep` process and return its PID.
    fn spawn_sleep() -> (tokio::process::Child, u32) {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let child = tokio::process::Command::new("sleep")
                .no_console_window()
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
                .no_console_window()
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
