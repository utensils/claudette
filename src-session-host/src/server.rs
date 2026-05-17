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
//! Anything past the handshake is the responsibility of later tasks
//! (C3 — session ops, C4 — event streaming, etc.).

use std::path::{Path, PathBuf};

use claudette::agent::interactive_protocol::{
    PROTOCOL_VERSION, Request, Response,
    frame::{read_frame, write_frame},
};
use interprocess::local_socket::tokio::{Listener, Stream, prelude::*};
#[cfg(unix)]
use interprocess::local_socket::{GenericFilePath, ToFsName};
#[cfg(windows)]
use interprocess::local_socket::{GenericNamespaced, ToNsName};
use interprocess::local_socket::{ListenerOptions, Name};

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

/// Bind the listener at `socket_path` and serve connections until the task is
/// cancelled. Used by `main.rs` in production.
pub async fn run_at(socket_path: &Path) -> std::io::Result<()> {
    let name = socket_name(socket_path)?;
    let listener = ListenerOptions::new().name(name).create_tokio()?;
    serve(listener).await
}

/// Test entry point — same behavior as `run_at`, named distinctly so
/// integration tests can call it without pretending to be `main`.
pub async fn run_for_test(socket_path: &Path) -> std::io::Result<()> {
    run_at(socket_path).await
}

async fn serve(listener: Listener) -> std::io::Result<()> {
    loop {
        let stream = match listener.accept().await {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!(?e, "accept failed");
                continue;
            }
        };
        tokio::spawn(async move {
            if let Err(e) = handle_connection(stream).await {
                tracing::warn!(?e, "connection ended with error");
            }
        });
    }
}

async fn handle_connection(stream: Stream) -> std::io::Result<()> {
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
        write_frame(&mut w, &serde_json::to_vec(&bad).unwrap()).await?;
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
    write_frame(&mut w, &serde_json::to_vec(&resp).unwrap()).await?;
    Ok(())
}
