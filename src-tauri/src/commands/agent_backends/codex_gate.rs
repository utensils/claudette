//! Alternative-backends and native-Codex gates plus the one-shot
//! migration that retired the `experimental-codex` / `codex-subscription`
//! ids. Lives in its own submodule so the gate constants and the
//! "should this backend be reachable in this build" predicates aren't
//! mixed in with the runtime resolver or the wire-translation code.

use claudette::agent_backend::{AgentBackendConfig, AgentBackendKind};
use claudette::db::Database;

pub(super) const ALTERNATIVE_BACKENDS_SETTING_KEY: &str = "alternative_backends_enabled";
pub(super) const NATIVE_CODEX_BACKEND_ID: &str = "codex";
pub(super) const LEGACY_NATIVE_CODEX_BACKEND_ID: &str = "experimental-codex";
pub(super) const LEGACY_CODEX_SUBSCRIPTION_BACKEND_ID: &str = "codex-subscription";
pub(super) const NATIVE_CODEX_SETTING_KEY: &str = "codex_enabled";
pub(super) const LEGACY_NATIVE_CODEX_SETTING_KEY: &str = "experimental_codex_enabled";
pub(super) const FIRST_CLASS_BACKENDS_PROMOTION_KEY: &str = "agent_backends_first_class_promoted";

/// Kinds that bypass the `alternative_backends_enabled` gate because
/// they're first-class first-run experiences when their dependencies
/// are detected (Codex via `codex` CLI, Pi via the bundled sidecar).
/// Pi only counts when the Pi harness is compiled in — otherwise the
/// list collapses to just Codex Native.
pub(super) fn is_always_on_alt_backend(kind: AgentBackendKind) -> bool {
    #[cfg(feature = "pi-sdk")]
    {
        matches!(
            kind,
            AgentBackendKind::CodexNative | AgentBackendKind::PiSdk
        )
    }
    #[cfg(not(feature = "pi-sdk"))]
    {
        matches!(kind, AgentBackendKind::CodexNative)
    }
}

pub(super) fn is_codex_gate_backend_id(id: &str) -> bool {
    matches!(
        id,
        LEGACY_CODEX_SUBSCRIPTION_BACKEND_ID
            | LEGACY_NATIVE_CODEX_BACKEND_ID
            | NATIVE_CODEX_BACKEND_ID
    )
}

pub(super) fn codex_backend_hidden_by_gate(native_codex_enabled: bool, id: &str) -> bool {
    id == LEGACY_CODEX_SUBSCRIPTION_BACKEND_ID
        || (!native_codex_enabled
            && matches!(id, LEGACY_NATIVE_CODEX_BACKEND_ID | NATIVE_CODEX_BACKEND_ID))
}

pub(super) fn default_backends_for_gate(native_codex_enabled: bool) -> Vec<AgentBackendConfig> {
    let mut backends = vec![
        AgentBackendConfig::builtin_anthropic(),
        AgentBackendConfig::builtin_ollama(),
        AgentBackendConfig::builtin_openai_api(),
        #[cfg(feature = "pi-sdk")]
        AgentBackendConfig::builtin_pi_sdk(),
        AgentBackendConfig::builtin_lm_studio(),
    ];
    if native_codex_enabled {
        backends.insert(3, AgentBackendConfig::builtin_codex_native());
    }
    backends
}

pub(super) fn native_codex_enabled(db: &Database) -> Result<bool, String> {
    promote_first_class_backend_gates(db)?;
    let native = db
        .get_app_setting(NATIVE_CODEX_SETTING_KEY)
        .map_err(|e| e.to_string())?;
    if native.is_some() {
        return Ok(native.as_deref() != Some("false"));
    }
    db.get_app_setting(LEGACY_NATIVE_CODEX_SETTING_KEY)
        .map_err(|e| e.to_string())
        .map(|value| value.as_deref() != Some("false"))
}

pub(super) fn ensure_native_codex_enabled(db: &Database) -> Result<(), String> {
    if native_codex_enabled(db)? {
        Ok(())
    } else {
        Err("Codex is disabled. Enable Settings → Models → Codex to use native Codex.".to_string())
    }
}

pub(super) fn ensure_backend_id_allowed_by_gate(
    db: &Database,
    backend_id: &str,
) -> Result<(), String> {
    if is_codex_gate_backend_id(backend_id) {
        ensure_native_codex_enabled(db)?;
    }
    Ok(())
}

pub(super) fn ensure_backend_allowed_by_gate(
    db: &Database,
    backend: &AgentBackendConfig,
) -> Result<(), String> {
    if backend.kind == AgentBackendKind::CodexNative || is_codex_gate_backend_id(&backend.id) {
        ensure_native_codex_enabled(db)?;
    }
    Ok(())
}

pub(super) fn alternative_backends_enabled(db: &Database) -> Result<bool, String> {
    promote_first_class_backend_gates(db)?;
    db.get_app_setting(ALTERNATIVE_BACKENDS_SETTING_KEY)
        .map_err(|e| e.to_string())
        .map(|setting| setting.as_deref() != Some("false"))
}

fn promote_first_class_backend_gates(db: &Database) -> Result<(), String> {
    migrate_legacy_codex_backend_settings(db)?;
    if db
        .get_app_setting(FIRST_CLASS_BACKENDS_PROMOTION_KEY)
        .map_err(|e| e.to_string())?
        .as_deref()
        == Some("true")
    {
        return Ok(());
    }

    db.set_app_setting(ALTERNATIVE_BACKENDS_SETTING_KEY, "true")
        .map_err(|e| e.to_string())?;
    db.set_app_setting(NATIVE_CODEX_SETTING_KEY, "true")
        .map_err(|e| e.to_string())?;
    db.set_app_setting(LEGACY_NATIVE_CODEX_SETTING_KEY, "true")
        .map_err(|e| e.to_string())?;
    db.set_app_setting(FIRST_CLASS_BACKENDS_PROMOTION_KEY, "true")
        .map_err(|e| e.to_string())
}

fn migrate_legacy_codex_backend_settings(db: &Database) -> Result<(), String> {
    if db
        .get_app_setting("default_agent_backend")
        .map_err(|e| e.to_string())?
        .as_deref()
        .is_some_and(|value| is_legacy_codex_backend_id(value))
    {
        db.set_app_setting("default_agent_backend", NATIVE_CODEX_BACKEND_ID)
            .map_err(|e| e.to_string())?;
    }
    for (key, value) in db
        .list_app_settings_with_prefix("model_provider:")
        .map_err(|e| e.to_string())?
    {
        if is_legacy_codex_backend_id(&value) {
            db.set_app_setting(&key, NATIVE_CODEX_BACKEND_ID)
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn is_legacy_codex_backend_id(id: &str) -> bool {
    matches!(
        id,
        LEGACY_NATIVE_CODEX_BACKEND_ID | LEGACY_CODEX_SUBSCRIPTION_BACKEND_ID
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alternative_backends_promote_on_by_default() {
        let db = Database::open_in_memory().expect("test db should open");

        assert!(alternative_backends_enabled(&db).expect("setting should load"));
        assert_eq!(
            db.get_app_setting(FIRST_CLASS_BACKENDS_PROMOTION_KEY)
                .expect("promotion marker should read")
                .as_deref(),
            Some("true")
        );
    }

    #[test]
    fn saved_false_backend_gates_are_flipped_during_promotion() {
        let db = Database::open_in_memory().expect("test db should open");
        db.set_app_setting(ALTERNATIVE_BACKENDS_SETTING_KEY, "false")
            .expect("setting should save");
        db.set_app_setting(NATIVE_CODEX_SETTING_KEY, "false")
            .expect("setting should save");

        assert!(alternative_backends_enabled(&db).expect("setting should load"));
        assert!(native_codex_enabled(&db).expect("setting should load"));
    }

    #[test]
    fn native_codex_command_guard_requires_models_gate_after_promotion() {
        let db = Database::open_in_memory().expect("test db should open");
        db.set_app_setting(FIRST_CLASS_BACKENDS_PROMOTION_KEY, "true")
            .expect("setting should save");
        db.set_app_setting(NATIVE_CODEX_SETTING_KEY, "false")
            .expect("setting should save");
        let native = AgentBackendConfig::builtin_codex_native();

        let err = ensure_backend_allowed_by_gate(&db, &native)
            .expect_err("native codex should be blocked while gate is off");
        assert!(err.contains("Codex is disabled"));
        assert!(err.contains("Settings → Models → Codex"));

        db.set_app_setting(NATIVE_CODEX_SETTING_KEY, "true")
            .expect("setting should save");
        ensure_backend_allowed_by_gate(&db, &native).expect("gate should allow native codex");
    }

    #[test]
    fn alternative_backends_can_still_be_disabled_without_codex() {
        let db = Database::open_in_memory().expect("test db should open");
        db.set_app_setting(FIRST_CLASS_BACKENDS_PROMOTION_KEY, "true")
            .expect("setting should save");
        db.set_app_setting(ALTERNATIVE_BACKENDS_SETTING_KEY, "false")
            .expect("setting should save");

        assert!(!alternative_backends_enabled(&db).expect("setting should load"));
    }

    #[test]
    fn legacy_codex_backend_settings_migrate_to_canonical_codex() {
        let db = Database::open_in_memory().expect("test db should open");
        db.set_app_setting("default_agent_backend", "experimental-codex")
            .expect("default should save");
        db.set_app_setting("model_provider:session-a", "codex-subscription")
            .expect("session provider should save");

        migrate_legacy_codex_backend_settings(&db).expect("migration should run");

        assert_eq!(
            db.get_app_setting("default_agent_backend")
                .expect("default should read")
                .as_deref(),
            Some("codex")
        );
        assert_eq!(
            db.get_app_setting("model_provider:session-a")
                .expect("provider should read")
                .as_deref(),
            Some("codex")
        );
    }
}
