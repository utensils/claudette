#![cfg(unix)]

//! End-to-end EnsureSession + Status test.
//!
//! Spawns the server pointed at a unique temp socket, performs the Hello
//! handshake, then issues `EnsureSession` with `stub-tui` as the executable
//! and asserts the server replied `SessionStarted`. A follow-up `Status`
//! request must include the new session as running.
//!
//! ## Locating the stub binary
//!
//! Artifact deps (`stub-tui = { ..., artifact = "bin:stub-tui" }`) would let
//! us read `env!("CARGO_BIN_EXE_stub-tui")`, but they still require
//! `-Z bindeps` on stable Rust 1.94. Instead we use `cargo metadata` to find
//! the workspace `target_directory` at test time and look up the stub binary
//! there. `cargo test -p claudette-session-host` always builds workspace
//! members it depends on transitively only — `stub-tui` is a peer crate, so
//! `find_stub_tui` calls `cargo build -p stub-tui` once before reading the
//! path. That keeps the test runnable from a clean target dir without
//! pulling stub-tui into our normal compile.

use std::path::{Path, PathBuf};
use std::process::Command;

use claudette::agent::interactive_protocol::{
    InboundFrame, PROTOCOL_VERSION, Request, RequestEnvelope, Response, SessionSpec, frame,
};
use interprocess::local_socket::tokio::{Stream, prelude::*};
use interprocess::local_socket::{GenericFilePath, ToFsName};
use std::sync::atomic::{AtomicU64, Ordering};

/// Monotonic request-id counter shared by `send_req`. Reset implicitly per
/// test process; tests do not run in parallel against the same socket so a
/// process-wide counter is fine.
static NEXT_REQ_ID: AtomicU64 = AtomicU64::new(1);

#[tokio::test]
async fn ensure_session_starts_and_status_lists_it() {
    let stub = find_stub_tui();

    let socket = std::env::temp_dir().join(format!("ess-test-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&socket);
    let server = tokio::spawn({
        let sp = socket.clone();
        async move {
            claudette_session_host::server::run_for_test(&sp)
                .await
                .unwrap()
        }
    });
    // Give the listener time to bind.
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    // `Stream::split` consumes the stream, so we split once and pass the
    // halves through every helper rather than re-splitting per-call.
    let conn = open_conn(&socket).await;
    let (mut r, mut w) = conn.split();

    send_req(
        &mut w,
        &Request::Hello {
            protocol_version: PROTOCOL_VERSION,
            claudette_version: "t".into(),
        },
    )
    .await;
    expect_helloack(&mut r).await;

    send_req(
        &mut w,
        &Request::EnsureSession {
            sid: "claudette-test-aaaaaaaa".into(),
            spec: SessionSpec {
                working_dir: std::env::temp_dir().to_string_lossy().into(),
                rows: 24,
                cols: 80,
                claude_binary: stub.to_string_lossy().into(),
                claude_args: vec![],
                env: vec![],
                claude_config_dir: std::env::temp_dir().to_string_lossy().into(),
            },
        },
    )
    .await;
    let resp = recv_resp(&mut r).await;
    match resp {
        Response::SessionStarted { sid, .. } => {
            assert_eq!(
                sid, "claudette-test-aaaaaaaa",
                "echo of sid in SessionStarted"
            )
        }
        other => panic!("expected SessionStarted, got {other:?}"),
    }

    send_req(&mut w, &Request::Status).await;
    let st = recv_resp(&mut r).await;
    match st {
        Response::Status { sessions, .. } => {
            assert!(
                sessions
                    .iter()
                    .any(|s| s.sid == "claudette-test-aaaaaaaa" && s.running),
                "Status should list the new session as running, got {sessions:?}"
            );
        }
        other => panic!("expected Status, got {other:?}"),
    }

    // Idempotency: a second EnsureSession with the same sid + spec must
    // return SessionStarted echoing the same sid. This exercises the
    // early-return path in the dispatch handler that previously held the
    // SessionMap lock across an inner-session lock acquisition.
    send_req(
        &mut w,
        &Request::EnsureSession {
            sid: "claudette-test-aaaaaaaa".into(),
            spec: SessionSpec {
                working_dir: std::env::temp_dir().to_string_lossy().into(),
                rows: 24,
                cols: 80,
                claude_binary: stub.to_string_lossy().into(),
                claude_args: vec![],
                env: vec![],
                claude_config_dir: std::env::temp_dir().to_string_lossy().into(),
            },
        },
    )
    .await;
    let resp2 = recv_resp(&mut r).await;
    match resp2 {
        Response::SessionStarted { sid, .. } => {
            assert_eq!(
                sid, "claudette-test-aaaaaaaa",
                "second EnsureSession should be idempotent and echo the same sid"
            );
        }
        other => panic!("expected SessionStarted on idempotent EnsureSession, got {other:?}"),
    }

    server.abort();
    let _ = std::fs::remove_file(&socket);
}

// -- helpers ---------------------------------------------------------------

async fn open_conn(path: &Path) -> Stream {
    let name = path.to_fs_name::<GenericFilePath>().unwrap();
    Stream::connect(name).await.unwrap()
}

/// Send a `Request` wrapped in a `RequestEnvelope` with a fresh `request_id`.
///
/// The Hello path needs `request_id == 0`, so we treat that as a special case:
/// `Request::Hello` always goes out as `request_id = 0`. All other requests
/// allocate a monotonic id from `NEXT_REQ_ID`.
async fn send_req<W>(w: &mut W, req: &Request)
where
    W: tokio::io::AsyncWrite + Unpin,
{
    let request_id = if matches!(req, Request::Hello { .. }) {
        0
    } else {
        NEXT_REQ_ID.fetch_add(1, Ordering::SeqCst)
    };
    let env = RequestEnvelope {
        request_id,
        request: req.clone(),
    };
    let bytes = serde_json::to_vec(&env).unwrap();
    frame::write_frame(w, &bytes).await.unwrap();
}

/// Read an `InboundFrame::Response` off the wire and unwrap to the inner
/// `Response`. Panics if an `Event` arrives — these tests only run on the
/// request/response control connection (no `Attach`).
async fn recv_resp<R>(r: &mut R) -> Response
where
    R: tokio::io::AsyncRead + Unpin,
{
    let buf = frame::read_frame(r).await.unwrap();
    let inbound: InboundFrame = serde_json::from_slice(&buf).unwrap();
    match inbound {
        InboundFrame::Response { response, .. } => response,
        InboundFrame::Event(ev) => panic!("expected Response, got Event: {ev:?}"),
    }
}

async fn expect_helloack<R>(r: &mut R)
where
    R: tokio::io::AsyncRead + Unpin,
{
    match recv_resp(r).await {
        Response::HelloAck { .. } => {}
        other => panic!("expected HelloAck, got {other:?}"),
    }
}

/// Locate the workspace `stub-tui` binary, building it if necessary.
///
/// `cargo metadata` reports the workspace `target_directory`; the unsuffixed
/// binary lives directly in `<target>/debug/`. We always `cargo build -p
/// stub-tui` first so the path exists when invoked from a clean target dir.
fn find_stub_tui() -> PathBuf {
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
    let status = Command::new(&cargo)
        .args(["build", "-p", "stub-tui"])
        .status()
        .expect("failed to invoke cargo to build stub-tui");
    assert!(status.success(), "cargo build -p stub-tui failed");

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
    let bin = PathBuf::from(target_dir).join("debug").join("stub-tui");
    assert!(bin.exists(), "stub-tui binary missing at {bin:?}");
    bin
}
