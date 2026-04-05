mod auth;
mod handler;
mod mdns;
mod tls;
mod ws;

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use clap::{Parser, Subcommand};
use tokio::net::TcpListener;

use crate::auth::ServerConfig;

/// Default WebSocket port for claudette-server.
pub const DEFAULT_PORT: u16 = 7683;

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

fn config_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("claudette-server")
}

fn default_config_path() -> PathBuf {
    config_dir().join("server.toml")
}

fn db_path() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("claudette")
        .join("claudette.db")
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
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
            return Ok(());
        }
        Some(Commands::ShowConnectionString) => {
            let config = ServerConfig::load_or_create(&config_path)?;
            let host = gethostname::gethostname().to_string_lossy().to_string();
            println!(
                "claudette://{}:{}/{}",
                host, config.server.port, config.auth.pairing_token
            );
            return Ok(());
        }
        None => {}
    }

    // Load or create config, applying CLI overrides.
    let mut config = ServerConfig::load_or_create(&config_path)?;
    config.server.port = cli.port;
    config.server.bind = cli.bind.clone();
    if let Some(ref name) = cli.name {
        config.server.name = name.clone();
    }
    config.save(&config_path)?;

    // Load or generate TLS certificate.
    let tls_config = tls::load_or_generate_tls(&config_dir())?;
    let fingerprint = tls::cert_fingerprint(&config_dir())?;

    let host = gethostname::gethostname().to_string_lossy().to_string();
    println!(
        "claudette-server v{} listening on wss://{}:{}",
        env!("CARGO_PKG_VERSION"),
        cli.bind,
        cli.port,
    );
    println!("Name: {}", config.server.name);
    println!();
    println!("Connection string (paste into Claudette):");
    println!(
        "  claudette://{}:{}/{}",
        host, cli.port, config.auth.pairing_token
    );
    println!();
    println!("Certificate fingerprint: {fingerprint}");
    println!();

    // Set up database.
    let db_path = db_path();
    let _ = claudette::db::Database::open(&db_path);

    let worktree_base_dir = {
        let default = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".claudette")
            .join("workspaces");
        if let Ok(db) = claudette::db::Database::open(&db_path) {
            db.get_app_setting("worktree_base_dir")
                .ok()
                .flatten()
                .map(PathBuf::from)
                .unwrap_or(default)
        } else {
            default
        }
    };

    let state = Arc::new(ws::ServerState::new(db_path, worktree_base_dir));

    // Start mDNS advertisement.
    if !cli.no_mdns {
        let short_fp = &fingerprint[..fingerprint.len().min(16)];
        let _mdns = mdns::advertise(&config.server.name, cli.port, short_fp)?;
        println!("mDNS: advertising as _claudette._tcp on port {}", cli.port);
    }

    // Bind TCP listener.
    let addr: SocketAddr = format!("{}:{}", cli.bind, cli.port).parse()?;
    let listener = TcpListener::bind(addr).await?;
    let acceptor = tokio_rustls::TlsAcceptor::from(tls_config);

    println!("Ready for connections.\n");

    loop {
        let (stream, peer_addr) = listener.accept().await?;
        let acceptor = acceptor.clone();
        let state = Arc::clone(&state);
        let config = config.clone();

        tokio::spawn(async move {
            match acceptor.accept(stream).await {
                Ok(tls_stream) => {
                    ws::handle_tls_connection(state, config, tls_stream, peer_addr).await;
                }
                Err(e) => {
                    eprintln!("[tls] handshake failed from {peer_addr}: {e}");
                }
            }
        });
    }
}
