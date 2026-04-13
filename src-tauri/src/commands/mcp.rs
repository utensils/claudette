//! Tauri commands for MCP configuration detection and management

use claudette::db::Database;
use claudette::mcp::{
    detect_mcp_servers as detect_mcp, parse_mcp_config, write_workspace_mcp_config, McpScope,
    McpServer,
};
use std::path::PathBuf;
use tauri::State;

use crate::state::AppState;

/// Detect all MCP servers for a repository
#[tauri::command]
pub async fn detect_mcp_servers(
    repo_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<McpServer>, String> {
    // Get repository path from database
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let repo = db
        .get_repository(&repo_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Repository not found: {}", repo_id))?;

    let repo_path = PathBuf::from(&repo.path);

    // Detect MCP servers
    detect_mcp(&repo_path).await
}

/// Write MCP configuration to workspace .claude.json
#[tauri::command]
pub async fn configure_workspace_mcps(
    workspace_id: String,
    servers: Vec<McpServer>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Get workspace worktree path from database
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let workspaces = db.list_workspaces().map_err(|e| e.to_string())?;

    let workspace = workspaces
        .into_iter()
        .find(|ws| ws.id == workspace_id)
        .ok_or_else(|| format!("Workspace not found: {}", workspace_id))?;

    let worktree_path = workspace
        .worktree_path
        .ok_or_else(|| format!("Workspace {} has no worktree path", workspace_id))?;

    let worktree_path = PathBuf::from(&worktree_path);

    // Write MCP configuration
    write_workspace_mcp_config(&worktree_path, &servers).await
}

/// Read workspace .claude.json MCP configuration
#[tauri::command]
pub async fn read_workspace_mcps(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<McpServer>, String> {
    // Get workspace worktree path
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let workspaces = db.list_workspaces().map_err(|e| e.to_string())?;

    let workspace = workspaces
        .into_iter()
        .find(|ws| ws.id == workspace_id)
        .ok_or_else(|| format!("Workspace not found: {}", workspace_id))?;

    let worktree_path = workspace
        .worktree_path
        .ok_or_else(|| format!("Workspace {} has no worktree path", workspace_id))?;

    let worktree_path = PathBuf::from(&worktree_path);
    let config_path = worktree_path.join(".claude.json");

    // Use the shared parsing function from claudette::mcp
    // (use Local scope since it's workspace-specific)
    parse_mcp_config(&config_path, McpScope::Local).await
}
