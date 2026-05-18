//! Pi provider-auth control plane.
//!
//! Thin typed wrapper around the Pi sidecar's `list_providers`,
//! `set_api_key`, `clear_api_key`, and `oauth_*` IPC messages. The
//! Settings provider-management UI and the `/login` slash command call
//! into this module; the sidecar process management itself lives in
//! `pi_sdk.rs`.
//!
//! Two flavours of operation:
//!   - **One-shot**: spawn a control session, run a single IPC, dispose.
//!     Right for `list_providers`, `set_api_key`, `clear_api_key`.
//!   - **Long-lived**: `PiOAuthSession` keeps the harness alive across
//!     the device-code flow so the UI can stream challenge events and
//!     forward `onPrompt` inputs (e.g. GHES domain) back without
//!     respawning.
//!
//! All wire-level concerns (PiHarnessMessage variants, control-event
//! routing) live in `pi_sdk.rs`. This file only translates between the
//! sidecar's JSON shapes and the Rust types Tauri commands expose.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::broadcast;

use super::pi_sdk::{PiControlEvent, PiSdkSession};

/// One row in the curated provider list shown in Settings → Models →
/// Pi card and the `/login` picker. Mirrors `ProviderRow` in the
/// harness. `serde(rename_all = "camelCase")` so the wire shape matches
/// the sidecar without per-field renames.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiProvider {
    pub id: String,
    pub label: String,
    pub description: String,
    /// `"api_key"` | `"oauth"` | `"oauth+enterprise"` | `"env_only"`.
    pub kind: String,
    #[serde(default)]
    pub env_hint: Option<String>,
    #[serde(default)]
    pub docs_url: Option<String>,
    #[serde(default)]
    pub auth_source: Option<String>,
    pub configured: bool,
    pub model_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiProviderList {
    /// First `default_visible_count` providers render expanded in the
    /// card; the rest sit behind a "More providers…" disclosure.
    pub default_visible_count: u32,
    pub providers: Vec<PiProvider>,
}

/// Resolve the curated list against the user's live Pi state. Spawns a
/// short-lived sidecar; do not call on a hot path — caller throttles.
/// `extra_env` carries the keychain-only secrets the Tauri layer
/// injects so the harness reports `configured: true` for providers
/// stored privately to Claudette.
pub async fn list_providers(
    working_dir: &Path,
    extra_env: Option<&[(String, String)]>,
) -> Result<PiProviderList, String> {
    let session = PiSdkSession::start_control(working_dir, extra_env).await?;
    let value = session
        .send_request_raw(json!({ "type": "list_providers" }))
        .await?;
    let parsed = serde_json::from_value::<PiProviderList>(value)
        .map_err(|e| format!("Invalid Pi list_providers response: {e}"))?;
    let _ = session.dispose().await;
    Ok(parsed)
}

/// Write `key` to `~/.pi/agent/auth.json` under `provider_id`. This is
/// the "shared with terminal `pi`" storage path. For the keychain-only
/// path Claudette stores the key itself and injects an env var on
/// harness spawn — that flow does NOT call this function.
pub async fn set_api_key(working_dir: &Path, provider_id: &str, key: &str) -> Result<(), String> {
    if provider_id.is_empty() {
        return Err("Missing providerId".to_string());
    }
    if key.is_empty() {
        return Err("API key is empty".to_string());
    }
    let session = PiSdkSession::start_control(working_dir, None).await?;
    session
        .send_request_raw(json!({
            "type": "set_api_key",
            "providerId": provider_id,
            "key": key,
        }))
        .await?;
    let _ = session.dispose().await;
    Ok(())
}

pub async fn clear_api_key(working_dir: &Path, provider_id: &str) -> Result<(), String> {
    if provider_id.is_empty() {
        return Err("Missing providerId".to_string());
    }
    let session = PiSdkSession::start_control(working_dir, None).await?;
    session
        .send_request_raw(json!({
            "type": "clear_api_key",
            "providerId": provider_id,
        }))
        .await?;
    let _ = session.dispose().await;
    Ok(())
}

/// Long-lived control session bound to a single OAuth login attempt.
/// Spawn one when the Configure modal opens, take the seeded
/// receiver via `take_events()` (or fall back to `subscribe_events()`
/// for additional independent listeners), forward user input via
/// `submit_input` / cancel via `cancel`, and `dispose()` (Drop also
/// works) when the modal closes.
pub struct PiOAuthSession {
    session: PiSdkSession,
    challenge_id: String,
    provider_id: String,
    /// Receiver bound BEFORE the `oauth_start` IPC. Hands the very
    /// first `oauth_challenge` (which Pi can emit faster than the
    /// caller registers its own subscriber) over to the Tauri layer
    /// via `take_events()`. Once taken, additional listeners can
    /// still call `subscribe_events()` — but they will miss any
    /// event that arrived before they subscribed, which is fine
    /// because the Tauri layer fans the seeded receiver out to a
    /// webview event.
    seeded_events: Option<broadcast::Receiver<PiControlEvent>>,
}

impl PiOAuthSession {
    pub async fn start(
        working_dir: &Path,
        provider_id: &str,
        challenge_id: &str,
        extra_env: Option<&[(String, String)]>,
    ) -> Result<Self, String> {
        if provider_id.is_empty() {
            return Err("Missing providerId".to_string());
        }
        if challenge_id.is_empty() {
            return Err("Missing challengeId".to_string());
        }
        let session = PiSdkSession::start_control(working_dir, extra_env).await?;
        // Subscribe BEFORE we issue oauth_start. The harness streams
        // the first `oauth_challenge` as soon as Pi resolves the
        // device-code, which races past any subscription made later.
        // Hold the receiver on `self` and hand it to the caller via
        // `take_events()` so the seeded subscription survives across
        // the IPC round-trip.
        let seeded_events = Some(session.subscribe_control());
        session
            .send_request_raw(json!({
                "type": "oauth_start",
                "providerId": provider_id,
                "challengeId": challenge_id,
            }))
            .await?;
        Ok(Self {
            session,
            challenge_id: challenge_id.to_string(),
            provider_id: provider_id.to_string(),
            seeded_events,
        })
    }

    pub fn challenge_id(&self) -> &str {
        &self.challenge_id
    }

    pub fn provider_id(&self) -> &str {
        &self.provider_id
    }

    /// Take the seeded broadcast receiver established BEFORE
    /// `oauth_start`. The caller (typically the Tauri webview-event
    /// forwarder) MUST use this on first subscription instead of
    /// `subscribe_events()` so the initial `oauth_challenge` payload
    /// is not lost. Returns `None` if already taken (subsequent
    /// listeners are independent and may legitimately miss the
    /// initial event).
    pub fn take_events(&mut self) -> Option<broadcast::Receiver<PiControlEvent>> {
        self.seeded_events.take()
    }

    /// Subscribe to control events from this point forward. Will miss
    /// any events that fired before this call — prefer
    /// `take_events()` for the primary subscriber.
    pub fn subscribe_events(&self) -> broadcast::Receiver<PiControlEvent> {
        self.session.subscribe_control()
    }

    /// Forward a user-entered value (e.g. a GHES domain) back to Pi's
    /// `onPrompt` resolver.
    pub async fn submit_input(&self, value: &str) -> Result<(), String> {
        self.session
            .send_request_raw(json!({
                "type": "oauth_input",
                "challengeId": self.challenge_id,
                "value": value,
            }))
            .await?;
        Ok(())
    }

    /// Abort the in-flight device-code flow. Pi's `onPrompt` resolver
    /// rejects with "OAuth flow cancelled by user."; the harness then
    /// emits `oauth_complete { ok: false }`.
    pub async fn cancel(&self) -> Result<(), String> {
        self.session
            .send_request_raw(json!({
                "type": "oauth_cancel",
                "challengeId": self.challenge_id,
            }))
            .await?;
        Ok(())
    }

    /// Tear down the sidecar.
    pub async fn dispose(self) -> Result<(), String> {
        self.session.dispose().await
    }
}

/// Result wire shape returned by the high-level Tauri command path.
/// Surfaces the value of the OAuth challenge currently displayed to
/// the user so the React modal can render without holding its own
/// state-machine glue.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiOAuthStarted {
    pub challenge_id: String,
    pub provider_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_list_round_trips() {
        let raw = serde_json::json!({
            "defaultVisibleCount": 6,
            "providers": [{
                "id": "openrouter",
                "label": "OpenRouter",
                "description": "Meta-aggregator",
                "kind": "api_key",
                "envHint": "OPENROUTER_API_KEY",
                "docsUrl": "https://openrouter.ai/keys",
                "configured": false,
                "modelCount": 275,
            }],
        });
        let parsed: PiProviderList = serde_json::from_value(raw).unwrap();
        assert_eq!(parsed.default_visible_count, 6);
        assert_eq!(parsed.providers.len(), 1);
        let row = &parsed.providers[0];
        assert_eq!(row.id, "openrouter");
        assert_eq!(row.env_hint.as_deref(), Some("OPENROUTER_API_KEY"));
        assert_eq!(row.model_count, 275);
        assert!(!row.configured);
    }

    #[test]
    fn provider_list_tolerates_missing_optional_fields() {
        // Bedrock entry from the env_only group has neither envHint
        // nor authSource. Deserialize must succeed.
        let raw = serde_json::json!({
            "defaultVisibleCount": 6,
            "providers": [{
                "id": "amazon-bedrock",
                "label": "Amazon Bedrock",
                "description": "AWS",
                "kind": "env_only",
                "configured": false,
                "modelCount": 93,
            }],
        });
        let parsed: PiProviderList = serde_json::from_value(raw).unwrap();
        let row = &parsed.providers[0];
        assert!(row.env_hint.is_none());
        assert!(row.auth_source.is_none());
        assert!(row.docs_url.is_none());
    }
}
