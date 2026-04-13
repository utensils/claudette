//! MCP (Model Context Protocol) configuration detection and management.
//!
//! This module handles:
//! - Detection of MCP servers from user/project/local scopes
//! - Writing workspace-specific .claude.json configurations
//! - Parsing and validating MCP server configurations

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use tokio::fs;

/// Represents a detected MCP server configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServer {
    pub name: String,
    pub config: McpServerConfig,
    pub scope: McpScope,
}

/// MCP server configuration based on transport type
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum McpServerConfig {
    #[serde(rename = "stdio")]
    Stdio {
        command: String,
        args: Vec<String>,
        #[serde(default, skip_serializing_if = "HashMap::is_empty")]
        env: HashMap<String, String>,
    },
    #[serde(rename = "http")]
    Http {
        url: String,
        #[serde(default, skip_serializing_if = "HashMap::is_empty")]
        headers: HashMap<String, String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        oauth: Option<OAuthConfig>,
    },
    #[serde(rename = "sse")]
    Sse { url: String },
}

/// OAuth configuration for HTTP MCP servers
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuthConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    #[serde(rename = "authServerMetadataUrl")]
    pub auth_server_metadata_url: Option<String>,
}

/// Scope of an MCP configuration
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum McpScope {
    User,    // ~/.claude.json (global)
    Project, // .mcp.json (project root)
    Local,   // .claude.json (worktree root, workspace-local config)
}

/// Internal structure for parsing .claude.json and .mcp.json files
#[derive(Debug, Deserialize, Serialize)]
struct ClaudeConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[serde(rename = "mcpServers")]
    mcp_servers: Option<HashMap<String, McpServerConfig>>,

    // Preserve other fields without parsing them
    #[serde(flatten)]
    other: HashMap<String, serde_json::Value>,
}

/// Structure for parsing Claude Code's ~/.claude.json with nested project configs
#[derive(Debug, Deserialize)]
struct ClaudeCodeConfig {
    #[serde(default)]
    projects: HashMap<String, ProjectConfig>,

    #[serde(flatten)]
    _other: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct ProjectConfig {
    #[serde(default, rename = "mcpServers")]
    mcp_servers: Option<HashMap<String, McpServerConfigNested>>,

    #[serde(flatten)]
    _other: HashMap<String, serde_json::Value>,
}

/// Nested MCP config format (used in Claude Code's project-specific configs)
/// This is slightly different from the standard format - it doesn't have a "type" field
#[derive(Debug, Deserialize)]
struct McpServerConfigNested {
    command: Option<String>,
    args: Option<Vec<String>>,
    env: Option<HashMap<String, String>>,
    url: Option<String>,
    headers: Option<HashMap<String, String>>,
}

/// Detect all MCP servers from user, project, and local scopes.
///
/// Precedence order (highest to lowest):
/// 1. Local scope (.claude.json in repo root)
/// 2. Project scope (.mcp.json in repo root)
/// 3. User scope (~/.claude.json global)
///
/// # Arguments
/// * `repo_path` - Path to the repository root
///
/// # Returns
/// A vector of all detected MCP servers with their scope information.
/// Missing or malformed config files are skipped (not errors).
pub async fn detect_mcp_servers(repo_path: &Path) -> Result<Vec<McpServer>, String> {
    let mut all_servers = Vec::new();
    let mut seen_names = HashMap::new();

    // 1. Read user scope (~/.claude.json)
    // First try to read project-specific MCP servers from Claude Code's nested format
    if let Some(home_dir) = dirs::home_dir() {
        let user_config_path = home_dir.join(".claude.json");
        if let Ok(servers) = parse_claude_code_project_mcps(&user_config_path, repo_path).await {
            for server in servers {
                seen_names.insert(server.name.clone(), server.scope);
                all_servers.push(server);
            }
        }
        // Also try to read from top-level mcpServers (standard format)
        if let Ok(servers) = parse_mcp_config(&user_config_path, McpScope::User).await {
            for server in servers {
                if !seen_names.contains_key(&server.name) {
                    seen_names.insert(server.name.clone(), server.scope);
                    all_servers.push(server);
                }
            }
        }
    }

    // 2. Read project scope (.mcp.json in repo root)
    let project_config_path = repo_path.join(".mcp.json");
    if let Ok(servers) = parse_mcp_config(&project_config_path, McpScope::Project).await {
        for server in servers {
            // Higher precedence overrides lower precedence with same name
            if let Some(&existing_scope) = seen_names.get(&server.name) {
                if server.scope > existing_scope {
                    // Remove lower precedence server
                    all_servers.retain(|s| s.name != server.name);
                    seen_names.insert(server.name.clone(), server.scope);
                    all_servers.push(server);
                }
            } else {
                seen_names.insert(server.name.clone(), server.scope);
                all_servers.push(server);
            }
        }
    }

    // 3. Read local scope (.claude.json in repo root)
    let local_config_path = repo_path.join(".claude.json");
    if let Ok(servers) = parse_mcp_config(&local_config_path, McpScope::Local).await {
        for server in servers {
            // Highest precedence always wins
            if seen_names.contains_key(&server.name) {
                all_servers.retain(|s| s.name != server.name);
            }
            seen_names.insert(server.name.clone(), server.scope);
            all_servers.push(server);
        }
    }

    Ok(all_servers)
}

/// Parse Claude Code's project-specific MCP servers from ~/.claude.json
/// Claude Code stores per-project MCPs in: .projects["/path/to/repo"].mcpServers
async fn parse_claude_code_project_mcps(
    config_path: &Path,
    repo_path: &Path,
) -> Result<Vec<McpServer>, String> {
    if !tokio::fs::try_exists(config_path).await.unwrap_or(false) {
        return Ok(Vec::new());
    }

    let content = fs::read_to_string(config_path)
        .await
        .map_err(|e| format!("Failed to read {}: {}", config_path.display(), e))?;

    let config: ClaudeCodeConfig = serde_json::from_str(&content).map_err(|e| {
        format!("Malformed JSON in {}: {}", config_path.display(), e)
    })?;

    // Look for project-specific MCPs using the repo path as key
    let repo_path_str = repo_path.to_string_lossy().to_string();
    let Some(project_config) = config.projects.get(&repo_path_str) else {
        return Ok(Vec::new());
    };

    let Some(mcp_servers) = &project_config.mcp_servers else {
        return Ok(Vec::new());
    };

    let mut servers = Vec::new();
    for (name, nested_config) in mcp_servers {
        // Convert nested format to standard McpServerConfig
        let config = if let Some(command) = &nested_config.command {
            // Stdio server
            McpServerConfig::Stdio {
                command: command.clone(),
                args: nested_config.args.clone().unwrap_or_default(),
                env: nested_config.env.clone().unwrap_or_default(),
            }
        } else if let Some(url) = &nested_config.url {
            // HTTP server
            McpServerConfig::Http {
                url: url.clone(),
                headers: nested_config.headers.clone().unwrap_or_default(),
                oauth: None,
            }
        } else {
            // Invalid config - skip
            continue;
        };

        servers.push(McpServer {
            name: name.clone(),
            config,
            scope: McpScope::Project, // Claude Code project-specific = Project scope
        });
    }

    Ok(servers)
}

/// Parse a single .claude.json or .mcp.json file
///
/// This is a public function that can be used by other modules to read MCP
/// configurations from .claude.json files.
pub async fn parse_mcp_config(path: &Path, scope: McpScope) -> Result<Vec<McpServer>, String> {
    // Missing files are not errors
    if !tokio::fs::try_exists(path).await.unwrap_or(false) {
        return Ok(Vec::new());
    }

    let content = fs::read_to_string(path)
        .await
        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;

    let config: ClaudeConfig = serde_json::from_str(&content).map_err(|e| {
        format!(
            "Malformed JSON in {}: {}",
            path.display(),
            e
        )
    })?;

    let Some(mcp_servers) = config.mcp_servers else {
        // No mcpServers section is valid
        return Ok(Vec::new());
    };

    let mut servers = Vec::new();
    for (name, config) in mcp_servers {
        servers.push(McpServer {
            name,
            config,
            scope,
        });
    }

    Ok(servers)
}

/// Write MCP servers to workspace .claude.json
///
/// # Behavior
/// - Creates .claude.json if it doesn't exist
/// - Merges into existing .claude.json, preserving non-MCP fields
/// - Pretty-prints with 2-space indentation (matches Claude CLI format)
///
/// # Arguments
/// * `worktree_path` - Path to workspace worktree root
/// * `servers` - MCP servers to write
pub async fn write_workspace_mcp_config(
    worktree_path: &Path,
    servers: &[McpServer],
) -> Result<(), String> {
    let config_path = worktree_path.join(".claude.json");

    // Read existing config or create new one
    let mut config: ClaudeConfig = if tokio::fs::try_exists(&config_path).await.unwrap_or(false) {
        let content = fs::read_to_string(&config_path)
            .await
            .map_err(|e| format!("Failed to read existing .claude.json: {}", e))?;

        serde_json::from_str(&content).map_err(|e| {
            format!("Existing .claude.json is malformed: {}", e)
        })?
    } else {
        ClaudeConfig {
            mcp_servers: None,
            other: HashMap::new(),
        }
    };

    // Build mcpServers map from input servers
    let mut mcp_servers = HashMap::new();
    for server in servers {
        mcp_servers.insert(server.name.clone(), server.config.clone());
    }

    config.mcp_servers = if mcp_servers.is_empty() {
        None
    } else {
        Some(mcp_servers)
    };

    // Serialize with pretty printing
    let json = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;

    // Write to file
    fs::write(&config_path, json)
        .await
        .map_err(|e| format!("Failed to write .claude.json: {}", e))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn test_parse_stdio_server() {
        let temp_dir = TempDir::new().unwrap();
        let config_path = temp_dir.path().join(".claude.json");

        let config_content = r#"{
            "mcpServers": {
                "filesystem": {
                    "type": "stdio",
                    "command": "npx",
                    "args": ["-y", "@modelcontextprotocol/server-filesystem"],
                    "env": {}
                }
            }
        }"#;

        fs::write(&config_path, config_content).await.unwrap();

        let servers = parse_mcp_config(&config_path, McpScope::User)
            .await
            .unwrap();

        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].name, "filesystem");
        assert_eq!(servers[0].scope, McpScope::User);

        match &servers[0].config {
            McpServerConfig::Stdio { command, args, .. } => {
                assert_eq!(command, "npx");
                assert_eq!(args.len(), 2);
            }
            _ => panic!("Expected stdio config"),
        }
    }

    #[tokio::test]
    async fn test_parse_http_server() {
        let temp_dir = TempDir::new().unwrap();
        let config_path = temp_dir.path().join(".claude.json");

        let config_content = r#"{
            "mcpServers": {
                "github": {
                    "type": "http",
                    "url": "https://mcp.github.com/api",
                    "headers": {
                        "Authorization": "Bearer token"
                    }
                }
            }
        }"#;

        fs::write(&config_path, config_content).await.unwrap();

        let servers = parse_mcp_config(&config_path, McpScope::Project)
            .await
            .unwrap();

        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].name, "github");

        match &servers[0].config {
            McpServerConfig::Http { url, headers, .. } => {
                assert_eq!(url, "https://mcp.github.com/api");
                assert_eq!(headers.get("Authorization").unwrap(), "Bearer token");
            }
            _ => panic!("Expected http config"),
        }
    }

    #[tokio::test]
    async fn test_missing_file_returns_empty() {
        let temp_dir = TempDir::new().unwrap();
        let config_path = temp_dir.path().join("nonexistent.json");

        let servers = parse_mcp_config(&config_path, McpScope::User)
            .await
            .unwrap();

        assert_eq!(servers.len(), 0);
    }

    #[tokio::test]
    async fn test_malformed_json_returns_error() {
        let temp_dir = TempDir::new().unwrap();
        let config_path = temp_dir.path().join(".claude.json");

        fs::write(&config_path, "{ invalid json }")
            .await
            .unwrap();

        let result = parse_mcp_config(&config_path, McpScope::User).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Malformed JSON"));
    }

    #[tokio::test]
    async fn test_write_new_config() {
        let temp_dir = TempDir::new().unwrap();

        let servers = vec![McpServer {
            name: "test-server".to_string(),
            config: McpServerConfig::Stdio {
                command: "node".to_string(),
                args: vec!["server.js".to_string()],
                env: HashMap::new(),
            },
            scope: McpScope::Local,
        }];

        write_workspace_mcp_config(temp_dir.path(), &servers)
            .await
            .unwrap();

        let config_path = temp_dir.path().join(".claude.json");
        assert!(config_path.exists());

        let content = fs::read_to_string(&config_path).await.unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&content).unwrap();

        assert!(parsed["mcpServers"]["test-server"].is_object());
    }

    #[tokio::test]
    async fn test_merge_preserves_other_fields() {
        let temp_dir = TempDir::new().unwrap();
        let config_path = temp_dir.path().join(".claude.json");

        // Write initial config with custom instructions
        let initial = r#"{
            "customInstructions": "Always use TypeScript",
            "mcpServers": {
                "old-server": {
                    "type": "stdio",
                    "command": "old",
                    "args": []
                }
            }
        }"#;

        fs::write(&config_path, initial).await.unwrap();

        // Write new MCP config
        let servers = vec![McpServer {
            name: "new-server".to_string(),
            config: McpServerConfig::Http {
                url: "https://example.com".to_string(),
                headers: HashMap::new(),
                oauth: None,
            },
            scope: McpScope::Local,
        }];

        write_workspace_mcp_config(temp_dir.path(), &servers)
            .await
            .unwrap();

        // Verify custom instructions preserved
        let content = fs::read_to_string(&config_path).await.unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&content).unwrap();

        assert_eq!(
            parsed["customInstructions"],
            "Always use TypeScript"
        );
        assert!(parsed["mcpServers"]["new-server"].is_object());
        assert!(parsed["mcpServers"]["old-server"].is_null());
    }
}
