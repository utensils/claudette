use serde::{Deserialize, Serialize};
use tauri::State;

use claudette::agent_backend::{AgentBackendConfig, AgentBackendRuntime};

use crate::state::AppState;

#[derive(Default)]
pub struct BackendGateway;

impl BackendGateway {
    pub fn new() -> Self {
        Self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackendStatus {
    pub ok: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backends: Option<Vec<AgentBackendConfig>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackendListResponse {
    pub backends: Vec<AgentBackendConfig>,
    pub default_backend_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackendSecretUpdate {
    pub backend_id: String,
    pub value: Option<String>,
}

fn disabled_error() -> String {
    "Alternative Claude Code backends were not compiled into this build".to_string()
}

#[tauri::command]
pub async fn list_agent_backends(
    _state: State<'_, AppState>,
) -> Result<BackendListResponse, String> {
    Ok(BackendListResponse {
        backends: vec![AgentBackendConfig::builtin_anthropic()],
        default_backend_id: "anthropic".to_string(),
    })
}

#[tauri::command]
pub async fn save_agent_backend(
    _backend: AgentBackendConfig,
    _state: State<'_, AppState>,
) -> Result<Vec<AgentBackendConfig>, String> {
    Err(disabled_error())
}

#[tauri::command]
pub async fn delete_agent_backend(
    _backend_id: String,
    _state: State<'_, AppState>,
) -> Result<Vec<AgentBackendConfig>, String> {
    Err(disabled_error())
}

#[tauri::command]
pub async fn save_agent_backend_secret(_update: BackendSecretUpdate) -> Result<(), String> {
    Err(disabled_error())
}

#[tauri::command]
pub async fn refresh_agent_backend_models(
    _backend_id: String,
    _state: State<'_, AppState>,
) -> Result<Vec<AgentBackendConfig>, String> {
    Err(disabled_error())
}

#[tauri::command]
pub async fn test_agent_backend(
    _backend_id: String,
    _state: State<'_, AppState>,
) -> Result<BackendStatus, String> {
    Ok(BackendStatus {
        ok: false,
        message: disabled_error(),
        backends: None,
    })
}

#[tauri::command]
pub async fn launch_codex_login() -> Result<(), String> {
    Err(disabled_error())
}

pub async fn resolve_backend_runtime(
    _state: &AppState,
    _backend_id: Option<&str>,
    _model: Option<&str>,
) -> Result<AgentBackendRuntime, String> {
    Ok(AgentBackendRuntime::default())
}

pub fn resolve_backend_request_defaults(
    _db: &claudette::db::Database,
    backend_id: Option<&str>,
    model: Option<&str>,
) -> Result<(Option<String>, Option<String>), String> {
    Ok((
        backend_id
            .map(str::trim)
            .filter(|backend| !backend.is_empty())
            .map(ToString::to_string),
        model
            .map(str::trim)
            .filter(|model| !model.is_empty())
            .map(ToString::to_string),
    ))
}
