use std::collections::HashMap;
use std::time::Duration;

use mlua::LuaSerdeExt;
use mlua::prelude::*;
use tokio::process::Command;
use crate::process::CommandWindowExt as _;

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

    fn make_test_ctx() -> HostContext {
        HostContext {
            plugin_name: "test".to_string(),
            allowed_clis: vec!["echo".to_string()],
            workspace_info: WorkspaceInfo {
                id: "ws-1".to_string(),
                name: "test-workspace".to_string(),
                branch: "main".to_string(),
                worktree_path: "/tmp".to_string(),
                repo_path: "/tmp".to_string(),
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
            .load(r#"return host.exec("echo", {"hello", "world"})"#)
            .eval_async()
            .await
            .unwrap();

        let stdout: String = result.get("stdout").unwrap();
        assert!(stdout.trim().contains("hello world"));
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

        let result: LuaResult<LuaTable> = lua
            .load(r#"return host.exec("echo", {"hello\0world"})"#)
            .eval_async()
            .await;

        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("null bytes"));
    }
}
