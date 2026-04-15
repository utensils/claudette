use std::sync::Arc;

use tauri::State;

use claudette::db::{Database, RepositoryMcpServer};
use claudette::mcp::{self, McpServer};
use claudette::mcp_supervisor::{McpServerStatus, McpStatusSnapshot, McpSupervisor};

use crate::state::AppState;

/// Detect non-portable MCP servers for a repository.
#[tauri::command]
pub async fn detect_mcp_servers(
    repo_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<McpServer>, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let repo = db
        .get_repository(&repo_id)
        .map_err(|e| e.to_string())?
        .ok_or("Repository not found")?;

    let repo_path = std::path::Path::new(&repo.path);
    tokio::task::spawn_blocking({
        let path = repo_path.to_path_buf();
        move || mcp::detect_mcp_servers(&path)
    })
    .await
    .map_err(|e| e.to_string())
}

/// Save selected MCP servers for a repository (replaces any existing).
///
/// Respects `~/.claude.json` `disabledMcpServers` for initial enabled state.
#[tauri::command]
pub async fn save_repository_mcps(
    repo_id: String,
    servers: Vec<McpServer>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;

    // Read disabled list from ~/.claude.json so initial enabled state matches.
    let repo = db.get_repository(&repo_id).map_err(|e| e.to_string())?;
    let disabled_list = repo
        .as_ref()
        .map(|r| mcp::get_disabled_servers(std::path::Path::new(&r.path)))
        .unwrap_or_default();

    let rows: Vec<RepositoryMcpServer> = servers
        .into_iter()
        .map(|s| {
            let config_json = serde_json::to_string(&s.config)
                .map_err(|e| format!("Invalid config JSON for {}: {e}", s.name))?;
            let enabled = !disabled_list.contains(&s.name);
            Ok(RepositoryMcpServer {
                id: uuid::Uuid::new_v4().to_string(),
                repository_id: repo_id.clone(),
                name: s.name,
                config_json,
                source: serde_json::to_string(&s.source)
                    .unwrap_or_default()
                    .trim_matches('"')
                    .to_string(),
                created_at: String::new(), // DB default
                enabled,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;

    db.replace_repository_mcp_servers(&repo_id, &rows)
        .map_err(|e| e.to_string())
}

/// Load saved MCP servers for a repository.
#[tauri::command]
pub async fn load_repository_mcps(
    repo_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<RepositoryMcpServer>, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.list_repository_mcp_servers(&repo_id)
        .map_err(|e| e.to_string())
}

/// Delete a single MCP server from a repository's saved config.
#[tauri::command]
pub async fn delete_repository_mcp(
    server_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.delete_repository_mcp_server(&server_id)
        .map_err(|e| e.to_string())
}

/// Get MCP server status for a repository from the supervisor.
#[tauri::command]
pub async fn get_mcp_status(
    repo_id: String,
    supervisor: State<'_, Arc<McpSupervisor>>,
) -> Result<Option<McpStatusSnapshot>, String> {
    Ok(supervisor.get_status(&repo_id).await)
}

/// Detect, merge, initialize supervisor, and validate MCP servers for a repo.
///
/// Always re-detects from all sources and merges with existing DB state:
/// - New servers are added (preserving disabled list from ~/.claude.json)
/// - Removed servers are dropped
/// - Existing servers keep their enabled state
///
/// Called when a workspace is selected or the connectors menu opens. Returns
/// the validated status snapshot with connected/failed states.
#[tauri::command]
pub async fn ensure_and_validate_mcps(
    repo_id: String,
    state: State<'_, AppState>,
    supervisor: State<'_, Arc<McpSupervisor>>,
) -> Result<McpStatusSnapshot, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let repo = db
        .get_repository(&repo_id)
        .map_err(|e| e.to_string())?
        .ok_or("Repository not found")?;
    let repo_path = std::path::Path::new(&repo.path);

    // Always re-detect from all sources (user, project, plugins).
    let detected = tokio::task::spawn_blocking({
        let path = repo_path.to_path_buf();
        move || mcp::detect_mcp_servers(&path)
    })
    .await
    .map_err(|e| e.to_string())?;

    // Merge with existing DB state: preserve enabled flags for known servers,
    // add new ones respecting ~/.claude.json disabledMcpServers.
    let existing = db
        .list_repository_mcp_servers(&repo_id)
        .unwrap_or_else(|e| {
            eprintln!("[mcp] Failed to load existing MCP servers for {repo_id}: {e}");
            Vec::new()
        });
    let existing_by_name: std::collections::HashMap<String, &RepositoryMcpServer> =
        existing.iter().map(|s| (s.name.clone(), s)).collect();
    let disabled_list = mcp::get_disabled_servers(repo_path);

    let rows: Vec<RepositoryMcpServer> = detected
        .into_iter()
        .map(|s| {
            let config_json = serde_json::to_string(&s.config).unwrap_or_default();
            // Preserve existing enabled state, or use disabled list for new servers.
            let enabled = existing_by_name
                .get(&s.name)
                .map(|e| e.enabled)
                .unwrap_or_else(|| !disabled_list.contains(&s.name));
            let id = existing_by_name
                .get(&s.name)
                .map(|e| e.id.clone())
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            RepositoryMcpServer {
                id,
                repository_id: repo_id.clone(),
                name: s.name,
                config_json,
                source: serde_json::to_string(&s.source)
                    .unwrap_or_default()
                    .trim_matches('"')
                    .to_string(),
                created_at: String::new(),
                enabled,
            }
        })
        .collect();

    // Always replace — even with an empty vec — so removed servers are dropped.
    if let Err(e) = db.replace_repository_mcp_servers(&repo_id, &rows) {
        eprintln!("[mcp] Failed to persist MCP servers for {repo_id}: {e}");
    }

    let saved = db
        .list_repository_mcp_servers(&repo_id)
        .unwrap_or_else(|e| {
            eprintln!("[mcp] Failed to reload MCP servers for {repo_id}: {e}");
            Vec::new()
        });

    // Initialize supervisor from persisted state (including empty, so stale
    // in-memory servers are cleared) and validate enabled servers.
    supervisor
        .init_repo_with_enabled(&repo_id, mcp::rows_to_servers(&saved))
        .await;
    if !saved.is_empty() {
        supervisor.validate_servers(&repo_id).await;
    }

    Ok(supervisor
        .get_status(&repo_id)
        .await
        .unwrap_or(McpStatusSnapshot {
            repository_id: repo_id,
            servers: Vec::new(),
        }))
}

/// Manually reconnect a specific MCP server.
#[tauri::command]
pub async fn reconnect_mcp_server(
    repo_id: String,
    server_name: String,
    supervisor: State<'_, Arc<McpSupervisor>>,
) -> Result<McpServerStatus, String> {
    supervisor.reconnect_server(&repo_id, &server_name).await
}

/// Enable or disable a specific MCP server.
///
/// Persists to both our DB and `~/.claude.json` `disabledMcpServers` so the
/// CLI respects the toggle for auto-discovered servers (global, project).
/// Also invalidates any active persistent sessions for workspaces in this repo
/// so the next turn starts a fresh process with the updated MCP config.
#[tauri::command]
pub async fn set_mcp_server_enabled(
    server_id: String,
    repo_id: String,
    server_name: String,
    enabled: bool,
    state: State<'_, AppState>,
    supervisor: State<'_, Arc<McpSupervisor>>,
) -> Result<(), String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;

    // Persist enabled state in our DB.
    db.set_mcp_server_enabled(&server_id, enabled)
        .map_err(|e| e.to_string())?;

    // Also write to ~/.claude.json disabledMcpServers so the CLI respects
    // the toggle for auto-discovered servers (global, .mcp.json).
    let repo = db.get_repository(&repo_id).map_err(|e| e.to_string())?;
    if let Some(ref repo) = repo {
        let repo_path = std::path::Path::new(&repo.path);
        if let Err(e) =
            claudette::mcp::set_server_disabled_in_config(repo_path, &server_name, !enabled)
        {
            eprintln!("[mcp] Failed to update ~/.claude.json: {e}");
        }
    }

    // Update supervisor in-memory state.
    supervisor
        .set_server_enabled(&repo_id, &server_name, enabled)
        .await;

    // Invalidate persistent sessions for all workspaces in this repo so the
    // next turn starts a fresh process with the updated MCP config.
    // Collect PIDs under the lock, then drop it before awaiting stop_agent
    // to avoid blocking other workspace commands during process shutdown.
    let workspaces = db.list_workspaces().unwrap_or_default();
    let repo_workspace_ids: Vec<String> = workspaces
        .iter()
        .filter(|w| w.repository_id == repo_id)
        .map(|w| w.id.clone())
        .collect();

    let pids_to_stop = {
        let mut agents = state.agents.write().await;
        let mut pids = Vec::new();
        for ws_id in &repo_workspace_ids {
            if let Some(session) = agents.get_mut(ws_id) {
                if let Some(pid) = session.active_pid.take() {
                    pids.push(pid);
                }
                session.persistent_session = None;
            }
        }
        pids
    };

    for pid in pids_to_stop {
        let _ = claudette::agent::stop_agent(pid).await;
    }

    Ok(())
}
