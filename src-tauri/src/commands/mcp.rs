use tauri::State;

use claudette::db::{Database, RepositoryMcpServer};
use claudette::mcp::{self, McpServer};

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
#[tauri::command]
pub async fn save_repository_mcps(
    repo_id: String,
    servers: Vec<McpServer>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;

    let rows: Vec<RepositoryMcpServer> = servers
        .into_iter()
        .map(|s| {
            // Validate config is valid JSON before storing.
            let config_json = serde_json::to_string(&s.config)
                .map_err(|e| format!("Invalid config JSON for {}: {e}", s.name))?;
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
