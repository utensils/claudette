//! Backend trait abstracting plugin invocation for the env-provider
//! dispatcher.
//!
//! The dispatcher is generic over this trait so unit tests can drive it
//! with a synthetic [`mock::MockBackend`] without spinning up a real
//! [`PluginRegistry`] (which needs a Lua VM per call, making unit tests
//! expensive).
//!
//! The real implementation [`PluginRegistryBackend`] wraps a
//! `&PluginRegistry` and forwards calls to `call_operation`.

use std::future::Future;
use std::path::{Path, PathBuf};

use crate::plugin_runtime::host_api::WorkspaceInfo;
use crate::plugin_runtime::manifest::PluginKind;
use crate::plugin_runtime::{PluginError, PluginRegistry};

use super::types::{EnvMap, ProviderExport};

/// Abstraction over the plugin runtime for the env-provider dispatcher.
///
/// Two impls:
/// - [`PluginRegistryBackend`]: production — calls into the real Lua runtime.
/// - `mock::MockBackend`: tests — returns canned results synchronously.
pub trait EnvProviderBackend: Send + Sync {
    /// Names of all loaded plugins whose manifest declares
    /// `kind = "env-provider"`.
    fn env_provider_names(&self) -> Vec<String>;

    /// True when the plugin is globally disabled and must not run,
    /// regardless of per-repo toggle state. The dispatcher checks this
    /// alongside the caller-supplied `disabled` HashSet and treats a
    /// hit identically — invalidates the cache and records a
    /// `disabled` source. Keeping the check on the backend (rather
    /// than relying on callers to merge in the registry's state) makes
    /// direct uses of [`resolve_for_workspace`] safe too.
    fn is_plugin_disabled(&self, _plugin: &str) -> bool {
        false
    }

    /// True when the plugin's required CLI (e.g. `nix`, `mise`,
    /// `direnv`) is not on PATH and so the plugin cannot run. Distinct
    /// from `is_plugin_disabled` — the user did not turn this off; the
    /// system simply doesn't have the tool. The dispatcher treats this
    /// as a silent skip with `error: "unavailable"` rather than letting
    /// the runtime's `CliNotFound` bubble up to a user-facing toast on
    /// every workspace switch. See issue #718. Default `false` keeps
    /// existing callers (including [`mock::MockBackend`] in non-`unavailable`
    /// tests) on the prior behavior.
    fn is_plugin_unavailable(&self, _plugin: &str) -> bool {
        false
    }

    /// Run the plugin's `detect` operation. Returns `true` if the
    /// plugin wants to contribute env for this worktree.
    fn detect(
        &self,
        plugin: &str,
        worktree: &Path,
        ws_info: &WorkspaceInfo,
    ) -> impl Future<Output = Result<bool, PluginError>> + Send;

    /// Run the plugin's `export` operation. Only called when `detect`
    /// returned `true`.
    fn export(
        &self,
        plugin: &str,
        worktree: &Path,
        ws_info: &WorkspaceInfo,
    ) -> impl Future<Output = Result<ProviderExport, PluginError>> + Send;
}

/// Production backend wrapping a [`PluginRegistry`].
pub struct PluginRegistryBackend<'a> {
    pub registry: &'a PluginRegistry,
}

impl<'a> PluginRegistryBackend<'a> {
    pub fn new(registry: &'a PluginRegistry) -> Self {
        Self { registry }
    }
}

impl EnvProviderBackend for PluginRegistryBackend<'_> {
    fn env_provider_names(&self) -> Vec<String> {
        self.registry
            .plugins
            .iter()
            .filter(|(_, p)| p.manifest.kind == PluginKind::EnvProvider)
            .map(|(name, _)| name.clone())
            .collect()
    }

    fn is_plugin_disabled(&self, plugin: &str) -> bool {
        self.registry.is_disabled(plugin)
    }

    fn is_plugin_unavailable(&self, plugin: &str) -> bool {
        // Re-consent must always surface (#580): if the live manifest
        // grew a CLI requirement the user hasn't approved, the
        // dispatcher must NOT swallow that as a silent "not installed"
        // skip — the user needs to see the prompt regardless of
        // whether the new tool is on PATH yet. Falling through here
        // lets `call_operation` return `NeedsReconsent` from the
        // detect/export call, which `resolve_one` records as an error.
        if self.registry.needs_reconsent(plugin) {
            return false;
        }
        !self.registry.is_cli_available(plugin)
    }

    async fn detect(
        &self,
        plugin: &str,
        worktree: &Path,
        ws_info: &WorkspaceInfo,
    ) -> Result<bool, PluginError> {
        let args = serde_json::json!({
            "worktree": worktree.to_string_lossy(),
        });
        let result = self
            .registry
            .call_operation(plugin, "detect", args, ws_info.clone())
            .await?;
        Ok(result.as_bool().unwrap_or(false))
    }

    async fn export(
        &self,
        plugin: &str,
        worktree: &Path,
        ws_info: &WorkspaceInfo,
    ) -> Result<ProviderExport, PluginError> {
        let args = serde_json::json!({
            "worktree": worktree.to_string_lossy(),
        });
        let result = self
            .registry
            .call_operation(plugin, "export", args, ws_info.clone())
            .await?;

        // Expected shape: { env: { KEY: "value" | nil, ... }, watched: ["path", ...] }
        let obj = result.as_object().ok_or_else(|| {
            PluginError::ParseError(format!(
                "{plugin}: export() must return a table with `env` and `watched` fields"
            ))
        })?;

        let env = match obj.get("env").and_then(|v| v.as_object()) {
            Some(m) => {
                let mut env = EnvMap::new();
                for (k, v) in m.iter() {
                    let val = match v {
                        serde_json::Value::Null => None,
                        serde_json::Value::String(s) => Some(s.clone()),
                        // OS env vars are strings. Silently stringifying
                        // objects/arrays/numbers would hide plugin bugs —
                        // surface them as a clear parse error instead.
                        _ => {
                            return Err(PluginError::ParseError(format!(
                                "{plugin}: export().env[{k:?}] must be a string or null"
                            )));
                        }
                    };
                    env.insert(k.clone(), val);
                }
                env
            }
            None => EnvMap::default(),
        };

        // Normalize every watched entry to an absolute path. Plugin
        // authors naturally return relative names (".envrc",
        // "mise.toml", "flake.lock"), and our bundled plugins already
        // join to worktree — but third-party plugins shouldn't have to
        // think about this, and without the join EnvCache would stat
        // relative paths against the app's CWD and silently never
        // invalidate.
        let watched: Vec<PathBuf> = obj
            .get("watched")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str())
                    .map(|s| {
                        let p = PathBuf::from(s);
                        if p.is_relative() { worktree.join(p) } else { p }
                    })
                    .collect()
            })
            .unwrap_or_default();

        Ok(ProviderExport { env, watched })
    }
}

#[cfg(test)]
pub(crate) mod mock {
    //! Synthetic backend for dispatcher unit tests.

    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    pub struct MockBackend {
        pub plugins: Vec<String>,
        /// Controls what each plugin's detect returns. Default (absent): false.
        pub detect_results: HashMap<String, Result<bool, String>>,
        /// Controls what each plugin's export returns.
        pub export_results: HashMap<String, Result<ProviderExport, String>>,
        /// Counts per plugin: (detect_calls, export_calls). Used by tests to
        /// assert cache behavior (e.g., that export was NOT called on a cache hit).
        pub calls: Mutex<HashMap<String, (usize, usize)>>,
        /// Plugin names that should report as globally disabled.
        pub globally_disabled: std::collections::HashSet<String>,
        /// Plugin names whose required CLI is not on PATH. Surfaced via
        /// [`EnvProviderBackend::is_plugin_unavailable`]; the dispatcher
        /// then short-circuits the same way it does for `disabled`.
        pub unavailable: std::collections::HashSet<String>,
    }

    impl MockBackend {
        pub fn new() -> Self {
            Self {
                plugins: vec![],
                detect_results: HashMap::new(),
                export_results: HashMap::new(),
                calls: Mutex::new(HashMap::new()),
                globally_disabled: std::collections::HashSet::new(),
                unavailable: std::collections::HashSet::new(),
            }
        }

        pub fn with_globally_disabled(mut self, name: &str) -> Self {
            self.globally_disabled.insert(name.to_string());
            self
        }

        pub fn with_unavailable(mut self, name: &str) -> Self {
            self.unavailable.insert(name.to_string());
            self
        }

        pub fn with_plugin(mut self, name: &str) -> Self {
            self.plugins.push(name.to_string());
            self
        }

        pub fn detects(mut self, name: &str, value: bool) -> Self {
            self.detect_results.insert(name.to_string(), Ok(value));
            self
        }

        pub fn exports(mut self, name: &str, export: ProviderExport) -> Self {
            self.export_results.insert(name.to_string(), Ok(export));
            self
        }

        pub fn export_fails(mut self, name: &str, msg: &str) -> Self {
            self.export_results
                .insert(name.to_string(), Err(msg.to_string()));
            self
        }

        pub fn call_counts(&self, name: &str) -> (usize, usize) {
            self.calls
                .lock()
                .unwrap()
                .get(name)
                .copied()
                .unwrap_or((0, 0))
        }
    }

    impl EnvProviderBackend for MockBackend {
        fn env_provider_names(&self) -> Vec<String> {
            self.plugins.clone()
        }

        fn is_plugin_disabled(&self, plugin: &str) -> bool {
            self.globally_disabled.contains(plugin)
        }

        fn is_plugin_unavailable(&self, plugin: &str) -> bool {
            self.unavailable.contains(plugin)
        }

        async fn detect(
            &self,
            plugin: &str,
            _worktree: &Path,
            _ws_info: &WorkspaceInfo,
        ) -> Result<bool, PluginError> {
            self.calls
                .lock()
                .unwrap()
                .entry(plugin.to_string())
                .or_default()
                .0 += 1;
            match self.detect_results.get(plugin) {
                Some(Ok(v)) => Ok(*v),
                Some(Err(e)) => Err(PluginError::ScriptError(e.clone())),
                None => Ok(false),
            }
        }

        async fn export(
            &self,
            plugin: &str,
            _worktree: &Path,
            _ws_info: &WorkspaceInfo,
        ) -> Result<ProviderExport, PluginError> {
            self.calls
                .lock()
                .unwrap()
                .entry(plugin.to_string())
                .or_default()
                .1 += 1;
            match self.export_results.get(plugin) {
                Some(Ok(v)) => Ok(v.clone()),
                Some(Err(e)) => Err(PluginError::ScriptError(e.clone())),
                None => Err(PluginError::OperationNotSupported("export".into())),
            }
        }
    }
}
