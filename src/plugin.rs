use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::process::CommandWindowExt as _;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum PluginScope {
    Managed,
    User,
    Project,
    Local,
}

impl PluginScope {
    pub fn as_cli_arg(self) -> &'static str {
        match self {
            Self::Managed => "managed",
            Self::User => "user",
            Self::Project => "project",
            Self::Local => "local",
        }
    }

    fn precedence(self) -> u8 {
        match self {
            Self::Local => 0,
            Self::Project => 1,
            Self::User => 2,
            Self::Managed => 3,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginConfigField {
    #[serde(rename = "type")]
    pub field_type: String,
    pub title: String,
    pub description: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default, rename = "default")]
    pub default_value: Option<Value>,
    #[serde(default)]
    pub multiple: bool,
    #[serde(default)]
    pub sensitive: bool,
    #[serde(default)]
    pub min: Option<f64>,
    #[serde(default)]
    pub max: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginChannelManifest {
    pub server: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub user_config: BTreeMap<String, PluginConfigField>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginManifestFile {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    user_config: BTreeMap<String, PluginConfigField>,
    #[serde(default)]
    channels: Vec<PluginChannelManifest>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PluginChannelSummary {
    pub server: String,
    pub display_name: Option<String>,
    pub config_schema: BTreeMap<String, PluginConfigField>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct InstalledPlugin {
    pub plugin_id: String,
    pub name: String,
    pub marketplace: Option<String>,
    pub version: String,
    pub latest_known_version: Option<String>,
    pub update_available: bool,
    pub scope: PluginScope,
    pub enabled: bool,
    pub install_path: String,
    pub installed_at: Option<String>,
    pub last_updated: Option<String>,
    pub description: Option<String>,
    pub command_count: usize,
    pub skill_count: usize,
    pub mcp_servers: Vec<String>,
    pub user_config_schema: BTreeMap<String, PluginConfigField>,
    pub channels: Vec<PluginChannelSummary>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AvailablePlugin {
    pub plugin_id: String,
    pub name: String,
    pub marketplace: String,
    pub description: Option<String>,
    pub version: Option<String>,
    pub current_version: Option<String>,
    pub update_available: bool,
    pub installed: bool,
    pub enabled: bool,
    pub installed_scopes: Vec<PluginScope>,
    pub enabled_scopes: Vec<PluginScope>,
    pub category: Option<String>,
    pub install_count: Option<u64>,
    pub homepage: Option<String>,
    pub source_label: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PluginCatalog {
    pub installed: Vec<InstalledPlugin>,
    pub available: Vec<AvailablePlugin>,
    pub updates_available: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PluginMarketplace {
    pub name: String,
    pub scope: Option<PluginScope>,
    pub source_kind: String,
    pub source_label: String,
    pub install_location: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PluginConfigState {
    pub values: BTreeMap<String, Value>,
    pub saved_sensitive_keys: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PluginConfigSection {
    pub schema: BTreeMap<String, PluginConfigField>,
    pub state: PluginConfigState,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PluginChannelConfiguration {
    pub server: String,
    pub display_name: Option<String>,
    pub section: PluginConfigSection,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PluginConfiguration {
    pub plugin_id: String,
    pub top_level: Option<PluginConfigSection>,
    pub channels: Vec<PluginChannelConfiguration>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct BulkPluginUpdateResult {
    pub attempted: usize,
    pub succeeded: usize,
    pub failed: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CliInstalledPluginEntry {
    id: String,
    version: String,
    scope: PluginScope,
    enabled: bool,
    install_path: String,
    #[serde(default)]
    installed_at: Option<String>,
    #[serde(default)]
    last_updated: Option<String>,
    #[serde(default)]
    mcp_servers: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CliMarketplaceEntry {
    name: String,
    source: String,
    #[serde(default)]
    repo: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    install_location: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstalledPluginsFile {
    #[allow(dead_code)]
    version: Option<u8>,
    #[serde(default)]
    plugins: BTreeMap<String, Vec<InstalledPluginEntry>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstalledPluginEntry {
    scope: PluginScope,
    #[serde(default)]
    project_path: Option<String>,
    install_path: String,
}

#[derive(Debug, Clone, Deserialize)]
struct MarketplaceManifestFile {
    #[serde(default)]
    plugins: Vec<MarketplaceManifestPluginEntry>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarketplaceManifestPluginEntry {
    name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    install_count: Option<u64>,
    #[serde(default)]
    homepage: Option<String>,
    #[serde(default)]
    source: Option<Value>,
}

#[derive(Debug, Clone)]
struct MarketplacePluginRecord {
    plugin_id: String,
    name: String,
    marketplace: String,
    description: Option<String>,
    version: Option<String>,
    category: Option<String>,
    install_count: Option<u64>,
    homepage: Option<String>,
    source_label: String,
}

#[derive(Default)]
struct SettingsDocs {
    user: Value,
    project: Value,
    local: Value,
}

pub async fn list_installed_plugins(
    repo_path: Option<&Path>,
) -> Result<Vec<InstalledPlugin>, String> {
    let marketplace_versions = load_cached_marketplace_version_index();
    let output = run_claude_plugin_command(
        repo_path,
        &[
            "plugin".to_string(),
            "list".to_string(),
            "--json".to_string(),
        ],
    )
    .await?;

    let mut plugins: Vec<InstalledPlugin> =
        serde_json::from_str::<Vec<CliInstalledPluginEntry>>(&output)
            .map_err(|e| format!("Failed to parse `claude plugin list --json`: {e}"))?
            .into_iter()
            .map(|entry| {
                let latest_known_version = marketplace_versions.get(&entry.id).cloned();
                enrich_installed_plugin(entry, latest_known_version)
            })
            .collect();

    plugins.sort_by(|a, b| {
        a.name
            .cmp(&b.name)
            .then_with(|| a.marketplace.cmp(&b.marketplace))
            .then_with(|| a.scope.precedence().cmp(&b.scope.precedence()))
    });

    Ok(plugins)
}

pub async fn list_plugin_catalog(repo_path: Option<&Path>) -> Result<PluginCatalog, String> {
    let installed = list_installed_plugins(repo_path).await?;
    let marketplaces = list_marketplaces(repo_path).await?;
    let available =
        build_available_plugins(&installed, load_marketplace_plugin_records(&marketplaces));
    let updates_available = installed
        .iter()
        .filter(|plugin| plugin.update_available)
        .count();

    Ok(PluginCatalog {
        installed,
        available,
        updates_available,
    })
}

pub async fn list_marketplaces(repo_path: Option<&Path>) -> Result<Vec<PluginMarketplace>, String> {
    let output = run_claude_plugin_command(
        repo_path,
        &[
            "plugin".to_string(),
            "marketplace".to_string(),
            "list".to_string(),
            "--json".to_string(),
        ],
    )
    .await?;

    let docs = load_settings_docs(repo_path);

    let mut marketplaces: Vec<PluginMarketplace> =
        serde_json::from_str::<Vec<CliMarketplaceEntry>>(&output)
            .map_err(|e| format!("Failed to parse `claude plugin marketplace list --json`: {e}"))?
            .into_iter()
            .map(|entry| PluginMarketplace {
                scope: declared_marketplace_scope(&docs, &entry.name),
                source_kind: entry.source.clone(),
                source_label: marketplace_source_label(&entry),
                install_location: entry.install_location.clone(),
                name: entry.name,
            })
            .collect();

    marketplaces.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(marketplaces)
}

pub async fn run_claude_plugin_command(
    repo_path: Option<&Path>,
    args: &[String],
) -> Result<String, String> {
    // Resolve claude up front. If it genuinely isn't on the enriched PATH,
    // return the structured `MISSING_CLI:claude` sentinel so the Tauri/UI
    // layer can render the install-CTA modal (see `crate::missing_cli`)
    // instead of leaking a bare `os error 2` (issue #641).
    //
    // Only `CannotFindBinaryPath` means "binary not found" — other variants
    // (`CannotGetCurrentDirAndPathListEmpty`, `CannotCanonicalize`) signal
    // real I/O / cwd issues that the user shouldn't be told to "install
    // claude" to fix. Surface those with their original message instead.
    let claude_path = crate::env::which_in_enriched_path("claude").map_err(|e| match e {
        which::Error::CannotFindBinaryPath => crate::missing_cli::format_err("claude"),
        other => format!("Failed to resolve `claude` on PATH: {other}"),
    })?;
    let current_dir = plugin_command_cwd(repo_path);

    let output = tokio::process::Command::new(&claude_path)
        .no_console_window()
        .args(args)
        .current_dir(current_dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .env("PATH", crate::env::enriched_path())
        .output()
        .await
        .map_err(|e| {
            crate::missing_cli::map_spawn_err(&e, "claude", || {
                format!("Failed to run `{}`: {e}", command_preview(args))
            })
        })?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if output.status.success() {
        if !stdout.is_empty() {
            Ok(stdout)
        } else if !stderr.is_empty() {
            Ok(stderr)
        } else {
            Ok("Plugin operation completed.".to_string())
        }
    } else {
        Err(if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("`{}` exited with {}", command_preview(args), output.status)
        })
    }
}

pub fn load_plugin_configuration(
    plugin_id: &str,
    repo_path: Option<&Path>,
) -> Result<PluginConfiguration, String> {
    let install = resolve_active_installation(plugin_id, repo_path)
        .ok_or_else(|| format!("Plugin `{plugin_id}` is not installed for this context"))?;
    let manifest = load_plugin_manifest(Path::new(&install.install_path));

    let settings = read_json_object(&user_settings_path())?;
    let secure_storage = read_secure_storage_object()?;

    let (top_level_schema, channels) = match manifest {
        Some(manifest) => (manifest.user_config, manifest.channels),
        None => (BTreeMap::new(), Vec::new()),
    };

    let plugin_config = settings
        .get("pluginConfigs")
        .and_then(Value::as_object)
        .and_then(|configs| configs.get(plugin_id))
        .and_then(Value::as_object);

    let plain_options = plugin_config
        .and_then(|config| config.get("options"))
        .and_then(Value::as_object);

    let secure_secrets = secure_storage
        .get("pluginSecrets")
        .and_then(Value::as_object);

    let top_level = if top_level_schema.is_empty() {
        None
    } else {
        Some(PluginConfigSection {
            state: build_config_state(
                &top_level_schema,
                plain_options,
                secure_secrets
                    .and_then(|secrets| secrets.get(plugin_id))
                    .and_then(Value::as_object),
            ),
            schema: top_level_schema,
        })
    };

    let channel_configs = plugin_config
        .and_then(|config| config.get("mcpServers"))
        .and_then(Value::as_object);

    let channels = channels
        .into_iter()
        .map(|channel| PluginChannelConfiguration {
            display_name: channel.display_name.clone(),
            server: channel.server.clone(),
            section: PluginConfigSection {
                state: build_config_state(
                    &channel.user_config,
                    channel_configs
                        .and_then(|configs| configs.get(&channel.server))
                        .and_then(Value::as_object),
                    secure_secrets
                        .and_then(|secrets| {
                            secrets.get(&channel_secret_key(plugin_id, &channel.server))
                        })
                        .and_then(Value::as_object),
                ),
                schema: channel.user_config,
            },
        })
        .collect();

    Ok(PluginConfiguration {
        channels,
        plugin_id: plugin_id.to_string(),
        top_level,
    })
}

pub fn save_plugin_top_level_configuration(
    plugin_id: &str,
    repo_path: Option<&Path>,
    submitted_values: BTreeMap<String, Value>,
) -> Result<(), String> {
    let install = resolve_active_installation(plugin_id, repo_path)
        .ok_or_else(|| format!("Plugin `{plugin_id}` is not installed for this context"))?;
    let manifest = load_plugin_manifest(Path::new(&install.install_path))
        .ok_or_else(|| format!("Plugin `{plugin_id}` has no manifest"))?;

    if manifest.user_config.is_empty() {
        return Err(format!(
            "Plugin `{plugin_id}` has no top-level configuration"
        ));
    }

    write_config_values(plugin_id, None, &manifest.user_config, submitted_values)
}

pub fn save_plugin_channel_configuration(
    plugin_id: &str,
    repo_path: Option<&Path>,
    server_name: &str,
    submitted_values: BTreeMap<String, Value>,
) -> Result<(), String> {
    let install = resolve_active_installation(plugin_id, repo_path)
        .ok_or_else(|| format!("Plugin `{plugin_id}` is not installed for this context"))?;
    let manifest = load_plugin_manifest(Path::new(&install.install_path))
        .ok_or_else(|| format!("Plugin `{plugin_id}` has no manifest"))?;

    let Some(channel) = manifest
        .channels
        .into_iter()
        .find(|channel| channel.server == server_name)
    else {
        return Err(format!(
            "Plugin `{plugin_id}` has no configurable channel named `{server_name}`"
        ));
    };

    if channel.user_config.is_empty() {
        return Err(format!(
            "Plugin `{plugin_id}` channel `{server_name}` has no configuration"
        ));
    }

    write_config_values(
        plugin_id,
        Some(server_name),
        &channel.user_config,
        submitted_values,
    )
}

pub fn cleanup_plugin_configuration_if_not_installed(plugin_id: &str) -> Result<(), String> {
    let installed = load_installed_plugins_file();
    if installed
        .plugins
        .get(plugin_id)
        .is_some_and(|entries| !entries.is_empty())
    {
        return Ok(());
    }

    let mut settings = read_json_object(&user_settings_path())?;
    let mut secure_storage = read_secure_storage_object()?;

    if let Some(plugin_configs) = settings
        .as_object_mut()
        .and_then(|root| root.get_mut("pluginConfigs"))
        .and_then(Value::as_object_mut)
    {
        plugin_configs.remove(plugin_id);
        if plugin_configs.is_empty() {
            settings
                .as_object_mut()
                .expect("settings is an object")
                .remove("pluginConfigs");
        }
    }

    if let Some(plugin_secrets) = secure_storage
        .as_object_mut()
        .and_then(|root| root.get_mut("pluginSecrets"))
        .and_then(Value::as_object_mut)
    {
        let prefix = format!("{plugin_id}/");
        let keys_to_remove: Vec<String> = plugin_secrets
            .keys()
            .filter(|key| *key == plugin_id || key.starts_with(&prefix))
            .cloned()
            .collect();
        for key in keys_to_remove {
            plugin_secrets.remove(&key);
        }
        if plugin_secrets.is_empty() {
            secure_storage
                .as_object_mut()
                .expect("secure storage is an object")
                .remove("pluginSecrets");
        }
    }

    write_json_object(&user_settings_path(), &settings)?;
    write_secure_storage_object(&secure_storage)?;

    Ok(())
}

pub fn enabled_plugin_install_paths(project_path: Option<&Path>) -> Vec<PathBuf> {
    let installed = load_installed_plugins_file();
    let docs = load_settings_docs(project_path);
    let mut roots = Vec::new();

    for (plugin_id, installs) in installed.plugins {
        if !effective_plugin_enabled(&docs, &plugin_id) {
            continue;
        }
        if let Some(install) = select_installation(&installs, project_path) {
            roots.push(PathBuf::from(&install.install_path));
        }
    }

    roots.sort();
    roots.dedup();
    roots
}

fn enrich_installed_plugin(
    entry: CliInstalledPluginEntry,
    latest_known_version: Option<String>,
) -> InstalledPlugin {
    let install_path = entry.install_path.clone();
    let (parsed_name, marketplace) = parse_plugin_id(&entry.id);
    let manifest = load_plugin_manifest(Path::new(&install_path));
    let name = manifest
        .as_ref()
        .and_then(|manifest| manifest.name.clone())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or(parsed_name);
    let version = if entry.version.trim().is_empty() {
        manifest
            .as_ref()
            .and_then(|manifest| manifest.version.clone())
            .filter(|version| !version.trim().is_empty())
            .unwrap_or_default()
    } else {
        entry.version.clone()
    };

    let description = manifest
        .as_ref()
        .and_then(|manifest| manifest.description.clone());
    let user_config_schema = manifest
        .as_ref()
        .map(|manifest| manifest.user_config.clone())
        .unwrap_or_default();
    let channels = manifest
        .as_ref()
        .map(|manifest| {
            manifest
                .channels
                .iter()
                .map(|channel| PluginChannelSummary {
                    config_schema: channel.user_config.clone(),
                    display_name: channel.display_name.clone(),
                    server: channel.server.clone(),
                })
                .collect()
        })
        .unwrap_or_default();
    let update_available = latest_known_version
        .as_deref()
        .is_some_and(|latest| version_is_newer(&version, latest));

    InstalledPlugin {
        channels,
        command_count: count_markdown_commands(Path::new(&entry.install_path).join("commands")),
        description,
        enabled: entry.enabled,
        install_path,
        installed_at: entry.installed_at,
        last_updated: entry.last_updated,
        latest_known_version,
        marketplace,
        mcp_servers: entry.mcp_servers.into_keys().collect(),
        name,
        plugin_id: entry.id,
        scope: entry.scope,
        skill_count: count_skills(Path::new(&entry.install_path).join("skills")),
        user_config_schema,
        update_available,
        version,
    }
}

fn build_available_plugins(
    installed: &[InstalledPlugin],
    marketplace_plugins: Vec<MarketplacePluginRecord>,
) -> Vec<AvailablePlugin> {
    let mut installed_by_id: BTreeMap<&str, Vec<&InstalledPlugin>> = BTreeMap::new();
    for plugin in installed {
        installed_by_id
            .entry(plugin.plugin_id.as_str())
            .or_default()
            .push(plugin);
    }

    let mut available: Vec<AvailablePlugin> = marketplace_plugins
        .into_iter()
        .map(|plugin| {
            let installed_entries = installed_by_id
                .get(plugin.plugin_id.as_str())
                .cloned()
                .unwrap_or_default();
            let preferred_install = installed_entries
                .iter()
                .min_by_key(|entry| entry.scope.precedence())
                .copied();
            let mut installed_scopes: Vec<PluginScope> =
                installed_entries.iter().map(|entry| entry.scope).collect();
            installed_scopes.sort_by_key(|scope| scope.precedence());
            installed_scopes.dedup();

            let mut enabled_scopes: Vec<PluginScope> = installed_entries
                .iter()
                .filter(|entry| entry.enabled)
                .map(|entry| entry.scope)
                .collect();
            enabled_scopes.sort_by_key(|scope| scope.precedence());
            enabled_scopes.dedup();

            AvailablePlugin {
                category: plugin.category,
                current_version: preferred_install.map(|entry| entry.version.clone()),
                description: plugin.description,
                enabled: !enabled_scopes.is_empty(),
                enabled_scopes,
                homepage: plugin.homepage,
                install_count: plugin.install_count,
                installed: !installed_entries.is_empty(),
                installed_scopes,
                marketplace: plugin.marketplace,
                name: plugin.name,
                plugin_id: plugin.plugin_id,
                source_label: plugin.source_label,
                update_available: installed_entries.iter().any(|entry| entry.update_available),
                version: plugin.version,
            }
        })
        .collect();

    available.sort_by(|a, b| {
        a.marketplace
            .cmp(&b.marketplace)
            .then_with(|| a.name.cmp(&b.name))
    });
    available
}

fn load_marketplace_plugin_records(
    marketplaces: &[PluginMarketplace],
) -> Vec<MarketplacePluginRecord> {
    let mut records = Vec::new();

    for marketplace in marketplaces {
        let Some(manifest) =
            load_marketplace_manifest(&marketplace.name, marketplace.install_location.as_deref())
        else {
            continue;
        };

        for plugin in manifest.plugins {
            records.push(MarketplacePluginRecord {
                category: plugin.category,
                description: plugin.description,
                homepage: plugin.homepage,
                install_count: plugin.install_count,
                marketplace: marketplace.name.clone(),
                name: plugin.name.clone(),
                plugin_id: format!("{}@{}", plugin.name, marketplace.name),
                source_label: marketplace_plugin_source_label(plugin.source.as_ref()),
                version: normalize_known_version(plugin.version.as_deref()),
            });
        }
    }

    records
}

fn load_cached_marketplace_version_index() -> BTreeMap<String, String> {
    let marketplaces_dir = plugins_root().join("marketplaces");
    let Ok(entries) = std::fs::read_dir(marketplaces_dir) else {
        return BTreeMap::new();
    };

    let mut versions = BTreeMap::new();
    for entry in entries.flatten() {
        let marketplace_path = entry.path();
        if !marketplace_path.is_dir() {
            continue;
        }

        let marketplace_name = entry.file_name().to_string_lossy().to_string();
        let Some(manifest) = load_marketplace_manifest(
            &marketplace_name,
            Some(&normalize_path_for_compare(&marketplace_path)),
        ) else {
            continue;
        };

        for plugin in manifest.plugins {
            if let Some(version) = normalize_known_version(plugin.version.as_deref()) {
                versions.insert(format!("{}@{}", plugin.name, marketplace_name), version);
            }
        }
    }

    versions
}

fn load_marketplace_manifest(
    marketplace_name: &str,
    install_location: Option<&str>,
) -> Option<MarketplaceManifestFile> {
    let mut candidates = Vec::new();
    if let Some(install_location) = install_location {
        let install_path = PathBuf::from(install_location);
        candidates.push(install_path.join(".claude-plugin/marketplace.json"));
        candidates.push(install_path.join("marketplace.json"));
    }

    let default_root = plugins_root().join("marketplaces").join(marketplace_name);
    candidates.push(default_root.join(".claude-plugin/marketplace.json"));
    candidates.push(default_root.join("marketplace.json"));

    for candidate in candidates {
        if !candidate.exists() {
            continue;
        }

        let Ok(contents) = std::fs::read_to_string(&candidate) else {
            continue;
        };
        if let Ok(manifest) = serde_json::from_str::<MarketplaceManifestFile>(&contents) {
            return Some(manifest);
        }
    }

    None
}

fn normalize_known_version(version: Option<&str>) -> Option<String> {
    let version = version?.trim();
    if version.is_empty()
        || version.eq_ignore_ascii_case("unknown")
        || version.eq_ignore_ascii_case("latest")
    {
        None
    } else {
        Some(version.to_string())
    }
}

fn marketplace_plugin_source_label(source: Option<&Value>) -> String {
    match source {
        Some(Value::String(path)) if !path.trim().is_empty() => path.clone(),
        Some(Value::Object(source)) => {
            let url = source
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let path = source
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !url.is_empty() && !path.is_empty() {
                format!("{url} ({path})")
            } else if !url.is_empty() {
                url.to_string()
            } else if !path.is_empty() {
                path.to_string()
            } else {
                source
                    .get("source")
                    .and_then(Value::as_str)
                    .unwrap_or("Marketplace entry")
                    .to_string()
            }
        }
        _ => "Marketplace entry".to_string(),
    }
}

fn version_is_newer(current: &str, candidate: &str) -> bool {
    matches!(
        compare_known_versions(current, candidate),
        Some(Ordering::Less)
    )
}

fn compare_known_versions(current: &str, candidate: &str) -> Option<Ordering> {
    let current_parts = parse_comparable_version(current)?;
    let candidate_parts = parse_comparable_version(candidate)?;
    let len = current_parts.len().max(candidate_parts.len());

    for index in 0..len {
        let current = *current_parts.get(index).unwrap_or(&0);
        let candidate = *candidate_parts.get(index).unwrap_or(&0);
        match current.cmp(&candidate) {
            Ordering::Equal => continue,
            other => return Some(other),
        }
    }

    Some(Ordering::Equal)
}

fn parse_comparable_version(version: &str) -> Option<Vec<u64>> {
    let version = normalize_known_version(Some(version))?;
    let version = version.strip_prefix('v').unwrap_or(&version);
    let buildless = version.split_once('+').map_or(version, |(left, _)| left);
    let core = buildless
        .split_once('-')
        .map_or(buildless, |(left, _)| left);
    let mut parts = Vec::new();
    for segment in core.split('.') {
        if segment.is_empty() || !segment.chars().all(|ch| ch.is_ascii_digit()) {
            return None;
        }
        parts.push(segment.parse::<u64>().ok()?);
    }
    if parts.is_empty() { None } else { Some(parts) }
}

fn build_config_state(
    schema: &BTreeMap<String, PluginConfigField>,
    plain_values: Option<&Map<String, Value>>,
    secret_values: Option<&Map<String, Value>>,
) -> PluginConfigState {
    let mut values = BTreeMap::new();
    let mut saved_sensitive_keys = Vec::new();

    for (key, field) in schema {
        if field.sensitive {
            let has_secret = secret_values.is_some_and(|secrets| secrets.contains_key(key))
                || plain_values.is_some_and(|plain| plain.contains_key(key));
            if has_secret {
                saved_sensitive_keys.push(key.clone());
            }
            continue;
        }

        if let Some(value) = plain_values.and_then(|plain| plain.get(key)).cloned() {
            values.insert(key.clone(), value);
        } else if let Some(default_value) = field.default_value.clone() {
            values.insert(key.clone(), default_value);
        }
    }

    PluginConfigState {
        saved_sensitive_keys,
        values,
    }
}

fn write_config_values(
    plugin_id: &str,
    server_name: Option<&str>,
    schema: &BTreeMap<String, PluginConfigField>,
    submitted_values: BTreeMap<String, Value>,
) -> Result<(), String> {
    let mut settings = read_json_object(&user_settings_path())?;
    let mut secure_storage = read_secure_storage_object()?;

    let current_plain = current_plain_values(&settings, plugin_id, server_name);
    let current_secrets = current_secret_values(&secure_storage, plugin_id, server_name);
    let current_merged =
        merged_current_values(schema, current_plain.as_ref(), current_secrets.as_ref());
    let normalized_values = normalize_submission(schema, &current_merged, submitted_values)?;

    let settings_root = settings
        .as_object_mut()
        .ok_or("User settings must be a JSON object")?;
    let secure_root = secure_storage
        .as_object_mut()
        .ok_or("Secure storage must be a JSON object")?;

    let plugin_configs = ensure_object(settings_root, "pluginConfigs");
    let plugin_config = ensure_object(plugin_configs, plugin_id);

    let plain_bucket = if let Some(server_name) = server_name {
        let mcp_servers = ensure_object(plugin_config, "mcpServers");
        ensure_object(mcp_servers, server_name)
    } else {
        ensure_object(plugin_config, "options")
    };

    let plugin_secrets_root = ensure_object(secure_root, "pluginSecrets");
    let secret_key = server_name
        .map(|server_name| channel_secret_key(plugin_id, server_name))
        .unwrap_or_else(|| plugin_id.to_string());
    let secret_bucket = ensure_object(plugin_secrets_root, &secret_key);

    for (key, value) in normalized_values {
        let field = schema
            .get(&key)
            .ok_or_else(|| format!("Unknown configuration key `{key}`"))?;

        if field.sensitive {
            plain_bucket.remove(&key);
            secret_bucket.insert(key, Value::String(secret_value_string(&value)));
        } else {
            plain_bucket.insert(key.clone(), value);
            secret_bucket.remove(&key);
        }
    }

    prune_plugin_config_tree(settings_root, plugin_id, server_name);
    prune_secret_tree(secure_root, &secret_key);

    write_json_object(&user_settings_path(), &settings)?;
    write_secure_storage_object(&secure_storage)?;

    Ok(())
}

fn normalize_submission(
    schema: &BTreeMap<String, PluginConfigField>,
    current_values: &BTreeMap<String, Value>,
    submitted_values: BTreeMap<String, Value>,
) -> Result<BTreeMap<String, Value>, String> {
    let mut normalized = BTreeMap::new();

    for (key, value) in submitted_values {
        let field = schema
            .get(&key)
            .ok_or_else(|| format!("Unknown configuration key `{key}`"))?;
        normalized.insert(key, normalize_field_value(field, &value)?);
    }

    for (key, field) in schema {
        let candidate = normalized
            .get(key)
            .or_else(|| current_values.get(key))
            .or(field.default_value.as_ref());
        if field.required && candidate.is_none_or(is_empty_value) {
            return Err(format!("`{}` is required", field.title));
        }
    }

    Ok(normalized)
}

fn normalize_field_value(field: &PluginConfigField, value: &Value) -> Result<Value, String> {
    match field.field_type.as_str() {
        "string" | "directory" | "file" => {
            if field.multiple {
                let Some(items) = value.as_array() else {
                    return Err(format!("`{}` must be a list of strings", field.title));
                };
                if items.iter().any(|item| item.as_str().is_none()) {
                    return Err(format!("`{}` must be a list of strings", field.title));
                }
                Ok(Value::Array(items.clone()))
            } else {
                let Some(text) = value.as_str() else {
                    return Err(format!("`{}` must be a string", field.title));
                };
                Ok(Value::String(text.to_string()))
            }
        }
        "number" => {
            let number = if let Some(number) = value.as_f64() {
                number
            } else if let Some(text) = value.as_str() {
                text.parse::<f64>()
                    .map_err(|_| format!("`{}` must be a number", field.title))?
            } else {
                return Err(format!("`{}` must be a number", field.title));
            };

            if let Some(min) = field.min
                && number < min
            {
                return Err(format!("`{}` must be at least {min}", field.title));
            }
            if let Some(max) = field.max
                && number > max
            {
                return Err(format!("`{}` must be at most {max}", field.title));
            }

            serde_json::Number::from_f64(number)
                .map(Value::Number)
                .ok_or_else(|| format!("`{}` must be a finite number", field.title))
        }
        "boolean" => {
            if let Some(flag) = value.as_bool() {
                Ok(Value::Bool(flag))
            } else if let Some(text) = value.as_str() {
                match text.trim().to_ascii_lowercase().as_str() {
                    "1" | "true" | "yes" | "on" => Ok(Value::Bool(true)),
                    "0" | "false" | "no" | "off" => Ok(Value::Bool(false)),
                    _ => Err(format!("`{}` must be true or false", field.title)),
                }
            } else {
                Err(format!("`{}` must be true or false", field.title))
            }
        }
        other => Err(format!(
            "Unsupported configuration field type `{other}` for `{}`",
            field.title
        )),
    }
}

fn current_plain_values(
    settings: &Value,
    plugin_id: &str,
    server_name: Option<&str>,
) -> Option<Map<String, Value>> {
    let plugin_config = settings
        .get("pluginConfigs")
        .and_then(Value::as_object)
        .and_then(|configs| configs.get(plugin_id))
        .and_then(Value::as_object)?;

    let value = if let Some(server_name) = server_name {
        plugin_config
            .get("mcpServers")
            .and_then(Value::as_object)
            .and_then(|servers| servers.get(server_name))
    } else {
        plugin_config.get("options")
    }?;

    value.as_object().cloned()
}

fn current_secret_values(
    secure_storage: &Value,
    plugin_id: &str,
    server_name: Option<&str>,
) -> Option<Map<String, Value>> {
    let key = server_name
        .map(|server_name| channel_secret_key(plugin_id, server_name))
        .unwrap_or_else(|| plugin_id.to_string());
    secure_storage
        .get("pluginSecrets")
        .and_then(Value::as_object)
        .and_then(|secrets| secrets.get(&key))
        .and_then(Value::as_object)
        .cloned()
}

fn merged_current_values(
    schema: &BTreeMap<String, PluginConfigField>,
    plain_values: Option<&Map<String, Value>>,
    secret_values: Option<&Map<String, Value>>,
) -> BTreeMap<String, Value> {
    let mut merged = BTreeMap::new();

    for (key, field) in schema {
        if field.sensitive {
            if let Some(value) = secret_values.and_then(|secrets| secrets.get(key)).cloned() {
                merged.insert(key.clone(), value);
            }
        } else if let Some(value) = plain_values.and_then(|plain| plain.get(key)).cloned() {
            merged.insert(key.clone(), value);
        }
    }

    merged
}

fn prune_plugin_config_tree(
    settings_root: &mut Map<String, Value>,
    plugin_id: &str,
    server_name: Option<&str>,
) {
    let Some(plugin_configs) = settings_root
        .get_mut("pluginConfigs")
        .and_then(Value::as_object_mut)
    else {
        return;
    };
    let Some(plugin_config) = plugin_configs
        .get_mut(plugin_id)
        .and_then(Value::as_object_mut)
    else {
        return;
    };

    if let Some(server_name) = server_name {
        if let Some(mcp_servers) = plugin_config
            .get_mut("mcpServers")
            .and_then(Value::as_object_mut)
        {
            if mcp_servers
                .get(server_name)
                .and_then(Value::as_object)
                .is_some_and(|map| map.is_empty())
            {
                mcp_servers.remove(server_name);
            }
            if mcp_servers.is_empty() {
                plugin_config.remove("mcpServers");
            }
        }
    } else if plugin_config
        .get("options")
        .and_then(Value::as_object)
        .is_some_and(|map| map.is_empty())
    {
        plugin_config.remove("options");
    }

    if plugin_config.is_empty() {
        plugin_configs.remove(plugin_id);
    }
    if plugin_configs.is_empty() {
        settings_root.remove("pluginConfigs");
    }
}

fn prune_secret_tree(secure_root: &mut Map<String, Value>, secret_key: &str) {
    let Some(plugin_secrets) = secure_root
        .get_mut("pluginSecrets")
        .and_then(Value::as_object_mut)
    else {
        return;
    };

    if plugin_secrets
        .get(secret_key)
        .and_then(Value::as_object)
        .is_some_and(|map| map.is_empty())
    {
        plugin_secrets.remove(secret_key);
    }
    if plugin_secrets.is_empty() {
        secure_root.remove("pluginSecrets");
    }
}

fn ensure_object<'a>(map: &'a mut Map<String, Value>, key: &str) -> &'a mut Map<String, Value> {
    if !map.get(key).is_some_and(Value::is_object) {
        map.insert(key.to_string(), Value::Object(Map::new()));
    }
    map.get_mut(key)
        .and_then(Value::as_object_mut)
        .expect("value was just initialized as object")
}

fn read_json_object(path: &Path) -> Result<Value, String> {
    match std::fs::read_to_string(path) {
        Ok(contents) => serde_json::from_str::<Value>(&contents)
            .map_err(|e| format!("Failed to parse {}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Object(Map::new())),
        Err(e) => Err(format!("Failed to read {}: {e}", path.display())),
    }
}

fn write_json_object(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }

    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|e| format!("Failed to serialize {}: {e}", path.display()))?;
    std::fs::write(path, bytes).map_err(|e| format!("Failed to write {}: {e}", path.display()))
}

fn read_secure_storage_object() -> Result<Value, String> {
    if let Some(path) = secure_storage_file_override() {
        return read_json_object(&path);
    }

    #[cfg(target_os = "macos")]
    {
        let account = std::env::var("USER").unwrap_or_else(|_| "root".to_string());
        let output = std::process::Command::new("security")
            .no_console_window()
            .args([
                "find-generic-password",
                "-s",
                "Claude Code-credentials",
                "-a",
                &account,
                "-w",
            ])
            .output()
            .map_err(|e| format!("Failed to run security command: {e}"))?;

        if output.status.success() {
            let stdout = String::from_utf8(output.stdout)
                .map_err(|e| format!("Invalid UTF-8 in keychain payload: {e}"))?;
            return serde_json::from_str::<Value>(&stdout)
                .map_err(|e| format!("Failed to parse Claude Code keychain payload: {e}"));
        }

        Ok(Value::Object(Map::new()))
    }

    #[cfg(not(target_os = "macos"))]
    {
        let path = claude_config_home_dir().join(".credentials.json");
        read_json_object(&path)
    }
}

fn write_secure_storage_object(value: &Value) -> Result<(), String> {
    if let Some(path) = secure_storage_file_override() {
        return write_json_object(&path, value);
    }

    #[cfg(target_os = "macos")]
    {
        let account = std::env::var("USER").unwrap_or_else(|_| "root".to_string());
        let json = serde_json::to_string(value)
            .map_err(|e| format!("Failed to serialize keychain payload: {e}"))?;
        let output = std::process::Command::new("security")
            .no_console_window()
            .args([
                "add-generic-password",
                "-U",
                "-a",
                &account,
                "-s",
                "Claude Code-credentials",
                "-w",
                &json,
            ])
            .output()
            .map_err(|e| format!("Failed to update Claude Code keychain entry: {e}"))?;

        if output.status.success() {
            return Ok(());
        }

        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let path = claude_config_home_dir().join(".credentials.json");
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
        }

        let bytes = serde_json::to_vec_pretty(value)
            .map_err(|e| format!("Failed to serialize {}: {e}", path.display()))?;
        std::fs::write(&path, bytes)
            .map_err(|e| format!("Failed to write {}: {e}", path.display()))?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let mut permissions = std::fs::metadata(&path)
                .map_err(|e| format!("Failed to read {} metadata: {e}", path.display()))?
                .permissions();
            permissions.set_mode(0o600);
            std::fs::set_permissions(&path, permissions)
                .map_err(|e| format!("Failed to chmod {}: {e}", path.display()))?;
        }

        Ok(())
    }
}

fn load_settings_docs(repo_path: Option<&Path>) -> SettingsDocs {
    let user =
        read_json_object(&user_settings_path()).unwrap_or_else(|_| Value::Object(Map::new()));
    let project = repo_path
        .map(|repo_path| {
            read_json_object(&repo_path.join(".claude/settings.json"))
                .unwrap_or_else(|_| Value::Object(Map::new()))
        })
        .unwrap_or_else(|| Value::Object(Map::new()));
    let local = repo_path
        .map(|repo_path| {
            read_json_object(&repo_path.join(".claude/settings.local.json"))
                .unwrap_or_else(|_| Value::Object(Map::new()))
        })
        .unwrap_or_else(|| Value::Object(Map::new()));

    SettingsDocs {
        user,
        project,
        local,
    }
}

fn effective_plugin_enabled(docs: &SettingsDocs, plugin_id: &str) -> bool {
    plugin_enabled_at(&docs.local, plugin_id)
        .or_else(|| plugin_enabled_at(&docs.project, plugin_id))
        .or_else(|| plugin_enabled_at(&docs.user, plugin_id))
        .unwrap_or(false)
}

fn plugin_enabled_at(doc: &Value, plugin_id: &str) -> Option<bool> {
    doc.get("enabledPlugins")
        .and_then(Value::as_object)
        .and_then(|plugins| plugins.get(plugin_id))
        .map(|value| value.as_bool() == Some(true))
}

fn declared_marketplace_scope(docs: &SettingsDocs, name: &str) -> Option<PluginScope> {
    if has_marketplace_decl(docs.local.as_object(), name) {
        Some(PluginScope::Local)
    } else if has_marketplace_decl(docs.project.as_object(), name) {
        Some(PluginScope::Project)
    } else if has_marketplace_decl(docs.user.as_object(), name) {
        Some(PluginScope::User)
    } else {
        None
    }
}

fn has_marketplace_decl(doc: Option<&Map<String, Value>>, name: &str) -> bool {
    doc.and_then(|doc| doc.get("extraKnownMarketplaces"))
        .and_then(Value::as_object)
        .is_some_and(|marketplaces| marketplaces.contains_key(name))
}

fn load_installed_plugins_file() -> InstalledPluginsFile {
    let path = plugins_root().join("installed_plugins.json");
    let Ok(contents) = std::fs::read_to_string(path) else {
        return InstalledPluginsFile {
            plugins: BTreeMap::new(),
            version: None,
        };
    };

    serde_json::from_str::<InstalledPluginsFile>(&contents).unwrap_or(InstalledPluginsFile {
        plugins: BTreeMap::new(),
        version: None,
    })
}

fn resolve_active_installation(
    plugin_id: &str,
    repo_path: Option<&Path>,
) -> Option<InstalledPluginEntry> {
    let installed = load_installed_plugins_file();
    installed
        .plugins
        .get(plugin_id)
        .and_then(|installs| select_installation(installs, repo_path).cloned())
}

fn select_installation<'a>(
    installs: &'a [InstalledPluginEntry],
    repo_path: Option<&Path>,
) -> Option<&'a InstalledPluginEntry> {
    let repo_path = repo_path.map(normalize_path_for_compare);
    installs
        .iter()
        .filter(|install| match install.scope {
            PluginScope::Managed | PluginScope::User => true,
            PluginScope::Project | PluginScope::Local => repo_path
                .as_ref()
                .zip(install.project_path.as_ref())
                .is_some_and(|(repo_path, project_path)| repo_path == project_path),
        })
        .min_by_key(|install| install.scope.precedence())
}

pub(crate) fn plugin_manifest_candidate_paths(install_path: &Path) -> [PathBuf; 2] {
    [
        install_path.join(".claude-plugin/plugin.json"),
        install_path.join("plugin.json"),
    ]
}

fn load_plugin_manifest(install_path: &Path) -> Option<PluginManifestFile> {
    for path in plugin_manifest_candidate_paths(install_path) {
        if let Ok(contents) = std::fs::read_to_string(&path)
            && let Ok(manifest) = serde_json::from_str::<PluginManifestFile>(&contents)
        {
            return Some(manifest);
        }
    }

    None
}

fn count_markdown_commands(path: PathBuf) -> usize {
    std::fs::read_dir(path)
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "md"))
                .count()
        })
        .unwrap_or(0)
}

fn count_skills(path: PathBuf) -> usize {
    std::fs::read_dir(path)
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| entry.path().join("SKILL.md").is_file())
                .count()
        })
        .unwrap_or(0)
}

fn parse_plugin_id(plugin_id: &str) -> (String, Option<String>) {
    if let Some((name, marketplace)) = plugin_id.split_once('@') {
        (name.to_string(), Some(marketplace.to_string()))
    } else {
        (plugin_id.to_string(), None)
    }
}

fn marketplace_source_label(entry: &CliMarketplaceEntry) -> String {
    if let Some(repo) = &entry.repo {
        repo.clone()
    } else if let Some(url) = &entry.url {
        url.clone()
    } else if let Some(path) = &entry.path {
        path.clone()
    } else {
        entry.source.clone()
    }
}

fn plugin_command_cwd(repo_path: Option<&Path>) -> PathBuf {
    let candidate = repo_path
        .map(Path::to_path_buf)
        .unwrap_or_else(claude_config_home_dir);
    if candidate.exists() {
        candidate
    } else if let Some(home) = dirs::home_dir() {
        home
    } else {
        PathBuf::from(".")
    }
}

fn command_preview(args: &[String]) -> String {
    std::iter::once("claude".to_string())
        .chain(args.iter().cloned())
        .collect::<Vec<_>>()
        .join(" ")
}

fn secret_value_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        Value::Array(items) => items
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join("\n"),
        other => other.to_string(),
    }
}

fn channel_secret_key(plugin_id: &str, server_name: &str) -> String {
    format!("{plugin_id}/{server_name}")
}

fn is_empty_value(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::String(text) => text.trim().is_empty(),
        Value::Array(items) => items.is_empty(),
        _ => false,
    }
}

fn user_settings_path() -> PathBuf {
    claude_config_home_dir().join("settings.json")
}

fn plugins_root() -> PathBuf {
    if let Some(override_dir) = std::env::var_os("CLAUDE_CODE_PLUGIN_CACHE_DIR") {
        PathBuf::from(override_dir)
    } else {
        claude_config_home_dir().join("plugins")
    }
}

fn claude_config_home_dir() -> PathBuf {
    if let Some(override_dir) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        PathBuf::from(override_dir)
    } else {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".claude")
    }
}

fn secure_storage_file_override() -> Option<PathBuf> {
    std::env::var_os("CLAUDE_TEST_CREDENTIALS_FILE").map(PathBuf::from)
}

fn normalize_path_for_compare(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{ffi::OsString, sync::Mutex};

    /// Serialize the few tests that override Claude-specific env vars so they
    /// never leak into one another.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct ClaudeEnvGuard {
        claude_config_dir: Option<OsString>,
        credentials_file: Option<OsString>,
    }

    impl ClaudeEnvGuard {
        fn override_with(
            claude_config_dir: Option<&Path>,
            credentials_file: Option<&Path>,
        ) -> Self {
            let guard = Self {
                claude_config_dir: std::env::var_os("CLAUDE_CONFIG_DIR"),
                credentials_file: std::env::var_os("CLAUDE_TEST_CREDENTIALS_FILE"),
            };
            match claude_config_dir {
                Some(path) => unsafe { std::env::set_var("CLAUDE_CONFIG_DIR", path) },
                None => unsafe { std::env::remove_var("CLAUDE_CONFIG_DIR") },
            }
            match credentials_file {
                Some(path) => unsafe { std::env::set_var("CLAUDE_TEST_CREDENTIALS_FILE", path) },
                None => unsafe { std::env::remove_var("CLAUDE_TEST_CREDENTIALS_FILE") },
            }
            guard
        }
    }

    impl Drop for ClaudeEnvGuard {
        fn drop(&mut self) {
            match &self.claude_config_dir {
                Some(value) => unsafe { std::env::set_var("CLAUDE_CONFIG_DIR", value) },
                None => unsafe { std::env::remove_var("CLAUDE_CONFIG_DIR") },
            }
            match &self.credentials_file {
                Some(value) => unsafe { std::env::set_var("CLAUDE_TEST_CREDENTIALS_FILE", value) },
                None => unsafe { std::env::remove_var("CLAUDE_TEST_CREDENTIALS_FILE") },
            }
        }
    }

    #[test]
    fn effective_plugin_enabled_prefers_more_specific_sources() {
        let docs = SettingsDocs {
            local: serde_json::json!({
                "enabledPlugins": { "plugin@market": false }
            }),
            project: serde_json::json!({
                "enabledPlugins": { "plugin@market": true }
            }),
            user: serde_json::json!({
                "enabledPlugins": { "plugin@market": true }
            }),
        };

        assert!(!effective_plugin_enabled(&docs, "plugin@market"));
    }

    #[test]
    fn select_installation_prefers_local_then_project_then_user() {
        let repo = Path::new("/tmp/repo");
        let installs = vec![
            InstalledPluginEntry {
                install_path: "/user".into(),
                project_path: None,
                scope: PluginScope::User,
            },
            InstalledPluginEntry {
                install_path: "/project".into(),
                project_path: Some("/tmp/repo".into()),
                scope: PluginScope::Project,
            },
            InstalledPluginEntry {
                install_path: "/local".into(),
                project_path: Some("/tmp/repo".into()),
                scope: PluginScope::Local,
            },
        ];

        let selected = select_installation(&installs, Some(repo)).unwrap();
        assert_eq!(selected.install_path, "/local");
    }

    #[test]
    fn build_config_state_omits_sensitive_values_but_tracks_presence() {
        let mut schema = BTreeMap::new();
        schema.insert(
            "token".to_string(),
            PluginConfigField {
                default_value: None,
                description: "Token".into(),
                field_type: "string".into(),
                max: None,
                min: None,
                multiple: false,
                required: true,
                sensitive: true,
                title: "Token".into(),
            },
        );
        schema.insert(
            "channel".to_string(),
            PluginConfigField {
                default_value: Some(Value::String("general".into())),
                description: "Channel".into(),
                field_type: "string".into(),
                max: None,
                min: None,
                multiple: false,
                required: false,
                sensitive: false,
                title: "Channel".into(),
            },
        );

        let plain = serde_json::json!({ "token": "secret", "channel": "ops" });
        let state = build_config_state(&schema, plain.as_object(), None);
        assert_eq!(state.saved_sensitive_keys, vec!["token".to_string()]);
        assert_eq!(
            state.values.get("channel"),
            Some(&Value::String("ops".to_string()))
        );
        assert!(!state.values.contains_key("token"));
    }

    #[test]
    fn normalize_submission_preserves_existing_required_sensitive_values() {
        let mut schema = BTreeMap::new();
        schema.insert(
            "token".to_string(),
            PluginConfigField {
                default_value: None,
                description: "Token".into(),
                field_type: "string".into(),
                max: None,
                min: None,
                multiple: false,
                required: true,
                sensitive: true,
                title: "Token".into(),
            },
        );

        let mut current = BTreeMap::new();
        current.insert("token".to_string(), Value::String("stored".into()));
        let normalized = normalize_submission(&schema, &current, BTreeMap::new()).unwrap();
        assert!(normalized.is_empty());
    }

    #[test]
    fn compare_known_versions_handles_basic_semver() {
        assert_eq!(
            compare_known_versions("1.2.3", "1.3.0"),
            Some(Ordering::Less)
        );
        assert_eq!(
            compare_known_versions("1.2.3", "1.2.3"),
            Some(Ordering::Equal)
        );
        assert_eq!(
            compare_known_versions("v2.0.0", "1.9.9"),
            Some(Ordering::Greater)
        );
        assert_eq!(compare_known_versions("unknown", "1.0.0"), None);
        assert_eq!(compare_known_versions("1.0.0", "main"), None);
    }

    #[test]
    fn build_available_plugins_marks_installed_status_and_updates() {
        let installed = vec![
            InstalledPlugin {
                channels: Vec::new(),
                command_count: 0,
                description: Some("Demo".into()),
                enabled: true,
                install_path: "/tmp/demo".into(),
                installed_at: None,
                last_updated: None,
                latest_known_version: Some("1.2.0".into()),
                marketplace: Some("official".into()),
                mcp_servers: Vec::new(),
                name: "demo".into(),
                plugin_id: "demo@official".into(),
                scope: PluginScope::User,
                skill_count: 0,
                update_available: true,
                user_config_schema: BTreeMap::new(),
                version: "1.0.0".into(),
            },
            InstalledPlugin {
                channels: Vec::new(),
                command_count: 0,
                description: Some("Utility".into()),
                enabled: false,
                install_path: "/tmp/utility".into(),
                installed_at: None,
                last_updated: None,
                latest_known_version: None,
                marketplace: Some("official".into()),
                mcp_servers: Vec::new(),
                name: "utility".into(),
                plugin_id: "utility@official".into(),
                scope: PluginScope::Project,
                skill_count: 0,
                update_available: false,
                user_config_schema: BTreeMap::new(),
                version: "0.9.0".into(),
            },
        ];
        let available = build_available_plugins(
            &installed,
            vec![
                MarketplacePluginRecord {
                    category: Some("development".into()),
                    description: Some("Demo".into()),
                    homepage: None,
                    install_count: Some(42),
                    marketplace: "official".into(),
                    name: "demo".into(),
                    plugin_id: "demo@official".into(),
                    source_label: "https://example.com/demo".into(),
                    version: Some("1.2.0".into()),
                },
                MarketplacePluginRecord {
                    category: Some("quality".into()),
                    description: Some("Fresh".into()),
                    homepage: None,
                    install_count: Some(7),
                    marketplace: "official".into(),
                    name: "fresh".into(),
                    plugin_id: "fresh@official".into(),
                    source_label: "https://example.com/fresh".into(),
                    version: Some("0.1.0".into()),
                },
            ],
        );

        assert_eq!(available.len(), 2);
        assert_eq!(available[0].plugin_id, "demo@official");
        assert!(available[0].installed);
        assert!(available[0].enabled);
        assert!(available[0].update_available);
        assert_eq!(available[0].current_version.as_deref(), Some("1.0.0"));
        assert_eq!(available[0].installed_scopes, vec![PluginScope::User]);
        assert_eq!(available[1].plugin_id, "fresh@official");
        assert!(!available[1].installed);
        assert!(!available[1].update_available);
    }

    #[test]
    fn enabled_plugin_install_paths_reads_fixture_state() {
        let _guard = ENV_LOCK.lock().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let claude_dir = temp.path().join(".claude");
        let plugins_dir = claude_dir.join("plugins");
        std::fs::create_dir_all(&plugins_dir).unwrap();
        std::fs::write(
            claude_dir.join("settings.json"),
            serde_json::json!({
                "enabledPlugins": {
                    "demo@market": true
                }
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            plugins_dir.join("installed_plugins.json"),
            serde_json::json!({
                "version": 2,
                "plugins": {
                    "demo@market": [
                        {
                            "scope": "user",
                            "installPath": "/tmp/demo"
                        }
                    ]
                }
            })
            .to_string(),
        )
        .unwrap();

        let _env = ClaudeEnvGuard::override_with(Some(&claude_dir), None);
        let paths = enabled_plugin_install_paths(None);

        assert_eq!(paths, vec![PathBuf::from("/tmp/demo")]);
    }

    #[test]
    fn cleanup_plugin_configuration_if_not_installed_removes_settings_and_secrets() {
        let _guard = ENV_LOCK.lock().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let claude_dir = temp.path().join(".claude");
        let plugins_dir = claude_dir.join("plugins");
        std::fs::create_dir_all(&plugins_dir).unwrap();
        std::fs::write(
            claude_dir.join("settings.json"),
            serde_json::json!({
                "pluginConfigs": {
                    "demo@market": {
                        "options": { "channel": "ops" }
                    }
                }
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            claude_dir.join(".credentials.json"),
            serde_json::json!({
                "pluginSecrets": {
                    "demo@market": { "token": "secret" },
                    "demo@market/server": { "channelToken": "secret" }
                }
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            plugins_dir.join("installed_plugins.json"),
            serde_json::json!({ "version": 2, "plugins": {} }).to_string(),
        )
        .unwrap();

        let _env = ClaudeEnvGuard::override_with(
            Some(&claude_dir),
            Some(&claude_dir.join(".credentials.json")),
        );
        cleanup_plugin_configuration_if_not_installed("demo@market").unwrap();
        let settings = read_json_object(&claude_dir.join("settings.json")).unwrap();
        let secrets = read_json_object(&claude_dir.join(".credentials.json")).unwrap();

        assert!(settings.get("pluginConfigs").is_none());
        assert!(secrets.get("pluginSecrets").is_none());
    }

    #[test]
    fn load_cached_marketplace_version_index_reads_cached_versions() {
        let _guard = ENV_LOCK.lock().unwrap();
        let temp = tempfile::tempdir().unwrap();
        let claude_dir = temp.path().join(".claude");
        let marketplace_dir = claude_dir.join("plugins/marketplaces/official/.claude-plugin");
        std::fs::create_dir_all(&marketplace_dir).unwrap();
        std::fs::write(
            marketplace_dir.join("marketplace.json"),
            serde_json::json!({
                "plugins": [
                    { "name": "demo", "version": "1.3.0" },
                    { "name": "utility" }
                ]
            })
            .to_string(),
        )
        .unwrap();

        let _env = ClaudeEnvGuard::override_with(Some(&claude_dir), None);
        let versions = load_cached_marketplace_version_index();

        assert_eq!(versions.get("demo@official"), Some(&"1.3.0".to_string()));
        assert!(!versions.contains_key("utility@official"));
    }
}
