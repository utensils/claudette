//! MCP (Model Context Protocol) server detection and serialization.
//!
//! Detects MCP server configurations from all sources:
//!
//! 1. User global MCPs in `~/.claude.json` → `mcpServers`
//! 2. Project-scoped MCPs in `~/.claude.json` → `projects[repo_path].mcpServers`
//! 3. Project committed `.mcp.json` at repo root
//! 4. Gitignored `.claude.json` at repo root
//!
//! Sources 1 and 3 are auto-discovered by the CLI in worktrees, but are
//! detected here for UI display purposes (connectors menu, settings).

use std::path::Path;

use serde::{Deserialize, Serialize};

/// A detected MCP server with its full configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServer {
    /// Server name (key in the mcpServers object).
    pub name: String,
    /// Full server configuration (passed through to --mcp-config).
    pub config: serde_json::Value,
    /// Where this config was found.
    pub source: McpSource,
}

/// Where the MCP server configuration was detected from.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum McpSource {
    /// User-global entry in ~/.claude.json → mcpServers
    UserGlobalConfig,
    /// Project-scoped entry in ~/.claude.json → projects[path].mcpServers
    UserProjectConfig,
    /// Committed .mcp.json at repo root
    ProjectMcpJson,
    /// Gitignored .claude.json at repo root
    RepoLocalConfig,
    /// Claude Code plugin (always available)
    Plugin,
}

/// Detect MCP servers from all configuration sources for the given repository.
///
/// Scans four locations (later sources override earlier ones by name):
/// 1. `~/.claude.json` → `mcpServers` (user global)
/// 2. `~/.claude.json` → `projects[repo_path].mcpServers` (user project-scoped)
/// 3. `{repo_path}/.mcp.json` → `mcpServers` (project committed)
/// 4. `{repo_path}/.claude.json` (only if gitignored)
pub fn detect_mcp_servers(repo_path: &Path) -> Vec<McpServer> {
    let mut by_name = std::collections::HashMap::<String, McpServer>::new();

    // 1. User global MCPs.
    if let Some(servers) = detect_user_global_mcps() {
        for s in servers {
            by_name.insert(s.name.clone(), s);
        }
    }

    // 2. User project-scoped MCPs (override globals by name).
    if let Some(servers) = detect_user_project_mcps(repo_path) {
        for s in servers {
            by_name.insert(s.name.clone(), s);
        }
    }

    // 3. Committed .mcp.json at repo root.
    if let Some(servers) = detect_project_mcp_json(repo_path) {
        for s in servers {
            by_name.insert(s.name.clone(), s);
        }
    }

    // 4. Gitignored .claude.json at repo root.
    if let Some(servers) = detect_repo_local_mcps(repo_path) {
        for s in servers {
            by_name.insert(s.name.clone(), s);
        }
    }

    // 5. Claude Code plugins (always available, don't override explicit configs).
    for s in detect_plugin_mcps() {
        by_name.entry(s.name.clone()).or_insert(s);
    }

    let mut servers: Vec<McpServer> = by_name.into_values().collect();
    servers.sort_by(|a, b| a.name.cmp(&b.name));
    servers
}

/// Serialize selected MCP servers into the JSON format expected by
/// `--mcp-config`.
///
/// Produces: `{"mcpServers":{"name":{...config...}}}`
pub fn serialize_for_cli(servers: &[McpServer]) -> String {
    let mut mcp_servers = serde_json::Map::new();
    for server in servers {
        mcp_servers.insert(server.name.clone(), server.config.clone());
    }
    let wrapper = serde_json::json!({ "mcpServers": mcp_servers });
    wrapper.to_string()
}

/// Convert saved DB rows into `McpServer` structs with their enabled flag.
///
/// Parses `config_json` and `source` from each row. Rows with invalid JSON
/// are silently skipped.
pub fn rows_to_servers(rows: &[crate::db::RepositoryMcpServer]) -> Vec<(McpServer, bool)> {
    rows.iter()
        .filter_map(|row| {
            let config: serde_json::Value = serde_json::from_str(&row.config_json).ok()?;
            let source = match row.source.as_str() {
                "user_global_config" => McpSource::UserGlobalConfig,
                "user_project_config" => McpSource::UserProjectConfig,
                "project_mcp_json" => McpSource::ProjectMcpJson,
                "repo_local_config" => McpSource::RepoLocalConfig,
                "plugin" => McpSource::Plugin,
                _ => McpSource::UserProjectConfig,
            };
            Some((
                McpServer {
                    name: row.name.clone(),
                    config,
                    source,
                },
                row.enabled,
            ))
        })
        .collect()
}

/// Build the `--mcp-config` CLI string from saved DB rows.
///
/// Only includes enabled servers. Returns `None` if no servers qualify.
pub fn cli_config_from_rows(rows: &[crate::db::RepositoryMcpServer]) -> Option<String> {
    let servers: Vec<McpServer> = rows_to_servers(rows)
        .into_iter()
        .filter(|(_, enabled)| *enabled)
        .map(|(s, _)| s)
        .collect();
    if servers.is_empty() {
        None
    } else {
        Some(serialize_for_cli(&servers))
    }
}

/// Read the `disabledMcpServers` list from `~/.claude.json` project config.
///
/// Claude Code stores disabled servers at:
///   `projects[repo_path].disabledMcpServers` as an array of server names.
pub fn get_disabled_servers(repo_path: &Path) -> Vec<String> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let config_path = home.join(".claude.json");
    let Ok(content) = std::fs::read_to_string(&config_path) else {
        return Vec::new();
    };
    let Ok(root) = serde_json::from_str::<serde_json::Value>(&content) else {
        return Vec::new();
    };

    let repo_key = repo_path.to_string_lossy();
    root.get("projects")
        .and_then(|p| p.get(repo_key.as_ref()))
        .and_then(|proj| proj.get("disabledMcpServers"))
        .and_then(|arr| arr.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

/// Set a server's enabled/disabled state in `~/.claude.json` project config.
///
/// Matches Claude Code's behavior: disabled servers are tracked in
/// `projects[repo_path].disabledMcpServers` as an array of names.
pub fn set_server_disabled_in_config(
    repo_path: &Path,
    server_name: &str,
    disabled: bool,
) -> Result<(), String> {
    let home = dirs::home_dir().ok_or("No home directory")?;
    let config_path = home.join(".claude.json");

    let mut root: serde_json::Value = if config_path.exists() {
        let content =
            std::fs::read_to_string(&config_path).map_err(|e| format!("Read error: {e}"))?;
        serde_json::from_str(&content).map_err(|e| format!("Parse error: {e}"))?
    } else {
        serde_json::json!({})
    };

    let repo_key = repo_path.to_string_lossy().to_string();

    // Ensure projects[repo_path] exists.
    if root.get("projects").is_none() {
        root["projects"] = serde_json::json!({});
    }
    if root["projects"].get(&repo_key).is_none() {
        root["projects"][&repo_key] = serde_json::json!({});
    }

    let project = root["projects"][&repo_key]
        .as_object_mut()
        .ok_or("Bad project config")?;

    let mut disabled_list: Vec<String> = project
        .get("disabledMcpServers")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    let already_disabled = disabled_list.contains(&server_name.to_string());

    if disabled && !already_disabled {
        disabled_list.push(server_name.to_string());
    } else if !disabled && already_disabled {
        disabled_list.retain(|n| n != server_name);
    }

    project.insert(
        "disabledMcpServers".to_string(),
        serde_json::json!(disabled_list),
    );

    let json_str =
        serde_json::to_string_pretty(&root).map_err(|e| format!("Serialize error: {e}"))?;

    // Atomic write: write to temp file then rename, so a crash mid-write
    // cannot truncate/corrupt the user's ~/.claude.json.
    // On Windows, std::fs::rename does not overwrite an existing file,
    // so we remove it first.
    let tmp_path = config_path.with_extension("json.tmp");
    std::fs::write(&tmp_path, &json_str).map_err(|e| format!("Write error: {e}"))?;
    #[cfg(windows)]
    if config_path.exists() {
        std::fs::remove_file(&config_path).map_err(|e| format!("Remove error: {e}"))?;
    }
    std::fs::rename(&tmp_path, &config_path).map_err(|e| format!("Rename error: {e}"))?;

    Ok(())
}

/// Normalize an MCP config by ensuring it has a "type" field.
///
/// Claude Code's project-scoped configs don't include "type", but the
/// Claude CLI `--mcp-config` flag requires it. This function adds
/// `"type": "stdio"` if the field is missing.
fn normalize_mcp_config(mut config: serde_json::Value) -> serde_json::Value {
    if let Some(obj) = config.as_object_mut()
        && !obj.contains_key("type")
    {
        obj.insert(
            "type".to_string(),
            serde_json::Value::String("stdio".to_string()),
        );
    }
    config
}

/// Parse user-global MCPs from `~/.claude.json` → `mcpServers`.
fn detect_user_global_mcps() -> Option<Vec<McpServer>> {
    let home = dirs::home_dir()?;
    let config_path = home.join(".claude.json");
    let content = std::fs::read_to_string(&config_path).ok()?;
    let root: serde_json::Value = serde_json::from_str(&content).ok()?;

    let mcp_servers = root.get("mcpServers")?.as_object()?;

    let servers = mcp_servers
        .iter()
        .map(|(name, config)| McpServer {
            name: name.clone(),
            config: normalize_mcp_config(config.clone()),
            source: McpSource::UserGlobalConfig,
        })
        .collect();

    Some(servers)
}

/// Parse committed `.mcp.json` at the repository root.
fn detect_project_mcp_json(repo_path: &Path) -> Option<Vec<McpServer>> {
    let config_path = repo_path.join(".mcp.json");
    let content = std::fs::read_to_string(&config_path).ok()?;
    let root: serde_json::Value = serde_json::from_str(&content).ok()?;
    let mcp_servers = root.get("mcpServers")?.as_object()?;

    let servers = mcp_servers
        .iter()
        .map(|(name, config)| McpServer {
            name: name.clone(),
            config: normalize_mcp_config(config.clone()),
            source: McpSource::ProjectMcpJson,
        })
        .collect();

    Some(servers)
}

/// Detect MCP servers from installed Claude Code plugins.
///
/// Plugins are installed at `~/.claude/plugins/cache/<marketplace>/<name>/<version>/`.
/// Enabled plugins are listed in `~/.claude/settings.json` → `enabledPlugins`.
/// Each plugin may have a `.mcp.json` defining MCP servers.
fn detect_plugin_mcps() -> Vec<McpServer> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let claude_dir = home.join(".claude");

    // Read enabled plugins from settings.json.
    let settings_path = claude_dir.join("settings.json");
    let enabled_plugins: std::collections::HashSet<String> =
        std::fs::read_to_string(&settings_path)
            .ok()
            .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
            .and_then(|root| {
                root.get("enabledPlugins")?.as_object().map(|obj| {
                    obj.iter()
                        .filter(|(_, v)| v.as_bool() == Some(true))
                        .map(|(k, _)| k.clone())
                        .collect()
                })
            })
            .unwrap_or_default();

    // Read installed plugins manifest.
    let installed_path = claude_dir.join("plugins").join("installed_plugins.json");
    let installed: serde_json::Value = std::fs::read_to_string(&installed_path)
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default();

    let mut servers = Vec::new();

    let Some(plugins) = installed.get("plugins").and_then(|p| p.as_object()) else {
        return servers;
    };

    for (plugin_key, installs) in plugins {
        // Only include enabled plugins.
        if !enabled_plugins.contains(plugin_key) {
            continue;
        }

        let Some(install_list) = installs.as_array() else {
            continue;
        };
        for install in install_list {
            let Some(install_path) = install.get("installPath").and_then(|p| p.as_str()) else {
                continue;
            };

            let mcp_json_path = Path::new(install_path).join(".mcp.json");
            let Ok(content) = std::fs::read_to_string(&mcp_json_path) else {
                continue;
            };
            let Ok(root) = serde_json::from_str::<serde_json::Value>(&content) else {
                continue;
            };

            // Plugin .mcp.json may use {"mcpServers": {...}} wrapper or bare {name: config}.
            let mcp_obj = if let Some(inner) = root.get("mcpServers").and_then(|v| v.as_object()) {
                inner.clone()
            } else if let Some(obj) = root.as_object() {
                // Bare format: top-level keys are server names.
                obj.iter()
                    .filter(|(k, v)| *k != "mcpServers" && v.is_object())
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect()
            } else {
                continue;
            };

            // Extract plugin display name from the key (e.g., "context7@claude-plugins-official" → "context7").
            let plugin_name = plugin_key.split('@').next().unwrap_or(plugin_key);

            for (name, config) in mcp_obj {
                // Use plugin:name:name format for display, matching Claude Code.
                let display_name = if name == plugin_name {
                    format!("plugin:{plugin_name}")
                } else {
                    format!("plugin:{plugin_name}:{name}")
                };
                servers.push(McpServer {
                    name: display_name,
                    config: normalize_mcp_config(config),
                    source: McpSource::Plugin,
                });
            }
        }
    }

    servers
}

/// Parse project-scoped MCPs from `~/.claude.json`.
///
/// Claude Code stores per-project configs at:
///   `projects["/absolute/path/to/repo"].mcpServers`
fn detect_user_project_mcps(repo_path: &Path) -> Option<Vec<McpServer>> {
    let home = dirs::home_dir()?;
    let config_path = home.join(".claude.json");
    let content = std::fs::read_to_string(&config_path).ok()?;
    let root: serde_json::Value = serde_json::from_str(&content).ok()?;

    let repo_key = repo_path.to_string_lossy();
    let mcp_servers = root
        .get("projects")?
        .get(repo_key.as_ref())?
        .get("mcpServers")?
        .as_object()?;

    let servers = mcp_servers
        .iter()
        .map(|(name, config)| McpServer {
            name: name.clone(),
            config: normalize_mcp_config(config.clone()),
            source: McpSource::UserProjectConfig,
        })
        .collect();

    Some(servers)
}

/// Parse MCPs from `{repo}/.claude.json`, but only if it's explicitly
/// gitignored.
fn detect_repo_local_mcps(repo_path: &Path) -> Option<Vec<McpServer>> {
    let config_path = repo_path.join(".claude.json");
    if !config_path.exists() {
        return None;
    }

    // Only include if the file is explicitly gitignored. An untracked but
    // not-ignored .claude.json should not be picked up.
    if !is_gitignored(repo_path, ".claude.json") {
        return None;
    }

    let content = std::fs::read_to_string(&config_path).ok()?;
    let root: serde_json::Value = serde_json::from_str(&content).ok()?;
    let mcp_servers = root.get("mcpServers")?.as_object()?;

    let servers = mcp_servers
        .iter()
        .map(|(name, config)| McpServer {
            name: name.clone(),
            config: normalize_mcp_config(config.clone()),
            source: McpSource::RepoLocalConfig,
        })
        .collect();

    Some(servers)
}

/// Check if a file is explicitly gitignored (returns true if ignored).
fn is_gitignored(repo_path: &Path, file: &str) -> bool {
    std::process::Command::new("git")
        .args(["check-ignore", "-q", file])
        .current_dir(repo_path)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    /// Helper: create a temporary git repo with .gitignore containing .claude.json.
    fn setup_git_repo_with_gitignored_claude_json(mcp_json: &str) -> TempDir {
        let dir = TempDir::new().unwrap();
        let repo = dir.path();

        // Init git repo
        std::process::Command::new("git")
            .args(["init"])
            .current_dir(repo)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();

        // Create .gitignore that ignores .claude.json
        fs::write(repo.join(".gitignore"), ".claude.json\n").unwrap();

        // Create .claude.json with MCP content
        fs::write(repo.join(".claude.json"), mcp_json).unwrap();

        // Stage and commit .gitignore so git is functional
        std::process::Command::new("git")
            .args(["add", ".gitignore"])
            .current_dir(repo)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        std::process::Command::new("git")
            .args(["commit", "-m", "init", "--allow-empty"])
            .current_dir(repo)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();

        dir
    }

    #[test]
    fn test_detect_repo_local_mcps_with_gitignored_file() {
        let dir = setup_git_repo_with_gitignored_claude_json(
            r#"{
                "mcpServers": {
                    "my-server": {
                        "type": "stdio",
                        "command": "npx",
                        "args": ["-y", "@example/mcp"]
                    }
                }
            }"#,
        );

        let servers = detect_repo_local_mcps(dir.path()).unwrap();
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].name, "my-server");
        assert_eq!(servers[0].source, McpSource::RepoLocalConfig);
        assert_eq!(servers[0].config["command"], "npx");
    }

    #[test]
    fn test_detect_repo_local_mcps_not_gitignored() {
        let dir = TempDir::new().unwrap();
        let repo = dir.path();

        // Init git repo WITHOUT .gitignore
        std::process::Command::new("git")
            .args(["init"])
            .current_dir(repo)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();

        // Create .claude.json but it's NOT ignored
        fs::write(
            repo.join(".claude.json"),
            r#"{"mcpServers":{"s":{"type":"stdio","command":"x"}}}"#,
        )
        .unwrap();

        let result = detect_repo_local_mcps(repo);
        assert!(result.is_none());
    }

    #[test]
    fn test_detect_repo_local_mcps_missing_file() {
        let dir = TempDir::new().unwrap();
        let result = detect_repo_local_mcps(dir.path());
        assert!(result.is_none());
    }

    #[test]
    fn test_detect_repo_local_mcps_malformed_json() {
        let dir = setup_git_repo_with_gitignored_claude_json("not valid json {{{");
        let result = detect_repo_local_mcps(dir.path());
        assert!(result.is_none());
    }

    #[test]
    fn test_detect_repo_local_mcps_no_mcp_servers_key() {
        let dir = setup_git_repo_with_gitignored_claude_json(r#"{"customInstructions": "hello"}"#);
        let result = detect_repo_local_mcps(dir.path());
        assert!(result.is_none());
    }

    #[test]
    fn test_detect_repo_local_mcps_multiple_servers() {
        let dir = setup_git_repo_with_gitignored_claude_json(
            r#"{
                "mcpServers": {
                    "server-a": {"type": "stdio", "command": "a"},
                    "server-b": {"type": "http", "url": "https://example.com"}
                }
            }"#,
        );

        let servers = detect_repo_local_mcps(dir.path()).unwrap();
        assert_eq!(servers.len(), 2);
        let names: Vec<&str> = servers.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"server-a"));
        assert!(names.contains(&"server-b"));
    }

    #[test]
    fn test_serialize_for_cli_empty() {
        let json = serialize_for_cli(&[]);
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(parsed["mcpServers"].as_object().unwrap().is_empty());
    }

    #[test]
    fn test_serialize_for_cli_single_server() {
        let servers = vec![McpServer {
            name: "test-server".to_string(),
            config: serde_json::json!({"type": "stdio", "command": "echo"}),
            source: McpSource::UserProjectConfig,
        }];
        let json = serialize_for_cli(&servers);
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed["mcpServers"]["test-server"]["command"], "echo");
    }

    #[test]
    fn test_serialize_for_cli_multiple_servers() {
        let servers = vec![
            McpServer {
                name: "a".to_string(),
                config: serde_json::json!({"type": "stdio", "command": "cmd-a"}),
                source: McpSource::UserProjectConfig,
            },
            McpServer {
                name: "b".to_string(),
                config: serde_json::json!({"type": "http", "url": "https://b.example.com"}),
                source: McpSource::RepoLocalConfig,
            },
        ];
        let json = serialize_for_cli(&servers);
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        let mcp = parsed["mcpServers"].as_object().unwrap();
        assert_eq!(mcp.len(), 2);
        assert_eq!(mcp["a"]["command"], "cmd-a");
        assert_eq!(mcp["b"]["url"], "https://b.example.com");
    }

    #[test]
    fn test_serialize_for_cli_preserves_env_vars() {
        let servers = vec![McpServer {
            name: "s".to_string(),
            config: serde_json::json!({
                "type": "http",
                "url": "https://api.example.com",
                "headers": {"Authorization": "Bearer ${TOKEN}"}
            }),
            source: McpSource::UserProjectConfig,
        }];
        let json = serialize_for_cli(&servers);
        assert!(json.contains("${TOKEN}"));
    }

    #[test]
    fn test_is_gitignored_true() {
        let dir = setup_git_repo_with_gitignored_claude_json("{}");
        assert!(is_gitignored(dir.path(), ".claude.json"));
    }

    #[test]
    fn test_is_gitignored_false_not_ignored() {
        let dir = TempDir::new().unwrap();
        std::process::Command::new("git")
            .args(["init"])
            .current_dir(dir.path())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(!is_gitignored(dir.path(), ".claude.json"));
    }

    #[test]
    fn test_normalize_mcp_config_adds_type_field() {
        let config_without_type = serde_json::json!({
            "command": "npx",
            "args": ["-y", "@example/mcp-server"]
        });

        let normalized = normalize_mcp_config(config_without_type);

        assert_eq!(normalized["type"], "stdio");
        assert_eq!(normalized["command"], "npx");
        assert_eq!(
            normalized["args"],
            serde_json::json!(["-y", "@example/mcp-server"])
        );
    }

    #[test]
    fn test_normalize_mcp_config_preserves_existing_type() {
        let config_with_type = serde_json::json!({
            "type": "http",
            "url": "https://example.com"
        });

        let normalized = normalize_mcp_config(config_with_type.clone());

        assert_eq!(normalized["type"], "http");
        assert_eq!(normalized["url"], "https://example.com");
    }

    // -- set_server_disabled_in_config tests --

    #[test]
    fn test_set_server_disabled_creates_project_entry() {
        let dir = TempDir::new().unwrap();
        let config_path = dir.path().join(".claude.json");
        fs::write(&config_path, "{}").unwrap();

        // We can't easily test with real home dir, so test the JSON manipulation
        // directly by simulating the logic.
        let mut root: serde_json::Value = serde_json::json!({});
        let repo_key = "/fake/repo";

        // Ensure structure.
        root["projects"] = serde_json::json!({});
        root["projects"][repo_key] = serde_json::json!({});

        let project = root["projects"][repo_key].as_object_mut().unwrap();
        let disabled_list: Vec<String> = vec!["my-server".to_string()];
        project.insert(
            "disabledMcpServers".to_string(),
            serde_json::json!(disabled_list),
        );

        let disabled = root["projects"][repo_key]["disabledMcpServers"]
            .as_array()
            .unwrap();
        assert_eq!(disabled.len(), 1);
        assert_eq!(disabled[0], "my-server");
    }

    #[test]
    fn test_disabled_list_toggle_logic() {
        // Simulate the toggle logic in set_server_disabled_in_config.
        let mut list: Vec<String> = vec!["a".into(), "b".into()];

        // Disable "c" (not in list).
        let name = "c";
        let disabled = true;
        if disabled && !list.contains(&name.to_string()) {
            list.push(name.to_string());
        }
        assert_eq!(list, vec!["a", "b", "c"]);

        // Enable "b" (remove from list).
        let name = "b";
        let disabled = false;
        if !disabled {
            list.retain(|n| n != name);
        }
        assert_eq!(list, vec!["a", "c"]);

        // Enable "x" (not in list, no-op).
        let name = "x";
        let disabled = false;
        if !disabled {
            list.retain(|n| n != name);
        }
        assert_eq!(list, vec!["a", "c"]);

        // Disable "a" (already in list, no-op).
        let name = "a";
        let disabled = true;
        if disabled && !list.contains(&name.to_string()) {
            list.push(name.to_string());
        }
        assert_eq!(list, vec!["a", "c"]);
    }

    #[test]
    fn test_set_server_disabled_preserves_other_config() {
        // Verify the JSON manipulation preserves existing config keys.
        let mut root = serde_json::json!({
            "apiKey": "sk-xxx",
            "projects": {
                "/my/repo": {
                    "allowedTools": ["Bash", "Read"],
                    "customInstructions": "be concise",
                    "mcpServers": {
                        "test": {"type": "stdio", "command": "echo"}
                    }
                }
            },
            "mcpServers": {
                "global-server": {"type": "stdio", "command": "npx"}
            }
        });

        let repo_key = "/my/repo";
        let project = root["projects"][repo_key].as_object_mut().unwrap();
        project.insert(
            "disabledMcpServers".to_string(),
            serde_json::json!(["some-server"]),
        );

        // Verify all other keys are preserved.
        assert_eq!(root["apiKey"], "sk-xxx");
        assert!(root["mcpServers"]["global-server"].is_object());
        let proj = &root["projects"]["/my/repo"];
        assert_eq!(proj["allowedTools"][0], "Bash");
        assert_eq!(proj["customInstructions"], "be concise");
        assert!(proj["mcpServers"]["test"].is_object());
        assert_eq!(proj["disabledMcpServers"][0], "some-server");
    }

    #[test]
    fn test_get_disabled_servers_parses_array() {
        // Test the parsing logic directly.
        let config = serde_json::json!({
            "projects": {
                "/my/repo": {
                    "disabledMcpServers": ["server-a", "server-b"]
                }
            }
        });

        let repo_key = "/my/repo";
        let disabled: Vec<String> = config
            .get("projects")
            .and_then(|p| p.get(repo_key))
            .and_then(|proj| proj.get("disabledMcpServers"))
            .and_then(|arr| arr.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();

        assert_eq!(disabled, vec!["server-a", "server-b"]);
    }

    #[test]
    fn test_get_disabled_servers_missing_key() {
        let config = serde_json::json!({
            "projects": {
                "/my/repo": {
                    "allowedTools": ["Bash"]
                }
            }
        });

        let repo_key = "/my/repo";
        let disabled: Vec<String> = config
            .get("projects")
            .and_then(|p| p.get(repo_key))
            .and_then(|proj| proj.get("disabledMcpServers"))
            .and_then(|arr| arr.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();

        assert!(disabled.is_empty());
    }

    #[test]
    fn test_detect_project_mcp_json() {
        let dir = TempDir::new().unwrap();
        fs::write(
            dir.path().join(".mcp.json"),
            r#"{"mcpServers":{"ctx":{"type":"stdio","command":"npx","args":["-y","@upstash/context7-mcp"]}}}"#,
        )
        .unwrap();

        let servers = detect_project_mcp_json(dir.path()).unwrap();
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].name, "ctx");
        assert_eq!(servers[0].source, McpSource::ProjectMcpJson);
    }

    #[test]
    fn test_detect_project_mcp_json_missing_file() {
        let dir = TempDir::new().unwrap();
        assert!(detect_project_mcp_json(dir.path()).is_none());
    }

    // -- Plugin detection tests --

    #[test]
    fn test_plugin_mcp_json_bare_format() {
        // Test parsing bare format: {"name": {config}} (no mcpServers wrapper).
        let json = r#"{"my-server": {"command": "npx", "args": ["-y", "server"]}}"#;
        let root: serde_json::Value = serde_json::from_str(json).unwrap();

        // Simulate the bare format extraction.
        let mcp_obj: serde_json::Map<String, serde_json::Value> = root
            .as_object()
            .unwrap()
            .iter()
            .filter(|(k, v)| *k != "mcpServers" && v.is_object())
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();

        assert_eq!(mcp_obj.len(), 1);
        assert!(mcp_obj.contains_key("my-server"));
    }

    #[test]
    fn test_plugin_mcp_json_wrapped_format() {
        // Test parsing wrapped format: {"mcpServers": {"name": {config}}}.
        let json = r#"{"mcpServers": {"telegram": {"command": "bun", "args": ["start"]}}}"#;
        let root: serde_json::Value = serde_json::from_str(json).unwrap();

        let inner = root.get("mcpServers").and_then(|v| v.as_object()).unwrap();
        assert_eq!(inner.len(), 1);
        assert!(inner.contains_key("telegram"));
    }

    #[test]
    fn test_plugin_display_name_same_as_plugin() {
        // When server name matches plugin name → "plugin:name"
        let plugin_key = "playwright@claude-plugins-official";
        let plugin_name = plugin_key.split('@').next().unwrap();
        let server_name = "playwright";
        let display = if server_name == plugin_name {
            format!("plugin:{plugin_name}")
        } else {
            format!("plugin:{plugin_name}:{server_name}")
        };
        assert_eq!(display, "plugin:playwright");
    }

    #[test]
    fn test_plugin_display_name_different() {
        // When server name differs → "plugin:pluginname:servername"
        let plugin_key = "mytools@marketplace";
        let plugin_name = plugin_key.split('@').next().unwrap();
        let server_name = "database";
        let display = if server_name == plugin_name {
            format!("plugin:{plugin_name}")
        } else {
            format!("plugin:{plugin_name}:{server_name}")
        };
        assert_eq!(display, "plugin:mytools:database");
    }

    #[test]
    fn test_detect_mcp_servers_does_not_override_explicit_with_plugin() {
        // Plugin servers should NOT override explicit project/user configs.
        // We can't easily test detect_mcp_servers with real files,
        // but we verify the HashMap insertion logic: or_insert (not insert).
        let mut by_name = std::collections::HashMap::<String, McpServer>::new();

        // Simulate explicit config (inserted first).
        by_name.insert(
            "playwright".to_string(),
            McpServer {
                name: "playwright".to_string(),
                config: serde_json::json!({"command": "explicit"}),
                source: McpSource::ProjectMcpJson,
            },
        );

        // Simulate plugin (should not override).
        let plugin_server = McpServer {
            name: "playwright".to_string(),
            config: serde_json::json!({"command": "plugin"}),
            source: McpSource::Plugin,
        };
        by_name
            .entry(plugin_server.name.clone())
            .or_insert(plugin_server);

        assert_eq!(by_name["playwright"].source, McpSource::ProjectMcpJson);
        assert_eq!(by_name["playwright"].config["command"], "explicit");
    }

    #[test]
    fn test_mcp_source_plugin_serialization() {
        let source = McpSource::Plugin;
        let json = serde_json::to_string(&source).unwrap();
        assert_eq!(json, "\"plugin\"");
        let deserialized: McpSource = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized, McpSource::Plugin);
    }

    // -- detect_mcp_servers full chain --

    #[test]
    fn test_detect_mcp_servers_combines_project_and_local() {
        // Set up a repo with both .mcp.json (committed) and gitignored .claude.json.
        let dir = setup_git_repo_with_gitignored_claude_json(
            r#"{
                "mcpServers": {
                    "local-only": {"type": "stdio", "command": "local-cmd"}
                }
            }"#,
        );

        // Also add a .mcp.json (committed project config).
        fs::write(
            dir.path().join(".mcp.json"),
            r#"{"mcpServers":{"committed-server":{"type":"stdio","command":"proj-cmd"}}}"#,
        )
        .unwrap();

        let servers = detect_mcp_servers(dir.path());
        let names: Vec<&str> = servers.iter().map(|s| s.name.as_str()).collect();

        // Both should be present (different names).
        assert!(names.contains(&"local-only"));
        assert!(names.contains(&"committed-server"));

        // Verify sources.
        let local = servers.iter().find(|s| s.name == "local-only").unwrap();
        assert_eq!(local.source, McpSource::RepoLocalConfig);
        let committed = servers
            .iter()
            .find(|s| s.name == "committed-server")
            .unwrap();
        assert_eq!(committed.source, McpSource::ProjectMcpJson);
    }

    #[test]
    fn test_detect_mcp_servers_local_overrides_committed_by_name() {
        // When .claude.json (gitignored) has same server name as .mcp.json,
        // the local one wins (later source overrides earlier).
        let dir = setup_git_repo_with_gitignored_claude_json(
            r#"{
                "mcpServers": {
                    "shared-name": {"type": "stdio", "command": "local-version"}
                }
            }"#,
        );

        fs::write(
            dir.path().join(".mcp.json"),
            r#"{"mcpServers":{"shared-name":{"type":"stdio","command":"committed-version"}}}"#,
        )
        .unwrap();

        let servers = detect_mcp_servers(dir.path());
        let shared = servers.iter().find(|s| s.name == "shared-name").unwrap();

        // .claude.json (source 4) overrides .mcp.json (source 3).
        assert_eq!(shared.source, McpSource::RepoLocalConfig);
        assert_eq!(shared.config["command"], "local-version");
    }

    #[test]
    fn test_detect_mcp_servers_sorted_by_name() {
        let dir = setup_git_repo_with_gitignored_claude_json(
            r#"{
                "mcpServers": {
                    "zebra": {"type": "stdio", "command": "z"},
                    "alpha": {"type": "stdio", "command": "a"},
                    "middle": {"type": "stdio", "command": "m"}
                }
            }"#,
        );

        let servers = detect_mcp_servers(dir.path());
        let names: Vec<&str> = servers.iter().map(|s| s.name.as_str()).collect();
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(names, sorted);
    }

    /// Mutex to serialize tests that mutate home-related env vars. Rust tests
    /// run in parallel, so without this, concurrent tests calling
    /// dirs::home_dir() could see temporarily overridden values.
    static ENV_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Override all home-related env vars and restore on drop.
    struct HomeEnvGuard {
        home: Option<std::ffi::OsString>,
        userprofile: Option<std::ffi::OsString>,
    }

    impl HomeEnvGuard {
        fn override_with(path: &Path) -> Self {
            let guard = Self {
                home: std::env::var_os("HOME"),
                userprofile: std::env::var_os("USERPROFILE"),
            };
            unsafe {
                std::env::set_var("HOME", path);
                std::env::set_var("USERPROFILE", path);
            }
            guard
        }
    }

    impl Drop for HomeEnvGuard {
        fn drop(&mut self) {
            match &self.home {
                Some(v) => unsafe { std::env::set_var("HOME", v) },
                None => unsafe { std::env::remove_var("HOME") },
            }
            match &self.userprofile {
                Some(v) => unsafe { std::env::set_var("USERPROFILE", v) },
                None => unsafe { std::env::remove_var("USERPROFILE") },
            }
        }
    }

    #[test]
    fn test_detect_mcp_servers_empty_repo() {
        // Isolate from real home dir so user-global and plugin MCPs don't
        // leak into the test. Override all home-related env vars for
        // cross-platform determinism (HOME on Unix, USERPROFILE on Windows).
        let _guard = ENV_MUTEX.lock().unwrap();
        let home = TempDir::new().unwrap();
        let repo = TempDir::new().unwrap();
        let _home_env = HomeEnvGuard::override_with(home.path());

        let servers = detect_mcp_servers(repo.path());

        assert!(
            servers.is_empty(),
            "expected no servers from empty repo + empty home, got {}",
            servers.len()
        );
    }

    // -- detect_project_mcp_json edge cases --

    #[test]
    fn test_detect_project_mcp_json_malformed_json() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join(".mcp.json"), "not valid json").unwrap();
        assert!(detect_project_mcp_json(dir.path()).is_none());
    }

    #[test]
    fn test_detect_project_mcp_json_empty_servers() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join(".mcp.json"), r#"{"mcpServers":{}}"#).unwrap();
        let servers = detect_project_mcp_json(dir.path());
        // Empty mcpServers object → Some with empty vec.
        assert!(servers.is_some());
        assert!(servers.unwrap().is_empty());
    }

    #[test]
    fn test_detect_project_mcp_json_no_mcp_servers_key() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join(".mcp.json"), r#"{"other": "data"}"#).unwrap();
        assert!(detect_project_mcp_json(dir.path()).is_none());
    }

    #[test]
    fn test_detect_project_mcp_json_normalizes_config() {
        let dir = TempDir::new().unwrap();
        // Config without "type" field should get "stdio" added.
        fs::write(
            dir.path().join(".mcp.json"),
            r#"{"mcpServers":{"my-srv":{"command":"npx","args":["-y","srv"]}}}"#,
        )
        .unwrap();

        let servers = detect_project_mcp_json(dir.path()).unwrap();
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].config["type"], "stdio");
        assert_eq!(servers[0].config["command"], "npx");
    }

    // -- detect_plugin_mcps with fixtures --

    #[test]
    fn test_detect_plugin_mcps_with_fixture_dir() {
        // Create a realistic plugin directory structure.
        let home_dir = TempDir::new().unwrap();
        let claude_dir = home_dir.path().join(".claude");
        let plugins_dir = claude_dir.join("plugins");
        let cache_dir = plugins_dir
            .join("cache")
            .join("marketplace")
            .join("test-plugin")
            .join("1.0.0");
        fs::create_dir_all(&cache_dir).unwrap();

        // settings.json with enabled plugin.
        fs::write(
            claude_dir.join("settings.json"),
            r#"{"enabledPlugins":{"test-plugin@marketplace":true}}"#,
        )
        .unwrap();

        // installed_plugins.json.
        let install_path = cache_dir.to_string_lossy().to_string();
        fs::write(
            plugins_dir.join("installed_plugins.json"),
            serde_json::json!({
                "plugins": {
                    "test-plugin@marketplace": [{
                        "installPath": install_path,
                        "version": "1.0.0"
                    }]
                }
            })
            .to_string(),
        )
        .unwrap();

        // Plugin's .mcp.json (wrapped format).
        fs::write(
            cache_dir.join(".mcp.json"),
            r#"{"mcpServers":{"test-plugin":{"command":"node","args":["server.js"]}}}"#,
        )
        .unwrap();

        // We can't call detect_plugin_mcps() directly because it reads from
        // the real home dir. Instead, test the parsing logic in isolation by
        // reading the files we just created and simulating the function.
        let settings: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(claude_dir.join("settings.json")).unwrap())
                .unwrap();
        let enabled: std::collections::HashSet<String> = settings
            .get("enabledPlugins")
            .and_then(|v| v.as_object())
            .map(|obj| {
                obj.iter()
                    .filter(|(_, v)| v.as_bool() == Some(true))
                    .map(|(k, _)| k.clone())
                    .collect()
            })
            .unwrap_or_default();
        assert!(enabled.contains("test-plugin@marketplace"));

        let installed: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(plugins_dir.join("installed_plugins.json")).unwrap(),
        )
        .unwrap();
        let plugins = installed
            .get("plugins")
            .and_then(|p| p.as_object())
            .unwrap();

        let mut servers = Vec::new();
        for (plugin_key, installs) in plugins {
            if !enabled.contains(plugin_key) {
                continue;
            }
            for install in installs.as_array().unwrap() {
                let ip = install.get("installPath").and_then(|p| p.as_str()).unwrap();
                let content =
                    fs::read_to_string(std::path::Path::new(ip).join(".mcp.json")).unwrap();
                let root: serde_json::Value = serde_json::from_str(&content).unwrap();
                let mcp_obj = root.get("mcpServers").and_then(|v| v.as_object()).unwrap();
                let plugin_name = plugin_key.split('@').next().unwrap();
                for (name, config) in mcp_obj {
                    let display_name = if *name == plugin_name {
                        format!("plugin:{plugin_name}")
                    } else {
                        format!("plugin:{plugin_name}:{name}")
                    };
                    servers.push(McpServer {
                        name: display_name,
                        config: normalize_mcp_config(config.clone()),
                        source: McpSource::Plugin,
                    });
                }
            }
        }

        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].name, "plugin:test-plugin");
        assert_eq!(servers[0].source, McpSource::Plugin);
        assert_eq!(servers[0].config["type"], "stdio");
        assert_eq!(servers[0].config["command"], "node");
    }

    #[test]
    fn test_detect_plugin_mcps_bare_format_parsing() {
        // Test that bare format (no mcpServers wrapper) is parsed correctly.
        let json = r#"{"my-tool": {"command": "npx", "args": ["-y", "my-tool-server"]}}"#;
        let root: serde_json::Value = serde_json::from_str(json).unwrap();

        // Simulate the bare format fallback from detect_plugin_mcps.
        let mcp_obj = if let Some(inner) = root.get("mcpServers").and_then(|v| v.as_object()) {
            inner.clone()
        } else if let Some(obj) = root.as_object() {
            obj.iter()
                .filter(|(k, v)| *k != "mcpServers" && v.is_object())
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect()
        } else {
            serde_json::Map::new()
        };

        assert_eq!(mcp_obj.len(), 1);
        assert!(mcp_obj.contains_key("my-tool"));
        assert_eq!(mcp_obj["my-tool"]["command"], "npx");
    }

    #[test]
    fn test_detect_plugin_disabled_plugin_skipped() {
        // Verify that disabled plugins in settings are not included.
        let settings = serde_json::json!({
            "enabledPlugins": {
                "active@marketplace": true,
                "disabled@marketplace": false
            }
        });

        let enabled: std::collections::HashSet<String> = settings
            .get("enabledPlugins")
            .and_then(|v| v.as_object())
            .map(|obj| {
                obj.iter()
                    .filter(|(_, v)| v.as_bool() == Some(true))
                    .map(|(k, _)| k.clone())
                    .collect()
            })
            .unwrap_or_default();

        assert!(enabled.contains("active@marketplace"));
        assert!(!enabled.contains("disabled@marketplace"));
        assert_eq!(enabled.len(), 1);
    }

    // -- normalize_mcp_config edge cases --

    #[test]
    fn test_normalize_mcp_config_with_url_type() {
        // SSE config should keep its type.
        let config = serde_json::json!({
            "type": "sse",
            "url": "https://example.com/sse"
        });
        let normalized = normalize_mcp_config(config);
        assert_eq!(normalized["type"], "sse");
    }

    #[test]
    fn test_normalize_mcp_config_non_object() {
        // Non-object values should pass through unchanged.
        let config = serde_json::json!("just a string");
        let normalized = normalize_mcp_config(config.clone());
        assert_eq!(normalized, config);
    }

    // -- McpSource serialization --

    #[test]
    fn test_mcp_source_all_variants_roundtrip() {
        let sources = vec![
            McpSource::UserGlobalConfig,
            McpSource::UserProjectConfig,
            McpSource::ProjectMcpJson,
            McpSource::RepoLocalConfig,
            McpSource::Plugin,
        ];
        let expected_strs = vec![
            "user_global_config",
            "user_project_config",
            "project_mcp_json",
            "repo_local_config",
            "plugin",
        ];
        for (source, expected) in sources.into_iter().zip(expected_strs) {
            let json = serde_json::to_string(&source).unwrap();
            assert_eq!(json, format!("\"{expected}\""));
            let deserialized: McpSource = serde_json::from_str(&json).unwrap();
            assert_eq!(deserialized, source);
        }
    }

    // -- rows_to_servers / cli_config_from_rows --

    fn make_db_row(name: &str, source: &str, enabled: bool) -> crate::db::RepositoryMcpServer {
        crate::db::RepositoryMcpServer {
            id: format!("id-{name}"),
            repository_id: "r1".to_string(),
            name: name.to_string(),
            config_json: format!(r#"{{"type":"stdio","command":"{name}"}}"#),
            source: source.to_string(),
            created_at: String::new(),
            enabled,
        }
    }

    #[test]
    fn test_rows_to_servers_parses_correctly() {
        let rows = vec![
            make_db_row("srv-a", "user_project_config", true),
            make_db_row("srv-b", "plugin", false),
        ];
        let result = rows_to_servers(&rows);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].0.name, "srv-a");
        assert!(result[0].1); // enabled
        assert_eq!(result[0].0.source, McpSource::UserProjectConfig);
        assert_eq!(result[1].0.name, "srv-b");
        assert!(!result[1].1); // disabled
        assert_eq!(result[1].0.source, McpSource::Plugin);
    }

    #[test]
    fn test_rows_to_servers_skips_invalid_json() {
        let mut row = make_db_row("bad", "user_project_config", true);
        row.config_json = "not valid json".to_string();
        let result = rows_to_servers(&[row]);
        assert!(result.is_empty());
    }

    #[test]
    fn test_cli_config_from_rows_filters_disabled() {
        let rows = vec![
            make_db_row("enabled-srv", "user_project_config", true),
            make_db_row("disabled-srv", "user_project_config", false),
        ];
        let config = cli_config_from_rows(&rows).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&config).unwrap();
        let servers = parsed["mcpServers"].as_object().unwrap();
        assert_eq!(servers.len(), 1);
        assert!(servers.contains_key("enabled-srv"));
        assert!(!servers.contains_key("disabled-srv"));
    }

    #[test]
    fn test_cli_config_from_rows_all_disabled_returns_none() {
        let rows = vec![make_db_row("srv", "user_project_config", false)];
        assert!(cli_config_from_rows(&rows).is_none());
    }

    #[test]
    fn test_cli_config_from_rows_empty_returns_none() {
        assert!(cli_config_from_rows(&[]).is_none());
    }
}
