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
    claudette::path::data_dir().join("claudette.db")
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
