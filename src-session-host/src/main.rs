//! The Claudette interactive-Claude session host.
//!
//! Long-lived sidecar process. Owns claude PTYs. Exposes a JSON-line local
//! socket protocol (Unix-domain socket / Named Pipe). See
//! `claudette::agent::interactive_protocol`.

use claudette_session_host::server;

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
        "claudette-session-host starting"
    );

    server::run_at(&socket_path).await
}
