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
//! wires `EnsureSession`, `Status`, `SendInput`, and `Stop`; `Resize`,
//! `Detach`, `CaptureScreen`, and `Attach` land in C4 (they currently return
//! `Response::Error { "not yet implemented" }`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::Ordering;

use claudette::agent::interactive_protocol::{
    PROTOCOL_VERSION, Request, Response, StopMode,
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
use crate::session::Session;

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
    serve(listener, map).await
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

async fn serve(listener: Listener, map: SessionMap) -> std::io::Result<()> {
    loop {
        let stream = match listener.accept().await {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!(?e, "accept failed");
                continue;
            }
        };
        let m = map.clone();
        tokio::spawn(async move {
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

    // Post-handshake dispatch loop. Each frame is one Request + one Response.
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
        let resp = dispatch(&map, req).await;
        write_frame(
            &mut w,
            &serde_json::to_vec(&resp).map_err(std::io::Error::other)?,
        )
        .await?;
    }
}

async fn dispatch(map: &SessionMap, req: Request) -> Response {
    match req {
        Request::Hello { .. } => Response::Error {
            message: "Hello received after handshake".into(),
            recoverable: true,
        },
        Request::EnsureSession { sid, spec } => {
            let mut m = map.lock().await;
            if let Some(s) = m.get(&sid) {
                return Response::SessionStarted {
                    sid: s.sid.clone(),
                    pid: s.pid.unwrap_or(0),
                    rows: *s.rows.lock().await,
                    cols: *s.cols.lock().await,
                };
            }
            match Session::spawn(sid.clone(), spec).await {
                Ok(s) => {
                    let pid = s.pid.unwrap_or(0);
                    let rows = *s.rows.lock().await;
                    let cols = *s.cols.lock().await;
                    m.insert(sid.clone(), s);
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
            let mut m = map.lock().await;
            let Some(s) = m.remove(&sid) else {
                return Response::Error {
                    message: format!("not found: {sid}"),
                    recoverable: true,
                };
            };
            drop(m);
            match mode {
                StopMode::Graceful => s.stop_graceful().await,
                StopMode::Force => {
                    // Master drop kills the child below.
                }
            }
            // Dropping the last Arc lets the PtyPair drop and reap the child.
            drop(s);
            Response::Stopped { exit_status: 0 }
        }
        // Resize / Detach / CaptureScreen / Attach come in later tasks.
        Request::Resize { .. }
        | Request::Detach { .. }
        | Request::CaptureScreen { .. }
        | Request::Attach { .. } => Response::Error {
            message: "not yet implemented".into(),
            recoverable: false,
        },
    }
}
