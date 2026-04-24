use std::collections::HashMap;
use std::time::Duration;

use crate::process::CommandWindowExt as _;
use mlua::LuaSerdeExt;
use mlua::prelude::*;
use tokio::process::Command;

/// Context passed to the Lua host API functions.
#[derive(Debug, Clone)]
pub struct HostContext {
    pub plugin_name: String,
    pub allowed_clis: Vec<String>,
    pub workspace_info: WorkspaceInfo,
    pub config: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone)]
pub struct WorkspaceInfo {
    pub id: String,
    pub name: String,
    pub branch: String,
    pub worktree_path: String,
    pub repo_path: String,
}

const EXEC_TIMEOUT: Duration = Duration::from_secs(30);

/// CLIs that are always allowed regardless of manifest declarations.
const ALWAYS_ALLOWED_CLIS: &[&str] = &["git"];

/// Create a sandboxed Lua VM with the host API registered.
pub fn create_lua_vm(ctx: HostContext) -> LuaResult<Lua> {
    let lua = Lua::new();

    // Remove dangerous standard libraries
    sandbox_stdlib(&lua)?;

    // Register the host table
    register_host_api(&lua, ctx)?;

    Ok(lua)
}

/// Remove os and io standard libraries from the Lua VM.
fn sandbox_stdlib(lua: &Lua) -> LuaResult<()> {
    let globals = lua.globals();
    globals.set("os", LuaNil)?;
    globals.set("io", LuaNil)?;
    globals.set("loadfile", LuaNil)?;
    globals.set("dofile", LuaNil)?;
    Ok(())
}

/// Register the `host` table with all API functions.
fn register_host_api(lua: &Lua, ctx: HostContext) -> LuaResult<()> {
    let host = lua.create_table()?;

    // host.exec(cmd, args) -> {stdout, stderr, code}
    let exec_ctx = ctx.clone();
    host.set(
        "exec",
        lua.create_async_function(move |lua, (cmd, args): (String, LuaTable)| {
            let ctx = exec_ctx.clone();
            async move { host_exec(&lua, &cmd, args, &ctx).await }
        })?,
    )?;

    // host.json_decode(str) -> table
    host.set(
        "json_decode",
        lua.create_function(|lua, s: String| {
            let value: serde_json::Value =
                serde_json::from_str(&s).map_err(|e| LuaError::external(e.to_string()))?;
            lua.to_value(&value)
        })?,
    )?;

    // host.json_encode(table) -> string
    host.set(
        "json_encode",
        lua.create_function(|lua, value: LuaValue| {
            let json_value: serde_json::Value = lua.from_value(value)?;
            serde_json::to_string(&json_value).map_err(|e| LuaError::external(e.to_string()))
        })?,
    )?;

    // host.workspace() -> {id, name, branch, worktree_path, repo_path}
    let ws = ctx.workspace_info.clone();
    host.set(
        "workspace",
        lua.create_function(move |lua, ()| {
            let table = lua.create_table()?;
            table.set("id", ws.id.clone())?;
            table.set("name", ws.name.clone())?;
            table.set("branch", ws.branch.clone())?;
            table.set("worktree_path", ws.worktree_path.clone())?;
            table.set("repo_path", ws.repo_path.clone())?;
            Ok(table)
        })?,
    )?;

    // host.config(key) -> value or nil
    let config = ctx.config.clone();
    host.set(
        "config",
        lua.create_function(move |lua, key: String| match config.get(&key) {
            Some(val) => lua.to_value(val),
            None => Ok(LuaNil),
        })?,
    )?;

    // host.log(level, msg)
    let plugin_name = ctx.plugin_name.clone();
    host.set(
        "log",
        lua.create_function(move |_, (level, msg): (String, String)| {
            eprintln!("[plugin:{plugin_name}] [{level}] {msg}");
            Ok(())
        })?,
    )?;

    // host.file_exists(path) -> bool
    //
    // Sandbox-safe: takes an explicit path string from the plugin. The
    // sandbox removed `io`/`os`, so plugins can't probe the filesystem
    // on their own — this host-provided helper is the only way to check
    // for the presence of config files (`.envrc`, `mise.toml`, `.env`,
    // `flake.nix`, etc.) that env providers detect on.
    //
    // Returns true for both files and directories — providers that need
    // finer distinction can call `host.read_file` (which errors on dirs).
    host.set(
        "file_exists",
        lua.create_function(|_, path: String| {
            if path.contains('\0') {
                return Err(LuaError::external("path must not contain null bytes"));
            }
            Ok(std::path::Path::new(&path).exists())
        })?,
    )?;

    // host.read_file(path) -> string
    //
    // Reads the file at `path` as UTF-8. Used by env providers that
    // parse config files in-process (e.g. dotenv's `.env` parser) rather
    // than shelling out to an external tool.
    //
    // Raises a Lua error on missing files, unreadable files, or non-UTF-8
    // contents. Plugins can wrap calls in `pcall` if they need to handle
    // the failure themselves.
    host.set(
        "read_file",
        lua.create_function(|_, path: String| {
            if path.contains('\0') {
                return Err(LuaError::external("path must not contain null bytes"));
            }
            std::fs::read_to_string(&path)
                .map_err(|e| LuaError::external(format!("failed to read '{path}': {e}")))
        })?,
    )?;

    lua.globals().set("host", host)?;
    Ok(())
}

/// Execute a subprocess, restricted to allowed CLIs.
async fn host_exec(
    lua: &Lua,
    cmd: &str,
    args_table: LuaTable,
    ctx: &HostContext,
) -> LuaResult<LuaTable> {
    // Validate command is in the allowlist
    let is_always_allowed = ALWAYS_ALLOWED_CLIS.contains(&cmd);
    let is_declared = ctx.allowed_clis.iter().any(|c| c == cmd);
    if !is_always_allowed && !is_declared {
        return Err(LuaError::external(format!(
            "Command '{cmd}' is not in this plugin's allowed CLIs: {:?}",
            ctx.allowed_clis
        )));
    }

    // Collect args from Lua table
    let mut args: Vec<String> = Vec::new();
    for i in 1..=args_table.len()? {
        let arg: String = args_table.get(i)?;
        // Reject null bytes
        if arg.contains('\0') {
            return Err(LuaError::external("Arguments must not contain null bytes"));
        }
        args.push(arg);
    }

    // Build and execute the command with kill_on_drop so timed-out
    // processes don't leak.
    let mut command = Command::new(cmd);
    command.no_console_window();
    command.args(&args);
    command.current_dir(&ctx.workspace_info.worktree_path);
    // macOS GUI apps inherit a minimal launchd PATH, so binaries like
    // `gh`/`glab` (typically in /opt/homebrew/bin) wouldn't be found.
    // Pass the enriched PATH so the child — and anything it shells out
    // to (git, credential helpers, editors) — can resolve them.
    command.env("PATH", crate::env::enriched_path());
    command.kill_on_drop(true);
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());

    let child = command
        .spawn()
        .map_err(|e| LuaError::external(format!("Failed to execute '{cmd}': {e}")))?;

    // Run with timeout — kill_on_drop ensures the child is killed if
    // the future is dropped on timeout.
    let output = tokio::time::timeout(EXEC_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| {
            LuaError::external(format!(
                "Command '{cmd}' timed out after {}s",
                EXEC_TIMEOUT.as_secs()
            ))
        })?
        .map_err(|e| LuaError::external(format!("Failed to execute '{cmd}': {e}")))?;

    let result = lua.create_table()?;
    result.set(
        "stdout",
        String::from_utf8_lossy(&output.stdout).to_string(),
    )?;
    result.set(
        "stderr",
        String::from_utf8_lossy(&output.stderr).to_string(),
    )?;
    result.set("code", output.status.code().unwrap_or(-1))?;

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a context whose `worktree_path` is a real directory so
    /// `Command::current_dir` actually works. Hardcoding `/tmp` worked
    /// on Unix but fails on Windows (no `/tmp` → `ERROR_DIRECTORY`).
    /// `std::env::temp_dir()` resolves per-platform — `/tmp` on Unix,
    /// `%TEMP%` on Windows.
    fn make_test_ctx() -> HostContext {
        let tmp = std::env::temp_dir().to_string_lossy().into_owned();
        HostContext {
            plugin_name: "test".to_string(),
            // `cargo` is cross-platform, guaranteed to be in PATH on
            // any Rust CI host, and produces stable human-readable
            // output. `echo` would be simpler but is a `cmd.exe`
            // builtin on Windows — there's no `echo.exe` on PATH, so
            // spawning it directly via `Command::new` fails.
            allowed_clis: vec!["cargo".to_string()],
            workspace_info: WorkspaceInfo {
                id: "ws-1".to_string(),
                name: "test-workspace".to_string(),
                branch: "main".to_string(),
                worktree_path: tmp.clone(),
                repo_path: tmp,
            },
            config: HashMap::new(),
        }
    }

    #[test]
    fn test_sandbox_removes_dangerous_libs() {
        let ctx = make_test_ctx();
        let lua = create_lua_vm(ctx).unwrap();
        let globals = lua.globals();

        // os and io should be nil
        assert!(globals.get::<LuaValue>("os").unwrap().is_nil());
        assert!(globals.get::<LuaValue>("io").unwrap().is_nil());
        assert!(globals.get::<LuaValue>("loadfile").unwrap().is_nil());
        assert!(globals.get::<LuaValue>("dofile").unwrap().is_nil());

        // Basic Lua functionality should still work
        assert!(globals.get::<LuaValue>("table").unwrap().is_table());
        assert!(globals.get::<LuaValue>("string").unwrap().is_table());
        assert!(globals.get::<LuaValue>("math").unwrap().is_table());
    }

    #[test]
    fn test_host_table_is_registered() {
        let ctx = make_test_ctx();
        let lua = create_lua_vm(ctx).unwrap();
        let host: LuaTable = lua.globals().get("host").unwrap();

        // All host functions should exist
        assert!(host.get::<LuaValue>("exec").unwrap().is_function());
        assert!(host.get::<LuaValue>("json_decode").unwrap().is_function());
        assert!(host.get::<LuaValue>("json_encode").unwrap().is_function());
        assert!(host.get::<LuaValue>("workspace").unwrap().is_function());
        assert!(host.get::<LuaValue>("config").unwrap().is_function());
        assert!(host.get::<LuaValue>("log").unwrap().is_function());
    }

    #[test]
    fn test_json_decode() {
        let ctx = make_test_ctx();
        let lua = create_lua_vm(ctx).unwrap();
        let result: LuaTable = lua
            .load(r#"return host.json_decode('{"name":"test","count":42}')"#)
            .eval()
            .unwrap();

        assert_eq!(result.get::<String>("name").unwrap(), "test");
        assert_eq!(result.get::<i64>("count").unwrap(), 42);
    }

    #[test]
    fn test_json_encode() {
        let ctx = make_test_ctx();
        let lua = create_lua_vm(ctx).unwrap();
        let result: String = lua
            .load(r#"return host.json_encode({name = "test", count = 42})"#)
            .eval()
            .unwrap();

        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["name"], "test");
        assert_eq!(parsed["count"], 42);
    }

    #[test]
    fn test_workspace_info() {
        let ctx = make_test_ctx();
        let lua = create_lua_vm(ctx).unwrap();
        let ws: LuaTable = lua.load("return host.workspace()").eval().unwrap();

        assert_eq!(ws.get::<String>("id").unwrap(), "ws-1");
        assert_eq!(ws.get::<String>("name").unwrap(), "test-workspace");
        assert_eq!(ws.get::<String>("branch").unwrap(), "main");
    }

    #[test]
    fn test_config_value() {
        let mut ctx = make_test_ctx();
        ctx.config
            .insert("key1".to_string(), serde_json::json!("value1"));

        let lua = create_lua_vm(ctx).unwrap();

        let result: String = lua.load(r#"return host.config("key1")"#).eval().unwrap();
        assert_eq!(result, "value1");

        // Non-existent key returns nil
        let result: LuaValue = lua
            .load(r#"return host.config("nonexistent")"#)
            .eval()
            .unwrap();
        assert!(result.is_nil());
    }

    #[tokio::test]
    async fn test_exec_allowed_cli() {
        let ctx = make_test_ctx();
        let lua = create_lua_vm(ctx).unwrap();

        let result: LuaTable = lua
            .load(r#"return host.exec("cargo", {"--version"})"#)
            .eval_async()
            .await
            .unwrap();

        let stdout: String = result.get("stdout").unwrap();
        assert!(
            stdout.trim().starts_with("cargo "),
            "expected `cargo --version` stdout to start with \"cargo \", got: {stdout:?}",
        );
        assert_eq!(result.get::<i32>("code").unwrap(), 0);
    }

    #[tokio::test]
    async fn test_exec_disallowed_cli() {
        let ctx = make_test_ctx();
        let lua = create_lua_vm(ctx).unwrap();

        let result: LuaResult<LuaTable> = lua
            .load(r#"return host.exec("rm", {"-rf", "/"})"#)
            .eval_async()
            .await;

        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("not in this plugin's allowed CLIs"));
    }

    #[tokio::test]
    async fn test_exec_git_always_allowed() {
        let ctx = make_test_ctx();
        let lua = create_lua_vm(ctx).unwrap();

        // git should work even though it's not in allowed_clis
        let result: LuaTable = lua
            .load(r#"return host.exec("git", {"--version"})"#)
            .eval_async()
            .await
            .unwrap();

        let stdout: String = result.get("stdout").unwrap();
        assert!(stdout.contains("git version"));
    }

    #[tokio::test]
    async fn test_exec_null_byte_rejection() {
        let ctx = make_test_ctx();
        let lua = create_lua_vm(ctx).unwrap();

        // Use the allowed cmd — the null-byte check must fire *after*
        // the allowlist check, so using a non-allowed cmd would hit the
        // earlier error path and never exercise the branch we want to
        // cover.
        let result: LuaResult<LuaTable> = lua
            .load(r#"return host.exec("cargo", {"--version\0"})"#)
            .eval_async()
            .await;

        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("null bytes"));
    }

    #[test]
    fn test_host_file_exists_true() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("marker.txt");
        std::fs::write(&file, "hi").unwrap();

        let ctx = make_test_ctx();
        let lua = create_lua_vm(ctx).unwrap();
        let path = file.to_string_lossy().into_owned();
        let exists: bool = lua
            .load(format!(r#"return host.file_exists("{path}")"#))
            .eval()
            .unwrap();
        assert!(exists, "existing file should return true");
    }

    #[test]
    fn test_host_file_exists_false() {
        let ctx = make_test_ctx();
        let lua = create_lua_vm(ctx).unwrap();
        // Cross-platform nonexistent path: tempdir + a child that never got created.
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("does-not-exist.xyz");
        let path = missing.to_string_lossy().into_owned();
        let exists: bool = lua
            .load(format!(r#"return host.file_exists("{path}")"#))
            .eval()
            .unwrap();
        assert!(!exists, "missing file should return false");
    }

    #[test]
    fn test_host_file_exists_directory_returns_true() {
        // Documented behavior: file_exists returns true for directories too.
        // Providers that need file-vs-dir distinction can use host.read_file
        // (which errors on directories) to disambiguate.
        let tmp = tempfile::tempdir().unwrap();
        let ctx = make_test_ctx();
        let lua = create_lua_vm(ctx).unwrap();
        let path = tmp.path().to_string_lossy().into_owned();
        let exists: bool = lua
            .load(format!(r#"return host.file_exists("{path}")"#))
            .eval()
            .unwrap();
        assert!(exists, "existing directory should return true");
    }

    #[test]
    fn test_host_read_file_returns_contents() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("data.env");
        std::fs::write(&file, "FOO=bar\nBAZ=qux\n").unwrap();

        let ctx = make_test_ctx();
        let lua = create_lua_vm(ctx).unwrap();
        let path = file.to_string_lossy().into_owned();
        let contents: String = lua
            .load(format!(r#"return host.read_file("{path}")"#))
            .eval()
            .unwrap();
        assert_eq!(contents, "FOO=bar\nBAZ=qux\n");
    }

    #[test]
    fn test_host_read_file_errors_on_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("nope.txt");
        let ctx = make_test_ctx();
        let lua = create_lua_vm(ctx).unwrap();
        let path = missing.to_string_lossy().into_owned();
        let result: LuaResult<String> = lua
            .load(format!(r#"return host.read_file("{path}")"#))
            .eval();
        assert!(result.is_err(), "missing file should raise Lua error");
    }

    #[test]
    fn test_host_read_file_rejects_null_byte_in_path() {
        let ctx = make_test_ctx();
        let lua = create_lua_vm(ctx).unwrap();
        let result: LuaResult<String> = lua
            .load(r#"return host.read_file("/tmp/file\0injected")"#)
            .eval();
        assert!(result.is_err());
    }
}
