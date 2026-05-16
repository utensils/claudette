//! Startup auto-detect probation + opt-out: the helpers that decide
//! which built-in backends should flip themselves on at launch when
//! their dependencies appear (Codex CLI, Ollama, LM Studio, Pi
//! sidecar), and the per-backend opt-out persistence that keeps a
//! deliberately-disabled card disabled.

use std::time::Duration;

use claudette::agent::resolve_codex_path;
use claudette::agent_backend::{AgentBackendConfig, AgentBackendKind, AgentBackendModel};
use claudette::db::Database;

use super::config::{apply_discovered_models, backend_models_signature, canonical_backend_id};
use super::{codex_cli_command, discover_codex_models, discover_models};

pub(super) const AUTO_DETECT_DISABLED_PREFIX: &str = "agent_backend_auto_detect_disabled:";
pub(super) const AUTO_DETECT_TIMEOUT: Duration = Duration::from_millis(900);
// Pi's discovery cold-starts a Bun-compiled sidecar binary, boots the
// Pi SDK, and enumerates 300+ models — easily 2–5s on first launch,
// well past the 900ms budget we use for cheap localhost HTTP probes.
// A short timeout here silently swallowed the discovery result and
// left the Pi card with an empty `discovered_models` list at startup
// (only the manual seeds were visible), forcing the user to open
// Settings and click Refresh. 8s covers a cold Bun start with margin
// and still bounds the worst case if the sidecar hangs.
#[cfg(feature = "pi-sdk")]
pub(super) const PI_AUTO_DETECT_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Debug, Clone)]
pub(super) struct BackendAutoDetection {
    pub(super) backend_id: String,
    pub(super) detected: bool,
    pub(super) discovered_models: Vec<AgentBackendModel>,
    pub(super) warning: Option<String>,
}

pub(super) fn auto_detect_disabled_key(backend_id: &str) -> String {
    format!(
        "{AUTO_DETECT_DISABLED_PREFIX}{}",
        canonical_backend_id(backend_id)
    )
}

pub(super) fn backend_supports_auto_detect(backend: &AgentBackendConfig) -> bool {
    #[cfg(feature = "pi-sdk")]
    {
        matches!(
            backend.kind,
            AgentBackendKind::Ollama
                | AgentBackendKind::CodexNative
                | AgentBackendKind::LmStudio
                | AgentBackendKind::PiSdk
        )
    }
    #[cfg(not(feature = "pi-sdk"))]
    {
        matches!(
            backend.kind,
            AgentBackendKind::Ollama | AgentBackendKind::CodexNative | AgentBackendKind::LmStudio
        )
    }
}

pub(super) fn backend_auto_detect_disabled(
    db: &Database,
    backend_id: &str,
) -> Result<bool, String> {
    db.get_app_setting(&auto_detect_disabled_key(backend_id))
        .map_err(|e| e.to_string())
        .map(|value| value.as_deref() == Some("true"))
}

pub(super) fn should_probe_backend_auto_detection(
    db: &Database,
    backend_id: &str,
) -> Result<bool, String> {
    backend_auto_detect_disabled(db, canonical_backend_id(backend_id)).map(|disabled| !disabled)
}

pub(super) fn skipped_backend_auto_detection(
    backend_id: impl Into<String>,
) -> BackendAutoDetection {
    BackendAutoDetection {
        backend_id: backend_id.into(),
        detected: false,
        discovered_models: Vec::new(),
        warning: None,
    }
}

pub(super) fn persist_backend_auto_detect_opt_out(
    db: &Database,
    backend: &AgentBackendConfig,
) -> Result<(), String> {
    if !backend_supports_auto_detect(backend) {
        return Ok(());
    }
    let key = auto_detect_disabled_key(&backend.id);
    if backend.enabled {
        db.delete_app_setting(&key).map_err(|e| e.to_string())
    } else {
        db.set_app_setting(&key, "true").map_err(|e| e.to_string())
    }
}

pub(super) fn apply_backend_auto_detections(
    db: &Database,
    backends: &mut [AgentBackendConfig],
    detections: &[BackendAutoDetection],
) -> Result<(bool, Vec<String>), String> {
    let mut changed = false;
    let mut warnings = Vec::new();
    for detection in detections {
        if !detection.detected {
            continue;
        }
        let backend_id = canonical_backend_id(&detection.backend_id);
        if backend_auto_detect_disabled(db, backend_id)? {
            continue;
        }
        let Some(backend) = backends
            .iter_mut()
            .find(|backend| canonical_backend_id(&backend.id) == backend_id)
        else {
            warnings.push(format!(
                "Detected `{backend_id}` but no matching backend is available in this build."
            ));
            continue;
        };
        if !backend.enabled {
            backend.enabled = true;
            changed = true;
        }
        if !detection.discovered_models.is_empty() {
            let before = backend_models_signature(backend);
            let before_default = backend.default_model.clone();
            apply_discovered_models(backend, detection.discovered_models.clone());
            if backend_models_signature(backend) != before
                || backend.default_model != before_default
            {
                changed = true;
            }
        }
    }
    Ok((changed, warnings))
}

pub(super) async fn probe_codex_backend(
    backend: Option<AgentBackendConfig>,
) -> BackendAutoDetection {
    let backend = backend.unwrap_or_else(AgentBackendConfig::builtin_codex_native);
    let backend_id = backend.id.clone();
    let detected = match tokio::time::timeout(AUTO_DETECT_TIMEOUT, async {
        let codex_path = resolve_codex_path().await;
        let mut command = codex_cli_command(codex_path);
        command.arg("--version").output().await
    })
    .await
    {
        Ok(Ok(output)) => output.status.success(),
        Ok(Err(_)) => false,
        Err(_) => false,
    };
    let discovered_models = if detected {
        match tokio::time::timeout(AUTO_DETECT_TIMEOUT, discover_codex_models()).await {
            Ok(Ok(models)) if !models.is_empty() => models,
            _ => codex_startup_models(&backend),
        }
    } else {
        Vec::new()
    };
    BackendAutoDetection {
        backend_id,
        detected,
        discovered_models,
        warning: None,
    }
}

pub(super) fn codex_startup_models(backend: &AgentBackendConfig) -> Vec<AgentBackendModel> {
    if !backend.discovered_models.is_empty() {
        return Vec::new();
    }
    let mut models = if backend.manual_models.is_empty() {
        AgentBackendConfig::builtin_codex_native().manual_models
    } else {
        backend.manual_models.clone()
    };
    for model in &mut models {
        if model.label.trim().is_empty() {
            model.label = model.id.clone();
        }
        if model.context_window_tokens == 0 {
            model.context_window_tokens = backend.context_window_default;
        }
        model.discovered = true;
    }
    models
}

pub(super) async fn probe_model_discovery_backend(
    backend: Option<AgentBackendConfig>,
) -> BackendAutoDetection {
    let Some(backend) = backend else {
        return BackendAutoDetection {
            backend_id: String::new(),
            detected: false,
            discovered_models: Vec::new(),
            warning: None,
        };
    };
    let backend_id = backend.id.clone();
    // Pi cold-starts a sidecar; everything else hits a fast localhost
    // endpoint. Pick the budget per kind rather than holding everyone
    // to Pi's worst case (which would slow first-paint of the Settings
    // panel and the chat picker for unrelated cards).
    let timeout = backend_auto_detect_timeout(&backend);
    match tokio::time::timeout(timeout, discover_models(&backend)).await {
        Ok(Ok(models)) => BackendAutoDetection {
            backend_id,
            detected: true,
            discovered_models: models,
            warning: None,
        },
        Ok(Err(error)) => BackendAutoDetection {
            backend_id,
            detected: false,
            discovered_models: Vec::new(),
            warning: Some(format!("Auto-detect skipped {}: {error}", backend.label)),
        },
        Err(_) => BackendAutoDetection {
            backend_id,
            detected: false,
            discovered_models: Vec::new(),
            // Surface the timeout as a warning so it's visible in the
            // settings panel's status strip instead of vanishing
            // silently — that silent swallow was exactly what hid the
            // Pi cold-start case before the per-kind timeout split.
            warning: Some(format!(
                "Auto-detect timed out for {} after {}s",
                backend.label,
                timeout.as_secs_f32().round() as u64
            )),
        },
    }
}

/// Per-backend timeout for the startup auto-detect probe. Pi runs a
/// Bun-compiled sidecar with a multi-second cold start; HTTP-probe
/// backends get the tighter default so they don't drag out launch.
pub(super) fn backend_auto_detect_timeout(backend: &AgentBackendConfig) -> Duration {
    match backend.kind {
        #[cfg(feature = "pi-sdk")]
        AgentBackendKind::PiSdk => PI_AUTO_DETECT_TIMEOUT,
        _ => AUTO_DETECT_TIMEOUT,
    }
}
