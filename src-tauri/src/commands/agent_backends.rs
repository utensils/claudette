use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::sync::Arc;

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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackendStatus {
    pub ok: bool,
    pub message: String,
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

#[derive(Debug, Clone)]
struct GatewayServer {
    base_url: String,
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
    ) -> Result<(String, String), String> {
        let hash = runtime_hash(&config, upstream_secret.as_deref(), model.as_deref());
        if let Some(existing) = self.servers.read().await.get(&config.id)
            && existing.hash == hash
        {
            return Ok((existing.base_url.clone(), hash));
        }

        if let Some(existing) = self.servers.write().await.remove(&config.id) {
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
        let cancel = Arc::new(Notify::new());
        let server = GatewayServer {
            base_url: base_url.clone(),
            hash: hash.clone(),
            cancel: Arc::clone(&cancel),
        };
        self.servers.write().await.insert(config.id.clone(), server);

        tokio::spawn(run_gateway(listener, cancel, config, upstream_secret));
        Ok((base_url, hash))
    }
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
    if backends[idx].kind == AgentBackendKind::Ollama && !discovered.is_empty() {
        backends[idx].manual_models.clear();
        if !backends[idx]
            .default_model
            .as_deref()
            .is_some_and(|model| discovered.iter().any(|found| found.id == model))
        {
            backends[idx].default_model = discovered.first().map(|model| model.id.clone());
        }
    }
    backends[idx].discovered_models = discovered;
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
    test_backend_connectivity(&backend).await
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
    let backend = find_backend(&db, backend_id)?;
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

    let secret = load_secure_secret(SECRET_BUCKET, &backend.id)?;
    if backend.kind.needs_gateway() {
        if backend.kind == AgentBackendKind::OpenAiApi && secret.is_none() {
            return Err("OpenAI API backend requires an API key in Settings → Models".to_string());
        }
        let (gateway_url, hash) = state
            .backend_gateway
            .ensure(backend.clone(), secret, model.map(String::from))
            .await?;
        return Ok(AgentBackendRuntime {
            backend_id: Some(backend.id),
            env: vec![
                ("ANTHROPIC_BASE_URL".to_string(), gateway_url),
                (
                    "ANTHROPIC_AUTH_TOKEN".to_string(),
                    "claudette-gateway".to_string(),
                ),
                (
                    "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY".to_string(),
                    "1".to_string(),
                ),
            ],
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
    Ok(AgentBackendRuntime {
        backend_id: Some(backend.id.clone()),
        env,
        hash: runtime_hash(&backend, secret.as_deref(), model),
    })
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

fn normalize_backend(mut backend: AgentBackendConfig) -> AgentBackendConfig {
    if backend.label.trim().is_empty() {
        backend.label = backend.id.clone();
    }
    if backend.context_window_default == 0 {
        backend.context_window_default = 64_000;
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
    backend
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
                request = request.bearer_auth(secret);
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
        _ => Ok(backend.manual_models.clone()),
    }
}

async fn test_backend_connectivity(backend: &AgentBackendConfig) -> Result<BackendStatus, String> {
    match backend.kind {
        AgentBackendKind::Anthropic => Ok(BackendStatus {
            ok: true,
            message: "Using Claude Code's default authentication".to_string(),
        }),
        AgentBackendKind::CodexSubscription => {
            let output = tokio::process::Command::new("codex")
                .arg("--version")
                .output()
                .await;
            Ok(match output {
                Ok(out) if out.status.success() => BackendStatus {
                    ok: true,
                    message:
                        "Codex CLI is installed. Run codex login if authentication is missing."
                            .to_string(),
                },
                _ => BackendStatus {
                    ok: false,
                    message: "Codex CLI is not installed or not on PATH".to_string(),
                },
            })
        }
        AgentBackendKind::OpenAiApi => Ok(BackendStatus {
            ok: load_secure_secret(SECRET_BUCKET, &backend.id)?.is_some(),
            message: if load_secure_secret(SECRET_BUCKET, &backend.id)?.is_some() {
                "API key saved".to_string()
            } else {
                "API key required".to_string()
            },
        }),
        _ => discover_models(backend).await.map(|models| BackendStatus {
            ok: true,
            message: format!("Connected. Found {} model(s).", models.len()),
        }),
    }
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

fn runtime_hash(config: &AgentBackendConfig, secret: Option<&str>, model: Option<&str>) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    config.id.hash(&mut hasher);
    config.label.hash(&mut hasher);
    format!("{:?}", config.kind).hash(&mut hasher);
    config.base_url.hash(&mut hasher);
    config.enabled.hash(&mut hasher);
    config.default_model.hash(&mut hasher);
    config.model_discovery.hash(&mut hasher);
    model.hash(&mut hasher);
    secret.unwrap_or("").hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

async fn run_gateway(
    listener: TcpListener,
    cancel: Arc<Notify>,
    config: AgentBackendConfig,
    upstream_secret: Option<String>,
) {
    loop {
        tokio::select! {
            _ = cancel.notified() => break,
            accepted = listener.accept() => {
                let Ok((stream, _)) = accepted else { continue };
                let config = config.clone();
                let upstream_secret = upstream_secret.clone();
                tokio::spawn(async move {
                    if let Err(err) = handle_gateway_connection(stream, config, upstream_secret).await {
                        eprintln!("[agent-backend-gateway] {err}");
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

    match (method.as_str(), path.as_str()) {
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

async fn call_openai_responses(
    config: &AgentBackendConfig,
    secret: Option<&str>,
    anthropic_req: Value,
) -> Result<Value, String> {
    if config.kind == AgentBackendKind::CodexSubscription {
        return Err(
            "Codex subscription gateway requires Codex auth extraction support; use OpenAI API for now"
                .to_string(),
        );
    }
    let secret = secret.ok_or("OpenAI-compatible backend requires an API key")?;
    let base = config
        .base_url
        .as_deref()
        .unwrap_or("https://api.openai.com")
        .trim_end_matches('/');
    let model = anthropic_req
        .get("model")
        .and_then(Value::as_str)
        .or(config.default_model.as_deref())
        .ok_or("Missing model")?;
    let openai_req = json!({
        "model": model,
        "input": transcript_from_anthropic(&anthropic_req),
        "tools": tools_from_anthropic(&anthropic_req),
        "max_output_tokens": anthropic_req.get("max_tokens").cloned().unwrap_or(json!(4096)),
    });
    let client = reqwest::Client::new();
    let value = client
        .post(format!("{base}/v1/responses"))
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
        model,
        value,
        anthropic_req
            .get("stream")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    ))
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
    if let Some(text) = value.get("output_text").and_then(Value::as_str)
        && !text.is_empty()
    {
        content.push(json!({"type": "text", "text": text}));
    }
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
    out.push_str("event: message_start\n");
    out.push_str(&format!(
        "data: {}\n\n",
        json!({"type":"message_start","message":message})
    ));
    if let Some(content) = message.get("content").and_then(Value::as_array) {
        for (index, block) in content.iter().enumerate() {
            out.push_str("event: content_block_start\n");
            out.push_str(&format!(
                "data: {}\n\n",
                json!({"type":"content_block_start","index":index,"content_block":block})
            ));
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

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|window| window == b"\r\n\r\n")
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn openai_response_maps_text_to_anthropic_message() {
        let mapped = anthropic_message_from_openai(
            "gpt-test",
            json!({"id":"resp_1","output_text":"hello","usage":{"input_tokens":3,"output_tokens":4}}),
            false,
        );
        assert_eq!(mapped["message"]["content"][0]["text"], "hello");
        assert_eq!(mapped["message"]["usage"]["input_tokens"], 3);
    }
}
