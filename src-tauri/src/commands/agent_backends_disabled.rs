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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
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
        warnings: Vec::new(),
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
    db: &claudette::db::Database,
    backend_id: Option<&str>,
    model: Option<&str>,
) -> Result<(Option<String>, Option<String>), String> {
    let backend = backend_id
        .map(str::trim)
        .filter(|backend| !backend.is_empty());
    let requested_model = model.map(str::trim).filter(|model| !model.is_empty());

    if matches!(backend, Some("anthropic")) {
        return Ok((
            Some("anthropic".to_string()),
            requested_model
                .filter(|model| looks_like_claude_model(model))
                .map(ToString::to_string),
        ));
    }

    if backend.is_some() {
        return Ok((
            Some("anthropic".to_string()),
            disabled_build_default_model(db)?,
        ));
    }

    Ok((
        None,
        requested_model
            .filter(|model| looks_like_claude_model(model))
            .map(ToString::to_string),
    ))
}

fn disabled_build_default_model(db: &claudette::db::Database) -> Result<Option<String>, String> {
    let default_backend = db
        .get_app_setting("default_agent_backend")
        .map_err(|e| e.to_string())?
        .filter(|backend| !backend.trim().is_empty())
        .unwrap_or_else(|| "anthropic".to_string());
    if default_backend != "anthropic" {
        return Ok(None);
    }
    Ok(db
        .get_app_setting("default_model")
        .map_err(|e| e.to_string())?
        .filter(|model| looks_like_claude_model(model)))
}

fn looks_like_claude_model(model: &str) -> bool {
    let model = model.trim().to_ascii_lowercase();
    matches!(model.as_str(), "opus" | "sonnet" | "haiku")
        || model.starts_with("claude-")
        || model.contains("/claude-")
}

#[cfg(test)]
mod tests {
    use super::*;
    use claudette::db::Database;

    #[test]
    fn disabled_defaults_drop_non_anthropic_provider_and_model() {
        let db = Database::open_in_memory().expect("test db should open");
        db.set_app_setting("default_agent_backend", "codex-subscription")
            .expect("setting should save");
        db.set_app_setting("default_model", "gpt-5.5")
            .expect("setting should save");

        let (backend, model) =
            resolve_backend_request_defaults(&db, Some("codex-subscription"), Some("gpt-5.5"))
                .expect("defaults should resolve");

        assert_eq!(backend.as_deref(), Some("anthropic"));
        assert_eq!(model, None);
    }

    #[test]
    fn disabled_defaults_preserve_anthropic_models() {
        let db = Database::open_in_memory().expect("test db should open");

        let (backend, model) =
            resolve_backend_request_defaults(&db, Some("anthropic"), Some("claude-opus-4-7"))
                .expect("defaults should resolve");

        assert_eq!(backend.as_deref(), Some("anthropic"));
        assert_eq!(model.as_deref(), Some("claude-opus-4-7"));
    }

    #[test]
    fn disabled_defaults_use_saved_claude_default_for_stale_provider_request() {
        let db = Database::open_in_memory().expect("test db should open");
        db.set_app_setting("default_agent_backend", "anthropic")
            .expect("setting should save");
        db.set_app_setting("default_model", "sonnet")
            .expect("setting should save");

        let (backend, model) =
            resolve_backend_request_defaults(&db, Some("ollama"), Some("qwen3-coder"))
                .expect("defaults should resolve");

        assert_eq!(backend.as_deref(), Some("anthropic"));
        assert_eq!(model.as_deref(), Some("sonnet"));
    }
}
