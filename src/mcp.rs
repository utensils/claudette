//! MCP (Model Context Protocol) server detection and serialization.
//!
//! Detects non-portable MCP configurations that won't be automatically
//! available inside git worktrees:
//!
//! 1. Project-scoped MCPs in `~/.claude.json` (keyed by absolute repo path)
//! 2. MCPs in gitignored `{repo}/.claude.json`
//!
//! Committed `.mcp.json` and global user MCPs are auto-available and NOT
//! detected here.

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
    /// Project-scoped entry in ~/.claude.json
    UserProjectConfig,
    /// Gitignored .claude.json at repo root
    RepoLocalConfig,
}

/// Detect non-portable MCP servers for the given repository path.
///
/// Scans two locations:
/// 1. `~/.claude.json` → `projects[repo_path].mcpServers`
/// 2. `{repo_path}/.claude.json` (only if gitignored)
///
/// Returns an empty Vec if no non-portable MCPs are found.
pub fn detect_mcp_servers(repo_path: &Path) -> Vec<McpServer> {
    let mut servers = Vec::new();

    if let Some(user_servers) = detect_user_project_mcps(repo_path) {
        servers.extend(user_servers);
    }

    if let Some(local_servers) = detect_repo_local_mcps(repo_path) {
        servers.extend(local_servers);
    }

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
            config: config.clone(),
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
            config: config.clone(),
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
}
