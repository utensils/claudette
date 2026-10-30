pub mod auth;
pub mod handler;
pub mod host;
pub mod mdns;
pub mod snapshot;
pub mod tls;
pub mod ws;

use std::path::PathBuf;
use std::sync::Arc;

use tokio::net::TcpListener;

use crate::auth::ServerConfig;
pub use crate::host::{RpcHost, StandaloneHost};

/// Default WebSocket port for claudette-server.
pub const DEFAULT_PORT: u16 = 7683;

/// Options for running the embedded server.
pub struct ServerOptions {
    pub port: u16,
    pub bind: String,
    pub name: Option<String>,
    pub no_mdns: bool,
    pub config_path: Option<PathBuf>,
    /// Where `cert.pem` / `key.pem` live. Defaults to [`config_dir`].
    pub tls_dir: Option<PathBuf>,
}

impl Default for ServerOptions {
    fn default() -> Self {
        Self {
            port: DEFAULT_PORT,
            bind: "0.0.0.0".to_string(),
            name: None,
            no_mdns: false,
            config_path: None,
            tls_dir: None,
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

/// A running server's public details plus the means to stop it.
pub struct ServerHandle {
    /// `claudette://host:port/pairing-token` for pairing new clients.
    pub connection_string: String,
    /// SHA-256 hex of the TLS certificate (what clients pin).
    pub cert_fingerprint: String,
    pub server_name: String,
    pub bind: String,
    pub port: u16,
    shutdown: tokio::sync::watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}

impl ServerHandle {
    /// Stop accepting connections, close every established one, and drop
    /// the mDNS advertisement. Idempotent.
    pub fn stop(&mut self) {
        let _ = self.shutdown.send(true);
    }

    /// [`Self::stop`], then wait until the listener is closed so its port
    /// can be bound again right away.
    pub async fn stop_and_wait(&mut self) {
        self.stop();
        if !self.task.is_finished() {
            let _ = (&mut self.task).await;
        }
    }

    /// Wait for the accept loop to end (it only ends on [`Self::stop`] or a
    /// listener error).
    pub async fn wait(self) {
        let _ = self.task.await;
    }
}

/// Bind the WSS listener, start mDNS, and serve `host` in a background task.
/// Returns once the listener is bound, so a returned handle is always
/// accepting connections.
pub async fn start(options: ServerOptions, host: Arc<dyn RpcHost>) -> Result<ServerHandle, String> {
    // Install the default crypto provider for rustls. When both `aws-lc-rs` and
    // `ring` features are active (e.g. embedded in the Tauri binary where
    // tauri-plugin-updater pulls in ring), rustls cannot auto-detect and panics.
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();

    let config_path = options.config_path.unwrap_or_else(default_config_path);

    // Load or create config, applying overrides.
    let mut config = ServerConfig::load_or_create(&config_path).map_err(|e| e.to_string())?;
    config.server.port = options.port;
    config.server.bind = options.bind.clone();
    if let Some(ref name) = options.name {
        config.server.name = name.clone();
    }
    config.save(&config_path).map_err(|e| e.to_string())?;

    // Load or generate TLS certificate.
    let tls_dir = options.tls_dir.clone().unwrap_or_else(config_dir);
    let tls_config = tls::load_or_generate_tls(&tls_dir).map_err(|e| e.to_string())?;
    let fingerprint = tls::cert_fingerprint(&tls_dir).map_err(|e| e.to_string())?;

    // Wrap config in shared state so all connections see session mutations.
    let pairing_token = config.auth.pairing_token.clone();
    let server_name = config.server.name.clone();
    let config = Arc::new(tokio::sync::Mutex::new(config));
    let config_path = Arc::new(config_path);

    let addr: std::net::SocketAddr = format!("{}:{}", options.bind, options.port)
        .parse()
        .map_err(|e| format!("invalid bind address: {e}"))?;
    let listener = TcpListener::bind(addr)
        .await
        .map_err(|e| format!("failed to bind {addr}: {e}"))?;
    // Report the bound port, which differs from the requested one when the
    // caller asked for port 0.
    let port = listener
        .local_addr()
        .map(|a| a.port())
        .unwrap_or(options.port);
    let acceptor = tokio_rustls::TlsAcceptor::from(tls_config);

    let mdns = if options.no_mdns {
        None
    } else {
        let short_fp = &fingerprint[..fingerprint.len().min(16)];
        match mdns::advertise(&server_name, port, short_fp) {
            Ok(daemon) => Some(daemon),
            Err(e) => {
                // Pairing by connection string still works without mDNS.
                tracing::warn!(target: "claudette::ws", error = %e, "mDNS advertisement failed");
                None
            }
        }
    };

    let hostname = gethostname::gethostname().to_string_lossy().to_string();
    let connection_string = format!(
        "claudette://{}:{}/{}",
        hostname, options.port, pairing_token
    );

    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    let mut accept_shutdown = shutdown_rx.clone();
    let task = tokio::spawn(async move {
        loop {
            let accepted = tokio::select! {
                accepted = listener.accept() => accepted,
                _ = async { accept_shutdown.wait_for(|stop| *stop).await.is_ok() } => break,
            };
            let (stream, peer_addr) = match accepted {
                Ok(pair) => pair,
                Err(e) => {
                    tracing::warn!(target: "claudette::ws", error = %e, "accept failed");
                    continue;
                }
            };
            let acceptor = acceptor.clone();
            let host = Arc::clone(&host);
            let config = Arc::clone(&config);
            let config_path = Arc::clone(&config_path);
            let shutdown = shutdown_rx.clone();

            tokio::spawn(async move {
                match acceptor.accept(stream).await {
                    Ok(tls_stream) => {
                        ws::handle_tls_connection(
                            host,
                            config,
                            config_path,
                            tls_stream,
                            peer_addr,
                            shutdown,
                        )
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
        if let Some(daemon) = mdns {
            let _ = daemon.shutdown();
        }
        tracing::info!(target: "claudette::ws", "server stopped");
    });

    Ok(ServerHandle {
        connection_string,
        cert_fingerprint: fingerprint,
        server_name,
        bind: options.bind,
        port,
        shutdown: shutdown_tx,
        task,
    })
}

/// Build the standalone host: the server's own DB-backed state, plugin
/// registry, and shell-env capture.
pub fn standalone_host() -> Arc<StandaloneHost> {
    let db_path = db_path();
    let _ = claudette::db::Database::open(&db_path);

    // Capture the user's interactive shell env so agents and terminals see
    // the same PATH/toolchains they'd get from a terminal. The desktop app
    // does this at launch; a headless server has to do it itself.
    let shell_env_denylist: Vec<String> = claudette::db::Database::open(&db_path)
        .ok()
        .and_then(|db| db.get_app_setting("shell_env:denylist").ok().flatten())
        .map(|s| {
            s.lines()
                .map(str::to_string)
                .filter(|l| !l.is_empty())
                .collect()
        })
        .unwrap_or_default();
    claudette::env::prewarm_shell_env(shell_env_denylist);

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

    // Hydrate enable/disable + setting overrides from app_settings,
    // matching the Tauri binary's startup behavior. Failures are
    // non-fatal: the registry just runs with manifest defaults.
    if let Ok(db) = claudette::db::Database::open(&db_path) {
        hydrate_plugin_registry_from_db(&plugins, &db);
    }

    Arc::new(StandaloneHost {
        state: Arc::new(ws::ServerState::new_with_plugins(
            db_path,
            worktree_base_dir,
            plugins,
        )),
    })
}

/// Run the standalone claudette-server until the process is killed.
///
/// Prints the connection string to stdout once the listener is bound.
pub async fn run(options: ServerOptions) -> Result<(), Box<dyn std::error::Error>> {
    let no_mdns = options.no_mdns;
    let handle = start(options, standalone_host()).await?;

    if !no_mdns {
        println!(
            "mDNS: advertising as _claudette._tcp on port {}",
            handle.port
        );
    }
    println!(
        "claudette-server v{} listening on wss://{}:{}",
        env!("CARGO_PKG_VERSION"),
        handle.bind,
        handle.port,
    );
    println!("Name: {}", handle.server_name);
    println!();
    println!("Connection string (paste into Claudette):");
    println!("  {}", handle.connection_string);
    println!();
    println!("Certificate fingerprint: {}", handle.cert_fingerprint);
    println!();
    println!("Ready for connections.\n");

    handle.wait().await;
    Ok(())
}

fn hydrate_plugin_registry_from_db(
    plugins: &claudette::plugin_runtime::PluginRegistry,
    db: &claudette::db::Database,
) {
    if let Ok(entries) = db.list_app_settings_with_prefix("plugin:") {
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

    if let Ok(entries) = db.list_app_settings_with_prefix("repo:") {
        for (key, value) in entries {
            let rest = &key["repo:".len()..];
            let Some((repo_id, tail)) = rest.split_once(':') else {
                continue;
            };
            let Some(rest) = tail.strip_prefix("plugin:") else {
                continue;
            };
            let Some((plugin_name, tail)) = rest.split_once(':') else {
                continue;
            };
            if let Some(setting_key) = tail.strip_prefix("setting:")
                && let Ok(json_value) = serde_json::from_str::<serde_json::Value>(&value)
            {
                plugins.set_repo_setting(repo_id, plugin_name, setting_key, Some(json_value));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::hydrate_plugin_registry_from_db;

    fn write_settings_plugin(dir: &std::path::Path) {
        let plugin_dir = dir.join("env-settings");
        std::fs::create_dir_all(&plugin_dir).unwrap();
        std::fs::write(
            plugin_dir.join("plugin.json"),
            r#"{
                "name": "env-settings",
                "display_name": "Settings fixture",
                "version": "1.0.0",
                "description": "test-only env-provider",
                "kind": "env-provider",
                "operations": ["detect", "export"]
            }"#,
        )
        .unwrap();
        std::fs::write(
            plugin_dir.join("init.lua"),
            r#"
            local M = {}
            function M.detect() return true end
            function M.export() return { env = {}, watched = {} } end
            return M
            "#,
        )
        .unwrap();
    }

    #[test]
    fn hydrate_plugin_registry_loads_global_and_per_repo_settings() {
        let plugin_root = tempfile::tempdir().unwrap();
        write_settings_plugin(plugin_root.path());
        let plugins = claudette::plugin_runtime::PluginRegistry::discover(plugin_root.path());

        let db_root = tempfile::tempdir().unwrap();
        let db = claudette::db::Database::open(&db_root.path().join("test.db")).unwrap();
        db.set_app_setting("plugin:env-settings:enabled", "false")
            .unwrap();
        db.set_app_setting("plugin:env-settings:setting:mode", "\"global\"")
            .unwrap();
        db.set_app_setting("repo:repo-a:plugin:env-settings:setting:mode", "\"repo-a\"")
            .unwrap();
        db.set_app_setting(
            "repo:repo-a:plugin:env-settings:setting:extra",
            "{\"ok\":true}",
        )
        .unwrap();

        hydrate_plugin_registry_from_db(&plugins, &db);

        assert!(plugins.is_disabled("env-settings"));
        assert_eq!(
            plugins
                .effective_config("env-settings")
                .get("mode")
                .and_then(|v| v.as_str()),
            Some("global")
        );

        let mut ws_info = claudette::plugin_runtime::host_api::WorkspaceInfo {
            repo_id: Some("repo-a".to_string()),
            ..Default::default()
        };
        let repo_config = plugins.effective_config_for_invocation("env-settings", &ws_info);
        assert_eq!(
            repo_config.get("mode").and_then(|v| v.as_str()),
            Some("repo-a")
        );
        assert_eq!(
            repo_config
                .get("extra")
                .and_then(|v| v.get("ok"))
                .and_then(|v| v.as_bool()),
            Some(true)
        );

        ws_info.repo_id = Some("repo-b".to_string());
        let other_config = plugins.effective_config_for_invocation("env-settings", &ws_info);
        assert_eq!(
            other_config.get("mode").and_then(|v| v.as_str()),
            Some("global")
        );
    }

    #[test]
    fn hydrate_plugin_registry_ignores_malformed_repo_settings() {
        let plugin_root = tempfile::tempdir().unwrap();
        write_settings_plugin(plugin_root.path());
        let plugins = claudette::plugin_runtime::PluginRegistry::discover(plugin_root.path());

        let db_root = tempfile::tempdir().unwrap();
        let db = claudette::db::Database::open(&db_root.path().join("test.db")).unwrap();
        db.set_app_setting("repo:repo-a:plugin:env-settings:setting:mode", "not-json")
            .unwrap();
        db.set_app_setting("repo:repo-a:plugin:missing:setting:mode", "\"ignored\"")
            .unwrap();

        hydrate_plugin_registry_from_db(&plugins, &db);

        let ws_info = claudette::plugin_runtime::host_api::WorkspaceInfo {
            repo_id: Some("repo-a".to_string()),
            ..Default::default()
        };
        let config = plugins.effective_config_for_invocation("env-settings", &ws_info);
        assert!(
            !config.contains_key("mode"),
            "malformed repo setting should not be hydrated"
        );
    }
}
