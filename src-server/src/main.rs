use std::path::PathBuf;

use clap::{Parser, Subcommand};

use claudette_server::auth::ServerConfig;
use claudette_server::{DEFAULT_PORT, ServerOptions, default_config_path};

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

    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand)]
enum Commands {
    /// Generate a new pairing token (revokes all sessions).
    RegenerateToken,
    /// Print the connection string for this server.
    ShowConnectionString,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Install the shared `tracing` subscriber before any code path emits
    // events. Without this, the conversions in `lib.rs` / `ws.rs` /
    // `handler.rs` (plugin bootstrap warnings, TLS handshake failures,
    // per-connection auth diagnostics) would be dropped on the floor when
    // someone runs the standalone `claudette-server` binary — only the
    // Tauri-embedded path installed the subscriber before. Held for the
    // life of `main` so the non-blocking file appender flushes pending
    // writes on exit.
    let _log_handle = claudette::logging::init();

    let cli = Cli::parse();
    let config_path = cli.config.clone().unwrap_or_else(default_config_path);

    match &cli.command {
        Some(Commands::RegenerateToken) => {
            let mut config = ServerConfig::load_or_create(&config_path)?;
            config.regenerate_token();
            config.save(&config_path)?;
            println!("Pairing token regenerated. All existing sessions have been revoked.");
            println!("\nNew connection string:");
            let host = gethostname::gethostname().to_string_lossy().to_string();
            println!(
                "  claudette://{}:{}/{}",
                host, config.server.port, config.auth.pairing_token
            );
        }
        Some(Commands::ShowConnectionString) => {
            let config = ServerConfig::load_or_create(&config_path)?;
            let host = gethostname::gethostname().to_string_lossy().to_string();
            println!(
                "claudette://{}:{}/{}",
                host, config.server.port, config.auth.pairing_token
            );
        }
        None => {
            claudette_server::run(ServerOptions {
                port: cli.port,
                bind: cli.bind,
                name: cli.name,
                no_mdns: cli.no_mdns,
                config_path: cli.config,
            })
            .await?;
        }
    }

    Ok(())
}
