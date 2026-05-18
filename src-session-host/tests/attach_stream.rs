#![cfg(unix)]

//! End-to-end Attach streaming test.
//!
//! Spins up the server, opens a `control` connection that issues
//! `EnsureSession` against `stub-tui`, then opens a second `attach`
//! connection that issues `Attach` for the same sid. We assert:
//!
//! - The attach connection receives a `Response::AttachStarted { attach_id }`
//!   with a monotonic `attach_id > 0`.
//! - We see the stub-tui's startup `READY\n` line on the attach stream.
//! - After sending `"hello\n"` on the control connection, the attach stream
//!   surfaces the stub-tui's `OUT: hello` echo.
//!
//! The split pattern matches `ensure_session.rs`: `Stream::split` consumes
//! the stream, so we keep one `(read_half, write_half)` pair per connection
//! and pass the halves through each helper.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use std::sync::atomic::{AtomicU64, Ordering};

use base64::Engine as _;
use claudette::agent::interactive_protocol::{
    Event, InboundFrame, InputPayload, PROTOCOL_VERSION, Request, RequestEnvelope, Response,
    SessionSpec, frame,
};
use interprocess::local_socket::tokio::{Stream, prelude::*};
use interprocess::local_socket::{GenericFilePath, ToFsName};

/// Monotonic request-id counter shared by `send_req`. Reset implicitly per
/// test process; the multiple connections opened by this test do not need
/// distinct namespaces because each connection-id correlation only flows
/// over one socket at a time.
static NEXT_REQ_ID: AtomicU64 = AtomicU64::new(1);

#[tokio::test]
async fn attach_streams_echoed_output() {
    let stub = find_stub_tui();

    let socket = std::env::temp_dir().join(format!("attach-test-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&socket);
    let server = tokio::spawn({
        let sp = socket.clone();
        async move {
            claudette_session_host::server::run_for_test(&sp)
                .await
                .unwrap()
        }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;

    // Connection 1: control (handshake + EnsureSession + SendInput).
    let ctrl = open_conn(&socket).await;
    let (mut ctrl_r, mut ctrl_w) = ctrl.split();
    handshake(&mut ctrl_r, &mut ctrl_w).await;

    let sid = "claudette-attach-aaaaaaaa".to_string();
    send_req(
        &mut ctrl_w,
        &Request::EnsureSession {
            sid: sid.clone(),
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
    match recv_resp(&mut ctrl_r).await {
        Response::SessionStarted { sid: got_sid, .. } => {
            assert_eq!(got_sid, sid, "echo of sid in SessionStarted")
        }
        other => panic!("expected SessionStarted, got {other:?}"),
    }

    // Connection 2: attach.
    let att = open_conn(&socket).await;
    let (mut att_r, mut att_w) = att.split();
    handshake(&mut att_r, &mut att_w).await;

    send_req(&mut att_w, &Request::Attach { sid: sid.clone() }).await;
    match recv_resp(&mut att_r).await {
        Response::AttachStarted { attach_id } => {
            assert!(attach_id > 0, "attach_id should be monotonic > 0")
        }
        other => panic!("expected AttachStarted, got {other:?}"),
    }

    // Drain stub-tui's `READY\n` first.
    let ready_seen = drain_until_contains(&mut att_r, "READY", Duration::from_secs(2)).await;
    assert!(ready_seen, "did not observe READY on attach stream");

    // Send input on the control connection.
    send_req(
        &mut ctrl_w,
        &Request::SendInput {
            sid: sid.clone(),
            payload: InputPayload::Text {
                text: "hello\n".into(),
            },
        },
    )
    .await;
    let resp = recv_resp(&mut ctrl_r).await;
    assert!(matches!(resp, Response::Ok), "expected Ok, got {resp:?}");

    // Drain attach until we see the echo.
    let seen = drain_until_contains(&mut att_r, "OUT: hello", Duration::from_secs(3)).await;
    assert!(seen, "did not observe echoed line on attach stream");

    server.abort();
    let _ = std::fs::remove_file(&socket);
}

/// Drive the broadcast channel past its 2048-slot capacity with one fast
/// consumer draining and one slow consumer falling behind, then assert the
/// slow consumer's attach stream terminates.
///
/// The session host wires every attach connection to the per-session
/// `broadcast::Sender<SessionEvent>` (capacity 2048 in `Session::spawn`). When
/// a subscriber falls more than 2048 messages behind the writer, `rx.recv()`
/// returns `RecvError::Lagged(n)`. `stream_attach` logs a warn and breaks out
/// of its pump loop — from the client's perspective the attach socket just
/// hits EOF cleanly. We can't assert against `tracing` output portably, so we
/// assert the observable contract instead: the slow attach reaches stream
/// end (EOF on `read_frame`) within a bounded time window.
///
/// The fast consumer is drained in a background task to keep its
/// `stream_attach` write loop unblocked — without it the server would apply
/// socket-write backpressure on the fast attach and we wouldn't have a clean
/// reference subscriber to compare against. The slow consumer reads at a
/// throttled cadence (one frame per `SLOW_DELAY_MS`) so its per-attach task
/// keeps cycling through `rx.recv()` rather than getting stuck on
/// `write_frame` once its OS send buffer fills — without that pacing the
/// `Lagged` arm would never be reached because `recv()` is never called.
#[tokio::test]
async fn attach_lagged_subscriber_stream_ends() {
    let stub = find_stub_tui();

    let socket = std::env::temp_dir().join(format!("attach-lag-test-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&socket);
    let server = tokio::spawn({
        let sp = socket.clone();
        async move {
            claudette_session_host::server::run_for_test(&sp)
                .await
                .unwrap()
        }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;

    // Control connection.
    let ctrl = open_conn(&socket).await;
    let (mut ctrl_r, mut ctrl_w) = ctrl.split();
    handshake(&mut ctrl_r, &mut ctrl_w).await;

    let sid = "claudette-attach-lagged".to_string();
    send_req(
        &mut ctrl_w,
        &Request::EnsureSession {
            sid: sid.clone(),
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
    match recv_resp(&mut ctrl_r).await {
        Response::SessionStarted { sid: got_sid, .. } => assert_eq!(got_sid, sid),
        other => panic!("expected SessionStarted, got {other:?}"),
    }

    // Fast attach: drained continuously by a background task.
    let fast = open_conn(&socket).await;
    let (mut fast_r, mut fast_w) = fast.split();
    handshake(&mut fast_r, &mut fast_w).await;
    send_req(&mut fast_w, &Request::Attach { sid: sid.clone() }).await;
    match recv_resp(&mut fast_r).await {
        Response::AttachStarted { .. } => {}
        other => panic!("expected AttachStarted on fast attach, got {other:?}"),
    }
    // Wait for stub-tui's READY before kicking off the drainer, to make sure
    // the session reader task is wired up before we start blasting input.
    assert!(
        drain_until_contains(&mut fast_r, "READY", Duration::from_secs(2)).await,
        "fast attach never saw READY"
    );

    let fast_drainer = tokio::spawn(async move {
        // Read frames as fast as they arrive; ignore content. Exits when
        // the connection closes (server abort at end of test).
        while frame::read_frame(&mut fast_r).await.is_ok() {}
    });

    // Slow attach: handshake + Attach, then read at a deliberately slow
    // rate. We can't simply never read — the server's per-attach task
    // would block on `write_frame` (TCP send buffer full) and never call
    // `rx.recv()` again, so the `Lagged` arm would be unreachable. By
    // pacing reads slower than production we keep the server task cycling
    // through `recv()` while the producer outpaces it; eventually `recv()`
    // returns `Lagged` and the server logs the warn + closes the stream.
    let slow = open_conn(&socket).await;
    let (mut slow_r, mut slow_w) = slow.split();
    handshake(&mut slow_r, &mut slow_w).await;
    send_req(&mut slow_w, &Request::Attach { sid: sid.clone() }).await;
    match recv_resp(&mut slow_r).await {
        Response::AttachStarted { .. } => {}
        other => panic!("expected AttachStarted on slow attach, got {other:?}"),
    }

    // The slow drainer reads at most one frame every `SLOW_DELAY_MS` ms
    // and returns the first read error it encounters (the lag-induced
    // close). It hands back the count of frames seen so a regression
    // toward "no frames at all" is also visible in the assertion below.
    const SLOW_DELAY_MS: u64 = 25;
    let slow_drainer = tokio::spawn(async move {
        let mut frames_seen: u64 = 0;
        loop {
            tokio::time::sleep(Duration::from_millis(SLOW_DELAY_MS)).await;
            match frame::read_frame(&mut slow_r).await {
                Ok(_) => frames_seen += 1,
                Err(_) => return frames_seen,
            }
        }
    });

    // Push enough output through stub-tui to overflow the 2048-slot
    // broadcast channel. Each iteration sends a small line and awaits its
    // `Ok` reply (so the test client never falls behind on responses and
    // we never block on socket buffers). The PTY reader produces one
    // broadcast event per read; with 4096 line-by-line sends the producer
    // far outpaces the 25 ms-per-frame slow drainer, eventually lapping
    // it past the 2048-slot window.
    const ITERATIONS: usize = 4096;
    for i in 0..ITERATIONS {
        send_req(
            &mut ctrl_w,
            &Request::SendInput {
                sid: sid.clone(),
                payload: InputPayload::Text {
                    text: format!("l{i}\n"),
                },
            },
        )
        .await;
        let resp = recv_resp(&mut ctrl_r).await;
        assert!(
            matches!(resp, Response::Ok),
            "expected Ok for SendInput at iteration {i}, got {resp:?}"
        );
    }

    // The slow drainer should observe its stream close once the broadcast
    // overruns it. Give it a generous timeout — production might continue
    // for a moment after the loop above as PTY echoes drain.
    let frames_seen = tokio::time::timeout(Duration::from_secs(20), slow_drainer)
        .await
        .expect("slow drainer never reported stream end — lagged-broadcast path not exercised")
        .expect("slow drainer task panicked");
    assert!(
        frames_seen > 0,
        "slow drainer never saw any frames before close — fast attach pipeline may be broken"
    );

    fast_drainer.abort();
    server.abort();
    let _ = std::fs::remove_file(&socket);
}

// -- helpers ---------------------------------------------------------------

async fn open_conn(p: &Path) -> Stream {
    let name = p.to_fs_name::<GenericFilePath>().unwrap();
    Stream::connect(name).await.unwrap()
}

async fn handshake<R, W>(r: &mut R, w: &mut W)
where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    send_req(
        w,
        &Request::Hello {
            protocol_version: PROTOCOL_VERSION,
            claudette_version: "t".into(),
        },
    )
    .await;
    match recv_resp(r).await {
        Response::HelloAck { .. } => {}
        other => panic!("expected HelloAck, got {other:?}"),
    }
}

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

/// Pump `Event::Output` frames off `r` for up to `total`, decoding their
/// base64 bodies into a rolling buffer. Returns `true` as soon as the
/// accumulated decoded bytes contain `needle`. Non-output events (Hook,
/// Exit, StreamError) are ignored — the test only cares about stdout echo.
///
/// Events arrive wrapped in `InboundFrame::Event(...)` post-envelope cutover.
async fn drain_until_contains<R>(r: &mut R, needle: &str, total: Duration) -> bool
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut buf = Vec::<u8>::new();
    let deadline = tokio::time::Instant::now() + total;
    while tokio::time::Instant::now() < deadline {
        let frame_res =
            tokio::time::timeout(Duration::from_millis(200), frame::read_frame(r)).await;
        let Ok(Ok(bytes)) = frame_res else { continue };
        let inbound: InboundFrame = match serde_json::from_slice(&bytes) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let ev = match inbound {
            InboundFrame::Event(ev) => ev,
            // Stray Responses on an attach stream are unexpected but not
            // fatal for this helper — just skip them.
            InboundFrame::Response { .. } => continue,
        };
        if let Event::Output { bytes_b64, .. } = ev {
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(bytes_b64)
                .unwrap_or_default();
            buf.extend_from_slice(&decoded);
            if String::from_utf8_lossy(&buf).contains(needle) {
                return true;
            }
        }
    }
    String::from_utf8_lossy(&buf).contains(needle)
}

/// Locate the workspace `stub-tui` binary, building it if necessary. Same
/// strategy as `ensure_session.rs` — see the module doc there for why we
/// can't use `CARGO_BIN_EXE_*`.
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
