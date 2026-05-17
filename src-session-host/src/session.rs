//! Per-session PTY ownership and event fan-out.
//!
//! A `Session` owns one `PtyPair` from `portable-pty` and the child process it
//! spawned. It exposes:
//!
//! - `spawn` — open the PTY, exec the binary, start reader + waiter tasks.
//! - `send_input` — write user input (text / decoded base64 / named key) to the
//!   master writer.
//! - `resize` — propagate a new size into the PTY.
//! - `stop_graceful` — politely ask the child to exit (Ctrl+C); the server
//!   handles the eventual wait + force-kill in `Stop`.
//! - `capture_screen` — return a clone of the rolling raw-ANSI capture buffer
//!   (capped at 256 KB) for snapshotting in `CaptureScreen`.
//!
//! Output from the PTY is fanned out two ways: appended to the capture buffer
//! (for `CaptureScreen`) and broadcast on `tx` as `SessionEvent::Output` so
//! later attach streams (Task C4) can subscribe live. The waiter task emits
//! `SessionEvent::Exit` when the child terminates.

use std::io::Read;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use claudette::agent::interactive_protocol::{HookFired, InputPayload, SessionSpec};
use portable_pty::{CommandBuilder, NativePtySystem, PtyPair, PtySize, PtySystem};
use tokio::sync::{Mutex, broadcast};
use tracing::info;

/// Events broadcast to live attaches and exit-watchers.
///
/// `Hook` is reserved for hook-fired notifications; it is unused by the
/// session itself today but lives here so attach streams (C4) and the
/// hook detector (later) can share one channel.
#[derive(Debug, Clone)]
pub enum SessionEvent {
    Output { bytes: Vec<u8>, seq: u64 },
    Hook(HookFired),
    Exit { exit_status: i32, reason: String },
}

/// One interactive Claude PTY. See module docs.
pub struct Session {
    pub sid: String,
    pub pid: Option<u32>,
    pub rows: Mutex<u16>,
    pub cols: Mutex<u16>,
    /// Broadcast channel for live attaches.
    pub tx: broadcast::Sender<SessionEvent>,
    pty: Mutex<Option<PtyPair>>,
    writer: Mutex<Option<Box<dyn std::io::Write + Send>>>,
    /// Last screen replay bytes (capped at 256 KB). Used by `capture_screen`.
    pub screen: Arc<Mutex<Vec<u8>>>,
    pub running: Arc<AtomicBool>,
}

impl Session {
    /// Open a PTY, exec the configured binary, and start the background
    /// reader + waiter tasks. Returns a shared `Session` handle the server
    /// stores in its `SessionMap`.
    pub async fn spawn(sid: String, spec: SessionSpec) -> std::io::Result<Arc<Self>> {
        let pty_system = NativePtySystem::default();
        let pair = pty_system
            .openpty(PtySize {
                rows: spec.rows,
                cols: spec.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| std::io::Error::other(e.to_string()))?;

        let mut cmd = CommandBuilder::new(&spec.claude_binary);
        for arg in &spec.claude_args {
            cmd.arg(arg);
        }
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        cmd.env("CLAUDE_CONFIG_DIR", &spec.claude_config_dir);
        cmd.cwd(&spec.working_dir);

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        let pid = child.process_id();
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| std::io::Error::other(e.to_string()))?;

        let (tx, _) = broadcast::channel(2048);
        let running = Arc::new(AtomicBool::new(true));
        let session = Arc::new(Self {
            sid: sid.clone(),
            pid,
            rows: Mutex::new(spec.rows),
            cols: Mutex::new(spec.cols),
            tx: tx.clone(),
            pty: Mutex::new(Some(pair)),
            writer: Mutex::new(Some(writer)),
            screen: Arc::new(Mutex::new(Vec::new())),
            running: running.clone(),
        });

        // Reader task: pumps PTY output to broadcast + screen blob.
        // `portable-pty`'s reader is std-blocking, so this lives on a
        // blocking-pool thread.
        let screen = session.screen.clone();
        let tx_reader = tx.clone();
        let running_reader = running.clone();
        tokio::task::spawn_blocking(move || {
            let mut buf = [0u8; 8192];
            let mut seq: u64 = 0;
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        seq += 1;
                        let bytes = buf[..n].to_vec();
                        // Capture into screen, cap at 256 KB.
                        {
                            let mut s = screen.blocking_lock();
                            s.extend_from_slice(&bytes);
                            let max = 256 * 1024;
                            if s.len() > max {
                                let drop_to = s.len() - max;
                                s.drain(..drop_to);
                            }
                        }
                        let _ = tx_reader.send(SessionEvent::Output { bytes, seq });
                    }
                }
            }
            running_reader.store(false, Ordering::SeqCst);
        });

        // Waiter task: reaps child + emits Exit.
        let tx_exit = tx.clone();
        tokio::task::spawn_blocking(move || match child.wait() {
            Ok(status) => {
                let code = status.exit_code() as i32;
                let _ = tx_exit.send(SessionEvent::Exit {
                    exit_status: code,
                    reason: format!("child exited with {code}"),
                });
            }
            Err(e) => {
                let _ = tx_exit.send(SessionEvent::Exit {
                    exit_status: -1,
                    reason: format!("wait failed: {e}"),
                });
            }
        });

        info!(%sid, ?pid, "session spawned");
        Ok(session)
    }

    /// Write `payload` to the PTY master.
    ///
    /// Text payloads are sent verbatim. Bytes payloads are base64-decoded
    /// before write. Named keys go through `key_bytes`, which intentionally
    /// returns an empty slice for unknown names so callers can't smuggle
    /// arbitrary control sequences by mistake.
    pub async fn send_input(&self, payload: InputPayload) -> std::io::Result<()> {
        let bytes = match payload {
            InputPayload::Text { text } => text.into_bytes(),
            InputPayload::Bytes { bytes_b64 } => {
                use base64::Engine as _;
                base64::engine::general_purpose::STANDARD
                    .decode(bytes_b64)
                    .map_err(std::io::Error::other)?
            }
            InputPayload::Keys { name } => key_bytes(&name),
        };
        let mut w = self.writer.lock().await;
        let Some(writer) = w.as_mut() else {
            return Err(std::io::Error::other("session closed"));
        };
        writer.write_all(&bytes)?;
        writer.flush()?;
        Ok(())
    }

    /// Resize the PTY and update the session's recorded rows/cols.
    pub async fn resize(&self, rows: u16, cols: u16) -> std::io::Result<()> {
        let pty = self.pty.lock().await;
        let Some(pair) = pty.as_ref() else {
            return Err(std::io::Error::other("session closed"));
        };
        pair.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        *self.rows.lock().await = rows;
        *self.cols.lock().await = cols;
        Ok(())
    }

    /// Send Ctrl+C to request a graceful shutdown. The server task is
    /// responsible for waiting / force-killing on top of this.
    pub async fn stop_graceful(&self) {
        let _ = self
            .send_input(InputPayload::Keys { name: "C-c".into() })
            .await;
    }

    /// Snapshot of the rolling raw-ANSI capture buffer.
    pub async fn capture_screen(&self) -> Vec<u8> {
        self.screen.lock().await.clone()
    }
}

/// Strict named-key matcher. Unknown names return an empty slice so callers
/// can't accidentally emit raw control bytes through a typoed key name.
fn key_bytes(name: &str) -> Vec<u8> {
    match name {
        "Enter" => vec![b'\r'],
        "Tab" => vec![b'\t'],
        "Backspace" => vec![0x7f],
        "Escape" => vec![0x1b],
        "C-c" => vec![0x03],
        "C-d" => vec![0x04],
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_bytes_known_names() {
        assert_eq!(key_bytes("Enter"), b"\r");
        assert_eq!(key_bytes("Tab"), b"\t");
        assert_eq!(key_bytes("Backspace"), vec![0x7f]);
        assert_eq!(key_bytes("Escape"), vec![0x1b]);
        assert_eq!(key_bytes("C-c"), vec![0x03]);
        assert_eq!(key_bytes("C-d"), vec![0x04]);
    }

    #[test]
    fn key_bytes_unknown_yields_empty() {
        assert!(key_bytes("F1").is_empty());
        assert!(key_bytes("").is_empty());
        assert!(key_bytes("Ctrl+C").is_empty());
    }
}
