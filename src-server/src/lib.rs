pub mod auth;
pub mod handler;
pub mod mdns;
pub mod tls;
pub mod ws;

use std::path::PathBuf;
use std::sync::Arc;

use tokio::net::TcpListener;

use crate::auth::ServerConfig;

/// Default WebSocket port for claudette-server.
pub const DEFAULT_PORT: u16 = 7683;

/// Options for running the embedded server.
pub struct ServerOptions {
    pub port: u16,
    pub bind: String,
    pub name: Option<String>,
    pub no_mdns: bool,
    pub config_path: Option<PathBuf>,
}

impl Default for ServerOptions {
    fn default() -> Self {
        Self {
            port: DEFAULT_PORT,
            bind: "0.0.0.0".to_string(),
            name: None,
            no_mdns: false,
            config_path: None,
        }
    }
}

pub fn config_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("claudette-server")
}

pub fn default_config_path() -> PathBuf {
    config_dir().join("server.toml")
}

pub fn db_path() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("claudette")
        .join("claudette.db")
}

/// Run the claudette-server with the given options. Blocks indefinitely,
/// accepting WebSocket connections over TLS.
///
/// Prints the connection string to stdout before entering the accept loop
/// (the Tauri parent process reads this to extract the connection string).
pub async fn run(options: ServerOptions) -> Result<(), Box<dyn std::error::Error>> {
    // Install the default crypto provider for rustls. When both `aws-lc-rs` and
    // `ring` features are active (e.g. embedded in the Tauri binary where
    // tauri-plugin-updater pulls in ring), rustls cannot auto-detect and panics.
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();

    let config_path = options.config_path.unwrap_or_else(default_config_path);

    // Load or create config, applying overrides.
    let mut config = ServerConfig::load_or_create(&config_path)?;
    config.server.port = options.port;
    config.server.bind = options.bind.clone();
    if let Some(ref name) = options.name {
        config.server.name = name.clone();
    }
    config.save(&config_path)?;

    // Load or generate TLS certificate.
    let tls_config = tls::load_or_generate_tls(&config_dir())?;
    let fingerprint = tls::cert_fingerprint(&config_dir())?;

    // Wrap config in shared state so all connections see session mutations.
    let pairing_token = config.auth.pairing_token.clone();
    let server_name = config.server.name.clone();
    let config = Arc::new(tokio::sync::Mutex::new(config));
    let config_path = Arc::new(config_path);

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

    // Mirror the Tauri-side plugin bootstrap so remote-launched agents
    // pick up env-provider activation. Seeding bundled plugins is
    // idempotent — if the desktop app has already populated the dir,
    // this is a no-op; if the user is running headless, it makes the
    // standard providers (direnv / mise / dotenv / nix-devshell)
    // available without any manual setup.
    let plugin_dir = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".claudette")
        .join("plugins");
    let _ = std::fs::create_dir_all(&plugin_dir);
    for warning in claudette::plugin_runtime::seed::seed_bundled_plugins(&plugin_dir) {
        tracing::warn!(target: "claudette::plugin", "{}", warning);
    }
    let plugins = claudette::plugin_runtime::PluginRegistry::discover(&plugin_dir);
    tracing::info!(
        target: "claudette::plugin",
        count = plugins.plugins.len(),
        plugins = %plugins
            .plugins
            .keys()
            .cloned()
            .collect::<Vec<_>>()
            .join(", "),
        "plugins discovered"
    );

    // Hydrate global enable/disable + per-plugin setting overrides from
    // app_settings, exactly as the Tauri binary does. Failures are
    // non-fatal: the registry just runs with manifest defaults.
    if let Ok(db) = claudette::db::Database::open(&db_path)
        && let Ok(entries) = db.list_app_settings_with_prefix("plugin:")
    {
        for (key, value) in entries {
            let rest = &key["plugin:".len()..];
            if let Some((plugin_name, tail)) = rest.split_once(':') {
                if tail == "enabled" && value == "false" {
                    plugins.set_disabled(plugin_name, true);
                } else if let Some(setting_key) = tail.strip_prefix("setting:")
                    && let Ok(json_value) = serde_json::from_str::<serde_json::Value>(&value)
                {
                    plugins.set_setting(plugin_name, setting_key, Some(json_value));
                }
            }
        }
    }

    let state = Arc::new(ws::ServerState::new_with_plugins(
        db_path,
        worktree_base_dir,
        plugins,
    ));

    // Bind TCP listener before printing the connection string so the parent
    // process never sees `claudette://` unless we're actually listening.
    let addr: std::net::SocketAddr = format!("{}:{}", options.bind, options.port).parse()?;
    let listener = TcpListener::bind(addr).await?;
    let acceptor = tokio_rustls::TlsAcceptor::from(tls_config);

    // Start mDNS advertisement.
    if !options.no_mdns {
        let short_fp = &fingerprint[..fingerprint.len().min(16)];
        let _mdns = mdns::advertise(&server_name, options.port, short_fp)?;
        println!(
            "mDNS: advertising as _claudette._tcp on port {}",
            options.port
        );
    }

    let host = gethostname::gethostname().to_string_lossy().to_string();
    println!(
        "claudette-server v{} listening on wss://{}:{}",
        env!("CARGO_PKG_VERSION"),
        options.bind,
        options.port,
    );
    println!("Name: {server_name}");
    println!();
    println!("Connection string (paste into Claudette):");
    println!("  claudette://{}:{}/{}", host, options.port, pairing_token);
    println!();
    println!("Certificate fingerprint: {fingerprint}");
    println!();
    println!("Ready for connections.\n");

    loop {
        let (stream, peer_addr) = listener.accept().await?;
        let acceptor = acceptor.clone();
        let state = Arc::clone(&state);
        let config = Arc::clone(&config);
        let config_path = Arc::clone(&config_path);

        tokio::spawn(async move {
            match acceptor.accept(stream).await {
                Ok(tls_stream) => {
                    ws::handle_tls_connection(state, config, config_path, tls_stream, peer_addr)
                        .await;
                }
                Err(e) => {
                    tracing::warn!(
                        target: "claudette::ws",
                        peer = %peer_addr,
                        error = %e,
                        "TLS handshake failed"
                    );
                }
            }
        });
    }
}
