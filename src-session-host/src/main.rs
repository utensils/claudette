//! The Claudette interactive-Claude session host.
//!
//! Long-lived sidecar process. Owns claude PTYs. Exposes a JSON-line local
//! socket protocol (Unix-domain socket / Named Pipe). See
//! `claudette::agent::interactive_protocol`.

fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();
    tracing::info!(
        "claudette-session-host {} starting",
        env!("CARGO_PKG_VERSION")
    );
    // Stub: just exit. Real server logic comes in Task C2+.
    Ok(())
}
