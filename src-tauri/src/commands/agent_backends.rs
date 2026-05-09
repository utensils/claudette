use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::Arc;

use base64::Engine as _;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Notify, RwLock};

use claudette::agent_backend::{
    AgentBackendConfig, AgentBackendKind, AgentBackendModel, AgentBackendRuntime,
};
use claudette::db::Database;
use claudette::plugin::{delete_secure_secret, load_secure_secret, save_secure_secret};

use crate::state::AppState;

const SETTINGS_KEY: &str = "agent_backends_config";
const SECRET_BUCKET: &str = "agentBackendSecrets";
const BACKEND_RUNTIME_ENV_VERSION: u8 = 2;
const CODEX_DEFAULT_BASE_URL: &str = "https://chatgpt.com/backend-api";
const CODEX_JWT_AUTH_CLAIM: &str = "https://api.openai.com/auth";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackendStatus {
    pub ok: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backends: Option<Vec<AgentBackendConfig>>,
}

impl BackendStatus {
    fn new(ok: bool, message: impl Into<String>) -> Self {
        Self {
            ok,
            message: message.into(),
            backends: None,
        }
    }
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

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CodexAuthMaterial {
    access_token: String,
    account_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CodexAuthJson {
    auth_mode: Option<String>,
    #[serde(rename = "OPENAI_API_KEY")]
    openai_api_key: Option<String>,
    tokens: Option<CodexAuthTokens>,
}

#[derive(Debug, Deserialize)]
struct CodexAuthTokens {
    access_token: String,
    account_id: Option<String>,
}

#[derive(Debug, Clone)]
struct GatewayServer {
    base_url: String,
    auth_token: String,
    hash: String,
    cancel: Arc<Notify>,
}

#[derive(Default)]
pub struct BackendGateway {
    servers: RwLock<HashMap<String, GatewayServer>>,
}

impl BackendGateway {
    pub fn new() -> Self {
        Self::default()
    }

    async fn ensure(
        &self,
        config: AgentBackendConfig,
        upstream_secret: Option<String>,
        model: Option<String>,
    ) -> Result<(String, String, String), String> {
        let hash = runtime_hash(&config, upstream_secret.as_deref(), model.as_deref());
        if let Some(existing) = self.servers.read().await.get(&config.id)
            && existing.hash == hash
        {
            // Reuse path: every chat session that hits the same backend
            // with matching (config, secret, model) shares this single
            // gateway URL + auth token. Stamp the reuse so a postmortem
            // can tell when N concurrent sessions are funneling through
            // one process — the cardinality matters for diagnosing
            // whether a leak rides on the shared surface.
            tracing::debug!(
                target: "claudette::backend",
                backend_id = %config.id,
                model = ?model,
                base_url = %existing.base_url,
                "gateway reuse"
            );
            return Ok((existing.base_url.clone(), existing.auth_token.clone(), hash));
        }

        if let Some(existing) = self.servers.write().await.remove(&config.id) {
            tracing::info!(
                target: "claudette::backend",
                backend_id = %config.id,
                model = ?model,
                "config drift — tearing down old gateway"
            );
            existing.cancel.notify_waiters();
        }

        let listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|e| format!("Failed to bind backend gateway: {e}"))?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("Failed to read gateway address: {e}"))?
            .port();
        let base_url = format!("http://127.0.0.1:{port}");
        let auth_token = generate_gateway_token();
        let cancel = Arc::new(Notify::new());
        let server = GatewayServer {
            base_url: base_url.clone(),
            auth_token: auth_token.clone(),
            hash: hash.clone(),
            cancel: Arc::clone(&cancel),
        };
        self.servers.write().await.insert(config.id.clone(), server);

        tokio::spawn(run_gateway(
            listener,
            cancel,
            config,
            upstream_secret,
            auth_token.clone(),
        ));
        Ok((base_url, auth_token, hash))
    }
}

fn generate_gateway_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

#[tauri::command]
pub async fn list_agent_backends(
    state: State<'_, AppState>,
) -> Result<BackendListResponse, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let default_backend_id = db
        .get_app_setting("default_agent_backend")
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| "anthropic".to_string());
    Ok(BackendListResponse {
        backends: load_backend_configs(&db)?,
        default_backend_id,
    })
}

#[tauri::command]
pub async fn save_agent_backend(
    backend: AgentBackendConfig,
    state: State<'_, AppState>,
) -> Result<Vec<AgentBackendConfig>, String> {
    if backend.id == "anthropic" {
        return Err("The built-in Claude Code backend cannot be overwritten".to_string());
    }
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let mut backends = load_backend_configs(&db)?;
    if let Some(existing) = backends.iter_mut().find(|b| b.id == backend.id) {
        *existing = normalize_backend(backend);
    } else {
        backends.push(normalize_backend(backend));
    }
    save_backend_configs(&db, &backends)?;
    load_backend_configs(&db)
}

#[tauri::command]
pub async fn delete_agent_backend(
    backend_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<AgentBackendConfig>, String> {
    if matches!(
        backend_id.as_str(),
        "anthropic" | "ollama" | "openai-api" | "codex-subscription"
    ) {
        return Err("Built-in backends can be disabled but not deleted".to_string());
    }
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let mut backends = load_backend_configs(&db)?;
    backends.retain(|backend| backend.id != backend_id);
    save_backend_configs(&db, &backends)?;
    let _ = delete_secure_secret(SECRET_BUCKET, &backend_id);
    load_backend_configs(&db)
}

#[tauri::command]
pub async fn save_agent_backend_secret(update: BackendSecretUpdate) -> Result<(), String> {
    match update.value {
        Some(value) if !value.is_empty() => {
            save_secure_secret(SECRET_BUCKET, &update.backend_id, &value)
        }
        _ => delete_secure_secret(SECRET_BUCKET, &update.backend_id),
    }
}

#[tauri::command]
pub async fn refresh_agent_backend_models(
    backend_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<AgentBackendConfig>, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let mut backends = load_backend_configs(&db)?;
    let idx = backends
        .iter()
        .position(|backend| backend.id == backend_id)
        .ok_or_else(|| format!("Unknown backend `{backend_id}`"))?;
    let discovered = discover_models(&backends[idx]).await?;
    apply_discovered_models(&mut backends[idx], discovered);
    save_backend_configs(&db, &backends)?;
    load_backend_configs(&db)
}

#[tauri::command]
pub async fn test_agent_backend(
    backend_id: String,
    state: State<'_, AppState>,
) -> Result<BackendStatus, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let backend = find_backend(&db, Some(&backend_id))?;
    let mut status = test_backend_connectivity(&backend).await?;
    if status.ok && backend.model_discovery {
        let mut backends = load_backend_configs(&db)?;
        if let Some(idx) = backends.iter().position(|item| item.id == backend_id) {
            let discovered = discover_models(&backends[idx]).await?;
            apply_discovered_models(&mut backends[idx], discovered);
            save_backend_configs(&db, &backends)?;
            status.backends = Some(load_backend_configs(&db)?);
        }
    }
    Ok(status)
}

#[tauri::command]
pub async fn launch_codex_login() -> Result<(), String> {
    let mut child = tokio::process::Command::new("codex")
        .arg("login")
        .spawn()
        .map_err(|e| format!("Failed to launch `codex login`: {e}"))?;
    tokio::spawn(async move {
        let _ = child.wait().await;
    });
    Ok(())
}

pub async fn resolve_backend_runtime(
    state: &AppState,
    backend_id: Option<&str>,
    model: Option<&str>,
) -> Result<AgentBackendRuntime, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let enabled = db
        .get_app_setting("alternative_backends_enabled")
        .map_err(|e| e.to_string())?
        .as_deref()
        == Some("true");
    if !enabled {
        return Ok(AgentBackendRuntime::default());
    }
    let backends = load_backend_configs(&db)?;
    let default_backend_id = db
        .get_app_setting("default_agent_backend")
        .map_err(|e| e.to_string())?;
    let mut backend =
        select_backend_for_request(&backends, backend_id, model, default_backend_id.as_deref())?;
    if backend.kind == AgentBackendKind::Anthropic {
        return Ok(AgentBackendRuntime {
            backend_id: Some(backend.id),
            env: Vec::new(),
            hash: String::new(),
        });
    }
    if !backend.enabled {
        return Err(format!("Backend `{}` is disabled", backend.label));
    }

    let secret = if backend.kind == AgentBackendKind::CodexSubscription {
        Some(serde_json::to_string(&load_codex_auth_material()?).map_err(|e| e.to_string())?)
    } else {
        load_secure_secret(SECRET_BUCKET, &backend.id)?
    };
    if backend.kind.needs_gateway() {
        if backend.kind == AgentBackendKind::OpenAiApi && secret.is_none() {
            return Err("OpenAI API backend requires an API key in Settings → Models".to_string());
        }
        hydrate_gateway_models_for_runtime(&mut backend, model).await?;
        if let Some(model) = model.map(str::trim).filter(|model| !model.is_empty()) {
            backend.default_model = Some(model.to_string());
        }
        let (gateway_url, gateway_token, hash) = state
            .backend_gateway
            .ensure(backend.clone(), secret, model.map(String::from))
            .await?;
        let mut env = vec![
            ("ANTHROPIC_BASE_URL".to_string(), gateway_url),
            ("ANTHROPIC_AUTH_TOKEN".to_string(), gateway_token),
            (
                "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY".to_string(),
                "1".to_string(),
            ),
        ];
        append_custom_model_env(&mut env, &backend, model);
        return Ok(AgentBackendRuntime {
            backend_id: Some(backend.id),
            env,
            hash,
        });
    }

    let base_url = backend
        .base_url
        .clone()
        .unwrap_or_else(|| "http://localhost:11434".to_string());
    let mut env = vec![
        ("ANTHROPIC_BASE_URL".to_string(), base_url),
        (
            "ANTHROPIC_AUTH_TOKEN".to_string(),
            secret.clone().unwrap_or_else(|| "ollama".to_string()),
        ),
    ];
    if backend.kind == AgentBackendKind::Ollama {
        env.push(("ANTHROPIC_API_KEY".to_string(), String::new()));
    } else if let Some(secret) = secret.clone() {
        env.push(("ANTHROPIC_API_KEY".to_string(), secret));
    }
    if backend.model_discovery {
        env.push((
            "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY".to_string(),
            "1".to_string(),
        ));
    }
    append_custom_model_env(&mut env, &backend, model);
    Ok(AgentBackendRuntime {
        backend_id: Some(backend.id.clone()),
        env,
        hash: runtime_hash(&backend, secret.as_deref(), model),
    })
}

pub fn resolve_backend_request_defaults(
    db: &Database,
    backend_id: Option<&str>,
    model: Option<&str>,
) -> Result<(Option<String>, Option<String>), String> {
    let requested_model = model
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .map(ToString::to_string);
    let requested_backend = backend_id
        .map(str::trim)
        .filter(|backend| !backend.is_empty())
        .map(ToString::to_string);
    let enabled = db
        .get_app_setting("alternative_backends_enabled")
        .map_err(|e| e.to_string())?
        .as_deref()
        == Some("true");
    if !enabled {
        return Ok((requested_backend, requested_model));
    }

    let backends = load_backend_configs(db)?;
    if requested_model.is_some() {
        return Ok((requested_backend, requested_model));
    }

    if let Some(backend_id) = requested_backend.as_deref() {
        let backend = backends
            .iter()
            .find(|backend| backend.id == backend_id)
            .ok_or_else(|| format!("Unknown backend `{backend_id}`"))?;
        let model = if backend.kind == AgentBackendKind::Anthropic {
            None
        } else {
            backend.default_model.clone().or_else(|| {
                backend
                    .discovered_models
                    .first()
                    .or_else(|| backend.manual_models.first())
                    .map(|model| model.id.clone())
            })
        };
        return Ok((requested_backend, model));
    }

    let default_backend_id = db
        .get_app_setting("default_agent_backend")
        .map_err(|e| e.to_string())?
        .filter(|backend| !backend.trim().is_empty())
        .unwrap_or_else(|| "anthropic".to_string());
    let default_model = db
        .get_app_setting("default_model")
        .map_err(|e| e.to_string())?
        .filter(|model| !model.trim().is_empty());
    let Some(backend) = backends
        .iter()
        .find(|backend| backend.id == default_backend_id)
    else {
        return Ok((None, default_model));
    };
    if backend.kind == AgentBackendKind::Anthropic {
        return Ok((Some(backend.id.clone()), default_model));
    }

    let model = default_model
        .filter(|model| backend_models_contain(backend, model))
        .or_else(|| backend.default_model.clone())
        .or_else(|| {
            backend
                .discovered_models
                .first()
                .or_else(|| backend.manual_models.first())
                .map(|model| model.id.clone())
        });
    Ok((Some(backend.id.clone()), model))
}

fn append_custom_model_env(
    env: &mut Vec<(String, String)>,
    backend: &AgentBackendConfig,
    model: Option<&str>,
) {
    let Some(model) = model.filter(|model| !model.trim().is_empty()) else {
        return;
    };
    if backend.kind == AgentBackendKind::Anthropic {
        return;
    }
    env.push((
        "ANTHROPIC_CUSTOM_MODEL_OPTION".to_string(),
        model.to_string(),
    ));
    env.push((
        "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME".to_string(),
        model.to_string(),
    ));
    env.push((
        "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION".to_string(),
        format!("{} via Claudette", backend.label),
    ));
    env.push(("CLAUDE_CODE_SUBAGENT_MODEL".to_string(), model.to_string()));
}

async fn hydrate_gateway_models_for_runtime(
    backend: &mut AgentBackendConfig,
    model: Option<&str>,
) -> Result<(), String> {
    if !matches!(
        backend.kind,
        AgentBackendKind::OpenAiApi | AgentBackendKind::CodexSubscription
    ) {
        return Ok(());
    }
    let has_models = !backend.manual_models.is_empty() || !backend.discovered_models.is_empty();
    let selected_is_known = model
        .map(|model| backend_models_contain(backend, model))
        .unwrap_or(true);
    if has_models && selected_is_known {
        return Ok(());
    }

    let discovered = discover_models(backend).await?;
    if !discovered.is_empty() {
        backend.manual_models.clear();
        backend.discovered_models = discovered;
    }

    if let Some(model) = model
        && !backend_models_contain(backend, model)
    {
        return Err(format!(
            "Selected model `{model}` was not reported by the {} backend. Refresh models or pick an available model.",
            backend.label
        ));
    }
    Ok(())
}

fn backend_models_contain(backend: &AgentBackendConfig, model: &str) -> bool {
    backend
        .manual_models
        .iter()
        .chain(backend.discovered_models.iter())
        .any(|candidate| candidate.id == model)
}

fn apply_discovered_models(backend: &mut AgentBackendConfig, discovered: Vec<AgentBackendModel>) {
    if matches!(
        backend.kind,
        AgentBackendKind::Ollama
            | AgentBackendKind::OpenAiApi
            | AgentBackendKind::CodexSubscription
    ) && !discovered.is_empty()
    {
        backend.manual_models.clear();
        if !backend
            .default_model
            .as_deref()
            .is_some_and(|model| discovered.iter().any(|found| found.id == model))
        {
            backend.default_model = discovered.first().map(|model| model.id.clone());
        }
    }
    backend.discovered_models = discovered;
}

fn load_backend_configs(db: &Database) -> Result<Vec<AgentBackendConfig>, String> {
    let mut backends = default_backends();
    if let Some(raw) = db
        .get_app_setting(SETTINGS_KEY)
        .map_err(|e| e.to_string())?
    {
        for saved in serde_json::from_str::<Vec<AgentBackendConfig>>(&raw)
            .map_err(|e| format!("Failed to parse backend settings: {e}"))?
        {
            if let Some(existing) = backends.iter_mut().find(|b| b.id == saved.id) {
                *existing = normalize_backend(saved);
            } else {
                backends.push(normalize_backend(saved));
            }
        }
    }
    for backend in &mut backends {
        backend.has_secret = load_secure_secret(SECRET_BUCKET, &backend.id)
            .ok()
            .flatten()
            .is_some();
    }
    Ok(backends)
}

fn save_backend_configs(db: &Database, backends: &[AgentBackendConfig]) -> Result<(), String> {
    let persisted: Vec<_> = backends
        .iter()
        .filter(|backend| backend.id != "anthropic")
        .map(|backend| {
            let mut backend = backend.clone();
            backend.has_secret = false;
            backend
        })
        .collect();
    let raw = serde_json::to_string(&persisted).map_err(|e| e.to_string())?;
    db.set_app_setting(SETTINGS_KEY, &raw)
        .map_err(|e| e.to_string())
}

fn default_backends() -> Vec<AgentBackendConfig> {
    vec![
        AgentBackendConfig::builtin_anthropic(),
        AgentBackendConfig::builtin_ollama(),
        AgentBackendConfig::builtin_openai_api(),
        AgentBackendConfig::builtin_codex_subscription(),
    ]
}

fn find_backend(db: &Database, backend_id: Option<&str>) -> Result<AgentBackendConfig, String> {
    let id = backend_id
        .filter(|id| !id.trim().is_empty())
        .unwrap_or("anthropic");
    load_backend_configs(db)?
        .into_iter()
        .find(|backend| backend.id == id)
        .ok_or_else(|| format!("Unknown backend `{id}`"))
}

fn select_backend_for_request(
    backends: &[AgentBackendConfig],
    backend_id: Option<&str>,
    model: Option<&str>,
    default_backend_id: Option<&str>,
) -> Result<AgentBackendConfig, String> {
    let requested = backend_id
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .unwrap_or("anthropic");
    let should_infer = requested == "anthropic" || backend_id.is_none();
    if should_infer
        && let Some(model) = model.map(str::trim).filter(|model| !model.is_empty())
        && let Some(backend) = infer_backend_for_model(backends, model, default_backend_id)
    {
        return Ok(backend.clone());
    }
    backends
        .iter()
        .find(|backend| backend.id == requested)
        .cloned()
        .ok_or_else(|| format!("Unknown backend `{requested}`"))
}

fn infer_backend_for_model<'a>(
    backends: &'a [AgentBackendConfig],
    model: &str,
    default_backend_id: Option<&str>,
) -> Option<&'a AgentBackendConfig> {
    let mut candidates = backends.iter().filter(|backend| {
        backend.enabled
            && backend.kind != AgentBackendKind::Anthropic
            && (backend.default_model.as_deref() == Some(model)
                || backend_models_contain(backend, model))
    });
    if let Some(default_backend_id) = default_backend_id
        && let Some(default_match) = candidates
            .clone()
            .find(|backend| backend.id == default_backend_id)
    {
        return Some(default_match);
    }
    candidates.next()
}

fn normalize_backend(mut backend: AgentBackendConfig) -> AgentBackendConfig {
    if backend.label.trim().is_empty() {
        backend.label = backend.id.clone();
    }
    if backend.context_window_default == 0 {
        backend.context_window_default = 64_000;
    }
    if matches!(
        backend.kind,
        AgentBackendKind::Ollama
            | AgentBackendKind::OpenAiApi
            | AgentBackendKind::CodexSubscription
    ) {
        backend.model_discovery = true;
    }
    for model in backend
        .manual_models
        .iter_mut()
        .chain(backend.discovered_models.iter_mut())
    {
        if model.label.trim().is_empty() {
            model.label = model.id.clone();
        }
        if model.context_window_tokens == 0 {
            model.context_window_tokens = backend.context_window_default;
        }
    }
    clear_manual_models_for_discovery_backend(&mut backend);
    backend
}

fn clear_manual_models_for_discovery_backend(backend: &mut AgentBackendConfig) {
    if matches!(
        backend.kind,
        AgentBackendKind::OpenAiApi | AgentBackendKind::CodexSubscription
    ) {
        backend.manual_models.clear();
    }
}

async fn discover_models(backend: &AgentBackendConfig) -> Result<Vec<AgentBackendModel>, String> {
    let client = reqwest::Client::new();
    match backend.kind {
        AgentBackendKind::Ollama => {
            let base = backend
                .base_url
                .as_deref()
                .unwrap_or("http://localhost:11434")
                .trim_end_matches('/');
            let value = client
                .get(format!("{base}/api/tags"))
                .send()
                .await
                .map_err(|e| format!("Failed to query Ollama: {e}"))?
                .error_for_status()
                .map_err(|e| format!("Ollama model discovery failed: {e}"))?
                .json::<Value>()
                .await
                .map_err(|e| format!("Invalid Ollama model response: {e}"))?;
            Ok(value
                .get("models")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|model| {
                    let id = model
                        .get("model")
                        .or_else(|| model.get("name"))
                        .and_then(Value::as_str)?;
                    Some(AgentBackendModel {
                        id: id.to_string(),
                        label: id.to_string(),
                        context_window_tokens: backend.context_window_default,
                        discovered: true,
                    })
                })
                .collect())
        }
        AgentBackendKind::CustomAnthropic => {
            let base = backend
                .base_url
                .as_deref()
                .ok_or("Custom Anthropic backend needs a base URL")?
                .trim_end_matches('/');
            let mut request = client.get(format!("{base}/v1/models"));
            if let Some(secret) = load_secure_secret(SECRET_BUCKET, &backend.id)? {
                request = request
                    .header("x-api-key", secret)
                    .header("anthropic-version", "2023-06-01");
            }
            let value = request
                .send()
                .await
                .map_err(|e| format!("Failed to query gateway: {e}"))?
                .error_for_status()
                .map_err(|e| format!("Gateway model discovery failed: {e}"))?
                .json::<Value>()
                .await
                .map_err(|e| format!("Invalid gateway model response: {e}"))?;
            Ok(models_from_openai_shape(
                &value,
                backend.context_window_default,
            ))
        }
        AgentBackendKind::OpenAiApi => discover_openai_api_models(backend).await,
        AgentBackendKind::CodexSubscription => discover_codex_models().await,
        _ => Ok(backend.manual_models.clone()),
    }
}

async fn test_backend_connectivity(backend: &AgentBackendConfig) -> Result<BackendStatus, String> {
    match backend.kind {
        AgentBackendKind::Anthropic => Ok(BackendStatus::new(
            true,
            "Using Claude Code's default authentication",
        )),
        AgentBackendKind::CodexSubscription => {
            let status = codex_login_status().await?;
            let models = discover_codex_models().await.unwrap_or_default();
            Ok(BackendStatus::new(
                true,
                format!("{status}. Found {} model(s).", models.len()),
            ))
        }
        AgentBackendKind::OpenAiApi => discover_openai_api_models(backend).await.map(|models| {
            BackendStatus::new(
                true,
                format!("API key works. Found {} model(s).", models.len()),
            )
        }),
        _ => discover_models(backend).await.map(|models| {
            BackendStatus::new(true, format!("Connected. Found {} model(s).", models.len()))
        }),
    }
}

async fn discover_openai_api_models(
    backend: &AgentBackendConfig,
) -> Result<Vec<AgentBackendModel>, String> {
    let secret = load_secure_secret(SECRET_BUCKET, &backend.id)?
        .ok_or("OpenAI API backend requires an API key in Settings -> Models")?;
    let base = backend
        .base_url
        .as_deref()
        .unwrap_or("https://api.openai.com")
        .trim_end_matches('/');
    let value = reqwest::Client::new()
        .get(openai_api_url(base, "models"))
        .bearer_auth(secret)
        .send()
        .await
        .map_err(|e| format!("Failed to query OpenAI models: {e}"))?
        .error_for_status()
        .map_err(|e| format!("OpenAI model discovery failed: {e}"))?
        .json::<Value>()
        .await
        .map_err(|e| format!("Invalid OpenAI model response: {e}"))?;
    Ok(filter_openai_models(models_from_openai_shape(
        &value,
        backend.context_window_default,
    )))
}

async fn discover_codex_models() -> Result<Vec<AgentBackendModel>, String> {
    codex_login_status().await?;
    // Codex does not currently expose a stable model-list API for ChatGPT
    // subscription auth. This experimental backend depends on the CLI debug
    // catalog until Codex publishes a supported discovery surface.
    let output = tokio::process::Command::new("codex")
        .args(["debug", "models"])
        .output()
        .await
        .map_err(|e| format!("Failed to run `codex debug models`: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "`codex debug models` failed".to_string()
        } else {
            format!("`codex debug models` failed: {stderr}")
        });
    }
    let value = serde_json::from_slice::<Value>(&output.stdout)
        .map_err(|e| format!("Invalid Codex model catalog: {e}"))?;
    let models = value
        .get("models")
        .and_then(Value::as_array)
        .ok_or("Codex model catalog did not include `models`")?;
    Ok(models
        .iter()
        .filter(|model| model.get("visibility").and_then(Value::as_str) == Some("list"))
        .filter_map(|model| {
            let id = model.get("slug").and_then(Value::as_str)?;
            let label = model
                .get("display_name")
                .and_then(Value::as_str)
                .unwrap_or(id);
            let context = model
                .get("max_context_window")
                .or_else(|| model.get("context_window"))
                .and_then(Value::as_u64)
                .and_then(|n| u32::try_from(n).ok())
                .unwrap_or(400_000);
            Some(AgentBackendModel {
                id: id.to_string(),
                label: label.to_string(),
                context_window_tokens: context,
                discovered: true,
            })
        })
        .collect())
}

async fn codex_login_status() -> Result<String, String> {
    let output = tokio::process::Command::new("codex")
        .args(["login", "status"])
        .output()
        .await
        .map_err(|e| format!("Failed to run `codex login status`: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "Codex is not authenticated. Run codex login.".to_string()
        } else {
            format!("Codex is not authenticated: {stderr}")
        });
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() {
        Ok("Codex authenticated".to_string())
    } else {
        Ok(stdout)
    }
}

fn load_codex_auth_material() -> Result<CodexAuthMaterial, String> {
    let path = codex_auth_path()?;
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read Codex auth cache at {}: {e}", path.display()))?;
    let auth = serde_json::from_str::<CodexAuthJson>(&raw)
        .map_err(|e| format!("Failed to parse Codex auth cache: {e}"))?;
    match auth.auth_mode.as_deref() {
        Some("chatgpt") | Some("chatgpt_auth_tokens") => {
            let tokens = auth
                .tokens
                .ok_or("Codex auth cache is missing ChatGPT tokens. Run codex login.")?;
            if tokens.access_token.trim().is_empty() {
                return Err(
                    "Codex auth cache has an empty access token. Run codex login.".to_string(),
                );
            }
            Ok(CodexAuthMaterial {
                account_id: tokens
                    .account_id
                    .or_else(|| codex_account_id_from_access_token(&tokens.access_token)),
                access_token: tokens.access_token,
            })
        }
        Some("apikey") | Some("api_key") => {
            let key = auth
                .openai_api_key
                .filter(|key| !key.trim().is_empty())
                .ok_or("Codex API-key auth is missing OPENAI_API_KEY")?;
            Ok(CodexAuthMaterial {
                access_token: key,
                account_id: None,
            })
        }
        Some(other) => Err(format!(
            "Unsupported Codex auth mode `{other}`. Run codex login with ChatGPT or an API key."
        )),
        None => Err("Codex auth cache is missing auth_mode. Run codex login.".to_string()),
    }
}

fn codex_auth_path() -> Result<PathBuf, String> {
    if let Ok(home) = std::env::var("CODEX_HOME")
        && !home.trim().is_empty()
    {
        return Ok(PathBuf::from(home).join("auth.json"));
    }
    let home = dirs::home_dir().ok_or("Could not determine home directory for Codex auth")?;
    Ok(home.join(".codex").join("auth.json"))
}

fn filter_openai_models(models: Vec<AgentBackendModel>) -> Vec<AgentBackendModel> {
    let mut seen = HashSet::new();
    let mut filtered: Vec<_> = models
        .into_iter()
        .filter(|model| is_openai_text_model(&model.id))
        .filter(|model| seen.insert(model.id.clone()))
        .collect();
    filtered.sort_by(|a, b| a.id.cmp(&b.id));
    filtered
}

fn is_openai_text_model(id: &str) -> bool {
    let id = id.to_ascii_lowercase();
    let excluded = [
        "audio",
        "dall-e",
        "embedding",
        "image",
        "moderation",
        "realtime",
        "search",
        "speech",
        "transcribe",
        "tts",
        "whisper",
    ];
    if excluded.iter().any(|needle| id.contains(needle)) {
        return false;
    }
    id.starts_with("gpt-")
        || id.starts_with("o1")
        || id.starts_with("o3")
        || id.starts_with("o4")
        || id.starts_with("codex")
}

fn models_from_openai_shape(value: &Value, default_context: u32) -> Vec<AgentBackendModel> {
    value
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|model| model.get("id").and_then(Value::as_str))
        .map(|id| AgentBackendModel {
            id: id.to_string(),
            label: id.to_string(),
            context_window_tokens: default_context,
            discovered: true,
        })
        .collect()
}

fn openai_api_url(base: &str, path: &str) -> String {
    let base = base.trim_end_matches('/');
    let path = path.trim_start_matches('/');
    if base.ends_with("/v1") {
        format!("{base}/{path}")
    } else {
        format!("{base}/v1/{path}")
    }
}

fn runtime_hash(config: &AgentBackendConfig, secret: Option<&str>, model: Option<&str>) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    BACKEND_RUNTIME_ENV_VERSION.hash(&mut hasher);
    config.id.hash(&mut hasher);
    config.label.hash(&mut hasher);
    backend_kind_hash_key(config.kind).hash(&mut hasher);
    config.base_url.hash(&mut hasher);
    config.enabled.hash(&mut hasher);
    config.default_model.hash(&mut hasher);
    config.model_discovery.hash(&mut hasher);
    model.hash(&mut hasher);
    secret.unwrap_or("").hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn backend_kind_hash_key(kind: AgentBackendKind) -> &'static str {
    match kind {
        AgentBackendKind::Anthropic => "anthropic",
        AgentBackendKind::Ollama => "ollama",
        AgentBackendKind::OpenAiApi => "openai_api",
        AgentBackendKind::CodexSubscription => "codex_subscription",
        AgentBackendKind::CustomAnthropic => "custom_anthropic",
        AgentBackendKind::CustomOpenAi => "custom_openai",
    }
}

async fn run_gateway(
    listener: TcpListener,
    cancel: Arc<Notify>,
    config: AgentBackendConfig,
    upstream_secret: Option<String>,
    auth_token: String,
) {
    let local_addr = listener
        .local_addr()
        .map(|a| a.to_string())
        .unwrap_or_else(|_| "<unknown>".to_string());
    tracing::info!(
        target: "claudette::backend",
        backend_id = %config.id,
        backend_label = %config.label,
        addr = %local_addr,
        "gateway listening"
    );
    loop {
        tokio::select! {
            _ = cancel.notified() => {
                tracing::info!(
                    target: "claudette::backend",
                    backend_id = %config.id,
                    addr = %local_addr,
                    "gateway shutting down"
                );
                break;
            }
            accepted = listener.accept() => {
                let Ok((stream, peer)) = accepted else { continue };
                let config = config.clone();
                let upstream_secret = upstream_secret.clone();
                let auth_token = auth_token.clone();
                let backend_id = config.id.clone();
                tokio::spawn(async move {
                    if let Err(err) =
                        handle_gateway_connection(stream, config, upstream_secret, &auth_token).await
                    {
                        // Connection-scoped errors carry both the
                        // backend id and the peer endpoint so a
                        // postmortem can tie a failure to the specific
                        // Claude CLI process that hit the gateway.
                        tracing::warn!(
                            target: "claudette::backend",
                            backend_id = %backend_id,
                            peer = %peer,
                            error = %err,
                            "gateway connection error"
                        );
                    }
                });
            }
        }
    }
}

async fn handle_gateway_connection(
    mut stream: TcpStream,
    config: AgentBackendConfig,
    upstream_secret: Option<String>,
    auth_token: &str,
) -> Result<(), String> {
    let mut buf = Vec::new();
    let mut tmp = [0_u8; 4096];
    let header_end = loop {
        let n = stream
            .read(&mut tmp)
            .await
            .map_err(|e| format!("read failed: {e}"))?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&tmp[..n]);
        if let Some(pos) = find_header_end(&buf) {
            break pos;
        }
        if buf.len() > 1024 * 1024 {
            return Err("request headers too large".to_string());
        }
    };
    let header = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let mut lines = header.lines();
    let request_line = lines.next().ok_or("missing request line")?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or("").to_string();
    let path = request_parts.next().unwrap_or("").to_string();
    let route_path = route_path(&path);
    if gateway_route_requires_auth(&method, route_path)
        && !gateway_auth_matches(&header, auth_token)
    {
        return write_json_response(
            &mut stream,
            401,
            json!({"type":"error","error":{"type":"authentication_error","message":"Unauthorized"}}),
        )
        .await;
    }
    let content_length = header
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().ok())
                .flatten()
        })
        .unwrap_or(0);
    let body_start = header_end + 4;
    while buf.len() < body_start + content_length {
        let n = stream
            .read(&mut tmp)
            .await
            .map_err(|e| format!("body read failed: {e}"))?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&tmp[..n]);
    }
    let body = &buf[body_start..usize::min(buf.len(), body_start + content_length)];
    match (method.as_str(), route_path) {
        ("HEAD", "/") | ("HEAD", "/health") => write_empty_response(&mut stream, 200).await,
        ("GET", "/health") => write_json_response(&mut stream, 200, json!({"ok": true})).await,
        ("GET", "/v1/models") => {
            let data: Vec<_> = config
                .manual_models
                .iter()
                .chain(config.discovered_models.iter())
                .map(|model| json!({"id": model.id, "display_name": model.label, "type": "model"}))
                .collect();
            write_json_response(&mut stream, 200, json!({"data": data})).await
        }
        ("POST", "/v1/messages/count_tokens") => {
            let req = serde_json::from_slice::<Value>(body).unwrap_or_else(|_| json!({}));
            let approx = req.to_string().len() / 4;
            write_json_response(&mut stream, 200, json!({"input_tokens": approx})).await
        }
        ("POST", "/v1/messages") => {
            let req = serde_json::from_slice::<Value>(body)
                .map_err(|e| format!("invalid messages request: {e}"))?;
            let response = call_openai_responses(&config, upstream_secret.as_deref(), req).await;
            match response {
                Ok(message) => write_json_or_sse_response(&mut stream, message).await,
                Err(err) => {
                    write_json_response(
                        &mut stream,
                        502,
                        json!({"type":"error","error":{"type":"api_error","message":err}}),
                    )
                    .await
                }
            }
        }
        _ => {
            write_json_response(
                &mut stream,
                404,
                json!({"type":"error","error":{"type":"not_found","message":"Not found"}}),
            )
            .await
        }
    }
}

fn gateway_route_requires_auth(method: &str, route_path: &str) -> bool {
    !matches!(
        (method, route_path),
        ("HEAD", "/") | ("HEAD", "/health") | ("GET", "/health")
    )
}

fn gateway_auth_matches(header: &str, auth_token: &str) -> bool {
    header.lines().any(|line| {
        let Some((name, value)) = line.split_once(':') else {
            return false;
        };
        let value = value.trim();
        if name.eq_ignore_ascii_case("authorization") {
            let mut parts = value.split_whitespace();
            return parts
                .next()
                .is_some_and(|scheme| scheme.eq_ignore_ascii_case("bearer"))
                && parts.next() == Some(auth_token)
                && parts.next().is_none();
        }
        name.eq_ignore_ascii_case("x-api-key") && value == auth_token
    })
}

async fn call_openai_responses(
    config: &AgentBackendConfig,
    secret: Option<&str>,
    anthropic_req: Value,
) -> Result<Value, String> {
    if config.kind == AgentBackendKind::CodexSubscription {
        return call_codex_responses(config, secret, anthropic_req).await;
    }
    let secret = secret.ok_or("OpenAI-compatible backend requires an API key")?;
    let base = config
        .base_url
        .as_deref()
        .unwrap_or("https://api.openai.com")
        .trim_end_matches('/');
    let model = openai_compatible_request_model(config, &anthropic_req)?;
    let openai_req = json!({
        "model": model.clone(),
        "input": transcript_from_anthropic(&anthropic_req),
        "tools": tools_from_anthropic(&anthropic_req),
        "max_output_tokens": anthropic_req.get("max_tokens").cloned().unwrap_or(json!(4096)),
    });
    let client = reqwest::Client::new();
    let value = client
        .post(openai_api_url(base, "responses"))
        .bearer_auth(secret)
        .json(&openai_req)
        .send()
        .await
        .map_err(|e| format!("OpenAI request failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("OpenAI request failed: {e}"))?
        .json::<Value>()
        .await
        .map_err(|e| format!("Invalid OpenAI response: {e}"))?;
    Ok(anthropic_message_from_openai(
        &model,
        value,
        anthropic_req
            .get("stream")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    ))
}

async fn call_codex_responses(
    config: &AgentBackendConfig,
    secret: Option<&str>,
    anthropic_req: Value,
) -> Result<Value, String> {
    let auth = serde_json::from_str::<CodexAuthMaterial>(
        secret.ok_or("Codex subscription backend requires Codex CLI authentication")?,
    )
    .map_err(|e| format!("Invalid Codex gateway auth material: {e}"))?;
    let model = openai_compatible_request_model(config, &anthropic_req)?;
    let instructions = codex_instructions_from_anthropic(&anthropic_req);
    let request_id = uuid::Uuid::new_v4().to_string();
    let codex_req = json!({
        "model": model.clone(),
        "store": false,
        "stream": true,
        "instructions": instructions,
        "input": codex_input_from_anthropic(&anthropic_req),
        "text": {"verbosity": "low"},
        "include": ["reasoning.encrypted_content"],
        "tools": tools_from_anthropic(&anthropic_req),
        "tool_choice": "auto",
        "parallel_tool_calls": true,
    });
    let client = reqwest::Client::new();
    let mut request = client
        .post(codex_responses_url(config.base_url.as_deref()))
        .bearer_auth(&auth.access_token)
        .header(reqwest::header::ACCEPT, "text/event-stream")
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header("OpenAI-Beta", "responses=experimental")
        .header("originator", "claudette")
        .header("x-client-request-id", request_id)
        .json(&codex_req);
    if let Some(account_id) = auth.account_id.as_deref()
        && !account_id.trim().is_empty()
    {
        request = request.header("chatgpt-account-id", account_id);
    }
    let response = request
        .send()
        .await
        .map_err(|e| format!("Codex request failed: {e}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("Invalid Codex response body: {e}"))?;
    if !status.is_success() {
        return Err(format!("Codex request failed ({status}): {body}"));
    }
    let value = openai_response_from_sse(&body)?;
    Ok(anthropic_message_from_openai(
        &model,
        value,
        anthropic_req
            .get("stream")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    ))
}

fn openai_compatible_request_model(
    config: &AgentBackendConfig,
    anthropic_req: &Value,
) -> Result<String, String> {
    let requested = anthropic_req
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|model| !model.is_empty());
    if let Some(model) = requested
        && (backend_models_contain(config, model) || !is_claude_code_model_alias(model))
    {
        return Ok(model.to_string());
    }

    config
        .default_model
        .as_deref()
        .filter(|model| !model.trim().is_empty())
        .or_else(|| {
            config
                .discovered_models
                .first()
                .or_else(|| config.manual_models.first())
                .map(|model| model.id.as_str())
        })
        .map(ToString::to_string)
        .or_else(|| requested.map(ToString::to_string))
        .ok_or_else(|| "Missing model".to_string())
}

fn is_claude_code_model_alias(model: &str) -> bool {
    let lower = model.trim().to_ascii_lowercase();
    let without_context_suffix = lower.strip_suffix("[1m]").unwrap_or(&lower);
    matches!(
        without_context_suffix,
        "sonnet" | "opus" | "haiku" | "opusplan"
    ) || without_context_suffix.starts_with("claude-")
        || without_context_suffix.starts_with("anthropic.claude-")
        || without_context_suffix.contains(".anthropic.claude-")
}

fn codex_instructions_from_anthropic(req: &Value) -> String {
    req.get("system")
        .map(content_value_text)
        .filter(|text| !text.trim().is_empty())
        .unwrap_or_else(|| "You are a concise coding assistant.".to_string())
}

fn codex_input_from_anthropic(req: &Value) -> Value {
    let input = req
        .get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|message| {
            let role = message
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or("user");
            let content = message.get("content").unwrap_or(&Value::Null);
            if role == "assistant" {
                assistant_input_items_from_anthropic(content)
            } else {
                user_input_items_from_anthropic(role, content)
            }
        })
        .collect::<Vec<_>>();
    Value::Array(input)
}

fn assistant_input_items_from_anthropic(content: &Value) -> Vec<Value> {
    let mut items = Vec::new();
    match content {
        Value::Array(blocks) => {
            let mut text_parts = Vec::new();
            for block in blocks {
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(text) = block.get("text").and_then(Value::as_str)
                            && !text.is_empty()
                        {
                            text_parts.push(text.to_string());
                        }
                    }
                    Some("tool_use") => {
                        let call_id = block
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or("call")
                            .to_string();
                        let name = block
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("tool")
                            .to_string();
                        let arguments = block
                            .get("input")
                            .map(Value::to_string)
                            .unwrap_or_else(|| "{}".to_string());
                        items.push(json!({
                            "type": "function_call",
                            "call_id": call_id,
                            "name": name,
                            "arguments": arguments,
                            "status": "completed",
                        }));
                    }
                    _ => {}
                }
            }
            if !text_parts.is_empty() {
                items.insert(
                    0,
                    json!({
                        "type": "message",
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": text_parts.join("\n"), "annotations": []}],
                        "status": "completed",
                    }),
                );
            }
        }
        Value::String(text) if !text.is_empty() => {
            items.push(json!({
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": text, "annotations": []}],
                "status": "completed",
            }));
        }
        other if !other.is_null() => {
            items.push(json!({
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": other.to_string(), "annotations": []}],
                "status": "completed",
            }));
        }
        _ => {}
    }
    items
}

fn user_input_items_from_anthropic(role: &str, content: &Value) -> Vec<Value> {
    let mut items = Vec::new();
    match content {
        Value::Array(blocks) => {
            let mut text_parts = Vec::new();
            for block in blocks {
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(text) = block.get("text").and_then(Value::as_str)
                            && !text.is_empty()
                        {
                            text_parts.push(text.to_string());
                        }
                    }
                    Some("tool_result") => {
                        if !text_parts.is_empty() {
                            items.push(json!({
                                "role": role,
                                "content": [{"type": "input_text", "text": text_parts.join("\n")}],
                            }));
                            text_parts.clear();
                        }
                        items.push(json!({
                            "type": "function_call_output",
                            "call_id": block.get("tool_use_id").and_then(Value::as_str).unwrap_or("call"),
                            "output": content_value_text(block.get("content").unwrap_or(&Value::Null)),
                        }));
                    }
                    _ => {}
                }
            }
            if !text_parts.is_empty() {
                items.push(json!({
                    "role": role,
                    "content": [{"type": "input_text", "text": text_parts.join("\n")}],
                }));
            }
        }
        Value::String(text) => {
            items.push(json!({
                "role": role,
                "content": [{"type": "input_text", "text": text}],
            }));
        }
        other => {
            items.push(json!({
                "role": role,
                "content": [{"type": "input_text", "text": content_value_text(other)}],
            }));
        }
    }
    items
}

fn route_path(path: &str) -> &str {
    path.split_once('?').map_or(path, |(route, _)| route)
}

fn codex_responses_url(base_url: Option<&str>) -> String {
    let raw = base_url
        .map(str::trim)
        .filter(|base| !base.is_empty())
        .unwrap_or(CODEX_DEFAULT_BASE_URL);
    let normalized = raw.trim_end_matches('/');
    if normalized.ends_with("/codex/responses") {
        normalized.to_string()
    } else if normalized.ends_with("/codex") {
        format!("{normalized}/responses")
    } else {
        format!("{normalized}/codex/responses")
    }
}

fn codex_account_id_from_access_token(token: &str) -> Option<String> {
    let payload = token.split('.').nth(1)?;
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    let value = serde_json::from_slice::<Value>(&decoded).ok()?;
    value
        .get(CODEX_JWT_AUTH_CLAIM)?
        .get("chatgpt_account_id")?
        .as_str()
        .filter(|account_id| !account_id.trim().is_empty())
        .map(ToString::to_string)
}

fn openai_response_from_sse(body: &str) -> Result<Value, String> {
    let mut output_text = String::new();
    let mut last_response = None;
    let mut output_items: HashMap<usize, Value> = HashMap::new();
    let mut function_args: HashMap<usize, String> = HashMap::new();
    for line in body.lines() {
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data == "[DONE]" || data.is_empty() {
            continue;
        }
        let value = serde_json::from_str::<Value>(data)
            .map_err(|e| format!("Invalid Codex SSE event: {e}"))?;
        match value.get("type").and_then(Value::as_str) {
            Some("response.output_text.delta") => {
                if let Some(delta) = value.get("delta").and_then(Value::as_str) {
                    output_text.push_str(delta);
                }
            }
            Some("response.output_item.added") => {
                if let Some(index) = event_output_index(&value)
                    && let Some(item) = value.get("item")
                {
                    output_items.insert(index, item.clone());
                }
            }
            Some("response.function_call_arguments.delta") => {
                if let Some(index) = event_output_index(&value)
                    && let Some(delta) = value.get("delta").and_then(Value::as_str)
                {
                    function_args.entry(index).or_default().push_str(delta);
                    if let Some(item) = output_items.get_mut(&index) {
                        item["arguments"] = Value::String(function_args[&index].clone());
                    }
                }
            }
            Some("response.function_call_arguments.done") => {
                if let Some(index) = event_output_index(&value)
                    && let Some(arguments) = value.get("arguments").and_then(Value::as_str)
                {
                    function_args.insert(index, arguments.to_string());
                    if let Some(item) = output_items.get_mut(&index) {
                        item["arguments"] = Value::String(arguments.to_string());
                    }
                }
            }
            Some("response.output_item.done") => {
                if let Some(index) = event_output_index(&value)
                    && let Some(item) = value.get("item")
                {
                    output_items.insert(index, item.clone());
                }
            }
            Some("response.completed") => {
                if let Some(response) = value.get("response") {
                    last_response = Some(response.clone());
                }
            }
            _ => {}
        }
    }
    let mut response = last_response.ok_or("Codex stream ended without response.completed")?;
    if response.get("output_text").is_none() && !output_text.is_empty() {
        response["output_text"] = Value::String(output_text);
    }
    let response_output_empty = response
        .get("output")
        .and_then(Value::as_array)
        .is_none_or(Vec::is_empty);
    if response_output_empty && !output_items.is_empty() {
        let mut indexed = output_items.into_iter().collect::<Vec<_>>();
        indexed.sort_by_key(|(index, _)| *index);
        response["output"] = Value::Array(indexed.into_iter().map(|(_, item)| item).collect());
    }
    Ok(response)
}

fn event_output_index(value: &Value) -> Option<usize> {
    value
        .get("output_index")
        .and_then(Value::as_u64)
        .and_then(|index| usize::try_from(index).ok())
}

fn transcript_from_anthropic(req: &Value) -> String {
    let mut out = String::new();
    if let Some(system) = req.get("system") {
        out.push_str("System:\n");
        out.push_str(&content_value_text(system));
        out.push_str("\n\n");
    }
    if let Some(messages) = req.get("messages").and_then(Value::as_array) {
        for message in messages {
            let role = message
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or("user");
            out.push_str(role);
            out.push_str(":\n");
            out.push_str(&content_value_text(
                message.get("content").unwrap_or(&Value::Null),
            ));
            out.push_str("\n\n");
        }
    }
    out
}

fn content_value_text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| {
                if item.get("type").and_then(Value::as_str) == Some("text") {
                    item.get("text")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string()
                } else if item.get("type").and_then(Value::as_str) == Some("tool_result") {
                    format!(
                        "Tool result {}: {}",
                        item.get("tool_use_id")
                            .and_then(Value::as_str)
                            .unwrap_or(""),
                        content_value_text(item.get("content").unwrap_or(&Value::Null))
                    )
                } else if item.get("type").and_then(Value::as_str) == Some("tool_use") {
                    format!(
                        "Tool use {}: {}",
                        item.get("name").and_then(Value::as_str).unwrap_or(""),
                        item.get("input").unwrap_or(&Value::Null)
                    )
                } else {
                    String::new()
                }
            })
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        other => other.to_string(),
    }
}

fn tools_from_anthropic(req: &Value) -> Value {
    let tools = req
        .get("tools")
        .and_then(Value::as_array)
        .map(|tools| {
            tools
                .iter()
                .filter_map(|tool| {
                    Some(json!({
                        "type": "function",
                        "name": tool.get("name")?.as_str()?,
                        "description": tool.get("description").and_then(Value::as_str).unwrap_or(""),
                        "parameters": tool.get("input_schema").cloned().unwrap_or_else(|| json!({"type":"object"})),
                    }))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Value::Array(tools)
}

fn anthropic_message_from_openai(model: &str, value: Value, stream: bool) -> Value {
    let mut content = Vec::new();
    let fallback_text = value
        .get("output_text")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty());
    let mut has_text_content = false;
    if let Some(output) = value.get("output").and_then(Value::as_array) {
        for item in output {
            match item.get("type").and_then(Value::as_str) {
                Some("message") => {
                    if let Some(parts) = item.get("content").and_then(Value::as_array) {
                        for part in parts {
                            if let Some(text) = part
                                .get("text")
                                .or_else(|| part.get("output_text"))
                                .and_then(Value::as_str)
                                && !text.is_empty()
                            {
                                has_text_content = true;
                                content.push(json!({"type":"text","text":text}));
                            }
                        }
                    }
                }
                Some("function_call") => {
                    let id = item
                        .get("call_id")
                        .or_else(|| item.get("id"))
                        .and_then(Value::as_str)
                        .unwrap_or("call");
                    let name = item.get("name").and_then(Value::as_str).unwrap_or("tool");
                    let args = item
                        .get("arguments")
                        .and_then(Value::as_str)
                        .and_then(|s| serde_json::from_str::<Value>(s).ok())
                        .unwrap_or_else(|| json!({}));
                    content.push(json!({"type":"tool_use","id":id,"name":name,"input":args}));
                }
                _ => {}
            }
        }
    }
    if !has_text_content && let Some(text) = fallback_text {
        content.insert(0, json!({"type": "text", "text": text}));
    }
    if content.is_empty() {
        content.push(json!({"type":"text","text":""}));
    }
    json!({
        "stream": stream,
        "message": {
            "id": value.get("id").and_then(Value::as_str).unwrap_or("msg_claudette_gateway"),
            "type": "message",
            "role": "assistant",
            "model": model,
            "content": content,
            "stop_reason": if content.iter().any(|c| c.get("type").and_then(Value::as_str) == Some("tool_use")) { "tool_use" } else { "end_turn" },
            "stop_sequence": null,
            "usage": {
                "input_tokens": value.pointer("/usage/input_tokens").and_then(Value::as_u64).unwrap_or(0),
                "output_tokens": value.pointer("/usage/output_tokens").and_then(Value::as_u64).unwrap_or(0),
            }
        }
    })
}

async fn write_json_or_sse_response(stream: &mut TcpStream, payload: Value) -> Result<(), String> {
    let stream_requested = payload
        .get("stream")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let message = payload.get("message").cloned().unwrap_or_else(|| json!({}));
    if !stream_requested {
        return write_json_response(stream, 200, message).await;
    }
    let body = anthropic_sse_body(&message);
    let headers = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream
        .write_all(headers.as_bytes())
        .await
        .map_err(|e| format!("write failed: {e}"))?;
    stream
        .write_all(body.as_bytes())
        .await
        .map_err(|e| format!("write failed: {e}"))
}

fn anthropic_sse_body(message: &Value) -> String {
    let mut out = String::new();
    let mut start_message = message.clone();
    start_message["content"] = json!([]);
    out.push_str("event: message_start\n");
    out.push_str(&format!(
        "data: {}\n\n",
        json!({"type":"message_start","message":start_message})
    ));
    if let Some(content) = message.get("content").and_then(Value::as_array) {
        for (index, block) in content.iter().enumerate() {
            let block_type = block.get("type").and_then(Value::as_str);
            let start_block = if block_type == Some("text") {
                json!({"type":"text","text":""})
            } else if block_type == Some("tool_use") {
                json!({
                    "type": "tool_use",
                    "id": block.get("id").cloned().unwrap_or(json!("toolu_claudette_gateway")),
                    "name": block.get("name").cloned().unwrap_or(json!("tool")),
                    "input": ""
                })
            } else {
                block.clone()
            };
            out.push_str("event: content_block_start\n");
            out.push_str(&format!(
                "data: {}\n\n",
                json!({"type":"content_block_start","index":index,"content_block":start_block})
            ));
            if block_type == Some("text")
                && let Some(text) = block.get("text").and_then(Value::as_str)
                && !text.is_empty()
            {
                out.push_str("event: content_block_delta\n");
                out.push_str(&format!(
                    "data: {}\n\n",
                    json!({"type":"content_block_delta","index":index,"delta":{"type":"text_delta","text":text}})
                ));
            }
            if block_type == Some("tool_use") {
                let partial_json = block
                    .get("input")
                    .map(Value::to_string)
                    .unwrap_or_else(|| "{}".to_string());
                out.push_str("event: content_block_delta\n");
                out.push_str(&format!(
                    "data: {}\n\n",
                    json!({"type":"content_block_delta","index":index,"delta":{"type":"input_json_delta","partial_json":partial_json}})
                ));
            }
            out.push_str("event: content_block_stop\n");
            out.push_str(&format!(
                "data: {}\n\n",
                json!({"type":"content_block_stop","index":index})
            ));
        }
    }
    out.push_str("event: message_delta\n");
    out.push_str(&format!(
        "data: {}\n\n",
        json!({"type":"message_delta","delta":{"stop_reason":message.get("stop_reason").cloned().unwrap_or(json!("end_turn")),"stop_sequence":null},"usage":message.get("usage").cloned().unwrap_or(json!({}))})
    ));
    out.push_str("event: message_stop\n");
    out.push_str("data: {\"type\":\"message_stop\"}\n\n");
    out
}

async fn write_json_response(
    stream: &mut TcpStream,
    status: u16,
    value: Value,
) -> Result<(), String> {
    let body = value.to_string();
    let reason = match status {
        200 => "OK",
        401 => "Unauthorized",
        404 => "Not Found",
        502 => "Bad Gateway",
        _ => "OK",
    };
    let headers = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream
        .write_all(headers.as_bytes())
        .await
        .map_err(|e| format!("write failed: {e}"))?;
    stream
        .write_all(body.as_bytes())
        .await
        .map_err(|e| format!("write failed: {e}"))
}

async fn write_empty_response(stream: &mut TcpStream, status: u16) -> Result<(), String> {
    let reason = match status {
        200 => "OK",
        401 => "Unauthorized",
        404 => "Not Found",
        502 => "Bad Gateway",
        _ => "OK",
    };
    let headers =
        format!("HTTP/1.1 {status} {reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    stream
        .write_all(headers.as_bytes())
        .await
        .map_err(|e| format!("write failed: {e}"))
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|window| window == b"\r\n\r\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(id: &str) -> AgentBackendModel {
        AgentBackendModel {
            id: id.to_string(),
            label: id.to_string(),
            context_window_tokens: 400_000,
            discovered: true,
        }
    }

    #[test]
    fn runtime_hash_changes_with_backend_model_and_secret() {
        let backend = AgentBackendConfig::builtin_ollama();
        let a = runtime_hash(&backend, Some("one"), Some("qwen"));
        let b = runtime_hash(&backend, Some("two"), Some("qwen"));
        let c = runtime_hash(&backend, Some("two"), Some("glm"));
        assert_ne!(a, b);
        assert_ne!(b, c);
    }

    #[test]
    fn backend_kind_hash_key_uses_stable_wire_values() {
        assert_eq!(
            backend_kind_hash_key(AgentBackendKind::Anthropic),
            "anthropic"
        );
        assert_eq!(
            backend_kind_hash_key(AgentBackendKind::CodexSubscription),
            "codex_subscription"
        );
        assert_eq!(
            backend_kind_hash_key(AgentBackendKind::CustomOpenAi),
            "custom_openai"
        );
    }

    #[test]
    fn gateway_auth_accepts_bearer_or_x_api_key_token() {
        let bearer = "POST /v1/messages HTTP/1.1\r\nAuthorization: Bearer abc123\r\n\r\n";
        let x_api_key = "GET /v1/models HTTP/1.1\r\nx-api-key: abc123\r\n\r\n";
        assert!(gateway_auth_matches(bearer, "abc123"));
        assert!(gateway_auth_matches(x_api_key, "abc123"));
        assert!(!gateway_auth_matches(bearer, "wrong"));
    }

    #[test]
    fn gateway_auth_required_for_backend_api_routes_only() {
        assert!(!gateway_route_requires_auth("GET", "/health"));
        assert!(!gateway_route_requires_auth("HEAD", "/"));
        assert!(gateway_route_requires_auth("GET", "/v1/models"));
        assert!(gateway_route_requires_auth("POST", "/v1/messages"));
    }

    #[test]
    fn custom_model_env_is_added_for_non_anthropic_backends() {
        let mut env = Vec::new();
        append_custom_model_env(
            &mut env,
            &AgentBackendConfig::builtin_codex_subscription(),
            Some("gpt-5.4"),
        );
        assert!(env.contains(&(
            "ANTHROPIC_CUSTOM_MODEL_OPTION".to_string(),
            "gpt-5.4".to_string()
        )));
        assert!(env.contains(&(
            "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME".to_string(),
            "gpt-5.4".to_string()
        )));
        assert!(env.contains(&(
            "CLAUDE_CODE_SUBAGENT_MODEL".to_string(),
            "gpt-5.4".to_string()
        )));
    }

    #[test]
    fn custom_model_env_is_not_added_for_anthropic_backend() {
        let mut env = Vec::new();
        append_custom_model_env(
            &mut env,
            &AgentBackendConfig::builtin_anthropic(),
            Some("sonnet"),
        );
        assert!(env.is_empty());
    }

    #[test]
    fn backend_selection_infers_provider_from_selected_model() {
        let anthropic = AgentBackendConfig::builtin_anthropic();
        let mut openai = AgentBackendConfig::builtin_openai_api();
        openai.enabled = false;
        openai.discovered_models = vec![model("gpt-5.4")];
        let mut codex = AgentBackendConfig::builtin_codex_subscription();
        codex.enabled = true;
        codex.discovered_models = vec![model("gpt-5.4")];
        let backends = vec![anthropic, openai, codex];

        let inferred =
            select_backend_for_request(&backends, Some("anthropic"), Some("gpt-5.4"), None)
                .expect("backend should infer from model");
        assert_eq!(inferred.id, "codex-subscription");

        let fallback = select_backend_for_request(&backends, None, Some("sonnet"), None)
            .expect("unknown model should use anthropic default");
        assert_eq!(fallback.id, "anthropic");
    }

    #[test]
    fn backend_defaults_resolve_codex_default_model_for_empty_request() {
        let db = Database::open_in_memory().expect("test db should open");
        db.set_app_setting("alternative_backends_enabled", "true")
            .expect("setting should save");
        db.set_app_setting("default_agent_backend", "codex-subscription")
            .expect("setting should save");
        db.set_app_setting("default_model", "gpt-5.4")
            .expect("setting should save");

        let mut codex = AgentBackendConfig::builtin_codex_subscription();
        codex.enabled = true;
        codex.default_model = Some("gpt-5.3-codex".to_string());
        codex.discovered_models = vec![model("gpt-5.3-codex"), model("gpt-5.4")];
        save_backend_configs(&db, &[codex]).expect("backend config should save");

        let (backend_id, resolved_model) =
            resolve_backend_request_defaults(&db, None, None).expect("defaults should resolve");

        assert_eq!(backend_id.as_deref(), Some("codex-subscription"));
        assert_eq!(resolved_model.as_deref(), Some("gpt-5.4"));
    }

    #[test]
    fn backend_defaults_ignore_stale_global_model_for_non_anthropic_backend() {
        let db = Database::open_in_memory().expect("test db should open");
        db.set_app_setting("alternative_backends_enabled", "true")
            .expect("setting should save");
        db.set_app_setting("default_agent_backend", "codex-subscription")
            .expect("setting should save");
        db.set_app_setting("default_model", "claude-opus-4-7")
            .expect("setting should save");

        let mut codex = AgentBackendConfig::builtin_codex_subscription();
        codex.enabled = true;
        codex.default_model = Some("gpt-5.3-codex".to_string());
        codex.discovered_models = vec![model("gpt-5.3-codex"), model("gpt-5.4")];
        save_backend_configs(&db, &[codex]).expect("backend config should save");

        let (backend_id, resolved_model) =
            resolve_backend_request_defaults(&db, None, None).expect("defaults should resolve");

        assert_eq!(backend_id.as_deref(), Some("codex-subscription"));
        assert_eq!(resolved_model.as_deref(), Some("gpt-5.3-codex"));
    }

    #[test]
    fn backend_defaults_fill_model_for_provider_only_request() {
        let db = Database::open_in_memory().expect("test db should open");
        db.set_app_setting("alternative_backends_enabled", "true")
            .expect("setting should save");

        let mut ollama = AgentBackendConfig::builtin_ollama();
        ollama.enabled = true;
        ollama.discovered_models = vec![model("qwen3-coder")];
        save_backend_configs(&db, &[ollama]).expect("backend config should save");

        let (backend_id, resolved_model) =
            resolve_backend_request_defaults(&db, Some("ollama"), None)
                .expect("provider-only request should resolve");

        assert_eq!(backend_id.as_deref(), Some("ollama"));
        assert_eq!(resolved_model.as_deref(), Some("qwen3-coder"));
    }

    #[test]
    fn openai_response_maps_text_to_anthropic_message() {
        let mapped = anthropic_message_from_openai(
            "gpt-test",
            json!({"id":"resp_1","output_text":"hello","usage":{"input_tokens":3,"output_tokens":4}}),
            false,
        );
        assert_eq!(mapped["message"]["content"][0]["text"], "hello");
        assert_eq!(mapped["message"]["usage"]["input_tokens"], 3);
    }

    #[test]
    fn openai_response_does_not_duplicate_streamed_and_final_text() {
        let mapped = anthropic_message_from_openai(
            "gpt-test",
            json!({
                "id":"resp_1",
                "output_text":"hello",
                "output":[{
                    "type":"message",
                    "content":[{"type":"output_text","text":"hello"}]
                }],
                "usage":{"input_tokens":3,"output_tokens":4}
            }),
            false,
        );
        let content = mapped["message"]["content"]
            .as_array()
            .expect("content should be an array");
        assert_eq!(content.len(), 1);
        assert_eq!(content[0]["text"], "hello");
    }

    #[test]
    fn openai_compatible_request_model_maps_claude_subagent_alias_to_backend_model() {
        let mut codex = AgentBackendConfig::builtin_codex_subscription();
        codex.default_model = Some("gpt-5.5".to_string());
        codex.discovered_models = vec![model("gpt-5.5")];

        let resolved =
            openai_compatible_request_model(&codex, &json!({"model": "sonnet", "messages": []}))
                .expect("model should resolve");

        assert_eq!(resolved, "gpt-5.5");
    }

    #[test]
    fn openai_compatible_request_model_keeps_known_backend_model() {
        let mut codex = AgentBackendConfig::builtin_codex_subscription();
        codex.default_model = Some("gpt-5.5".to_string());
        codex.discovered_models = vec![model("gpt-5.5"), model("gpt-5.4")];

        let resolved =
            openai_compatible_request_model(&codex, &json!({"model": "gpt-5.4", "messages": []}))
                .expect("model should resolve");

        assert_eq!(resolved, "gpt-5.4");
    }

    #[test]
    fn openai_compatible_request_model_keeps_unknown_non_claude_model() {
        let codex = AgentBackendConfig::builtin_codex_subscription();

        let resolved = openai_compatible_request_model(
            &codex,
            &json!({"model": "future-gpt", "messages": []}),
        )
        .expect("model should resolve");

        assert_eq!(resolved, "future-gpt");
    }

    #[test]
    fn openai_api_url_adds_v1_once() {
        assert_eq!(
            openai_api_url("https://api.openai.com", "models"),
            "https://api.openai.com/v1/models"
        );
        assert_eq!(
            openai_api_url("https://example.test/v1/", "/responses"),
            "https://example.test/v1/responses"
        );
    }

    #[test]
    fn gateway_route_path_ignores_claude_code_query_flags() {
        assert_eq!(route_path("/v1/messages?beta=true"), "/v1/messages");
        assert_eq!(route_path("/v1/models?limit=1000"), "/v1/models");
        assert_eq!(route_path("/health"), "/health");
    }

    #[test]
    fn codex_responses_url_matches_chatgpt_codex_shapes() {
        assert_eq!(
            codex_responses_url(None),
            "https://chatgpt.com/backend-api/codex/responses"
        );
        assert_eq!(
            codex_responses_url(Some("https://chatgpt.com/backend-api")),
            "https://chatgpt.com/backend-api/codex/responses"
        );
        assert_eq!(
            codex_responses_url(Some("https://chatgpt.com/backend-api/codex")),
            "https://chatgpt.com/backend-api/codex/responses"
        );
        assert_eq!(
            codex_responses_url(Some("https://chatgpt.com/backend-api/codex/responses")),
            "https://chatgpt.com/backend-api/codex/responses"
        );
    }

    #[test]
    fn codex_account_id_can_be_derived_from_chatgpt_access_token() {
        let mut claims = serde_json::Map::new();
        claims.insert(
            CODEX_JWT_AUTH_CLAIM.to_string(),
            json!({"chatgpt_account_id": "acct-123"}),
        );
        let payload = Value::Object(claims);
        let encoded =
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload.to_string().as_bytes());
        let token = format!("header.{encoded}.signature");
        assert_eq!(
            codex_account_id_from_access_token(&token).as_deref(),
            Some("acct-123")
        );
        assert_eq!(codex_account_id_from_access_token("not-a-jwt"), None);
    }

    #[test]
    fn codex_input_uses_responses_text_parts() {
        let input = codex_input_from_anthropic(&json!({
            "messages": [
                {"role": "user", "content": [{"type": "text", "text": "hello"}]},
                {"role": "assistant", "content": [{"type": "text", "text": "hi"}]}
            ]
        }));
        assert_eq!(input[0]["role"], "user");
        assert_eq!(input[0]["content"][0]["type"], "input_text");
        assert_eq!(input[0]["content"][0]["text"], "hello");
        assert_eq!(input[1]["type"], "message");
        assert_eq!(input[1]["content"][0]["type"], "output_text");
        assert_eq!(input[1]["content"][0]["text"], "hi");
    }

    #[test]
    fn codex_input_preserves_tool_calls_and_results() {
        let input = codex_input_from_anthropic(&json!({
            "messages": [
                {"role": "assistant", "content": [
                    {"type": "text", "text": "I'll read it."},
                    {"type": "tool_use", "id": "toolu_1", "name": "Read", "input": {"path": "README.md"}}
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "toolu_1", "content": "contents"}
                ]}
            ]
        }));

        assert_eq!(input[0]["type"], "message");
        assert_eq!(input[0]["content"][0]["text"], "I'll read it.");
        assert_eq!(input[1]["type"], "function_call");
        assert_eq!(input[1]["call_id"], "toolu_1");
        assert_eq!(input[1]["name"], "Read");
        assert_eq!(input[1]["arguments"], r#"{"path":"README.md"}"#);
        assert_eq!(input[2]["type"], "function_call_output");
        assert_eq!(input[2]["call_id"], "toolu_1");
        assert_eq!(input[2]["output"], "contents");
    }

    #[test]
    fn openai_model_filter_keeps_text_and_codex_models() {
        let models = models_from_openai_shape(
            &json!({
                "data": [
                    {"id": "gpt-5.5"},
                    {"id": "gpt-5.5"},
                    {"id": "gpt-image-1"},
                    {"id": "text-embedding-3-large"},
                    {"id": "o4-mini"},
                    {"id": "codex-mini-latest"},
                    {"id": "whisper-1"}
                ]
            }),
            400_000,
        );
        let ids = filter_openai_models(models)
            .into_iter()
            .map(|model| model.id)
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["codex-mini-latest", "gpt-5.5", "o4-mini"]);
    }

    #[test]
    fn built_in_discovery_backends_do_not_keep_manual_model_seeds() {
        let mut openai = AgentBackendConfig::builtin_openai_api();
        openai.manual_models = vec![model("any-future-model")];
        let normalized = normalize_backend(openai);
        assert!(normalized.manual_models.is_empty());

        let mut custom = AgentBackendConfig::builtin_openai_api();
        custom.kind = AgentBackendKind::CustomOpenAi;
        custom.manual_models = vec![model("team-private-model")];
        let normalized = normalize_backend(custom);
        assert_eq!(normalized.manual_models.len(), 1);
    }

    #[test]
    fn codex_sse_response_maps_to_openai_response() {
        let response = openai_response_from_sse(
            r#"data: {"type":"response.output_text.delta","delta":"hel"}
data: {"type":"response.output_text.delta","delta":"lo"}
data: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":1,"output_tokens":2}}}
data: [DONE]
"#,
        )
        .expect("SSE should parse");
        assert_eq!(response["output_text"], "hello");
        assert_eq!(response["usage"]["output_tokens"], 2);
    }

    #[test]
    fn codex_sse_response_preserves_streamed_function_call_items() {
        let response = openai_response_from_sse(
            r#"data: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc_1","type":"function_call","status":"in_progress","arguments":"","call_id":"call_1","name":"Read"}}
data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":"{\"path\""}
data: {"type":"response.function_call_arguments.delta","output_index":0,"delta":":\"README.md\"}"}
data: {"type":"response.output_item.done","output_index":0,"item":{"id":"fc_1","type":"function_call","status":"completed","arguments":"{\"path\":\"README.md\"}","call_id":"call_1","name":"Read"}}
data: {"type":"response.completed","response":{"id":"resp_1","output":[],"usage":{"input_tokens":1,"output_tokens":2}}}
data: [DONE]
"#,
        )
        .expect("SSE should parse");

        assert_eq!(response["output"][0]["type"], "function_call");
        assert_eq!(response["output"][0]["call_id"], "call_1");
        assert_eq!(response["output"][0]["name"], "Read");
        assert_eq!(
            response["output"][0]["arguments"],
            r#"{"path":"README.md"}"#
        );
    }

    #[test]
    fn anthropic_sse_emits_text_delta_for_stream_json_consumers() {
        let body = anthropic_sse_body(&json!({
            "id": "msg_1",
            "type": "message",
            "role": "assistant",
            "model": "gpt-test",
            "content": [{"type":"text","text":"hello"}],
            "stop_reason": "end_turn",
            "stop_sequence": null,
            "usage": {"input_tokens": 1, "output_tokens": 1}
        }));
        assert!(body.contains(r#""message":{"content":[],"id":"msg_1""#));
        assert!(body.contains(r#""content_block":{"text":"","type":"text"}"#));
        assert!(body.contains(r#""delta":{"text":"hello","type":"text_delta"}"#));
    }

    #[test]
    fn anthropic_sse_emits_tool_input_json_delta_for_stream_json_consumers() {
        let body = anthropic_sse_body(&json!({
            "id": "msg_1",
            "type": "message",
            "role": "assistant",
            "model": "gpt-test",
            "content": [{"type":"tool_use","id":"toolu_1","name":"Read","input":{"path":"README.md"}}],
            "stop_reason": "tool_use",
            "stop_sequence": null,
            "usage": {"input_tokens": 1, "output_tokens": 1}
        }));

        assert!(body.contains(
            r#""content_block":{"id":"toolu_1","input":"","name":"Read","type":"tool_use"}"#
        ));
        assert!(body.contains(
            r#""delta":{"partial_json":"{\"path\":\"README.md\"}","type":"input_json_delta"}"#
        ));
    }
}
