//! Conformance suite both InteractiveHost impls must pass.
//!
//! Tests build a host, point it at a stub TUI, and exercise the full lifecycle.
//! Both impls share the same expectations.

use super::{
    AttachEvent, HostStatus, InputPayload, InteractiveHost, ScreenSnapshot, SessionId, SessionSpec,
    StopMode,
};
use futures::StreamExt;
use std::time::Duration;
use tokio::time::timeout;

pub struct ConformanceFixture {
    pub spec: SessionSpec,
    pub sid: SessionId,
}

/// Run the full conformance suite against `host`.
pub async fn run<H: InteractiveHost>(host: &H, fx: &ConformanceFixture) {
    ensure_session_is_idempotent(host, fx).await;
    send_then_capture_returns_bytes(host, fx).await;
    multiple_attaches_each_receive_events(host, fx).await;
    detach_does_not_kill_session(host, fx).await;
    stop_graceful_yields_exit_event(host, fx).await;
    status_lists_only_running_sessions(host, fx).await;
}

async fn ensure_session_is_idempotent<H: InteractiveHost>(host: &H, fx: &ConformanceFixture) {
    let h1 = host
        .ensure_session(&fx.sid, &fx.spec)
        .await
        .expect("ensure 1");
    let h2 = host
        .ensure_session(&fx.sid, &fx.spec)
        .await
        .expect("ensure 2");
    assert_eq!(h1.sid, h2.sid);
}

async fn send_then_capture_returns_bytes<H: InteractiveHost>(host: &H, fx: &ConformanceFixture) {
    let _ = host.ensure_session(&fx.sid, &fx.spec).await.unwrap();
    let (_attach_id, mut stream) = host.attach(&fx.sid).await.unwrap();
    host.send_input(
        &fx.sid,
        InputPayload::Text {
            text: "hello\n".into(),
        },
    )
    .await
    .unwrap();
    let mut got = Vec::<u8>::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    while tokio::time::Instant::now() < deadline {
        match timeout(Duration::from_millis(200), stream.next()).await {
            Ok(Some(AttachEvent::Output { bytes, .. })) => got.extend_from_slice(&bytes),
            Ok(Some(_)) => {}
            Ok(None) => break,
            Err(_) => {}
        }
        if String::from_utf8_lossy(&got).contains("OUT: hello") {
            break;
        }
    }
    assert!(
        String::from_utf8_lossy(&got).contains("OUT: hello"),
        "did not see echoed line in stream: {:?}",
        String::from_utf8_lossy(&got)
    );
    let snap: ScreenSnapshot = host.capture_screen(&fx.sid).await.unwrap();
    assert!(snap.rows >= 1 && snap.cols >= 1);
}

async fn multiple_attaches_each_receive_events<H: InteractiveHost>(
    host: &H,
    fx: &ConformanceFixture,
) {
    let _ = host.ensure_session(&fx.sid, &fx.spec).await.unwrap();
    let (_a1, mut s1) = host.attach(&fx.sid).await.unwrap();
    let (_a2, mut s2) = host.attach(&fx.sid).await.unwrap();
    host.send_input(
        &fx.sid,
        InputPayload::Text {
            text: "ping\n".into(),
        },
    )
    .await
    .unwrap();
    let s1_seen = drain_until_contains(&mut s1, "OUT: ping", Duration::from_secs(3)).await;
    let s2_seen = drain_until_contains(&mut s2, "OUT: ping", Duration::from_secs(3)).await;
    assert!(s1_seen, "first attach missed ping");
    assert!(s2_seen, "second attach missed ping");
}

async fn detach_does_not_kill_session<H: InteractiveHost>(host: &H, fx: &ConformanceFixture) {
    let _ = host.ensure_session(&fx.sid, &fx.spec).await.unwrap();
    let (attach_id, _stream) = host.attach(&fx.sid).await.unwrap();
    host.detach(&fx.sid, attach_id).await.unwrap();
    // Session must still be enumerable as running.
    let st = host.status().await.unwrap();
    assert!(
        st.sessions.iter().any(|s| s.sid == fx.sid && s.running),
        "session vanished after detach"
    );
}

async fn stop_graceful_yields_exit_event<H: InteractiveHost>(host: &H, fx: &ConformanceFixture) {
    let _ = host.ensure_session(&fx.sid, &fx.spec).await.unwrap();
    let (_attach_id, mut stream) = host.attach(&fx.sid).await.unwrap();
    host.stop(&fx.sid, StopMode::Graceful).await.unwrap();
    let mut got_exit = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while tokio::time::Instant::now() < deadline {
        match timeout(Duration::from_millis(200), stream.next()).await {
            Ok(Some(AttachEvent::Exit { .. })) => {
                got_exit = true;
                break;
            }
            Ok(Some(_)) => {}
            Ok(None) => break,
            Err(_) => {}
        }
    }
    assert!(got_exit, "no exit event after stop");
}

async fn status_lists_only_running_sessions<H: InteractiveHost>(
    host: &H,
    _fx: &ConformanceFixture,
) {
    let st: HostStatus = host.status().await.unwrap();
    // After stop in the previous test, our session should be gone.
    assert!(
        !st.sessions
            .iter()
            .any(|s| s.running && s.sid.as_str().contains("claudette-"))
    );
}

async fn drain_until_contains<S>(stream: &mut S, needle: &str, total: Duration) -> bool
where
    S: futures::Stream<Item = AttachEvent> + Unpin,
{
    use futures::StreamExt;
    let mut buf = Vec::<u8>::new();
    let deadline = tokio::time::Instant::now() + total;
    while tokio::time::Instant::now() < deadline {
        match timeout(Duration::from_millis(200), stream.next()).await {
            Ok(Some(AttachEvent::Output { bytes, .. })) => buf.extend_from_slice(&bytes),
            Ok(Some(_)) => {}
            Ok(None) => return String::from_utf8_lossy(&buf).contains(needle),
            Err(_) => {}
        }
        if String::from_utf8_lossy(&buf).contains(needle) {
            return true;
        }
    }
    String::from_utf8_lossy(&buf).contains(needle)
}
