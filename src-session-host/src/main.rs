//! The Claudette interactive-Claude session host.
//!
//! Long-lived sidecar process. Owns claude PTYs. Exposes a JSON-line local
//! socket protocol (Unix-domain socket / Named Pipe). See
//! `claudette::agent::interactive_protocol`.
//!
//! The sidecar exits cleanly after `IDLE_TIMEOUT` of no clients and no
//! sessions — see `claudette_session_host::idle`. Production default is
//! 600 s; integration tests use shorter timeouts.

use claudette_session_host::{idle, server};

/// Default idle-exit window for production. After this much continuous time
/// with zero connected clients and zero live sessions the sidecar shuts
/// itself down. A new request from the Tauri app will respawn it on
/// demand. Mirrors the value referenced by the C5 plan section.
const IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);

#[tokio::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let socket_path = server::default_socket_path();
    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        socket = %socket_path.display(),
        idle_timeout_secs = IDLE_TIMEOUT.as_secs(),
        "claudette-session-host starting"
    );

    let map = server::new_session_map();
    let idle = idle::Idle::new(IDLE_TIMEOUT);

    // Race the accept loop against the idle waiter. Either branch ending
    // returns from `main`; the OS reaps remaining tasks. The idle branch is
    // the common "user closed Claudette" path — we exit `Ok(())` so the
    // process status reflects a clean shutdown.
    tokio::select! {
        r = server::run_at_with_idle(map.clone(), &socket_path, idle.clone()) => r,
        _ = idle::wait_for_idle_exit(map.clone(), idle.clone()) => {
            tracing::info!(
                idle_timeout_secs = IDLE_TIMEOUT.as_secs(),
                "idle timeout reached, exiting"
            );
            Ok(())
        }
    }
}
