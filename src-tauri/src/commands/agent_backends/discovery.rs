//! Per-backend model-list discovery + connectivity checks. Talks to:
//!
//! - Ollama's /api/tags
//! - LM Studio's /api/v0/models (preferred) and OpenAI-shaped /v1/models
//! - Cloud OpenAI's /v1/models
//! - Custom Anthropic gateways' /v1/models
//! - The Codex CLI (`codex debug models` + `codex login status`) for the
//!   subscription-auth catalog
//! - The Codex app-server's `list_models` for native-Codex picker rows
//! - The Pi sidecar's discoverModels (pi-sdk feature only)
//!
//! Also owns the small Codex-CLI command builder that suppresses the
//! Windows console window for every probe and the OpenAI URL builder
//! shared with the gateway translation layer.

use std::collections::{HashMap, HashSet};

use claudette::agent::{
    CodexAppServerOptions, CodexAppServerSession, resolve_codex_path, stop_agent_graceful,
};
use claudette::agent_backend::{AgentBackendConfig, AgentBackendKind, AgentBackendModel};
use claudette::plugin::load_secure_secret;
use claudette::process::CommandWindowExt as _;
use serde_json::Value;

#[cfg(feature = "pi-sdk")]
use claudette::agent::PiSdkSession;

use super::config::{BackendStatus, SECRET_BUCKET};

pub(super) async fn discover_models(
    backend: &AgentBackendConfig,
) -> Result<Vec<AgentBackendModel>, String> {
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
        AgentBackendKind::CodexNative => discover_codex_native_models(backend).await,
        AgentBackendKind::LmStudio => discover_lm_studio_models(backend).await,
        #[cfg(feature = "pi-sdk")]
        AgentBackendKind::PiSdk => discover_pi_models(backend).await,
        _ => Ok(backend.manual_models.clone()),
    }
}

pub(super) async fn test_backend_connectivity(
    backend: &AgentBackendConfig,
) -> Result<BackendStatus, String> {
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
        AgentBackendKind::CodexNative => test_codex_native_connectivity(backend).await,
        #[cfg(feature = "pi-sdk")]
        AgentBackendKind::PiSdk => discover_pi_models(backend).await.map(|models| {
            BackendStatus::new(
                true,
                format!(
                    "Pi SDK harness is available. Found {} model(s). Use `pi auth` to configure providers.",
                    models.len()
                ),
            )
        }),
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

async fn test_codex_native_connectivity(
    backend: &AgentBackendConfig,
) -> Result<BackendStatus, String> {
    let session = start_codex_native_control_session().await?;
    let pid = session.pid();
    let result = async {
        let account = session.read_account(true).await?;
        ensure_codex_native_authenticated(&account)?;
        let catalog_models = discover_codex_models().await.unwrap_or_default();
        let models = codex_native_models_from_app_server(
            backend,
            session.list_models().await?,
            &catalog_models,
        );
        let account_label = account
            .email
            .as_deref()
            .or(account.account_type.as_deref())
            .unwrap_or("Codex");
        Ok(BackendStatus::new(
            true,
            format!(
                "Codex app-server authenticated as {account_label}. Found {} model(s).",
                models.len()
            ),
        ))
    }
    .await;
    let _ = stop_agent_graceful(pid).await;
    result
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

#[cfg(feature = "pi-sdk")]
async fn discover_pi_models(
    backend: &AgentBackendConfig,
) -> Result<Vec<AgentBackendModel>, String> {
    // Run discovery from the OS temp dir rather than `.` so a Settings
    // "Refresh models" click can't sweep in workspace state via the
    // sidecar's cwd. Discovery never touches tools, so the cwd only
    // matters for `precheck_cwd`; `std::env::temp_dir()` is always
    // present and identical for every refresh.
    let cwd = std::env::temp_dir();
    let discovered = PiSdkSession::discover_models(&cwd).await?;
    let models: Vec<AgentBackendModel> = discovered
        .into_iter()
        .map(|model| AgentBackendModel {
            id: model.id.clone(),
            label: if model.label.trim().is_empty() {
                model.id
            } else {
                model.label
            },
            context_window_tokens: model
                .context_window_tokens
                .unwrap_or(backend.context_window_default),
            discovered: true,
        })
        .collect();
    // Return an empty Vec when discovery turns up nothing so that
    // `apply_discovered_models`'s `!discovered.is_empty()` guard keeps the
    // user's manual_models intact. Substituting the seed list here used to
    // trick that guard into clearing user-entered manual models.
    Ok(models)
}

pub(super) fn lm_studio_models_from_v0(
    value: &Value,
    default_context: u32,
) -> Vec<AgentBackendModel> {
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

pub(super) async fn discover_codex_models() -> Result<Vec<AgentBackendModel>, String> {
    codex_login_status().await?;
    // Codex does not currently expose a stable model-list API for ChatGPT
    // subscription auth. This native backend depends on the CLI debug
    // catalog until Codex publishes a supported discovery surface.
    let codex_path = resolve_codex_path().await;
    let mut command = codex_cli_command(codex_path);
    let output = command
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
    codex_models_from_debug_catalog(&value)
}

pub(super) fn codex_models_from_debug_catalog(
    value: &Value,
) -> Result<Vec<AgentBackendModel>, String> {
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
                .get("context_window")
                .or_else(|| model.get("max_context_window"))
                .and_then(Value::as_u64)
                .and_then(|n| u32::try_from(n).ok())
                .unwrap_or(272_000);
            Some(AgentBackendModel {
                id: id.to_string(),
                label: label.to_string(),
                context_window_tokens: context,
                discovered: true,
            })
        })
        .collect())
}

async fn discover_codex_native_models(
    backend: &AgentBackendConfig,
) -> Result<Vec<AgentBackendModel>, String> {
    let session = start_codex_native_control_session().await?;
    let pid = session.pid();
    let result = async {
        let account = session.read_account(false).await?;
        ensure_codex_native_authenticated(&account)?;
        let catalog_models = discover_codex_models().await.unwrap_or_default();
        Ok(codex_native_models_from_app_server(
            backend,
            session.list_models().await?,
            &catalog_models,
        ))
    }
    .await;
    let _ = stop_agent_graceful(pid).await;
    result
}

pub(super) fn codex_native_models_from_app_server(
    backend: &AgentBackendConfig,
    models: Vec<claudette::agent::codex_app_server::CodexAppServerModel>,
    catalog_models: &[AgentBackendModel],
) -> Vec<AgentBackendModel> {
    let mut seen = HashSet::new();
    let context_by_id: HashMap<&str, u32> = catalog_models
        .iter()
        .map(|model| (model.id.as_str(), model.context_window_tokens))
        .collect();
    let mut converted: Vec<_> = models
        .into_iter()
        .filter(|model| !model.hidden)
        .filter(|model| seen.insert(model.id.clone()))
        .map(|model| {
            let context_window_tokens = context_by_id
                .get(model.id.as_str())
                .copied()
                .unwrap_or(backend.context_window_default);
            (
                AgentBackendModel {
                    id: model.id,
                    label: model.label,
                    context_window_tokens,
                    discovered: true,
                },
                model.is_default,
            )
        })
        .collect();
    converted.sort_by(|a, b| {
        let a_default = models_backend_default_rank(backend, &a.0.id, a.1);
        let b_default = models_backend_default_rank(backend, &b.0.id, b.1);
        a_default.cmp(&b_default).then_with(|| a.0.id.cmp(&b.0.id))
    });
    converted.into_iter().map(|(model, _)| model).collect()
}

fn models_backend_default_rank(
    backend: &AgentBackendConfig,
    model_id: &str,
    is_default: bool,
) -> u8 {
    if backend.default_model.as_deref() == Some(model_id) || is_default {
        0
    } else {
        1
    }
}

pub(super) fn ensure_codex_native_authenticated(
    account: &claudette::agent::codex_app_server::CodexAppServerAccountStatus,
) -> Result<(), String> {
    if account.authenticated {
        Ok(())
    } else if account.requires_openai_auth {
        Err("Codex is not authenticated. Click Login for Codex or run `codex login`.".to_string())
    } else {
        Err(
            "Codex account status is unavailable. Click Login for Codex or run `codex login`."
                .to_string(),
        )
    }
}

async fn start_codex_native_control_session() -> Result<CodexAppServerSession, String> {
    let cwd = std::env::current_dir()
        .ok()
        .filter(|path| path.exists())
        .or_else(dirs::home_dir)
        .unwrap_or_else(std::env::temp_dir);
    CodexAppServerSession::start_with_options(
        &cwd,
        env!("CARGO_PKG_VERSION"),
        CodexAppServerOptions::default(),
    )
    .await
}

pub(super) async fn codex_login_status() -> Result<String, String> {
    let codex_path = resolve_codex_path().await;
    let mut command = codex_cli_command(codex_path);
    let output = command
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

pub(super) fn codex_cli_command(program: impl AsRef<std::ffi::OsStr>) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(program);
    command
        .no_console_window()
        .env("PATH", claudette::env::enriched_path());
    command
}

pub(super) fn filter_openai_models(models: Vec<AgentBackendModel>) -> Vec<AgentBackendModel> {
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

pub(super) fn models_from_openai_shape(
    value: &Value,
    default_context: u32,
) -> Vec<AgentBackendModel> {
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

pub(super) fn openai_api_url(base: &str, path: &str) -> String {
    let base = base.trim_end_matches('/');
    let path = path.trim_start_matches('/');
    if base.ends_with("/v1") {
        format!("{base}/{path}")
    } else {
        format!("{base}/v1/{path}")
    }
}
