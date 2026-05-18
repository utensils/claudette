//! `SidecarHost` — the `InteractiveHost` impl that talks to
//! `claudette-session-host` over a local socket.
//!
//! Connection topology:
//!
//! - **One long-lived "control" connection** owned by the host. Used for
//!   request/response traffic (`EnsureSession`, `SendInput`,
//!   `CaptureScreen`, `Resize`, `Stop`, `Status`, plus the symmetric
//!   no-op `Detach`). Requests are multiplexed via a monotonic
//!   `request_id` and per-id `oneshot::Sender<Response>` table.
//!
//! - **One short-lived "attach" connection per `attach()` call.** The
//!   session-host's `Attach` handler switches the connection into
//!   streaming mode and never returns to the dispatch loop, so a fresh
//!   socket is required. The attach task handshakes, sends the `Attach`
//!   envelope, awaits `AttachStarted`, then pumps inbound
//!   `InboundFrame::Event` frames to the caller's `AttachStream`. Closing
//!   the receiver drops the task, which closes the socket, which the
//!   server treats as a detach.
//!
//! This split mirrors how `attach_stream.rs` in the session-host tests
//! uses two separate connections — one for control, one for streaming.

use super::{
    AttachEvent, AttachId, AttachStream, HostError, HostHandle, HostSessionSummary, HostStatus,
    InteractiveHost, ScreenSnapshot, SessionId,
};
use crate::agent::interactive_protocol::{
    Event, InboundFrame, InputPayload, PROTOCOL_VERSION, Request, RequestEnvelope, Response,
    SessionSpec, StopMode,
    frame::{read_frame, write_frame},
};
use async_trait::async_trait;
use base64::Engine as _;
use interprocess::local_socket::Name;
use interprocess::local_socket::tokio::{Stream as SockStream, prelude::*};
#[cfg(unix)]
use interprocess::local_socket::{GenericFilePath, ToFsName};
#[cfg(windows)]
use interprocess::local_socket::{GenericNamespaced, ToNsName};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{Mutex, OnceCell, mpsc, oneshot};

/// Outbound frame the writer task picks off the mpsc.
enum OutFrame {
    Bytes(Vec<u8>),
}

/// Multiplexed control connection: one socket, many in-flight requests
/// correlated by `request_id`. Owns reader and writer Tokio tasks for the
/// lifetime of the connection.
struct ConnHandle {
    tx: mpsc::Sender<OutFrame>,
    inflight: Arc<Mutex<HashMap<u64, oneshot::Sender<Response>>>>,
    next_id: Arc<AtomicU64>,
}

impl ConnHandle {
    async fn connect(socket_path: &Path) -> std::io::Result<Self> {
        let stream = open_handshaked(socket_path).await?;
        let (r, w) = stream.split();
        Ok(Self::spawn_tasks(r, w))
    }

    /// Spawn the reader/writer tasks against a pre-handshaked split stream.
    /// Generic over any `AsyncRead`/`AsyncWrite` halves so unit tests can
    /// drive the reader/writer fault paths with `tokio::io::duplex` rather
    /// than a real socket. Production callers go through
    /// [`ConnHandle::connect`].
    fn spawn_tasks<R, W>(mut r: R, mut w: W) -> Self
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let (tx_out, mut rx_out) = mpsc::channel::<OutFrame>(256);
        let inflight: Arc<Mutex<HashMap<u64, oneshot::Sender<Response>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let next_id = Arc::new(AtomicU64::new(1));

        // Writer task: drains tx_out and writes frames. Exits when the
        // sender side drops or a write fails — in either case the reader
        // task will also notice the socket closing on its next read.
        tokio::spawn(async move {
            while let Some(OutFrame::Bytes(bytes)) = rx_out.recv().await {
                if write_frame(&mut w, &bytes).await.is_err() {
                    break;
                }
            }
        });

        // Reader task: routes Response frames to the matching inflight
        // oneshot by request_id. Events should not arrive on the control
        // connection (we never send Attach over it), so we silently drop
        // them if they do — this keeps the connection robust to server
        // bugs without hanging.
        let inflight_r = inflight.clone();
        tokio::spawn(async move {
            loop {
                let bytes = match read_frame(&mut r).await {
                    Ok(b) => b,
                    Err(_) => break,
                };
                let Ok(frame) = serde_json::from_slice::<InboundFrame>(&bytes) else {
                    continue;
                };
                match frame {
                    InboundFrame::Response {
                        request_id,
                        response,
                    } => {
                        if let Some(tx) = inflight_r.lock().await.remove(&request_id) {
                            let _ = tx.send(response);
                        }
                    }
                    InboundFrame::Event(_) => {
                        // Events shouldn't reach the control connection;
                        // the server doesn't switch us to streaming mode
                        // because we never send Attach here. Silently drop.
                    }
                }
            }
            // Reader exited — drain inflight to wake any awaiters with a
            // synthetic Error response so callers don't hang forever.
            let mut g = inflight_r.lock().await;
            for (_id, tx) in g.drain() {
                let _ = tx.send(Response::Error {
                    message: "connection closed".into(),
                    recoverable: false,
                });
            }
        });

        Self {
            tx: tx_out,
            inflight,
            next_id,
        }
    }

    /// Issue a request and await the matching response. Allocates a fresh
    /// `request_id`, registers a oneshot in the inflight table, sends the
    /// envelope to the writer task, then awaits the oneshot.
    async fn request(&self, req: Request) -> Result<Response, HostError> {
        let request_id = self
            .next_id
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let (tx_resp, rx_resp) = oneshot::channel();
        self.inflight.lock().await.insert(request_id, tx_resp);
        let env = RequestEnvelope {
            request_id,
            request: req,
        };
        let bytes = serde_json::to_vec(&env).map_err(|e| HostError::Other(e.to_string()))?;
        self.tx
            .send(OutFrame::Bytes(bytes))
            .await
            .map_err(|_| HostError::Other("conn closed".into()))?;
        rx_resp
            .await
            .map_err(|_| HostError::Other("response channel dropped".into()))
    }
}

/// Open a socket connection and perform the Hello handshake. Returns the
/// (read,write)-splittable stream ready for further envelope traffic.
async fn open_handshaked(socket_path: &Path) -> std::io::Result<SockStream> {
    let name = socket_name(socket_path)?;
    let stream = SockStream::connect(name).await?;
    {
        let (mut r, mut w) = (&stream, &stream);
        handshake_streams(&mut r, &mut w).await?;
    }
    Ok(stream)
}

/// Run the Hello / HelloAck handshake against an arbitrary
/// `AsyncRead`/`AsyncWrite` pair. Extracted from [`open_handshaked`] so the
/// fault paths (non-HelloAck response, `HelloNack`, malformed first frame,
/// EOF before any frame) can be exercised by unit tests over
/// `tokio::io::duplex` without a real socket binary in the way.
async fn handshake_streams<R, W>(r: &mut R, w: &mut W) -> std::io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let hello = Request::Hello {
        protocol_version: PROTOCOL_VERSION,
        claudette_version: env!("CARGO_PKG_VERSION").to_string(),
    };
    let env = RequestEnvelope {
        request_id: 0,
        request: hello,
    };
    let bytes = serde_json::to_vec(&env).map_err(std::io::Error::other)?;
    write_frame(w, &bytes).await?;
    let first = read_frame(r).await?;
    let inbound: InboundFrame = serde_json::from_slice(&first).map_err(std::io::Error::other)?;
    match inbound {
        InboundFrame::Response {
            response: Response::HelloAck { .. },
            ..
        } => Ok(()),
        InboundFrame::Response { response, .. } => Err(std::io::Error::other(format!(
            "handshake failed: {response:?}"
        ))),
        InboundFrame::Event(ev) => Err(std::io::Error::other(format!(
            "expected HelloAck, got event: {ev:?}"
        ))),
    }
}

/// Convert a filesystem path / pipe path into an `interprocess` `Name`.
fn socket_name(path: &Path) -> std::io::Result<Name<'_>> {
    #[cfg(unix)]
    {
        path.to_fs_name::<GenericFilePath>()
    }
    #[cfg(windows)]
    {
        let raw = path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| std::io::Error::other("invalid pipe path"))?;
        raw.to_ns_name::<GenericNamespaced>()
    }
}

/// `InteractiveHost` impl that talks to `claudette-session-host` over a
/// local socket. Holds an exclusive long-lived control connection that's
/// created on first use and shared across every non-attach trait call.
pub struct SidecarHost {
    socket_path: PathBuf,
    binary_path: PathBuf,
    /// Lazy-initialized once on first trait call. Wrapped in `OnceCell` so
    /// concurrent first calls share a single control connection.
    ///
    /// **Known limitation (tracked in CLAUDE.md):** the cached `ConnHandle`
    /// in `OnceCell` is never reset if the underlying connection dies.
    /// If the bundled `claudette-session-host` sidecar exits (e.g., 600s
    /// idle timer) while Claudette is still running, subsequent
    /// `interactive_*` commands fail with "conn closed" until Claudette
    /// is restarted. Resolution: replace `OnceCell` with
    /// `Mutex<Option<ConnHandle>>` and reconnect on dead-conn detection.
    /// FIXME: implement reconnect (see CLAUDE.md "Known limitations").
    conn: OnceCell<ConnHandle>,
}

impl SidecarHost {
    pub fn new(socket_path: PathBuf, binary_path: PathBuf) -> Self {
        Self {
            socket_path,
            binary_path,
            conn: OnceCell::new(),
        }
    }

    /// Ensure the sidecar is running, spawning it if not. Idempotent.
    ///
    /// First tries to connect to `socket_path`. If the connect fails with
    /// `ConnectionRefused` / `NotFound`, spawn `binary_path` as a detached
    /// child and retry the connect for up to ~2 seconds.
    pub async fn ensure_running(&self) -> std::io::Result<()> {
        // Fast path: socket already responds.
        if try_connect(&self.socket_path).await.is_ok() {
            return Ok(());
        }
        // Spawn the sidecar.
        spawn_sidecar(&self.binary_path, &self.socket_path)?;
        // Retry the connect briefly while the sidecar binds.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        let mut delay = std::time::Duration::from_millis(25);
        loop {
            match try_connect(&self.socket_path).await {
                Ok(()) => return Ok(()),
                Err(e) => {
                    if std::time::Instant::now() >= deadline {
                        return Err(e);
                    }
                    tokio::time::sleep(delay).await;
                    delay = (delay * 2).min(std::time::Duration::from_millis(200));
                }
            }
        }
    }

    /// Lazily initialize and return the shared control `ConnHandle`.
    async fn conn(&self) -> Result<&ConnHandle, HostError> {
        self.conn
            .get_or_try_init(|| async {
                ConnHandle::connect(&self.socket_path)
                    .await
                    .map_err(HostError::Io)
            })
            .await
    }
}

/// Try opening a connection (drops it immediately on success). Used as a
/// liveness probe before deciding whether to spawn the sidecar binary.
async fn try_connect(socket_path: &Path) -> std::io::Result<()> {
    let name = socket_name(socket_path)?;
    let _ = SockStream::connect(name).await?;
    Ok(())
}

/// Spawn the sidecar binary with the socket-path argument. The child runs
/// detached — we don't await its exit, and `kill_on_drop` stays at the
/// default `false` so the sidecar outlives this process if needed.
fn spawn_sidecar(binary: &Path, socket: &Path) -> std::io::Result<()> {
    let mut cmd = tokio::process::Command::new(binary);
    cmd.arg("--socket").arg(socket);
    // Detach: don't tie the sidecar's lifetime to this process. The sidecar
    // has its own idle-exit timer (see `idle_exit.rs` in session-host).
    cmd.kill_on_drop(false);
    let _child = cmd.spawn()?;
    Ok(())
}

/// Open a brand-new connection, handshake, send `Attach`, await
/// `AttachStarted`, then spawn a reader task that pumps events into `tx`
/// until the connection closes. Returns the `attach_id` echoed by the
/// server.
async fn open_attach_stream(
    socket_path: &Path,
    sid: String,
    tx: mpsc::Sender<AttachEvent>,
) -> Result<u64, HostError> {
    let stream = open_handshaked(socket_path).await.map_err(HostError::Io)?;
    let (mut r, mut w) = stream.split();

    // Send Attach as request_id=1 (this connection has no other inflight
    // traffic, so we don't need a counter).
    let env = RequestEnvelope {
        request_id: 1,
        request: Request::Attach { sid: sid.clone() },
    };
    let bytes = serde_json::to_vec(&env).map_err(|e| HostError::Other(e.to_string()))?;
    write_frame(&mut w, &bytes)
        .await
        .map_err(|e| HostError::Io(std::io::Error::other(e)))?;

    // Read the ack.
    let ack_bytes = read_frame(&mut r)
        .await
        .map_err(|e| HostError::Io(std::io::Error::other(e)))?;
    let ack: InboundFrame = serde_json::from_slice(&ack_bytes)
        .map_err(|e| HostError::Protocol(format!("bad ack: {e}")))?;
    let attach_id = match ack {
        InboundFrame::Response {
            response: Response::AttachStarted { attach_id },
            ..
        } => attach_id,
        InboundFrame::Response { response, .. } => {
            return Err(HostError::Other(format!("Attach failed: {response:?}")));
        }
        InboundFrame::Event(ev) => {
            return Err(HostError::Protocol(format!(
                "expected AttachStarted, got event: {ev:?}"
            )));
        }
    };

    // Spawn the event pump. Owns the write half too — dropping the
    // task at task-end closes the socket, which the server treats as
    // a detach.
    tokio::spawn(async move {
        // `_w` is held so the connection stays open. Dropping it
        // closes the write half; the server-side write half will
        // notice when we drop the read half too.
        let _w = w;
        loop {
            let bytes = match read_frame(&mut r).await {
                Ok(b) => b,
                Err(_) => break,
            };
            let Ok(frame) = serde_json::from_slice::<InboundFrame>(&bytes) else {
                continue;
            };
            let ev_out = match frame {
                InboundFrame::Event(Event::Output { bytes_b64, seq, .. }) => {
                    let decoded = base64::engine::general_purpose::STANDARD
                        .decode(bytes_b64)
                        .unwrap_or_default();
                    AttachEvent::Output {
                        bytes: decoded,
                        seq,
                    }
                }
                InboundFrame::Event(Event::Hook { hook, .. }) => AttachEvent::Hook(hook),
                InboundFrame::Event(Event::Exit {
                    exit_status,
                    reason,
                    ..
                }) => AttachEvent::Exit {
                    exit_status,
                    reason,
                },
                InboundFrame::Event(Event::StreamError {
                    message,
                    recoverable,
                    ..
                }) => AttachEvent::Error {
                    message,
                    recoverable,
                },
                // Stray Responses on an attach stream are unexpected;
                // skip them.
                InboundFrame::Response { .. } => continue,
            };
            let was_exit = matches!(ev_out, AttachEvent::Exit { .. });
            if tx.send(ev_out).await.is_err() {
                // Receiver dropped — bail out so the connection closes.
                break;
            }
            if was_exit {
                break;
            }
        }
    });

    Ok(attach_id)
}

#[async_trait]
impl InteractiveHost for SidecarHost {
    async fn ensure_session(
        &self,
        sid: &SessionId,
        spec: &SessionSpec,
    ) -> Result<HostHandle, HostError> {
        let conn = self.conn().await?;
        let resp = conn
            .request(Request::EnsureSession {
                sid: sid.0.clone(),
                spec: spec.clone(),
            })
            .await?;
        match resp {
            Response::SessionStarted {
                sid: got_sid,
                pid,
                rows,
                cols,
            } => Ok(HostHandle {
                sid: SessionId(got_sid),
                pid: Some(pid),
                rows,
                cols,
            }),
            Response::Error { message, .. } => Err(HostError::Other(message)),
            other => Err(HostError::Protocol(format!(
                "unexpected EnsureSession response: {other:?}"
            ))),
        }
    }

    async fn attach(&self, sid: &SessionId) -> Result<(AttachId, AttachStream), HostError> {
        // Each attach opens its OWN connection. The session-host's Attach
        // handler switches the connection into streaming mode and never
        // returns to the dispatch loop, so reusing the multiplexed
        // control connection would break every subsequent request.
        let (tx, rx) = mpsc::channel::<AttachEvent>(1024);
        let attach_id = open_attach_stream(&self.socket_path, sid.0.clone(), tx).await?;
        use tokio_stream::wrappers::ReceiverStream;
        let stream: AttachStream = Box::pin(ReceiverStream::new(rx));
        Ok((AttachId(attach_id), stream))
    }

    async fn send_input(&self, sid: &SessionId, payload: InputPayload) -> Result<(), HostError> {
        let conn = self.conn().await?;
        let resp = conn
            .request(Request::SendInput {
                sid: sid.0.clone(),
                payload,
            })
            .await?;
        match resp {
            Response::Ok => Ok(()),
            Response::Error { message, .. } => Err(HostError::Other(message)),
            other => Err(HostError::Protocol(format!(
                "unexpected SendInput response: {other:?}"
            ))),
        }
    }

    async fn capture_screen(&self, sid: &SessionId) -> Result<ScreenSnapshot, HostError> {
        let conn = self.conn().await?;
        let resp = conn
            .request(Request::CaptureScreen { sid: sid.0.clone() })
            .await?;
        match resp {
            Response::ScreenSnapshot {
                rows,
                cols,
                ansi_bytes_b64,
            } => {
                let ansi_bytes = base64::engine::general_purpose::STANDARD
                    .decode(ansi_bytes_b64)
                    .map_err(|e| HostError::Protocol(e.to_string()))?;
                Ok(ScreenSnapshot {
                    rows,
                    cols,
                    ansi_bytes,
                })
            }
            Response::Error { message, .. } => Err(HostError::Other(message)),
            other => Err(HostError::Protocol(format!(
                "unexpected CaptureScreen response: {other:?}"
            ))),
        }
    }

    async fn resize(&self, sid: &SessionId, rows: u16, cols: u16) -> Result<(), HostError> {
        let conn = self.conn().await?;
        let resp = conn
            .request(Request::Resize {
                sid: sid.0.clone(),
                rows,
                cols,
            })
            .await?;
        match resp {
            Response::Ok => Ok(()),
            Response::Error { message, .. } => Err(HostError::Other(message)),
            other => Err(HostError::Protocol(format!(
                "unexpected Resize response: {other:?}"
            ))),
        }
    }

    async fn detach(&self, sid: &SessionId, attach_id: AttachId) -> Result<(), HostError> {
        let conn = self.conn().await?;
        // The v1 protocol treats explicit Detach as a no-op (closing the
        // attach socket is the canonical detach), but we issue it for
        // symmetry and to surface protocol errors. The actual receiver
        // gets `None` when the per-attach connection closes — that
        // happens when the caller drops the `AttachStream` returned
        // earlier.
        let resp = conn
            .request(Request::Detach {
                sid: sid.0.clone(),
                attach_id: attach_id.0,
            })
            .await?;
        match resp {
            Response::Ok => Ok(()),
            Response::Error { message, .. } => Err(HostError::Other(message)),
            other => Err(HostError::Protocol(format!(
                "unexpected Detach response: {other:?}"
            ))),
        }
    }

    async fn stop(&self, sid: &SessionId, mode: StopMode) -> Result<(), HostError> {
        let conn = self.conn().await?;
        let resp = conn
            .request(Request::Stop {
                sid: sid.0.clone(),
                mode,
            })
            .await?;
        match resp {
            Response::Stopped { .. } | Response::Ok => Ok(()),
            Response::Error { message, .. } => Err(HostError::Other(message)),
            other => Err(HostError::Protocol(format!(
                "unexpected Stop response: {other:?}"
            ))),
        }
    }

    async fn status(&self) -> Result<HostStatus, HostError> {
        let conn = self.conn().await?;
        let resp = conn.request(Request::Status).await?;
        match resp {
            Response::Status {
                sessions,
                host_version,
            } => Ok(HostStatus {
                host_version,
                sessions: sessions
                    .into_iter()
                    .map(|s| HostSessionSummary {
                        sid: SessionId(s.sid),
                        pid: s.pid,
                        running: s.running,
                    })
                    .collect(),
            }),
            Response::Error { message, .. } => Err(HostError::Other(message)),
            other => Err(HostError::Protocol(format!(
                "unexpected Status response: {other:?}"
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::interactive_host::conformance::{ConformanceFixture, run};
    use std::process::Command;

    /// Locate a workspace binary, building it first if necessary. Mirrors
    /// the `find_stub_tui` helper used by the session-host integration
    /// tests — we cannot use `CARGO_BIN_EXE_*` because that requires
    /// `-Z bindeps` on stable.
    fn find_workspace_binary(pkg: &str, bin: &str) -> PathBuf {
        let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
        let status = Command::new(&cargo)
            .args(["build", "-p", pkg])
            .status()
            .expect("failed to invoke cargo to build workspace binary");
        assert!(status.success(), "cargo build -p {pkg} failed");

        let meta_out = Command::new(&cargo)
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

    #[tokio::test]
    #[ignore = "spawned-sidecar conformance test — run with --ignored"]
    async fn sidecar_passes_conformance() {
        let bin = find_workspace_binary("claudette-session-host", "claudette-session-host");
        let stub = find_workspace_binary("stub-tui", "stub-tui");

        // Unique-per-test socket path so multiple `cargo test` invocations
        // don't collide on a stale stuck sidecar. Keep the path SHORT —
        // macOS `sun_path` caps Unix-domain socket paths at 104 bytes, so
        // we use a short uuid prefix in `/tmp/` rather than `$TMPDIR`
        // (which on macOS is `/var/folders/.../T/` and already eats ~60
        // bytes of the budget).
        let short = uuid::Uuid::new_v4().simple().to_string();
        let socket = std::path::PathBuf::from("/tmp").join(format!("sh-{}.sock", &short[..8]));
        let _ = std::fs::remove_file(&socket);

        let host = SidecarHost::new(socket.clone(), bin);
        host.ensure_running().await.expect("ensure_running");

        let fx = ConformanceFixture {
            sid: SessionId("claudette-conformance-aaaaaaaa".into()),
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

        // Clean up the socket file on the way out (the sidecar will idle-exit
        // on its own; we just don't want a stale path lying around).
        let _ = std::fs::remove_file(&socket);
    }

    // --- ConnHandle / handshake fault-path unit tests (Task B1) ------------
    //
    // These tests drive `handshake_streams` and `ConnHandle::spawn_tasks`
    // against `tokio::io::duplex` rather than a real `claudette-session-host`
    // socket, so they pin the reader/writer/handshake fault paths in plain
    // unit-test scope (no spawned sidecar, no `--ignored` gate).

    use crate::agent::interactive_protocol::frame::{read_frame, write_frame};
    use crate::agent::interactive_protocol::{InboundFrame, Request, RequestEnvelope, Response};
    use tokio::io::duplex;

    /// Read the client's Hello envelope off `r`. Used by the duplex-backed
    /// handshake tests so the server side advances past the client's first
    /// write before doing anything fault-y.
    async fn drain_client_hello<R>(r: &mut R) -> RequestEnvelope
    where
        R: tokio::io::AsyncRead + Unpin,
    {
        let bytes = read_frame(r).await.expect("client hello frame");
        serde_json::from_slice::<RequestEnvelope>(&bytes).expect("hello envelope parses")
    }

    /// Helper: serialize an `InboundFrame` to a length-prefixed wire frame.
    async fn write_inbound<W>(w: &mut W, frame: &InboundFrame)
    where
        W: tokio::io::AsyncWrite + Unpin,
    {
        let bytes = serde_json::to_vec(frame).expect("frame serializes");
        write_frame(w, &bytes).await.expect("write inbound frame");
    }

    /// Step 1: Malformed first frame. The server writes valid framing
    /// (length-prefix + payload) but the payload is not JSON, so the
    /// handshake parse fails. We expect `handshake_streams` to surface the
    /// `serde_json` parse error as an `io::Error::other(...)`.
    #[tokio::test]
    async fn handshake_rejects_non_hello_first_frame() {
        let (mut client_r, mut server_w) = duplex(4096);
        let (mut server_r, mut client_w) = duplex(4096);

        // Server side: consume the client Hello, then send a malformed
        // JSON payload as the "first" response frame.
        let server = tokio::spawn(async move {
            let _hello = drain_client_hello(&mut server_r).await;
            // Length prefix says 5 bytes, payload is literally "hello" —
            // valid framing, invalid JSON.
            write_frame(&mut server_w, b"hello")
                .await
                .expect("server writes garbage payload");
        });

        let res = handshake_streams(&mut client_r, &mut client_w).await;
        server.await.expect("server task");
        let err = res.expect_err("handshake should reject malformed first frame");
        assert_eq!(err.kind(), std::io::ErrorKind::Other);
    }

    /// Step 2: `HelloNack` branch. The server completes a real framed
    /// response, but with a `HelloNack` instead of `HelloAck`. The
    /// production code surfaces this via `io::Error::other` formatted with
    /// the response debug — so the error message must mention HelloNack.
    #[tokio::test]
    async fn handshake_surfaces_hello_nack() {
        let (mut client_r, mut server_w) = duplex(4096);
        let (mut server_r, mut client_w) = duplex(4096);

        let server = tokio::spawn(async move {
            let _hello = drain_client_hello(&mut server_r).await;
            let nack = InboundFrame::Response {
                request_id: 0,
                response: Response::HelloNack {
                    reason: "protocol mismatch".into(),
                    supported_versions: vec![2, 3],
                },
            };
            write_inbound(&mut server_w, &nack).await;
        });

        let res = handshake_streams(&mut client_r, &mut client_w).await;
        server.await.expect("server task");
        let err = res.expect_err("handshake should surface HelloNack");
        let msg = err.to_string();
        assert!(
            msg.contains("HelloNack"),
            "expected HelloNack in error message, got: {msg}"
        );
        assert!(
            msg.contains("protocol mismatch"),
            "expected nack reason in error message, got: {msg}"
        );
    }

    /// Step 3: EOF mid-stream wakes inflight waiters. Build a `ConnHandle`
    /// against a duplex stream that's already past the handshake, submit a
    /// `request()`, then drop the server side. The reader task should
    /// notice EOF and drain the inflight table with a synthetic error
    /// response, so the awaiter resolves promptly with `HostError::Other`
    /// rather than hanging forever.
    #[tokio::test]
    async fn request_wakes_when_reader_sees_eof() {
        // client-write -> server-read so the writer task can flush; the
        // server side immediately closes after consuming one envelope.
        let (client_r, server_w) = duplex(4096);
        let (mut server_r, client_w) = duplex(4096);

        let conn = ConnHandle::spawn_tasks(client_r, client_w);

        // Wait for the writer task to flush the request, then close both
        // halves of the server side. Dropping `server_w` and `server_r`
        // closes the duplex pair from the peer's perspective — the reader
        // task's `read_frame` then returns Err and the inflight drain
        // path runs.
        let server = tokio::spawn(async move {
            let _envelope = read_frame(&mut server_r).await.expect("server reads req");
            // Drop both halves to surface EOF to the client side.
            drop(server_r);
            drop(server_w);
        });

        // request() awaits the inflight oneshot. The reader task's
        // synthetic Error response keeps this from hanging.
        let resp = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            conn.request(Request::Status),
        )
        .await
        .expect("request() must not hang after EOF")
        .expect("inflight resolves to a Response, not a channel-drop error");
        server.await.expect("server task");

        match resp {
            Response::Error {
                message,
                recoverable,
            } => {
                assert!(!recoverable, "synthetic close error is not recoverable");
                assert!(
                    message.contains("connection closed"),
                    "expected 'connection closed' in synthetic error, got: {message}"
                );
            }
            other => panic!("expected synthetic Error on EOF, got: {other:?}"),
        }
    }

    /// Step 4: Writer task dies → next `request()` fails. We can't kill the
    /// writer task directly, but closing the *reader* side of the duplex
    /// pair (the side the writer task writes to) makes `write_frame` fail
    /// and the writer task exits via its `break`. After the writer task is
    /// gone the mpsc receiver is dropped, so `conn.request()`'s
    /// `tx_out.send(...)` returns `Err`, which the production code maps to
    /// `HostError::Other("conn closed")`.
    #[tokio::test]
    async fn request_fails_when_writer_task_dies() {
        let (client_r, server_w) = duplex(4096);
        let (server_r, client_w) = duplex(4096);

        let conn = ConnHandle::spawn_tasks(client_r, client_w);

        // Close the server side so writes fail. We have to drop both
        // halves: the writer task writes into `client_w` whose peer is
        // `server_r` — dropping `server_r` makes the next write_all fail.
        // We also drop `server_w` so the reader task sees EOF and won't
        // race with us.
        drop(server_r);
        drop(server_w);

        // Give the writer task a chance to attempt a write and fail. The
        // mpsc channel has capacity 256, so the *first* request just
        // queues; the writer task picks it up, the write_all fails, and
        // the task exits. We loop a few times to be robust against
        // scheduling.
        let mut saw_err = None;
        for _ in 0..32 {
            match tokio::time::timeout(
                std::time::Duration::from_millis(200),
                conn.request(Request::Status),
            )
            .await
            {
                Ok(Ok(_resp)) => {
                    // The reader task may have raced ahead and drained
                    // inflight with a synthetic Error before the writer
                    // task even noticed — that's also valid evidence
                    // that the connection is unusable, but we want to
                    // exercise the `tx_out.send` failure path
                    // specifically, so keep trying until the mpsc is
                    // actually closed.
                    continue;
                }
                Ok(Err(e)) => {
                    saw_err = Some(e);
                    break;
                }
                Err(_) => {
                    panic!("request() hung after writer was supposed to die");
                }
            }
        }

        let err = saw_err.expect("request() must error once the writer task has dropped rx_out");
        let msg = err.to_string();
        assert!(
            msg.contains("conn closed") || msg.contains("connection closed"),
            "expected closed-connection error, got: {msg}"
        );
    }

    /// Step 5: `try_connect` failure variants. Pointing at a path that
    /// definitely doesn't exist must surface as an `io::Error` — typically
    /// `NotFound` on Unix domain sockets (the file isn't there) or
    /// `ConnectionRefused` on Windows named pipes (no server listening).
    #[tokio::test]
    async fn try_connect_fails_on_missing_path() {
        // Build a path that cannot exist: a temp dir we just removed.
        let tmp = tempfile::tempdir().expect("tempdir");
        let socket_path = tmp.path().join("definitely-not-a-socket.sock");
        // Ensure the path doesn't exist by being inside a still-live
        // tempdir but never created.
        assert!(!socket_path.exists());

        let err = try_connect(&socket_path)
            .await
            .expect_err("try_connect should fail for a non-existent socket path");
        let kind = err.kind();
        assert!(
            matches!(
                kind,
                std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused
            ),
            "expected NotFound or ConnectionRefused, got {kind:?}: {err}"
        );
    }
}
