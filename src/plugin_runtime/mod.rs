pub mod host_api;
pub mod manifest;
pub mod seed;

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::{Duration, Instant};

use host_api::{HostContext, WorkspaceInfo};
use manifest::PluginManifest;
use mlua::{LuaSerdeExt, VmState};

/// Overall operation timeout. A plugin can make multiple serial
/// `host.exec` calls (each capped at 30s), but pure-Lua loops have no
/// inner cap. This bounds the total time a single call_operation can
/// hang the polling loop or a Tauri command.
const OPERATION_TIMEOUT: Duration = Duration::from_secs(60);
const LUA_OPERATION_TIMEOUT: &str = "__claudette_lua_operation_timeout__";

#[derive(Debug)]
pub struct LoadedPlugin {
    pub manifest: PluginManifest,
    pub dir: PathBuf,
    pub config: HashMap<String, serde_json::Value>,
    pub cli_available: bool,
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
                eprintln!(
                    "[plugin] Failed to read plugin directory {}: {e}",
                    plugin_dir.display()
                );
                return Self {
                    plugins,
                    plugin_dir: plugin_dir.to_path_buf(),
                    setting_overrides: RwLock::new(HashMap::new()),
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
            let init_path = path.join("init.lua");

            if !manifest_path.exists() || !init_path.exists() {
                let name = path.file_name().unwrap_or_default().to_string_lossy();
                eprintln!("[plugin] Skipping '{name}': missing plugin.json or init.lua");
                continue;
            }

            match manifest::parse_manifest(&manifest_path) {
                Ok(manifest) => {
                    let cli_available = check_clis_available(&manifest.required_clis);
                    let name = manifest.name.clone();
                    plugins.insert(
                        name,
                        LoadedPlugin {
                            manifest,
                            dir: path,
                            config: HashMap::new(),
                            cli_available,
                        },
                    );
                }
                Err(e) => {
                    eprintln!("[plugin] {e}");
                }
            }
        }

        Self {
            plugins,
            plugin_dir: plugin_dir.to_path_buf(),
            setting_overrides: RwLock::new(HashMap::new()),
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

    /// Return the effective config map a plugin's Lua VM will see.
    /// Precedence (lowest → highest): manifest `settings[].default` →
    /// static `plugin.config` → user setting overrides.
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
        self.call_operation_with_timeout(
            plugin_name,
            operation,
            args,
            workspace_info,
            OPERATION_TIMEOUT,
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
    ) -> Result<serde_json::Value, PluginError> {
        let plugin = self
            .plugins
            .get(plugin_name)
            .ok_or_else(|| PluginError::PluginNotFound(plugin_name.to_string()))?;

        if self.is_disabled(plugin_name) {
            return Err(PluginError::PluginDisabled(plugin_name.to_string()));
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

        let ctx = HostContext {
            plugin_name: plugin_name.to_string(),
            kind: plugin.manifest.kind,
            allowed_clis: plugin.manifest.required_clis.clone(),
            workspace_info,
            config: self.effective_config(plugin_name),
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
            let lua_args = lua
                .to_value(&args)
                .map_err(|e| PluginError::ParseError(format!("Failed to convert args: {e}")))?;

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
            lua.from_value(result)
                .map_err(|e| PluginError::ParseError(format!("Failed to convert result: {e}")))
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

fn install_operation_timeout_interrupt(lua: &mlua::Lua, operation_timeout: Duration) {
    let deadline = Instant::now() + operation_timeout;
    lua.set_interrupt(move |_| {
        if Instant::now() >= deadline {
            Err(mlua::Error::external(LUA_OPERATION_TIMEOUT))
        } else {
            Ok(VmState::Continue)
        }
    });
}

fn is_lua_operation_timeout(error: &mlua::Error) -> bool {
    error.to_string().contains(LUA_OPERATION_TIMEOUT)
}

/// Check if all required CLI tools are available on PATH.
///
/// Uses the enriched PATH (login-shell probed) so Homebrew-installed CLIs
/// like `gh`/`glab` resolve correctly when the app is launched from Finder.
fn check_clis_available(clis: &[String]) -> bool {
    clis.iter()
        .all(|cli| crate::env::which_in_enriched_path(cli).is_ok())
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

        let ws = WorkspaceInfo {
            id: "ws-1".to_string(),
            name: "test".to_string(),
            branch: "main".to_string(),
            worktree_path: "/tmp".to_string(),
            repo_path: "/tmp".to_string(),
        };

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

    fn test_workspace() -> WorkspaceInfo {
        WorkspaceInfo {
            id: "ws-1".to_string(),
            name: "test".to_string(),
            branch: "main".to_string(),
            worktree_path: "/tmp".to_string(),
            repo_path: "/tmp".to_string(),
        }
    }

    #[tokio::test]
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
        let result = registry
            .call_operation_with_timeout(
                "top-level-loop",
                "run",
                serde_json::json!({}),
                test_workspace(),
                Duration::from_millis(100),
            )
            .await;

        assert!(matches!(result, Err(PluginError::Timeout)));
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "CPU-bound Lua load should abort promptly"
        );
    }

    #[tokio::test]
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
        let result = registry
            .call_operation_with_timeout(
                "operation-loop",
                "run",
                serde_json::json!({}),
                test_workspace(),
                Duration::from_millis(100),
            )
            .await;

        assert!(matches!(result, Err(PluginError::Timeout)));
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "CPU-bound Lua operation should abort promptly"
        );
    }

    #[tokio::test]
    async fn test_call_operation_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let registry = PluginRegistry::discover(dir.path());

        let ws = WorkspaceInfo {
            id: "ws-1".to_string(),
            name: "test".to_string(),
            branch: "main".to_string(),
            worktree_path: "/tmp".to_string(),
            repo_path: "/tmp".to_string(),
        };

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

        let ws = WorkspaceInfo {
            id: "ws-1".to_string(),
            name: "test".to_string(),
            branch: "main".to_string(),
            worktree_path: "/tmp".to_string(),
            repo_path: "/tmp".to_string(),
        };

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

        let ws = WorkspaceInfo {
            id: "ws-1".into(),
            name: "test".into(),
            branch: "main".into(),
            worktree_path: "/tmp".into(),
            repo_path: "/tmp".into(),
        };
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

        let ws = WorkspaceInfo {
            id: "ws-1".into(),
            name: "test".into(),
            branch: "main".into(),
            worktree_path: "/tmp".into(),
            repo_path: "/tmp".into(),
        };
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
}
