pub mod host_api;
pub mod manifest;
pub mod seed;

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::{Duration, Instant};

use host_api::{DEFAULT_EXEC_TIMEOUT, HostContext, WorkspaceInfo};
use manifest::{PluginKind, PluginManifest, PluginSettingField};
use mlua::{LuaSerdeExt, VmState};

/// Well-known plugin setting key used to override the runtime's
/// per-`host.exec` and per-operation timeout. A plugin manifest can
/// declare a `Number`-typed setting with this key (and an optional
/// `min`/`max` bound) to surface the timeout in the Plugins settings
/// UI; the user can additionally override it per-repo via the
/// "Environment" subsection in Repo Settings.
pub const TIMEOUT_SETTING_KEY: &str = "timeout_seconds";

/// Hard cap on user-supplied timeout values. Prevents a typo like
/// `99999` from effectively disabling the safety net.
const MAX_TIMEOUT_SECS: u64 = 600;

/// Hard floor on user-supplied timeout values. A 0/1-second cap would
/// fail nearly every real env-provider invocation; clamping prevents
/// users from configuring an unusable workspace.
const MIN_TIMEOUT_SECS: u64 = 5;

/// Nested-map shape for [`PluginRegistry::repo_setting_overrides`].
/// Aliased so the `RwLock<...>` declaration stays readable — clippy
/// flags the raw triple-nested `HashMap` as `type_complexity`.
type RepoSettingMap = HashMap<String, HashMap<String, HashMap<String, serde_json::Value>>>;

#[derive(Debug)]
struct LuaOperationTimeout;

impl fmt::Display for LuaOperationTimeout {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "plugin operation timed out")
    }
}

impl std::error::Error for LuaOperationTimeout {}

/// Source-of-trust marker resolved once at discovery time. Drives
/// whether a plugin's privileged `host.*` calls are gated by stored
/// `granted_capabilities` (community installs) or pass through with
/// the live manifest as the allowlist (bundled and hand-installed).
#[derive(Debug, Clone)]
pub enum PluginTrust {
    /// Shipped inside the binary (seeded from `BUNDLED_PLUGINS` on
    /// startup). The seeder writes a `.version` file alongside
    /// `init.lua`; presence of that file in a directory whose name
    /// matches a bundled plugin is the sentinel. Bundled plugins are
    /// trusted: their `required_clis` is the install-time grant by
    /// definition.
    Bundled,
    /// Installed via the community registry (`.install_meta.json`
    /// with `source = "community"`). The `Vec<String>` is the
    /// `granted_capabilities` recorded at install time and is the
    /// authoritative allowlist for `host.exec`.
    Community { granted: Vec<String> },
    /// Plugin directory present in `~/.claudette/plugins/<name>/`
    /// without an `.install_meta.json` and not matching a bundled
    /// name. Pre-existing user-installed plugins fall here. We treat
    /// these as trusted (allowlist = manifest) for backward
    /// compatibility — flipping to deny is tracked as a follow-up to
    /// avoid breaking hand-installed setups.
    Unknown,
}

impl PluginTrust {
    /// Effective CLI allowlist for `host.exec`. For community
    /// plugins this is `manifest.required_clis ∩ granted_capabilities`
    /// — never broader than what was declared at install. For
    /// bundled and unknown trust, the manifest itself is the
    /// allowlist.
    pub fn effective_allowlist(&self, required: &[String]) -> Vec<String> {
        match self {
            Self::Community { granted } => required
                .iter()
                .filter(|c| granted.iter().any(|g| g == *c))
                .cloned()
                .collect(),
            Self::Bundled | Self::Unknown => required.to_vec(),
        }
    }

    /// Capabilities the live manifest requests that the user has not
    /// yet approved. Empty for trusted (bundled / unknown) trust;
    /// for community plugins it's `manifest.required_clis -
    /// granted_capabilities`. Non-empty means the runtime must fail
    /// closed and surface a re-consent prompt.
    pub fn missing_capabilities(&self, required: &[String]) -> Vec<String> {
        match self {
            Self::Community { granted } => required
                .iter()
                .filter(|c| !granted.iter().any(|g| g == *c))
                .cloned()
                .collect(),
            Self::Bundled | Self::Unknown => Vec::new(),
        }
    }
}

#[derive(Debug)]
pub struct LoadedPlugin {
    pub manifest: PluginManifest,
    pub dir: PathBuf,
    pub config: HashMap<String, serde_json::Value>,
    pub cli_available: bool,
    pub trust: PluginTrust,
}

#[derive(Debug, Clone)]
pub enum PluginError {
    CliNotFound(String),
    CliAuthError(String),
    CliError {
        cmd: String,
        stderr: String,
        code: i32,
    },
    ScriptError(String),
    Timeout,
    ParseError(String),
    NoProvider,
    OperationNotSupported(String),
    PluginNotFound(String),
    PluginDisabled(String),
    /// The plugin's live manifest declares CLI capabilities that the
    /// user-approved `granted_capabilities` does not cover. Fail
    /// closed: the runtime must NOT load the script or invoke
    /// `host.exec` — the user has to review and approve the new
    /// capabilities first via the Community settings UI.
    NeedsReconsent {
        plugin: String,
        missing: Vec<String>,
    },
}

impl fmt::Display for PluginError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::CliNotFound(cli) => write!(f, "CLI tool '{cli}' is not installed"),
            Self::CliAuthError(cli) => {
                write!(f, "CLI tool '{cli}' is not authenticated")
            }
            Self::CliError { cmd, stderr, code } => {
                write!(f, "Command '{cmd}' exited with code {code}: {stderr}")
            }
            Self::ScriptError(msg) => write!(f, "Plugin script error: {msg}"),
            Self::Timeout => write!(f, "Operation timed out"),
            Self::ParseError(msg) => write!(f, "Failed to parse plugin output: {msg}"),
            Self::NoProvider => write!(f, "No provider configured for this repository"),
            Self::OperationNotSupported(op) => write!(f, "Operation '{op}' is not supported"),
            Self::PluginNotFound(name) => write!(f, "Plugin '{name}' not found"),
            Self::PluginDisabled(name) => write!(f, "Plugin '{name}' is disabled"),
            Self::NeedsReconsent { plugin, missing } => write!(
                f,
                "Plugin '{plugin}' needs re-consent: new capabilities {missing:?}. \
                 Open Settings → Community to review and approve."
            ),
        }
    }
}

impl std::error::Error for PluginError {}

impl serde::Serialize for PluginError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub struct PluginRegistry {
    pub plugins: HashMap<String, LoadedPlugin>,
    pub plugin_dir: PathBuf,
    /// User-persisted setting overrides, keyed by plugin name → setting
    /// key → JSON value. Populated from `app_settings` at app start
    /// and updated by the Plugins settings UI. Takes precedence over
    /// manifest defaults and any static `plugin.config`.
    ///
    /// The lock is independent of `plugins`, so concurrent reads (from
    /// `call_operation` building its HostContext) don't contend with
    /// writes from the UI layer.
    setting_overrides: RwLock<HashMap<String, HashMap<String, serde_json::Value>>>,
    /// Per-repo setting overrides. Shape: `{ repo_id -> { plugin -> {
    /// key -> value } } }`. Populated from `app_settings` rows whose
    /// key matches `repo:{repo_id}:plugin:{name}:setting:{key}`.
    /// Layered on top of `setting_overrides` when the dispatcher
    /// resolves a config for a workspace whose [`WorkspaceInfo::repo_id`]
    /// is set. Cleared per-repo via [`PluginRegistry::set_repo_setting`]
    /// so the env cache invalidates on any change to a repo's overrides.
    repo_setting_overrides: RwLock<RepoSettingMap>,
    /// Globally-disabled plugin names. `call_operation` short-circuits
    /// with `PluginDisabled` for any name in this set; dispatchers that
    /// want to skip silently (e.g. env-provider resolution) should call
    /// `is_disabled` and filter.
    disabled: RwLock<HashSet<String>>,
}

impl PluginRegistry {
    /// Discover plugins from the plugin directory.
    ///
    /// Scans subdirectories for `plugin.json` manifests and checks CLI availability.
    pub fn discover(plugin_dir: &Path) -> Self {
        let mut plugins = HashMap::new();

        let entries = match std::fs::read_dir(plugin_dir) {
            Ok(entries) => entries,
            Err(e) => {
                tracing::warn!(
                    target: "claudette::plugin",
                    plugin_dir = %plugin_dir.display(),
                    error = %e,
                    "failed to read plugin directory"
                );
                return Self {
                    plugins,
                    plugin_dir: plugin_dir.to_path_buf(),
                    setting_overrides: RwLock::new(HashMap::new()),
                    repo_setting_overrides: RwLock::new(HashMap::new()),
                    disabled: RwLock::new(HashSet::new()),
                };
            }
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }

            let manifest_path = path.join("plugin.json");
            if !manifest_path.exists() {
                let name = path.file_name().unwrap_or_default().to_string_lossy();
                tracing::warn!(
                    target: "claudette::plugin",
                    plugin_name = %name,
                    "skipping plugin: missing plugin.json"
                );
                continue;
            }

            // Parse the manifest before checking for `init.lua` so that
            // declarative-only kinds (currently `language-grammar`) can
            // opt out of the script requirement. Operation-driven kinds
            // (`scm`, `env-provider`) still need `init.lua` to dispatch.
            match manifest::parse_manifest(&manifest_path) {
                Ok(manifest) => {
                    let init_path = path.join("init.lua");
                    if requires_init_lua(manifest.kind) && !init_path.exists() {
                        tracing::warn!(
                            target: "claudette::plugin",
                            plugin_name = %manifest.name,
                            kind = ?manifest.kind,
                            "skipping plugin: missing init.lua"
                        );
                        continue;
                    }
                    let cli_available = check_clis_available(&manifest.required_clis);
                    let trust = resolve_trust(&manifest.name, &path);
                    let name = manifest.name.clone();
                    plugins.insert(
                        name,
                        LoadedPlugin {
                            manifest,
                            dir: path,
                            config: HashMap::new(),
                            cli_available,
                            trust,
                        },
                    );
                }
                Err(e) => {
                    tracing::warn!(
                        target: "claudette::plugin",
                        manifest_path = %manifest_path.display(),
                        error = %e,
                        "failed to parse plugin manifest"
                    );
                }
            }
        }

        Self {
            plugins,
            plugin_dir: plugin_dir.to_path_buf(),
            setting_overrides: RwLock::new(HashMap::new()),
            repo_setting_overrides: RwLock::new(HashMap::new()),
            disabled: RwLock::new(HashSet::new()),
        }
    }

    /// Set or clear a user setting override for a plugin. Pass `None` to
    /// revert to the manifest's default value. No-op if the plugin
    /// isn't registered — we don't want unknown plugin names to
    /// silently accumulate override entries.
    pub fn set_setting(&self, plugin_name: &str, key: &str, value: Option<serde_json::Value>) {
        if !self.plugins.contains_key(plugin_name) {
            return;
        }
        let mut guard = self.setting_overrides.write().unwrap();
        match value {
            Some(v) => {
                guard
                    .entry(plugin_name.to_string())
                    .or_default()
                    .insert(key.to_string(), v);
            }
            None => {
                if let Some(entry) = guard.get_mut(plugin_name) {
                    entry.remove(key);
                    if entry.is_empty() {
                        guard.remove(plugin_name);
                    }
                }
            }
        }
    }

    /// Return the effective config map a plugin's Lua VM will see —
    /// without any per-repo layering. Precedence (lowest → highest):
    /// manifest `settings[].default` → static `plugin.config` → global
    /// user setting overrides.
    ///
    /// Returns an empty map for unknown plugin names rather than an
    /// error; `call_operation` is the surface that rejects unknown
    /// plugins.
    pub fn effective_config(&self, plugin_name: &str) -> HashMap<String, serde_json::Value> {
        let mut out: HashMap<String, serde_json::Value> = HashMap::new();

        if let Some(plugin) = self.plugins.get(plugin_name) {
            for field in &plugin.manifest.settings {
                let default = field.default_value();
                if !default.is_null() {
                    out.insert(field.key().to_string(), default);
                }
            }
            for (k, v) in &plugin.config {
                out.insert(k.clone(), v.clone());
            }
        }

        let overrides = self.setting_overrides.read().unwrap();
        if let Some(plugin_overrides) = overrides.get(plugin_name) {
            for (k, v) in plugin_overrides {
                out.insert(k.clone(), v.clone());
            }
        }

        out
    }

    /// Effective config for a specific invocation, layering per-repo
    /// overrides on top of [`PluginRegistry::effective_config`] when
    /// `ws_info.repo_id` is set. The Tauri layer hydrates per-repo
    /// overrides from `app_settings` rows of shape
    /// `repo:{repo_id}:plugin:{name}:setting:{key}` via
    /// [`PluginRegistry::set_repo_setting`].
    pub fn effective_config_for_invocation(
        &self,
        plugin_name: &str,
        ws_info: &WorkspaceInfo,
    ) -> HashMap<String, serde_json::Value> {
        let mut out = self.effective_config(plugin_name);
        if let Some(repo_id) = ws_info.repo_id.as_deref() {
            let overrides = self.repo_setting_overrides.read().unwrap();
            if let Some(plugin_map) = overrides.get(repo_id).and_then(|m| m.get(plugin_name)) {
                for (k, v) in plugin_map {
                    out.insert(k.clone(), v.clone());
                }
            }
        }
        out
    }

    /// Set or clear a per-repo setting override. Pass `None` to clear
    /// — empties the per-plugin map (and the per-repo entry) when the
    /// last value goes away so the next read short-circuits without
    /// touching the repo's bucket. No-op for unknown plugin names —
    /// matches [`PluginRegistry::set_setting`] so stale `repo:*`
    /// entries from removed plugins don't accumulate.
    pub fn set_repo_setting(
        &self,
        repo_id: &str,
        plugin_name: &str,
        key: &str,
        value: Option<serde_json::Value>,
    ) {
        if !self.plugins.contains_key(plugin_name) {
            return;
        }
        let mut guard = self.repo_setting_overrides.write().unwrap();
        match value {
            Some(v) => {
                guard
                    .entry(repo_id.to_string())
                    .or_default()
                    .entry(plugin_name.to_string())
                    .or_default()
                    .insert(key.to_string(), v);
            }
            None => {
                if let Some(repo_map) = guard.get_mut(repo_id) {
                    if let Some(plugin_map) = repo_map.get_mut(plugin_name) {
                        plugin_map.remove(key);
                        if plugin_map.is_empty() {
                            repo_map.remove(plugin_name);
                        }
                    }
                    if repo_map.is_empty() {
                        guard.remove(repo_id);
                    }
                }
            }
        }
    }

    /// Resolves the effective per-`host.exec` and per-operation
    /// timeout for a plugin invocation, trying overrides in priority
    /// order and using the **first valid** value found:
    ///   1. per-repo override
    ///      (`repo:{repo_id}:plugin:{plugin}:setting:timeout_seconds`),
    ///   2. global override (`plugin:{plugin}:setting:timeout_seconds`),
    ///   3. manifest default (from a `Number`-typed
    ///      [`PluginSettingField`] whose key is [`TIMEOUT_SETTING_KEY`]),
    ///   4. [`DEFAULT_EXEC_TIMEOUT`] (120s) as the global fallback.
    ///
    /// Invalid overrides (non-numeric strings, negatives, NaN, false)
    /// are skipped so the next tier gets a chance — e.g. a malformed
    /// per-repo value falls back to the global, then the manifest, not
    /// straight to 120s. The resolved value is then clamped into the
    /// manifest's `[min, max]` (further clamped into the global
    /// `[MIN_TIMEOUT_SECS, MAX_TIMEOUT_SECS]` safety net) so a typo
    /// like `2` or `99999` can't render the workspace unusable.
    pub fn effective_timeout(
        &self,
        plugin_name: &str,
        ws_info: Option<&WorkspaceInfo>,
    ) -> Duration {
        // Pull the matching `Number` field once so we don't iterate
        // the manifest's settings vec four times.
        let (manifest_default, manifest_min_max) = self
            .plugins
            .get(plugin_name)
            .and_then(|p| {
                p.manifest.settings.iter().find_map(|f| match f {
                    PluginSettingField::Number {
                        key,
                        default,
                        min,
                        max,
                        ..
                    } if key == TIMEOUT_SETTING_KEY => Some((*default, (*min, *max))),
                    _ => None,
                })
            })
            .unwrap_or((None, (None, None)));

        let per_repo = ws_info
            .and_then(|info| info.repo_id.as_deref())
            .and_then(|repo_id| {
                self.repo_setting_overrides
                    .read()
                    .unwrap()
                    .get(repo_id)
                    .and_then(|plugins| plugins.get(plugin_name))
                    .and_then(|kvs| kvs.get(TIMEOUT_SETTING_KEY))
                    .cloned()
            });
        let global = self
            .setting_overrides
            .read()
            .unwrap()
            .get(plugin_name)
            .and_then(|kvs| kvs.get(TIMEOUT_SETTING_KEY))
            .cloned();

        // First valid number from the override chain wins. Manifest
        // default is consulted if both override slots are absent or
        // unparseable; the global constant catches the case where the
        // plugin doesn't declare `timeout_seconds` at all.
        let resolved_secs = [per_repo, global]
            .into_iter()
            .flatten()
            .find_map(parse_timeout_value)
            .or(manifest_default.filter(|v| v.is_finite() && *v > 0.0))
            .unwrap_or_else(|| DEFAULT_EXEC_TIMEOUT.as_secs() as f64);

        // A malformed plugin manifest could declare `min > max` (e.g.
        // a community plugin with `min: 600, max: 5`). `f64::clamp`
        // panics in that case — and the dispatcher would crash the
        // process every time it tried to invoke the plugin. Reject
        // inverted manifest bounds and fall back to the global
        // `[MIN_TIMEOUT_SECS, MAX_TIMEOUT_SECS]` floor/ceiling so the
        // workspace stays usable even if the manifest is wrong.
        let (manifest_min, manifest_max) = manifest_min_max;
        let manifest_bounds_valid = match (manifest_min, manifest_max) {
            (Some(lo_m), Some(hi_m)) => lo_m <= hi_m,
            _ => true,
        };
        let (lo, hi) = if manifest_bounds_valid {
            let lo = manifest_min
                .map(|m| m.max(MIN_TIMEOUT_SECS as f64))
                .unwrap_or(MIN_TIMEOUT_SECS as f64);
            let hi = manifest_max
                .map(|m| m.min(MAX_TIMEOUT_SECS as f64))
                .unwrap_or(MAX_TIMEOUT_SECS as f64);
            (lo, hi)
        } else {
            tracing::warn!(
                target: "claudette::plugin",
                plugin = plugin_name,
                manifest_min = ?manifest_min,
                manifest_max = ?manifest_max,
                "ignoring inverted timeout_seconds bounds; using global limits"
            );
            (MIN_TIMEOUT_SECS as f64, MAX_TIMEOUT_SECS as f64)
        };
        let secs = resolved_secs.clamp(lo, hi).round() as u64;
        Duration::from_secs(secs)
    }

    /// Globally enable/disable a plugin. Disabled plugins return
    /// `PluginDisabled` from `call_operation`; dispatchers that prefer
    /// silent filtering (env-provider resolution) check `is_disabled`
    /// first.
    ///
    /// No-op for plugin names that aren't registered — parallels
    /// `set_setting`, and keeps startup hydration from app_settings
    /// silently dropping entries for removed/renamed plugins instead of
    /// ghost-disabling them. Callers at the API boundary (e.g.
    /// `set_claudette_plugin_enabled`) should validate unknown names
    /// explicitly and surface an error to the user.
    pub fn set_disabled(&self, plugin_name: &str, disabled: bool) {
        if !self.plugins.contains_key(plugin_name) {
            return;
        }
        let mut guard = self.disabled.write().unwrap();
        if disabled {
            guard.insert(plugin_name.to_string());
        } else {
            guard.remove(plugin_name);
        }
    }

    pub fn is_disabled(&self, plugin_name: &str) -> bool {
        self.disabled.read().unwrap().contains(plugin_name)
    }

    /// Whether the plugin's `manifest.required_clis` were all on PATH at
    /// registry discovery. Returns `true` for unknown plugin names so
    /// this method isn't the place that reports "missing plugin"
    /// errors — `call_operation` already does that with a clearer
    /// `PluginNotFound` error.
    ///
    /// Used by the env-provider dispatcher to treat an env-provider
    /// whose CLI is missing as "skip silently" rather than as a hard
    /// error (issue #718). For SCM plugins the existing
    /// `cli_available`-gated `CliNotFound` short-circuit in
    /// `call_operation` still applies — only consumers that explicitly
    /// query this method get the soft-skip behavior.
    pub fn is_cli_available(&self, plugin_name: &str) -> bool {
        self.plugins
            .get(plugin_name)
            .map(|p| p.cli_available)
            .unwrap_or(true)
    }

    /// Whether the plugin's live manifest declares `required_clis`
    /// that the user-approved `granted_capabilities` does not cover.
    /// Returns `false` for unknown plugins, bundled plugins, and
    /// pre-redesign user-installed plugins (`PluginTrust::Unknown`).
    /// Non-zero only for community plugins whose post-install manifest
    /// grew a CLI requirement that the user hasn't yet approved.
    ///
    /// Dispatchers that soft-skip on `is_cli_available` (env-provider)
    /// must consult this *first*: a community plugin that needs
    /// re-consent and is also missing its CLI should still surface the
    /// re-consent prompt, not vanish silently as "not installed".
    pub fn needs_reconsent(&self, plugin_name: &str) -> bool {
        self.plugins
            .get(plugin_name)
            .map(|p| {
                !p.trust
                    .missing_capabilities(&p.manifest.required_clis)
                    .is_empty()
            })
            .unwrap_or(false)
    }

    /// Execute an operation on a plugin.
    ///
    /// Creates a fresh Lua VM, loads the plugin script, calls the specified
    /// operation function, and returns the result as a JSON value.
    pub async fn call_operation(
        &self,
        plugin_name: &str,
        operation: &str,
        args: serde_json::Value,
        workspace_info: WorkspaceInfo,
    ) -> Result<serde_json::Value, PluginError> {
        // Resolve the effective timeout per-invocation so the
        // operation cap and the per-`host.exec` cap stay in sync. Both
        // now scale with the plugin's manifest default + any global /
        // per-repo overrides — see `effective_timeout`.
        let timeout = self.effective_timeout(plugin_name, Some(&workspace_info));
        self.call_operation_with_timeout(
            plugin_name,
            operation,
            args,
            workspace_info,
            timeout,
            None,
        )
        .await
    }

    /// Variant of [`call_operation`] that attaches a [`StreamingSink`]
    /// to the plugin's host context so any `host.exec_streaming` call
    /// (or `host.console`) the plugin makes forwards lines to the
    /// sink. Pass `None` for the sink to get the same behavior as
    /// [`call_operation`].
    pub async fn call_operation_streaming(
        &self,
        plugin_name: &str,
        operation: &str,
        args: serde_json::Value,
        workspace_info: WorkspaceInfo,
        streaming_sink: Option<std::sync::Arc<dyn host_api::StreamingSink>>,
    ) -> Result<serde_json::Value, PluginError> {
        let timeout = self.effective_timeout(plugin_name, Some(&workspace_info));
        self.call_operation_with_timeout(
            plugin_name,
            operation,
            args,
            workspace_info,
            timeout,
            streaming_sink,
        )
        .await
    }

    async fn call_operation_with_timeout(
        &self,
        plugin_name: &str,
        operation: &str,
        args: serde_json::Value,
        workspace_info: WorkspaceInfo,
        operation_timeout: Duration,
        streaming_sink: Option<std::sync::Arc<dyn host_api::StreamingSink>>,
    ) -> Result<serde_json::Value, PluginError> {
        let plugin = self
            .plugins
            .get(plugin_name)
            .ok_or_else(|| PluginError::PluginNotFound(plugin_name.to_string()))?;

        if self.is_disabled(plugin_name) {
            return Err(PluginError::PluginDisabled(plugin_name.to_string()));
        }

        // Capability gate (#580): for community-installed plugins,
        // the live manifest's required_clis must be a subset of the
        // user's approved grants. A plugin update that grew its
        // required CLI set fails closed here — before init.lua is
        // even read, and ahead of the cli_available probe so the
        // user sees the consent prompt regardless of whether the
        // tool is on PATH.
        let missing = plugin
            .trust
            .missing_capabilities(&plugin.manifest.required_clis);
        if !missing.is_empty() {
            return Err(PluginError::NeedsReconsent {
                plugin: plugin_name.to_string(),
                missing,
            });
        }

        if !plugin.cli_available {
            let cli_list = plugin.manifest.required_clis.join(", ");
            return Err(PluginError::CliNotFound(cli_list));
        }

        if !plugin.manifest.operations.contains(&operation.to_string()) {
            return Err(PluginError::OperationNotSupported(operation.to_string()));
        }

        let init_path = plugin.dir.join("init.lua");
        // Use tokio::fs to avoid blocking the async runtime thread, which
        // matters in the polling loop where many workspaces may load at once.
        let script = tokio::fs::read_to_string(&init_path)
            .await
            .map_err(|e| PluginError::ScriptError(format!("Failed to read init.lua: {e}")))?;

        let allowed_clis = plugin
            .trust
            .effective_allowlist(&plugin.manifest.required_clis);
        // Per-`host.exec` timeout matches the operation timeout: a
        // single export that does N serial exec calls would otherwise
        // be allowed (operation budget) to exceed the per-call budget.
        // Resolving once here keeps both sides consistent for this
        // invocation even if a concurrent UI write changes the global
        // override mid-call.
        let config = self.effective_config_for_invocation(plugin_name, &workspace_info);
        let ctx = HostContext {
            plugin_name: plugin_name.to_string(),
            kind: plugin.manifest.kind,
            allowed_clis,
            workspace_info,
            config,
            exec_timeout: operation_timeout,
            streaming_sink,
        };

        let lua =
            host_api::create_lua_vm(ctx).map_err(|e| PluginError::ScriptError(e.to_string()))?;
        install_operation_timeout_interrupt(&lua, operation_timeout);

        // Run script load + function call + result conversion under a
        // single timeout. Luau's interrupt deadline covers non-yielding
        // pure-Lua loops, while the Tokio timeout still covers async host
        // calls that are waiting outside the VM.
        let required_clis = plugin.manifest.required_clis.clone();
        let plugin_name_owned = plugin_name.to_string();
        let operation_owned = operation.to_string();
        let fut = async move {
            // Load and execute the plugin script to get the module table
            let module: mlua::Table = lua
                .load(&script)
                .set_name(format!("plugins/{plugin_name_owned}/init.lua"))
                .eval_async()
                .await
                .map_err(|e| {
                    if is_lua_operation_timeout(&e) {
                        PluginError::Timeout
                    } else {
                        PluginError::ScriptError(format!("Failed to load plugin: {e}"))
                    }
                })?;

            // Get the operation function
            let func: mlua::Function = module.get(operation_owned.as_str()).map_err(|e| {
                PluginError::OperationNotSupported(format!("{operation_owned}: {e}"))
            })?;

            // Convert args to Lua value
            let lua_args = lua.to_value(&args).map_err(|e| {
                if is_lua_operation_timeout(&e) {
                    PluginError::Timeout
                } else {
                    PluginError::ParseError(format!("Failed to convert args: {e}"))
                }
            })?;

            // Call the operation
            let result: mlua::Value =
                func.call_async(lua_args).await.map_err(|e: mlua::Error| {
                    if is_lua_operation_timeout(&e) {
                        return PluginError::Timeout;
                    }
                    let msg = e.to_string();
                    // Detect auth errors from CLI tools
                    if msg.contains("auth") || msg.contains("login") || msg.contains("401") {
                        let cli = required_clis.first().cloned().unwrap_or_default();
                        return PluginError::CliAuthError(cli);
                    }
                    PluginError::ScriptError(msg)
                })?;

            // Convert result to JSON
            lua.from_value(result).map_err(|e| {
                if is_lua_operation_timeout(&e) {
                    PluginError::Timeout
                } else {
                    PluginError::ParseError(format!("Failed to convert result: {e}"))
                }
            })
        };

        match tokio::time::timeout(operation_timeout, fut).await {
            Ok(result) => result,
            Err(_) => Err(PluginError::Timeout),
        }
    }

    /// Get the plugin directory path.
    pub fn plugin_dir(&self) -> &Path {
        &self.plugin_dir
    }
}

/// Parse a stored timeout value into seconds. Accepts JSON numbers
/// directly and JSON strings (`"60"`) for forward-compat with text
/// inputs whose payload type can drift across UI versions. Anything
/// else — booleans, arrays, NaN, negatives — returns `None` so the
/// caller falls back to the manifest default. Logged as a warning so
/// diagnostic surfaces can show that a saved override is being
/// ignored.
fn parse_timeout_value(value: serde_json::Value) -> Option<f64> {
    let parsed = match &value {
        serde_json::Value::Number(n) => n.as_f64(),
        serde_json::Value::String(s) => s.trim().parse::<f64>().ok(),
        _ => None,
    };
    if let Some(v) = parsed
        && v.is_finite()
        && v > 0.0
    {
        return Some(v);
    }
    // A persisted timeout override that fails to parse means the
    // user (or a misbehaving migration / external write) wrote an
    // invalid value into `app_settings`. We don't want this to
    // disappear silently — surface it at WARN so the diagnostics
    // surface ("could not parse my timeout") matches the doc claim.
    tracing::warn!(
        target: "claudette::plugin",
        value = ?value,
        "ignoring non-numeric / non-positive timeout override; using default"
    );
    None
}

fn install_operation_timeout_interrupt(lua: &mlua::Lua, operation_timeout: Duration) {
    let deadline = Instant::now() + operation_timeout;
    lua.set_interrupt(move |_| {
        if Instant::now() >= deadline {
            Err(mlua::Error::external(LuaOperationTimeout))
        } else {
            Ok(VmState::Continue)
        }
    });
}

fn is_lua_operation_timeout(error: &mlua::Error) -> bool {
    match error {
        mlua::Error::ExternalError(err) => err.downcast_ref::<LuaOperationTimeout>().is_some(),
        mlua::Error::CallbackError { cause, .. } | mlua::Error::WithContext { cause, .. } => {
            is_lua_operation_timeout(cause)
        }
        _ => false,
    }
}

/// Check if all required CLI tools are available on PATH.
///
/// Uses the enriched PATH (login-shell probed) so Homebrew-installed CLIs
/// like `gh`/`glab` resolve correctly when the app is launched from Finder.
fn check_clis_available(clis: &[String]) -> bool {
    clis.iter()
        .all(|cli| crate::env::which_in_enriched_path(cli).is_ok())
}

/// Resolve a plugin directory's trust source at discovery time.
///
/// Decision order:
/// 1. `.install_meta.json` is present on disk and parses with
///    `source = "community"` → community install. Use recorded
///    `granted_capabilities`. If it parses with a non-community
///    source, fall through. If it fails to parse (corrupt /
///    truncated / partial write), fail closed: treat as community
///    with empty grants so the runtime returns `NeedsReconsent`,
///    rather than silently falling through to Unknown
///    (allow-everything).
/// 2. Plugin name matches a bundled name AND a `.version` sentinel
///    is present (written by `seed_bundled_plugins`) → bundled
///    and trusted.
/// 3. Anything else (no meta file, no bundled match) → unknown
///    hand-installed plugin; trusted for backward compat.
///
/// The check is one disk read per plugin at startup, never on hot
/// paths — `call_operation` consults the cached `LoadedPlugin.trust`.
fn resolve_trust(name: &str, dir: &Path) -> PluginTrust {
    let meta_path = dir.join(".install_meta.json");
    if meta_path.exists() {
        match crate::community::read_install_meta(dir) {
            Ok(Some(meta)) if meta.source == crate::community::InstallSource::Community => {
                return PluginTrust::Community {
                    granted: meta.granted_capabilities,
                };
            }
            Ok(Some(_)) => {
                // Meta file present but not community-sourced
                // (`direct` / `bundled`). No grant model applies —
                // fall through to bundled / unknown resolution.
            }
            Ok(None) => {
                // The exists() check passed but the read returned
                // None — narrow race window where the file
                // disappeared between checks. Fail closed: treat as
                // community with empty grants.
                tracing::warn!(
                    target: "claudette::plugin",
                    plugin_name = %name,
                    ".install_meta.json vanished during discovery — failing closed"
                );
                return PluginTrust::Community {
                    granted: Vec::new(),
                };
            }
            Err(e) => {
                // Corrupt / truncated / partially-written meta file.
                // Fail closed rather than silently allowing the
                // manifest's full required_clis through.
                tracing::warn!(
                    target: "claudette::plugin",
                    plugin_name = %name,
                    error = %e,
                    "failed to read .install_meta.json — failing closed"
                );
                return PluginTrust::Community {
                    granted: Vec::new(),
                };
            }
        }
    }
    if seed::is_bundled_plugin_name(name) && dir.join(".version").exists() {
        return PluginTrust::Bundled;
    }
    PluginTrust::Unknown
}

/// Whether discovery should require an `init.lua` for a plugin of this
/// kind. Operation-driven kinds (`scm`, `env-provider`) load Lua to
/// dispatch operations; declarative-only kinds (`language-grammar`)
/// expose static metadata + asset files instead.
fn requires_init_lua(kind: PluginKind) -> bool {
    match kind {
        PluginKind::Scm | PluginKind::EnvProvider => true,
        PluginKind::LanguageGrammar => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn test_discover_empty_dir() {
        let dir = tempfile::tempdir().unwrap();
        let registry = PluginRegistry::discover(dir.path());
        assert!(registry.plugins.is_empty());
    }

    #[test]
    fn test_discover_valid_plugin() {
        let dir = tempfile::tempdir().unwrap();
        let plugin_dir = dir.path().join("test-plugin");
        std::fs::create_dir(&plugin_dir).unwrap();

        std::fs::write(
            plugin_dir.join("plugin.json"),
            r#"{
                "name": "test",
                "display_name": "Test Plugin",
                "version": "1.0.0",
                "description": "A test plugin",
                "required_clis": [],
                "operations": ["list_pull_requests"]
            }"#,
        )
        .unwrap();
        std::fs::write(plugin_dir.join("init.lua"), "local M = {} return M").unwrap();

        let registry = PluginRegistry::discover(dir.path());
        assert_eq!(registry.plugins.len(), 1);
        assert!(registry.plugins.contains_key("test"));
        assert!(registry.plugins["test"].cli_available); // no CLIs required
    }

    #[test]
    fn test_discover_grammar_plugin_without_init_lua() {
        // language-grammar plugins are declarative; init.lua is not
        // required and must not be a discovery prerequisite.
        let dir = tempfile::tempdir().unwrap();
        let plugin_dir = dir.path().join("lang-test");
        std::fs::create_dir(&plugin_dir).unwrap();

        std::fs::write(
            plugin_dir.join("plugin.json"),
            r#"{
                "name": "lang-test",
                "display_name": "Test Lang",
                "version": "1.0.0",
                "description": "Grammar plugin without init.lua",
                "kind": "language-grammar",
                "operations": [],
                "languages": [{ "id": "test", "extensions": [".test"] }],
                "grammars": [{ "language": "test", "scope_name": "source.test", "path": "grammars/test.tmLanguage.json" }]
            }"#,
        )
        .unwrap();

        let registry = PluginRegistry::discover(dir.path());
        assert!(registry.plugins.contains_key("lang-test"));
        assert_eq!(
            registry.plugins["lang-test"].manifest.kind,
            PluginKind::LanguageGrammar
        );
    }

    #[test]
    fn test_discover_scm_plugin_still_requires_init_lua() {
        // Regression guard: relaxing init.lua for grammar plugins
        // must NOT relax it for kinds that dispatch Lua operations.
        let dir = tempfile::tempdir().unwrap();
        let plugin_dir = dir.path().join("bad-scm");
        std::fs::create_dir(&plugin_dir).unwrap();
        std::fs::write(
            plugin_dir.join("plugin.json"),
            r#"{
                "name": "bad-scm",
                "display_name": "Bad SCM",
                "version": "1.0.0",
                "description": "missing init.lua",
                "kind": "scm",
                "operations": ["list_pull_requests"]
            }"#,
        )
        .unwrap();

        let registry = PluginRegistry::discover(dir.path());
        assert!(registry.plugins.is_empty());
    }

    #[test]
    fn test_discover_missing_init_lua() {
        let dir = tempfile::tempdir().unwrap();
        let plugin_dir = dir.path().join("bad-plugin");
        std::fs::create_dir(&plugin_dir).unwrap();

        std::fs::write(
            plugin_dir.join("plugin.json"),
            r#"{
                "name": "bad",
                "display_name": "Bad Plugin",
                "version": "1.0.0",
                "description": "Missing init.lua",
                "operations": []
            }"#,
        )
        .unwrap();
        // No init.lua

        let registry = PluginRegistry::discover(dir.path());
        assert!(registry.plugins.is_empty());
    }

    #[test]
    fn test_discover_malformed_manifest() {
        let dir = tempfile::tempdir().unwrap();
        let plugin_dir = dir.path().join("bad-manifest");
        std::fs::create_dir(&plugin_dir).unwrap();

        std::fs::write(plugin_dir.join("plugin.json"), "not json").unwrap();
        std::fs::write(plugin_dir.join("init.lua"), "return {}").unwrap();

        let registry = PluginRegistry::discover(dir.path());
        assert!(registry.plugins.is_empty());
    }

    #[test]
    fn test_discover_skips_files() {
        let dir = tempfile::tempdir().unwrap();
        // Create a file (not a directory) in the plugin dir
        std::fs::write(dir.path().join("not-a-plugin.txt"), "hello").unwrap();

        let registry = PluginRegistry::discover(dir.path());
        assert!(registry.plugins.is_empty());
    }

    #[tokio::test]
    async fn test_call_operation_simple() {
        let dir = tempfile::tempdir().unwrap();
        let plugin_dir = dir.path().join("echo-plugin");
        std::fs::create_dir(&plugin_dir).unwrap();

        std::fs::write(
            plugin_dir.join("plugin.json"),
            r#"{
                "name": "echo",
                "display_name": "Echo Plugin",
                "version": "1.0.0",
                "description": "Returns its input",
                "operations": ["echo_back"]
            }"#,
        )
        .unwrap();

        std::fs::write(
            plugin_dir.join("init.lua"),
            r#"
            local M = {}
            function M.echo_back(args)
                return { message = args.input }
            end
            return M
            "#,
        )
        .unwrap();

        let registry = PluginRegistry::discover(dir.path());

        let ws = test_workspace();

        let result = registry
            .call_operation(
                "echo",
                "echo_back",
                serde_json::json!({"input": "hello"}),
                ws,
            )
            .await
            .unwrap();

        assert_eq!(result["message"], "hello");
    }

    fn write_plugin(dir: &Path, name: &str, init_lua: &str, operations: &[&str]) {
        let plugin_dir = dir.join(name);
        std::fs::create_dir(&plugin_dir).unwrap();
        std::fs::write(
            plugin_dir.join("plugin.json"),
            serde_json::json!({
                "name": name,
                "display_name": name,
                "version": "1.0.0",
                "description": "test plugin",
                "operations": operations,
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(plugin_dir.join("init.lua"), init_lua).unwrap();
    }

    /// Build a `WorkspaceInfo` whose `worktree_path` and `repo_path` are
    /// real existing directories so `Command::current_dir(...)` works in
    /// `host.exec` tests. Hardcoding `"/tmp"` worked on Unix but on
    /// Windows there is no `/tmp` and `tokio::process::Command::spawn`
    /// fails with `os error 267 (ERROR_DIRECTORY)` before the child
    /// process even starts. `std::env::temp_dir()` resolves per-platform
    /// (`/tmp` on Unix, `%TEMP%` on Windows) and is guaranteed to exist.
    fn test_workspace() -> WorkspaceInfo {
        let tmp = std::env::temp_dir().to_string_lossy().into_owned();
        WorkspaceInfo {
            id: "ws-1".to_string(),
            name: "test".to_string(),
            branch: "main".to_string(),
            worktree_path: tmp.clone(),
            repo_path: tmp,
            ..Default::default()
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn top_level_cpu_loop_is_interrupted_within_operation_timeout() {
        let dir = tempfile::tempdir().unwrap();
        write_plugin(
            dir.path(),
            "top-level-loop",
            r#"
            while true do end
            local M = {}
            function M.run(args)
                return { ok = true }
            end
            return M
            "#,
            &["run"],
        );
        let registry = PluginRegistry::discover(dir.path());

        let started = Instant::now();
        let result = tokio::time::timeout(
            Duration::from_secs(2),
            registry.call_operation_with_timeout(
                "top-level-loop",
                "run",
                serde_json::json!({}),
                test_workspace(),
                Duration::from_millis(100),
                None,
            ),
        )
        .await
        .expect("CPU-bound Lua load should not stall the test runtime");

        assert!(matches!(result, Err(PluginError::Timeout)));
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "CPU-bound Lua load should abort promptly"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn operation_cpu_loop_is_interrupted_within_operation_timeout() {
        let dir = tempfile::tempdir().unwrap();
        write_plugin(
            dir.path(),
            "operation-loop",
            r#"
            local M = {}
            function M.run(args)
                while true do end
                return { ok = true }
            end
            return M
            "#,
            &["run"],
        );
        let registry = PluginRegistry::discover(dir.path());

        let started = Instant::now();
        let result = tokio::time::timeout(
            Duration::from_secs(2),
            registry.call_operation_with_timeout(
                "operation-loop",
                "run",
                serde_json::json!({}),
                test_workspace(),
                Duration::from_millis(100),
                None,
            ),
        )
        .await
        .expect("CPU-bound Lua operation should not stall the test runtime");

        assert!(matches!(result, Err(PluginError::Timeout)));
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "CPU-bound Lua operation should abort promptly"
        );
    }

    #[tokio::test]
    async fn script_error_message_containing_timeout_text_is_not_timeout() {
        let dir = tempfile::tempdir().unwrap();
        write_plugin(
            dir.path(),
            "sentinel-error",
            r#"
            local M = {}
            function M.run(args)
                error("plugin operation timed out")
            end
            return M
            "#,
            &["run"],
        );
        let registry = PluginRegistry::discover(dir.path());

        let result = registry
            .call_operation_with_timeout(
                "sentinel-error",
                "run",
                serde_json::json!({}),
                test_workspace(),
                Duration::from_millis(100),
                None,
            )
            .await;

        assert!(matches!(result, Err(PluginError::ScriptError(_))));
    }

    #[tokio::test]
    async fn test_call_operation_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let registry = PluginRegistry::discover(dir.path());

        let ws = test_workspace();

        let result = registry
            .call_operation("nonexistent", "op", serde_json::json!({}), ws)
            .await;

        assert!(matches!(result, Err(PluginError::PluginNotFound(_))));
    }

    #[tokio::test]
    async fn test_call_operation_unsupported() {
        let dir = tempfile::tempdir().unwrap();
        let plugin_dir = dir.path().join("limited");
        std::fs::create_dir(&plugin_dir).unwrap();

        std::fs::write(
            plugin_dir.join("plugin.json"),
            r#"{
                "name": "limited",
                "display_name": "Limited",
                "version": "1.0.0",
                "description": "Limited ops",
                "operations": ["list_pull_requests"]
            }"#,
        )
        .unwrap();
        std::fs::write(plugin_dir.join("init.lua"), "local M = {} return M").unwrap();

        let registry = PluginRegistry::discover(dir.path());

        let ws = test_workspace();

        let result = registry
            .call_operation("limited", "ci_status", serde_json::json!({}), ws)
            .await;

        assert!(matches!(result, Err(PluginError::OperationNotSupported(_))));
    }

    fn make_plugin_with_settings_manifest(dir: &Path) -> PluginRegistry {
        let plugin_dir = dir.join("settings-demo");
        std::fs::create_dir(&plugin_dir).unwrap();
        std::fs::write(
            plugin_dir.join("plugin.json"),
            r#"{
                "name": "settings-demo",
                "display_name": "Settings Demo",
                "version": "1.0.0",
                "description": "demo",
                "operations": ["read_config"],
                "settings": [
                    { "type": "boolean", "key": "flag", "label": "Flag", "default": false },
                    { "type": "text", "key": "name", "label": "Name", "default": "alice" }
                ]
            }"#,
        )
        .unwrap();
        std::fs::write(
            plugin_dir.join("init.lua"),
            r#"
            local M = {}
            function M.read_config(args)
                return { flag = host.config("flag"), name = host.config("name") }
            end
            return M
            "#,
        )
        .unwrap();
        PluginRegistry::discover(dir)
    }

    #[test]
    fn effective_config_uses_manifest_defaults_when_no_overrides() {
        let dir = tempfile::tempdir().unwrap();
        let registry = make_plugin_with_settings_manifest(dir.path());
        let cfg = registry.effective_config("settings-demo");
        assert_eq!(cfg.get("flag"), Some(&serde_json::Value::Bool(false)));
        assert_eq!(
            cfg.get("name"),
            Some(&serde_json::Value::String("alice".into()))
        );
    }

    #[test]
    fn set_setting_overrides_manifest_default() {
        let dir = tempfile::tempdir().unwrap();
        let registry = make_plugin_with_settings_manifest(dir.path());
        registry.set_setting("settings-demo", "flag", Some(serde_json::Value::Bool(true)));
        let cfg = registry.effective_config("settings-demo");
        assert_eq!(cfg.get("flag"), Some(&serde_json::Value::Bool(true)));
        // Unset override reverts to manifest default.
        registry.set_setting("settings-demo", "flag", None);
        let cfg = registry.effective_config("settings-demo");
        assert_eq!(cfg.get("flag"), Some(&serde_json::Value::Bool(false)));
    }

    #[test]
    fn effective_config_empty_for_unknown_plugin() {
        let dir = tempfile::tempdir().unwrap();
        let registry = PluginRegistry::discover(dir.path());
        assert!(registry.effective_config("no-such-plugin").is_empty());
    }

    #[test]
    fn set_disabled_and_is_disabled_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let registry = make_plugin_with_settings_manifest(dir.path());
        assert!(!registry.is_disabled("settings-demo"));
        registry.set_disabled("settings-demo", true);
        assert!(registry.is_disabled("settings-demo"));
        registry.set_disabled("settings-demo", false);
        assert!(!registry.is_disabled("settings-demo"));
    }

    #[test]
    fn set_disabled_ignores_unknown_plugin_name() {
        let dir = tempfile::tempdir().unwrap();
        let registry = PluginRegistry::discover(dir.path());
        registry.set_disabled("does-not-exist", true);
        assert!(
            !registry.is_disabled("does-not-exist"),
            "unknown plugin names must not accumulate in the disabled set"
        );
    }

    #[tokio::test]
    async fn call_operation_errors_for_disabled_plugin() {
        let dir = tempfile::tempdir().unwrap();
        let registry = make_plugin_with_settings_manifest(dir.path());
        registry.set_disabled("settings-demo", true);

        let ws = test_workspace();
        let result = registry
            .call_operation("settings-demo", "read_config", serde_json::json!({}), ws)
            .await;
        assert!(matches!(result, Err(PluginError::PluginDisabled(_))));
    }

    #[tokio::test]
    async fn call_operation_populates_host_config_from_settings() {
        let dir = tempfile::tempdir().unwrap();
        let registry = make_plugin_with_settings_manifest(dir.path());
        registry.set_setting(
            "settings-demo",
            "name",
            Some(serde_json::Value::String("bob".into())),
        );

        let ws = test_workspace();
        let result = registry
            .call_operation("settings-demo", "read_config", serde_json::json!({}), ws)
            .await
            .unwrap();
        assert_eq!(result["flag"], false);
        assert_eq!(result["name"], "bob");
    }

    #[test]
    fn set_setting_ignores_unknown_plugin_name() {
        let dir = tempfile::tempdir().unwrap();
        let registry = PluginRegistry::discover(dir.path());

        registry.set_setting(
            "does-not-exist",
            "some_key",
            Some(serde_json::Value::String("x".into())),
        );

        // Unknown plugin names must NOT silently accumulate override
        // entries in the map.
        let overrides = registry.setting_overrides.read().unwrap();
        assert!(!overrides.contains_key("does-not-exist"));
    }

    /// Build a registry whose plugin declares a `Number`-typed
    /// `timeout_seconds` setting. Used by the timeout-resolution tests
    /// to exercise the manifest default + global override + per-repo
    /// override layering without going through the env-provider
    /// dispatch.
    fn make_plugin_with_timeout_manifest(dir: &Path, default: u64) -> PluginRegistry {
        let plugin_dir = dir.join("timeout-demo");
        std::fs::create_dir(&plugin_dir).unwrap();
        let manifest = format!(
            r#"{{
                "name": "timeout-demo",
                "display_name": "Timeout Demo",
                "version": "1.0.0",
                "description": "demo",
                "operations": ["noop"],
                "settings": [
                    {{
                        "type": "number",
                        "key": "timeout_seconds",
                        "label": "Timeout",
                        "default": {default},
                        "min": 5,
                        "max": 600
                    }}
                ]
            }}"#
        );
        std::fs::write(plugin_dir.join("plugin.json"), manifest).unwrap();
        std::fs::write(
            plugin_dir.join("init.lua"),
            "local M = {} function M.noop(a) return {} end return M",
        )
        .unwrap();
        PluginRegistry::discover(dir)
    }

    #[test]
    fn effective_timeout_uses_manifest_default() {
        let dir = tempfile::tempdir().unwrap();
        let registry = make_plugin_with_timeout_manifest(dir.path(), 90);
        let resolved = registry.effective_timeout("timeout-demo", None);
        assert_eq!(resolved, Duration::from_secs(90));
    }

    #[test]
    fn effective_timeout_falls_back_when_no_manifest_setting() {
        // Plugin without a `timeout_seconds` field: resolver returns
        // the global DEFAULT_EXEC_TIMEOUT (120s).
        let dir = tempfile::tempdir().unwrap();
        let registry = make_plugin_with_settings_manifest(dir.path());
        let resolved = registry.effective_timeout("settings-demo", None);
        assert_eq!(resolved, DEFAULT_EXEC_TIMEOUT);
    }

    #[test]
    fn effective_timeout_global_override_wins_over_manifest() {
        let dir = tempfile::tempdir().unwrap();
        let registry = make_plugin_with_timeout_manifest(dir.path(), 60);
        registry.set_setting(
            "timeout-demo",
            TIMEOUT_SETTING_KEY,
            Some(serde_json::json!(300)),
        );
        let resolved = registry.effective_timeout("timeout-demo", None);
        assert_eq!(resolved, Duration::from_secs(300));
    }

    #[test]
    fn effective_timeout_per_repo_override_wins_over_global() {
        let dir = tempfile::tempdir().unwrap();
        let registry = make_plugin_with_timeout_manifest(dir.path(), 60);
        registry.set_setting(
            "timeout-demo",
            TIMEOUT_SETTING_KEY,
            Some(serde_json::json!(120)),
        );
        registry.set_repo_setting(
            "repo-A",
            "timeout-demo",
            TIMEOUT_SETTING_KEY,
            Some(serde_json::json!(240)),
        );

        let mut ws = test_workspace();
        ws.repo_id = Some("repo-A".to_string());
        let resolved = registry.effective_timeout("timeout-demo", Some(&ws));
        assert_eq!(resolved, Duration::from_secs(240));

        // Different repo gets the global override, not the repo-A override.
        let mut other = test_workspace();
        other.repo_id = Some("repo-B".to_string());
        let resolved_b = registry.effective_timeout("timeout-demo", Some(&other));
        assert_eq!(resolved_b, Duration::from_secs(120));
    }

    #[test]
    fn effective_timeout_clamps_to_manifest_bounds() {
        let dir = tempfile::tempdir().unwrap();
        let registry = make_plugin_with_timeout_manifest(dir.path(), 60);
        // Override well above the manifest max=600 → clamps to 600.
        registry.set_setting(
            "timeout-demo",
            TIMEOUT_SETTING_KEY,
            Some(serde_json::json!(99_999)),
        );
        let resolved = registry.effective_timeout("timeout-demo", None);
        assert_eq!(resolved, Duration::from_secs(600));

        // Override below the manifest min=5 → clamps to 5.
        registry.set_setting(
            "timeout-demo",
            TIMEOUT_SETTING_KEY,
            Some(serde_json::json!(1)),
        );
        let resolved = registry.effective_timeout("timeout-demo", None);
        assert_eq!(resolved, Duration::from_secs(5));
    }

    /// A malformed plugin manifest (community plugin, hand-edited
    /// manifest, etc.) could declare `min > max` (e.g. `min: 600,
    /// max: 5`). `f64::clamp` panics in that case, which would crash
    /// the dispatcher. The resolver must detect inverted bounds and
    /// fall back to the global limits instead.
    #[test]
    fn effective_timeout_does_not_panic_on_inverted_manifest_bounds() {
        let dir = tempfile::tempdir().unwrap();
        let plugin_dir = dir.path().join("inverted-bounds");
        std::fs::create_dir(&plugin_dir).unwrap();
        // Deliberately inverted: min=600, max=5. f64::clamp(_, 600, 5)
        // would panic.
        let manifest = r#"{
            "name": "inverted-bounds",
            "display_name": "Inverted Bounds",
            "version": "1.0.0",
            "description": "demo",
            "operations": ["noop"],
            "settings": [
                {
                    "type": "number",
                    "key": "timeout_seconds",
                    "label": "Timeout",
                    "default": 90,
                    "min": 600,
                    "max": 5
                }
            ]
        }"#;
        std::fs::write(plugin_dir.join("plugin.json"), manifest).unwrap();
        std::fs::write(
            plugin_dir.join("init.lua"),
            "local M = {} function M.noop() return {} end return M",
        )
        .unwrap();
        let registry = PluginRegistry::discover(dir.path());

        // Must not panic. The fallback uses the global
        // `[MIN_TIMEOUT_SECS, MAX_TIMEOUT_SECS]` (5..=600) bounds, so
        // a default of 90 stays in range and resolves to 90s.
        let resolved = registry.effective_timeout("inverted-bounds", None);
        assert_eq!(resolved, Duration::from_secs(90));
    }

    #[test]
    fn effective_timeout_invalid_value_falls_back_to_default() {
        let dir = tempfile::tempdir().unwrap();
        let registry = make_plugin_with_timeout_manifest(dir.path(), 90);
        // Garbage values: each one falls back to the manifest default.
        for bad in [
            serde_json::json!("not a number"),
            serde_json::json!(-5),
            serde_json::json!(0),
            serde_json::json!(true),
        ] {
            registry.set_setting("timeout-demo", TIMEOUT_SETTING_KEY, Some(bad.clone()));
            let resolved = registry.effective_timeout("timeout-demo", None);
            assert_eq!(
                resolved,
                Duration::from_secs(90),
                "value {bad:?} should fall back to manifest default"
            );
        }

        // String form of a valid number is accepted (forward-compat
        // with text inputs whose payload type can drift).
        registry.set_setting(
            "timeout-demo",
            TIMEOUT_SETTING_KEY,
            Some(serde_json::json!("180")),
        );
        let resolved = registry.effective_timeout("timeout-demo", None);
        assert_eq!(resolved, Duration::from_secs(180));
    }

    #[test]
    fn set_repo_setting_ignores_unknown_plugin_name() {
        let dir = tempfile::tempdir().unwrap();
        let registry = PluginRegistry::discover(dir.path());
        registry.set_repo_setting(
            "repo-A",
            "does-not-exist",
            "k",
            Some(serde_json::json!("v")),
        );
        let overrides = registry.repo_setting_overrides.read().unwrap();
        assert!(!overrides.contains_key("repo-A"));
    }

    #[test]
    fn set_repo_setting_clear_collapses_empty_buckets() {
        let dir = tempfile::tempdir().unwrap();
        let registry = make_plugin_with_timeout_manifest(dir.path(), 60);
        registry.set_repo_setting(
            "repo-A",
            "timeout-demo",
            TIMEOUT_SETTING_KEY,
            Some(serde_json::json!(240)),
        );
        // Sanity check: the override is present.
        {
            let overrides = registry.repo_setting_overrides.read().unwrap();
            assert!(overrides.contains_key("repo-A"));
        }
        // Clearing the only key should remove the entire repo entry,
        // not leave an empty {repo-A: {timeout-demo: {}}} bucket.
        registry.set_repo_setting("repo-A", "timeout-demo", TIMEOUT_SETTING_KEY, None);
        let overrides = registry.repo_setting_overrides.read().unwrap();
        assert!(!overrides.contains_key("repo-A"));
    }

    // ---- Capability enforcement (#580) -------------------------------------

    /// Build a plugin directory whose `.install_meta.json` records
    /// `granted_capabilities` — i.e. the registry-installed shape.
    /// Manifest `required_clis` is configurable so tests can simulate
    /// post-install manifest drift (the threat model in #580).
    fn write_community_plugin(
        dir: &Path,
        name: &str,
        manifest_required_clis: &[&str],
        granted: &[&str],
        operations: &[&str],
        init_lua: &str,
    ) {
        let plugin_dir = dir.join(name);
        std::fs::create_dir(&plugin_dir).unwrap();
        let manifest = serde_json::json!({
            "name": name,
            "display_name": name,
            "version": "1.0.0",
            "description": "test plugin",
            "required_clis": manifest_required_clis,
            "operations": operations,
        });
        std::fs::write(plugin_dir.join("plugin.json"), manifest.to_string()).unwrap();
        std::fs::write(plugin_dir.join("init.lua"), init_lua).unwrap();
        let meta = serde_json::json!({
            "source": "community",
            "kind": "plugin:scm",
            "registry_sha": "0".repeat(40),
            "contribution_sha": "1".repeat(40),
            "sha256": "2".repeat(64),
            "installed_at": "2026-05-02T00:00:00Z",
            "granted_capabilities": granted,
            "version": "1.0.0",
        });
        std::fs::write(
            plugin_dir.join(".install_meta.json"),
            serde_json::to_string_pretty(&meta).unwrap(),
        )
        .unwrap();
    }

    #[tokio::test]
    async fn community_plugin_with_grant_superset_is_allowed() {
        // grant ⊇ manifest: pre-flight passes, op runs.
        let dir = tempfile::tempdir().unwrap();
        write_community_plugin(
            dir.path(),
            "ok-plugin",
            &[], // empty required_clis so cli_available stays true
            &["git", "gh"],
            &["echo"],
            r#"
            local M = {}
            function M.echo() return { ok = true } end
            return M
            "#,
        );
        let registry = PluginRegistry::discover(dir.path());
        let trust = &registry.plugins["ok-plugin"].trust;
        assert!(matches!(trust, PluginTrust::Community { .. }));

        let result = registry
            .call_operation("ok-plugin", "echo", serde_json::json!({}), test_workspace())
            .await
            .expect("op must succeed");
        assert_eq!(result["ok"], true);
    }

    #[tokio::test]
    async fn community_plugin_with_manifest_exceeding_grants_fails_closed() {
        // grant ⊊ manifest: pre-flight returns NeedsReconsent before
        // the script even loads. Use a CLI-less manifest? No — we need
        // required_clis to drift, and `check_clis_available` would deny
        // first if those CLIs aren't on PATH. Solve by writing the
        // plugin with empty required_clis at creation, then patching
        // the manifest so cli_available was already true at discovery.
        // A simpler approach: write plugin with empty required at
        // discovery, then mutate the LoadedPlugin fields directly.
        let dir = tempfile::tempdir().unwrap();
        write_community_plugin(
            dir.path(),
            "drift-plugin",
            &[], // discovery sees empty list → cli_available = true
            &["git"],
            &["op"],
            r#"
            local M = {}
            function M.op() return { ok = true } end
            return M
            "#,
        );
        let mut registry = PluginRegistry::discover(dir.path());
        // Simulate post-install manifest drift: registry update grew
        // required_clis. We mutate in-place rather than re-reading the
        // manifest because cli_available was determined at discovery
        // and we don't want PATH-resolution to vary the test.
        let plugin = registry.plugins.get_mut("drift-plugin").unwrap();
        plugin.manifest.required_clis =
            vec!["git".to_string(), "curl".to_string(), "sh".to_string()];

        let result = registry
            .call_operation(
                "drift-plugin",
                "op",
                serde_json::json!({}),
                test_workspace(),
            )
            .await;
        match result {
            Err(PluginError::NeedsReconsent { plugin, missing }) => {
                assert_eq!(plugin, "drift-plugin");
                assert_eq!(missing, vec!["curl".to_string(), "sh".to_string()]);
            }
            other => panic!("expected NeedsReconsent, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn community_plugin_host_exec_uses_intersection_allowlist() {
        // Discovery: granted=[git, cargo], manifest=[cargo] → effective
        // allowlist = [cargo]. host.exec("cargo") works; host.exec("git")
        // — even though it's granted — is denied because the manifest
        // doesn't declare it. (Intersection semantics: never broader
        // than what's in the manifest.)
        let dir = tempfile::tempdir().unwrap();
        write_community_plugin(
            dir.path(),
            "intersect-plugin",
            &[], // empty at discovery so cli_available = true
            &["git", "cargo"],
            &["run_cargo", "run_git"],
            r#"
            local M = {}
            function M.run_cargo()
                return host.exec("cargo", {"--version"})
            end
            function M.run_git()
                return host.exec("git", {"--version"})
            end
            return M
            "#,
        );
        let mut registry = PluginRegistry::discover(dir.path());
        // After discovery, narrow the manifest to just `cargo`. The
        // pre-flight gate sees missing=[] (cargo ∈ grants), so the
        // call proceeds; host.exec then gates against the
        // intersection grant ∩ required = {cargo}.
        let plugin = registry.plugins.get_mut("intersect-plugin").unwrap();
        plugin.manifest.required_clis = vec!["cargo".to_string()];

        let cargo_result = registry
            .call_operation(
                "intersect-plugin",
                "run_cargo",
                serde_json::json!({}),
                test_workspace(),
            )
            .await
            .expect("cargo must execute");
        assert_eq!(cargo_result["code"], 0);

        let git_result = registry
            .call_operation(
                "intersect-plugin",
                "run_git",
                serde_json::json!({}),
                test_workspace(),
            )
            .await;
        assert!(
            git_result.is_err(),
            "git must be denied — not in manifest's required_clis"
        );
        let err = git_result.unwrap_err().to_string();
        assert!(
            err.contains("not in this plugin's allowed CLIs"),
            "expected allowlist denial, got: {err}"
        );
    }

    #[tokio::test]
    async fn community_plugin_missing_install_meta_treated_as_unknown() {
        // No `.install_meta.json` at all → trust falls through to
        // Unknown (hand-installed compat). Manifest-required CLIs all
        // pass. This guards against accidentally promoting "missing
        // meta" to "deny everything" for legacy installs that pre-date
        // the grant-recording code.
        let dir = tempfile::tempdir().unwrap();
        let plugin_dir = dir.path().join("legacy-plugin");
        std::fs::create_dir(&plugin_dir).unwrap();
        std::fs::write(
            plugin_dir.join("plugin.json"),
            r#"{
                "name": "legacy-plugin",
                "display_name": "Legacy",
                "version": "1.0.0",
                "description": "no meta",
                "required_clis": [],
                "operations": ["op"]
            }"#,
        )
        .unwrap();
        std::fs::write(
            plugin_dir.join("init.lua"),
            r#"
            local M = {}
            function M.op() return { ok = true } end
            return M
            "#,
        )
        .unwrap();

        let registry = PluginRegistry::discover(dir.path());
        assert!(matches!(
            registry.plugins["legacy-plugin"].trust,
            PluginTrust::Unknown
        ));
        let result = registry
            .call_operation(
                "legacy-plugin",
                "op",
                serde_json::json!({}),
                test_workspace(),
            )
            .await
            .expect("legacy install with no meta must still run");
        assert_eq!(result["ok"], true);
    }

    #[test]
    fn bundled_plugin_dir_resolves_to_bundled_trust() {
        // A plugin whose name matches BUNDLED_PLUGINS AND has a
        // `.version` sentinel from the seeder is trusted. Capability
        // enforcement is skipped — the bundle's manifest is the
        // grant by construction.
        let dir = tempfile::tempdir().unwrap();
        let plugin_dir = dir.path().join("github");
        std::fs::create_dir(&plugin_dir).unwrap();
        std::fs::write(
            plugin_dir.join("plugin.json"),
            r#"{
                "name": "github",
                "display_name": "GitHub",
                "version": "1.0.0",
                "description": "bundled",
                "required_clis": ["git", "gh"],
                "operations": []
            }"#,
        )
        .unwrap();
        std::fs::write(plugin_dir.join("init.lua"), "return {}").unwrap();
        // Sentinel that the seeder writes — proves bundled origin.
        std::fs::write(plugin_dir.join(".version"), "0.0.0").unwrap();

        let registry = PluginRegistry::discover(dir.path());
        assert!(matches!(
            registry.plugins["github"].trust,
            PluginTrust::Bundled
        ));
        // `missing_capabilities` is empty for Bundled regardless of
        // what the manifest declares — that's the trust bypass.
        assert!(
            registry.plugins["github"]
                .trust
                .missing_capabilities(&["git".into(), "gh".into(), "anything".into()])
                .is_empty()
        );
    }

    #[test]
    fn plugin_trust_effective_allowlist_intersects_for_community() {
        let trust = PluginTrust::Community {
            granted: vec!["git".into(), "gh".into()],
        };
        let allowed = trust.effective_allowlist(&["git".into(), "curl".into()]);
        assert_eq!(allowed, vec!["git".to_string()]);
    }

    #[test]
    fn plugin_trust_effective_allowlist_passes_through_for_bundled() {
        let allowed = PluginTrust::Bundled.effective_allowlist(&["git".into(), "anything".into()]);
        assert_eq!(allowed, vec!["git".to_string(), "anything".to_string()]);
    }

    #[test]
    fn plugin_trust_missing_capabilities_diff_for_community() {
        let trust = PluginTrust::Community {
            granted: vec!["git".into()],
        };
        let missing = trust.missing_capabilities(&["git".into(), "curl".into(), "sh".into()]);
        assert_eq!(missing, vec!["curl".to_string(), "sh".to_string()]);
    }

    #[test]
    fn plugin_trust_missing_capabilities_empty_for_bundled() {
        assert!(
            PluginTrust::Bundled
                .missing_capabilities(&["anything".into()])
                .is_empty()
        );
    }

    #[test]
    fn is_bundled_plugin_recognizes_seeded_names() {
        assert!(seed::is_bundled_plugin_name("github"));
        assert!(seed::is_bundled_plugin_name("env-direnv"));
        assert!(!seed::is_bundled_plugin_name("user-installed"));
    }

    #[test]
    fn corrupt_install_meta_fails_closed_to_empty_grants() {
        // Defense in depth: a malformed `.install_meta.json`
        // (corrupt JSON, partial write, manual tampering) must NOT
        // fall through to PluginTrust::Unknown — that would let the
        // plugin run with full manifest-required_clis, defeating the
        // grant model. Resolve to Community { granted: [] } so
        // `call_operation` returns NeedsReconsent for any non-empty
        // required_clis.
        let dir = tempfile::tempdir().unwrap();
        let plugin_dir = dir.path().join("corrupt-meta");
        std::fs::create_dir(&plugin_dir).unwrap();
        std::fs::write(
            plugin_dir.join("plugin.json"),
            r#"{
                "name": "corrupt-meta",
                "display_name": "Corrupt",
                "version": "1.0.0",
                "description": "meta is broken",
                "operations": []
            }"#,
        )
        .unwrap();
        std::fs::write(plugin_dir.join("init.lua"), "return {}").unwrap();
        // Garbage bytes — not valid JSON.
        std::fs::write(
            plugin_dir.join(".install_meta.json"),
            "this is not json\x00",
        )
        .unwrap();

        let registry = PluginRegistry::discover(dir.path());
        match &registry.plugins["corrupt-meta"].trust {
            PluginTrust::Community { granted } => assert!(
                granted.is_empty(),
                "corrupt meta must fail closed with empty grants"
            ),
            other => panic!("expected Community trust (fail-closed), got {other:?}"),
        }
    }

    #[test]
    fn bundled_name_without_version_sentinel_is_unknown() {
        // Defense in depth: if a user creates a plugin dir named
        // `github` but never had it seeded (no `.version`), we treat
        // it as Unknown rather than auto-promoting to Bundled — a
        // shadowed bundle could otherwise dodge enforcement.
        let dir = tempfile::tempdir().unwrap();
        let plugin_dir = dir.path().join("github");
        std::fs::create_dir(&plugin_dir).unwrap();
        std::fs::write(
            plugin_dir.join("plugin.json"),
            r#"{
                "name": "github",
                "display_name": "User Github",
                "version": "1.0.0",
                "description": "shadow",
                "operations": []
            }"#,
        )
        .unwrap();
        std::fs::write(plugin_dir.join("init.lua"), "return {}").unwrap();
        // No .version — discovery must NOT mark this as bundled.

        let registry = PluginRegistry::discover(dir.path());
        assert!(matches!(
            registry.plugins["github"].trust,
            PluginTrust::Unknown
        ));
    }
}
