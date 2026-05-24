#![cfg(unix)]

//! Idle-exit timer test for the session host.
//!
//! Constructs an `Idle` tracker with a short (200 ms) timeout, an empty
//! `SessionMap`, and zero clients, then asserts `wait_for_idle_exit` returns
//! within the expected window. This pins the C5 acceptance contract: when no
//! clients are connected AND no sessions are alive continuously for
//! `idle.timeout`, the sidecar can exit.

#[tokio::test]
async fn idle_exit_when_no_sessions_and_no_clients() {
    let map = claudette_session_host::server::new_session_map();
    let idle = claudette_session_host::idle::Idle::new(std::time::Duration::from_millis(200));
    idle.notify_client_count(0);
    let started = std::time::Instant::now();
    claudette_session_host::idle::wait_for_idle_exit(map.clone(), idle.clone()).await;
    let elapsed = started.elapsed();
    assert!(
        elapsed >= std::time::Duration::from_millis(180),
        "expected idle wait to last at least ~timeout (200ms); elapsed={elapsed:?}"
    );
    assert!(
        elapsed < std::time::Duration::from_millis(1_000),
        "expected idle wait to return promptly after timeout; elapsed={elapsed:?}"
    );
}
