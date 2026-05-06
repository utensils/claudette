pub mod auth;
pub mod collab;
pub mod handler;
pub mod mdns;
pub mod tls;
pub mod ws;

use std::path::PathBuf;
use std::sync::Arc;

use claudette::room::RoomRegistry;
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
    /// Pre-built shared config. When `Some`, the server uses this instance
    /// (so a host process can mutate the same `ServerConfig` to mint and
    /// revoke shares); when `None`, the server loads from `config_path`
    /// and owns its own copy.
    pub existing_config: Option<Arc<tokio::sync::Mutex<ServerConfig>>>,
}

impl Default for ServerOptions {
    fn default() -> Self {
        Self {
            port: DEFAULT_PORT,
            bind: "0.0.0.0".to_string(),
            name: None,
            no_mdns: false,
            config_path: None,
            existing_config: None,
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
    claudette::path::data_dir().join("claudette.db")
}

/// Run the claudette-server with the given options. Blocks indefinitely,
/// accepting WebSocket connections over TLS.
///
/// Prints the connection string to stdout before entering the accept loop
/// (the Tauri parent process reads this to extract the connection string).
///
/// This is the **subprocess** entrypoint — the server owns its own
/// `RoomRegistry`. For collaborative sessions where the Tauri host needs to
/// share rooms with the embedded server, see [`run_with_rooms`].
pub async fn run(options: ServerOptions) -> Result<(), Box<dyn std::error::Error>> {
    run_with_rooms(options, RoomRegistry::new()).await
}

/// Variant of [`run`] that accepts an externally-owned `RoomRegistry`. The
/// Tauri host calls this from a `tokio::spawn` after starting collaborative
/// share: the registry is the same `Arc` held by `AppState`, so events
/// published from either side reach subscribers on the other.
pub async fn run_with_rooms(
    options: ServerOptions,
    rooms: Arc<RoomRegistry>,
) -> Result<(), Box<dyn std::error::Error>> {
    run_with_rooms_and_events(options, rooms, None).await
}

/// Variant of [`run_with_rooms`] that additionally wires a
/// [`claudette::workspace_events::WorkspaceEventBus`] into the server.
/// Authenticated WS connections subscribe to the bus and forward events
/// (currently: workspace archive) to remote clients in scope.
///
/// The Tauri host passes a `Some(Arc<...>)` cloned from `AppState.workspace_events`
/// so a publish on the host side reaches every connected remote.
/// Subprocess servers without a host process pass `None`.
pub async fn run_with_rooms_and_events(
    options: ServerOptions,
    rooms: Arc<RoomRegistry>,
    workspace_events: Option<Arc<claudette::workspace_events::WorkspaceEventBus>>,
) -> Result<(), Box<dyn std::error::Error>> {
    // Install the default crypto provider for rustls. When both `aws-lc-rs` and
    // `ring` features are active (e.g. embedded in the Tauri binary where
    // tauri-plugin-updater pulls in ring), rustls cannot auto-detect and panics.
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();

    let config_path = options.config_path.unwrap_or_else(default_config_path);

    // Get or build the shared config. When the caller (Tauri host) supplies
    // one, we use it as-is — that's what lets the host mint shares while
    // the server is running. Otherwise we load from disk and own it.
    let config = if let Some(existing) = options.existing_config {
        // Apply runtime overrides to the caller's config too (port, bind,
        // name) so a CLI override on a shared config still takes effect.
        {
            let mut guard = existing.lock().await;
            guard.server.port = options.port;
            guard.server.bind = options.bind.clone();
            if let Some(ref name) = options.name {
                guard.server.name = name.clone();
            }
            let _ = guard.save(&config_path);
        }
        existing
    } else {
        let mut config = ServerConfig::load_or_create(&config_path)?;
        config.server.port = options.port;
        config.server.bind = options.bind.clone();
        if let Some(ref name) = options.name {
            config.server.name = name.clone();
        }
        config.save(&config_path)?;
        Arc::new(tokio::sync::Mutex::new(config))
    };

    // Load or generate TLS certificate.
    let tls_config = tls::load_or_generate_tls(&config_dir())?;
    let fingerprint = tls::cert_fingerprint(&config_dir())?;

    // No global pairing token any more — every share mints its own.
    // The config is shared with `ServerState` (so RPC handlers can
    // re-validate a connection's parent share on every request).
    let server_name = config.lock().await.server.name.clone();
    let config_path = Arc::new(config_path);

    // Set up database.
    let db_path = db_path();
    let _ = claudette::db::Database::open(&db_path);

    let worktree_base_dir = {
        let default = claudette::path::claudette_home().join("workspaces");
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
    let plugin_dir = claudette::path::claudette_home().join("plugins");
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

    let mut server_state = ws::ServerState::new_with_plugins_rooms_and_config_arc(
        db_path,
        worktree_base_dir,
        plugins,
        rooms,
        config,
    );
    if let Some(bus) = workspace_events {
        server_state.set_workspace_events(bus);
    }
    let state = Arc::new(server_state);
    // The shared config inside `state` is the single source of truth.
    // The accept loop hands `state.config` back into `handle_tls_connection`
    // so the auth path mutates the same instance the handler validates against.
    let config_for_accept = Arc::clone(&state.config);

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
    println!("Certificate fingerprint: {fingerprint}");
    println!();
    println!("Hostname: {host} — connection strings are minted per-share from the Claudette UI.");
    println!("Ready for connections.\n");

    loop {
        let (stream, peer_addr) = listener.accept().await?;
        let acceptor = acceptor.clone();
        let state = Arc::clone(&state);
        let config = Arc::clone(&config_for_accept);
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
