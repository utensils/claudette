//! Local-socket server for the session host.
//!
//! Listens on a per-user path:
//!   Unix:    `$TMPDIR/claudette-session-host/<user>.sock`
//!   Windows: `\\.\pipe\claudette-session-host-<user>`
//!
//! Each accepted connection runs in its own task. The first frame must be a
//! `Request::Hello`; the server replies with either `Response::HelloAck` or
//! `Response::HelloNack` depending on protocol_version compatibility.
//!
//! After the handshake the connection enters a request/response loop. Task C3
//! wired `EnsureSession`, `Status`, `SendInput`, and `Stop`; C4 adds `Resize`,
//! `CaptureScreen`, `Detach`, and the streaming `Attach` handler.
//!
//! `Attach` does not flow through the regular request/response loop: after
//! ack-ing with `Response::AttachStarted { attach_id }` the connection
//! becomes an event stream of `Event::Output` / `Event::Hook` / `Event::Exit`
//! frames until the client closes the socket or the session exits. Per the
//! plan's "simpler v1 model", a client detaches by closing the connection;
//! the explicit `Detach` request is accepted (returns `Response::Ok`) for
//! symmetry but is otherwise a no-op.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::Ordering;

use base64::Engine as _;
use claudette::agent::interactive_protocol::{
    Event, PROTOCOL_VERSION, Request, Response, StopMode,
    frame::{read_frame, write_frame},
};
use interprocess::local_socket::tokio::{Listener, Stream, prelude::*};
#[cfg(unix)]
use interprocess::local_socket::{GenericFilePath, ToFsName};
#[cfg(windows)]
use interprocess::local_socket::{GenericNamespaced, ToNsName};
use interprocess::local_socket::{ListenerOptions, Name};
use tokio::sync::Mutex;

use crate::SessionSummary;
use crate::idle::Idle;
use crate::session::{Session, SessionEvent};

/// RAII guard that decrements an `Idle`'s client counter on drop. The
/// server wraps each connection task with one so a panic or early `?`
/// return still re-arms the idle waiter — manual `client_disconnected`
/// calls would race against any `await` returning early.
struct ClientGuard {
    idle: Idle,
}

impl Drop for ClientGuard {
    fn drop(&mut self) {
        self.idle.client_disconnected();
    }
}

/// Shared map of active sessions keyed by `sid`. Held by the server task and
/// cloned into each accepted connection so all connections see the same set
/// of live sessions.
pub type SessionMap = Arc<Mutex<HashMap<String, Arc<Session>>>>;

/// Build a fresh, empty `SessionMap`.
pub fn new_session_map() -> SessionMap {
    Arc::new(Mutex::new(HashMap::new()))
}

/// Returns the default per-user socket path for the session host.
///
/// On Unix this is `$TMPDIR/claudette-session-host/<user>.sock`
/// (`/tmp/claudette-session-host/<user>.sock` if `$TMPDIR` is unset). The
/// containing directory is created if missing — failures are ignored so the
/// caller still tries to bind and produces a meaningful error.
///
/// On Windows this is `\\.\pipe\claudette-session-host-<user>`.
pub fn default_socket_path() -> PathBuf {
    let user = whoami::username();
    #[cfg(unix)]
    {
        let base = std::env::var("TMPDIR").unwrap_or_else(|_| "/tmp".into());
        let dir = PathBuf::from(base).join("claudette-session-host");
        let _ = std::fs::create_dir_all(&dir);
        dir.join(format!("{user}.sock"))
    }
    #[cfg(windows)]
    {
        PathBuf::from(format!(r"\\.\pipe\claudette-session-host-{user}"))
    }
}

/// Convert a filesystem path / pipe path into an `interprocess` `Name`,
/// choosing the right namespace per platform.
fn socket_name(path: &Path) -> std::io::Result<Name<'_>> {
    #[cfg(unix)]
    {
        path.to_fs_name::<GenericFilePath>()
    }
    #[cfg(windows)]
    {
        // On Windows the "path" is really `\\.\pipe\<name>`; only the trailing
        // segment is the namespace key.
        let raw = path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| std::io::Error::other("invalid pipe path"))?;
        raw.to_ns_name::<GenericNamespaced>()
    }
}

/// Bind the listener at `socket_path` with the given session map and serve
/// connections until the task is cancelled. Useful when an outer harness
/// wants to inspect / share session state with the server.
pub async fn run_at_with(map: SessionMap, socket_path: &Path) -> std::io::Result<()> {
    let name = socket_name(socket_path)?;
    let listener = ListenerOptions::new().name(name).create_tokio()?;
    serve(listener, map, None).await
}

/// Same as `run_at_with`, but also tracks client connection lifetimes against
/// the supplied `Idle` so a sibling `wait_for_idle_exit` future can decide
/// when to shut the sidecar down.
pub async fn run_at_with_idle(
    map: SessionMap,
    socket_path: &Path,
    idle: Idle,
) -> std::io::Result<()> {
    let name = socket_name(socket_path)?;
    let listener = ListenerOptions::new().name(name).create_tokio()?;
    serve(listener, map, Some(idle)).await
}

/// Bind the listener at `socket_path` with a fresh session map. Used by
/// `main.rs` in production.
pub async fn run_at(socket_path: &Path) -> std::io::Result<()> {
    run_at_with(new_session_map(), socket_path).await
}

/// Test entry point — same behavior as `run_at`, named distinctly so
/// integration tests can call it without pretending to be `main`.
pub async fn run_for_test(socket_path: &Path) -> std::io::Result<()> {
    run_at_with(new_session_map(), socket_path).await
}

async fn serve(listener: Listener, map: SessionMap, idle: Option<Idle>) -> std::io::Result<()> {
    loop {
        let stream = match listener.accept().await {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!(?e, "accept failed");
                continue;
            }
        };
        let m = map.clone();
        let idle_for_task = idle.clone();
        tokio::spawn(async move {
            // Drop-guard pattern: bump the client count before handling the
            // connection and rely on `ClientGuard`'s `Drop` impl to
            // decrement it on any exit path (return, `?`, panic). This is
            // strictly cleaner than explicit `client_disconnected()` calls
            // because `handle_connection` returns early on bad frames.
            let _client_guard = idle_for_task.map(|i| {
                i.client_connected();
                ClientGuard { idle: i }
            });
            if let Err(e) = handle_connection(stream, m).await {
                tracing::warn!(?e, "connection ended with error");
            }
        });
    }
}

async fn handle_connection(stream: Stream, map: SessionMap) -> std::io::Result<()> {
    let (mut r, mut w) = stream.split();
    // First frame must be Hello.
    let first = read_frame(&mut r).await?;
    let req: Request = serde_json::from_slice(&first).map_err(std::io::Error::other)?;
    let Request::Hello {
        protocol_version, ..
    } = req
    else {
        let bad = Response::Error {
            message: "first frame was not Hello".into(),
            recoverable: false,
        };
        write_frame(
            &mut w,
            &serde_json::to_vec(&bad).map_err(std::io::Error::other)?,
        )
        .await?;
        return Ok(());
    };
    let resp = if protocol_version == PROTOCOL_VERSION {
        Response::HelloAck {
            protocol_version: PROTOCOL_VERSION,
            host_version: env!("CARGO_PKG_VERSION").to_string(),
            pid: std::process::id(),
        }
    } else {
        Response::HelloNack {
            reason: format!("unsupported protocol_version {protocol_version}"),
            supported_versions: vec![PROTOCOL_VERSION],
        }
    };
    write_frame(
        &mut w,
        &serde_json::to_vec(&resp).map_err(std::io::Error::other)?,
    )
    .await?;

    // If the protocol version didn't match, we already sent HelloNack — close
    // the connection rather than entering the request loop.
    if protocol_version != PROTOCOL_VERSION {
        return Ok(());
    }

    // Post-handshake dispatch loop. Most requests are one Request + one
    // Response; `Attach` is special — it ack-s with `AttachStarted` and then
    // streams session events on the same connection until the session exits
    // or the client closes the socket. `attach_id_counter` is bumped each
    // time so clients can correlate later `Detach` requests if needed (v1
    // detaches just close the socket).
    let mut attach_id_counter: u64 = 0;
    loop {
        let frame_bytes = match read_frame(&mut r).await {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(()),
            Err(e) => return Err(e),
        };
        let req: Request = match serde_json::from_slice(&frame_bytes) {
            Ok(v) => v,
            Err(e) => {
                let r = Response::Error {
                    message: format!("bad request: {e}"),
                    recoverable: false,
                };
                write_frame(
                    &mut w,
                    &serde_json::to_vec(&r).map_err(std::io::Error::other)?,
                )
                .await?;
                continue;
            }
        };
        match req {
            Request::Attach { sid } => {
                let session: Option<Arc<Session>> = {
                    let m = map.lock().await;
                    m.get(&sid).cloned()
                };
                let Some(s) = session else {
                    let r = Response::Error {
                        message: format!("not found: {sid}"),
                        recoverable: true,
                    };
                    write_frame(
                        &mut w,
                        &serde_json::to_vec(&r).map_err(std::io::Error::other)?,
                    )
                    .await?;
                    continue;
                };
                attach_id_counter += 1;
                let attach_id = attach_id_counter;
                let ack = Response::AttachStarted { attach_id };
                write_frame(
                    &mut w,
                    &serde_json::to_vec(&ack).map_err(std::io::Error::other)?,
                )
                .await?;
                // Stream events on this connection until the session exits or
                // the client disconnects. After streaming ends we return — the
                // connection is no longer in a dispatch state because we may
                // have written `Event` frames where the client expects
                // `Response` frames; the cleanest contract is to close.
                stream_attach(&mut w, s, sid).await?;
                return Ok(());
            }
            other => {
                let resp = dispatch(&map, other).await;
                write_frame(
                    &mut w,
                    &serde_json::to_vec(&resp).map_err(std::io::Error::other)?,
                )
                .await?;
            }
        }
    }
}

/// Pump session events onto an attached client connection until the session
/// exits or the write side errors (i.e. the client disconnected).
///
/// On broadcast `Lagged` we log a warn and close the stream — clients are
/// expected to re-sync via `CaptureScreen` after re-attaching. Per the plan
/// this is acceptable for v1. `Closed` ends the stream silently.
async fn stream_attach<W>(w: &mut W, sess: Arc<Session>, sid: String) -> std::io::Result<()>
where
    W: tokio::io::AsyncWrite + Unpin,
{
    let mut rx = sess.tx.subscribe();
    loop {
        match rx.recv().await {
            Ok(ev) => {
                let (event, is_exit) = match ev {
                    SessionEvent::Output { bytes, seq } => (
                        Event::Output {
                            sid: sid.clone(),
                            bytes_b64: base64::engine::general_purpose::STANDARD.encode(&bytes),
                            seq,
                        },
                        false,
                    ),
                    SessionEvent::Hook(h) => (
                        Event::Hook {
                            sid: sid.clone(),
                            hook: h,
                        },
                        false,
                    ),
                    SessionEvent::Exit {
                        exit_status,
                        reason,
                    } => (
                        Event::Exit {
                            sid: sid.clone(),
                            exit_status,
                            reason,
                        },
                        true,
                    ),
                };
                let bytes = serde_json::to_vec(&event).map_err(std::io::Error::other)?;
                write_frame(w, &bytes).await?;
                if is_exit {
                    break;
                }
            }
            Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                tracing::warn!(
                    sid = %sid,
                    skipped = n,
                    "attach subscriber lagged; closing stream",
                );
                break;
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
        }
    }
    Ok(())
}

async fn dispatch(map: &SessionMap, req: Request) -> Response {
    match req {
        Request::Hello { .. } => Response::Error {
            message: "Hello received after handshake".into(),
            recoverable: true,
        },
        Request::EnsureSession { sid, spec } => {
            // Grab the existing session (if any) under the map lock, then drop
            // the map guard before awaiting any inner-session locks. Holding
            // the coarse map lock across a finer-grained `s.rows.lock().await`
            // would risk deadlock with any future path that takes those locks
            // in the inverse order.
            let existing: Option<Arc<Session>> = {
                let m = map.lock().await;
                m.get(&sid).cloned()
            };
            if let Some(s) = existing {
                let rows = *s.rows.lock().await;
                let cols = *s.cols.lock().await;
                return Response::SessionStarted {
                    sid: s.sid.clone(),
                    pid: s.pid.unwrap_or(0),
                    rows,
                    cols,
                };
            }
            match Session::spawn(sid.clone(), spec).await {
                Ok(s) => {
                    let pid = s.pid.unwrap_or(0);
                    let rows = *s.rows.lock().await;
                    let cols = *s.cols.lock().await;
                    {
                        let mut m = map.lock().await;
                        m.insert(sid.clone(), s);
                    }
                    Response::SessionStarted {
                        sid,
                        pid,
                        rows,
                        cols,
                    }
                }
                Err(e) => Response::Error {
                    message: e.to_string(),
                    recoverable: false,
                },
            }
        }
        Request::Status => {
            let m = map.lock().await;
            let mut sessions: Vec<SessionSummary> = Vec::with_capacity(m.len());
            for s in m.values() {
                sessions.push(SessionSummary {
                    sid: s.sid.clone(),
                    pid: s.pid,
                    running: s.running.load(Ordering::SeqCst),
                });
            }
            Response::Status {
                host_version: env!("CARGO_PKG_VERSION").into(),
                sessions,
            }
        }
        Request::SendInput { sid, payload } => {
            let m = map.lock().await;
            let Some(s) = m.get(&sid).cloned() else {
                return Response::Error {
                    message: format!("not found: {sid}"),
                    recoverable: true,
                };
            };
            drop(m);
            match s.send_input(payload).await {
                Ok(()) => Response::Ok,
                Err(e) => Response::Error {
                    message: e.to_string(),
                    recoverable: true,
                },
            }
        }
        Request::Stop { sid, mode } => {
            let removed = {
                let mut m = map.lock().await;
                m.remove(&sid)
            };
            let Some(s) = removed else {
                return Response::Error {
                    message: format!("not found: {sid}"),
                    recoverable: true,
                };
            };
            match mode {
                StopMode::Graceful => s.stop_graceful().await,
                StopMode::Force => {
                    // Master drop kills the child below.
                }
            }
            // Dropping the last Arc lets the PtyPair drop and reap the child.
            drop(s);
            // `exit_status: -1` is a sentinel meaning "not waited" — the
            // session-host does NOT block `Stop` on the child being reaped.
            // The actual exit status will arrive on the attach stream as
            // `SessionEvent::Exit` (see C4 for the streamed Exit event).
            Response::Stopped { exit_status: -1 }
        }
        Request::Resize { sid, rows, cols } => {
            let session: Option<Arc<Session>> = {
                let m = map.lock().await;
                m.get(&sid).cloned()
            };
            let Some(s) = session else {
                return Response::Error {
                    message: format!("not found: {sid}"),
                    recoverable: true,
                };
            };
            match s.resize(rows, cols).await {
                Ok(()) => Response::Ok,
                Err(e) => Response::Error {
                    message: e.to_string(),
                    recoverable: true,
                },
            }
        }
        Request::CaptureScreen { sid } => {
            let session: Option<Arc<Session>> = {
                let m = map.lock().await;
                m.get(&sid).cloned()
            };
            let Some(s) = session else {
                return Response::Error {
                    message: format!("not found: {sid}"),
                    recoverable: true,
                };
            };
            let bytes = s.capture_screen().await;
            // Two-step read: a concurrent Resize could split between rows/cols.
            // Acceptable for v1 — dimensions are display hints, not load-bearing.
            let rows = *s.rows.lock().await;
            let cols = *s.cols.lock().await;
            Response::ScreenSnapshot {
                rows,
                cols,
                ansi_bytes_b64: base64::engine::general_purpose::STANDARD.encode(&bytes),
            }
        }
        // Per the simplified v1 model the canonical way to detach is to
        // close the connection — `stream_attach` exits on the resulting
        // write error / EOF. We accept the explicit Detach request for
        // symmetry and treat it as a no-op `Ok`. (Note: Detach can never
        // actually reach this branch on the attaching connection, which is
        // in streaming mode and not reading frames. It can arrive on a
        // sibling control connection that knows the `(sid, attach_id)` but
        // has no per-attach receiver to drop, so "no-op" is the honest
        // behavior.)
        Request::Detach { .. } => Response::Ok,
        // Attach is handled directly in `handle_connection` because it
        // switches the connection into streaming mode after the ack frame.
        Request::Attach { .. } => Response::Error {
            message: "Attach must be handled by handle_connection".into(),
            recoverable: false,
        },
    }
}
