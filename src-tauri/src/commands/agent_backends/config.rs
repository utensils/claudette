//! Persistence + selection plumbing for agent backends: load / save
//! the JSON blob in app_settings, tolerate unknown entries from newer
//! builds, normalize legacy ids, infer the right backend for an
//! (id, model) request, and produce the runtime hash that drives gateway
//! respawn decisions. Wire types `BackendStatus`, `BackendListResponse`,
//! and `BackendSecretUpdate` live here so the storage layer that
//! produces them stays cohesive.

use std::collections::HashSet;
use std::hash::{Hash, Hasher};

use claudette::agent_backend::{
    AgentBackendConfig, AgentBackendKind, AgentBackendModel, AgentBackendRuntimeHarness,
};
use claudette::db::Database;
use claudette::plugin::load_secure_secret;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::auto_detect::auto_detect_disabled_key;
use super::codex_gate::{
    LEGACY_CODEX_SUBSCRIPTION_BACKEND_ID, LEGACY_NATIVE_CODEX_BACKEND_ID, NATIVE_CODEX_BACKEND_ID,
    codex_backend_hidden_by_gate, default_backends_for_gate, is_codex_gate_backend_id,
    native_codex_enabled,
};

pub(super) const SETTINGS_KEY: &str = "agent_backends_config";
pub(super) const SECRET_BUCKET: &str = "agentBackendSecrets";
const BACKEND_RUNTIME_ENV_VERSION: u8 = 2;

/// Backend `kind` values that shipped in an earlier build and have since
/// been removed for good (Pi + LM Studio, dropped in #1007).
///
/// These are deliberately *not* treated like an unrecognized kind from a
/// newer build. The unknown-entry path assumes forward compatibility — it
/// warns the user and preserves the entry so it revives on a build that
/// understands it. No such build is coming for these, so a stored entry is
/// simply dead config: the tolerant loader skips it without a user-visible
/// warning, [`read_unknown_passthrough`] stops splicing it back on save,
/// and [`purge_retired_backend_settings`] removes it from the stored blob.
const RETIRED_BACKEND_KINDS: &[&str] = &["pi_sdk", "lm_studio"];

/// Backend ids that belonged to [`RETIRED_BACKEND_KINDS`]. Tracked
/// separately because id-keyed settings (`default_agent_backend`, the
/// auto-detect opt-out keys) never record a `kind`.
const RETIRED_BACKEND_IDS: &[&str] = &["pi", "lm-studio"];

/// True when a stored JSON entry carries a retired `kind`. Reads the raw
/// value rather than a parsed config because retired kinds are exactly the
/// ones this build can no longer deserialize.
fn is_retired_backend_entry(entry: &Value) -> bool {
    entry
        .get("kind")
        .and_then(Value::as_str)
        .is_some_and(|kind| RETIRED_BACKEND_KINDS.contains(&kind))
}

fn is_retired_backend_id(id: &str) -> bool {
    RETIRED_BACKEND_IDS.contains(&id)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackendStatus {
    pub ok: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backends: Option<Vec<AgentBackendConfig>>,
}

impl BackendStatus {
    pub(super) fn new(ok: bool, message: impl Into<String>) -> Self {
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
    /// Non-fatal diagnostics emitted while loading the persisted backend
    /// list — e.g. a stored entry whose `kind` isn't recognized by this
    /// build (forward/backward compat across dev channels). Surfaced to
    /// the UI so the user knows their config wasn't fully applied, but
    /// the loader still returns the valid entries instead of failing the
    /// whole panel.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackendSecretUpdate {
    pub backend_id: String,
    pub value: Option<String>,
}

pub(super) fn backend_models_contain(backend: &AgentBackendConfig, model: &str) -> bool {
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
/// on a local server reliably triggers both a DB write and a gateway respawn.
///
/// Sorted by model id so the same set of models in a different upstream
/// order produces the same signature — otherwise a single discovery call
/// that returned items in a different order would force an unnecessary DB
/// write + gateway respawn on every chat send.
pub(super) fn backend_models_signature(backend: &AgentBackendConfig) -> Vec<(String, u32)> {
    let mut entries: Vec<(String, u32)> = backend
        .discovered_models
        .iter()
        .chain(backend.manual_models.iter())
        .map(|model| (model.id.clone(), model.context_window_tokens))
        .collect();
    entries.sort();
    entries
}

pub(super) fn apply_discovered_models(
    backend: &mut AgentBackendConfig,
    discovered: Vec<AgentBackendModel>,
) {
    // Kinds where a successful discovery pass replaces manual entries:
    // Ollama / cloud OpenAI / Codex auto-detect the server's
    // own model list and the picker is supposed to mirror that source of
    // truth — leaving stale manual rows behind confuses the UI.
    let clears_manual = matches!(
        backend.kind,
        AgentBackendKind::Ollama
            | AgentBackendKind::OpenAiApi
            | AgentBackendKind::CodexSubscription
            | AgentBackendKind::CodexNative
    );
    if clears_manual && !discovered.is_empty() {
        backend.manual_models.clear();
    }
    if !discovered.is_empty()
        && !backend.default_model.as_deref().is_some_and(|model| {
            discovered.iter().any(|found| found.id == model)
                || backend.manual_models.iter().any(|m| m.id == model)
        })
    {
        backend.default_model = discovered.first().map(|model| model.id.clone());
    }
    backend.discovered_models = discovered;
}

/// Result of a tolerant load: the active backend list and any
/// non-fatal diagnostics surfaced to the UI. Unknown passthrough
/// entries are NOT carried on this struct — `save_backend_configs`
/// re-reads them from the raw blob at write time so the field would
/// be dead in production. Tests assert passthrough behavior by
/// calling `read_unknown_passthrough` directly.
pub(super) struct LoadedBackends {
    pub(super) backends: Vec<AgentBackendConfig>,
    pub(super) warnings: Vec<String>,
}

/// Tolerant variant: parses the stored backend list entry-by-entry so
/// a single unknown variant (e.g. a `kind` this build doesn't know)
/// downgrades to a warning instead of failing the whole settings load.
///
/// Two failure modes are guarded:
///   1. The top-level JSON is unparseable — surfaces a single warning
///      and returns the built-in defaults. The raw blob is left in
///      place *on this read* so a user can recover it externally;
///      the first subsequent user-initiated save will overwrite it
///      (see [`read_unknown_passthrough`]).
///   2. An individual entry fails to deserialize — that one entry is
///      skipped from the active list but kept in the persisted JSON.
///      `save_backend_configs` re-reads the raw blob and splices the
///      unknown entry back on the next write so a downgrade-then-
///      upgrade cycle is non-destructive.
pub(super) fn load_backend_configs_tolerant(db: &Database) -> Result<LoadedBackends, String> {
    let native_codex_enabled = native_codex_enabled(db)?;
    let mut backends = default_backends_for_gate(native_codex_enabled);
    let mut warnings: Vec<String> = Vec::new();

    if let Some(raw) = db
        .get_app_setting(SETTINGS_KEY)
        .map_err(|e| e.to_string())?
    {
        match serde_json::from_str::<Vec<Value>>(&raw) {
            Ok(entries) => {
                for entry in entries {
                    match serde_json::from_value::<AgentBackendConfig>(entry.clone()) {
                        Ok(saved) => {
                            let saved = normalize_backend(saved);
                            if codex_backend_hidden_by_gate(native_codex_enabled, &saved.id) {
                                continue;
                            }
                            if let Some(existing) = backends.iter_mut().find(|b| b.id == saved.id) {
                                *existing = saved;
                            } else {
                                backends.push(saved);
                            }
                        }
                        Err(err) => {
                            let id = entry.get("id").and_then(Value::as_str).unwrap_or("<no id>");
                            let kind = entry
                                .get("kind")
                                .and_then(Value::as_str)
                                .unwrap_or("<no kind>");
                            // Retired kinds are dead config, not a
                            // forward-compat entry — nothing for the user
                            // to act on, so no warning. `list_agent_backends`
                            // purges them from storage on the next load.
                            if is_retired_backend_entry(&entry) {
                                tracing::debug!(
                                    target: "agent_backends",
                                    id, kind,
                                    "tolerant load: dropping retired backend entry"
                                );
                                continue;
                            }
                            warnings.push(format!(
                                "Skipped backend entry id=`{id}` kind=`{kind}`: {err}. \
                                 Entry preserved and will be reapplied on a build that supports it."
                            ));
                            tracing::warn!(
                                target: "agent_backends",
                                id, kind, error = %err,
                                "tolerant load: preserving unknown backend entry as passthrough"
                            );
                        }
                    }
                }
            }
            Err(err) => {
                warnings.push(format!(
                    "Backend settings JSON is unreadable; using built-in defaults this session. \
                     Stored value left untouched for recovery on this read. ({err})"
                ));
                tracing::error!(
                    target: "agent_backends",
                    error = %err,
                    "tolerant load: top-level JSON parse failed; falling back to defaults"
                );
            }
        }
    }

    for backend in &mut backends {
        backend.has_secret = load_secure_secret(SECRET_BUCKET, &backend.id)
            .ok()
            .flatten()
            .is_some();
    }

    Ok(LoadedBackends { backends, warnings })
}

pub(super) fn load_backend_configs(db: &Database) -> Result<Vec<AgentBackendConfig>, String> {
    Ok(load_backend_configs_tolerant(db)?.backends)
}

pub(super) fn resolve_backend_list_default(
    backends: &[AgentBackendConfig],
    warnings: &mut Vec<String>,
    stored_default: String,
) -> String {
    if backends.iter().any(|backend| backend.id == stored_default) {
        return stored_default;
    }
    let aliased_default = backend_request_alias(backends, &stored_default);
    if backends.iter().any(|backend| backend.id == aliased_default) {
        return aliased_default;
    }
    // A default pointing at a retired backend isn't a config the user can
    // repair by switching builds — fall back silently and let
    // `purge_retired_backend_settings` clear the stored key.
    if is_retired_backend_id(&stored_default) {
        tracing::debug!(
            target: "agent_backends",
            stored_default = %stored_default,
            "default backend setting points at a retired backend; using anthropic"
        );
        return "anthropic".to_string();
    }
    warnings.push(format!(
        "Default backend `{stored_default}` is not available in this build; \
         falling back to `anthropic` for this session. \
         Stored setting unchanged."
    ));
    tracing::warn!(
        target: "agent_backends",
        stored_default = %stored_default,
        "default backend setting points to a backend not in the loaded list"
    );
    "anthropic".to_string()
}

/// Re-read the stored JSON and return any entries this build can't
/// deserialize. Used by `save_backend_configs` to splice unknown
/// passthrough entries back into the persisted blob so they survive
/// edits made by an older build.
///
/// Returns `Err` on DB read failure so the caller surfaces the problem
/// instead of silently dropping unknowns. Returns `Ok(empty)` when the
/// stored blob is missing or its top-level JSON is unparseable —
/// passthrough is unsafe in either case (no source-of-truth array to
/// preserve), and the next save will write a clean list. This is the
/// only documented path that overwrites a corrupt blob.
pub(super) fn read_unknown_passthrough(db: &Database) -> Result<Vec<Value>, String> {
    let Some(raw) = db
        .get_app_setting(SETTINGS_KEY)
        .map_err(|e| e.to_string())?
    else {
        return Ok(Vec::new());
    };
    let Ok(entries) = serde_json::from_str::<Vec<Value>>(&raw) else {
        return Ok(Vec::new());
    };
    Ok(entries
        .into_iter()
        .filter(|entry| {
            // Retired kinds are excluded from passthrough on purpose: they
            // are unparseable here and always will be, so preserving them
            // would carry dead config forward on every write.
            !is_retired_backend_entry(entry)
                && serde_json::from_value::<AgentBackendConfig>(entry.clone()).is_err()
        })
        .collect())
}

/// Drop every trace of a retired backend from persisted settings: the
/// entry in the backend blob, a `default_agent_backend` still pointing at
/// it, and its auto-detect opt-out key.
///
/// Called from `list_agent_backends` (which runs at app boot and whenever
/// the Models panel mounts) so the cleanup is deterministic rather than
/// waiting for the user's next backend edit. Self-limiting: once the
/// retired entries are gone there is nothing to rewrite, so it stops
/// touching the DB. Surviving entries are re-persisted from their raw
/// JSON, never a reparse, so unrelated unknown-kind passthrough and any
/// additive fields written by a newer build survive untouched.
///
/// A DB write failure is returned to the caller rather than swallowed —
/// the alternative is silently reintroducing the warning-free-but-still-
/// stored state this is meant to clear.
pub(super) fn purge_retired_backend_settings(db: &Database) -> Result<(), String> {
    // A missing or corrupt blob reads as "nothing to purge" rather than an
    // error: recovering a corrupt blob is `save_backend_configs`'s job, and
    // this pass must not be the thing that overwrites it.
    let stored: Vec<Value> = db
        .get_app_setting(SETTINGS_KEY)
        .map_err(|e| e.to_string())?
        .and_then(|raw| serde_json::from_str::<Vec<Value>>(&raw).ok())
        .unwrap_or_default();

    if stored.iter().any(is_retired_backend_entry) {
        let kept: Vec<&Value> = stored
            .iter()
            .filter(|entry| !is_retired_backend_entry(entry))
            .collect();
        let cleaned = serde_json::to_string(&kept).map_err(|e| e.to_string())?;
        db.set_app_setting(SETTINGS_KEY, &cleaned)
            .map_err(|e| e.to_string())?;
        tracing::info!(
            target: "agent_backends",
            "purged retired backend entries from stored settings"
        );
    }

    // `default_agent_backend` and the auto-detect opt-out are keyed by id,
    // and a retired id is not reserved — nothing stops a user-defined
    // backend from also being called `pi`. Only purge an id-keyed setting
    // when no surviving entry claims that id, so a custom backend that
    // happens to reuse the name keeps its default selection and opt-out.
    let live_ids: HashSet<&str> = stored
        .iter()
        .filter(|entry| !is_retired_backend_entry(entry))
        .filter_map(|entry| entry.get("id").and_then(Value::as_str))
        .collect();
    let purgeable_ids: Vec<&str> = RETIRED_BACKEND_IDS
        .iter()
        .copied()
        .filter(|id| !live_ids.contains(id))
        .collect();

    if db
        .get_app_setting("default_agent_backend")
        .map_err(|e| e.to_string())?
        .is_some_and(|stored| purgeable_ids.contains(&stored.as_str()))
    {
        db.delete_app_setting("default_agent_backend")
            .map_err(|e| e.to_string())?;
    }

    for id in purgeable_ids {
        let key = auto_detect_disabled_key(id);
        if db
            .get_app_setting(&key)
            .map_err(|e| e.to_string())?
            .is_some()
        {
            db.delete_app_setting(&key).map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

pub(super) fn canonical_backend_id(id: &str) -> &str {
    match id {
        LEGACY_NATIVE_CODEX_BACKEND_ID | LEGACY_CODEX_SUBSCRIPTION_BACKEND_ID => {
            NATIVE_CODEX_BACKEND_ID
        }
        other => other,
    }
}

fn normalize_backend_id(id: String) -> String {
    match id.as_str() {
        LEGACY_NATIVE_CODEX_BACKEND_ID => NATIVE_CODEX_BACKEND_ID.to_string(),
        _ => id,
    }
}

/// Re-read the stored JSON and return hidden Codex-gate backends that this
/// build can deserialize but deliberately omits from the active list while
/// the Codex gate is on/off. This keeps the user's hidden legacy/native
/// Codex config intact across unrelated backend edits.
fn read_hidden_codex_passthrough(
    db: &Database,
    active_backend_ids: &HashSet<String>,
) -> Result<Vec<Value>, String> {
    let Some(raw) = db
        .get_app_setting(SETTINGS_KEY)
        .map_err(|e| e.to_string())?
    else {
        return Ok(Vec::new());
    };
    let Ok(entries) = serde_json::from_str::<Vec<Value>>(&raw) else {
        return Ok(Vec::new());
    };
    Ok(entries
        .into_iter()
        .filter(|entry| {
            let Ok(saved) = serde_json::from_value::<AgentBackendConfig>(entry.clone()) else {
                return false;
            };
            is_codex_gate_backend_id(&saved.id)
                && !active_backend_ids.contains(normalize_backend_id(saved.id.clone()).as_str())
        })
        .collect())
}

pub(super) fn save_backend_configs(
    db: &Database,
    backends: &[AgentBackendConfig],
) -> Result<(), String> {
    let active_backend_ids: HashSet<String> =
        backends.iter().map(|backend| backend.id.clone()).collect();
    let mut persisted: Vec<Value> = backends
        .iter()
        .filter(|backend| backend.id != "anthropic")
        .map(|backend| {
            let mut backend = backend.clone();
            backend.has_secret = false;
            serde_json::to_value(backend).map_err(|e| e.to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;

    // Splice unknown passthrough entries back so a build that doesn't
    // recognize them doesn't quietly drop them on every save. Errors
    // here propagate — silently dropping unknowns on a transient DB
    // read failure would defeat the whole point of the passthrough.
    persisted.extend(read_hidden_codex_passthrough(db, &active_backend_ids)?);
    persisted.extend(read_unknown_passthrough(db)?);

    let raw = serde_json::to_string(&persisted).map_err(|e| e.to_string())?;
    db.set_app_setting(SETTINGS_KEY, &raw)
        .map_err(|e| e.to_string())
}

pub(super) fn find_backend(
    db: &Database,
    backend_id: Option<&str>,
) -> Result<AgentBackendConfig, String> {
    let id = backend_id
        .filter(|id| !id.trim().is_empty())
        .unwrap_or("anthropic");
    let backends = load_backend_configs(db)?;
    let id = backend_request_alias(&backends, id);
    backends
        .into_iter()
        .find(|backend| backend.id == id.as_str())
        .ok_or_else(|| format!("Unknown backend `{id}`"))
}

pub(super) fn select_backend_for_request(
    backends: &[AgentBackendConfig],
    backend_id: Option<&str>,
    model: Option<&str>,
    default_backend_id: Option<&str>,
) -> Result<AgentBackendConfig, String> {
    let requested = backend_id
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .unwrap_or("anthropic");
    let requested = backend_request_alias(backends, requested);
    let should_infer = requested == "anthropic" || backend_id.is_none();
    if should_infer
        && let Some(model) = model.map(str::trim).filter(|model| !model.is_empty())
        && let Some(backend) = infer_backend_for_model(backends, model, default_backend_id)
    {
        return Ok(backend.clone());
    }
    backends
        .iter()
        .find(|backend| backend.id == requested.as_str())
        .cloned()
        .ok_or_else(|| format!("Unknown backend `{requested}`"))
}

pub(super) fn backend_request_alias(backends: &[AgentBackendConfig], requested: &str) -> String {
    if is_codex_gate_backend_id(requested)
        && backends.iter().any(|b| b.id == NATIVE_CODEX_BACKEND_ID)
    {
        NATIVE_CODEX_BACKEND_ID.to_string()
    } else {
        requested.to_string()
    }
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

pub(super) fn normalize_backend(mut backend: AgentBackendConfig) -> AgentBackendConfig {
    let original_id = backend.id.clone();
    backend.id = normalize_backend_id(backend.id);
    // The legacy "experimental-codex" backend was labelled "Experimental Codex". Reset it to
    // the current canonical label for any DB blob that still carries the old id or label.
    if backend.id == NATIVE_CODEX_BACKEND_ID
        && (original_id != backend.id || backend.label == "Experimental Codex")
    {
        backend.label = "Codex".to_string();
    }
    if backend.label.trim().is_empty() {
        backend.label = backend.id.clone();
    }
    if backend.context_window_default == 0 {
        backend.context_window_default = 64_000;
    }
    let model_discovery_kinds = matches!(
        backend.kind,
        AgentBackendKind::Ollama
            | AgentBackendKind::OpenAiApi
            | AgentBackendKind::CodexSubscription
            | AgentBackendKind::CodexNative
    );
    if model_discovery_kinds {
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

pub(super) fn runtime_hash(
    config: &AgentBackendConfig,
    secret: Option<&str>,
    model: Option<&str>,
) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    BACKEND_RUNTIME_ENV_VERSION.hash(&mut hasher);
    config.id.hash(&mut hasher);
    config.label.hash(&mut hasher);
    backend_kind_hash_key(config.kind).hash(&mut hasher);
    // The user-selected harness goes into the hash too — flipping a
    // card's runtime mid-session must force a respawn, otherwise the
    // live agent keeps talking to the old subprocess.
    harness_hash_key(config.effective_harness()).hash(&mut hasher);
    config.base_url.hash(&mut hasher);
    config.enabled.hash(&mut hasher);
    config.default_model.hash(&mut hasher);
    config.model_discovery.hash(&mut hasher);
    model.hash(&mut hasher);
    secret.unwrap_or("").hash(&mut hasher);
    // Fingerprint the per-model context windows so a fresh discovery that
    // bumps `loaded_context_length` (a local-server reload with a new slider)
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

pub(super) fn backend_kind_hash_key(kind: AgentBackendKind) -> &'static str {
    match kind {
        AgentBackendKind::Anthropic => "anthropic",
        AgentBackendKind::Ollama => "ollama",
        AgentBackendKind::OpenAiApi => "openai_api",
        AgentBackendKind::CodexSubscription => "codex_subscription",
        AgentBackendKind::CodexNative => "codex_native",
        AgentBackendKind::CustomAnthropic => "custom_anthropic",
        AgentBackendKind::CustomOpenAi => "custom_openai",
    }
}

fn harness_hash_key(harness: AgentBackendRuntimeHarness) -> &'static str {
    match harness {
        AgentBackendRuntimeHarness::ClaudeCode => "claude_code",
        AgentBackendRuntimeHarness::CodexAppServer => "codex_app_server",
    }
}
