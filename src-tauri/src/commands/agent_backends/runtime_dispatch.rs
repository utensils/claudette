//! Runtime resolution + harness dispatch:
//!
//! - `resolve_backend_runtime` is the chat/send path's main entry point;
//!   it picks the right backend, enforces gates, picks the active
//!   harness, and produces the env / hash / model rewrite the spawn site
//!   needs.
//! - `resolve_backend_request_defaults` fills in the default backend +
//!   model when the caller didn't pass either, applying the alt-backend
//!   gate so the Anthropic fast path keeps working.
//! - `build_codex_app_server_runtime` and the `build_claude_code_*`
//!   family produce the actual runtimes per harness.

use claudette::agent_backend::{
    AgentBackendConfig, AgentBackendKind, AgentBackendRuntime, AgentBackendRuntimeHarness,
};
use claudette::db::Database;
use claudette::plugin::load_secure_secret;

use crate::state::AppState;

use super::codex_auth::load_codex_auth_material;
use super::codex_gate::{
    alternative_backends_enabled, ensure_backend_allowed_by_gate,
    ensure_backend_id_allowed_by_gate, is_always_on_alt_backend,
};
use super::config::{
    SECRET_BUCKET, backend_models_contain, backend_models_signature, backend_request_alias,
    load_backend_configs, runtime_hash, save_backend_configs, select_backend_for_request,
};
use super::discovery::discover_models;

pub async fn resolve_backend_runtime(
    state: &AppState,
    backend_id: Option<&str>,
    model: Option<&str>,
) -> Result<AgentBackendRuntime, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let alternative_backends_enabled = alternative_backends_enabled(&db)?;
    let backends = load_backend_configs(&db)?;
    let default_backend_id = db
        .get_app_setting("default_agent_backend")
        .map_err(|e| e.to_string())?;
    let mut backend =
        select_backend_for_request(&backends, backend_id, model, default_backend_id.as_deref())?;
    ensure_backend_allowed_by_gate(&db, &backend)?;
    if !alternative_backends_enabled && !is_always_on_alt_backend(backend.kind) {
        return Ok(AgentBackendRuntime::default());
    }
    // Anthropic stays a fast-path: no enabled-flag check, no env, no hash.
    // The Claude CLI inherits the parent process's auth state.
    if backend.kind == AgentBackendKind::Anthropic {
        return Ok(AgentBackendRuntime {
            backend_id: Some(backend.id),
            harness: AgentBackendRuntimeHarness::ClaudeCode,
            env: Vec::new(),
            hash: String::new(),
        });
    }
    if !backend.enabled {
        return Err(format!("Backend `{}` is disabled", backend.label));
    }

    let dispatch_harness = backend.effective_harness();

    // Drop the borrowed Database before any `.await` so the resulting
    // future stays `Send` for the Tauri command handler. The Claude-CLI
    // path re-opens it inside the sync block when it needs to persist a
    // hydration.
    drop(db);

    match dispatch_harness {
        AgentBackendRuntimeHarness::CodexAppServer => {
            Ok(build_codex_app_server_runtime(&backend, model))
        }
        AgentBackendRuntimeHarness::AntigravityAcp => {
            Ok(build_antigravity_acp_runtime(&backend, model))
        }
        AgentBackendRuntimeHarness::ClaudeCode => {
            build_claude_code_runtime(state, &mut backend, model).await
        }
    }
}

pub(super) fn build_codex_app_server_runtime(
    backend: &AgentBackendConfig,
    model: Option<&str>,
) -> AgentBackendRuntime {
    AgentBackendRuntime {
        backend_id: Some(backend.id.clone()),
        harness: AgentBackendRuntimeHarness::CodexAppServer,
        env: Vec::new(),
        hash: runtime_hash(backend, None, model),
    }
}

pub(super) fn build_antigravity_acp_runtime(
    backend: &AgentBackendConfig,
    model: Option<&str>,
) -> AgentBackendRuntime {
    AgentBackendRuntime {
        backend_id: Some(backend.id.clone()),
        harness: AgentBackendRuntimeHarness::AntigravityAcp,
        env: Vec::new(),
        hash: runtime_hash(backend, None, model),
    }
}

async fn build_claude_code_runtime(
    state: &AppState,
    backend: &mut AgentBackendConfig,
    model: Option<&str>,
) -> Result<AgentBackendRuntime, String> {
    let secret = if backend.kind == AgentBackendKind::CodexSubscription {
        Some(serde_json::to_string(&load_codex_auth_material()?).map_err(|e| e.to_string())?)
    } else {
        load_secure_secret(SECRET_BUCKET, &backend.id)?
    };
    if backend.kind.needs_gateway() {
        return build_claude_code_gateway_runtime(state, backend, model, secret).await;
    }
    Ok(build_claude_code_direct_runtime(backend, model, secret))
}

async fn build_claude_code_gateway_runtime(
    state: &AppState,
    backend: &mut AgentBackendConfig,
    model: Option<&str>,
    secret: Option<String>,
) -> Result<AgentBackendRuntime, String> {
    if backend.kind == AgentBackendKind::OpenAiApi && secret.is_none() {
        return Err("OpenAI API backend requires an API key in Settings → Models".to_string());
    }
    let pre_hydrate = backend.clone();
    hydrate_gateway_models_for_runtime(backend, model).await?;
    // Persist fresh discoveries (new model list, new context windows)
    // so the UI's token-capacity indicator and the next list_agent_backends
    // call see the live values — without requiring a manual Settings →
    // Models refresh. Limited to a real change to keep the chat-send
    // hot path off the DB writer when nothing has actually moved.
    //
    // Opens a fresh `Database` inside this sync block so the connection
    // (which is `!Sync`) never has to cross an `.await` and the future
    // stays `Send` for Tauri's command dispatcher.
    if backend_models_signature(backend) != backend_models_signature(&pre_hydrate)
        && let Ok(db) = Database::open(&state.db_path)
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
    append_custom_model_env(&mut env, backend, model);
    Ok(AgentBackendRuntime {
        backend_id: Some(backend.id.clone()),
        harness: AgentBackendRuntimeHarness::ClaudeCode,
        env,
        hash,
    })
}

pub(super) fn build_claude_code_direct_runtime(
    backend: &AgentBackendConfig,
    model: Option<&str>,
    secret: Option<String>,
) -> AgentBackendRuntime {
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
    append_custom_model_env(&mut env, backend, model);
    AgentBackendRuntime {
        backend_id: Some(backend.id.clone()),
        harness: AgentBackendRuntimeHarness::ClaudeCode,
        env,
        hash: runtime_hash(backend, secret.as_deref(), model),
    }
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
    let backends = load_backend_configs(db)?;
    if requested_model.is_some() {
        return Ok((requested_backend, requested_model));
    }
    let alternative_backends_enabled = alternative_backends_enabled(db)?;

    if let Some(backend_id) = requested_backend.as_deref() {
        ensure_backend_id_allowed_by_gate(db, backend_id)?;
        let backend_id = backend_request_alias(&backends, backend_id);
        let backend = backends
            .iter()
            .find(|backend| backend.id == backend_id.as_str())
            .ok_or_else(|| format!("Unknown backend `{backend_id}`"))?;
        if !alternative_backends_enabled && !is_always_on_alt_backend(backend.kind) {
            return Ok((requested_backend, requested_model));
        }
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
        return Ok((Some(backend.id.clone()), model));
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
    let default_backend_id = backend_request_alias(&backends, &default_backend_id);
    let Some(backend) = backends
        .iter()
        .find(|backend| backend.id == default_backend_id)
    else {
        return Ok((None, default_model));
    };
    if backend.kind == AgentBackendKind::Anthropic {
        return Ok((Some(backend.id.clone()), default_model));
    }
    if !alternative_backends_enabled && !is_always_on_alt_backend(backend.kind) {
        return Ok((None, default_model));
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

pub(super) fn append_custom_model_env(
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
