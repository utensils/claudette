use tauri::State;

use crate::commands::agent_backends::load_backend_secret;
use crate::state::AppState;
use crate::usage::{self, ClaudeCodeUsage};
use claudette::agent::{CodexAppServerOptions, CodexAppServerSession};
use claudette::agent_backend::{AgentBackendConfig, AgentBackendKind};
use claudette::db::Database;
use claudette::usage::{
    UsageSnapshot, anthropic_oauth, codex_account, local_aggregate, openrouter,
};

#[tauri::command]
pub async fn get_claude_code_usage(state: State<'_, AppState>) -> Result<ClaudeCodeUsage, String> {
    usage::get_usage(&state.usage_cache).await
}

/// Per-session usage snapshot. Dispatches to the right source based on
/// the backend's kind and whether the user has opted in to the
/// experimental Anthropic OAuth Usage API.
///
/// The frontend passes the active backend config (kind, base_url, id,
/// default_model) rather than letting Rust look it up — the active
/// `selectedModelProvider` mapping lives in the Zustand toolbar slice
/// and isn't persisted to SQLite, so the frontend is the source of
/// truth. Any secret the backend needs for provider usage endpoints
/// (currently OpenRouter `/credits`) is loaded server-side, so the API
/// key never crosses the IPC boundary.
#[tauri::command]
pub async fn get_session_usage(
    state: State<'_, AppState>,
    workspace_id: String,
    chat_session_id: String,
    backend: AgentBackendConfig,
    usage_insights_enabled: bool,
) -> Result<UsageSnapshot, String> {
    let now_ms = chrono::Utc::now().timestamp_millis();

    // Anthropic-family backends (subscription OAuth lives behind the
    // experimental gate). When the gate is off, return the disabled-state
    // stub so the frontend renders the indicator in greyed mode without
    // leaking any per-session token data the user hasn't asked for.
    //
    // OpenAI / Custom OpenAI / Ollama / LM Studio also default to the
    // `claude_code` harness for gateway translation, but they go to the
    // local-aggregate branch below — the meter shows tokens recorded
    // by Claudette, not Anthropic OAuth quotas, so no gate applies.
    if is_claude_family(&backend.kind) {
        if !usage_insights_enabled {
            return Ok(UsageSnapshot::experimental_stub(backend.kind, now_ms));
        }
        return match anthropic_oauth::get_usage(&state.usage_cache).await {
            Ok(usage) => Ok(anthropic_oauth::snapshot_from_usage(
                &usage,
                backend.kind,
                now_ms,
            )),
            Err(e) => Err(e),
        };
    }

    // Codex (Native or Subscription): prefer the live `account/rateLimits`
    // snapshot when the chat-send loop has populated the cache (see
    // `commands::chat::send` for the subscriber task wiring). When the
    // cache is cold — e.g. user hasn't sent a Codex turn this run yet —
    // fall through to local-aggregate so the meter still shows
    // something useful.
    if matches!(
        backend.kind,
        AgentBackendKind::CodexNative | AgentBackendKind::CodexSubscription
    ) {
        let snapshot = state.codex_rate_limits.read().await.clone();
        if let Some(snapshot) = snapshot {
            return Ok(codex_account::snapshot_from_rate_limits(
                backend.kind,
                &snapshot,
                "Codex",
                now_ms,
            ));
        }
    }

    // Non-Claude path: every backend gets the local-aggregate baseline,
    // and OpenRouter merges in its provider-specific credit bucket.
    let db = Database::open(&state.db_path).map_err(|e| format!("DB open failed: {e}"))?;

    let session = db
        .usage_session_totals(&chat_session_id)
        .map_err(|e| format!("session aggregate failed: {e}"))?;
    let today = db
        .usage_workspace_24h_totals(&workspace_id)
        .map_err(|e| format!("daily aggregate failed: {e}"))?;

    let default_model = backend.default_model.as_deref();

    // Provider-specific extras and label.
    let (source_label, extra_buckets) = match backend.kind {
        // Both Codex variants share the "Codex" header. Native is the
        // standalone app-server harness, Subscription is the Codex CLI
        // routed through Claude CLI's gateway — different runtimes, same
        // user-facing branding, same data source (local aggregate;
        // upstream Codex usage telemetry is deferred).
        AgentBackendKind::CodexNative | AgentBackendKind::CodexSubscription => {
            (String::from("Codex"), Vec::new())
        }
        AgentBackendKind::CustomOpenAi
            if openrouter::is_openrouter_base_url(backend.base_url.as_deref()) =>
        {
            // Read the user's OpenRouter API key from the keychain via the
            // same `load_secure_secret` path the agent runtime uses to
            // authenticate the model call itself. Frontend never sees the
            // key. Network errors are swallowed — the bucket simply doesn't
            // appear, and local-aggregate still carries the meter.
            let mut extras = Vec::new();
            if let Ok(Some(key)) = load_backend_secret(&backend.id)
                && !key.is_empty()
                && let Ok(Some(bucket)) = openrouter::fetch_credit_bucket(&key).await
            {
                extras.push(bucket);
            }
            (String::from("OpenRouter"), extras)
        }
        AgentBackendKind::OpenAiApi | AgentBackendKind::CustomOpenAi => {
            (String::from("OpenAI"), Vec::new())
        }
        AgentBackendKind::Ollama => (String::from("Ollama"), Vec::new()),
        AgentBackendKind::LmStudio => (String::from("LM Studio"), Vec::new()),
        #[cfg(feature = "pi-sdk")]
        AgentBackendKind::PiSdk => {
            let mut extras = Vec::new();
            if pi_model_is_openrouter(backend.default_model.as_deref())
                && let Ok(bucket) =
                    crate::commands::agent_backends::pi_auth::fetch_pi_openrouter_credit_bucket()
                        .await
            {
                extras.push(bucket);
            }
            (String::from("Pi"), extras)
        }
        // Anthropic-family already handled above; fall through for
        // forward-compat if a new variant is added without a matching
        // dispatch arm.
        AgentBackendKind::Anthropic | AgentBackendKind::CustomAnthropic => {
            (String::from("Claude"), Vec::new())
        }
    };

    Ok(local_aggregate::snapshot_from_locals(
        backend.kind,
        source_label,
        session,
        today,
        default_model,
        extra_buckets,
        now_ms,
    ))
}

fn pi_model_is_openrouter(model: Option<&str>) -> bool {
    model
        .and_then(|model| model.split_once('/').map(|(provider, _)| provider))
        .is_some_and(|provider| provider.eq_ignore_ascii_case("openrouter"))
}

/// Mirror of the TS-side `CLAUDE_FAMILY_KINDS` in
/// `src/ui/src/components/chat/composer/usageIndicatorMode.ts`. Membership
/// is "auth source is Anthropic Pro/Max OAuth". Codex Subscription is NOT
/// here — its auth is Codex-side and the Anthropic Usage API can never
/// speak for it, even though its default harness happens to be the Claude
/// CLI gateway.
fn is_claude_family(kind: &AgentBackendKind) -> bool {
    matches!(
        kind,
        AgentBackendKind::Anthropic | AgentBackendKind::CustomAnthropic
    )
}

/// Spawn a short-lived Codex app-server session, fire
/// `account/rateLimits/read`, persist the result, and tear the
/// session down. Lets the composer's usage meter render real plan
/// quotas the moment the user selects a Codex backend, instead of
/// waiting for the next `chat::send` turn to populate the cache as
/// a side-effect.
///
/// Idempotent and cheap to call from the frontend's model-switch
/// effect: takes ~1–2s on a cold launch (Codex CLI spawn cost) and
/// returns immediately on success or any RPC failure. Failures fall
/// back to the local-aggregate path that already renders in the
/// meter — there is nothing user-visible to surface, so we return
/// `Ok(())` either way and just log on the Rust side.
#[tauri::command]
pub async fn prefetch_codex_rate_limits(
    state: State<'_, AppState>,
    backend: AgentBackendConfig,
) -> Result<(), String> {
    if !matches!(
        backend.kind,
        AgentBackendKind::CodexNative | AgentBackendKind::CodexSubscription
    ) {
        return Ok(());
    }

    let cwd = std::env::current_dir()
        .ok()
        .filter(|path| path.exists())
        .or_else(dirs::home_dir)
        .unwrap_or_else(std::env::temp_dir);

    let session = match CodexAppServerSession::start_with_options(
        &cwd,
        env!("CARGO_PKG_VERSION"),
        CodexAppServerOptions {
            model: backend.default_model.clone(),
            ..Default::default()
        },
    )
    .await
    {
        Ok(session) => session,
        Err(err) => {
            tracing::debug!(
                target: "claudette::usage",
                error = %err,
                "Codex rate-limits prefetch failed at session start (auth not ready?)",
            );
            return Ok(());
        }
    };

    let pid = session.pid();
    let read_outcome = session.read_rate_limits().await;

    // Best-effort shutdown — the session struct intentionally has no
    // `Drop` impl that kills the process, so we must call this here.
    if let Err(stop_err) = claudette::agent::stop_agent_graceful(pid).await {
        tracing::debug!(
            target: "claudette::usage",
            pid,
            error = %stop_err,
            "failed to stop prefetch Codex app-server session",
        );
    }

    match read_outcome {
        Ok(response) => {
            let snapshot = response.rate_limits.clone();
            *state.codex_rate_limits.write().await = Some(snapshot.clone());

            let db_path = state.db_path.clone();
            tokio::task::spawn_blocking(move || {
                if let Err(err) =
                    Database::open(&db_path).and_then(|db| db.save_codex_rate_limits(&snapshot))
                {
                    tracing::warn!(
                        target: "claudette::usage",
                        error = %err,
                        "failed to persist Codex rate-limits prefetch snapshot",
                    );
                }
            });

            // No event emit — the frontend caller chains a fresh
            // `getSessionUsage` fetch after this command resolves
            // (see `useSessionUsagePoller`'s
            // `prefetchCodexRateLimits(backend).then(() => fetchOnce())`),
            // so the cached snapshot surfaces on the next IPC call
            // without needing a separate broadcast.
        }
        Err(err) => {
            tracing::debug!(
                target: "claudette::usage",
                error = %err,
                "Codex rate-limits prefetch RPC failed; meter falls back to local aggregate",
            );
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn open_usage_settings() -> Result<(), String> {
    open_external_url("https://claude.ai/settings/usage").await
}

#[tauri::command]
pub async fn open_release_notes() -> Result<(), String> {
    open_external_url("https://github.com/utensils/Claudette/releases").await
}

async fn open_external_url(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        claudette::process::command("open")
            .arg(url)
            .spawn()
            .map_err(|e| format!("Failed to open URL: {e}"))?;
    }
    #[cfg(target_os = "windows")]
    {
        // `start` treats its first quoted argument as a window title, so an
        // unquoted target containing spaces or quotes can be misparsed as a
        // title with no real target. The empty `""` slot neutralises that
        // quirk — current callers pass controlled URLs, but the defensive
        // form costs nothing and protects future callers.
        claudette::process::command("cmd")
            .args(["/C", "start", "", url])
            .spawn()
            .map_err(|e| format!("Failed to open URL: {e}"))?;
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        claudette::process::command("xdg-open")
            .arg(url)
            .spawn()
            .map_err(|e| format!("Failed to open URL: {e}"))?;
    }

    Ok(())
}
