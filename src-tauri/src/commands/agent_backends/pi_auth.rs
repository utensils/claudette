//! Pi provider-auth Tauri commands.
//!
//! Exposed surface:
//!
//!   pi_list_providers(working_dir)                         → PiProviderList
//!   pi_set_provider_api_key(working_dir, id, key, scope)   → ()
//!   pi_clear_provider_api_key(working_dir, id, scope)      → ()
//!   pi_oauth_start(working_dir, provider_id, app_handle)   → PiOAuthStarted
//!   pi_oauth_submit_input(challenge_id, value)             → ()
//!   pi_oauth_cancel(challenge_id)                          → ()
//!   pi_openrouter_credits()                                → PiOpenRouterCredits
//!
//! The OAuth flow keeps its `PiOAuthSession` alive across Tauri
//! commands by stashing it in the module-level `ACTIVE_OAUTH` map.
//! `pi_oauth_start` spawns the harness, kicks off the device-code
//! flow, and spawns a background task that forwards every
//! `PiControlEvent` to the webview via `pi://oauth/event`. The React
//! modal subscribes to that channel.
//!
//! Storage scopes:
//!   - `"shared"` → writes/clears the key in `~/.pi/agent/auth.json` via
//!     `pi_control::set_api_key` (visible to terminal `pi` too).
//!   - `"local"`  → stores in Claudette's keychain under
//!     `KEYCHAIN_BUCKET / pi_provider:{id}`. The matching env var name
//!     (e.g. `OPENROUTER_API_KEY`) is injected into the harness on spawn.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, LazyLock};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

use claudette::agent::{
    PiControlEvent, PiOAuthSession, PiOAuthStarted, PiProviderList, pi_control,
};
use claudette::plugin::{delete_secure_secret, load_secure_secret, save_secure_secret};
use claudette::usage::openrouter::{self, OpenRouterCredits};

/// Keychain bucket for the "private to Claudette" provider keys.
/// Disjoint from `agentBackendSecrets` (which stores per-backend
/// custom_anthropic/custom_openai tokens) so we never collide on a
/// well-known id.
const KEYCHAIN_BUCKET: &str = "piProviderSecrets";

/// Webview event channel the React modal subscribes to.
const OAUTH_EVENT: &str = "pi://oauth/event";

/// In-flight OAuth sessions keyed by `challenge_id`. Held in an `Arc`
/// so the background event-forwarder task can hold a clone without
/// blocking new commands.
static ACTIVE_OAUTH: LazyLock<Mutex<HashMap<String, Arc<PiOAuthSession>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Pi's env-var convention for each provider id. Source of truth is
/// `getApiKeyEnvVars` in `@earendil-works/pi-ai/dist/env-api-keys.js`
/// — keep in sync when Pi adds providers. Returns the *first* env var
/// Pi checks for that provider (it accepts several aliases for
/// github-copilot; we standardize on `COPILOT_GITHUB_TOKEN`).
fn pi_env_var_for_provider(provider_id: &str) -> Option<&'static str> {
    match provider_id {
        "openai" => Some("OPENAI_API_KEY"),
        "anthropic" => Some("ANTHROPIC_API_KEY"),
        "azure-openai-responses" => Some("AZURE_OPENAI_API_KEY"),
        "deepseek" => Some("DEEPSEEK_API_KEY"),
        "google" => Some("GEMINI_API_KEY"),
        "google-vertex" => Some("GOOGLE_CLOUD_API_KEY"),
        "groq" => Some("GROQ_API_KEY"),
        "cerebras" => Some("CEREBRAS_API_KEY"),
        "xai" => Some("XAI_API_KEY"),
        "openrouter" => Some("OPENROUTER_API_KEY"),
        "vercel-ai-gateway" => Some("AI_GATEWAY_API_KEY"),
        "zai" => Some("ZAI_API_KEY"),
        "mistral" => Some("MISTRAL_API_KEY"),
        "minimax" => Some("MINIMAX_API_KEY"),
        "minimax-cn" => Some("MINIMAX_CN_API_KEY"),
        "moonshotai" | "moonshotai-cn" => Some("MOONSHOT_API_KEY"),
        "huggingface" => Some("HF_TOKEN"),
        "fireworks" => Some("FIREWORKS_API_KEY"),
        "opencode" | "opencode-go" => Some("OPENCODE_API_KEY"),
        "kimi-coding" => Some("KIMI_API_KEY"),
        "cloudflare-workers-ai" | "cloudflare-ai-gateway" => Some("CLOUDFLARE_API_KEY"),
        "xiaomi" => Some("XIAOMI_API_KEY"),
        "github-copilot" => Some("COPILOT_GITHUB_TOKEN"),
        _ => None,
    }
}

fn keychain_key(provider_id: &str) -> String {
    format!("pi_provider:{provider_id}")
}

/// Gather every keychain-stored Pi provider secret and project it into
/// `(env_var, value)` pairs ready for `cmd.env(...)`. Called both by
/// the Settings refresh paths (so `list_providers` reflects local
/// keys) and by `chat::send` when spawning a Pi chat session.
pub fn pi_local_secret_env() -> Result<Vec<(String, String)>, String> {
    let mut out = Vec::new();
    // We iterate over the curated provider env-var table; that's the
    // only set of providers we accept "local" keys for. Anything
    // outside this map can't have a Claudette-private key by
    // construction.
    let curated = [
        "openai",
        "anthropic",
        "azure-openai-responses",
        "deepseek",
        "google",
        "groq",
        "cerebras",
        "xai",
        "openrouter",
        "vercel-ai-gateway",
        "zai",
        "mistral",
        "minimax",
        "minimax-cn",
        "moonshotai",
        "huggingface",
        "fireworks",
        "opencode",
        "kimi-coding",
        "github-copilot",
    ];
    for id in curated {
        let key = keychain_key(id);
        let stored = load_secure_secret(KEYCHAIN_BUCKET, &key)
            .map_err(|e| format!("Failed to read pi provider secret: {e}"))?;
        if let Some(value) = stored
            && !value.trim().is_empty()
            && let Some(env_name) = pi_env_var_for_provider(id)
        {
            out.push((env_name.to_string(), value));
        }
    }
    Ok(out)
}

fn extract_auth_key(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => {
            let trimmed = s.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        }
        Value::Object(map) => ["key", "apiKey", "api_key", "token"]
            .iter()
            .find_map(|field| map.get(*field).and_then(extract_auth_key)),
        _ => None,
    }
}

fn auth_json_provider_key(value: &Value, provider_id: &str) -> Option<String> {
    let root = value.as_object()?;
    if let Some(value) = root.get(provider_id).and_then(extract_auth_key) {
        return Some(value);
    }
    ["providers", "auth", "credentials", "apiKeys", "api_keys"]
        .iter()
        .find_map(|field| {
            root.get(*field)?
                .get(provider_id)
                .and_then(extract_auth_key)
        })
}

async fn pi_shared_auth_json_key(provider_id: &str) -> Result<Option<String>, String> {
    let Some(home) = dirs::home_dir() else {
        return Ok(None);
    };
    let path = home.join(".pi").join("agent").join("auth.json");
    let raw = match tokio::fs::read_to_string(&path).await {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("Failed to read Pi auth.json: {err}")),
    };
    let value: Value =
        serde_json::from_str(&raw).map_err(|e| format!("Failed to parse Pi auth.json: {e}"))?;
    Ok(auth_json_provider_key(&value, provider_id))
}

async fn pi_provider_api_key(provider_id: &str) -> Result<Option<String>, String> {
    // Pi's auth.json has priority over env-var fallback in the sidecar.
    // Mirror that here so the balance probe reads the same OpenRouter
    // account a Pi turn would actually charge. Claudette-private keys
    // are injected into the sidecar as env vars, so they take the same
    // slot as process env but should win when both are present.
    if let Some(key) = pi_shared_auth_json_key(provider_id).await? {
        return Ok(Some(key));
    }
    let stored = load_secure_secret(KEYCHAIN_BUCKET, &keychain_key(provider_id))
        .map_err(|e| format!("Failed to read pi provider secret: {e}"))?;
    if let Some(key) = stored
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    {
        return Ok(Some(key));
    }
    Ok(pi_env_var_for_provider(provider_id)
        .and_then(|env| std::env::var(env).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty()))
}

pub async fn fetch_pi_openrouter_credits() -> Result<OpenRouterCredits, String> {
    let key = pi_provider_api_key("openrouter")
        .await?
        .ok_or_else(|| "OpenRouter key is not configured for Pi".to_string())?;
    openrouter::fetch_credits(&key).await
}

pub async fn fetch_pi_openrouter_credit_bucket() -> Result<claudette::usage::UsageBucket, String> {
    let credits = fetch_pi_openrouter_credits().await?;
    Ok(openrouter::credit_bucket_from(&credits))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PiOpenRouterCredits {
    pub total_credits: f64,
    pub used_credits: f64,
    pub remaining_credits: f64,
}

impl From<OpenRouterCredits> for PiOpenRouterCredits {
    fn from(value: OpenRouterCredits) -> Self {
        Self {
            total_credits: value.total_credits,
            used_credits: value.used_credits,
            remaining_credits: value.remaining_credits,
        }
    }
}

#[tauri::command]
pub async fn pi_openrouter_credits() -> Result<PiOpenRouterCredits, String> {
    fetch_pi_openrouter_credits().await.map(Into::into)
}

#[derive(Debug, Deserialize)]
pub enum ProviderSecretScope {
    /// Write to Pi's auth.json (shared with terminal `pi`).
    #[serde(rename = "shared")]
    Shared,
    /// Store in Claudette's keychain (env-var injection only).
    #[serde(rename = "local")]
    Local,
}

fn working_dir_path(working_dir: &str) -> &Path {
    if working_dir.is_empty() {
        // Pi's `list_providers` only touches `auth.json` + the env
        // map; cwd doesn't matter. Fall back to `/` (which exists on
        // every platform Claudette targets) so a frontend that passes
        // an empty string can still query.
        Path::new("/")
    } else {
        Path::new(working_dir)
    }
}

#[tauri::command]
pub async fn pi_list_providers(working_dir: String) -> Result<PiProviderList, String> {
    let extras = pi_local_secret_env()?;
    let extras_slice = if extras.is_empty() {
        None
    } else {
        Some(extras.as_slice())
    };
    pi_control::list_providers(working_dir_path(&working_dir), extras_slice).await
}

#[tauri::command]
pub async fn pi_set_provider_api_key(
    working_dir: String,
    provider_id: String,
    key: String,
    scope: ProviderSecretScope,
) -> Result<(), String> {
    let trimmed = key.trim().to_string();
    if trimmed.is_empty() {
        return Err("API key is empty".to_string());
    }
    // Write the new credential first, then clear the *other* scope so
    // the old key never silently shadows the new one. Pi's resolution
    // order has auth.json beating env vars; without clearing the
    // other scope, switching from shared→local leaves the auth.json
    // entry in place and Pi keeps using the old key, while switching
    // from local→shared leaves the env-injected key around in case
    // the user later removes the auth.json entry from a terminal.
    // The previous "clear local first, then write shared" path
    // produced an even worse failure: a write error wiped the only
    // working credential.
    match scope {
        ProviderSecretScope::Shared => {
            pi_control::set_api_key(working_dir_path(&working_dir), &provider_id, &trimmed).await?;
            // If the user previously stored a private (keychain) key
            // and switches to shared, the stale private copy would
            // silently come back to life if they later remove the
            // auth.json entry from a terminal. Surface a delete
            // failure so the user knows the old secret is still in
            // place — the shared write already succeeded, so the
            // primary action is intact and this becomes advisory.
            delete_secure_secret(KEYCHAIN_BUCKET, &keychain_key(&provider_id)).map_err(|e| {
                format!(
                    "Saved shared key, but failed to remove the previously-stored \
                     keychain copy ({e}). If you want the keychain copy gone, retry \
                     after restoring secure-store access."
                )
            })?;
            Ok(())
        }
        ProviderSecretScope::Local => {
            if pi_env_var_for_provider(&provider_id).is_none() {
                return Err(format!(
                    "Provider \"{provider_id}\" has no env-var mapping; use shared storage instead."
                ));
            }
            save_secure_secret(KEYCHAIN_BUCKET, &keychain_key(&provider_id), &trimmed)
                .map_err(|e| format!("Failed to store pi provider secret: {e}"))?;
            // Drop any pre-existing shared auth.json entry only after
            // the new local secret is safely written. If the shared
            // clear fails (Pi auth.json unreadable, etc.) the local
            // key still wins for keychain-injected env-var lookups
            // outside auth.json, but inside Pi's resolution order the
            // shared entry would beat it — surface that condition so
            // the user knows their local change is shadowed.
            pi_control::clear_api_key(working_dir_path(&working_dir), &provider_id)
                .await
                .map_err(|e| {
                    format!(
                        "Saved local secret, but failed to clear shared auth.json entry \
                         (Pi will keep using the old shared key until it is removed): {e}"
                    )
                })
        }
    }
}

#[tauri::command]
pub async fn pi_clear_provider_api_key(
    working_dir: String,
    provider_id: String,
    scope: ProviderSecretScope,
) -> Result<(), String> {
    match scope {
        ProviderSecretScope::Shared => {
            pi_control::clear_api_key(working_dir_path(&working_dir), &provider_id).await
        }
        ProviderSecretScope::Local => {
            delete_secure_secret(KEYCHAIN_BUCKET, &keychain_key(&provider_id))
                .map_err(|e| format!("Failed to delete pi provider secret: {e}"))
        }
    }
}

#[tauri::command]
pub async fn pi_oauth_start(
    working_dir: String,
    provider_id: String,
    app: AppHandle,
) -> Result<PiOAuthStarted, String> {
    // A fresh challenge id per attempt so simultaneous flows don't
    // clobber each other. (The UI doesn't expose multi-attempt today,
    // but the harness is built for it; keep the surface honest.)
    let challenge_id = format!("pi-oauth-{}", uuid::Uuid::new_v4().simple());
    let extras = pi_local_secret_env()?;
    let extras_slice = if extras.is_empty() {
        None
    } else {
        Some(extras.as_slice())
    };
    let mut session = PiOAuthSession::start(
        working_dir_path(&working_dir),
        &provider_id,
        &challenge_id,
        extras_slice,
    )
    .await?;
    // Take the receiver subscribed BEFORE `oauth_start` was issued so
    // the very first `oauth_challenge` cannot race past us. A fresh
    // `subscribe_events()` after the fact is not equivalent — broadcast
    // channels do not replay messages to late subscribers, so any
    // event Pi emitted between `start_control` and this line would be
    // dropped without `take_events()`.
    let mut events = session
        .take_events()
        .ok_or("PiOAuthSession seeded events already consumed")?;
    let session = Arc::new(session);
    ACTIVE_OAUTH
        .lock()
        .await
        .insert(challenge_id.clone(), Arc::clone(&session));

    // Forward every event onto the webview. Drops itself when the
    // session emits OAuthComplete (the harness disposes itself on
    // that boundary; the long-lived session is still in ACTIVE_OAUTH
    // until oauth_cancel/submit_input finishes — clean up here too).
    let app_clone = app.clone();
    let challenge_id_clone = challenge_id.clone();
    tokio::spawn(async move {
        loop {
            match events.recv().await {
                Ok(event) => {
                    let is_complete = matches!(&event, PiControlEvent::OAuthComplete { .. });
                    let _ = app_clone.emit(OAUTH_EVENT, &event);
                    if is_complete {
                        ACTIVE_OAUTH.lock().await.remove(&challenge_id_clone);
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    ACTIVE_OAUTH.lock().await.remove(&challenge_id_clone);
                    break;
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(
                        target: "claudette::pi_auth",
                        dropped = n,
                        "pi_oauth_start broadcast lag"
                    );
                }
            }
        }
    });

    Ok(PiOAuthStarted {
        challenge_id,
        provider_id,
    })
}

#[tauri::command]
pub async fn pi_oauth_submit_input(challenge_id: String, value: String) -> Result<(), String> {
    let session = ACTIVE_OAUTH
        .lock()
        .await
        .get(&challenge_id)
        .cloned()
        .ok_or_else(|| format!("No active Pi OAuth session for {challenge_id}"))?;
    session.submit_input(&value).await
}

#[tauri::command]
pub async fn pi_oauth_cancel(challenge_id: String) -> Result<(), String> {
    let session = ACTIVE_OAUTH.lock().await.remove(&challenge_id);
    if let Some(session) = session {
        session.cancel().await
    } else {
        // Already cancelled / completed. Idempotent.
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_map_covers_canonical_providers() {
        // Spot-check the providers we care about most for the user
        // story (Copilot, OpenRouter, OpenAI). A regression here is a
        // silent feature break, so the test pins each mapping.
        assert_eq!(
            pi_env_var_for_provider("openrouter"),
            Some("OPENROUTER_API_KEY")
        );
        assert_eq!(pi_env_var_for_provider("openai"), Some("OPENAI_API_KEY"));
        assert_eq!(
            pi_env_var_for_provider("github-copilot"),
            Some("COPILOT_GITHUB_TOKEN")
        );
        assert_eq!(
            pi_env_var_for_provider("anthropic"),
            Some("ANTHROPIC_API_KEY")
        );
        assert_eq!(pi_env_var_for_provider("nonexistent"), None);
    }

    #[test]
    fn keychain_key_is_namespaced() {
        // Two layers of isolation: the KEYCHAIN_BUCKET keeps Pi keys
        // out of agentBackendSecrets, and the `pi_provider:` prefix
        // keeps individual rows from colliding with anything else
        // someone might wedge into this bucket later.
        assert_eq!(keychain_key("openrouter"), "pi_provider:openrouter");
        assert!(keychain_key("github-copilot").starts_with("pi_provider:"));
    }

    #[test]
    fn auth_json_provider_key_reads_direct_pi_shape() {
        let value = serde_json::json!({
            "openrouter": { "type": "api_key", "key": "sk-or-test" }
        });
        assert_eq!(
            auth_json_provider_key(&value, "openrouter").as_deref(),
            Some("sk-or-test")
        );
    }

    #[test]
    fn auth_json_provider_key_reads_nested_provider_shape() {
        let value = serde_json::json!({
            "providers": {
                "openrouter": { "apiKey": "sk-or-nested" }
            }
        });
        assert_eq!(
            auth_json_provider_key(&value, "openrouter").as_deref(),
            Some("sk-or-nested")
        );
    }
}
