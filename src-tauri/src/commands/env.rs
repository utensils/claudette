//! Tauri commands for the env-provider diagnostic UI.
//!
//! The env-provider system runs silently in the background — every
//! workspace spawn already gets the merged env without asking. These
//! commands expose read + reload surfaces so the UI can tell the user
//! *why* a variable is (or isn't) set, and let them force a
//! re-evaluation (e.g. after running `direnv allow`).
//!
//! Nothing here mutates the workspace or database state — reload just
//! evicts the in-memory cache, and the next spawn/resolve recomputes.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use claudette::db::Database;
use claudette::env_provider::EnvWatcher;
use claudette::plugin_runtime::host_api::WorkspaceInfo;
use claudette::plugin_runtime::manifest::PluginKind;

use crate::state::AppState;

/// Payload for the `env-cache-invalidated` Tauri event. The frontend's
/// EnvPanel subscribes to this and refetches when the worktree + plugin
/// match what it's currently displaying. Kept deliberately small so
/// routing logic on the JS side can be a string compare.
#[derive(Clone, Serialize)]
pub struct EnvCacheInvalidatedPayload {
    pub worktree_path: String,
    pub plugin_name: String,
}

/// Phase reported by the env-provider progress sink. Routed through
/// the `workspace_env_progress` Tauri event so every UI surface
/// (sidebar row, chat composer, terminal overlay) can render the same
/// loading state regardless of which workspace the user is viewing.
#[derive(Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EnvProgressPhase {
    Started,
    Finished,
    /// Emitted once after the resolve loop completes, regardless of
    /// which Tauri command kicked it off (`prepare_workspace_environment`,
    /// `spawn_pty`, agent spawn, EnvPanel reload, repo warmup). The
    /// frontend uses this as the authoritative "all plugins are done"
    /// signal so a stale "preparing" status set by an earlier
    /// `Started` event can be cleared even when the command's own
    /// response promise is dropped by WebView2 (the Windows IPC race
    /// that originally locked the new-terminal-tab + chat composer
    /// UI). Carries no plugin or ok field — pure terminator.
    Complete,
}

#[derive(Clone, Serialize)]
pub struct WorkspaceEnvProgressPayload {
    pub workspace_id: String,
    pub plugin: String,
    pub phase: EnvProgressPhase,
    /// Milliseconds since `started`. Zero on the `started` event so
    /// the UI can use it as the base for its own elapsed-time counter.
    pub elapsed_ms: u64,
    /// Set on `finished` only. `None` on `started`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ok: Option<bool>,
}

/// Bridge that turns `EnvProgressSink` callbacks into Tauri events.
/// Every Tauri-side env-resolve call site builds one of these so the
/// sidebar/composer/terminal loading state stays in sync across all
/// entry points (workspace creation, selection, agent spawn, PTY
/// spawn, env-panel reload).
///
/// The `workspace_id` baked in here is the same id the frontend's
/// Zustand store keys `workspaceEnvironment` by — the synthetic
/// `repo:{id}` form used by EnvPanel's repo-mode resolves is fine
/// because the JS side ignores progress for ids it isn't tracking.
pub struct TauriEnvProgressSink {
    app: AppHandle,
    workspace_id: String,
}

impl TauriEnvProgressSink {
    pub fn new(app: AppHandle, workspace_id: String) -> Self {
        Self { app, workspace_id }
    }
}

impl claudette::env_provider::EnvProgressSink for TauriEnvProgressSink {
    fn started(&self, plugin: &str) {
        let _ = self.app.emit(
            "workspace_env_progress",
            WorkspaceEnvProgressPayload {
                workspace_id: self.workspace_id.clone(),
                plugin: plugin.to_string(),
                phase: EnvProgressPhase::Started,
                elapsed_ms: 0,
                ok: None,
            },
        );
    }
    fn finished(&self, plugin: &str, ok: bool, elapsed: std::time::Duration) {
        let _ = self.app.emit(
            "workspace_env_progress",
            WorkspaceEnvProgressPayload {
                workspace_id: self.workspace_id.clone(),
                plugin: plugin.to_string(),
                phase: EnvProgressPhase::Finished,
                elapsed_ms: elapsed.as_millis() as u64,
                ok: Some(ok),
            },
        );
    }
}

/// Emit a `Complete` event whenever the sink is dropped. This is the
/// authoritative terminator for the workspace's progress stream — fires
/// after the resolve loop returns regardless of which command owned
/// the sink and regardless of whether that command's Tauri response
/// makes it back across the WebView2 IPC bridge.
///
/// Without this terminator, the symptom on Windows was: clicking the
/// terminal new-tab button triggered a `spawn_pty` whose own env
/// resolve emitted `Started`/`Finished` events that flipped the
/// workspace's `workspaceEnvironment` slice to `"preparing"`, but no
/// caller-side path then set it back to `"ready"` (the `+` click
/// doesn't go through the dedicated `prepare_workspace_environment`
/// command, so no `.then` fires on the JS side). The user stayed
/// locked at "preparing" with no recovery.
impl Drop for TauriEnvProgressSink {
    fn drop(&mut self) {
        let _ = self.app.emit(
            "workspace_env_progress",
            WorkspaceEnvProgressPayload {
                workspace_id: self.workspace_id.clone(),
                plugin: String::new(),
                phase: EnvProgressPhase::Complete,
                elapsed_ms: 0,
                ok: None,
            },
        );
    }
}

/// App-settings key for "is this env-provider enabled for this repo?".
/// Default (absent key) is enabled. `"false"` disables.
fn enabled_key(repo_id: &str, plugin_name: &str) -> String {
    format!("repo:{repo_id}:env_provider:{plugin_name}:enabled")
}

/// Load the set of env-provider plugin names that have been explicitly
/// disabled for a repo. Absent settings = enabled (default), so the
/// returned set contains only names with the setting set to `"false"`.
pub(crate) fn load_disabled_providers(db: &Database, repo_id: &str) -> HashSet<String> {
    // We list all app settings with the repo+env_provider prefix.
    // Pattern is precise; rusqlite does this cheaply via LIKE.
    let prefix = format!("repo:{repo_id}:env_provider:");
    db.list_app_settings_with_prefix(&prefix)
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(key, value)| {
            if value == "false" {
                // key = "repo:{repo_id}:env_provider:{plugin_name}:enabled"
                let rest = key.strip_prefix(&prefix)?;
                let plugin_name = rest.strip_suffix(":enabled")?;
                Some(plugin_name.to_string())
            } else {
                None
            }
        })
        .collect()
}

/// Strip sources whose plugin is globally disabled in the Plugins
/// settings section. The env panel is a per-repo/per-workspace view —
/// surfacing globally-off plugins there is noise (they're managed
/// elsewhere and won't run regardless), and showing them with the
/// `error: "disabled"` marker was being rendered as a confusing ERROR
/// badge. Resolution still runs them through `resolve_with_registry`
/// upstream (the dispatcher needs to record them for cache
/// invalidation), so we filter at the UI boundary only.
pub(crate) fn filter_globally_disabled(
    sources: Vec<claudette::env_provider::ResolvedSource>,
    is_globally_disabled: impl Fn(&str) -> bool,
) -> Vec<claudette::env_provider::ResolvedSource> {
    sources
        .into_iter()
        .filter(|s| !is_globally_disabled(&s.plugin_name))
        .collect()
}

/// Snapshot of one plugin's contribution for a workspace.
///
/// Mirrors [`claudette::env_provider::ResolvedSource`] but uses
/// serializable timestamps (ms since epoch) since `SystemTime` isn't
/// directly serde-friendly across the IPC boundary.
#[derive(Serialize)]
pub struct EnvSourceInfo {
    pub plugin_name: String,
    pub display_name: String,
    pub detected: bool,
    pub enabled: bool,
    /// True when the plugin's required CLI (e.g. `nix`, `mise`,
    /// `direnv`) is not on PATH. The dispatcher records this via the
    /// "unavailable" error marker; we surface it as a dedicated flag
    /// so the EnvPanel can render a distinct "not installed" badge
    /// (with the toggle disabled) rather than the generic error
    /// treatment. See issue #718.
    pub unavailable: bool,
    pub vars_contributed: usize,
    pub cached: bool,
    /// Milliseconds since the Unix epoch. Frontend formats this
    /// relative to `Date.now()` ("evaluated 3s ago").
    pub evaluated_at_ms: u128,
    pub error: Option<String>,
}

/// Identifies what to resolve env for. `Repo` resolves against the
/// repository's main checkout (useful before any workspace exists);
/// `Workspace` resolves against the workspace's worktree (existing
/// behavior). Per-provider toggles persist at repo scope, so both
/// targets under the same repo share their enable/disable state.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum EnvTarget {
    Repo { repo_id: String },
    Workspace { workspace_id: String },
}

/// Resolve the worktree path for an [`EnvTarget`]. Used by the
/// EnvPanel to filter `env-cache-invalidated` events to its current
/// target — without it, any watched file change in any repo refreshes
/// every open Environment panel, re-running direnv/nix unnecessarily.
#[tauri::command]
pub async fn get_env_target_worktree(
    target: EnvTarget,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let (worktree, _, _) = resolve_target(&state, &target).await?;
    Ok(worktree)
}

/// Return the list of env-provider plugins that ran (or would run) for
/// this target, along with how many vars each contributed and whether
/// the result is cached.
///
/// Side effect: this triggers a full `resolve_for_workspace` pass,
/// which respects the mtime cache — so repeated calls during a quiet
/// period are cheap.
#[tauri::command]
pub async fn get_env_sources(
    target: EnvTarget,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<EnvSourceInfo>, String> {
    let (worktree, ws_info, repo_id) = resolve_target(&state, &target).await?;
    let disabled = {
        let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
        load_disabled_providers(&db, &repo_id)
    };
    // Snapshot the registry so the read lock is released before we
    // start awaiting — env resolves can take ~120s on cold direnv/Nix
    // and would otherwise block the Plugins settings page from loading.
    let registry = state.plugins_snapshot().await;
    // Look up display_name for each plugin from the registry so the UI
    // shows "direnv" instead of the internal "env-direnv" name.
    let display_names: std::collections::HashMap<String, String> = registry
        .plugins
        .iter()
        .map(|(name, p)| (name.clone(), p.manifest.display_name.clone()))
        .collect();
    let progress = TauriEnvProgressSink::new(app, ws_info.id.clone());
    let resolved = claudette::env_provider::resolve_with_registry_and_progress(
        &registry,
        &state.env_cache,
        Path::new(&worktree),
        &ws_info,
        &disabled,
        Some(&progress),
    )
    .await;

    // Subscribe the fs watcher to every freshly-cached plugin's
    // watched paths. Must happen BEFORE `filter_globally_disabled`
    // moves `resolved.sources` — we want to register even hidden
    // sources so backing invalidation stays correct.
    register_resolved_with_watcher(&state, Path::new(&worktree), &resolved.sources).await;

    let visible = filter_globally_disabled(resolved.sources, |name| registry.is_disabled(name));
    let sources = visible
        .into_iter()
        .map(|s| {
            let display_name = display_names
                .get(&s.plugin_name)
                .cloned()
                .unwrap_or_else(|| s.plugin_name.clone());
            let enabled = !disabled.contains(&s.plugin_name);
            // The dispatcher writes `error: Some("unavailable")` to
            // signal "required CLI isn't on PATH". Promote that to a
            // dedicated flag and clear the error string so the UI
            // doesn't render it as a generic provider failure — and
            // the EnvPanel can disable the toggle with a clear
            // "Install <cli> to enable" hint instead. See issue #718.
            let unavailable = s.error.as_deref() == Some("unavailable");
            let error = if unavailable { None } else { s.error };
            EnvSourceInfo {
                plugin_name: s.plugin_name,
                display_name,
                detected: s.detected,
                enabled,
                unavailable,
                vars_contributed: s.vars_contributed,
                cached: s.cached,
                evaluated_at_ms: s
                    .evaluated_at
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0),
                error,
            }
        })
        .collect();
    Ok(sources)
}

fn source_error_summary(source: &claudette::env_provider::ResolvedSource) -> String {
    format!(
        "{}: {}",
        source.plugin_name,
        source.error.as_deref().unwrap_or("unknown error")
    )
}

/// Per-plugin entry in [`WorkspaceEnvTrustNeededPayload`]. Carries
/// just enough for the frontend modal to render a row and route the
/// Trust / Disable buttons through the existing `run_env_trust` and
/// `set_env_provider_enabled` commands without re-querying.
#[derive(Clone, Serialize)]
pub struct TrustNeededEntry {
    pub plugin_name: String,
    /// One-line human-readable summary of *why* the provider failed,
    /// e.g. "mise.toml is not trusted." or ".envrc is blocked." Built
    /// by [`clean_trust_error_excerpt`] from the raw plugin stderr so
    /// the modal renders a presentable line instead of the Lua-wrapped
    /// dump that ships up from `host.exec`.
    pub message: String,
    /// Absolute path to the offending config file, if we could parse
    /// it out of the stderr. Surfaced as a sub-label so the user can
    /// see exactly which mise.toml / .envrc is being trusted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_path: Option<String>,
    /// Original stderr / error text the plugin propagated up,
    /// truncated to a reasonable size. Hidden behind a "Show details"
    /// disclosure in the modal — useful for diagnosing a wedge where
    /// the cleaner doesn't recognize a new error variant.
    pub error_excerpt: String,
}

/// Payload for the `workspace_env_trust_needed` Tauri event. Emitted
/// once per [`prepare_workspace_environment`] call that detected at
/// least one trust-error source. The frontend opens the EnvTrustModal
/// on receipt; the toast path is bypassed for trust-only failures so
/// the user isn't double-prompted.
#[derive(Clone, Serialize)]
pub struct WorkspaceEnvTrustNeededPayload {
    pub workspace_id: String,
    pub repo_id: String,
    pub plugins: Vec<TrustNeededEntry>,
}

/// Single-shot UTF-8-safe truncation used to keep stderr excerpts
/// short enough to embed in the modal payload without dumping
/// multi-screen mise/direnv diagnostics over IPC.
fn truncate_excerpt(error: &str, max_bytes: usize) -> String {
    let trimmed = error.trim_end();
    if trimmed.len() <= max_bytes {
        return trimmed.to_string();
    }
    let mut cut = max_bytes;
    while cut > 0 && !trimmed.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}…", &trimmed[..cut])
}

/// Result of cleaning a raw plugin trust error for display.
struct CleanedTrustError {
    message: String,
    config_path: Option<String>,
}

/// Strip the mlua `runtime error: [string "<plugin path>"]:<line>:`
/// call-frame prefix (and the optional outer `export: Plugin script
/// error: ` dispatcher wrapper) from a propagated Lua error. The
/// remaining text is whatever string the plugin actually passed to
/// `error()`. Tolerates either prefix being absent so this works on
/// any error string — plain stderr passes through unchanged.
fn strip_lua_wrapper(raw: &str) -> &str {
    let s = raw
        .strip_prefix("export: ")
        .unwrap_or(raw)
        .strip_prefix("Plugin script error: ")
        .unwrap_or_else(|| raw.strip_prefix("export: ").unwrap_or(raw));
    // After the outer wrapper, mlua surfaces:
    //   runtime error: [string "<path>"]:<N>: <inner>
    // We want just `<inner>`. The `]:N: ` segment varies (line number
    // is dynamic), so find the closing `"]:` then skip to the next
    // ": " which terminates the line-number suffix.
    let after_runtime = s.strip_prefix("runtime error: ").unwrap_or(s);
    if let Some(bracket_end) = after_runtime.find("\"]:") {
        let after_bracket = &after_runtime[bracket_end + 3..];
        // Skip `<digits>: ` — find the first ": " after the digits.
        if let Some(colon_space) = after_bracket.find(": ") {
            return &after_bracket[colon_space + 2..];
        }
    }
    after_runtime
}

/// Strip the Lua-runtime wrapper, deduplicate path mentions, and drop
/// `--verbose` hint footers from a plugin's trust-error stderr so the
/// modal can show a presentable one-liner instead of a multi-line
/// dump. Per plugin so we can recognize the actual error shape:
///
/// **mise** stderr looks like:
/// ```text
/// export: Plugin script error: runtime error: [string "plugins/env-mise/init.lua"]:52: mise env failed: mise ERROR error parsing config file: ~/...mise.toml
/// mise ERROR Config files in ~/...mise.toml are not trusted. Trust them with `mise trust`. See https://...
/// mise ERROR Run with --verbose or MISE_VERBOSE=1 for more information
/// ```
///
/// **direnv** stderr looks like:
/// ```text
/// direnv: error /repo/.envrc is blocked. Run `direnv allow` to approve its content
/// ```
fn clean_trust_error_excerpt(plugin_name: &str, raw: &str) -> CleanedTrustError {
    // Drop the Lua-runtime wrapper. mlua surfaces a Lua-side
    // `error("...")` as the string
    //   `runtime error: [string "<plugin path>"]:<line>: <inner>`
    // optionally prefixed by `export: Plugin script error: ` from the
    // env-provider dispatcher. The two bundled plugins also used to
    // prefix the inner with `"mise env failed: " / "direnv export
    // failed: "` before the Lua tightening landed; we still strip
    // both prefixes for back-compat with any in-flight stderr that
    // crossed plugin versions during an upgrade.
    let body = strip_lua_wrapper(raw);
    let body = body
        .split_once("mise env failed: ")
        .map(|(_, rest)| rest)
        .or_else(|| {
            body.split_once("direnv export failed: ")
                .map(|(_, rest)| rest)
        })
        .unwrap_or(body);

    match plugin_name {
        "env-mise" => clean_mise(body),
        "env-direnv" => clean_direnv(body),
        _ => CleanedTrustError {
            // Unknown plugin shape — leave the body as-is but capped
            // to a single line so the modal still gets one summary
            // line. The full stderr is still available via the
            // disclosure.
            message: body.lines().next().unwrap_or(body).trim().to_string(),
            config_path: None,
        },
    }
}

/// Extract the basename of a parsed config path for display in the
/// modal headline. Splits on BOTH `/` and `\` so a Windows path like
/// `C:\Users\…\mise.toml` produces `mise.toml`, not the whole path.
/// `std::path::Path::file_name()` would also work on Windows but only
/// because the runtime path separator is `\` there — using it on a
/// Linux build against a Windows string still misclassifies. Manual
/// split-on-either is platform-independent and matches what mise /
/// direnv print.
fn basename(path: &str) -> Option<&str> {
    path.rsplit(|c: char| c == '/' || c == '\\')
        .next()
        .filter(|s| !s.is_empty())
}

/// Extract the path + a clean "X is not trusted" headline from mise's
/// "Config files in <path> are not trusted" line. Falls back to the
/// generic stderr-first-line behavior if the expected phrase isn't
/// present (e.g. mise changed its error format).
fn clean_mise(body: &str) -> CleanedTrustError {
    for line in body.lines() {
        let line = line.trim().trim_start_matches("mise ERROR").trim();
        if let Some(rest) = line.strip_prefix("Config files in ") {
            // " <path> are not trusted. Trust them with `mise trust`. See https://..."
            if let Some(end) = rest.find(" are not trusted") {
                let path = rest[..end].trim().to_string();
                let filename = basename(&path).unwrap_or("mise.toml");
                return CleanedTrustError {
                    message: format!("{filename} is not trusted."),
                    config_path: Some(path),
                };
            }
        }
    }
    CleanedTrustError {
        message: body
            .lines()
            .map(|l| l.trim().trim_start_matches("mise ERROR").trim())
            .find(|l| !l.is_empty() && !l.starts_with("Run with"))
            .unwrap_or("mise config is not trusted.")
            .to_string(),
        config_path: None,
    }
}

/// Extract the .envrc path + a clean "is blocked" headline from
/// direnv's "error <path> is blocked" line.
fn clean_direnv(body: &str) -> CleanedTrustError {
    for line in body.lines() {
        // direnv prefixes everything with `direnv: ` — strip it for the
        // headline so the line reads cleanly.
        let line = line
            .trim()
            .strip_prefix("direnv: ")
            .unwrap_or_else(|| line.trim());
        if let Some(rest) = line.strip_prefix("error ") {
            // "<path> is blocked. Run `direnv allow` ..."
            if let Some(end) = rest.find(" is blocked") {
                let path = rest[..end].trim().to_string();
                let filename = basename(&path).unwrap_or(".envrc");
                return CleanedTrustError {
                    message: format!("{filename} is blocked."),
                    config_path: Some(path),
                };
            }
        }
    }
    CleanedTrustError {
        message: body
            .lines()
            .next()
            .unwrap_or(".envrc is blocked.")
            .trim()
            .to_string(),
        config_path: None,
    }
}

/// Build the trust-needed event payload from a resolved env, returning
/// `None` when no source flagged a trust error. Pure — extracted so the
/// command site stays small and the unit tests can assert payload
/// shape without a Tauri AppHandle.
fn build_trust_needed_payload(
    workspace_id: &str,
    repo_id: &str,
    resolved: &claudette::env_provider::ResolvedEnv,
) -> Option<WorkspaceEnvTrustNeededPayload> {
    let trust_errors = resolved.trust_errors();
    if trust_errors.is_empty() {
        return None;
    }
    let plugins = trust_errors
        .into_iter()
        .map(|src| {
            let raw = src.error.as_deref().unwrap_or("");
            let cleaned = clean_trust_error_excerpt(&src.plugin_name, raw);
            TrustNeededEntry {
                plugin_name: src.plugin_name.clone(),
                message: cleaned.message,
                config_path: cleaned.config_path,
                error_excerpt: truncate_excerpt(raw, 1200),
            }
        })
        .collect();
    Some(WorkspaceEnvTrustNeededPayload {
        workspace_id: workspace_id.to_string(),
        repo_id: repo_id.to_string(),
        plugins,
    })
}

/// Build a toast message string for non-trust provider errors only.
/// Trust errors are intentionally excluded — they're routed through the
/// `workspace_env_trust_needed` event + modal instead so the user isn't
/// double-prompted. Returns `None` when there's nothing toast-worthy
/// (clean resolve, or only trust/disabled/unavailable sources).
///
/// "disabled" = user toggled it off (per-repo or globally).
/// "unavailable" = required CLI not on PATH; bundled env-providers
/// ship for everyone, so most users won't have all of nix/mise/
/// direnv installed and that is not a user-actionable error
/// (issue #718). Both are silent skips at the toast layer.
fn prepare_workspace_error(resolved: &claudette::env_provider::ResolvedEnv) -> Option<String> {
    let summaries = resolved
        .sources
        .iter()
        .filter(|source| {
            source.error.as_deref().is_some_and(|error| {
                error != "disabled"
                    && error != "unavailable"
                    && !claudette::env_provider::is_trust_error_str(error)
            })
        })
        .map(source_error_summary)
        .collect::<Vec<_>>();
    if summaries.is_empty() {
        None
    } else {
        Some(format!(
            "Environment provider failed: {}",
            summaries.join("; ")
        ))
    }
}

/// Resolve env-providers for a workspace before the user can start a fresh
/// agent process or terminal PTY.
///
/// When at least one source reports a trust-class error (mise / direnv
/// config not yet allowed for this worktree), the
/// `workspace_env_trust_needed` Tauri event is emitted carrying the
/// repo id, workspace id, and per-plugin error excerpts so the
/// frontend's `EnvTrustModal` can prompt the user without a toast. Any
/// non-trust failures still surface via the `Err` return so the
/// existing toast path stays unchanged for those cases.
#[tauri::command]
pub async fn prepare_workspace_environment(
    workspace_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let target = EnvTarget::Workspace { workspace_id };
    let (worktree, ws_info, repo_id) = resolve_target(&state, &target).await?;
    let disabled = {
        let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
        load_disabled_providers(&db, &repo_id)
    };
    // Snapshot — see `plugins_snapshot` doc; this command can run
    // ~120s on cold env-providers and must not stall the Plugins UI.
    let registry = state.plugins_snapshot().await;
    let progress = TauriEnvProgressSink::new(app.clone(), ws_info.id.clone());
    let resolved = claudette::env_provider::resolve_with_registry_and_progress(
        &registry,
        &state.env_cache,
        Path::new(&worktree),
        &ws_info,
        &disabled,
        Some(&progress),
    )
    .await;
    register_resolved_with_watcher(&state, Path::new(&worktree), &resolved.sources).await;
    if let Some(payload) = build_trust_needed_payload(&ws_info.id, &repo_id, &resolved) {
        // Best-effort: the emit can fail if the Tauri app handle is
        // shutting down, but we still want to fall through and surface
        // any non-trust errors below.
        let _ = app.emit("workspace_env_trust_needed", payload);
    }
    if let Some(error) = prepare_workspace_error(&resolved) {
        return Err(error);
    }
    Ok(())
}

/// Toggle whether an env-provider plugin runs for the target's repo.
/// The toggle is persisted per-repo, so the change applies to every
/// worktree under that repo. This evicts the cache for the repo's
/// main checkout AND every workspace worktree beneath it so the next
/// spawn in any of them reflects the new state immediately.
#[tauri::command]
pub async fn set_env_provider_enabled(
    target: EnvTarget,
    plugin_name: String,
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (_, _, repo_id) = resolve_target(&state, &target).await?;
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let key = enabled_key(&repo_id, &plugin_name);
    // We persist only the "disabled" case; absent key = enabled (default).
    if enabled {
        db.delete_app_setting(&key).map_err(|e| e.to_string())?;
    } else {
        db.set_app_setting(&key, "false")
            .map_err(|e| e.to_string())?;
    }
    // Per-repo setting → fan-out cache eviction across the repo's main
    // checkout + every workspace worktree. Re-enabling forces a fresh
    // eval on next resolve; disabling stops a stale cached value from
    // being applied.
    for path in repo_worktree_paths(&db, &repo_id) {
        state
            .env_cache
            .invalidate(Path::new(&path), Some(&plugin_name));
    }
    Ok(())
}

/// Every on-disk worktree path associated with a repo: the main
/// checkout plus each workspace.worktree_path. Silently drops
/// database errors — if we can't list workspaces, we just invalidate
/// what we can (or nothing), and stale cache entries will expire on
/// the next mtime change anyway.
fn repo_worktree_paths(db: &Database, repo_id: &str) -> Vec<String> {
    let Ok(Some(repo)) = db.get_repository(repo_id) else {
        return Vec::new();
    };
    let mut paths = vec![repo.path.clone()];
    if let Ok(workspaces) = db.list_workspaces() {
        for ws in workspaces {
            if ws.repository_id == repo_id
                && let Some(wt) = ws.worktree_path
                && wt != repo.path
            {
                paths.push(wt);
            }
        }
    }
    paths
}

/// Evict the env-provider cache for the target, forcing a fresh
/// `export` call on the next spawn / diagnostic query.
///
/// If `plugin_name` is provided, only that plugin's cache entry is
/// dropped. Otherwise every plugin's entry for this worktree is
/// dropped.
#[tauri::command]
pub async fn reload_env(
    target: EnvTarget,
    plugin_name: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let (worktree, _, _) = resolve_target(&state, &target).await?;
    state
        .env_cache
        .invalidate(Path::new(&worktree), plugin_name.as_deref());
    Ok(())
}

/// Env-provider CLI trust/state pass-through. direnv and mise look
/// up their trust cache under XDG_*_HOME (falling back to $HOME-based
/// defaults), and some users point those at non-default locations.
/// `host_exec`'s env-provider hermetic path and `run_env_trust` must
/// both preserve these vars so what Claudette reads/writes matches
/// what the user's terminal sees.
const ENV_PROVIDER_PASSTHROUGH_KEYS: &[&str] = &[
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TERM",
    "LANG",
    "LC_ALL",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
];

/// Run a plugin's trust command (`direnv allow`, `mise trust`) in the
/// target's worktree directory. Hard-coded dispatch by plugin name so
/// a malicious plugin manifest can't declare arbitrary commands for
/// us to auto-run.
///
/// direnv and mise hash the target path into their allow-cache keys,
/// so a single approval doesn't cover sibling worktrees. When the
/// target is a repo (from `RepoSettings`), we fan out: run the
/// command in the repo's main checkout AND every existing workspace
/// worktree under it. That way one click blesses every path the
/// agent, setup script, or PTY will actually spawn in.
#[tauri::command]
pub async fn run_env_trust(
    target: EnvTarget,
    plugin_name: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let cmd: &[&str] = match plugin_name.as_str() {
        "env-direnv" => &["direnv", "allow"],
        "env-mise" => &["mise", "trust"],
        _ => return Err(format!("no trust command defined for '{plugin_name}'")),
    };

    // Collect every path we need to approve. For a Workspace target
    // it's just that workspace. For a Repo target it's repo.path +
    // every workspace.worktree_path that exists for that repo.
    let scope = resolve_trust_scope(&state, &target).await?;
    if scope.paths.is_empty() {
        return Err("no worktrees to run trust against".to_string());
    }

    let mut errors: Vec<String> = Vec::new();
    let mut approved_envrc_sha256s: Vec<String> = Vec::new();
    for path in &scope.paths {
        let mut command = tokio::process::Command::new(cmd[0]);
        command.args(&cmd[1..]);
        command.current_dir(path);
        command.env("PATH", claudette::env::enriched_path());
        for key in ENV_PROVIDER_PASSTHROUGH_KEYS {
            if let Ok(val) = std::env::var(key) {
                command.env(key, val);
            }
        }

        let output = command
            .output()
            .await
            .map_err(|e| format!("failed to spawn {}: {e}", cmd[0]))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            errors.push(format!(
                "{}: {} failed: {}",
                path,
                cmd.join(" "),
                stderr.trim()
            ));
            continue;
        }

        // Trust state changed → evict this path's cache entry so the
        // next resolve re-runs export with the now-allowed config.
        state
            .env_cache
            .invalidate(Path::new(path), Some(&plugin_name));

        if plugin_name == "env-direnv" {
            let envrc = Path::new(path).join(".envrc");
            if let Ok(digest) = sha256_file_hex(&envrc) {
                approved_envrc_sha256s.push(digest);
            }
        }
    }

    if plugin_name == "env-direnv" && !approved_envrc_sha256s.is_empty() {
        persist_approved_envrc_sha256s(&state, &scope.repo_id, approved_envrc_sha256s).await?;
    }

    if !errors.is_empty() && errors.len() == scope.paths.len() {
        return Err(errors.join("; "));
    }
    // Partial success is fine — the caller's refresh will show which
    // paths are now trusted and which still need attention.
    Ok(())
}

struct TrustScope {
    repo_id: String,
    paths: Vec<String>,
}

/// Gather every on-disk path we should run the trust command against.
/// `Workspace` → the workspace's worktree. `Repo` → repo.path plus
/// every workspace.worktree_path that currently exists for the repo.
async fn resolve_trust_scope(state: &AppState, target: &EnvTarget) -> Result<TrustScope, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    match target {
        EnvTarget::Workspace { workspace_id } => {
            let ws = db
                .list_workspaces()
                .map_err(|e| e.to_string())?
                .into_iter()
                .find(|w| w.id == *workspace_id)
                .ok_or("Workspace not found")?;
            let worktree = ws
                .worktree_path
                .clone()
                .ok_or("Workspace has no worktree")?;
            Ok(TrustScope {
                repo_id: ws.repository_id,
                paths: vec![worktree],
            })
        }
        EnvTarget::Repo { repo_id } => {
            let repo = db
                .get_repository(repo_id)
                .map_err(|e| e.to_string())?
                .ok_or("Repository not found")?;
            let mut paths = vec![repo.path.clone()];
            let workspaces = db.list_workspaces().map_err(|e| e.to_string())?;
            for ws in workspaces {
                if ws.repository_id == *repo_id
                    && let Some(wt) = ws.worktree_path
                    && wt != repo.path
                {
                    paths.push(wt);
                }
            }
            Ok(TrustScope {
                repo_id: repo_id.clone(),
                paths,
            })
        }
    }
}

const APPROVED_ENVRC_SHA256S_KEY: &str = "approved_envrc_sha256s";
const TRUST_PROBE_DEBOUNCE_MS: u64 = 500;

fn sha256_file_hex(path: &Path) -> std::io::Result<String> {
    use sha2::{Digest, Sha256};

    let bytes = std::fs::read(path)?;
    let digest = Sha256::digest(&bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{byte:02x}");
    }
    Ok(out)
}

async fn persist_approved_envrc_sha256s(
    state: &AppState,
    repo_id: &str,
    new_digests: Vec<String>,
) -> Result<(), String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let storage_key =
        format!("repo:{repo_id}:plugin:env-direnv:setting:{APPROVED_ENVRC_SHA256S_KEY}");
    let mut merged: Vec<String> = db
        .get_app_setting(&storage_key)
        .map_err(|e| e.to_string())?
        .and_then(|stored| serde_json::from_str::<Vec<String>>(&stored).ok())
        .unwrap_or_default();
    merged = merge_approved_envrc_sha256s(merged, new_digests);

    let value = serde_json::json!(merged);
    let serialized = serde_json::to_string(&value).map_err(|e| e.to_string())?;
    db.set_app_setting(&storage_key, &serialized)
        .map_err(|e| e.to_string())?;
    drop(db);
    state.plugins.read().await.set_repo_setting(
        repo_id,
        "env-direnv",
        APPROVED_ENVRC_SHA256S_KEY,
        Some(value),
    );
    state.env_cache.invalidate_plugin_everywhere("env-direnv");
    Ok(())
}

fn merge_approved_envrc_sha256s(
    mut existing: Vec<String>,
    new_digests: Vec<String>,
) -> Vec<String> {
    for digest in new_digests {
        if !existing.iter().any(|old| old == &digest) {
            existing.push(digest);
        }
    }
    existing.sort();
    existing.dedup();
    existing
}

type EnvResolveTarget = (String, WorkspaceInfo, String);

fn workspace_info_for_repo(repo: claudette::model::Repository) -> EnvResolveTarget {
    let ws_info = WorkspaceInfo {
        id: format!("repo:{}", repo.id),
        name: repo.name.clone(),
        branch: String::new(),
        worktree_path: repo.path.clone(),
        repo_path: repo.path.clone(),
        repo_id: Some(repo.id.clone()),
    };
    (repo.path, ws_info, repo.id)
}

fn resolve_target_from_db(db: &Database, target: &EnvTarget) -> Result<EnvResolveTarget, String> {
    match target {
        EnvTarget::Workspace { workspace_id } => {
            let ws = db
                .list_workspaces()
                .map_err(|e| e.to_string())?
                .into_iter()
                .find(|w| w.id == *workspace_id)
                .ok_or("Workspace not found")?;
            let worktree = ws
                .worktree_path
                .clone()
                .ok_or("Workspace has no worktree")?;
            let repo = db
                .get_repository(&ws.repository_id)
                .map_err(|e| e.to_string())?
                .ok_or("Repository not found")?;
            let repo_id = ws.repository_id.clone();
            let ws_info = WorkspaceInfo {
                id: ws.id.clone(),
                name: ws.name.clone(),
                branch: ws.branch_name.clone(),
                worktree_path: worktree.clone(),
                repo_path: repo.path,
                repo_id: Some(repo_id.clone()),
            };
            Ok((worktree, ws_info, repo_id))
        }
        EnvTarget::Repo { repo_id } => {
            let repo = db
                .get_repository(repo_id)
                .map_err(|e| e.to_string())?
                .ok_or("Repository not found")?;
            // The repo's main checkout IS a git worktree — safe to
            // use as a resolution target. Synthetic WorkspaceInfo
            // uses "repo:{id}" as id (guaranteed not to collide with
            // any real workspace id) and an empty branch string
            // (none of our plugins consume `args.branch`).
            Ok(workspace_info_for_repo(repo))
        }
    }
}

fn resolve_worktree_target_from_db(
    db: &Database,
    worktree: &Path,
) -> Result<Option<EnvResolveTarget>, String> {
    let worktree = worktree.to_string_lossy();
    if let Some(ws) = db
        .list_workspaces()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|w| w.worktree_path.as_deref() == Some(worktree.as_ref()))
    {
        let repo = db
            .get_repository(&ws.repository_id)
            .map_err(|e| e.to_string())?
            .ok_or("Repository not found")?;
        let worktree_path = ws
            .worktree_path
            .clone()
            .ok_or("Workspace has no worktree")?;
        let repo_id = ws.repository_id.clone();
        let ws_info = WorkspaceInfo {
            id: ws.id.clone(),
            name: ws.name.clone(),
            branch: ws.branch_name.clone(),
            worktree_path: worktree_path.clone(),
            repo_path: repo.path,
            repo_id: Some(repo_id.clone()),
        };
        return Ok(Some((worktree_path, ws_info, repo_id)));
    }

    let repo = db
        .list_repositories()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|repo| repo.path == worktree.as_ref());
    Ok(repo.map(workspace_info_for_repo))
}

/// Build a [`WorkspaceInfo`] for the given target, returning
/// `(worktree_path, ws_info, repo_id)`.
async fn resolve_target(state: &AppState, target: &EnvTarget) -> Result<EnvResolveTarget, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    resolve_target_from_db(&db, target)
}

async fn maybe_emit_trust_needed_for_changed_env(
    app: AppHandle,
    worktree: String,
    plugin_name: String,
) {
    let state = app.state::<AppState>();
    let target = {
        let db = match Database::open(&state.db_path) {
            Ok(db) => db,
            Err(err) => {
                tracing::warn!(
                    target: "claudette::env-watcher",
                    error = %err,
                    "failed to open database after env invalidation"
                );
                return;
            }
        };
        let Some((worktree, ws_info, repo_id)) =
            (match resolve_worktree_target_from_db(&db, Path::new(&worktree)) {
                Ok(target) => target,
                Err(err) => {
                    tracing::warn!(
                        target: "claudette::env-watcher",
                        error = %err,
                        "failed to map changed env path to a workspace"
                    );
                    return;
                }
            })
        else {
            tracing::debug!(
                target: "claudette::env-watcher",
                worktree,
                plugin = plugin_name,
                "ignoring env invalidation for unknown worktree"
            );
            return;
        };
        let disabled = load_disabled_providers(&db, &repo_id);
        (worktree, ws_info, repo_id, disabled)
    };

    let (worktree, ws_info, repo_id, mut disabled) = target;
    let registry = state.plugins_snapshot().await;
    for (name, plugin) in &registry.plugins {
        if plugin.manifest.kind == PluginKind::EnvProvider && name != &plugin_name {
            disabled.insert(name.clone());
        }
    }
    let resolved = claudette::env_provider::resolve_with_registry_and_progress(
        &registry,
        &state.env_cache,
        Path::new(&worktree),
        &ws_info,
        &disabled,
        None,
    )
    .await;
    register_resolved_with_watcher(&state, Path::new(&worktree), &resolved.sources).await;
    if let Some(payload) = build_trust_needed_payload(&ws_info.id, &repo_id, &resolved) {
        let _ = app.emit("workspace_env_trust_needed", payload);
    }
}

fn should_probe_trust_after_invalidation(plugin_name: &str) -> bool {
    matches!(plugin_name, "env-direnv" | "env-mise")
}

/// Build the `EnvWatcher` and store it in `AppState`. Called once at
/// Tauri setup time. The change callback invalidates the cache entry
/// and emits `env-cache-invalidated` so any live UI can refetch. On
/// construction failure (rare — usually Linux inotify limits) we log
/// and leave `env_watcher = None`, which means reactive invalidation
/// is disabled but lazy mtime invalidation still works.
pub fn setup_env_watcher(app: AppHandle) {
    let state = app.state::<AppState>();
    let cache = Arc::clone(&state.env_cache);
    let app_for_cb = app.clone();
    let trust_probe_versions: Arc<Mutex<HashMap<(String, String), u64>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let watcher = match EnvWatcher::new(Arc::new(move |worktree, plugin| {
        cache.invalidate(worktree, Some(plugin));
        let worktree_path = worktree.to_string_lossy().into_owned();
        let plugin_name = plugin.to_string();
        let _ = app_for_cb.emit(
            "env-cache-invalidated",
            EnvCacheInvalidatedPayload {
                worktree_path: worktree_path.clone(),
                plugin_name: plugin_name.clone(),
            },
        );
        if !should_probe_trust_after_invalidation(&plugin_name) {
            return;
        }
        let key = (worktree_path.clone(), plugin_name.clone());
        let scheduled_version = {
            let mut versions = trust_probe_versions.lock().unwrap();
            let next = versions
                .get(&key)
                .copied()
                .unwrap_or_default()
                .wrapping_add(1);
            versions.insert(key.clone(), next);
            next
        };
        let app_for_check = app_for_cb.clone();
        let versions_for_check = Arc::clone(&trust_probe_versions);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(TRUST_PROBE_DEBOUNCE_MS)).await;
            let should_run = {
                let mut versions = versions_for_check.lock().unwrap();
                if versions.get(&key).copied() == Some(scheduled_version) {
                    versions.remove(&key);
                    true
                } else {
                    false
                }
            };
            if !should_run {
                return;
            }
            maybe_emit_trust_needed_for_changed_env(app_for_check, worktree_path, plugin_name)
                .await;
        });
    })) {
        Ok(w) => Arc::new(w),
        Err(err) => {
            tracing::warn!(
                target: "claudette::env-watcher",
                error = %err,
                "failed to start — reactive invalidation disabled"
            );
            return;
        }
    };
    // Block-on is fine here — `setup_env_watcher` runs during Tauri
    // setup, where we're not on a hot path; the lock is held for a
    // single swap. The `Arc<EnvWatcher>` then lives for the app
    // lifetime.
    let app_for_store = app.clone();
    tauri::async_runtime::block_on(async move {
        let state = app_for_store.state::<AppState>();
        *state.env_watcher.write().await = Some(watcher);
    });
}

/// Register every `(worktree, plugin)` that was just resolved with
/// the fs watcher, using the watched paths the cache stored. Called
/// after each `resolve_with_registry` so reactive invalidation stays
/// current as plugins change what they care about.
///
/// Plugins whose source entry errored or didn't detect are skipped —
/// they have no cached watched paths to register.
pub async fn register_resolved_with_watcher(
    state: &AppState,
    worktree: &Path,
    sources: &[claudette::env_provider::ResolvedSource],
) {
    let watcher_guard = state.env_watcher.read().await;
    let Some(watcher) = watcher_guard.as_ref() else {
        return;
    };
    for source in sources {
        if source.error.is_some() || !source.detected {
            // detect=false / error path: the dispatcher already
            // invalidated this entry; make sure the watcher drops it
            // too so we stop receiving events for stale paths.
            watcher.unregister(worktree, Some(&source.plugin_name));
            continue;
        }
        let paths = state.env_cache.watched_paths(worktree, &source.plugin_name);
        if paths.is_empty() {
            // Plugin detected but reported no watched paths (e.g. a
            // provider contributing env without anything to watch).
            // Still drop any prior registration so a stale watch set
            // from a previous export doesn't keep firing events.
            watcher.unregister(worktree, Some(&source.plugin_name));
            continue;
        }
        watcher.register(worktree, &source.plugin_name, &paths);
    }
}

/// Fire-and-forget env-provider warmup for a freshly-added repo.
/// Resolves against the repo's main checkout so the cache is ready
/// for the first EnvPanel open, and trust errors (`.envrc` blocked,
/// `mise.toml` untrusted) surface before the user creates a workspace.
///
/// Errors are swallowed — this is best-effort warmup, not a
/// correctness path. The user will see the error on the next EnvPanel
/// open if the warmup genuinely failed.
pub fn spawn_repo_env_warmup(app: AppHandle, repo_id: String) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let Ok(db) = Database::open(&state.db_path) else {
            return;
        };
        let Ok(Some(repo)) = db.get_repository(&repo_id) else {
            return;
        };
        let ws_info = claudette::plugin_runtime::host_api::WorkspaceInfo {
            id: format!("repo:{}", repo.id),
            name: repo.name.clone(),
            branch: String::new(),
            worktree_path: repo.path.clone(),
            repo_path: repo.path.clone(),
            repo_id: Some(repo.id.clone()),
        };
        let disabled = load_disabled_providers(&db, &repo.id);
        // Best-effort warmup — snapshot so the resolve doesn't stall
        // any concurrent Plugins/SCM commands.
        let registry = state.plugins_snapshot().await;
        let progress = TauriEnvProgressSink::new(app.clone(), ws_info.id.clone());
        let resolved = claudette::env_provider::resolve_with_registry_and_progress(
            &registry,
            &state.env_cache,
            Path::new(&repo.path),
            &ws_info,
            &disabled,
            Some(&progress),
        )
        .await;
        register_resolved_with_watcher(&state, Path::new(&repo.path), &resolved.sources).await;
    });
}

/// Flags derived from the host process environment that the frontend needs
/// to adjust UI behaviour.
#[derive(Serialize)]
pub struct HostEnvFlags {
    pub disable_1m_context: bool,
    pub alternative_backends_compiled: bool,
}

/// Return environment-derived flags from the host process. Unlike app
/// settings (stored in the database), these reflect the environment in
/// which Claudette was launched and cannot be changed at runtime.
#[tauri::command]
pub fn get_host_env_flags() -> HostEnvFlags {
    HostEnvFlags {
        disable_1m_context: std::env::var("CLAUDE_CODE_DISABLE_1M_CONTEXT").is_ok(),
        alternative_backends_compiled: cfg!(feature = "alternative-backends"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use claudette::env_provider::{ResolvedEnv, ResolvedSource};
    use std::collections::HashSet;
    use std::time::SystemTime;

    fn src(name: &str) -> ResolvedSource {
        ResolvedSource {
            plugin_name: name.to_string(),
            detected: true,
            vars_contributed: 1,
            cached: false,
            evaluated_at: SystemTime::now(),
            error: None,
        }
    }

    #[test]
    fn filter_globally_disabled_hides_globally_disabled_sources() {
        let sources = vec![src("env-direnv"), src("env-mise"), src("env-dotenv")];
        let globally_off: HashSet<&str> = ["env-mise"].into_iter().collect();

        let visible = filter_globally_disabled(sources, |n| globally_off.contains(n));

        let names: Vec<&str> = visible.iter().map(|s| s.plugin_name.as_str()).collect();
        assert_eq!(names, vec!["env-direnv", "env-dotenv"]);
    }

    #[test]
    fn filter_globally_disabled_keeps_per_repo_disabled_with_reason() {
        // Per-repo disable stamps `error: Some("disabled")`. That must
        // still be visible — the user can re-enable it right there via
        // the toggle. Only GLOBAL disables (from Plugins settings) are
        // hidden.
        let mut s = src("env-direnv");
        s.error = Some("disabled".to_string());
        s.detected = false;
        s.vars_contributed = 0;
        let sources = vec![s];

        let visible = filter_globally_disabled(sources, |_| false);

        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].error.as_deref(), Some("disabled"));
    }

    #[test]
    fn filter_globally_disabled_empty_passes_through() {
        let visible = filter_globally_disabled(Vec::new(), |_| true);
        assert!(visible.is_empty());
    }

    #[test]
    fn merge_approved_envrc_sha256s_records_unique_sorted_digests() {
        let merged = merge_approved_envrc_sha256s(
            vec!["b".repeat(64), "a".repeat(64), "a".repeat(64)],
            vec!["b".repeat(64), "c".repeat(64)],
        );

        assert_eq!(merged, vec!["a".repeat(64), "b".repeat(64), "c".repeat(64)]);
    }

    #[test]
    fn prepare_workspace_error_ignores_disabled_sources() {
        let mut source = src("env-direnv");
        source.error = Some("disabled".to_string());
        let resolved = ResolvedEnv {
            sources: vec![source],
            ..Default::default()
        };

        assert_eq!(prepare_workspace_error(&resolved), None);
    }

    #[test]
    fn prepare_workspace_error_ignores_unavailable_sources() {
        // Regression for issue #718: an env-provider with a missing
        // required CLI must not produce a workspace-switch toast.
        let mut source = src("env-nix-devshell");
        source.error = Some("unavailable".to_string());
        let resolved = ResolvedEnv {
            sources: vec![source],
            ..Default::default()
        };

        assert_eq!(prepare_workspace_error(&resolved), None);
    }

    #[test]
    fn prepare_workspace_error_ignores_mixed_disabled_and_unavailable() {
        // The common case for a fresh Linux install without nix:
        // env-direnv detected fine, env-mise was disabled per-repo,
        // env-nix-devshell is unavailable. None should trigger a toast.
        let mut direnv = src("env-direnv");
        direnv.detected = true;
        direnv.error = None;
        let mut mise = src("env-mise");
        mise.error = Some("disabled".to_string());
        let mut nix = src("env-nix-devshell");
        nix.error = Some("unavailable".to_string());
        let resolved = ResolvedEnv {
            sources: vec![direnv, mise, nix],
            ..Default::default()
        };

        assert_eq!(prepare_workspace_error(&resolved), None);
    }

    #[test]
    fn prepare_workspace_error_hides_pure_trust_errors() {
        // Contract after the EnvTrustModal split: trust-class errors
        // are routed through the `workspace_env_trust_needed` event,
        // NOT through `prepare_workspace_error`'s toast string. So a
        // resolve whose only failures are trust errors returns None
        // (the command succeeds, the modal handles UX).
        let mut source = src("env-direnv");
        source.error = Some(
            "direnv: error /repo/.envrc is blocked. Run `direnv allow` to approve its content"
                .to_string(),
        );
        let resolved = ResolvedEnv {
            sources: vec![source],
            ..Default::default()
        };

        assert_eq!(prepare_workspace_error(&resolved), None);
    }

    #[test]
    fn prepare_workspace_error_surfaces_generic_provider_errors() {
        let mut source = src("env-mise");
        source.error = Some("mise failed to export env".to_string());
        let resolved = ResolvedEnv {
            sources: vec![source],
            ..Default::default()
        };

        let message = prepare_workspace_error(&resolved).unwrap();

        assert_eq!(
            message,
            "Environment provider failed: env-mise: mise failed to export env"
        );
    }

    #[test]
    fn prepare_workspace_error_surfaces_non_trust_when_mixed_with_trust() {
        // If a resolve produces both a trust error (mise.toml not
        // trusted) AND a generic failure (TOML parse error in another
        // provider), the trust portion routes through the modal and
        // the non-trust portion still surfaces via the toast. The user
        // sees both signals — modal for the actionable trust prompt,
        // toast for the truly broken provider.
        let mut trust = src("env-mise");
        trust.error = Some("mise.toml is not trusted".to_string());
        let mut other = src("env-direnv");
        other.error = Some("direnv export failed: unexpected EOF".to_string());
        let resolved = ResolvedEnv {
            sources: vec![trust, other],
            ..Default::default()
        };

        let message = prepare_workspace_error(&resolved).unwrap();
        assert!(message.starts_with("Environment provider failed:"));
        assert!(message.contains("env-direnv"));
        assert!(!message.contains("env-mise"));
    }

    #[test]
    fn build_trust_needed_payload_lists_only_trust_sources() {
        let mut trust = src("env-mise");
        trust.error = Some("mise.toml is not trusted".to_string());
        let mut other = src("env-direnv");
        other.error = Some("direnv export failed".to_string());
        let resolved = ResolvedEnv {
            sources: vec![trust, other],
            ..Default::default()
        };

        let payload = build_trust_needed_payload("ws-id", "repo-id", &resolved).unwrap();
        assert_eq!(payload.workspace_id, "ws-id");
        assert_eq!(payload.repo_id, "repo-id");
        assert_eq!(payload.plugins.len(), 1);
        assert_eq!(payload.plugins[0].plugin_name, "env-mise");
        // The raw stderr is preserved in error_excerpt for the
        // "Show details" disclosure even when the cleaner doesn't
        // recognize the message shape.
        assert!(payload.plugins[0].error_excerpt.contains("not trusted"));
    }

    #[test]
    fn strip_lua_wrapper_handles_mlua_runtime_error_with_dispatcher_prefix() {
        // What mlua actually surfaces when env-provider dispatcher
        // catches a Lua `error("...")` and re-raises with its own
        // `export: Plugin script error: ` prefix. This is the literal
        // shape the EnvTrustModal screenshot was rendering as the
        // headline — the cleaner must reduce it to just `<inner>`.
        let raw = "export: Plugin script error: runtime error: [string \"plugins/env-mise/init.lua\"]:67: Config files in /repo/mise.toml are not trusted.";
        assert_eq!(
            strip_lua_wrapper(raw),
            "Config files in /repo/mise.toml are not trusted."
        );
    }

    #[test]
    fn strip_lua_wrapper_is_a_noop_for_plain_strings() {
        // A plugin that doesn't go through Lua (or a third-party plugin
        // returning a clean error directly) must pass through untouched.
        let raw = "Config files in /repo/mise.toml are not trusted.";
        assert_eq!(strip_lua_wrapper(raw), raw);
    }

    #[test]
    fn strip_lua_wrapper_strips_just_runtime_prefix_when_dispatcher_absent() {
        // Lua-side `error()` without the `export: Plugin script error:`
        // outer wrapper — happens in unit tests that drive the plugin
        // VM directly. Still needs to land at the inner string.
        let raw = "runtime error: [string \"plugins/env-mise/init.lua\"]:67: Config files in /repo/mise.toml are not trusted.";
        assert_eq!(
            strip_lua_wrapper(raw),
            "Config files in /repo/mise.toml are not trusted."
        );
    }

    #[test]
    fn clean_trust_error_handles_tightened_lua_output_with_no_legacy_prefix() {
        // After the env-mise plugin tightening, init.lua passes the
        // `Config files in ... are not trusted` line directly to
        // `error()` without the legacy `"mise env failed: "` prefix.
        // The cleaner must produce the same final message + path as
        // for the legacy shape — otherwise the modal renders the raw
        // `[string "..."]:NN:` Luau wrapper as the headline (the bug
        // from the user's screenshot).
        let raw = "export: Plugin script error: runtime error: [string \"plugins/env-mise/init.lua\"]:67: Config files in /Users/x/.claudette/workspaces/Claudette/grumpy-crocus/mise.toml are not trusted. Trust them with `mise trust`. See https://mise.jdx.dev/cli/trust.html for more information.";
        let cleaned = clean_trust_error_excerpt("env-mise", raw);
        assert_eq!(cleaned.message, "mise.toml is not trusted.");
        assert_eq!(
            cleaned.config_path.as_deref(),
            Some("/Users/x/.claudette/workspaces/Claudette/grumpy-crocus/mise.toml"),
        );
    }

    #[test]
    fn clean_trust_error_handles_tightened_direnv_output_with_no_legacy_prefix() {
        // Mirror of the env-mise tightening test: env-direnv now
        // passes the `direnv: error <path> is blocked` line directly
        // to `error()` without the legacy `"direnv export failed: "`
        // prefix.
        let raw = "export: Plugin script error: runtime error: [string \"plugins/env-direnv/init.lua\"]:62: direnv: error /Users/x/.claudette/workspaces/Claudette/grumpy-crocus/.envrc is blocked. Run `direnv allow` to approve its content";
        let cleaned = clean_trust_error_excerpt("env-direnv", raw);
        assert_eq!(cleaned.message, ".envrc is blocked.");
        assert_eq!(
            cleaned.config_path.as_deref(),
            Some("/Users/x/.claudette/workspaces/Claudette/grumpy-crocus/.envrc"),
        );
    }

    #[test]
    fn basename_handles_unix_and_windows_separators() {
        assert_eq!(basename("/Users/jb/repo/mise.toml"), Some("mise.toml"));
        assert_eq!(
            basename("C:\\Users\\jb\\repo\\mise.toml"),
            Some("mise.toml")
        );
        // Mixed separators (e.g. Cygwin / Git Bash on Windows passing a
        // POSIX-style path with backslash inside it) still extract the
        // final component.
        assert_eq!(
            basename("C:\\Users\\jb/mixed/path/mise.toml"),
            Some("mise.toml")
        );
        // Trailing separator → no filename portion. Defensive: callers
        // fall back to a hard-coded "mise.toml" / ".envrc" in that case.
        assert_eq!(basename("/repo/"), None);
        assert_eq!(basename(""), None);
    }

    #[test]
    fn clean_trust_error_extracts_filename_on_windows_path() {
        // Codex P3 finding regression guard: a Windows-style path must
        // produce just `mise.toml` (or `.envrc`) in the modal headline,
        // not the whole `C:\...` blob.
        let raw = "Config files in C:\\Users\\jb\\repo\\mise.toml are not trusted. Trust them with `mise trust`.";
        let cleaned = clean_trust_error_excerpt("env-mise", raw);
        assert_eq!(cleaned.message, "mise.toml is not trusted.");
        assert_eq!(
            cleaned.config_path.as_deref(),
            Some("C:\\Users\\jb\\repo\\mise.toml"),
        );

        let raw_dr = "direnv: error C:\\Users\\jb\\repo\\.envrc is blocked. Run `direnv allow` to approve its content";
        let cleaned_dr = clean_trust_error_excerpt("env-direnv", raw_dr);
        assert_eq!(cleaned_dr.message, ".envrc is blocked.");
        assert_eq!(
            cleaned_dr.config_path.as_deref(),
            Some("C:\\Users\\jb\\repo\\.envrc"),
        );
    }

    #[test]
    fn clean_trust_error_extracts_mise_path_and_filename() {
        // Verbatim shape from the user-reported toast — Lua-runtime
        // wrapper, two ERROR lines that re-print the same path, and
        // the verbose-hint footer that should all collapse to one
        // line.
        let raw = "export: Plugin script error: runtime error: [string \"plugins/env-mise/init.lua\"]:52: mise env failed: mise ERROR error parsing config file: /Users/x/.claudette/workspaces/Claudette/stubborn-jasmine/mise.toml\nmise ERROR Config files in /Users/x/.claudette/workspaces/Claudette/stubborn-jasmine/mise.toml are not trusted. Trust them with `mise trust`. See https://mise.jdx.dev/cli/trust.html for more information.\nmise ERROR Run with --verbose or MISE_VERBOSE=1 for more information";
        let cleaned = clean_trust_error_excerpt("env-mise", raw);
        assert_eq!(cleaned.message, "mise.toml is not trusted.");
        assert_eq!(
            cleaned.config_path.as_deref(),
            Some("/Users/x/.claudette/workspaces/Claudette/stubborn-jasmine/mise.toml"),
        );
    }

    #[test]
    fn clean_trust_error_extracts_direnv_path_and_filename() {
        let raw = "direnv: error /Users/x/projects/foo/.envrc is blocked. Run `direnv allow` to approve its content";
        let cleaned = clean_trust_error_excerpt("env-direnv", raw);
        assert_eq!(cleaned.message, ".envrc is blocked.");
        assert_eq!(
            cleaned.config_path.as_deref(),
            Some("/Users/x/projects/foo/.envrc"),
        );
    }

    #[test]
    fn clean_trust_error_falls_back_when_format_unfamiliar() {
        // mise might emit something we don't recognize on a future
        // version bump. We should still produce *some* message — just
        // first non-empty line — and skip the verbose footer.
        let raw = "mise ERROR Run with --verbose or MISE_VERBOSE=1 for more information\nmise ERROR something completely new";
        let cleaned = clean_trust_error_excerpt("env-mise", raw);
        assert_eq!(cleaned.message, "something completely new");
        assert!(cleaned.config_path.is_none());
    }

    #[test]
    fn build_trust_needed_payload_returns_none_when_clean() {
        let resolved = ResolvedEnv {
            sources: vec![src("env-mise")],
            ..Default::default()
        };
        assert!(build_trust_needed_payload("ws", "repo", &resolved).is_none());
    }

    #[test]
    fn trust_invalidation_probe_only_runs_for_trust_capable_providers() {
        assert!(should_probe_trust_after_invalidation("env-direnv"));
        assert!(should_probe_trust_after_invalidation("env-mise"));
        assert!(!should_probe_trust_after_invalidation("env-dotenv"));
        assert!(!should_probe_trust_after_invalidation("env-nix-devshell"));
    }

    #[test]
    fn truncate_excerpt_caps_long_stderr_at_utf8_boundary() {
        // Build a >max payload that includes a multi-byte char near the
        // cut point so we exercise the char-boundary backoff loop.
        let mut input = "a".repeat(58);
        input.push('é'); // 2 bytes; pushes past 60 if max=60
        input.push_str("trailing");
        let out = truncate_excerpt(&input, 60);
        assert!(out.ends_with('…'));
        // Ellipsis is one of [..3 bytes] depending on UTF-8 encoding;
        // the truncated body is at most 60 bytes pre-ellipsis.
        assert!(out.len() <= 60 + '…'.len_utf8());
    }
}
