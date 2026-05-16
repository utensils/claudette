//! Runtime resolution + harness dispatch:
//!
//! - `resolve_backend_runtime` is the chat/send path's main entry point;
//!   it picks the right backend, enforces gates, picks the active
//!   harness, and produces the env / hash / model rewrite the spawn site
//!   needs.
//! - `resolve_backend_request_defaults` fills in the default backend +
//!   model when the caller didn't pass either, applying the alt-backend
//!   gate so the Anthropic fast path keeps working.
//! - `build_codex_app_server_runtime`, `build_pi_sdk_runtime`, and the
//!   `build_claude_code_*` family produce the actual runtimes per
//!   harness.
//! - The Anthropic-via-Pi OAuth guard
//!   (`ensure_anthropic_not_routed_through_pi_via_oauth`,
//!   `pi_model_targets_anthropic`, `claude_oauth_blocks_pi_anthropic`)
//!   is a defense-in-depth check that refuses to route Anthropic
//!   models through Pi when the local Claude CLI is logged in with a
//!   subscription OAuth token.

#[cfg(feature = "pi-sdk")]
use claudette::agent_backend::PiProviderOverride;
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
pub(super) fn resolve_dispatch_harness(
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
pub(super) fn resolve_dispatch_harness(
    backend: &AgentBackendConfig,
    _backends: &[AgentBackendConfig],
) -> AgentBackendRuntimeHarness {
    backend.effective_harness()
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
        // Codex app-server speaks bare ids; no rewrite needed.
        model: None,
        pi_provider_override: None,
    }
}

#[cfg(feature = "pi-sdk")]
pub(super) fn build_pi_sdk_runtime(
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
pub(super) fn normalize_pi_provider_base_url(kind: AgentBackendKind, base_url: &str) -> String {
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
pub(super) fn qualify_model_for_pi(kind: AgentBackendKind, model: &str) -> String {
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
pub(super) fn pi_model_targets_anthropic(model_id: &str) -> bool {
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
