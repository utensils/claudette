pub mod detect;
pub mod host_api;
pub mod manifest;
pub mod scm;
pub mod seed;

use std::collections::HashMap;
use std::fmt;
use std::path::{Path, PathBuf};

use host_api::{HostContext, WorkspaceInfo};
use manifest::PluginManifest;
use mlua::LuaSerdeExt;

#[derive(Debug)]
pub struct LoadedPlugin {
    pub manifest: PluginManifest,
    pub dir: PathBuf,
    pub config: HashMap<String, serde_json::Value>,
    pub cli_available: bool,
}

#[derive(Debug, Clone)]
pub enum ScmError {
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
}

impl fmt::Display for ScmError {
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
            Self::NoProvider => write!(f, "No SCM provider configured for this repository"),
            Self::OperationNotSupported(op) => write!(f, "Operation '{op}' is not supported"),
            Self::PluginNotFound(name) => write!(f, "Plugin '{name}' not found"),
        }
    }
}

impl std::error::Error for ScmError {}

impl serde::Serialize for ScmError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub struct PluginRegistry {
    pub plugins: HashMap<String, LoadedPlugin>,
    pub plugin_dir: PathBuf,
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
        }
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
    ) -> Result<serde_json::Value, ScmError> {
        let plugin = self
            .plugins
            .get(plugin_name)
            .ok_or_else(|| ScmError::PluginNotFound(plugin_name.to_string()))?;

        if !plugin.cli_available {
            let cli_list = plugin.manifest.required_clis.join(", ");
            return Err(ScmError::CliNotFound(cli_list));
        }

        if !plugin.manifest.operations.contains(&operation.to_string()) {
            return Err(ScmError::OperationNotSupported(operation.to_string()));
        }

        let init_path = plugin.dir.join("init.lua");
        let script = std::fs::read_to_string(&init_path)
            .map_err(|e| ScmError::ScriptError(format!("Failed to read init.lua: {e}")))?;

        let ctx = HostContext {
            plugin_name: plugin_name.to_string(),
            allowed_clis: plugin.manifest.required_clis.clone(),
            workspace_info,
            config: plugin.config.clone(),
        };

        let lua = host_api::create_lua_vm(ctx).map_err(|e| ScmError::ScriptError(e.to_string()))?;

        // Load and execute the plugin script to get the module table
        let module: mlua::Table = lua
            .load(&script)
            .set_name(format!("plugins/{plugin_name}/init.lua"))
            .eval_async()
            .await
            .map_err(|e| ScmError::ScriptError(format!("Failed to load plugin: {e}")))?;

        // Get the operation function
        let func: mlua::Function = module
            .get(operation)
            .map_err(|e| ScmError::OperationNotSupported(format!("{operation}: {e}")))?;

        // Convert args to Lua value
        let lua_args = lua
            .to_value(&args)
            .map_err(|e| ScmError::ParseError(format!("Failed to convert args: {e}")))?;

        // Call the operation
        let result: mlua::Value = func.call_async(lua_args).await.map_err(|e: mlua::Error| {
            let msg = e.to_string();
            // Detect auth errors from CLI tools
            if msg.contains("auth") || msg.contains("login") || msg.contains("401") {
                let cli = plugin
                    .manifest
                    .required_clis
                    .first()
                    .cloned()
                    .unwrap_or_default();
                return ScmError::CliAuthError(cli);
            }
            ScmError::ScriptError(msg)
        })?;

        // Convert result to JSON
        lua.from_value(result)
            .map_err(|e| ScmError::ParseError(format!("Failed to convert result: {e}")))
    }

    /// Get the plugin directory path.
    pub fn plugin_dir(&self) -> &Path {
        &self.plugin_dir
    }
}

/// Check if all required CLI tools are available on PATH.
fn check_clis_available(clis: &[String]) -> bool {
    clis.iter().all(|cli| which_cli(cli))
}

/// Check if a CLI tool is available on PATH.
fn which_cli(name: &str) -> bool {
    std::process::Command::new("which")
        .arg(name)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

#[cfg(test)]
mod tests {
    use super::*;

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

        assert!(matches!(result, Err(ScmError::PluginNotFound(_))));
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

        assert!(matches!(result, Err(ScmError::OperationNotSupported(_))));
    }
}
