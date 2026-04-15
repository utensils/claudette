//! MCP server supervision: pre-validation, state tracking, and health monitoring.
//!
//! Claudette doesn't speak MCP protocol directly — it passes `--mcp-config` to
//! the Claude CLI subprocess. This module provides a supervision layer that:
//!
//! 1. **Pre-validates** server availability before each agent session
//! 2. **Tracks** per-server connection state via an explicit state machine
//! 3. **Monitors** the agent event stream for MCP tool failures
//! 4. **Broadcasts** status changes via `tokio::sync::watch` for UI updates
//!
//! The supervisor lives in the `claudette` library crate so both `src-tauri`
//! (desktop) and `src-server` (headless) can share it.

use std::collections::HashMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::{RwLock, watch};

use crate::mcp::McpServer;

// ---------------------------------------------------------------------------
// Constants (matching Claude Code's proven values)
// ---------------------------------------------------------------------------

/// Terminal error patterns from the Claude Code reference implementation.
/// These indicate the MCP server connection is broken, not just a transient error.
const TERMINAL_ERROR_PATTERNS: &[&str] = &[
    "ECONNRESET",
    "ETIMEDOUT",
    "EPIPE",
    "EHOSTUNREACH",
    "ECONNREFUSED",
    "Body Timeout Error",
    "terminated",
    "SSE stream disconnected",
    "Failed to reconnect SSE stream",
    "Connection closed",
    "server disconnected",
    "Maximum reconnection attempts",
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Connection state for a supervised MCP server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpConnectionState {
    /// Server is reachable / command exists.
    Connected,
    /// Awaiting validation or reconnection.
    Pending,
    /// Validation or connection failed.
    Failed,
    /// Manually disabled by user.
    Disabled,
}

/// Transport type derived from server config.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpTransport {
    Stdio,
    Http,
    Sse,
}

/// Full per-server supervision state (internal, includes config).
#[derive(Debug, Clone, Serialize)]
pub struct SupervisedServer {
    pub name: String,
    pub transport: McpTransport,
    pub state: McpConnectionState,
    pub config: serde_json::Value,
    pub enabled: bool,
    pub failure_count: u32,
    pub last_error: Option<String>,
}

/// Lightweight status for events and frontend (no config blob).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct McpServerStatus {
    pub name: String,
    pub transport: McpTransport,
    pub state: McpConnectionState,
    pub enabled: bool,
    pub last_error: Option<String>,
    pub failure_count: u32,
}

/// Snapshot of all server states for a repository.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct McpStatusSnapshot {
    pub repository_id: String,
    pub servers: Vec<McpServerStatus>,
}

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

/// Exponential backoff configuration.
pub struct BackoffConfig {
    pub base_ms: u64,
    pub multiplier: f64,
    pub max_ms: u64,
    pub max_attempts: u32,
}

impl Default for BackoffConfig {
    fn default() -> Self {
        Self {
            base_ms: 1000,
            multiplier: 2.0,
            max_ms: 30_000,
            max_attempts: 5,
        }
    }
}

/// Calculate backoff delay for a given failure count.
///
/// Follows Claude Code's exponential backoff: 1s, 2s, 4s, 8s, 16s, capped at 30s.
pub fn calculate_backoff(config: &BackoffConfig, failure_count: u32) -> Duration {
    let delay_ms = (config.base_ms as f64 * config.multiplier.powi(failure_count as i32)) as u64;
    Duration::from_millis(delay_ms.min(config.max_ms))
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/// Detect the transport type from a server config JSON value.
pub fn detect_transport(config: &serde_json::Value) -> McpTransport {
    if let Some(t) = config.get("type").and_then(|v| v.as_str()) {
        match t {
            "sse" => return McpTransport::Sse,
            "http" => return McpTransport::Http,
            "stdio" => return McpTransport::Stdio,
            _ => {}
        }
    }
    // Fallback heuristics: if it has a "command" field, it's stdio; if "url", it's http.
    if config.get("command").is_some() {
        McpTransport::Stdio
    } else if config.get("url").is_some() {
        McpTransport::Http
    } else {
        McpTransport::Stdio
    }
}

/// Extract MCP server name from a tool name like `mcp__servername__toolname`.
///
/// Returns `None` if the tool name doesn't follow MCP naming convention.
pub fn extract_mcp_server_name(tool_name: &str) -> Option<&str> {
    let rest = tool_name.strip_prefix("mcp__")?;
    let end = rest.find("__")?;
    Some(&rest[..end])
}

/// Check if an error message indicates a terminal MCP connection failure.
pub fn is_terminal_mcp_error(msg: &str) -> bool {
    TERMINAL_ERROR_PATTERNS
        .iter()
        .any(|pattern| msg.contains(pattern))
}

// ---------------------------------------------------------------------------
// Validation functions
// ---------------------------------------------------------------------------

/// Check if a stdio server's command exists and is executable.
///
/// Resolves the command from `PATH` using the `which` crate for
/// cross-platform lookup (works on macOS, Linux, and Windows).
pub async fn validate_stdio_server(config: &serde_json::Value) -> Result<(), String> {
    let command = config
        .get("command")
        .and_then(|v| v.as_str())
        .ok_or("stdio server config missing 'command' field")?;

    which::which(command)
        .map(|_| ())
        .map_err(|_| format!("command not found in PATH: {command}"))
}

/// Health-check a remote server endpoint via TCP connect with timeout.
pub async fn validate_remote_server(config: &serde_json::Value) -> Result<(), String> {
    let url_str = config
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or("remote server config missing 'url' field")?;

    // Parse host and port from the URL.
    let url: url::Url = url_str.parse().map_err(|e| format!("invalid URL: {e}"))?;
    let host = url.host_str().ok_or("URL missing host")?;
    let port = url.port_or_known_default().unwrap_or(443);
    let display_addr = if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };

    // TCP connect with 5-second timeout.
    // Use (host, port) tuple so tokio resolves IPv6 addresses correctly.
    let timeout = Duration::from_secs(5);
    match tokio::time::timeout(timeout, tokio::net::TcpStream::connect((host, port))).await {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(e)) => Err(format!("TCP connect to {display_addr} failed: {e}")),
        Err(_) => Err(format!("TCP connect to {display_addr} timed out after 5s")),
    }
}

/// Validate a server based on its transport type.
async fn validate_server(
    config: &serde_json::Value,
    transport: McpTransport,
) -> Result<(), String> {
    match transport {
        McpTransport::Stdio => validate_stdio_server(config).await,
        McpTransport::Http | McpTransport::Sse => validate_remote_server(config).await,
    }
}

// ---------------------------------------------------------------------------
// Per-repository state
// ---------------------------------------------------------------------------

struct RepoMcpState {
    servers: HashMap<String, SupervisedServer>,
    state_tx: watch::Sender<McpStatusSnapshot>,
}

impl RepoMcpState {
    fn new(repository_id: &str) -> Self {
        let initial = McpStatusSnapshot {
            repository_id: repository_id.to_string(),
            servers: Vec::new(),
        };
        let (state_tx, _) = watch::channel(initial);
        Self {
            servers: HashMap::new(),
            state_tx,
        }
    }

    /// Build and broadcast a status snapshot.
    fn broadcast(&self, repository_id: &str) {
        let servers: Vec<McpServerStatus> = self
            .servers
            .values()
            .map(|s| McpServerStatus {
                name: s.name.clone(),
                transport: s.transport,
                state: s.state,
                enabled: s.enabled,
                last_error: s.last_error.clone(),
                failure_count: s.failure_count,
            })
            .collect();

        let snapshot = McpStatusSnapshot {
            repository_id: repository_id.to_string(),
            servers,
        };
        // Ignore send error — means no receivers are listening.
        let _ = self.state_tx.send(snapshot);
    }

    /// Get the current snapshot without broadcasting.
    fn snapshot(&self, repository_id: &str) -> McpStatusSnapshot {
        let servers: Vec<McpServerStatus> = self
            .servers
            .values()
            .map(|s| McpServerStatus {
                name: s.name.clone(),
                transport: s.transport,
                state: s.state,
                enabled: s.enabled,
                last_error: s.last_error.clone(),
                failure_count: s.failure_count,
            })
            .collect();

        McpStatusSnapshot {
            repository_id: repository_id.to_string(),
            servers,
        }
    }
}

// ---------------------------------------------------------------------------
// McpSupervisor
// ---------------------------------------------------------------------------

/// Top-level MCP server supervisor, one instance per application.
///
/// Manages per-repository server state, validation, and status broadcasting.
pub struct McpSupervisor {
    repos: RwLock<HashMap<String, RepoMcpState>>,
}

impl McpSupervisor {
    pub fn new() -> Self {
        Self {
            repos: RwLock::new(HashMap::new()),
        }
    }

    /// Initialize supervision for a repository from its saved MCP servers.
    ///
    /// Idempotent: if the repo is already initialized, merges new servers
    /// (adds missing, removes stale) without resetting existing state.
    pub async fn init_repo(&self, repository_id: &str, servers: Vec<McpServer>) {
        let mut repos = self.repos.write().await;
        let repo = repos
            .entry(repository_id.to_string())
            .or_insert_with(|| RepoMcpState::new(repository_id));

        // Build set of incoming server names.
        let incoming_names: std::collections::HashSet<&str> =
            servers.iter().map(|s| s.name.as_str()).collect();

        // Remove servers no longer in the config.
        repo.servers
            .retain(|name, _| incoming_names.contains(name.as_str()));

        // Add or update servers.
        for server in servers {
            let transport = detect_transport(&server.config);
            repo.servers
                .entry(server.name.clone())
                .and_modify(|existing| {
                    // Update config but keep current state.
                    existing.config = server.config.clone();
                    existing.transport = transport;
                })
                .or_insert(SupervisedServer {
                    name: server.name,
                    transport,
                    state: McpConnectionState::Pending,
                    config: server.config,
                    enabled: true,
                    failure_count: 0,
                    last_error: None,
                });
        }

        repo.broadcast(repository_id);
    }

    /// Initialize a repo with enabled state from DB rows.
    ///
    /// Like `init_repo` but also sets the `enabled` flag per server.
    pub async fn init_repo_with_enabled(
        &self,
        repository_id: &str,
        servers: Vec<(McpServer, bool)>,
    ) {
        let mut repos = self.repos.write().await;
        let repo = repos
            .entry(repository_id.to_string())
            .or_insert_with(|| RepoMcpState::new(repository_id));

        let incoming_names: std::collections::HashSet<&str> =
            servers.iter().map(|(s, _)| s.name.as_str()).collect();

        repo.servers
            .retain(|name, _| incoming_names.contains(name.as_str()));

        for (server, enabled) in servers {
            let transport = detect_transport(&server.config);
            repo.servers
                .entry(server.name.clone())
                .and_modify(|existing| {
                    existing.config = server.config.clone();
                    existing.transport = transport;
                    existing.enabled = enabled;
                })
                .or_insert(SupervisedServer {
                    name: server.name,
                    transport,
                    state: if enabled {
                        McpConnectionState::Pending
                    } else {
                        McpConnectionState::Disabled
                    },
                    config: server.config,
                    enabled,
                    failure_count: 0,
                    last_error: None,
                });
        }

        repo.broadcast(repository_id);
    }

    /// Pre-validate all enabled servers for a repository.
    ///
    /// Transitions each server's state based on validation result:
    /// - Success → Connected
    /// - Failure → Failed (with error message)
    /// - Disabled servers are skipped.
    ///
    /// Returns the updated status list.
    pub async fn validate_servers(&self, repository_id: &str) -> Vec<McpServerStatus> {
        // Collect servers to validate (snapshot under read lock).
        let to_validate: Vec<(String, serde_json::Value, McpTransport)> = {
            let repos = self.repos.read().await;
            let Some(repo) = repos.get(repository_id) else {
                return Vec::new();
            };
            repo.servers
                .values()
                .filter(|s| s.enabled)
                .map(|s| (s.name.clone(), s.config.clone(), s.transport))
                .collect()
        };

        // Validate concurrently (release lock during I/O).
        let results: Vec<(String, Result<(), String>)> =
            futures::future::join_all(to_validate.into_iter().map(|(name, config, transport)| {
                let name = name.clone();
                async move {
                    let result = validate_server(&config, transport).await;
                    (name, result)
                }
            }))
            .await;

        // Apply results under write lock.
        let mut repos = self.repos.write().await;
        let Some(repo) = repos.get_mut(repository_id) else {
            return Vec::new();
        };

        for (name, result) in results {
            if let Some(server) = repo.servers.get_mut(&name) {
                // Server may have been disabled while validation was in flight.
                if !server.enabled {
                    continue;
                }
                match result {
                    Ok(()) => {
                        server.state = McpConnectionState::Connected;
                        server.failure_count = 0;
                        server.last_error = None;
                    }
                    Err(err) => {
                        server.state = McpConnectionState::Failed;
                        server.failure_count += 1;
                        server.last_error = Some(err);
                    }
                }
            }
        }

        let snapshot = repo.snapshot(repository_id);
        repo.broadcast(repository_id);
        snapshot.servers
    }

    /// Report a tool failure detected from the agent event stream.
    ///
    /// Transitions the named server to Failed state.
    pub async fn report_tool_failure(&self, repository_id: &str, server_name: &str, error: &str) {
        let mut repos = self.repos.write().await;
        let Some(repo) = repos.get_mut(repository_id) else {
            return;
        };
        let Some(server) = repo.servers.get_mut(server_name) else {
            return;
        };

        if server.state == McpConnectionState::Connected {
            server.state = McpConnectionState::Failed;
            server.failure_count += 1;
            server.last_error = Some(error.to_string());
            repo.broadcast(repository_id);
        }
    }

    /// Manually reconnect a specific server (re-validate).
    ///
    /// Returns the new state, or an error if the server doesn't exist or is disabled.
    pub async fn reconnect_server(
        &self,
        repository_id: &str,
        server_name: &str,
    ) -> Result<McpServerStatus, String> {
        // Read config under lock, then validate without lock held.
        let (config, transport) = {
            let repos = self.repos.read().await;
            let repo = repos
                .get(repository_id)
                .ok_or("repository not supervised")?;
            let server = repo.servers.get(server_name).ok_or("server not found")?;
            if !server.enabled {
                return Err("server is disabled".to_string());
            }
            (server.config.clone(), server.transport)
        };

        // Mark as pending during validation.
        {
            let mut repos = self.repos.write().await;
            if let Some(repo) = repos.get_mut(repository_id)
                && let Some(server) = repo.servers.get_mut(server_name)
            {
                server.state = McpConnectionState::Pending;
                repo.broadcast(repository_id);
            }
        }

        let result = validate_server(&config, transport).await;

        // Apply result.
        let mut repos = self.repos.write().await;
        let repo = repos
            .get_mut(repository_id)
            .ok_or("repository not supervised")?;
        let server = repo
            .servers
            .get_mut(server_name)
            .ok_or("server not found")?;

        // Server may have been disabled while validation was in flight.
        if !server.enabled {
            let status = McpServerStatus {
                name: server.name.clone(),
                transport: server.transport,
                state: server.state,
                enabled: server.enabled,
                last_error: server.last_error.clone(),
                failure_count: server.failure_count,
            };
            return Ok(status);
        }

        match result {
            Ok(()) => {
                server.state = McpConnectionState::Connected;
                server.failure_count = 0;
                server.last_error = None;
            }
            Err(ref err) => {
                server.state = McpConnectionState::Failed;
                server.failure_count += 1;
                server.last_error = Some(err.clone());
            }
        }

        let status = McpServerStatus {
            name: server.name.clone(),
            transport: server.transport,
            state: server.state,
            enabled: server.enabled,
            last_error: server.last_error.clone(),
            failure_count: server.failure_count,
        };
        repo.broadcast(repository_id);

        result.map(|()| status.clone()).or(Ok(status))
    }

    /// Enable or disable a specific server.
    ///
    /// Disabling transitions state to Disabled; enabling transitions to Pending.
    pub async fn set_server_enabled(&self, repository_id: &str, server_name: &str, enabled: bool) {
        let mut repos = self.repos.write().await;
        let Some(repo) = repos.get_mut(repository_id) else {
            return;
        };
        let Some(server) = repo.servers.get_mut(server_name) else {
            return;
        };

        server.enabled = enabled;
        if enabled {
            // Re-enable: move to Pending so next validate picks it up.
            if server.state == McpConnectionState::Disabled {
                server.state = McpConnectionState::Pending;
                server.failure_count = 0;
                server.last_error = None;
            }
        } else {
            server.state = McpConnectionState::Disabled;
        }

        repo.broadcast(repository_id);
    }

    /// Get current status snapshot for a repository.
    pub async fn get_status(&self, repository_id: &str) -> Option<McpStatusSnapshot> {
        let repos = self.repos.read().await;
        repos.get(repository_id).map(|r| r.snapshot(repository_id))
    }

    /// Subscribe to status changes for a repository.
    ///
    /// Returns `None` if the repository is not supervised.
    pub async fn subscribe(
        &self,
        repository_id: &str,
    ) -> Option<watch::Receiver<McpStatusSnapshot>> {
        let repos = self.repos.read().await;
        repos.get(repository_id).map(|r| r.state_tx.subscribe())
    }

    /// Remove supervision for a repository.
    pub async fn remove_repo(&self, repository_id: &str) {
        let mut repos = self.repos.write().await;
        repos.remove(repository_id);
    }
}

impl Default for McpSupervisor {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // -- Backoff --

    #[test]
    fn test_backoff_calculation_exponential() {
        let config = BackoffConfig::default();
        assert_eq!(calculate_backoff(&config, 0), Duration::from_millis(1000));
        assert_eq!(calculate_backoff(&config, 1), Duration::from_millis(2000));
        assert_eq!(calculate_backoff(&config, 2), Duration::from_millis(4000));
        assert_eq!(calculate_backoff(&config, 3), Duration::from_millis(8000));
        assert_eq!(calculate_backoff(&config, 4), Duration::from_millis(16000));
    }

    #[test]
    fn test_backoff_caps_at_max() {
        let config = BackoffConfig::default();
        // 2^5 * 1000 = 32000, capped to 30000
        assert_eq!(calculate_backoff(&config, 5), Duration::from_millis(30000));
        assert_eq!(calculate_backoff(&config, 10), Duration::from_millis(30000));
    }

    // -- Transport detection --

    #[test]
    fn test_detect_transport_stdio_explicit() {
        let config = serde_json::json!({"type": "stdio", "command": "npx"});
        assert_eq!(detect_transport(&config), McpTransport::Stdio);
    }

    #[test]
    fn test_detect_transport_stdio_implicit() {
        let config = serde_json::json!({"command": "npx", "args": ["-y", "server"]});
        assert_eq!(detect_transport(&config), McpTransport::Stdio);
    }

    #[test]
    fn test_detect_transport_http() {
        let config = serde_json::json!({"type": "http", "url": "https://example.com"});
        assert_eq!(detect_transport(&config), McpTransport::Http);
    }

    #[test]
    fn test_detect_transport_sse() {
        let config = serde_json::json!({"type": "sse", "url": "https://example.com/sse"});
        assert_eq!(detect_transport(&config), McpTransport::Sse);
    }

    #[test]
    fn test_detect_transport_url_fallback() {
        let config = serde_json::json!({"url": "https://example.com"});
        assert_eq!(detect_transport(&config), McpTransport::Http);
    }

    // -- Tool name parsing --

    #[test]
    fn test_extract_mcp_server_name_valid() {
        assert_eq!(
            extract_mcp_server_name("mcp__my_server__do_thing"),
            Some("my_server")
        );
    }

    #[test]
    fn test_extract_mcp_server_name_with_plugin_prefix() {
        assert_eq!(
            extract_mcp_server_name("mcp__plugin_playwright_playwright__browser_click"),
            Some("plugin_playwright_playwright")
        );
    }

    #[test]
    fn test_extract_mcp_server_name_not_mcp() {
        assert_eq!(extract_mcp_server_name("Read"), None);
        assert_eq!(extract_mcp_server_name("Bash"), None);
    }

    #[test]
    fn test_extract_mcp_server_name_no_tool_part() {
        assert_eq!(extract_mcp_server_name("mcp__server_only"), None);
    }

    // -- Terminal error detection --

    #[test]
    fn test_is_terminal_mcp_error_matches() {
        assert!(is_terminal_mcp_error("Connection reset: ECONNRESET"));
        assert!(is_terminal_mcp_error("ETIMEDOUT after 30s"));
        assert!(is_terminal_mcp_error("write failed: EPIPE"));
        assert!(is_terminal_mcp_error("ECONNREFUSED 127.0.0.1:8080"));
        assert!(is_terminal_mcp_error("SSE stream disconnected"));
        assert!(is_terminal_mcp_error("Connection closed by server"));
    }

    #[test]
    fn test_is_terminal_mcp_error_non_terminal() {
        assert!(!is_terminal_mcp_error("Invalid argument: foo"));
        assert!(!is_terminal_mcp_error("Tool not found"));
        assert!(!is_terminal_mcp_error("Permission denied"));
    }

    // -- Status snapshot serialization --

    #[test]
    fn test_status_snapshot_serialization_roundtrip() {
        let snapshot = McpStatusSnapshot {
            repository_id: "repo-1".to_string(),
            servers: vec![
                McpServerStatus {
                    name: "server-a".to_string(),
                    transport: McpTransport::Stdio,
                    state: McpConnectionState::Connected,
                    enabled: true,
                    last_error: None,
                    failure_count: 0,
                },
                McpServerStatus {
                    name: "server-b".to_string(),
                    transport: McpTransport::Http,
                    state: McpConnectionState::Failed,
                    enabled: true,
                    last_error: Some("ECONNREFUSED".to_string()),
                    failure_count: 2,
                },
            ],
        };

        let json = serde_json::to_string(&snapshot).unwrap();
        let deserialized: McpStatusSnapshot = serde_json::from_str(&json).unwrap();
        assert_eq!(snapshot, deserialized);
    }

    // -- McpSupervisor --

    /// A real PATH-resolvable executable for validation tests.
    /// `echo` is a shell built-in on Windows, so we use `cmd` there instead.
    const TEST_COMMAND: &str = if cfg!(windows) { "cmd" } else { "echo" };

    fn make_test_server(name: &str, transport_type: &str) -> McpServer {
        let config = match transport_type {
            "stdio" => {
                serde_json::json!({"type": "stdio", "command": TEST_COMMAND, "args": []})
            }
            "http" => serde_json::json!({"type": "http", "url": "https://example.com"}),
            "sse" => serde_json::json!({"type": "sse", "url": "https://example.com/sse"}),
            _ => serde_json::json!({"type": "stdio", "command": TEST_COMMAND}),
        };
        McpServer {
            name: name.to_string(),
            config,
            source: crate::mcp::McpSource::UserProjectConfig,
        }
    }

    #[tokio::test]
    async fn test_init_repo_creates_pending_servers() {
        let supervisor = McpSupervisor::new();
        supervisor
            .init_repo(
                "repo-1",
                vec![
                    make_test_server("a", "stdio"),
                    make_test_server("b", "http"),
                ],
            )
            .await;

        let status = supervisor.get_status("repo-1").await.unwrap();
        assert_eq!(status.servers.len(), 2);
        for s in &status.servers {
            assert_eq!(s.state, McpConnectionState::Pending);
            assert!(s.enabled);
        }
    }

    #[tokio::test]
    async fn test_init_repo_idempotent() {
        let supervisor = McpSupervisor::new();
        let servers = vec![make_test_server("a", "stdio")];

        supervisor.init_repo("repo-1", servers.clone()).await;
        // Second init should not duplicate.
        supervisor.init_repo("repo-1", servers).await;

        let status = supervisor.get_status("repo-1").await.unwrap();
        assert_eq!(status.servers.len(), 1);
    }

    #[tokio::test]
    async fn test_init_repo_removes_stale_servers() {
        let supervisor = McpSupervisor::new();
        supervisor
            .init_repo(
                "repo-1",
                vec![
                    make_test_server("a", "stdio"),
                    make_test_server("b", "http"),
                ],
            )
            .await;

        // Re-init with only server "a" — "b" should be removed.
        supervisor
            .init_repo("repo-1", vec![make_test_server("a", "stdio")])
            .await;

        let status = supervisor.get_status("repo-1").await.unwrap();
        assert_eq!(status.servers.len(), 1);
        assert_eq!(status.servers[0].name, "a");
    }

    #[tokio::test]
    async fn test_report_tool_failure_transitions_to_failed() {
        let supervisor = McpSupervisor::new();
        supervisor
            .init_repo("repo-1", vec![make_test_server("a", "stdio")])
            .await;

        // Manually set to Connected first.
        {
            let mut repos = supervisor.repos.write().await;
            let repo = repos.get_mut("repo-1").unwrap();
            repo.servers.get_mut("a").unwrap().state = McpConnectionState::Connected;
        }

        supervisor
            .report_tool_failure("repo-1", "a", "ECONNRESET")
            .await;

        let status = supervisor.get_status("repo-1").await.unwrap();
        let server = status.servers.iter().find(|s| s.name == "a").unwrap();
        assert_eq!(server.state, McpConnectionState::Failed);
        assert_eq!(server.last_error.as_deref(), Some("ECONNRESET"));
        assert_eq!(server.failure_count, 1);
    }

    #[tokio::test]
    async fn test_set_server_enabled_disable() {
        let supervisor = McpSupervisor::new();
        supervisor
            .init_repo("repo-1", vec![make_test_server("a", "stdio")])
            .await;

        supervisor.set_server_enabled("repo-1", "a", false).await;

        let status = supervisor.get_status("repo-1").await.unwrap();
        let server = status.servers.iter().find(|s| s.name == "a").unwrap();
        assert_eq!(server.state, McpConnectionState::Disabled);
        assert!(!server.enabled);
    }

    #[tokio::test]
    async fn test_set_server_enabled_reenable() {
        let supervisor = McpSupervisor::new();
        supervisor
            .init_repo("repo-1", vec![make_test_server("a", "stdio")])
            .await;

        supervisor.set_server_enabled("repo-1", "a", false).await;
        supervisor.set_server_enabled("repo-1", "a", true).await;

        let status = supervisor.get_status("repo-1").await.unwrap();
        let server = status.servers.iter().find(|s| s.name == "a").unwrap();
        assert_eq!(server.state, McpConnectionState::Pending);
        assert!(server.enabled);
    }

    #[tokio::test]
    async fn test_watch_channel_broadcasts_changes() {
        let supervisor = McpSupervisor::new();
        supervisor
            .init_repo("repo-1", vec![make_test_server("a", "stdio")])
            .await;

        let mut rx = supervisor.subscribe("repo-1").await.unwrap();

        // Mark current value as seen so `changed()` waits for the next update.
        rx.borrow_and_update();

        // Trigger a state change.
        supervisor.set_server_enabled("repo-1", "a", false).await;

        // Should receive the update.
        rx.changed().await.unwrap();
        let updated = rx.borrow().clone();
        assert_eq!(updated.servers.len(), 1);
        assert_eq!(updated.servers[0].state, McpConnectionState::Disabled);
    }

    #[tokio::test]
    async fn test_remove_repo() {
        let supervisor = McpSupervisor::new();
        supervisor
            .init_repo("repo-1", vec![make_test_server("a", "stdio")])
            .await;

        supervisor.remove_repo("repo-1").await;
        assert!(supervisor.get_status("repo-1").await.is_none());
    }

    #[tokio::test]
    async fn test_get_status_nonexistent_repo() {
        let supervisor = McpSupervisor::new();
        assert!(supervisor.get_status("nope").await.is_none());
    }

    #[tokio::test]
    async fn test_validate_stdio_server_existing_command() {
        let config = serde_json::json!({"type": "stdio", "command": TEST_COMMAND});
        let result = validate_stdio_server(&config).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_validate_stdio_server_missing_command() {
        let config =
            serde_json::json!({"type": "stdio", "command": "nonexistent_binary_xyz_12345"});
        let result = validate_stdio_server(&config).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("command not found"));
    }

    #[tokio::test]
    async fn test_validate_remote_server_unreachable() {
        // Port 1 on localhost should be unreachable.
        let config = serde_json::json!({"type": "http", "url": "http://127.0.0.1:1/mcp"});
        let result = validate_remote_server(&config).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_reconnect_disabled_server_errors() {
        let supervisor = McpSupervisor::new();
        supervisor
            .init_repo("repo-1", vec![make_test_server("a", "stdio")])
            .await;
        supervisor.set_server_enabled("repo-1", "a", false).await;

        let result = supervisor.reconnect_server("repo-1", "a").await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("disabled"));
    }

    // -- validate_servers --

    #[tokio::test]
    async fn test_validate_servers_mixed_results() {
        let supervisor = McpSupervisor::new();
        // "echo" exists, "nonexistent_binary_xyz_12345" does not.
        supervisor
            .init_repo(
                "repo-1",
                vec![
                    make_test_server("good", "stdio"),     // command = "echo" → will pass
                    McpServer {
                        name: "bad".to_string(),
                        config: serde_json::json!({"type": "stdio", "command": "nonexistent_binary_xyz_12345"}),
                        source: crate::mcp::McpSource::UserProjectConfig,
                    },
                ],
            )
            .await;

        let statuses = supervisor.validate_servers("repo-1").await;
        assert_eq!(statuses.len(), 2);

        let good = statuses.iter().find(|s| s.name == "good").unwrap();
        assert_eq!(good.state, McpConnectionState::Connected);
        assert!(good.last_error.is_none());
        assert_eq!(good.failure_count, 0);

        let bad = statuses.iter().find(|s| s.name == "bad").unwrap();
        assert_eq!(bad.state, McpConnectionState::Failed);
        assert!(bad.last_error.is_some());
        assert!(bad.failure_count > 0);
    }

    #[tokio::test]
    async fn test_validate_servers_skips_disabled() {
        let supervisor = McpSupervisor::new();
        supervisor
            .init_repo("repo-1", vec![make_test_server("a", "stdio")])
            .await;
        supervisor.set_server_enabled("repo-1", "a", false).await;

        let statuses = supervisor.validate_servers("repo-1").await;
        // Disabled server should stay disabled, not be validated.
        let a = statuses.iter().find(|s| s.name == "a").unwrap();
        assert_eq!(a.state, McpConnectionState::Disabled);
    }

    #[tokio::test]
    async fn test_validate_servers_nonexistent_repo() {
        let supervisor = McpSupervisor::new();
        let statuses = supervisor.validate_servers("nope").await;
        assert!(statuses.is_empty());
    }

    // -- report_tool_failure edge cases --

    #[tokio::test]
    async fn test_report_tool_failure_only_from_connected() {
        // report_tool_failure should only transition Connected → Failed.
        // If server is Pending or Disabled, it should NOT change state.
        let supervisor = McpSupervisor::new();
        supervisor
            .init_repo("repo-1", vec![make_test_server("a", "stdio")])
            .await;
        // Server starts as Pending — failure report should be ignored.
        supervisor
            .report_tool_failure("repo-1", "a", "ECONNRESET")
            .await;

        let status = supervisor.get_status("repo-1").await.unwrap();
        let a = status.servers.iter().find(|s| s.name == "a").unwrap();
        assert_eq!(a.state, McpConnectionState::Pending);
        assert_eq!(a.failure_count, 0);
    }

    #[tokio::test]
    async fn test_report_tool_failure_nonexistent_server() {
        let supervisor = McpSupervisor::new();
        supervisor
            .init_repo("repo-1", vec![make_test_server("a", "stdio")])
            .await;
        // Should not panic — just no-op.
        supervisor
            .report_tool_failure("repo-1", "nonexistent", "ECONNRESET")
            .await;
        supervisor
            .report_tool_failure("no-repo", "a", "ECONNRESET")
            .await;
    }

    #[tokio::test]
    async fn test_report_tool_failure_increments_count() {
        let supervisor = McpSupervisor::new();
        supervisor
            .init_repo("repo-1", vec![make_test_server("a", "stdio")])
            .await;
        // Set to Connected.
        {
            let mut repos = supervisor.repos.write().await;
            let repo = repos.get_mut("repo-1").unwrap();
            repo.servers.get_mut("a").unwrap().state = McpConnectionState::Connected;
        }

        supervisor
            .report_tool_failure("repo-1", "a", "ECONNRESET")
            .await;

        // After first failure it's now Failed, so second report should be no-op
        // (only Connected → Failed transition triggers).
        supervisor.report_tool_failure("repo-1", "a", "EPIPE").await;

        let status = supervisor.get_status("repo-1").await.unwrap();
        let a = status.servers.iter().find(|s| s.name == "a").unwrap();
        assert_eq!(a.failure_count, 1); // Not 2, because second was from Failed state
        assert_eq!(a.last_error.as_deref(), Some("ECONNRESET"));
    }

    // -- reconnect state machine --

    #[tokio::test]
    async fn test_reconnect_transitions_failed_to_connected() {
        let supervisor = McpSupervisor::new();
        // Use "echo" which is a valid command.
        supervisor
            .init_repo("repo-1", vec![make_test_server("a", "stdio")])
            .await;
        // Set to Failed.
        {
            let mut repos = supervisor.repos.write().await;
            let repo = repos.get_mut("repo-1").unwrap();
            let s = repo.servers.get_mut("a").unwrap();
            s.state = McpConnectionState::Failed;
            s.failure_count = 3;
            s.last_error = Some("previous error".to_string());
        }

        let result = supervisor.reconnect_server("repo-1", "a").await;
        assert!(result.is_ok());

        let status = result.unwrap();
        assert_eq!(status.state, McpConnectionState::Connected);
        assert_eq!(status.failure_count, 0);
        assert!(status.last_error.is_none());
    }

    #[tokio::test]
    async fn test_reconnect_bad_server_stays_failed() {
        let supervisor = McpSupervisor::new();
        supervisor
            .init_repo(
                "repo-1",
                vec![McpServer {
                    name: "bad".to_string(),
                    config: serde_json::json!({"type": "stdio", "command": "nonexistent_binary_xyz_12345"}),
                    source: crate::mcp::McpSource::UserProjectConfig,
                }],
            )
            .await;

        let result = supervisor.reconnect_server("repo-1", "bad").await;
        // reconnect_server returns Ok with the status even on failure.
        assert!(result.is_ok());
        let status = result.unwrap();
        assert_eq!(status.state, McpConnectionState::Failed);
        assert!(status.failure_count > 0);
        assert!(status.last_error.is_some());
    }

    #[tokio::test]
    async fn test_reconnect_nonexistent_server_errors() {
        let supervisor = McpSupervisor::new();
        supervisor
            .init_repo("repo-1", vec![make_test_server("a", "stdio")])
            .await;

        let result = supervisor.reconnect_server("repo-1", "nope").await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }

    #[tokio::test]
    async fn test_reconnect_nonexistent_repo_errors() {
        let supervisor = McpSupervisor::new();
        let result = supervisor.reconnect_server("nope", "a").await;
        assert!(result.is_err());
    }

    // -- get_status direct --

    #[tokio::test]
    async fn test_get_status_returns_all_servers() {
        let supervisor = McpSupervisor::new();
        supervisor
            .init_repo(
                "repo-1",
                vec![
                    make_test_server("a", "stdio"),
                    make_test_server("b", "http"),
                    make_test_server("c", "sse"),
                ],
            )
            .await;

        let status = supervisor.get_status("repo-1").await.unwrap();
        assert_eq!(status.repository_id, "repo-1");
        assert_eq!(status.servers.len(), 3);
        // Each server should have correct transport.
        let a = status.servers.iter().find(|s| s.name == "a").unwrap();
        assert_eq!(a.transport, McpTransport::Stdio);
        let b = status.servers.iter().find(|s| s.name == "b").unwrap();
        assert_eq!(b.transport, McpTransport::Http);
        let c = status.servers.iter().find(|s| s.name == "c").unwrap();
        assert_eq!(c.transport, McpTransport::Sse);
    }

    // -- watch channel multiple repos --

    #[tokio::test]
    async fn test_watch_channel_independent_per_repo() {
        let supervisor = McpSupervisor::new();
        supervisor
            .init_repo("repo-1", vec![make_test_server("a", "stdio")])
            .await;
        supervisor
            .init_repo("repo-2", vec![make_test_server("b", "stdio")])
            .await;

        let mut rx1 = supervisor.subscribe("repo-1").await.unwrap();
        let mut rx2 = supervisor.subscribe("repo-2").await.unwrap();

        rx1.borrow_and_update();
        rx2.borrow_and_update();

        // Change in repo-1 should not notify repo-2.
        supervisor.set_server_enabled("repo-1", "a", false).await;

        rx1.changed().await.unwrap();
        let snap1 = rx1.borrow().clone();
        assert_eq!(snap1.servers[0].state, McpConnectionState::Disabled);

        // rx2 should not have changed.
        assert!(rx2.has_changed().is_err() || !rx2.has_changed().unwrap_or(true));
    }

    // -- backoff with custom config --

    #[test]
    fn test_backoff_with_custom_config() {
        let config = BackoffConfig {
            base_ms: 500,
            max_ms: 5000,
            multiplier: 3.0,
            max_attempts: 10,
        };
        assert_eq!(calculate_backoff(&config, 0), Duration::from_millis(500));
        // 500 * 3^1 = 1500
        assert_eq!(calculate_backoff(&config, 1), Duration::from_millis(1500));
        // 500 * 3^2 = 4500
        assert_eq!(calculate_backoff(&config, 2), Duration::from_millis(4500));
        // 500 * 3^3 = 13500, capped to 5000
        assert_eq!(calculate_backoff(&config, 3), Duration::from_millis(5000));
    }

    // -- validate_stdio_server edge cases --

    #[tokio::test]
    async fn test_validate_stdio_server_missing_command_field() {
        let config = serde_json::json!({"type": "stdio"});
        let result = validate_stdio_server(&config).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("missing"));
    }

    // -- validate_remote_server edge cases --

    #[tokio::test]
    async fn test_validate_remote_server_missing_url() {
        let config = serde_json::json!({"type": "http"});
        let result = validate_remote_server(&config).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("missing"));
    }

    #[tokio::test]
    async fn test_validate_remote_server_invalid_url() {
        let config = serde_json::json!({"type": "http", "url": "not-a-url"});
        let result = validate_remote_server(&config).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_init_repo_with_enabled() {
        let supervisor = McpSupervisor::new();
        supervisor
            .init_repo_with_enabled(
                "repo-1",
                vec![
                    (make_test_server("a", "stdio"), true),
                    (make_test_server("b", "http"), false),
                ],
            )
            .await;

        let status = supervisor.get_status("repo-1").await.unwrap();
        let a = status.servers.iter().find(|s| s.name == "a").unwrap();
        let b = status.servers.iter().find(|s| s.name == "b").unwrap();
        assert!(a.enabled);
        assert_eq!(a.state, McpConnectionState::Pending);
        assert!(!b.enabled);
        assert_eq!(b.state, McpConnectionState::Disabled);
    }

    #[tokio::test]
    async fn test_init_repo_with_empty_clears_stale_servers() {
        let supervisor = McpSupervisor::new();
        // Start with servers.
        supervisor
            .init_repo("repo-1", vec![make_test_server("a", "stdio")])
            .await;
        assert_eq!(
            supervisor.get_status("repo-1").await.unwrap().servers.len(),
            1
        );

        // Re-init with empty list — stale servers should be cleared.
        supervisor.init_repo_with_enabled("repo-1", vec![]).await;
        let status = supervisor.get_status("repo-1").await.unwrap();
        assert!(
            status.servers.is_empty(),
            "expected stale servers to be cleared"
        );
    }
}
