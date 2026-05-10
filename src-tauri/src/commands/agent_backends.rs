use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::Arc;

use base64::Engine as _;
use futures_util::StreamExt;
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
        "anthropic" | "ollama" | "openai-api" | "codex-subscription" | "lm-studio"
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
        let pre_hydrate = backend.clone();
        hydrate_gateway_models_for_runtime(&mut backend, model).await?;
        // Persist fresh discoveries (new model list, new context windows)
        // so the UI's token-capacity indicator and the next list_agent_backends
        // call see the live values — without requiring a manual Settings →
        // Models refresh. Limited to a real change to keep the chat-send
        // hot path off the DB writer when nothing has actually moved.
        if backend_models_signature(&backend) != backend_models_signature(&pre_hydrate)
            && let Ok(mut all) = load_backend_configs(&db)
            && let Some(slot) = all.iter_mut().find(|item| item.id == backend.id)
        {
            *slot = backend.clone();
            let _ = save_backend_configs(&db, &all);
        }
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
        // LM Studio benefits from the same KV-cache reuse fix Ollama gets:
        // suppress Claude Code's rotating attribution header so identical
        // request prefixes hit LM Studio's prefix cache turn after turn.
        // (Routing-wise LM Studio still goes through our gateway because
        // it returns HTTP 500 for context-overflow, which the SDK retries
        // unless we demote it to 4xx. See `proxy_anthropic_messages`.)
        if backend.kind == AgentBackendKind::LmStudio {
            env.push((
                "CLAUDE_CODE_ATTRIBUTION_HEADER".to_string(),
                "0".to_string(),
            ));
        }
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
        // Disable the per-request user-attribution header. Claude Code
        // adds it for usage attribution against api.anthropic.com, but
        // its rotating value invalidates every local KV-cache prefix
        // and causes a documented ~90 % perf regression on local
        // backends (see github.com/anthropics/claude-code/issues/29230,
        // roborhythms.com/stop-claude-code-slowing-local-llm-by-90).
        // Ollama doesn't bill anything, so the header is pure overhead.
        // LM Studio gets the same env via the gateway-routed path
        // (where we forward this env via the spawned CLI's environment
        // and the gateway itself strips the header from upstream
        // requests).
        env.push((
            "CLAUDE_CODE_ATTRIBUTION_HEADER".to_string(),
            "0".to_string(),
        ));
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
        AgentBackendKind::OpenAiApi
            | AgentBackendKind::CodexSubscription
            | AgentBackendKind::LmStudio
    ) {
        return Ok(());
    }
    let has_models = !backend.manual_models.is_empty() || !backend.discovered_models.is_empty();
    let selected_is_known = model
        .map(|model| backend_models_contain(backend, model))
        .unwrap_or(true);
    // LM Studio's loaded_context_length changes every time the user
    // reloads the model with a different context slider, so we can't
    // trust a cached discovery response here — the pre-flight gate uses
    // that value as ground truth. Always re-discover on the chat-send
    // hot path; it's a single GET to localhost (typically <50ms) and a
    // stale cache means the user sees a 4k-context error after they
    // already reloaded the model with 256k.
    let force_refresh = matches!(backend.kind, AgentBackendKind::LmStudio);
    if !force_refresh && has_models && selected_is_known {
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

/// Order-independent fingerprint of a backend's discovered + manual model
/// list — used to decide whether a chat-send re-discovery actually changed
/// anything worth persisting. Matches the freshness signal in
/// `runtime_hash` (id + context_window_tokens) so a context-slider change
/// in LM Studio reliably triggers both a DB write and a gateway respawn.
///
/// Sorted by model id so the same set of models in a different upstream
/// order produces the same signature — otherwise a single discovery call
/// that returned items in a different order would force an unnecessary DB
/// write + gateway respawn on every chat send.
fn backend_models_signature(backend: &AgentBackendConfig) -> Vec<(String, u32)> {
    let mut entries: Vec<(String, u32)> = backend
        .discovered_models
        .iter()
        .chain(backend.manual_models.iter())
        .map(|model| (model.id.clone(), model.context_window_tokens))
        .collect();
    entries.sort();
    entries
}

fn apply_discovered_models(backend: &mut AgentBackendConfig, discovered: Vec<AgentBackendModel>) {
    if matches!(
        backend.kind,
        AgentBackendKind::Ollama
            | AgentBackendKind::OpenAiApi
            | AgentBackendKind::CodexSubscription
            | AgentBackendKind::LmStudio
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
        AgentBackendConfig::builtin_lm_studio(),
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
            | AgentBackendKind::LmStudio
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
        AgentBackendKind::LmStudio => discover_lm_studio_models(backend).await,
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

async fn discover_lm_studio_models(
    backend: &AgentBackendConfig,
) -> Result<Vec<AgentBackendModel>, String> {
    let base = backend
        .base_url
        .as_deref()
        .unwrap_or("http://localhost:1234")
        .trim_end_matches('/');
    // Treat secure-store failures as soft (a corrupt keychain entry is
    // distinct from "no secret was ever set") and tell the user via the
    // log so a discovery-fails-silently bug is debuggable. A missing /
    // blank secret is fine — LM Studio accepts any bearer locally and
    // we substitute a placeholder below.
    let secret = match load_secure_secret(SECRET_BUCKET, &backend.id) {
        Ok(maybe) => maybe,
        Err(err) => {
            tracing::warn!(
                target: "claudette::backend",
                backend_id = %backend.id,
                error = %err,
                "LM Studio secret unreadable from secure store — falling back to placeholder bearer for discovery"
            );
            None
        }
    };
    // LM Studio's local server accepts any bearer — empty included — but
    // some users front it with an authenticating proxy that rejects
    // requests *without* an Authorization header even if the value
    // doesn't matter. Always send a bearer (user-supplied or the
    // `lm-studio` placeholder) so discovery works in both setups,
    // matching what the runtime path does.
    let bearer = secret
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("lm-studio")
        .to_string();
    let client = reqwest::Client::new();

    // Prefer LM Studio's native v0 endpoint, which exposes per-model
    // max_context_length / loaded_context_length. Fall back to the OpenAI-shaped
    // /v1/models if v0 is missing (older or stripped builds).
    let v0_response = client
        .get(format!("{base}/api/v0/models"))
        .bearer_auth(&bearer)
        .send()
        .await;
    if let Ok(response) = v0_response
        && response.status().is_success()
        && let Ok(value) = response.json::<Value>().await
    {
        let models = lm_studio_models_from_v0(&value, backend.context_window_default);
        if !models.is_empty() {
            return Ok(models);
        }
    }

    let value = client
        .get(openai_api_url(base, "models"))
        .bearer_auth(&bearer)
        .send()
        .await
        .map_err(|e| format!("Failed to query LM Studio: {e}"))?
        .error_for_status()
        .map_err(|e| format!("LM Studio model discovery failed: {e}"))?
        .json::<Value>()
        .await
        .map_err(|e| format!("Invalid LM Studio model response: {e}"))?;
    Ok(models_from_openai_shape(
        &value,
        backend.context_window_default,
    ))
}

fn lm_studio_models_from_v0(value: &Value, default_context: u32) -> Vec<AgentBackendModel> {
    value
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|model| {
            let id = model.get("id").and_then(Value::as_str)?;
            // Skip embedding/vision-only entries — they aren't usable as chat
            // backends for the agent loop. Everything else (LLM, instruct,
            // unknown) is fair game.
            if model
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|kind| kind.eq_ignore_ascii_case("embeddings"))
            {
                return None;
            }
            let context = model
                .get("loaded_context_length")
                .or_else(|| model.get("max_context_length"))
                .and_then(Value::as_u64)
                .and_then(|n| u32::try_from(n).ok())
                .unwrap_or(default_context);
            Some(AgentBackendModel {
                id: id.to_string(),
                label: id.to_string(),
                context_window_tokens: context,
                discovered: true,
            })
        })
        .collect()
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
    // Fingerprint the per-model context windows so a fresh discovery that
    // bumps `loaded_context_length` (LM Studio reload with a new slider)
    // forces the gateway to respawn with the new snapshot. Without this
    // the gateway's pre-flight check would keep using the stale context
    // size baked into the running task. id+context is enough — label and
    // discovered-flag don't affect runtime behaviour.
    //
    // Sort first: upstream discovery doesn't guarantee a stable order, so
    // hashing in iteration order would rotate the hash on every chat send
    // even when nothing actually changed, forcing a needless gateway
    // teardown/respawn cycle.
    let mut model_entries: Vec<(&str, u32)> = config
        .discovered_models
        .iter()
        .chain(config.manual_models.iter())
        .map(|entry| (entry.id.as_str(), entry.context_window_tokens))
        .collect();
    model_entries.sort();
    for (id, ctx) in &model_entries {
        id.hash(&mut hasher);
        ctx.hash(&mut hasher);
    }
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
        AgentBackendKind::LmStudio => "lm_studio",
    }
}

/// Error from a gateway request that needs to be turned back into an HTTP
/// response for the Claude CLI. Carries both the upstream-extracted message
/// and the response status we want the gateway to emit — so a 4xx from LM
/// Studio (e.g. context-length exceeded) propagates as 4xx and the SDK does
/// not retry it as a transient 5xx.
#[derive(Debug, Clone)]
struct GatewayUpstreamError {
    status: u16,
    message: String,
}

impl GatewayUpstreamError {
    /// Wrap a local/internal failure (couldn't even reach the upstream).
    /// Surfaces as 502 to the CLI.
    fn internal(message: impl Into<String>) -> Self {
        Self {
            status: 502,
            message: message.into(),
        }
    }

    /// Build from an upstream non-2xx response. Parses the OpenAI-shaped
    /// `{error: {message: ...}}` envelope when present, else falls back to
    /// the raw body. Preserves 4xx status codes so the CLI fails fast on
    /// permanent input errors instead of retrying with backoff.
    fn from_upstream(status: u16, body: &str) -> Self {
        let message = serde_json::from_str::<Value>(body)
            .ok()
            .as_ref()
            .and_then(|v| v.get("error"))
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| {
                if body.trim().is_empty() {
                    format!("upstream returned HTTP {status} with no body")
                } else {
                    // Cap the raw-body fallback so a cloud proxy's giant
                    // HTML 502 page or an upstream debug dump can't
                    // balloon error responses or log lines. The full
                    // body is logged via tracing::warn for postmortem.
                    truncate_for_error_message(body)
                }
            });
        // 4xx → forward as-is so retries stop. 5xx that are *semantically*
        // permanent (LM Studio classifies "tokens to keep > context length"
        // as HTTP 500 even though it's a hard input error) get demoted to
        // 400 so the Anthropic SDK does not retry them with backoff.
        // Anything else collapses to 502 (bad gateway) for the SDK consumer.
        let outbound = if (400..500).contains(&status) {
            status
        } else if upstream_message_is_permanent_failure(&message) {
            400
        } else {
            502
        };
        Self {
            status: outbound,
            message,
        }
    }
}

/// Map an outbound HTTP status to the Anthropic error-envelope `type`
/// string the Claude CLI / SDK expect for that class. Default is
/// `api_error` (transient — SDK may retry); 4xx → kind-specific labels
/// so 401/403/404/429 don't all collapse to `invalid_request_error`,
/// which would re-classify `429`s out of the SDK's rate-limit retry path.
fn anthropic_error_type_for(status: u16) -> &'static str {
    match status {
        401 => "authentication_error",
        403 => "permission_error",
        404 => "not_found_error",
        413 => "request_too_large",
        429 => "rate_limit_error",
        400..=499 => "invalid_request_error",
        _ => "api_error",
    }
}

/// Cap an upstream body / payload that might end up in a user-visible
/// error string. Keeps just enough context to be actionable; protects
/// log files and chat UI from being flooded by upstream HTML / proxy
/// error pages. Caller is responsible for tracing::warn-ing the full
/// body if a postmortem-quality copy is needed.
fn truncate_for_error_message(body: &str) -> String {
    const MAX: usize = 512;
    let mut trimmed = body.trim();
    if trimmed.len() <= MAX {
        return trimmed.to_string();
    }
    // Walk back to the last char boundary at or below MAX so we never
    // slice into a multibyte UTF-8 sequence.
    let mut cut = MAX;
    while cut > 0 && !trimmed.is_char_boundary(cut) {
        cut -= 1;
    }
    trimmed = &trimmed[..cut];
    format!(
        "{trimmed}… [truncated, {total} bytes total]",
        total = body.len()
    )
}

/// Returns true when the upstream message describes a hard input error that
/// will fail identically on retry — context-window overflow, model not
/// loaded, model not found, etc. Matched case-insensitively against
/// substrings observed in the wild from LM Studio, llama.cpp, vLLM, and
/// OpenAI-compatible gateways. Keep the list narrow: false positives mean
/// users miss out on transient-failure retries.
fn upstream_message_is_permanent_failure(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    const NEEDLES: &[&str] = &[
        "context length",
        "tokens to keep",
        "context window",
        "exceeds the maximum",
        "model is not loaded",
        "model not loaded",
        "model not found",
        "no model is loaded",
        "input is too long",
        "prompt is too long",
    ];
    NEEDLES.iter().any(|needle| lower.contains(needle))
}

impl std::fmt::Display for GatewayUpstreamError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} (status={})", self.message, self.status)
    }
}

impl From<String> for GatewayUpstreamError {
    fn from(message: String) -> Self {
        Self::internal(message)
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
            // LM Studio speaks Anthropic's wire format natively — there's
            // no OpenAI-Responses translation work to do, just forward
            // bytes. The pass-through writes the response (including
            // streaming SSE) directly to the client TCP stream so we
            // preserve TTFT, and intercepts non-2xx upstream responses
            // to apply the same status-demotion logic the gateway uses
            // for OpenAI-shape backends (otherwise LM Studio's HTTP 500
            // for context-overflow triggers the SDK's retry-with-backoff
            // path and the user sees a multi-minute spinner instead of
            // the actual error message).
            if config.kind == AgentBackendKind::LmStudio {
                match proxy_anthropic_messages(&config, &req, &mut stream).await {
                    Ok(()) => Ok(()),
                    Err(err) => write_anthropic_error_response(&mut stream, err).await,
                }
            } else {
                let response =
                    call_openai_responses(&config, upstream_secret.as_deref(), req).await;
                match response {
                    Ok(message) => write_json_or_sse_response(&mut stream, message).await,
                    Err(err) => write_anthropic_error_response(&mut stream, err).await,
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

// Gateway backends that go through the OpenAI-Responses translation
// path (OpenAi, Codex, CustomOpenAi) require a real API key — they
// hit api.openai.com or chatgpt.com and need real auth. LM Studio is
// also gateway-routed but takes the Anthropic-shape pass-through in
// `proxy_anthropic_messages` instead of this helper, and its
// local-first placeholder-bearer logic lives there + in
// `discover_lm_studio_models` (where it's actually exercised).
fn openai_compatible_bearer_token(secret: Option<&str>) -> Result<String, String> {
    secret
        .map(str::to_string)
        .ok_or_else(|| "OpenAI-compatible backend requires an API key".to_string())
}

fn openai_compatible_default_base(_kind: AgentBackendKind) -> &'static str {
    "https://api.openai.com"
}

/// Approximate the prompt+tools size and compare against the backend's
/// known context window for `model`. Returns Some(error) when the request
/// is obviously too large to fit, so we can fail fast at 400 instead of
/// waiting on the upstream server to tokenize and reject it. Returns None
/// when the model's context window isn't known (e.g. user added a manual
/// model without a discovered context size) — in that case we still send
/// upstream and let the runtime classify any overflow via
/// `from_upstream` + `upstream_message_is_permanent_failure`.
fn preflight_context_window_check(
    config: &AgentBackendConfig,
    model: &str,
    openai_req: &Value,
) -> Option<GatewayUpstreamError> {
    let context = config
        .discovered_models
        .iter()
        .chain(config.manual_models.iter())
        .find(|m| m.id == model)
        .map(|m| m.context_window_tokens)
        .filter(|n| *n > 0)?;
    // Body length / 4 is a deliberate over-estimate for English text and
    // a conservative match for tokenizer-dense JSON tool schemas. Same
    // approximation we use in /v1/messages/count_tokens, so the count
    // and the gate stay consistent.
    let approx_tokens = openai_req.to_string().len() / 4;
    // Reserve some headroom for completion tokens — even a 1-token reply
    // needs a slot. 90% of the window is a reasonable hard ceiling.
    let limit = (context as usize).saturating_mul(9) / 10;
    if approx_tokens <= limit {
        return None;
    }
    Some(GatewayUpstreamError {
        status: 400,
        message: format!(
            "Prompt is too large for the model's loaded context window. \
             Approx {approx_tokens} tokens of input vs {context} tokens \
             of context for `{model}`. Reload the model in {label} with a \
             larger context length, or pick a model with a bigger window.",
            label = config.label,
        ),
    })
}

/// Forward an Anthropic Messages API request to LM Studio's native
/// `/v1/messages` endpoint. Bypasses the OpenAI Responses translation
/// `call_openai_responses` does — LM Studio 0.4.1+ implements Anthropic's
/// wire format natively, so the only thing we need from the gateway is
/// **status-code translation**: LM Studio returns HTTP 500 for hard
/// input errors like context-window overflow, which the Anthropic SDK
/// retries with backoff. The response body is in Anthropic shape
/// (`{type: error, error: {type, message}}`) — we just need to fix the
/// status before forwarding to the CLI.
///
/// Successful (2xx) responses are streamed through unchanged so the
/// agent UI gets per-chunk SSE events as LM Studio produces them
/// (preserving TTFT). The pass-through writes directly to `out_stream`
/// rather than buffering into a `Value` like the OpenAI-Responses path.
async fn proxy_anthropic_messages(
    config: &AgentBackendConfig,
    anthropic_req: &Value,
    out_stream: &mut TcpStream,
) -> Result<(), GatewayUpstreamError> {
    let base = config
        .base_url
        .as_deref()
        .unwrap_or("http://localhost:1234")
        .trim_end_matches('/');
    // LM Studio's `/v1/messages` accepts any bearer locally — but a user
    // who fronts the server with an authenticating proxy would reject a
    // missing Authorization header. Always send the placeholder so both
    // setups work.
    let bearer = load_secure_secret(SECRET_BUCKET, &config.id)
        .ok()
        .flatten()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "lm-studio".to_string());
    // Pre-flight: same approximation we use for OpenAI-Responses-routed
    // backends. LM Studio enforces its own context check too, but our
    // pre-flight wins on UX (~1 ms vs ~40 s round-trip to LM Studio's
    // tokenizer) and produces a tailored message that names the actual
    // numbers.
    let model = anthropic_req
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if !model.is_empty()
        && let Some(err) = preflight_context_window_check(config, &model, anthropic_req)
    {
        return Err(err);
    }

    let stream_requested = anthropic_req
        .get("stream")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let response = reqwest::Client::new()
        .post(format!("{base}/v1/messages"))
        .bearer_auth(&bearer)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header("anthropic-version", "2023-06-01")
        .json(anthropic_req)
        .send()
        .await
        .map_err(|e| GatewayUpstreamError::internal(format!("LM Studio request failed: {e}")))?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.map_err(|e| {
            GatewayUpstreamError::internal(format!("Invalid LM Studio response body: {e}"))
        })?;
        return Err(GatewayUpstreamError::from_upstream(status.as_u16(), &body));
    }

    // Forward the response. We mirror the upstream Content-Type so the
    // CLI sees `text/event-stream` for streaming requests and JSON for
    // non-streaming ones, then close the connection at end-of-body so
    // we can stream without committing to a Content-Length. Same
    // `Connection: close` pattern the OpenAI-Responses fallback uses.
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
        .unwrap_or_else(|| {
            if stream_requested {
                "text/event-stream".to_string()
            } else {
                "application/json".to_string()
            }
        });
    let header_block = format!(
        "HTTP/1.1 200 OK\r\n\
         Content-Type: {content_type}\r\n\
         Cache-Control: no-cache\r\n\
         Connection: close\r\n\
         \r\n"
    );
    out_stream
        .write_all(header_block.as_bytes())
        .await
        .map_err(|e| GatewayUpstreamError::internal(format!("write headers failed: {e}")))?;

    let mut body_stream = response.bytes_stream();
    while let Some(chunk) = body_stream.next().await {
        let chunk = chunk
            .map_err(|e| GatewayUpstreamError::internal(format!("upstream stream error: {e}")))?;
        out_stream
            .write_all(&chunk)
            .await
            .map_err(|e| GatewayUpstreamError::internal(format!("write chunk failed: {e}")))?;
    }
    out_stream
        .flush()
        .await
        .map_err(|e| GatewayUpstreamError::internal(format!("flush failed: {e}")))?;
    Ok(())
}

/// Format a `GatewayUpstreamError` as the JSON error envelope the
/// Anthropic CLI / SDK expect, picking the most accurate `error.type`
/// for the outbound HTTP status. Centralized so every gateway code path
/// (OpenAI-Responses translation, LM Studio pass-through) produces an
/// identical shape.
async fn write_anthropic_error_response(
    stream: &mut TcpStream,
    err: GatewayUpstreamError,
) -> Result<(), String> {
    let error_type = anthropic_error_type_for(err.status);
    write_json_response(
        stream,
        err.status,
        json!({
            "type":"error",
            "error":{"type":error_type,"message":err.message},
        }),
    )
    .await
}

async fn call_openai_responses(
    config: &AgentBackendConfig,
    secret: Option<&str>,
    anthropic_req: Value,
) -> Result<Value, GatewayUpstreamError> {
    if config.kind == AgentBackendKind::CodexSubscription {
        return call_codex_responses(config, secret, anthropic_req).await;
    }
    let secret = openai_compatible_bearer_token(secret)?;
    let base = config
        .base_url
        .as_deref()
        .unwrap_or_else(|| openai_compatible_default_base(config.kind))
        .trim_end_matches('/');
    let model = openai_compatible_request_model(config, &anthropic_req)?;
    let openai_req = json!({
        "model": model.clone(),
        "input": transcript_from_anthropic(&anthropic_req),
        "tools": tools_from_anthropic(&anthropic_req),
        "max_output_tokens": anthropic_req.get("max_tokens").cloned().unwrap_or(json!(4096)),
    });
    // Pre-flight: when the backend reports a per-model context window
    // (LM Studio's `loaded_context_length`, OpenAI's `context_window_tokens`)
    // and the serialized request obviously won't fit, fail fast with a
    // user-actionable message instead of waiting ~40s for LM Studio to
    // tokenize the prompt and reject it as HTTP 500.
    if let Some(err) = preflight_context_window_check(config, &model, &openai_req) {
        return Err(err);
    }
    let client = reqwest::Client::new();
    let response = client
        .post(openai_api_url(base, "responses"))
        .bearer_auth(secret)
        .json(&openai_req)
        .send()
        .await
        .map_err(|e| GatewayUpstreamError::internal(format!("OpenAI request failed: {e}")))?;
    let status = response.status();
    // Read the body unconditionally — on error this is where LM Studio
    // returns the "load with larger context" message that we want to
    // surface verbatim instead of swallowing via error_for_status().
    let body = response
        .text()
        .await
        .map_err(|e| GatewayUpstreamError::internal(format!("Invalid OpenAI response: {e}")))?;
    if !status.is_success() {
        return Err(GatewayUpstreamError::from_upstream(status.as_u16(), &body));
    }
    let value = serde_json::from_str::<Value>(&body).map_err(|e| {
        // Cap the body in the user-visible error so a non-JSON proxy
        // page (e.g. a Cloudflare 502 HTML splash) doesn't drown the
        // chat UI. Full body still goes to the tracing log via the
        // gateway connection-error path.
        GatewayUpstreamError::internal(format!(
            "Invalid OpenAI response: {e}: {snippet}",
            snippet = truncate_for_error_message(&body)
        ))
    })?;
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
) -> Result<Value, GatewayUpstreamError> {
    let auth = serde_json::from_str::<CodexAuthMaterial>(secret.ok_or_else(|| {
        GatewayUpstreamError::internal(
            "Codex subscription backend requires Codex CLI authentication",
        )
    })?)
    .map_err(|e| {
        GatewayUpstreamError::internal(format!("Invalid Codex gateway auth material: {e}"))
    })?;
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
        .map_err(|e| GatewayUpstreamError::internal(format!("Codex request failed: {e}")))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| GatewayUpstreamError::internal(format!("Invalid Codex response body: {e}")))?;
    if !status.is_success() {
        return Err(GatewayUpstreamError::from_upstream(status.as_u16(), &body));
    }
    let value = openai_response_from_sse(&body).map_err(GatewayUpstreamError::internal)?;
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
    fn lm_studio_routing_classification_pinned() {
        // Pinned: LM Studio MUST stay on the gateway path. Direct
        // routing (`is_anthropic_compatible() == true`) loses our
        // status-code translation, and LM Studio's HTTP 500 for
        // context-overflow ends up in the SDK's retry-with-backoff
        // path — the user sees a multi-minute spinner instead of the
        // actual error. The gateway uses `proxy_anthropic_messages`
        // (not the OpenAI-Responses translator) so streaming
        // pass-through is preserved; only error status codes get
        // rewritten on the way back.
        assert!(AgentBackendKind::LmStudio.needs_gateway());
        assert!(!AgentBackendKind::LmStudio.is_anthropic_compatible());
        // Sanity-check the rest of the matrix to catch a copy-paste
        // misclassification of an unrelated kind.
        assert!(AgentBackendKind::Anthropic.is_anthropic_compatible());
        assert!(AgentBackendKind::Ollama.is_anthropic_compatible());
        assert!(AgentBackendKind::CustomAnthropic.is_anthropic_compatible());
        assert!(AgentBackendKind::OpenAiApi.needs_gateway());
        assert!(AgentBackendKind::CodexSubscription.needs_gateway());
        assert!(AgentBackendKind::CustomOpenAi.needs_gateway());
    }

    #[test]
    fn runtime_hash_changes_when_discovered_context_window_changes() {
        // Regression: LM Studio's loaded_context_length changes when the
        // user reloads a model with a different context slider. The
        // gateway must respawn on that change so the pre-flight check
        // doesn't keep using the stale context size.
        let mut backend = AgentBackendConfig::builtin_lm_studio();
        backend.discovered_models = vec![AgentBackendModel {
            id: "qwen3.6-35b-a3b-ud-mlx".to_string(),
            label: "qwen3.6-35b-a3b-ud-mlx".to_string(),
            context_window_tokens: 4096,
            discovered: true,
        }];
        let small = runtime_hash(&backend, None, Some("qwen3.6-35b-a3b-ud-mlx"));
        backend.discovered_models[0].context_window_tokens = 262_144;
        let large = runtime_hash(&backend, None, Some("qwen3.6-35b-a3b-ud-mlx"));
        assert_ne!(
            small, large,
            "context-window change must rotate the hash so ensure() respawns the gateway"
        );
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
        assert_eq!(
            backend_kind_hash_key(AgentBackendKind::LmStudio),
            "lm_studio"
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

    #[test]
    fn lm_studio_builtin_defaults_match_local_server() {
        let backend = AgentBackendConfig::builtin_lm_studio();
        assert_eq!(backend.id, "lm-studio");
        assert_eq!(backend.kind, AgentBackendKind::LmStudio);
        assert!(
            backend.kind.needs_gateway(),
            "LM Studio routes through our gateway so we can demote its \
             HTTP 500 context-overflow responses to 4xx — without that \
             the Anthropic SDK retries the error with backoff and the \
             user sees a multi-minute spinner. Inside the gateway we use \
             the `proxy_anthropic_messages` pass-through (no wire-format \
             translation) since LM Studio 0.4.1+ speaks Anthropic /v1/messages \
             natively."
        );
        assert!(
            !backend.kind.is_anthropic_compatible(),
            "is_anthropic_compatible() means the spawned CLI talks to the \
             upstream directly with no in-process gateway. LM Studio is \
             *wire-compatible* with Anthropic but still needs the gateway \
             for status-code translation."
        );
        assert_eq!(
            backend.base_url.as_deref(),
            Some("http://localhost:1234"),
            "URL must match LM Studio's stock `lms server start --port 1234` default"
        );
        assert!(backend.model_discovery);
        assert!(!backend.enabled, "Disabled by default until user opts in");
    }

    #[test]
    fn lm_studio_v0_parser_reads_per_model_context_lengths() {
        // Sample shape from `GET /api/v0/models` on LM Studio 0.4+.
        let payload = json!({
            "data": [
                {
                    "id": "qwen2.5-coder-7b-instruct",
                    "type": "llm",
                    "loaded_context_length": 32_768,
                    "max_context_length": 131_072,
                },
                {
                    "id": "llama-3.2-3b-instruct",
                    "type": "llm",
                    "max_context_length": 8_192,
                },
                {
                    "id": "nomic-embed-text-v1.5",
                    "type": "embeddings",
                    "max_context_length": 8_192,
                },
            ]
        });
        let models = lm_studio_models_from_v0(&payload, 4_096);
        assert_eq!(models.len(), 2, "embedding entries must be filtered out");
        assert_eq!(models[0].id, "qwen2.5-coder-7b-instruct");
        assert_eq!(
            models[0].context_window_tokens, 32_768,
            "loaded_context_length wins over max_context_length when both are present"
        );
        assert_eq!(models[1].id, "llama-3.2-3b-instruct");
        assert_eq!(models[1].context_window_tokens, 8_192);
    }

    #[test]
    fn lm_studio_v0_parser_falls_back_to_default_context_when_missing() {
        let payload = json!({
            "data": [{"id": "model-without-context", "type": "llm"}]
        });
        let models = lm_studio_models_from_v0(&payload, 8_192);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].context_window_tokens, 8_192);
    }

    #[test]
    fn openai_compatible_bearer_token_requires_a_real_secret() {
        // Every gateway backend that reaches `call_openai_responses`
        // (OpenAi, Codex, CustomOpenAi) requires a real API key — the
        // gateway does not substitute placeholders. LM Studio's
        // local-first placeholder lives in the LM Studio code path
        // (which is direct-routed and never enters this helper).
        assert_eq!(
            openai_compatible_bearer_token(Some("user-token")).as_deref(),
            Ok("user-token"),
            "user-supplied bearer must be forwarded as-is"
        );
        assert!(openai_compatible_bearer_token(None).is_err());

        // Default base URL still defined for compatibility with the
        // existing call site, but we no longer branch by kind because
        // every remaining gateway-routed backend that uses this default
        // points at the OpenAI API.
        assert_eq!(
            openai_compatible_default_base(AgentBackendKind::OpenAiApi),
            "https://api.openai.com"
        );
        assert_eq!(
            openai_compatible_default_base(AgentBackendKind::CustomOpenAi),
            "https://api.openai.com"
        );
    }

    #[test]
    fn gateway_upstream_error_unwraps_openai_error_message() {
        // The exact shape LM Studio returns for context-length overflow.
        // Body lives inside `error.message`; status is a 4xx so retries stop.
        let body = serde_json::json!({
            "error": {
                "message": "The number of tokens to keep from the initial \
                    prompt is greater than the context length. Try to load \
                    the model with a larger context length, or provide a \
                    shorter input",
                "type": "internal_error",
                "param": null,
                "code": "unknown",
            }
        })
        .to_string();
        let err = GatewayUpstreamError::from_upstream(400, &body);
        assert_eq!(
            err.status, 400,
            "4xx must propagate as 4xx so the SDK does not retry it"
        );
        assert!(
            err.message
                .contains("load the model with a larger context length"),
            "actual upstream message must reach the user, got: {}",
            err.message
        );
        assert!(
            !err.message.starts_with('{'),
            "raw JSON envelope must be unwrapped to error.message"
        );
    }

    #[test]
    fn gateway_upstream_error_falls_back_to_raw_body_when_unparseable() {
        // Plain-text upstream body (not JSON-shaped) must still reach the
        // user; we never silently drop it.
        let err = GatewayUpstreamError::from_upstream(500, "upstream went boom");
        assert_eq!(
            err.status, 502,
            "5xx upstream collapses to 502 (Bad Gateway) for the SDK"
        );
        assert_eq!(err.message, "upstream went boom");

        // Empty body still produces a useful message instead of a blank string.
        let err = GatewayUpstreamError::from_upstream(503, "");
        assert!(
            err.message.contains("503") && err.message.contains("no body"),
            "empty body fallback must mention the status, got: {}",
            err.message
        );
    }

    #[test]
    fn anthropic_error_type_for_routes_status_codes() {
        // Specific 4xx codes get their dedicated Anthropic types so
        // the SDK's retry classifier behaves correctly: 429 stays a
        // rate-limit error (retryable with backoff), 401/403 stay
        // permission/auth (non-retryable), 404 stays not_found.
        assert_eq!(anthropic_error_type_for(401), "authentication_error");
        assert_eq!(anthropic_error_type_for(403), "permission_error");
        assert_eq!(anthropic_error_type_for(404), "not_found_error");
        assert_eq!(anthropic_error_type_for(413), "request_too_large");
        assert_eq!(anthropic_error_type_for(429), "rate_limit_error");
        // Other 4xx fall back to invalid_request_error (the catch-all
        // for "your request is malformed and won't succeed on retry").
        assert_eq!(anthropic_error_type_for(400), "invalid_request_error");
        assert_eq!(anthropic_error_type_for(422), "invalid_request_error");
        // 5xx and anything else collapse to api_error so the SDK's
        // retry-with-backoff path stays in effect for transient outages.
        assert_eq!(anthropic_error_type_for(500), "api_error");
        assert_eq!(anthropic_error_type_for(502), "api_error");
        assert_eq!(anthropic_error_type_for(503), "api_error");
    }

    #[test]
    fn truncate_for_error_message_caps_runaway_payloads() {
        // Short payloads pass through unchanged.
        assert_eq!(truncate_for_error_message("hi"), "hi");

        // Payloads at the cap return as-is (no trailing marker).
        let exact = "x".repeat(512);
        assert_eq!(truncate_for_error_message(&exact), exact);

        // Anything longer is sliced to ≤512 chars and tagged with the
        // original byte count so the user knows the snippet is partial.
        let huge = "y".repeat(5_000);
        let truncated = truncate_for_error_message(&huge);
        assert!(truncated.contains("[truncated, 5000 bytes total]"));
        assert!(
            truncated.len() < 600,
            "truncated output must stay near the cap, got {} bytes",
            truncated.len()
        );

        // Multibyte UTF-8 must not be sliced mid-character.
        let mut wide = String::new();
        for _ in 0..200 {
            wide.push_str("日本語"); // 3 bytes per char
        }
        let truncated = truncate_for_error_message(&wide);
        assert!(
            truncated.is_char_boundary(truncated.len()),
            "truncation must land on a char boundary"
        );
    }

    #[test]
    fn gateway_upstream_error_internal_uses_502() {
        // Local failures (couldn't even reach upstream) are 502 — distinct
        // from a parsed-from-upstream 5xx, but converging on the same code
        // is fine because both indicate "Claudette gateway can't satisfy
        // this request right now".
        let err = GatewayUpstreamError::internal("could not bind socket");
        assert_eq!(err.status, 502);
        assert_eq!(err.message, "could not bind socket");
    }

    #[test]
    fn gateway_upstream_error_promotes_5xx_context_overflow_to_400() {
        // LM Studio classifies "tokens to keep > context length" as HTTP
        // 500 (verified empirically against `lms server` 0.4). Without the
        // message-text demotion, the SDK retries this with exponential
        // backoff and the user sees a 2-3 minute spinner. With it, the
        // request fails fast at 400.
        let body = serde_json::json!({
            "error": {
                "message": "The number of tokens to keep from the initial \
                    prompt is greater than the context length. Try to load \
                    the model with a larger context length, or provide a \
                    shorter input",
                "type": "internal_error",
            }
        })
        .to_string();
        let err = GatewayUpstreamError::from_upstream(500, &body);
        assert_eq!(
            err.status, 400,
            "5xx with context-overflow message must demote to 400 so the \
             SDK does not retry it"
        );
        assert!(err.message.contains("larger context length"));
    }

    #[test]
    fn gateway_upstream_error_keeps_unknown_5xx_at_502() {
        // A 5xx with a generic message (transient outage) must NOT be
        // demoted — that case really should be retried.
        let body = serde_json::json!({
            "error": {"message": "internal server error", "type": "server_error"}
        })
        .to_string();
        let err = GatewayUpstreamError::from_upstream(500, &body);
        assert_eq!(err.status, 502);
        assert_eq!(err.message, "internal server error");
    }

    #[test]
    fn upstream_message_permanent_failure_classifier_recognises_known_phrases() {
        let cases: &[(&str, bool)] = &[
            ("tokens to keep from the initial prompt", true),
            ("greater than the context length", true),
            ("This exceeds the maximum context window", true),
            ("Model is not loaded", true),
            ("model not found", true),
            ("Input is too long", true),
            ("rate limit exceeded, retry after 30s", false),
            ("upstream timed out", false),
            ("internal server error", false),
        ];
        for (msg, expected) in cases {
            assert_eq!(
                upstream_message_is_permanent_failure(msg),
                *expected,
                "classifier disagreed on: {msg:?}"
            );
        }
    }

    #[test]
    fn preflight_context_window_check_rejects_obvious_overflow() {
        // 4096-token loaded context, ~12k bytes of JSON ≈ 3000 approx
        // tokens fits comfortably. Bump to 60k bytes ≈ 15k approx tokens
        // and we trip the 90% gate (3686-token ceiling).
        let mut backend = AgentBackendConfig::builtin_lm_studio();
        backend.discovered_models = vec![AgentBackendModel {
            id: "qwen3.6-35b-a3b-ud-mlx".to_string(),
            label: "qwen3.6-35b-a3b-ud-mlx".to_string(),
            context_window_tokens: 4096,
            discovered: true,
        }];

        // Small request → passes pre-flight.
        let small = json!({
            "model": "qwen3.6-35b-a3b-ud-mlx",
            "input": "ping",
        });
        assert!(
            preflight_context_window_check(&backend, "qwen3.6-35b-a3b-ud-mlx", &small).is_none()
        );

        // Big request → trips pre-flight with a clear message and 400.
        let huge_input = "x".repeat(80_000); // ~20k approx tokens
        let big = json!({
            "model": "qwen3.6-35b-a3b-ud-mlx",
            "input": huge_input,
        });
        let err = preflight_context_window_check(&backend, "qwen3.6-35b-a3b-ud-mlx", &big)
            .expect("oversized request must trip pre-flight");
        assert_eq!(err.status, 400);
        assert!(
            err.message.contains("4096"),
            "error must cite the loaded context size, got: {}",
            err.message
        );
        assert!(err.message.contains("LM Studio"));
    }

    #[test]
    fn preflight_context_window_check_skips_when_window_unknown() {
        // Manual-only model with no discovered context size → no gate
        // (we don't second-guess the user's manual entry).
        let mut backend = AgentBackendConfig::builtin_lm_studio();
        backend.discovered_models.clear();
        backend.manual_models = vec![AgentBackendModel {
            id: "custom-model".to_string(),
            label: "custom-model".to_string(),
            context_window_tokens: 0,
            discovered: false,
        }];
        let req = json!({"model": "custom-model", "input": "x".repeat(100_000)});
        assert!(preflight_context_window_check(&backend, "custom-model", &req).is_none());
    }
}
