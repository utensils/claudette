use std::path::PathBuf;

use clap::Parser;

use claudette_server::{DEFAULT_PORT, ServerOptions};

#[derive(Parser)]
#[command(
    name = "claudette-server",
    version,
    about = "Headless Claudette backend for remote access"
)]
struct Cli {
    /// WebSocket port.
    #[arg(long, default_value_t = DEFAULT_PORT)]
    port: u16,

    /// Bind address.
    #[arg(long, default_value = "0.0.0.0")]
    bind: String,

    /// Display name for this server.
    #[arg(long)]
    name: Option<String>,

    /// Disable mDNS advertisement.
    #[arg(long)]
    no_mdns: bool,

    /// Config file path.
    #[arg(long)]
    config: Option<PathBuf>,
}

// The legacy subcommands `regenerate-token` and `show-connection-string`
// were removed when the auth model switched from a single global pairing
// token to per-share scoped grants. Connection strings are now minted by
// the Claudette GUI when a share is created (one per share), so there's
// no useful single string for the binary to print on demand.

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    claudette_server::run(ServerOptions {
        port: cli.port,
        bind: cli.bind,
        name: cli.name,
        no_mdns: cli.no_mdns,
        config_path: cli.config,
        existing_config: None,
    })
    .await?;
    Ok(())
}
