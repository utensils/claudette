// NOTE (god-file watch): this file passed 6k lines after the Pi
// harness landed. The Pi-specific resolver cluster (`build_pi_sdk_runtime`,
// `build_pi_provider_override`, `qualify_model_for_pi`,
// `normalize_pi_provider_base_url`, `pi_model_targets_anthropic`,
// `ensure_anthropic_not_routed_through_pi_via_oauth`,
// `claude_oauth_blocks_pi_anthropic`, `discover_pi_models`, and the
// matching `pi_*` test cluster at the bottom) is the most cohesive
// extraction candidate — they share no callers outside this file with
// the Codex / gateway code, and pulling them into a sibling
// `commands/agent_backends/pi.rs` module would let the rest of this
// file go back to "general backend resolution" without invasive
// rewiring. Not done in this PR to keep the diff scoped; tracked as a
// follow-up.
use std::collections::HashMap;
use std::sync::Arc;

use base64::Engine as _;
use futures_util::StreamExt;
use rand::RngCore;
use serde_json::{Value, json};
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Notify, RwLock};

use claudette::agent::resolve_codex_path;
#[cfg(feature = "pi-sdk")]
use claudette::agent_backend::PiProviderOverride;
use claudette::agent_backend::{
    AgentBackendConfig, AgentBackendKind, AgentBackendModel, AgentBackendRuntime,
    AgentBackendRuntimeHarness,
};
use claudette::db::Database;
use claudette::plugin::{delete_secure_secret, load_secure_secret, save_secure_secret};

use crate::state::AppState;

mod auto_detect;
mod codex_auth;
mod codex_gate;
mod config;
mod discovery;

use auto_detect::{
    BackendAutoDetection, apply_backend_auto_detections, backend_auto_detect_disabled,
    persist_backend_auto_detect_opt_out, probe_codex_backend, probe_model_discovery_backend,
    should_probe_backend_auto_detection, skipped_backend_auto_detection,
};
use codex_auth::{CODEX_DEFAULT_BASE_URL, CodexAuthMaterial, load_codex_auth_material};
use codex_gate::{
    LEGACY_NATIVE_CODEX_BACKEND_ID, LEGACY_NATIVE_CODEX_SETTING_KEY, NATIVE_CODEX_BACKEND_ID,
    NATIVE_CODEX_SETTING_KEY, alternative_backends_enabled, ensure_backend_allowed_by_gate,
    ensure_backend_id_allowed_by_gate, ensure_native_codex_enabled, is_always_on_alt_backend,
};
pub use config::{BackendListResponse, BackendSecretUpdate, BackendStatus};
use config::{
    SECRET_BUCKET, apply_discovered_models, backend_models_contain, backend_models_signature,
    backend_request_alias, canonical_backend_id, find_backend, load_backend_configs,
    load_backend_configs_tolerant, normalize_backend, resolve_backend_list_default, runtime_hash,
    save_backend_configs, select_backend_for_request,
};
use discovery::{codex_cli_command, discover_models, openai_api_url, test_backend_connectivity};

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
    let stored_default = db
        .get_app_setting("default_agent_backend")
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| "anthropic".to_string());
    let mut loaded = load_backend_configs_tolerant(&db)?;
    let default_backend_id =
        resolve_backend_list_default(&loaded.backends, &mut loaded.warnings, stored_default);
    Ok(BackendListResponse {
        backends: loaded.backends,
        default_backend_id,
        warnings: loaded.warnings,
    })
}

#[tauri::command]
pub async fn auto_detect_agent_backends(
    state: State<'_, AppState>,
) -> Result<BackendListResponse, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let mut backends = load_backend_configs(&db)?;
    let codex = backends
        .iter()
        .find(|backend| backend.id == NATIVE_CODEX_BACKEND_ID)
        .cloned();
    let ollama = backends
        .iter()
        .find(|backend| backend.id == "ollama")
        .cloned();
    let lm_studio = backends
        .iter()
        .find(|backend| backend.id == "lm-studio")
        .cloned();
    #[cfg(feature = "pi-sdk")]
    let pi = backends.iter().find(|backend| backend.id == "pi").cloned();
    let probe_codex = should_probe_backend_auto_detection(&db, NATIVE_CODEX_BACKEND_ID)?;
    let probe_ollama = should_probe_backend_auto_detection(&db, "ollama")?;
    let probe_lm_studio = should_probe_backend_auto_detection(&db, "lm-studio")?;
    #[cfg(feature = "pi-sdk")]
    let probe_pi = should_probe_backend_auto_detection(&db, "pi")?;

    #[cfg(feature = "pi-sdk")]
    let (codex_detection, ollama_detection, lm_studio_detection, pi_detection) = tokio::join!(
        async move {
            if probe_codex {
                probe_codex_backend(codex).await
            } else {
                skipped_backend_auto_detection(NATIVE_CODEX_BACKEND_ID)
            }
        },
        async move {
            if probe_ollama {
                probe_model_discovery_backend(ollama).await
            } else {
                skipped_backend_auto_detection("ollama")
            }
        },
        async move {
            if probe_lm_studio {
                probe_model_discovery_backend(lm_studio).await
            } else {
                skipped_backend_auto_detection("lm-studio")
            }
        },
        // Pi piggybacks on `probe_model_discovery_backend` because
        // `discover_models` already dispatches to `discover_pi_models`
        // for the `PiSdk` kind, which spawns the same Bun sidecar the
        // Refresh button uses. Pi's discovery is heavier than a
        // localhost probe (Bun cold-start), but it's the only way to
        // populate the chat-header model picker on a fresh launch —
        // without it the user only sees the two seed manual models.
        async move {
            if probe_pi {
                probe_model_discovery_backend(pi).await
            } else {
                skipped_backend_auto_detection("pi")
            }
        },
    );
    #[cfg(not(feature = "pi-sdk"))]
    let (codex_detection, ollama_detection, lm_studio_detection) = tokio::join!(
        async move {
            if probe_codex {
                probe_codex_backend(codex).await
            } else {
                skipped_backend_auto_detection(NATIVE_CODEX_BACKEND_ID)
            }
        },
        async move {
            if probe_ollama {
                probe_model_discovery_backend(ollama).await
            } else {
                skipped_backend_auto_detection("ollama")
            }
        },
        async move {
            if probe_lm_studio {
                probe_model_discovery_backend(lm_studio).await
            } else {
                skipped_backend_auto_detection("lm-studio")
            }
        },
    );
    let mut detections = vec![
        codex_detection,
        ollama_detection,
        lm_studio_detection,
        #[cfg(feature = "pi-sdk")]
        pi_detection,
    ];
    if detections.iter().any(|detection| {
        canonical_backend_id(&detection.backend_id) == NATIVE_CODEX_BACKEND_ID && detection.detected
    }) && !backend_auto_detect_disabled(&db, NATIVE_CODEX_BACKEND_ID)?
    {
        db.set_app_setting(NATIVE_CODEX_SETTING_KEY, "true")
            .map_err(|e| e.to_string())?;
        db.set_app_setting(LEGACY_NATIVE_CODEX_SETTING_KEY, "true")
            .map_err(|e| e.to_string())?;
        backends = load_backend_configs(&db)?;
    }
    let (changed, mut warnings) = apply_backend_auto_detections(&db, &mut backends, &detections)?;
    warnings.extend(
        detections
            .drain(..)
            .filter_map(|detection| detection.warning),
    );
    if changed {
        save_backend_configs(&db, &backends)?;
    }
    let mut loaded = load_backend_configs_tolerant(&db)?;
    loaded.warnings.extend(warnings);

    let stored_default = db
        .get_app_setting("default_agent_backend")
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| "anthropic".to_string());
    let default_backend_id =
        resolve_backend_list_default(&loaded.backends, &mut loaded.warnings, stored_default);

    Ok(BackendListResponse {
        backends: loaded.backends,
        default_backend_id,
        warnings: loaded.warnings,
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
    let backend = normalize_backend(backend);
    ensure_backend_allowed_by_gate(&db, &backend)?;
    persist_backend_auto_detect_opt_out(&db, &backend)?;
    let mut backends = load_backend_configs(&db)?;
    if let Some(existing) = backends.iter_mut().find(|b| b.id == backend.id) {
        *existing = backend;
    } else {
        backends.push(backend);
    }
    save_backend_configs(&db, &backends)?;
    load_backend_configs(&db)
}

/// Persist the user's per-backend runtime override.
///
/// `harness` is `None` to clear the override (the resolver falls back
/// to `AgentBackendKind::default_harness`). A `Some` value must be in
/// the kind's `available_harnesses` list — otherwise the call is
/// rejected so a malicious frontend cannot bypass the per-kind matrix.
/// The built-in Anthropic backend always rejects overrides because its
/// kind only permits the Claude CLI harness.
#[tauri::command]
pub async fn set_agent_backend_runtime_harness(
    backend_id: String,
    harness: Option<AgentBackendRuntimeHarness>,
    state: State<'_, AppState>,
) -> Result<Vec<AgentBackendConfig>, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    ensure_backend_id_allowed_by_gate(&db, &backend_id)?;
    let mut backends = load_backend_configs(&db)?;
    let slot = backends
        .iter_mut()
        .find(|backend| backend.id == backend_id)
        .ok_or_else(|| format!("Unknown backend `{backend_id}`"))?;
    if let Some(harness) = harness {
        if !slot.kind.available_harnesses().contains(&harness) {
            return Err(format!(
                "Backend `{}` ({:?}) does not allow harness `{:?}`",
                slot.id, slot.kind, harness
            ));
        }
        slot.runtime_harness = Some(harness);
    } else {
        slot.runtime_harness = None;
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
        "anthropic"
            | "ollama"
            | "openai-api"
            | "codex-subscription"
            | "codex"
            | "experimental-codex"
            | "pi"
            | "lm-studio"
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
    ensure_backend_id_allowed_by_gate(&db, &backend_id)?;
    let mut backends = load_backend_configs(&db)?;
    let idx = backends
        .iter()
        .position(|backend| backend.id == backend_id)
        .ok_or_else(|| format!("Unknown backend `{backend_id}`"))?;
    ensure_backend_allowed_by_gate(&db, &backends[idx])?;
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
    ensure_backend_id_allowed_by_gate(&db, &backend_id)?;
    let backend = find_backend(&db, Some(&backend_id))?;
    ensure_backend_allowed_by_gate(&db, &backend)?;
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
pub async fn launch_codex_login(state: State<'_, AppState>) -> Result<(), String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    ensure_native_codex_enabled(&db)?;
    let codex_path = resolve_codex_path().await;
    let mut command = codex_cli_command(codex_path);
    let mut child = command
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
            // Anthropic stays a Claude CLI path — no model rewrite.
            // None tells the caller to use its original input.
            model: None,
            pi_provider_override: None,
        });
    }
    if !backend.enabled {
        return Err(format!("Backend `{}` is disabled", backend.label));
    }

    #[cfg(feature = "pi-sdk")]
    ensure_anthropic_not_routed_through_pi_via_oauth(&backend, model).await?;

    // Ollama/LM Studio/OpenAI cards default to (or opt into) the Pi
    // harness, but `effective_harness()` only sees the single backend
    // and can't tell whether the Pi backend itself is enabled. If the
    // user disabled the Pi card in Settings → Models, those PiSdk
    // routes have no sidecar to talk to and should fall back to the
    // Claude CLI path that was the historical default.
    let dispatch_harness = resolve_dispatch_harness(&backend, &backends);

    // Drop the borrowed Database before any `.await` so the resulting
    // future stays `Send` for the Tauri command handler. The Claude-CLI
    // path re-opens it inside the sync block when it needs to persist a
    // hydration.
    drop(db);

    match dispatch_harness {
        AgentBackendRuntimeHarness::CodexAppServer => {
            Ok(build_codex_app_server_runtime(&backend, model))
        }
        #[cfg(feature = "pi-sdk")]
        AgentBackendRuntimeHarness::PiSdk => Ok(build_pi_sdk_runtime(&mut backend, model)),
        AgentBackendRuntimeHarness::ClaudeCode => {
            build_claude_code_runtime(state, &mut backend, model).await
        }
    }
}

/// Decide which harness `resolve_backend_runtime` actually dispatches
/// to. Mostly this is the backend's `effective_harness()`, but if a
/// non-Pi-kind backend (Ollama, LM Studio, OpenAI, …) is configured to
/// route through Pi and the user has disabled the Pi backend itself,
/// we downgrade to the Claude CLI harness so the chat still works.
/// Without this, the user gets a "sidecar not started" failure mid-turn
/// for a state Settings is supposed to control.
///
/// In a build with the Pi harness compiled out, the downgrade logic
/// is unreachable — `effective_harness()` can never return PiSdk
/// because the variant doesn't exist — so the body collapses to
/// returning the effective harness verbatim.
#[cfg(feature = "pi-sdk")]
fn resolve_dispatch_harness(
    backend: &AgentBackendConfig,
    backends: &[AgentBackendConfig],
) -> AgentBackendRuntimeHarness {
    let harness = backend.effective_harness();
    if harness != AgentBackendRuntimeHarness::PiSdk {
        return harness;
    }
    if backend.kind == AgentBackendKind::PiSdk {
        // The Pi card itself — `enabled` is enforced separately by the
        // `!backend.enabled` check earlier in the resolver, so it can't
        // reach this branch with a disabled Pi card.
        return harness;
    }
    let pi_available = backends
        .iter()
        .any(|other| other.kind == AgentBackendKind::PiSdk && other.enabled);
    if pi_available {
        harness
    } else {
        // Pick the first non-Pi harness the kind itself sanctions. The
        // naive fallback to `kind.default_harness()` is wrong here:
        // Ollama / LM Studio / OpenAI default to PiSdk, so returning the
        // default would loop back to the very harness we're trying to
        // downgrade away from. Codex Native's allow-list is
        // `[CodexAppServer, PiSdk]`, so a hardcoded ClaudeCode would
        // route a Codex card through the Claude CLI path (taking the
        // Ollama-style base URL with it) — that's what this branch
        // exists to prevent. Walking the allow-list in order picks
        // CodexAppServer for Codex Native and ClaudeCode for the
        // local-OpenAI-style cards.
        backend
            .kind
            .available_harnesses()
            .iter()
            .copied()
            .find(|candidate| *candidate != AgentBackendRuntimeHarness::PiSdk)
            .unwrap_or_else(|| backend.kind.default_harness())
    }
}

#[cfg(not(feature = "pi-sdk"))]
fn resolve_dispatch_harness(
    backend: &AgentBackendConfig,
    _backends: &[AgentBackendConfig],
) -> AgentBackendRuntimeHarness {
    backend.effective_harness()
}

fn build_codex_app_server_runtime(
    backend: &AgentBackendConfig,
    model: Option<&str>,
) -> AgentBackendRuntime {
    AgentBackendRuntime {
        backend_id: Some(backend.id.clone()),
        harness: AgentBackendRuntimeHarness::CodexAppServer,
        env: Vec::new(),
        hash: runtime_hash(backend, None, model),
        // Codex app-server speaks bare ids; no rewrite needed.
        model: None,
        pi_provider_override: None,
    }
}

#[cfg(feature = "pi-sdk")]
fn build_pi_sdk_runtime(
    backend: &mut AgentBackendConfig,
    model: Option<&str>,
) -> AgentBackendRuntime {
    // The Pi sidecar's registry keys models as `"<provider>/<modelId>"`.
    // The Pi backend card already stores ids in that shape, but when a
    // non-Pi backend (Ollama, LM Studio, OpenAI API, Codex Native) opts
    // into the Pi harness, the user's selected model id is bare (e.g.
    // `"gpt-5.4"`) and we need to prepend the Pi-provider hint so the
    // sidecar's `ModelRegistry.find` lookup hits.
    let qualified = model
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| qualify_model_for_pi(backend.kind, value));
    if let Some(value) = qualified.as_deref() {
        backend.default_model = Some(value.to_string());
    }
    let pi_provider_override = build_pi_provider_override(backend, model);
    AgentBackendRuntime {
        backend_id: Some(backend.id.clone()),
        harness: AgentBackendRuntimeHarness::PiSdk,
        env: Vec::new(),
        hash: runtime_hash(backend, None, qualified.as_deref()),
        // Hand the qualified id to the caller so the Pi spawn at
        // `chat/send.rs` receives `<provider>/<modelId>`, not the
        // bare or slash-bearing input the user picked. Without this
        // an Ollama id like `library/llama3` reaches the sidecar
        // unqualified and `findModel` parses `library` as the
        // provider — the lookup always misses.
        model: qualified,
        pi_provider_override,
    }
}

/// Build a Pi `registerProvider` payload for the local-server kinds
/// (Ollama, LM Studio) so the Pi sidecar can route the user's
/// Claudette-configured backend without a separate `~/.pi/agent/models.json`
/// setup. Returns `None` for kinds Pi already ships a bundled
/// provider for (OpenAI, Anthropic, Codex Native) — registering
/// "openai" with a non-OpenAI base URL there would shadow Pi's
/// official provider for the rest of the session. Also returns `None`
/// when the caller didn't pass a model id (no row to register) or
/// the backend has no `base_url` set.
#[cfg(feature = "pi-sdk")]
fn build_pi_provider_override(
    backend: &AgentBackendConfig,
    model: Option<&str>,
) -> Option<PiProviderOverride> {
    let provider = match backend.kind {
        AgentBackendKind::Ollama => "ollama",
        AgentBackendKind::LmStudio => "lmstudio",
        // OpenAI-compatible cloud and Codex Native names collide with
        // Pi's bundled providers; skip the override and let the user's
        // `~/.pi/agent/models.json` (or Pi's bundled config) drive the
        // route. The Pi card itself never reaches this code path —
        // `qualify_model_for_pi` short-circuits when the kind has no
        // prefix.
        AgentBackendKind::Anthropic
        | AgentBackendKind::CustomAnthropic
        | AgentBackendKind::CodexSubscription
        | AgentBackendKind::OpenAiApi
        | AgentBackendKind::CustomOpenAi
        | AgentBackendKind::CodexNative
        | AgentBackendKind::PiSdk => return None,
    };
    let raw_model_id = model.map(str::trim).filter(|s| !s.is_empty())?;
    let base_url = backend.base_url.as_deref().map(str::trim)?;
    if base_url.is_empty() {
        return None;
    }
    let normalized_base_url = normalize_pi_provider_base_url(backend.kind, base_url);
    // The model row Pi's registry looks up is keyed by the bare id —
    // strip the provider prefix if the caller already qualified it.
    let prefix_with_slash = format!("{provider}/");
    let bare_model_id = raw_model_id
        .strip_prefix(&prefix_with_slash)
        .unwrap_or(raw_model_id);
    // Prefer the friendly label from the discovered/manual models list
    // when we have one; otherwise fall back to the bare id so the
    // picker doesn't show `undefined`.
    let model_label = backend
        .discovered_models
        .iter()
        .chain(backend.manual_models.iter())
        .find(|m| m.id == bare_model_id || m.id == raw_model_id)
        .map(|m| m.label.clone())
        .unwrap_or_else(|| bare_model_id.to_string());
    let context_window = backend
        .discovered_models
        .iter()
        .chain(backend.manual_models.iter())
        .find(|m| m.id == bare_model_id || m.id == raw_model_id)
        .map(|m| m.context_window_tokens)
        .unwrap_or(0);
    Some(PiProviderOverride {
        provider: provider.to_string(),
        base_url: normalized_base_url,
        model_id: bare_model_id.to_string(),
        model_label,
        context_window,
    })
}

/// Ollama serves an OpenAI-compatible API under `/v1` while LM Studio
/// already exposes that path by default. Pi's OpenAI-style provider
/// expects the base URL to point at the OpenAI-compat root, so append
/// `/v1` when the caller's base URL doesn't already include it. Idempotent.
#[cfg(feature = "pi-sdk")]
fn normalize_pi_provider_base_url(kind: AgentBackendKind, base_url: &str) -> String {
    let trimmed = base_url.trim_end_matches('/');
    match kind {
        AgentBackendKind::Ollama | AgentBackendKind::LmStudio => {
            if trimmed.ends_with("/v1") {
                trimmed.to_string()
            } else {
                format!("{trimmed}/v1")
            }
        }
        _ => trimmed.to_string(),
    }
}

#[cfg(feature = "pi-sdk")]
fn qualify_model_for_pi(kind: AgentBackendKind, model: &str) -> String {
    // The Pi card's own ids are already `<provider>/<modelId>`; for
    // every other kind (Ollama, LM Studio, OpenAI, CustomOpenAI, Codex
    // Native) the user picks a bare model id and we prepend the kind's
    // Pi-provider prefix so Pi's `ModelRegistry.find(provider, id)` hits.
    //
    // We deliberately don't bail out on a plain `model.contains('/')`:
    // Ollama-style ids legitimately contain slashes (`library/llama3`,
    // `user/custom-model`), and stripping the prefix there would route
    // `library/llama3` through Pi un-qualified, which never resolves.
    // Instead, only skip prefixing when the id is *already* qualified
    // with the same prefix this kind would have applied.
    let Some(prefix) = kind.pi_provider_prefix() else {
        return model.to_string();
    };
    let prefix_with_slash = format!("{prefix}/");
    if model.starts_with(&prefix_with_slash) {
        return model.to_string();
    }
    format!("{prefix}/{model}")
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
    append_custom_model_env(&mut env, backend, model);
    Ok(AgentBackendRuntime {
        backend_id: Some(backend.id.clone()),
        harness: AgentBackendRuntimeHarness::ClaudeCode,
        env,
        hash,
        // Claude CLI uses the caller's input directly.
        model: None,
        pi_provider_override: None,
    })
}

fn build_claude_code_direct_runtime(
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
    append_custom_model_env(&mut env, backend, model);
    AgentBackendRuntime {
        backend_id: Some(backend.id.clone()),
        harness: AgentBackendRuntimeHarness::ClaudeCode,
        env,
        hash: runtime_hash(backend, secret.as_deref(), model),
        // Claude CLI uses the caller's input directly.
        model: None,
        pi_provider_override: None,
    }
}

/// Defense-in-depth: when the user picks an Anthropic model via Pi and
/// the local Claude CLI is signed in with an OAuth subscription token,
/// refuse the routing. Claude OAuth tokens must never leave the Claude
/// CLI subprocess; the picker already hides this case in the UI but a
/// stale persisted selection or a slash-command typed `model:` value
/// can still hit the resolver. Returns Ok for the (overwhelming) majority
/// case where the gate does not apply.
#[cfg(feature = "pi-sdk")]
async fn ensure_anthropic_not_routed_through_pi_via_oauth(
    backend: &AgentBackendConfig,
    model: Option<&str>,
) -> Result<(), String> {
    if backend.effective_harness() != AgentBackendRuntimeHarness::PiSdk {
        return Ok(());
    }
    let Some(model) = model.map(str::trim).filter(|m| !m.is_empty()) else {
        // No explicit model — Pi will pick a default from its registry,
        // which the user can only target via this code path by setting
        // `default_model` to an Anthropic id. The Pi backend's own
        // default_model gate is the last line of defense.
        let default = backend.default_model.as_deref().unwrap_or("");
        if !pi_model_targets_anthropic(default) {
            return Ok(());
        }
        return claude_oauth_blocks_pi_anthropic().await;
    };
    let qualified = qualify_model_for_pi(backend.kind, model);
    if !pi_model_targets_anthropic(&qualified) {
        return Ok(());
    }
    claude_oauth_blocks_pi_anthropic().await
}

#[cfg(feature = "pi-sdk")]
fn pi_model_targets_anthropic(model_id: &str) -> bool {
    let trimmed = model_id.trim();
    if trimmed.is_empty() {
        return false;
    }
    // Provider-qualified form (`anthropic/...` or `claude/...`) — the
    // common case the picker emits.
    if let Some(prefix) = trimmed.split('/').next() {
        let prefix = prefix.trim();
        if prefix.eq_ignore_ascii_case("anthropic") || prefix.eq_ignore_ascii_case("claude") {
            return true;
        }
        if prefix != trimmed {
            // Slash-bearing id whose prefix isn't Anthropic — that's
            // some other provider (`openai/...`, `ollama/...`, etc.).
            // The provider prefix is the authoritative routing signal,
            // don't re-scan the rest of the id.
            return false;
        }
    }
    // Bare id (no slash). Pi's `findModel` falls back to scanning the
    // whole registry, so a bare `claude-opus-4-5` typed by a slash
    // command or sent through IPC would still resolve to the Anthropic
    // provider — bypassing the OAuth gate. Match Anthropic's own
    // naming convention so the gate still trips. Examples:
    //   `claude`            → matches
    //   `claude-3-opus`     → matches
    //   `claude_haiku`      → matches
    //   `claude-instant-1`  → matches
    //   `opus` / `sonnet` / `haiku` → match (Claude Code's
    //                        canonical bare aliases — the picker, the
    //                        `/model` slash command, and the
    //                        `default_model` setting all accept these
    //                        shorthand strings, and a Pi `findModel`
    //                        scan of a custom `~/.pi/agent/models.json`
    //                        could resolve them to an Anthropic row)
    //   `clade-x`           → does NOT match (no `claude` token)
    //   `mistral-7b`        → does NOT match
    let lowered = trimmed.to_ascii_lowercase();
    if matches!(lowered.as_str(), "claude" | "opus" | "sonnet" | "haiku") {
        return true;
    }
    lowered.starts_with("claude-")
        || lowered.starts_with("claude_")
        || lowered.starts_with("opus-")
        || lowered.starts_with("opus_")
        || lowered.starts_with("sonnet-")
        || lowered.starts_with("sonnet_")
        || lowered.starts_with("haiku-")
        || lowered.starts_with("haiku_")
}

#[cfg(feature = "pi-sdk")]
async fn claude_oauth_blocks_pi_anthropic() -> Result<(), String> {
    if crate::commands::auth::is_claude_oauth_authenticated().await {
        Err(
            "Pi cannot route Anthropic models while you're signed in with a Claude subscription. \
             Pick a non-Anthropic Pi provider, or switch this backend's runtime to Claude CLI."
                .to_string(),
        )
    } else {
        Ok(())
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
    #[cfg(feature = "pi-sdk")]
    use super::auto_detect::PI_AUTO_DETECT_TIMEOUT;
    use super::auto_detect::{
        AUTO_DETECT_TIMEOUT, auto_detect_disabled_key, backend_auto_detect_timeout,
        codex_startup_models,
    };
    use super::codex_gate::FIRST_CLASS_BACKENDS_PROMOTION_KEY;
    use super::config::{SETTINGS_KEY, backend_kind_hash_key, read_unknown_passthrough};
    use super::discovery::{
        codex_models_from_debug_catalog, codex_native_models_from_app_server,
        ensure_codex_native_authenticated, filter_openai_models, lm_studio_models_from_v0,
        models_from_openai_shape,
    };
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
    fn codex_cli_command_centralizes_windows_safe_background_spawns() {
        let command = codex_cli_command("codex");
        assert_eq!(command.as_std().get_program(), "codex");
        assert!(
            command
                .as_std()
                .get_envs()
                .any(|(key, value)| key == "PATH" && value.is_some()),
            "Codex CLI probes should use Claudette's enriched PATH",
        );

        // Rust does not expose a stable getter for Windows creation flags on
        // `Command`, so keep a source-level tripwire around the helper that
        // protects startup refresh, Settings refresh, and login-status probes
        // from allocating black cmd.exe windows in release builds.
        let source = include_str!("discovery.rs");
        let helper_start = source
            .find("fn codex_cli_command")
            .expect("helper should remain in the discovery submodule");
        let helper_end = source[helper_start..]
            .find("\n}\n\npub(super) fn filter_openai_models")
            .expect("helper should stay before the OpenAI model filter")
            + helper_start;
        assert!(
            source[helper_start..helper_end].contains(".no_console_window()"),
            "Codex CLI helper must suppress Windows console windows",
        );
    }

    #[test]
    fn codex_native_models_from_app_server_surface_picker_models() {
        let backend = AgentBackendConfig::builtin_codex_native();
        let models = codex_native_models_from_app_server(
            &backend,
            vec![
                claudette::agent::codex_app_server::CodexAppServerModel {
                    id: "gpt-hidden".to_string(),
                    label: "Hidden".to_string(),
                    hidden: true,
                    is_default: false,
                },
                claudette::agent::codex_app_server::CodexAppServerModel {
                    id: "gpt-5.3-codex".to_string(),
                    label: "GPT-5.3 Codex".to_string(),
                    hidden: false,
                    is_default: false,
                },
                claudette::agent::codex_app_server::CodexAppServerModel {
                    id: "gpt-5.4".to_string(),
                    label: "GPT-5.4".to_string(),
                    hidden: false,
                    is_default: true,
                },
            ],
            &[
                AgentBackendModel {
                    id: "gpt-5.4".to_string(),
                    label: "gpt-5.4".to_string(),
                    context_window_tokens: 272_000,
                    discovered: true,
                },
                AgentBackendModel {
                    id: "gpt-5.3-codex".to_string(),
                    label: "gpt-5.3-codex".to_string(),
                    context_window_tokens: 128_000,
                    discovered: true,
                },
            ],
        );

        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "gpt-5.4");
        assert_eq!(models[0].label, "GPT-5.4");
        assert!(models.iter().all(|model| model.discovered));
        assert_eq!(models[0].context_window_tokens, 272_000);
        assert_eq!(models[1].context_window_tokens, 128_000);
    }

    #[test]
    fn codex_native_models_leave_seed_models_untouched_when_server_returns_none() {
        let backend = AgentBackendConfig::builtin_codex_native();

        let models = codex_native_models_from_app_server(&backend, Vec::new(), &[]);

        assert!(models.is_empty());
    }

    #[test]
    fn codex_debug_catalog_prefers_effective_context_window() {
        let models = codex_models_from_debug_catalog(&json!({
            "models": [
                {
                    "slug": "gpt-5.4",
                    "display_name": "GPT-5.4",
                    "visibility": "list",
                    "context_window": 272000,
                    "max_context_window": 1000000
                },
                {
                    "slug": "gpt-5.3-codex-spark",
                    "display_name": "GPT-5.3-Codex-Spark",
                    "visibility": "list",
                    "context_window": 128000,
                    "max_context_window": 128000
                },
                {
                    "slug": "hidden",
                    "display_name": "Hidden",
                    "visibility": "hidden",
                    "context_window": 1
                }
            ]
        }))
        .expect("catalog parses");

        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "gpt-5.4");
        assert_eq!(models[0].context_window_tokens, 272_000);
        assert_eq!(models[1].id, "gpt-5.3-codex-spark");
        assert_eq!(models[1].context_window_tokens, 128_000);
    }

    #[test]
    fn codex_native_auth_requires_openai_account() {
        let account = claudette::agent::codex_app_server::CodexAppServerAccountStatus {
            authenticated: false,
            requires_openai_auth: true,
            account_type: None,
            email: None,
            plan_type: None,
        };

        let err = ensure_codex_native_authenticated(&account).expect_err("auth should fail");

        assert!(err.contains("codex login"));
    }

    #[test]
    fn codex_native_auth_accepts_chatgpt_account_requiring_openai_auth() {
        let account = claudette::agent::codex_app_server::CodexAppServerAccountStatus {
            authenticated: true,
            requires_openai_auth: true,
            account_type: Some("chatgpt".to_string()),
            email: Some("dev@example.com".to_string()),
            plan_type: Some("pro".to_string()),
        };

        ensure_codex_native_authenticated(&account).expect("chatgpt account is authenticated");
    }

    #[test]
    fn auto_detection_enables_detected_builtin_backends() {
        let db = Database::open_in_memory().expect("test db should open");
        let mut backends = load_backend_configs(&db).expect("backends should load");
        let detections = vec![
            BackendAutoDetection {
                backend_id: "codex".to_string(),
                detected: true,
                discovered_models: Vec::new(),
                warning: None,
            },
            BackendAutoDetection {
                backend_id: "ollama".to_string(),
                detected: true,
                discovered_models: vec![model("qwen3-coder")],
                warning: None,
            },
            BackendAutoDetection {
                backend_id: "lm-studio".to_string(),
                detected: true,
                discovered_models: vec![model("local-model")],
                warning: None,
            },
        ];

        let (changed, warnings) = apply_backend_auto_detections(&db, &mut backends, &detections)
            .expect("detections should apply");

        assert!(changed);
        assert!(warnings.is_empty());
        let codex = backends.iter().find(|b| b.id == "codex").expect("codex");
        let ollama = backends.iter().find(|b| b.id == "ollama").expect("ollama");
        let lm_studio = backends
            .iter()
            .find(|b| b.id == "lm-studio")
            .expect("lm studio");
        assert!(codex.enabled);
        assert!(ollama.enabled);
        assert_eq!(ollama.default_model.as_deref(), Some("qwen3-coder"));
        assert!(lm_studio.enabled);
        assert_eq!(lm_studio.default_model.as_deref(), Some("local-model"));
    }

    #[test]
    fn codex_startup_models_hydrate_seeded_models_for_auto_detection() {
        let mut backend = AgentBackendConfig::builtin_codex_native();
        backend.manual_models[0].label.clear();
        backend.manual_models[0].context_window_tokens = 0;

        let models = codex_startup_models(&backend);

        assert_eq!(
            models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            vec!["gpt-5.4", "gpt-5.3-codex"]
        );
        assert!(models.iter().all(|model| model.discovered));
        assert_eq!(models[0].label, "gpt-5.4");
        assert_eq!(
            models[0].context_window_tokens,
            backend.context_window_default
        );
    }

    #[test]
    fn codex_startup_models_do_not_replace_existing_discovery_results() {
        let mut backend = AgentBackendConfig::builtin_codex_native();
        backend.discovered_models = vec![model("gpt-5.5")];

        assert!(codex_startup_models(&backend).is_empty());
    }

    #[test]
    fn auto_detection_overrides_old_disabled_rows_without_opt_out() {
        let db = Database::open_in_memory().expect("test db should open");
        let mut ollama = AgentBackendConfig::builtin_ollama();
        ollama.enabled = false;
        save_backend_configs(&db, &[ollama]).expect("config should save");
        let mut backends = load_backend_configs(&db).expect("backends should load");

        let (changed, _) = apply_backend_auto_detections(
            &db,
            &mut backends,
            &[BackendAutoDetection {
                backend_id: "ollama".to_string(),
                detected: true,
                discovered_models: Vec::new(),
                warning: None,
            }],
        )
        .expect("detections should apply");

        assert!(changed);
        assert!(
            backends
                .iter()
                .find(|backend| backend.id == "ollama")
                .expect("ollama")
                .enabled
        );
    }

    #[test]
    fn auto_detection_respects_manual_opt_out() {
        let db = Database::open_in_memory().expect("test db should open");
        db.set_app_setting(&auto_detect_disabled_key("ollama"), "true")
            .expect("opt-out should save");
        let mut backends = load_backend_configs(&db).expect("backends should load");

        let (changed, _) = apply_backend_auto_detections(
            &db,
            &mut backends,
            &[BackendAutoDetection {
                backend_id: "ollama".to_string(),
                detected: true,
                discovered_models: vec![model("qwen3-coder")],
                warning: None,
            }],
        )
        .expect("detections should apply");

        assert!(!changed);
        let ollama = backends.iter().find(|b| b.id == "ollama").expect("ollama");
        assert!(!ollama.enabled);
        assert!(ollama.discovered_models.is_empty());
    }

    #[test]
    fn auto_detection_probe_plan_respects_manual_opt_outs_before_probe_work() {
        let db = Database::open_in_memory().expect("test db should open");
        db.set_app_setting(&auto_detect_disabled_key("ollama"), "true")
            .expect("ollama opt-out should save");
        db.set_app_setting(&auto_detect_disabled_key(NATIVE_CODEX_BACKEND_ID), "true")
            .expect("codex opt-out should save");

        assert!(
            !should_probe_backend_auto_detection(&db, "ollama")
                .expect("ollama probe flag should load")
        );
        assert!(
            !should_probe_backend_auto_detection(&db, LEGACY_NATIVE_CODEX_BACKEND_ID)
                .expect("legacy codex probe flag should load")
        );
        assert!(
            should_probe_backend_auto_detection(&db, "lm-studio")
                .expect("lm studio probe flag should load")
        );
        let skipped = skipped_backend_auto_detection("ollama");
        assert_eq!(skipped.backend_id, "ollama");
        assert!(!skipped.detected);
        assert!(skipped.discovered_models.is_empty());
    }

    #[test]
    fn codex_auto_detection_can_restore_disabled_gate_without_opt_out() {
        let db = Database::open_in_memory().expect("test db should open");
        db.set_app_setting(FIRST_CLASS_BACKENDS_PROMOTION_KEY, "true")
            .expect("promotion should save");
        db.set_app_setting(NATIVE_CODEX_SETTING_KEY, "false")
            .expect("codex setting should save");
        db.set_app_setting(LEGACY_NATIVE_CODEX_SETTING_KEY, "false")
            .expect("legacy codex setting should save");

        db.set_app_setting(NATIVE_CODEX_SETTING_KEY, "true")
            .expect("auto-detect should restore gate");
        db.set_app_setting(LEGACY_NATIVE_CODEX_SETTING_KEY, "true")
            .expect("auto-detect should restore legacy gate");
        let mut backends = load_backend_configs(&db).expect("backends should load");
        let (changed, _) = apply_backend_auto_detections(
            &db,
            &mut backends,
            &[BackendAutoDetection {
                backend_id: "codex".to_string(),
                detected: true,
                discovered_models: Vec::new(),
                warning: None,
            }],
        )
        .expect("detections should apply");

        assert!(!changed);
        assert!(
            backends
                .iter()
                .find(|backend| backend.id == "codex")
                .expect("codex")
                .enabled
        );
    }

    #[test]
    fn tolerant_load_skips_unknown_kind_and_preserves_passthrough() {
        // Simulates the reported breakage: a newer build wrote a
        // `lm_studio` entry, an older build is now reading it. The
        // unknown entry must NOT take down the rest of the panel —
        // valid entries (and the built-in defaults) should still load.
        let db = Database::open_in_memory().expect("test db should open");
        let mut ollama = AgentBackendConfig::builtin_ollama();
        ollama.enabled = true;
        let mut ollama_value = serde_json::to_value(&ollama).expect("ollama serializes");
        // Pollute the entry with a future-only field to also verify
        // serde tolerates additive fields (it does, by default —
        // deny_unknown_fields is not set on AgentBackendConfig).
        ollama_value
            .as_object_mut()
            .expect("object")
            .insert("future_only_field".to_string(), serde_json::json!(7));

        let unknown_value = serde_json::json!({
            "id": "future-thing",
            "label": "Future Thing",
            "kind": "totally_new_backend",
            "enabled": true
        });

        let raw = serde_json::Value::Array(vec![ollama_value, unknown_value]);
        db.set_app_setting(SETTINGS_KEY, &raw.to_string())
            .expect("seed should save");

        let loaded = load_backend_configs_tolerant(&db).expect("tolerant load should succeed");

        // Ollama applied on top of the default.
        let ollama = loaded
            .backends
            .iter()
            .find(|b| b.id == "ollama")
            .expect("ollama survived tolerant load");
        assert!(ollama.enabled);

        // Anthropic default still present (loader merges into defaults).
        assert!(loaded.backends.iter().any(|b| b.id == "anthropic"));

        // Unknown entry observable via the read helper, not dropped.
        let passthrough = read_unknown_passthrough(&db).expect("passthrough read should succeed");
        assert_eq!(passthrough.len(), 1);
        assert_eq!(
            passthrough[0].get("id").and_then(Value::as_str),
            Some("future-thing")
        );

        // User-visible warning names the offending id+kind.
        assert_eq!(loaded.warnings.len(), 1);
        let warning = &loaded.warnings[0];
        assert!(
            warning.contains("future-thing") && warning.contains("totally_new_backend"),
            "warning should name the offending entry: {warning}"
        );
    }

    #[test]
    fn native_codex_gate_replaces_subscription_builtin() {
        let db = Database::open_in_memory().expect("test db should open");
        db.set_app_setting(NATIVE_CODEX_SETTING_KEY, "true")
            .expect("setting should save");

        let loaded = load_backend_configs(&db).expect("backends should load");

        assert!(loaded.iter().any(|b| b.id == "codex"));
        assert!(!loaded.iter().any(|b| b.id == "codex-subscription"));
        let codex = loaded
            .iter()
            .find(|b| b.id == "codex")
            .expect("native codex backend should be present");
        assert_eq!(codex.kind, AgentBackendKind::CodexNative);
        assert!(codex.model_discovery);
    }

    #[test]
    fn native_codex_gate_hides_stored_subscription_backend() {
        let db = Database::open_in_memory().expect("test db should open");
        db.set_app_setting(NATIVE_CODEX_SETTING_KEY, "true")
            .expect("setting should save");
        let mut legacy = AgentBackendConfig::builtin_codex_subscription();
        legacy.enabled = true;
        save_backend_configs(&db, &[legacy]).expect("legacy backend config should save");

        let loaded = load_backend_configs(&db).expect("backends should load");

        assert!(loaded.iter().any(|b| b.id == "codex"));
        assert!(!loaded.iter().any(|b| b.id == "codex-subscription"));
    }

    #[test]
    fn native_codex_gate_preserves_hidden_subscription_on_save() {
        let db = Database::open_in_memory().expect("test db should open");
        db.set_app_setting(NATIVE_CODEX_SETTING_KEY, "true")
            .expect("setting should save");
        let mut legacy = AgentBackendConfig::builtin_codex_subscription();
        legacy.enabled = true;
        legacy.default_model = Some("gpt-hidden-legacy".to_string());
        save_backend_configs(&db, &[legacy]).expect("legacy backend config should save");

        let loaded = load_backend_configs(&db).expect("backends should load");
        save_backend_configs(&db, &loaded).expect("active backends should save");

        let raw = db
            .get_app_setting(SETTINGS_KEY)
            .expect("settings should read")
            .expect("settings should exist");
        let entries: Vec<AgentBackendConfig> =
            serde_json::from_str(&raw).expect("settings should deserialize");
        let preserved = entries
            .iter()
            .find(|backend| backend.id == "codex-subscription")
            .expect("hidden legacy Codex config should survive save");
        assert!(preserved.enabled);
        assert_eq!(
            preserved.default_model.as_deref(),
            Some("gpt-hidden-legacy")
        );
    }

    #[test]
    fn legacy_codex_gate_hides_and_preserves_native_backend_on_save() {
        let db = Database::open_in_memory().expect("test db should open");
        db.set_app_setting(FIRST_CLASS_BACKENDS_PROMOTION_KEY, "true")
            .expect("setting should save");
        db.set_app_setting(NATIVE_CODEX_SETTING_KEY, "false")
            .expect("setting should save");
        let mut native = AgentBackendConfig::builtin_codex_native();
        native.enabled = true;
        native.default_model = Some("gpt-hidden-native".to_string());
        save_backend_configs(&db, &[native]).expect("native backend config should save");

        let loaded = load_backend_configs(&db).expect("backends should load");
        assert!(!loaded.iter().any(|b| b.id == "codex-subscription"));
        assert!(!loaded.iter().any(|b| b.id == "codex"));

        save_backend_configs(&db, &loaded).expect("active backends should save");

        let raw = db
            .get_app_setting(SETTINGS_KEY)
            .expect("settings should read")
            .expect("settings should exist");
        let entries: Vec<AgentBackendConfig> =
            serde_json::from_str(&raw).expect("settings should deserialize");
        let preserved = entries
            .iter()
            .find(|backend| backend.id == "codex")
            .expect("hidden native Codex config should survive save");
        assert!(preserved.enabled);
        assert_eq!(
            preserved.default_model.as_deref(),
            Some("gpt-hidden-native")
        );
    }

    #[test]
    fn native_codex_gate_aliases_legacy_subscription_requests() {
        let db = Database::open_in_memory().expect("test db should open");
        db.set_app_setting(NATIVE_CODEX_SETTING_KEY, "true")
            .expect("setting should save");
        let mut native = AgentBackendConfig::builtin_codex_native();
        native.enabled = true;
        save_backend_configs(&db, &[native]).expect("native backend config should save");

        let (backend_id, resolved_model) =
            resolve_backend_request_defaults(&db, Some("codex-subscription"), None)
                .expect("legacy codex request should resolve");

        assert_eq!(backend_id.as_deref(), Some("codex"));
        assert_eq!(resolved_model.as_deref(), Some("gpt-5.4"));
    }

    #[test]
    fn disabled_codex_gate_rejects_native_requests_instead_of_aliasing_legacy() {
        let db = Database::open_in_memory().expect("test db should open");
        db.set_app_setting(FIRST_CLASS_BACKENDS_PROMOTION_KEY, "true")
            .expect("setting should save");
        db.set_app_setting("alternative_backends_enabled", "true")
            .expect("setting should save");
        db.set_app_setting(NATIVE_CODEX_SETTING_KEY, "false")
            .expect("setting should save");
        let mut legacy = AgentBackendConfig::builtin_codex_subscription();
        legacy.enabled = true;
        legacy.default_model = Some("gpt-5.3-codex".to_string());
        legacy.discovered_models = vec![model("gpt-5.3-codex")];
        save_backend_configs(&db, &[legacy]).expect("legacy backend config should save");

        let err = resolve_backend_request_defaults(&db, Some("experimental-codex"), None)
            .expect_err("native codex request should require the gate");

        assert!(err.contains("Codex is disabled"));
    }

    #[test]
    fn save_after_tolerant_load_round_trips_unknown_entry() {
        // Regression guard: a downgrade-then-upgrade cycle must not lose
        // the user's LM-Studio-style config. After an older build does a
        // tolerant load and then saves edits, the unknown entry must
        // still be present in SQLite for the newer build to pick up.
        let db = Database::open_in_memory().expect("test db should open");
        let raw = serde_json::json!([
            {
                "id": "future-thing",
                "label": "Future Thing",
                "kind": "totally_new_backend",
                "enabled": true,
                "some_future_field": 42
            }
        ]);
        db.set_app_setting(SETTINGS_KEY, &raw.to_string())
            .expect("seed should save");

        // Older build loads, then saves an unrelated edit (toggling
        // ollama on). The unknown entry should ride along.
        let mut backends = load_backend_configs(&db).expect("tolerant load should succeed");
        let ollama = backends
            .iter_mut()
            .find(|b| b.id == "ollama")
            .expect("default ollama present");
        ollama.enabled = true;
        // The default `builtin_ollama` ships with empty discovered models,
        // so save filters cleanly without needing extra fixture mutation.
        save_backend_configs(&db, &backends).expect("save should succeed");

        let stored_raw = db
            .get_app_setting(SETTINGS_KEY)
            .expect("stored value should read")
            .expect("stored value should exist");
        let stored: Vec<Value> =
            serde_json::from_str(&stored_raw).expect("stored JSON should parse");

        let preserved = stored
            .iter()
            .find(|entry| entry.get("id").and_then(Value::as_str) == Some("future-thing"))
            .expect("unknown entry must round-trip through save");
        assert_eq!(
            preserved.get("kind").and_then(Value::as_str),
            Some("totally_new_backend")
        );
        // Even unknown future-only fields are preserved verbatim.
        assert_eq!(
            preserved.get("some_future_field").and_then(Value::as_i64),
            Some(42)
        );
    }

    #[test]
    fn tolerant_load_falls_back_when_top_level_json_is_garbage() {
        // If the stored blob is corrupt (truncated write, hand-edit
        // typo), the loader must not poison the panel — it returns
        // built-in defaults plus a warning, and crucially does NOT
        // overwrite the corrupt blob (so the user can recover it).
        let db = Database::open_in_memory().expect("test db should open");
        db.set_app_setting(SETTINGS_KEY, "{not valid json")
            .expect("seed should save");

        let loaded = load_backend_configs_tolerant(&db).expect("tolerant load should succeed");

        assert!(loaded.backends.iter().any(|b| b.id == "anthropic"));
        let passthrough = read_unknown_passthrough(&db).expect("passthrough read should succeed");
        assert!(
            passthrough.is_empty(),
            "corrupt top-level JSON has no recoverable passthrough"
        );
        assert_eq!(loaded.warnings.len(), 1);
        assert!(loaded.warnings[0].contains("unreadable"));

        // Corrupt blob untouched on read.
        let still_there = db
            .get_app_setting(SETTINGS_KEY)
            .expect("read should succeed")
            .expect("value still stored");
        assert_eq!(still_there, "{not valid json");
    }

    #[test]
    fn save_after_corrupt_blob_writes_clean_list_and_loses_corrupt_value() {
        // Documents the corrupt-blob save behavior explicitly, since
        // it's the one path where this PR's tolerant loader IS allowed
        // to overwrite stored data: there's no recoverable structure
        // to splice unknowns from. Once a user save runs, the corrupt
        // bytes are gone — by design, with a warning surfaced on the
        // preceding read.
        let db = Database::open_in_memory().expect("test db should open");
        db.set_app_setting(SETTINGS_KEY, "{still not valid json")
            .expect("seed should save");

        let mut backends = load_backend_configs(&db).expect("tolerant load should succeed");
        let ollama = backends
            .iter_mut()
            .find(|b| b.id == "ollama")
            .expect("default ollama present");
        ollama.enabled = true;
        save_backend_configs(&db, &backends).expect("save should succeed");

        let stored_raw = db
            .get_app_setting(SETTINGS_KEY)
            .expect("stored value should read")
            .expect("stored value should exist");
        // Now valid JSON, no passthrough.
        let stored: Vec<Value> = serde_json::from_str(&stored_raw).expect("stored JSON now parses");
        assert!(
            stored
                .iter()
                .all(|entry| serde_json::from_value::<AgentBackendConfig>(entry.clone()).is_ok()),
            "every entry post-save deserializes cleanly"
        );
    }

    #[test]
    fn tolerant_load_warns_per_unknown_entry_and_handles_missing_fields() {
        // Multiple unknown entries with different shapes — including
        // entries missing `id` or `kind` — should each get their own
        // warning and pass through cleanly. Pins the warning placeholder
        // strings (`<no id>` / `<no kind>`) so a later refactor doesn't
        // silently change diagnostic UX.
        let db = Database::open_in_memory().expect("test db should open");
        let raw = serde_json::json!([
            {
                "id": "future-a",
                "label": "Future A",
                "kind": "kind_alpha",
                "enabled": true
            },
            // Missing `kind` — falls into the err arm because
            // AgentBackendConfig requires it.
            {
                "id": "future-b",
                "label": "Future B",
                "enabled": false
            },
            // Missing `id` AND has an entirely unknown kind.
            {
                "label": "Future C",
                "kind": "kind_gamma"
            }
        ]);
        db.set_app_setting(SETTINGS_KEY, &raw.to_string())
            .expect("seed should save");

        let loaded = load_backend_configs_tolerant(&db).expect("tolerant load should succeed");
        assert_eq!(loaded.warnings.len(), 3, "one warning per unknown entry");

        // Placeholder strings stay stable.
        assert!(loaded.warnings.iter().any(|w| w.contains("future-a")));
        assert!(loaded.warnings.iter().any(|w| w.contains("kind_alpha")));
        assert!(loaded.warnings.iter().any(|w| w.contains("future-b")));
        assert!(loaded.warnings.iter().any(|w| w.contains("<no kind>")));
        assert!(loaded.warnings.iter().any(|w| w.contains("<no id>")));
        assert!(loaded.warnings.iter().any(|w| w.contains("kind_gamma")));

        // All three unknowns are observable as passthrough; nothing dropped.
        let passthrough = read_unknown_passthrough(&db).expect("passthrough read should succeed");
        assert_eq!(passthrough.len(), 3);
    }

    #[test]
    fn list_agent_backends_falls_back_when_default_points_to_skipped_unknown() {
        // Regression guard for a Copilot-flagged edge case: if the
        // user's `default_agent_backend` pointed to a backend whose
        // `kind` this build doesn't recognize, the entry is skipped
        // by tolerant load, and the UI would otherwise pre-select a
        // backend that isn't in the returned list. The response must
        // (a) override default_backend_id to a backend that exists,
        // (b) surface a warning, and (c) leave the persisted setting
        // unchanged so a build that does recognize the kind picks it
        // up cleanly.
        let db = Database::open_in_memory().expect("test db should open");
        db.set_app_setting("default_agent_backend", "future-thing")
            .expect("seed default should save");
        let raw = serde_json::json!([
            {
                "id": "future-thing",
                "label": "Future Thing",
                "kind": "totally_new_backend",
                "enabled": true
            }
        ]);
        db.set_app_setting(SETTINGS_KEY, &raw.to_string())
            .expect("seed should save");

        // Mirror what list_agent_backends and auto_detect_agent_backends
        // do post-load.
        let stored_default = db
            .get_app_setting("default_agent_backend")
            .expect("read default")
            .expect("default present");
        let mut loaded = load_backend_configs_tolerant(&db).expect("tolerant load should succeed");
        let default_backend_id =
            resolve_backend_list_default(&loaded.backends, &mut loaded.warnings, stored_default);

        // Fallback wired up correctly.
        assert_eq!(default_backend_id, "anthropic");
        assert!(loaded.backends.iter().any(|b| b.id == "anthropic"));

        // Two warnings: one from the per-entry skip, one from the
        // default-pointer fallback.
        assert!(
            loaded
                .warnings
                .iter()
                .any(|w| w.contains("future-thing") && w.contains("falling back")),
            "warnings should include the default-fallback diagnostic"
        );
        assert!(
            loaded
                .warnings
                .iter()
                .any(|w| w.contains("totally_new_backend")),
            "warnings should still include the per-entry skip diagnostic"
        );

        // Persisted default-setting untouched — a build that does
        // recognize `totally_new_backend` will see the user's choice
        // come back automatically.
        let still_stored = db
            .get_app_setting("default_agent_backend")
            .expect("read default after")
            .expect("default still present");
        assert_eq!(still_stored, "future-thing");
    }

    #[test]
    fn backend_list_default_aliases_legacy_codex_to_available_native_backend() {
        let mut warnings = Vec::new();
        let backends = vec![
            AgentBackendConfig::builtin_anthropic(),
            AgentBackendConfig::builtin_codex_native(),
        ];

        let default_backend_id = resolve_backend_list_default(
            &backends,
            &mut warnings,
            LEGACY_NATIVE_CODEX_BACKEND_ID.to_string(),
        );

        assert_eq!(default_backend_id, NATIVE_CODEX_BACKEND_ID);
        assert!(warnings.is_empty());
    }

    #[test]
    fn save_agent_backend_command_path_preserves_unknown_entries() {
        // Closer to the production path than save_after_tolerant_load_…:
        // simulates what `save_agent_backend` does (load → mutate one
        // known backend → save) starting from a blob that already
        // contains an unknown entry. Pins that the unknown entry
        // survives the full load/merge/save round-trip a user toggle
        // would take.
        let db = Database::open_in_memory().expect("test db should open");
        let mut ollama = AgentBackendConfig::builtin_ollama();
        ollama.enabled = false;
        let ollama_value = serde_json::to_value(&ollama).expect("ollama serializes");
        let unknown = serde_json::json!({
            "id": "future-thing",
            "label": "Future Thing",
            "kind": "kind_omega",
            "enabled": true,
            "future_only_field": "preserved-value"
        });
        let raw = serde_json::Value::Array(vec![ollama_value, unknown]);
        db.set_app_setting(SETTINGS_KEY, &raw.to_string())
            .expect("seed should save");

        // Mirror save_agent_backend's body: load_backend_configs →
        // mutate the matching slot → save_backend_configs.
        let mut backends = load_backend_configs(&db).expect("tolerant load should succeed");
        let slot = backends
            .iter_mut()
            .find(|b| b.id == "ollama")
            .expect("ollama present");
        slot.enabled = true;
        save_backend_configs(&db, &backends).expect("save should succeed");

        let stored_raw = db
            .get_app_setting(SETTINGS_KEY)
            .expect("read should succeed")
            .expect("value present");
        let stored: Vec<Value> = serde_json::from_str(&stored_raw).expect("JSON parses post-save");

        let preserved = stored
            .iter()
            .find(|e| e.get("id").and_then(Value::as_str) == Some("future-thing"))
            .expect("unknown entry survived save_agent_backend-like flow");
        assert_eq!(
            preserved.get("future_only_field").and_then(Value::as_str),
            Some("preserved-value"),
            "future-only fields preserved verbatim"
        );

        // And the user's edit landed.
        let post_load = load_backend_configs(&db).expect("post-save load should succeed");
        let ollama_after = post_load
            .iter()
            .find(|b| b.id == "ollama")
            .expect("ollama present");
        assert!(ollama_after.enabled);
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
    fn backend_defaults_resolve_openai_default_model_for_empty_request() {
        let db = Database::open_in_memory().expect("test db should open");
        db.set_app_setting("alternative_backends_enabled", "true")
            .expect("setting should save");
        db.set_app_setting("default_agent_backend", "openai-api")
            .expect("setting should save");
        db.set_app_setting("default_model", "gpt-5.4")
            .expect("setting should save");

        let mut openai = AgentBackendConfig::builtin_openai_api();
        openai.enabled = true;
        openai.default_model = Some("gpt-5.3-codex".to_string());
        openai.discovered_models = vec![model("gpt-5.3-codex"), model("gpt-5.4")];
        save_backend_configs(&db, &[openai]).expect("backend config should save");

        let (backend_id, resolved_model) =
            resolve_backend_request_defaults(&db, None, None).expect("defaults should resolve");

        assert_eq!(backend_id.as_deref(), Some("openai-api"));
        assert_eq!(resolved_model.as_deref(), Some("gpt-5.4"));
    }

    #[test]
    fn backend_defaults_ignore_stale_global_model_for_non_anthropic_backend() {
        let db = Database::open_in_memory().expect("test db should open");
        db.set_app_setting("alternative_backends_enabled", "true")
            .expect("setting should save");
        db.set_app_setting("default_agent_backend", "openai-api")
            .expect("setting should save");
        db.set_app_setting("default_model", "claude-opus-4-7")
            .expect("setting should save");

        let mut openai = AgentBackendConfig::builtin_openai_api();
        openai.enabled = true;
        openai.default_model = Some("gpt-5.3-codex".to_string());
        openai.discovered_models = vec![model("gpt-5.3-codex"), model("gpt-5.4")];
        save_backend_configs(&db, &[openai]).expect("backend config should save");

        let (backend_id, resolved_model) =
            resolve_backend_request_defaults(&db, None, None).expect("defaults should resolve");

        assert_eq!(backend_id.as_deref(), Some("openai-api"));
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

    #[test]
    fn normalize_backend_resets_stale_experimental_codex_label_for_legacy_id() {
        let mut legacy = AgentBackendConfig::builtin_codex_native();
        legacy.id = LEGACY_NATIVE_CODEX_BACKEND_ID.to_string();
        legacy.label = "Experimental Codex".to_string();
        let normalized = normalize_backend(legacy);
        assert_eq!(normalized.id, NATIVE_CODEX_BACKEND_ID);
        assert_eq!(normalized.label, "Codex");
    }

    #[test]
    fn normalize_backend_resets_stale_experimental_codex_label_for_canonical_id() {
        let mut stale = AgentBackendConfig::builtin_codex_native();
        stale.label = "Experimental Codex".to_string();
        let normalized = normalize_backend(stale);
        assert_eq!(normalized.id, NATIVE_CODEX_BACKEND_ID);
        assert_eq!(normalized.label, "Codex");
    }

    // -- Pi runtime helpers -------------------------------------------------

    #[cfg(feature = "pi-sdk")]
    #[test]
    fn qualify_model_for_pi_prepends_provider_prefix_for_local_kinds() {
        assert_eq!(
            qualify_model_for_pi(AgentBackendKind::Ollama, "llama3"),
            "ollama/llama3"
        );
        assert_eq!(
            qualify_model_for_pi(AgentBackendKind::LmStudio, "qwen3"),
            "lmstudio/qwen3"
        );
    }

    #[cfg(feature = "pi-sdk")]
    #[test]
    fn qualify_model_for_pi_prepends_openai_for_codex_native() {
        assert_eq!(
            qualify_model_for_pi(AgentBackendKind::CodexNative, "gpt-5.4"),
            "openai/gpt-5.4"
        );
    }

    #[cfg(feature = "pi-sdk")]
    #[test]
    fn qualify_model_for_pi_leaves_already_qualified_ids_unchanged() {
        // The Pi card's own ids are already provider/model — never
        // double-prefix them.
        assert_eq!(
            qualify_model_for_pi(AgentBackendKind::PiSdk, "anthropic/claude-opus-4-5"),
            "anthropic/claude-opus-4-5"
        );
        assert_eq!(
            qualify_model_for_pi(AgentBackendKind::Ollama, "ollama/llama3"),
            "ollama/llama3"
        );
    }

    #[cfg(feature = "pi-sdk")]
    #[test]
    fn qualify_model_for_pi_passes_through_when_kind_has_no_prefix() {
        // Subscription-OAuth flavors return None — those models must
        // never reach the Pi sidecar at all (the gate above stops them),
        // but defensively the qualifier doesn't invent a provider.
        assert_eq!(
            qualify_model_for_pi(AgentBackendKind::Anthropic, "sonnet"),
            "sonnet"
        );
    }

    #[cfg(feature = "pi-sdk")]
    #[test]
    fn qualify_model_for_pi_preserves_slash_in_ollama_model_ids() {
        // Ollama model names legitimately contain slashes
        // (`library/llama3`, `user/custom-model`). The old "any slash
        // means already-qualified" heuristic dropped the `ollama/`
        // prefix on these and Pi's registry never resolved them.
        assert_eq!(
            qualify_model_for_pi(AgentBackendKind::Ollama, "library/llama3"),
            "ollama/library/llama3"
        );
        assert_eq!(
            qualify_model_for_pi(AgentBackendKind::Ollama, "user/custom-model"),
            "ollama/user/custom-model"
        );
        // The corresponding LM Studio case (e.g. a manual entry shaped
        // like `studio/foo`) should also pick up the `lmstudio/` prefix.
        assert_eq!(
            qualify_model_for_pi(AgentBackendKind::LmStudio, "studio/foo"),
            "lmstudio/studio/foo"
        );
    }

    #[cfg(feature = "pi-sdk")]
    #[test]
    fn apply_discovered_models_preserves_pi_manual_entries() {
        // Pi's Settings card exposes a manual-models editor for custom
        // entries the user wires up outside Pi's own `getAvailable()`
        // (e.g. local Ollama via `~/.pi/agent/models.json`, internal
        // proxies). The Codex peer review flagged that the previous
        // implementation included `PiSdk` in the `manual_models.clear()`
        // branch, so every refresh silently deleted user-entered rows.
        // Pin the preservation contract here.
        let mut pi = AgentBackendConfig::builtin_pi_sdk();
        pi.manual_models = vec![AgentBackendModel {
            id: "ollama/custom-llama".to_string(),
            label: "Custom Llama".to_string(),
            context_window_tokens: 64_000,
            discovered: false,
        }];
        let discovered = vec![AgentBackendModel {
            id: "openai/gpt-5.4".to_string(),
            label: "GPT-5.4".to_string(),
            context_window_tokens: 272_000,
            discovered: true,
        }];
        apply_discovered_models(&mut pi, discovered);
        assert_eq!(
            pi.manual_models.len(),
            1,
            "Pi refresh must keep user-entered manual models",
        );
        assert_eq!(pi.manual_models[0].id, "ollama/custom-llama");
        // Discovered list is replaced, as expected.
        assert_eq!(pi.discovered_models.len(), 1);
        assert_eq!(pi.discovered_models[0].id, "openai/gpt-5.4");
    }

    #[test]
    fn apply_discovered_models_still_clears_manual_for_ollama_card() {
        // Sister case: non-Pi auto-detected backends (Ollama, LM Studio,
        // cloud OpenAI, Codex) keep the historical behaviour where
        // discovery replaces manual entries. Without this guard the Pi
        // fix above could regress into "no backend ever clears manuals".
        let mut ollama = AgentBackendConfig::builtin_ollama();
        ollama.manual_models = vec![AgentBackendModel {
            id: "stale-manual".to_string(),
            label: "Stale".to_string(),
            context_window_tokens: 8_000,
            discovered: false,
        }];
        let discovered = vec![AgentBackendModel {
            id: "llama3".to_string(),
            label: "Llama 3".to_string(),
            context_window_tokens: 128_000,
            discovered: true,
        }];
        apply_discovered_models(&mut ollama, discovered);
        assert!(
            ollama.manual_models.is_empty(),
            "Ollama refresh continues to clear manuals — Pi is the exception"
        );
    }

    #[cfg(feature = "pi-sdk")]
    #[test]
    fn apply_discovered_models_default_model_honors_pi_manual_entries() {
        // When the user's default_model points at a manual Pi row, the
        // discovery pass must not overwrite that selection with a
        // discovered model. Otherwise the default flips to whatever Pi
        // happens to surface first the next time the Pi sidecar refreshes
        // (which can change with auth status), silently re-routing the
        // user's chats. Mirrors the discovered-models check that already
        // protected non-Pi defaults.
        let mut pi = AgentBackendConfig::builtin_pi_sdk();
        pi.manual_models = vec![AgentBackendModel {
            id: "ollama/custom-llama".to_string(),
            label: "Custom Llama".to_string(),
            context_window_tokens: 64_000,
            discovered: false,
        }];
        pi.default_model = Some("ollama/custom-llama".to_string());
        let discovered = vec![AgentBackendModel {
            id: "openai/gpt-5.4".to_string(),
            label: "GPT-5.4".to_string(),
            context_window_tokens: 272_000,
            discovered: true,
        }];
        apply_discovered_models(&mut pi, discovered);
        assert_eq!(
            pi.default_model.as_deref(),
            Some("ollama/custom-llama"),
            "manual default must survive a refresh that doesn't include it"
        );
    }

    #[cfg(feature = "pi-sdk")]
    #[test]
    fn pi_runtime_emits_ollama_provider_override_with_v1_base_url() {
        // Ollama's API is OpenAI-compatible at `/v1`. Claudette's
        // backend stores the bare host, so the override builder must
        // append the `/v1` suffix so Pi's `registerProvider` lands on
        // the OpenAI-style chat completions endpoint and the agent
        // loop can actually reach the local server.
        let mut ollama = AgentBackendConfig::builtin_ollama();
        ollama.base_url = Some("http://localhost:11434".to_string());
        ollama.discovered_models = vec![claudette::agent_backend::AgentBackendModel {
            id: "llama3".to_string(),
            label: "Llama 3".to_string(),
            context_window_tokens: 128_000,
            discovered: true,
        }];
        let runtime = build_pi_sdk_runtime(&mut ollama, Some("llama3"));
        let override_ = runtime
            .pi_provider_override
            .expect("Ollama route should emit a provider override");
        assert_eq!(override_.provider, "ollama");
        assert_eq!(override_.base_url, "http://localhost:11434/v1");
        assert_eq!(override_.model_id, "llama3");
        assert_eq!(override_.model_label, "Llama 3");
        assert_eq!(override_.context_window, 128_000);
    }

    #[cfg(feature = "pi-sdk")]
    #[test]
    fn pi_runtime_provider_override_preserves_v1_already_in_base_url() {
        // Idempotency: if the user's LM Studio card already points at
        // `http://localhost:1234/v1`, we must not append a second
        // `/v1`. The fix to `normalize_pi_provider_base_url` is the
        // load-bearing piece here.
        let mut lmstudio = AgentBackendConfig::builtin_lm_studio();
        lmstudio.base_url = Some("http://localhost:1234/v1".to_string());
        let runtime = build_pi_sdk_runtime(&mut lmstudio, Some("openai/gpt-4"));
        let override_ = runtime
            .pi_provider_override
            .expect("LM Studio route should emit a provider override");
        assert_eq!(override_.base_url, "http://localhost:1234/v1");
        // Bare id falls through when the qualified prefix doesn't
        // match LM Studio's `lmstudio` prefix.
        assert_eq!(override_.model_id, "openai/gpt-4");
    }

    #[cfg(feature = "pi-sdk")]
    #[test]
    fn pi_runtime_strips_provider_prefix_from_model_id_for_override() {
        // The qualified model id reaching `build_pi_sdk_runtime` will
        // already have the `ollama/` prefix applied by
        // `qualify_model_for_pi`. The override carries Pi's
        // `<provider>` + `<model_id>` split, so we must strip the
        // prefix before storing — otherwise Pi looks up `library/...`
        // inside the `ollama` provider and misses.
        let mut ollama = AgentBackendConfig::builtin_ollama();
        ollama.base_url = Some("http://localhost:11434".to_string());
        let runtime = build_pi_sdk_runtime(&mut ollama, Some("ollama/library/llama3"));
        let override_ = runtime
            .pi_provider_override
            .expect("Ollama route should emit a provider override");
        assert_eq!(override_.model_id, "library/llama3");
    }

    #[cfg(feature = "pi-sdk")]
    #[test]
    fn pi_runtime_skips_provider_override_for_cloud_kinds() {
        // Pi already bundles providers for `openai`, `anthropic`,
        // `codex_native`, etc. Registering a Claudette card under the
        // same name with a different base URL would shadow Pi's
        // bundled provider for the rest of the session — produce
        // nothing instead and let the user's `~/.pi/agent/models.json`
        // (or Pi's bundled config) drive the route.
        let mut openai = AgentBackendConfig::builtin_openai_api();
        openai.base_url = Some("https://api.openai.com".to_string());
        let runtime = build_pi_sdk_runtime(&mut openai, Some("gpt-5.4"));
        assert!(
            runtime.pi_provider_override.is_none(),
            "OpenAI API kind must not emit an override that would shadow Pi's bundled provider"
        );
    }

    #[cfg(feature = "pi-sdk")]
    #[test]
    fn pi_runtime_skips_provider_override_when_base_url_is_empty() {
        // No reachable server → no override. The session will hit
        // `findModel`'s "not found" error which is the right UX —
        // synthesizing an override with a blank base URL would mask
        // the actual misconfiguration.
        let mut ollama = AgentBackendConfig::builtin_ollama();
        ollama.base_url = Some("   ".to_string());
        let runtime = build_pi_sdk_runtime(&mut ollama, Some("llama3"));
        assert!(runtime.pi_provider_override.is_none());
    }

    #[cfg(feature = "pi-sdk")]
    #[test]
    fn pi_runtime_surfaces_qualified_model_for_ollama_bare_id() {
        // The Pi sidecar's `findModel` splits on the first slash and
        // refuses a bare model id like `llama3` on an Ollama-routed
        // turn. The runtime needs to hand the qualified value back to
        // the spawn site so the AgentSettings.model the harness sees is
        // already `ollama/llama3`.
        let mut ollama = AgentBackendConfig::builtin_ollama();
        let runtime = build_pi_sdk_runtime(&mut ollama, Some("llama3"));
        assert_eq!(runtime.model.as_deref(), Some("ollama/llama3"));
    }

    #[cfg(feature = "pi-sdk")]
    #[test]
    fn pi_runtime_qualifies_ollama_id_with_internal_slash() {
        // Regression: Ollama model ids legitimately contain slashes
        // (`library/llama3`). Without this rewrite the sidecar's
        // `findModel` parses `library` as the provider hint and the
        // lookup always misses. The runtime must hand the spawn site
        // a fully-prefixed `ollama/library/llama3`.
        let mut ollama = AgentBackendConfig::builtin_ollama();
        let runtime = build_pi_sdk_runtime(&mut ollama, Some("library/llama3"));
        assert_eq!(runtime.model.as_deref(), Some("ollama/library/llama3"));
    }

    #[cfg(feature = "pi-sdk")]
    #[test]
    fn pi_runtime_leaves_already_qualified_pi_card_model_unchanged() {
        // The Pi card's own ids are already `<provider>/<modelId>`.
        // Re-qualifying would double-prefix.
        let mut pi = AgentBackendConfig::builtin_pi_sdk();
        let runtime = build_pi_sdk_runtime(&mut pi, Some("anthropic/claude-opus-4-5"));
        assert_eq!(
            runtime.model.as_deref(),
            Some("anthropic/claude-opus-4-5"),
            "Pi card ids are already canonical and must not gain a `pi/` prefix"
        );
    }

    #[test]
    fn claude_code_runtime_does_not_rewrite_model() {
        // Claude CLI consumes the caller's input as-is. Surfacing a
        // model rewrite here would let the Pi qualification logic
        // accidentally leak into the Claude-side spawn (which would
        // then complain about an unknown `<provider>/<modelId>` id).
        let ollama = AgentBackendConfig {
            enabled: true,
            ..AgentBackendConfig::builtin_ollama()
        };
        let runtime = build_claude_code_direct_runtime(&ollama, Some("llama3"), None);
        assert_eq!(
            runtime.model, None,
            "Claude CLI paths leave the model field unset so the caller falls back to its input"
        );
    }

    #[test]
    fn codex_app_server_runtime_does_not_rewrite_model() {
        // Codex app-server gets bare ids straight through (`gpt-5.4`,
        // `o3`, …). Sibling guard to the Claude CLI test so a future
        // refactor doesn't accidentally start qualifying Codex ids.
        let codex = AgentBackendConfig::builtin_codex_native();
        let runtime = build_codex_app_server_runtime(&codex, Some("gpt-5.4"));
        assert_eq!(runtime.model, None);
    }

    #[cfg(feature = "pi-sdk")]
    #[test]
    fn resolve_dispatch_harness_downgrades_pi_to_claude_when_pi_backend_is_disabled() {
        let ollama = AgentBackendConfig {
            enabled: true,
            ..AgentBackendConfig::builtin_ollama()
        };
        let mut pi = AgentBackendConfig::builtin_pi_sdk();
        pi.enabled = false;
        let backends = vec![ollama.clone(), pi];
        // Ollama defaults to PiSdk harness, but with Pi disabled it
        // must fall back to ClaudeCode so the user's chat still works.
        assert_eq!(
            resolve_dispatch_harness(&ollama, &backends),
            AgentBackendRuntimeHarness::ClaudeCode,
        );
    }

    #[cfg(feature = "pi-sdk")]
    #[test]
    fn resolve_dispatch_harness_keeps_pi_when_pi_backend_is_enabled() {
        let ollama = AgentBackendConfig {
            enabled: true,
            ..AgentBackendConfig::builtin_ollama()
        };
        let mut pi = AgentBackendConfig::builtin_pi_sdk();
        pi.enabled = true;
        let backends = vec![ollama.clone(), pi];
        assert_eq!(
            resolve_dispatch_harness(&ollama, &backends),
            AgentBackendRuntimeHarness::PiSdk,
        );
    }

    #[cfg(feature = "pi-sdk")]
    #[test]
    fn pi_gets_a_longer_auto_detect_timeout_than_http_probes() {
        // Pi cold-starts a Bun sidecar plus boots the Pi SDK, which can
        // easily exceed the 900ms budget the HTTP probes use. Pin the
        // per-kind split so a future tidy pass doesn't accidentally
        // re-flatten Pi back into the short budget — which is the bug
        // that left the Pi card with an empty discovered_models at
        // startup before this fix.
        let ollama = AgentBackendConfig::builtin_ollama();
        let lm_studio = AgentBackendConfig::builtin_lm_studio();
        let pi = AgentBackendConfig::builtin_pi_sdk();
        assert_eq!(backend_auto_detect_timeout(&ollama), AUTO_DETECT_TIMEOUT);
        assert_eq!(backend_auto_detect_timeout(&lm_studio), AUTO_DETECT_TIMEOUT);
        assert_eq!(backend_auto_detect_timeout(&pi), PI_AUTO_DETECT_TIMEOUT);
        assert!(
            PI_AUTO_DETECT_TIMEOUT > AUTO_DETECT_TIMEOUT,
            "Pi timeout must exceed the HTTP-probe default"
        );
    }

    #[cfg(feature = "pi-sdk")]
    #[test]
    fn disabling_pi_backend_persists_auto_detect_opt_out() {
        // Pi is included in startup auto-detect now, so the disabled-flag
        // has to stick across launches. Without an opt-out row, the next
        // `auto_detect_agent_backends` pass would silently re-enable the
        // card the user just turned off.
        let db = Database::open_in_memory().expect("test db should open");
        let mut pi = AgentBackendConfig::builtin_pi_sdk();
        pi.enabled = false;
        persist_backend_auto_detect_opt_out(&db, &pi).expect("opt-out should persist");
        assert!(
            backend_auto_detect_disabled(&db, "pi").expect("opt-out flag should load"),
            "Pi disable must write the auto-detect opt-out so it survives a restart",
        );
        // Re-enable: the opt-out row should be cleared so the probe resumes.
        pi.enabled = true;
        persist_backend_auto_detect_opt_out(&db, &pi).expect("opt-in should clear opt-out");
        assert!(
            !backend_auto_detect_disabled(&db, "pi").expect("opt-out flag should reload"),
            "Pi re-enable must clear the opt-out row",
        );
    }

    #[cfg(feature = "pi-sdk")]
    #[test]
    fn resolve_dispatch_harness_uses_kind_default_when_downgrading_codex_native() {
        // Codex Native's `available_harnesses` is `[CodexAppServer, PiSdk]`
        // — it never sanctions ClaudeCode. So if a user wires Codex Native
        // to Pi and then disables Pi, the downgrade must drop to the
        // kind's own default (CodexAppServer), not the generic Claude CLI
        // path that would otherwise leak an Ollama-style base URL into a
        // Codex turn.
        let mut codex = AgentBackendConfig::builtin_codex_native();
        codex.enabled = true;
        codex.runtime_harness = Some(AgentBackendRuntimeHarness::PiSdk);
        let mut pi = AgentBackendConfig::builtin_pi_sdk();
        pi.enabled = false;
        let backends = vec![codex.clone(), pi];
        assert_eq!(
            resolve_dispatch_harness(&codex, &backends),
            AgentBackendRuntimeHarness::CodexAppServer,
        );
    }

    #[cfg(feature = "pi-sdk")]
    #[test]
    fn resolve_dispatch_harness_does_not_downgrade_pi_card_itself() {
        // The Pi card's own `effective_harness()` is `PiSdk`. The
        // resolver-time enabled-flag check earlier in
        // `resolve_backend_runtime` rejects a disabled Pi card before
        // we get here, so `resolve_dispatch_harness` must not silently
        // rewrite the Pi card to ClaudeCode (Pi-card-via-Claude-CLI is
        // nonsense — there's no Anthropic-shaped endpoint to point at).
        let pi = AgentBackendConfig::builtin_pi_sdk();
        let backends = vec![pi.clone()];
        assert_eq!(
            resolve_dispatch_harness(&pi, &backends),
            AgentBackendRuntimeHarness::PiSdk,
        );
    }

    #[test]
    fn runtime_hash_changes_when_runtime_harness_changes() {
        // Flipping Settings → Models → $(card) → Runtime mid-session
        // must respawn the agent; if `runtime_hash` ignored the
        // override the live agent would keep talking to the previous
        // harness's subprocess until the user manually reset.
        let mut backend = AgentBackendConfig::builtin_ollama();
        backend.enabled = true;
        let default_hash = runtime_hash(&backend, None, Some("llama3"));
        backend.runtime_harness = Some(AgentBackendRuntimeHarness::ClaudeCode);
        let override_hash = runtime_hash(&backend, None, Some("llama3"));
        assert_ne!(
            default_hash, override_hash,
            "runtime_hash must change when runtime_harness flips",
        );
    }

    #[cfg(feature = "pi-sdk")]
    #[test]
    fn pi_model_targets_anthropic_detects_anthropic_prefix() {
        assert!(pi_model_targets_anthropic("anthropic/claude-opus-4-5"));
        assert!(pi_model_targets_anthropic("Anthropic/Claude-Sonnet"));
        assert!(pi_model_targets_anthropic("claude/sonnet"));
    }

    #[cfg(feature = "pi-sdk")]
    #[test]
    fn pi_model_targets_anthropic_ignores_other_providers() {
        assert!(!pi_model_targets_anthropic("openai/gpt-5.4"));
        assert!(!pi_model_targets_anthropic("ollama/llama3"));
        assert!(!pi_model_targets_anthropic(""));
        assert!(!pi_model_targets_anthropic("mistral-7b"));
        // Near-miss prefix: similar shape, different model.
        assert!(!pi_model_targets_anthropic("clade-x"));
        // `opusclasic-3b` is not the Anthropic `opus` alias — the gate
        // only trips when `opus` is the whole id or a `opus-` / `opus_`
        // prefixed family member, so unrelated names that happen to
        // start with the four letters stay routable.
        assert!(!pi_model_targets_anthropic("opusclassic"));
        assert!(!pi_model_targets_anthropic("sonnets-of-shakespeare"));
        assert!(!pi_model_targets_anthropic("haikulm"));
    }

    #[cfg(feature = "pi-sdk")]
    #[test]
    fn pi_model_targets_anthropic_blocks_bare_claude_ids() {
        // Codex peer-review regression: Pi's `findModel` falls back to
        // scanning the entire registry when given a bare id, so a
        // non-UI caller (slash command, IPC) sending Pi + `claude-opus-4-5`
        // would still land on the Anthropic provider — bypassing the
        // OAuth gate. Catch the bare-id case via Anthropic's naming
        // convention so the gate trips on real model ids users would
        // actually paste.
        assert!(pi_model_targets_anthropic("claude"));
        assert!(pi_model_targets_anthropic("claude-opus-4-5"));
        assert!(pi_model_targets_anthropic("Claude-Sonnet-4-6"));
        assert!(pi_model_targets_anthropic("claude_haiku"));
        assert!(pi_model_targets_anthropic("claude-instant-1"));
        // Surrounding whitespace must still trip the check — the
        // upstream caller path doesn't always trim.
        assert!(pi_model_targets_anthropic("  claude-opus-4-5  "));
    }

    #[cfg(feature = "pi-sdk")]
    #[test]
    fn pi_model_targets_anthropic_blocks_claude_code_bare_aliases() {
        // Claude Code accepts `opus` / `sonnet` / `haiku` as canonical
        // bare aliases for the latest Anthropic models in that family.
        // The picker emits them, `/model` accepts them, and the
        // `default_model` app-setting can hold them — so a user with
        // an OAuth subscription who also has a custom `~/.pi/agent/models.json`
        // that maps these names to an Anthropic row would otherwise
        // route their subscription token through Pi. Block the aliases
        // (case-insensitive, with optional surrounding whitespace)
        // and any `opus-…` / `sonnet-…` / `haiku-…` family member that
        // looks like an Anthropic model id.
        for alias in [
            "opus",
            "sonnet",
            "haiku",
            "OPUS",
            "Sonnet",
            "  haiku  ",
            "opus-4-7",
            "sonnet-4-6",
            "haiku-4-5",
            "opus_legacy",
        ] {
            assert!(
                pi_model_targets_anthropic(alias),
                "{alias:?} should trip the gate"
            );
        }
    }

    #[cfg(feature = "pi-sdk")]
    #[test]
    fn build_pi_sdk_runtime_qualifies_model_for_non_pi_kind() {
        let mut backend = AgentBackendConfig::builtin_ollama();
        let runtime = build_pi_sdk_runtime(&mut backend, Some("llama3"));
        assert_eq!(runtime.harness, AgentBackendRuntimeHarness::PiSdk);
        assert!(
            runtime.env.is_empty(),
            "Pi runs with empty env so subscription credentials never leak in"
        );
        assert_eq!(backend.default_model.as_deref(), Some("ollama/llama3"));
    }

    #[cfg(feature = "pi-sdk")]
    #[test]
    fn build_pi_sdk_runtime_keeps_pi_card_ids_unchanged() {
        let mut backend = AgentBackendConfig::builtin_pi_sdk();
        let runtime = build_pi_sdk_runtime(&mut backend, Some("openai/gpt-5.4"));
        assert_eq!(runtime.harness, AgentBackendRuntimeHarness::PiSdk);
        assert_eq!(backend.default_model.as_deref(), Some("openai/gpt-5.4"));
    }

    #[cfg(feature = "pi-sdk")]
    #[test]
    fn build_pi_sdk_runtime_leaves_default_model_alone_when_no_model_passed() {
        let mut backend = AgentBackendConfig::builtin_ollama();
        backend.default_model = Some("preexisting".to_string());
        let runtime = build_pi_sdk_runtime(&mut backend, None);
        assert_eq!(runtime.harness, AgentBackendRuntimeHarness::PiSdk);
        assert_eq!(backend.default_model.as_deref(), Some("preexisting"));
    }

    #[test]
    fn build_codex_app_server_runtime_uses_empty_env() {
        let backend = AgentBackendConfig::builtin_codex_native();
        let runtime = build_codex_app_server_runtime(&backend, Some("gpt-5.4"));
        assert_eq!(runtime.harness, AgentBackendRuntimeHarness::CodexAppServer);
        assert!(runtime.env.is_empty());
        assert!(!runtime.hash.is_empty());
    }

    #[test]
    fn build_claude_code_direct_runtime_for_ollama_sets_attribution_off() {
        let backend = AgentBackendConfig::builtin_ollama();
        let runtime = build_claude_code_direct_runtime(&backend, Some("llama3"), None);
        assert_eq!(runtime.harness, AgentBackendRuntimeHarness::ClaudeCode);
        let env: HashMap<_, _> = runtime
            .env
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();
        assert_eq!(
            env.get("ANTHROPIC_BASE_URL"),
            Some(&"http://localhost:11434")
        );
        assert_eq!(env.get("CLAUDE_CODE_ATTRIBUTION_HEADER"), Some(&"0"));
        // Ollama path scrubs the API key to empty (Ollama doesn't bill).
        assert_eq!(env.get("ANTHROPIC_API_KEY"), Some(&""));
    }
}
