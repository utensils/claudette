//! `TmuxHost` — `InteractiveHost` impl backed by the system `tmux` binary.
//!
//! Each session is a separate tmux session named after its `SessionId`. Output
//! is routed through a per-session FIFO using `tmux pipe-pane`:
//!
//! ```text
//!   tmux session ── pipe-pane ──▶ FIFO ──▶ [blocking reader thread] ──▶ tokio::sync::broadcast
//!                                                                                 │
//!                                                                                 ├─▶ Attach #1 (mpsc)
//!                                                                                 └─▶ Attach #2 (mpsc)
//! ```
//!
//! A single per-session blocking reader pumps FIFO bytes into a
//! `tokio::sync::broadcast::Sender<AttachEvent>` so multiple `attach()` callers
//! each get an independent stream of the *same* output (conformance requires
//! this — see `multiple_attaches_each_receive_events`). When the reader hits
//! EOF on the FIFO and verifies via `tmux has-session` that the session is
//! gone, it broadcasts a synthetic `AttachEvent::Exit { exit_status: -1,
//! reason: "session ended" }` so attach streams unblock.
//!
//! `detach()` is a no-op at the tmux level; conformance only requires the
//! session keep running, which dropping a single subscriber doesn't affect.
//! `stop()` issues `tmux kill-session` after an optional `C-c` for graceful
//! mode and removes the FIFO file.

#![cfg(unix)]

use super::availability::{TmuxAvailability, check_tmux};
use super::{
    AttachEvent, AttachId, AttachStream, HostError, HostHandle, HostSessionSummary, HostStatus,
    InteractiveHost, ScreenSnapshot, SessionId,
};
use crate::agent::interactive_protocol::{InputPayload, SessionSpec, StopMode};
use async_trait::async_trait;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::process::Command;
use tokio::sync::Mutex;

/// Per-session broadcast hub. Owned by `TmuxHost::sessions`; one entry per
/// live tmux session that we've issued `pipe-pane` against.
struct SessionState {
    /// Broadcasts FIFO output / exit events to every `attach()` subscriber.
    /// `broadcast` is the right primitive because each subscriber needs its
    /// own copy of every event and slow subscribers must not block the
    /// reader thread (broadcast drops the oldest item on overflow).
    events: tokio::sync::broadcast::Sender<AttachEvent>,
}

/// `InteractiveHost` impl that shells out to the system `tmux` binary.
///
/// Holds a per-host map of live sessions so multiple `attach()` calls share a
/// single FIFO reader. `runtime_dir` is where per-session FIFOs live; the
/// caller (usually `claude_interactive.rs`) owns the directory lifetime.
pub struct TmuxHost {
    runtime_dir: PathBuf,
    next_attach: Arc<AtomicU64>,
    /// Per-session broadcast hub, lazy-initialized on first `ensure_session`.
    sessions: Arc<Mutex<HashMap<SessionId, SessionState>>>,
}

impl TmuxHost {
    /// Construct a new host. `runtime_dir` will be created lazily on first
    /// `ensure_session` if it doesn't exist.
    pub fn new(runtime_dir: PathBuf) -> Self {
        Self {
            runtime_dir,
            next_attach: Arc::new(AtomicU64::new(0)),
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn fifo_path(&self, sid: &SessionId) -> PathBuf {
        self.runtime_dir.join(format!("{}.fifo", sid.as_str()))
    }
}

/// Spawn the per-session blocking FIFO tailer. Reads bytes and pushes
/// `AttachEvent::Output` frames onto `events`. On EOF (writer side closed),
/// confirms the tmux session is actually gone before emitting
/// `AttachEvent::Exit` and terminating. Spurious 0-byte reads (FIFO refill
/// gap) trigger a short sleep + a session-liveness check.
fn spawn_fifo_tailer(
    fifo: PathBuf,
    sid: SessionId,
    events: tokio::sync::broadcast::Sender<AttachEvent>,
) {
    std::thread::spawn(move || {
        use std::io::Read;
        // `O_RDONLY` blocks until tmux's pipe-pane opens the write end.
        let mut f = match std::fs::OpenOptions::new().read(true).open(&fifo) {
            Ok(f) => f,
            Err(e) => {
                let _ = events.send(AttachEvent::Error {
                    message: format!("fifo open failed: {e}"),
                    recoverable: false,
                });
                return;
            }
        };
        let mut buf = [0u8; 8192];
        let mut seq: u64 = 0;
        loop {
            match f.read(&mut buf) {
                Ok(0) => {
                    // EOF: tmux's pipe-pane writer is gone. Confirm the
                    // session is actually dead before signalling Exit —
                    // tmux can briefly close pipe-pane on `respawn-pane`
                    // and similar without the session ending.
                    if !tmux_session_exists_blocking(sid.as_str()) {
                        let _ = events.send(AttachEvent::Exit {
                            exit_status: -1,
                            reason: "session ended".into(),
                        });
                        return;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                Ok(n) => {
                    seq += 1;
                    // `send` fails only when every subscriber has dropped.
                    // That's fine — the next `attach()` will mint a new
                    // subscriber from the same broadcast Sender and the
                    // tailer keeps running.
                    let _ = events.send(AttachEvent::Output {
                        bytes: buf[..n].to_vec(),
                        seq,
                    });
                }
                Err(e) => {
                    let _ = events.send(AttachEvent::Error {
                        message: format!("fifo read failed: {e}"),
                        recoverable: false,
                    });
                    return;
                }
            }
        }
    });
}

/// Synchronous (`tmux has-session`) probe used by the FIFO tailer thread,
/// which runs outside the tokio runtime and can't `await`.
fn tmux_session_exists_blocking(sid: &str) -> bool {
    std::process::Command::new("tmux")
        .args(["has-session", "-t", sid])
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[async_trait]
impl InteractiveHost for TmuxHost {
    async fn ensure_session(
        &self,
        sid: &SessionId,
        spec: &SessionSpec,
    ) -> Result<HostHandle, HostError> {
        // 1. Determine current tmux state.
        let exists = Command::new("tmux")
            .args(["has-session", "-t", sid.as_str()])
            .output()
            .await
            .map(|o| o.status.success())
            .unwrap_or(false);

        // 2. Create the session + pipe-pane if missing.
        if !exists {
            std::fs::create_dir_all(&self.runtime_dir).map_err(HostError::Io)?;

            let mut cmd = Command::new("tmux");
            cmd.args([
                "new-session",
                "-d",
                "-s",
                sid.as_str(),
                "-x",
                &spec.cols.to_string(),
                "-y",
                &spec.rows.to_string(),
            ]);
            for (k, v) in &spec.env {
                cmd.args(["-e", &format!("{k}={v}")]);
            }
            cmd.args([
                "-e",
                &format!("CLAUDE_CONFIG_DIR={}", spec.claude_config_dir),
            ]);
            cmd.arg("-c").arg(&spec.working_dir);
            cmd.arg("--").arg(&spec.claude_binary);
            for arg in &spec.claude_args {
                cmd.arg(arg);
            }
            let st = cmd.status().await.map_err(HostError::Io)?;
            if !st.success() {
                return Err(HostError::Other(format!("tmux new-session failed: {st}")));
            }

            // 3. (Re)create the FIFO and wire pipe-pane to it.
            let fifo = self.fifo_path(sid);
            let _ = std::fs::remove_file(&fifo);
            nix::unistd::mkfifo(
                &fifo,
                nix::sys::stat::Mode::S_IRUSR | nix::sys::stat::Mode::S_IWUSR,
            )
            .map_err(|e| HostError::Other(format!("mkfifo {}: {e}", fifo.display())))?;

            let pipe_cmd = format!("cat >> {}", shell_escape(&fifo.to_string_lossy()));
            let st = Command::new("tmux")
                .args(["pipe-pane", "-O", "-t", sid.as_str(), &pipe_cmd])
                .status()
                .await
                .map_err(HostError::Io)?;
            if !st.success() {
                return Err(HostError::Other(format!("tmux pipe-pane failed: {st}")));
            }

            // 4. Create the broadcast hub and spawn the FIFO tailer.
            // Capacity 1024 is generous: subscribers that fall behind by
            // more than 1024 events get a `RecvError::Lagged` and skip
            // forward (acceptable — TUIs repaint on the next frame).
            let (tx, _rx) = tokio::sync::broadcast::channel::<AttachEvent>(1024);
            spawn_fifo_tailer(fifo, sid.clone(), tx.clone());

            self.sessions
                .lock()
                .await
                .insert(sid.clone(), SessionState { events: tx });
        }

        Ok(HostHandle {
            sid: sid.clone(),
            pid: None,
            rows: spec.rows,
            cols: spec.cols,
        })
    }

    async fn attach(&self, sid: &SessionId) -> Result<(AttachId, AttachStream), HostError> {
        let id = AttachId(self.next_attach.fetch_add(1, Ordering::SeqCst));

        // Subscribe to the per-session broadcast hub.
        let rx = {
            let sessions = self.sessions.lock().await;
            let state = sessions
                .get(sid)
                .ok_or_else(|| HostError::NotFound(sid.as_str().into()))?;
            state.events.subscribe()
        };

        // Bridge broadcast → mpsc → AttachStream. We can't simply box the
        // BroadcastStream because the trait requires
        // `Stream<Item = AttachEvent>`, while BroadcastStream yields
        // `Result<AttachEvent, RecvError>`. Filtering lagged events out
        // here keeps the public surface clean and matches sidecar's mpsc
        // shape.
        let (tx, rx_mpsc) = tokio::sync::mpsc::channel::<AttachEvent>(1024);
        tokio::spawn(async move {
            let mut rx = rx;
            loop {
                match rx.recv().await {
                    Ok(ev) => {
                        let was_exit = matches!(ev, AttachEvent::Exit { .. });
                        if tx.send(ev).await.is_err() {
                            return;
                        }
                        if was_exit {
                            return;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        // Subscriber fell behind — skip and keep going.
                        // Output dropouts on a TUI heal on the next repaint.
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                }
            }
        });

        use tokio_stream::wrappers::ReceiverStream;
        let stream: AttachStream = Box::pin(ReceiverStream::new(rx_mpsc));
        Ok((id, stream))
    }

    async fn send_input(&self, sid: &SessionId, payload: InputPayload) -> Result<(), HostError> {
        // Build the `tmux send-keys` argv. `-l` flips literal mode for
        // `Text` / `Bytes`; `Keys` variants are key names like `C-c`,
        // `Enter`, `PageUp` and must NOT use `-l`.
        let mut args: Vec<String> = vec!["send-keys".into(), "-t".into(), sid.as_str().into()];
        match payload {
            InputPayload::Text { text } => {
                args.push("-l".into());
                args.push("--".into());
                args.push(text);
            }
            InputPayload::Keys { name } => {
                args.push("--".into());
                args.push(name);
            }
            InputPayload::Bytes { bytes_b64 } => {
                use base64::Engine as _;
                let raw = base64::engine::general_purpose::STANDARD
                    .decode(&bytes_b64)
                    .map_err(|e| HostError::Other(format!("invalid bytes_b64: {e}")))?;
                let s = String::from_utf8_lossy(&raw).to_string();
                args.push("-l".into());
                args.push("--".into());
                args.push(s);
            }
        }
        let st = Command::new("tmux")
            .args(&args)
            .status()
            .await
            .map_err(HostError::Io)?;
        if !st.success() {
            return Err(HostError::Other(format!("tmux send-keys failed: {st}")));
        }
        Ok(())
    }

    async fn capture_screen(&self, sid: &SessionId) -> Result<ScreenSnapshot, HostError> {
        // `-p` writes to stdout, `-J` joins wrapped lines, `-e` keeps
        // raw escape sequences so the frontend can replay attributes.
        let out = Command::new("tmux")
            .args(["capture-pane", "-t", sid.as_str(), "-pJ", "-e"])
            .output()
            .await
            .map_err(HostError::Io)?;
        if !out.status.success() {
            return Err(HostError::Other(format!(
                "tmux capture-pane failed: {}",
                String::from_utf8_lossy(&out.stderr)
            )));
        }

        // Fetch real pane dimensions; fall back to a safe 24x80 if the
        // format string returns something unparseable.
        let dims = Command::new("tmux")
            .args([
                "display-message",
                "-p",
                "-t",
                sid.as_str(),
                "#{pane_height},#{pane_width}",
            ])
            .output()
            .await
            .map_err(HostError::Io)?;
        let s = String::from_utf8_lossy(&dims.stdout);
        let (rows, cols): (u16, u16) = {
            let mut parts = s.trim().split(',');
            let h = parts.next().and_then(|p| p.parse().ok()).unwrap_or(24);
            let w = parts.next().and_then(|p| p.parse().ok()).unwrap_or(80);
            (h, w)
        };

        Ok(ScreenSnapshot {
            rows,
            cols,
            ansi_bytes: out.stdout,
        })
    }

    async fn resize(&self, sid: &SessionId, rows: u16, cols: u16) -> Result<(), HostError> {
        let st = Command::new("tmux")
            .args([
                "resize-window",
                "-t",
                sid.as_str(),
                "-x",
                &cols.to_string(),
                "-y",
                &rows.to_string(),
            ])
            .status()
            .await
            .map_err(HostError::Io)?;
        if !st.success() {
            return Err(HostError::Other(format!("tmux resize-window failed: {st}")));
        }
        Ok(())
    }

    async fn detach(&self, _sid: &SessionId, _attach_id: AttachId) -> Result<(), HostError> {
        // The attach stream's lifetime is managed entirely by the caller
        // dropping the `AttachStream`; there is no per-attach state on
        // the tmux side. Returning `Ok(())` here matches the v1 protocol
        // semantics — detach is a no-op for tmux.
        Ok(())
    }

    async fn stop(&self, sid: &SessionId, mode: StopMode) -> Result<(), HostError> {
        match mode {
            StopMode::Graceful => {
                // Best-effort C-c; ignore failure (session may already be
                // gone). Then wait up to 5s for the underlying process to
                // exit — same budget as the sidecar host.
                let _ = Command::new("tmux")
                    .args(["send-keys", "-t", sid.as_str(), "--", "C-c"])
                    .status()
                    .await;
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
                while std::time::Instant::now() < deadline {
                    let still = Command::new("tmux")
                        .args(["has-session", "-t", sid.as_str()])
                        .output()
                        .await
                        .map(|o| o.status.success())
                        .unwrap_or(false);
                    if !still {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
            }
            StopMode::Force => {}
        }
        // Always kill — graceful path is best-effort.
        let _ = Command::new("tmux")
            .args(["kill-session", "-t", sid.as_str()])
            .status()
            .await
            .map_err(HostError::Io)?;

        // Drop the broadcast hub. Subscribers see `RecvError::Closed`
        // which closes their attach streams. The FIFO tailer thread will
        // observe EOF on its next read and emit `AttachEvent::Exit` — but
        // only if a subscriber survives (broadcast send fails harmlessly
        // when nobody's listening). Either way, callers see exit through
        // the tailer's broadcast or stream close.
        let _ = self.sessions.lock().await.remove(sid);
        let _ = std::fs::remove_file(self.fifo_path(sid));
        Ok(())
    }

    async fn status(&self) -> Result<HostStatus, HostError> {
        let out = Command::new("tmux")
            .args(["list-sessions", "-F", "#{session_name}|#{session_created}"])
            .output()
            .await;
        let mut sessions = Vec::new();
        let host_version = match check_tmux().await {
            TmuxAvailability::Available { version } => format!("tmux {version}"),
            TmuxAvailability::TooOld { version, .. } => format!("tmux {version} (too old)"),
            TmuxAvailability::NotFound => "tmux (not found)".into(),
        };
        if let Ok(o) = out
            && o.status.success()
        {
            for line in String::from_utf8_lossy(&o.stdout).lines() {
                let mut parts = line.split('|');
                let name = parts.next().unwrap_or("");
                if !name.starts_with("claudette-") {
                    continue;
                }
                sessions.push(HostSessionSummary {
                    sid: SessionId(name.to_string()),
                    pid: None,
                    running: true,
                });
            }
        }
        Ok(HostStatus {
            host_version,
            sessions,
        })
    }
}

/// POSIX-shell-safe single-quote escape for a path that will be embedded in
/// the `pipe-pane` shell command. tmux invokes the pipe command via
/// `/bin/sh -c <cmd>`, so anything that survives single-quoting is safe.
fn shell_escape(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::interactive_host::conformance::{ConformanceFixture, run};
    use std::process::Command as StdCommand;

    /// Locate a workspace binary, building it first if necessary. Mirrors
    /// `find_workspace_binary` in `sidecar.rs` — we can't use
    /// `CARGO_BIN_EXE_*` because that requires `-Z bindeps`.
    fn find_workspace_binary(pkg: &str, bin: &str) -> PathBuf {
        let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
        let status = StdCommand::new(&cargo)
            .args(["build", "-p", pkg])
            .status()
            .expect("failed to invoke cargo to build workspace binary");
        assert!(status.success(), "cargo build -p {pkg} failed");

        let meta_out = StdCommand::new(&cargo)
            .args(["metadata", "--format-version", "1", "--no-deps"])
            .output()
            .expect("failed to run cargo metadata");
        assert!(meta_out.status.success(), "cargo metadata failed");
        let meta: serde_json::Value =
            serde_json::from_slice(&meta_out.stdout).expect("invalid cargo metadata json");
        let target_dir = meta
            .get("target_directory")
            .and_then(|v| v.as_str())
            .expect("metadata missing target_directory")
            .to_string();
        let path = PathBuf::from(target_dir).join("debug").join(bin);
        assert!(path.exists(), "{bin} binary missing at {path:?}");
        path
    }

    #[test]
    fn shell_escape_handles_single_quotes() {
        assert_eq!(shell_escape("/tmp/foo"), "'/tmp/foo'");
        assert_eq!(shell_escape("/tmp/foo's"), "'/tmp/foo'\\''s'");
        assert_eq!(shell_escape(""), "''");
    }

    #[tokio::test]
    #[ignore = "requires tmux >= 3.0"]
    async fn tmux_passes_conformance() {
        match check_tmux().await {
            TmuxAvailability::Available { .. } => {}
            other => {
                eprintln!("skipping: tmux not available: {other:?}");
                return;
            }
        }

        // Per-run runtime dir under /tmp keeps FIFO paths short and
        // unique across concurrent `cargo test` invocations.
        let short = uuid::Uuid::new_v4().simple().to_string();
        let runtime_dir = PathBuf::from("/tmp").join(format!("th-{}", &short[..8]));
        let _ = std::fs::create_dir_all(&runtime_dir);
        let host = TmuxHost::new(runtime_dir.clone());

        let stub = find_workspace_binary("stub-tui", "stub-tui");

        let fx = ConformanceFixture {
            sid: SessionId(format!("claudette-tmux-conformance-{}", &short[..8])),
            spec: SessionSpec {
                working_dir: std::env::temp_dir().to_string_lossy().into(),
                rows: 24,
                cols: 80,
                claude_binary: stub.to_string_lossy().into(),
                claude_args: vec![],
                env: vec![],
                claude_config_dir: std::env::temp_dir().to_string_lossy().into(),
            },
        };
        run(&host, &fx).await;

        // Best-effort cleanup; stop() already removed the FIFO and we
        // don't care about leftover state since the dir name is uuid'd.
        let _ = std::fs::remove_dir_all(&runtime_dir);
    }
}
