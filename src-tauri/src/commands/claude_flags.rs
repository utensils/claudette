//! Tauri commands for the "Claude flags" Settings section. The Settings UI
//! reads the cached `claude --help` parse from `AppState`, then writes
//! per-flag enable/value state into the same `app_settings` table the rest
//! of Claudette persists user preferences in (see `claudette::claude_flags_store`).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::State;

use claudette::claude_flags_store::{
    self, FlagValue, clear_repo_override, set_global_flag, set_repo_override,
};
use claudette::claude_help::{ClaudeFlagDef, discover_claude_flags};
use claudette::db::Database;

use crate::state::{AppState, ClaudeFlagDiscovery};

/// Scope addressed by the flag-state read/write commands. Serialised as
/// `{ "kind": "global" }` or `{ "kind": "repo", "repoId": "..." }` so the
/// frontend can construct it with a TypeScript discriminated union.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FlagScope {
    Global,
    Repo {
        #[serde(rename = "repoId")]
        repo_id: String,
    },
}

/// Effective flag state for a scope. `repo` is populated only when the
/// caller asked for a repo scope, and contains only entries with the
/// `:override` sentinel set — so the UI knows which flags are actually
/// overridden vs inheriting global.
#[derive(Debug, Clone, Serialize)]
pub struct FlagStateResponse {
    pub global: HashMap<String, SerializedFlagValue>,
    pub repo: HashMap<String, SerializedFlagValue>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SerializedFlagValue {
    pub enabled: bool,
    pub value: Option<String>,
}

impl From<FlagValue> for SerializedFlagValue {
    fn from(v: FlagValue) -> Self {
        Self {
            enabled: v.enabled,
            value: v.value,
        }
    }
}

/// Return the cached `claude --help` parse. The UI calls this on mount;
/// while the boot-time discovery is still running we surface a transient
/// error so the UI shows a "loading" state, and on parse failure we
/// surface the upstream error verbatim for the Retry banner.
#[tauri::command]
pub async fn list_claude_flags(state: State<'_, AppState>) -> Result<Vec<ClaudeFlagDef>, String> {
    let guard = state.claude_flag_defs.read().await;
    match &*guard {
        ClaudeFlagDiscovery::Loading => Err("CLI flags still loading…".to_string()),
        ClaudeFlagDiscovery::Ok(defs) => Ok(defs.clone()),
        ClaudeFlagDiscovery::Err(msg) => Err(msg.clone()),
    }
}

/// Re-run discovery and update the cache. Wired to the Settings "Retry"
/// button; also useful after the user reinstalls / upgrades the `claude`
/// binary.
#[tauri::command]
pub async fn refresh_claude_flags(
    state: State<'_, AppState>,
) -> Result<Vec<ClaudeFlagDef>, String> {
    match discover_claude_flags().await {
        Ok(defs) => {
            let mut guard = state.claude_flag_defs.write().await;
            *guard = ClaudeFlagDiscovery::Ok(defs.clone());
            Ok(defs)
        }
        Err(msg) => {
            let mut guard = state.claude_flag_defs.write().await;
            *guard = ClaudeFlagDiscovery::Err(msg.clone());
            Err(msg)
        }
    }
}

/// Read effective flag state for the requested scope. Always includes the
/// global map (the UI shows it as the inherited fallback); the repo map
/// only contains explicit overrides.
#[tauri::command]
pub async fn get_claude_flag_state(
    state: State<'_, AppState>,
    scope: FlagScope,
) -> Result<FlagStateResponse, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let global = claude_flags_store::load_global(&db).map_err(|e| e.to_string())?;
    let repo = match &scope {
        FlagScope::Global => HashMap::new(),
        FlagScope::Repo { repo_id } => {
            claude_flags_store::load_repo_overrides(&db, repo_id).map_err(|e| e.to_string())?
        }
    };
    Ok(FlagStateResponse {
        global: global.into_iter().map(|(k, v)| (k, v.into())).collect(),
        repo: repo.into_iter().map(|(k, v)| (k, v.into())).collect(),
    })
}

/// Write enable/value state for one flag. For `Repo` scope, when the
/// caller is creating a brand-new override (no `:override` sentinel yet)
/// AND passed `value: None`, we seed the override with the current
/// effective global value — otherwise an empty text box at first-override
/// would silently clobber a non-empty global value the user assumed they
/// were keeping.
#[tauri::command]
pub async fn set_claude_flag_state(
    state: State<'_, AppState>,
    scope: FlagScope,
    name: String,
    enabled: bool,
    value: Option<String>,
) -> Result<(), String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    match scope {
        FlagScope::Global => {
            set_global_flag(&db, &name, enabled, value.as_deref()).map_err(|e| e.to_string())
        }
        FlagScope::Repo { repo_id } => {
            let seeded_value = if value.is_none() {
                let existing =
                    claude_flags_store::load_repo_overrides(&db, &repo_id).unwrap_or_default();
                if existing.contains_key(&name) {
                    None
                } else {
                    let global = claude_flags_store::load_global(&db).map_err(|e| e.to_string())?;
                    global.get(&name).and_then(|fv| fv.value.clone())
                }
            } else {
                value
            };
            set_repo_override(&db, &repo_id, &name, enabled, seeded_value.as_deref())
                .map_err(|e| e.to_string())
        }
    }
}

/// Drop the per-repo override entirely, so the flag inherits the global
/// value again.
#[tauri::command]
pub async fn clear_claude_flag_repo_override(
    state: State<'_, AppState>,
    repo_id: String,
    name: String,
) -> Result<(), String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    clear_repo_override(&db, &repo_id, &name).map_err(|e| e.to_string())
}
