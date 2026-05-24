//! Idle-shutdown timer for the session host.
//!
//! The sidecar should not linger forever once nothing useful is happening.
//! `Idle` tracks two pieces of state cooperatively with the server:
//!
//! 1. A client-connection counter. The server increments / decrements it
//!    around each connection-handling task (via `client_connected` /
//!    `client_disconnected`, or a drop-guard wrapper).
//! 2. Whatever is in the shared `SessionMap`. The session count is read
//!    directly from the map by `wait_for_idle_exit` — we don't mirror it
//!    into atomics because the map is already authoritative.
//!
//! `wait_for_idle_exit` returns once `clients == 0 && session_count == 0`
//! has held continuously for `timeout`. Any change to the client count
//! re-arms the wait via `Notify::notify_waiters`; session-count changes
//! re-arm the wait the next time the state is re-checked after a wake-up.
//!
//! `main.rs` races `wait_for_idle_exit` against the server's accept loop in
//! a `tokio::select!`; when the idle future wins, the sidecar logs and
//! exits cleanly.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use tokio::sync::Notify;

use crate::server::SessionMap;

/// Sidecar idle-exit tracker. Cheap to clone — all interior state is in
/// `Arc`s and shared across clones.
#[derive(Clone)]
pub struct Idle {
    /// How long `clients == 0 && session_count == 0` must hold continuously
    /// before `wait_for_idle_exit` returns.
    pub timeout: Duration,
    /// Live count of connected clients (one per accepted connection task).
    clients: Arc<AtomicUsize>,
    /// Wakes the idle waiter whenever client / session state may have
    /// changed. Public so the server can wake the waiter from places that
    /// already hold `Idle` and modify session state (e.g. after a
    /// `Stop` request removes a session).
    pub waker: Arc<Notify>,
}

impl Idle {
    /// Build a fresh tracker with the given timeout. Client count starts at
    /// zero; bump it via `client_connected` as connections arrive.
    pub fn new(timeout: Duration) -> Self {
        Self {
            timeout,
            clients: Arc::new(AtomicUsize::new(0)),
            waker: Arc::new(Notify::new()),
        }
    }

    /// Increment the client count by one and wake the idle waiter. Call
    /// this when a new connection is accepted.
    pub fn client_connected(&self) {
        self.clients.fetch_add(1, Ordering::SeqCst);
        self.waker.notify_waiters();
    }

    /// Decrement the client count by one and wake the idle waiter. Call
    /// this when a connection-handling task ends (the `ClientGuard`
    /// drop-guard in `server.rs` does this automatically on return / panic).
    pub fn client_disconnected(&self) {
        self.clients.fetch_sub(1, Ordering::SeqCst);
        self.waker.notify_waiters();
    }

    /// Explicitly set the client count and wake the idle waiter. Primarily
    /// useful in tests where we want to assert behavior without going
    /// through the connection lifecycle.
    pub fn notify_client_count(&self, n: usize) {
        self.clients.store(n, Ordering::SeqCst);
        self.waker.notify_waiters();
    }
}

/// Block until the host has been idle (no clients, no sessions) for
/// `idle.timeout` continuously. The future is cancel-safe — callers race
/// it against the server's accept future in a `tokio::select!`.
///
/// The algorithm is a small state machine:
///
/// ```text
/// loop {
///     if clients == 0 && sessions == 0 {
///         select! {
///             timer  -> re-check; if still idle, return.
///             waker  -> continue (state changed; re-evaluate).
///         }
///     } else {
///         wait on waker (anything that bumps clients or session state
///         must notify_waiters).
///     }
/// }
/// ```
///
/// Session-count changes don't have their own waker today; they piggy-back
/// on whatever wakes us next (a connection / disconnect, or an explicit
/// `idle.waker.notify_waiters()` from the dispatch path). The re-check on
/// the other side of the sleep guarantees we don't exit prematurely if a
/// session was added during the timeout.
pub async fn wait_for_idle_exit(map: SessionMap, idle: Idle) {
    loop {
        let clients = idle.clients.load(Ordering::SeqCst);
        let session_count = map.lock().await.len();
        if clients == 0 && session_count == 0 {
            tokio::select! {
                _ = tokio::time::sleep(idle.timeout) => {
                    let clients = idle.clients.load(Ordering::SeqCst);
                    let session_count = map.lock().await.len();
                    if clients == 0 && session_count == 0 {
                        return;
                    }
                }
                _ = idle.waker.notified() => {
                    continue;
                }
            }
        } else {
            idle.waker.notified().await;
        }
    }
}
