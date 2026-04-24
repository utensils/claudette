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

/// Create a sandboxed Lua VM with the host API registered.
pub fn create_lua_vm(ctx: HostContext) -> LuaResult<Lua> {
    let lua = Lua::new();

    // Remove dangerous standard libraries
    sandbox_stdlib(&lua)?;

    // Register the host table
    register_host_api(&lua, ctx)?;

    Ok(lua)
}

/// Remove stdlib functions that give a plugin filesystem/network/process
/// access outside the host-mediated API. The sandbox is defense-in-depth
/// — a plugin is compiled code the user opted to install, not adversarial
/// input — but we minimize the reachable surface anyway.
///
/// Includes `package`/`require`: mlua's Luau backend disables `require`
/// by default, but we clear them unconditionally so a future mlua
/// change (or a different Lua backend) doesn't silently re-enable
/// file-backed module loading.
fn sandbox_stdlib(lua: &Lua) -> LuaResult<()> {
    let globals = lua.globals();
    globals.set("os", LuaNil)?;
    globals.set("io", LuaNil)?;
    globals.set("loadfile", LuaNil)?;
    globals.set("dofile", LuaNil)?;
    globals.set("package", LuaNil)?;
    globals.set("require", LuaNil)?;
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

    // Canonicalize the workspace root once per VM creation. Both
    // `host.file_exists` and `host.read_file` use it as the confinement
    // boundary: any path they resolve (after following symlinks) must
    // descend from this root, or the operation fails. Stored as
    // Option<PathBuf> so plugins whose worktree no longer exists fail
    // closed (deny everything) rather than panicking.
    let confinement = std::path::Path::new(&ctx.workspace_info.worktree_path)
        .canonicalize()
        .ok();

    // host.file_exists(path) -> bool
    //
    // Returns true only when the path resolves to something that exists
    // AND is inside the workspace root (after canonicalization — symlinks
    // that escape the workspace resolve to false, not true).
    //
    // Deliberately returns `false` (not error) for paths outside the
    // workspace so a malicious plugin can't probe the filesystem by
    // observing whether the call succeeds or errors.
    let file_exists_root = confinement.clone();
    host.set(
        "file_exists",
        lua.create_function(move |_, path: String| {
            if path.contains('\0') {
                return Err(LuaError::external("path must not contain null bytes"));
            }
            Ok(resolve_inside_workspace(&path, file_exists_root.as_deref()).is_some())
        })?,
    )?;

    // host.read_file(path) -> string
    //
    // Reads the file at `path` as UTF-8. Rejects paths that escape the
    // workspace (`../../etc/passwd`, absolute paths outside, symlinks
    // pointing out) with a Lua error. Used by env providers that parse
    // config files in-process (e.g. dotenv's `.env` parser).
    let read_file_root = confinement;
    host.set(
        "read_file",
        lua.create_function(move |_, path: String| {
            if path.contains('\0') {
                return Err(LuaError::external("path must not contain null bytes"));
            }
            let canonical =
                resolve_inside_workspace(&path, read_file_root.as_deref()).ok_or_else(|| {
                    LuaError::external(format!(
                        "path '{path}' is outside the workspace or does not exist"
                    ))
                })?;
            std::fs::read_to_string(&canonical)
                .map_err(|e| LuaError::external(format!("failed to read '{path}': {e}")))
        })?,
    )?;

    lua.globals().set("host", host)?;
    Ok(())
}

/// Resolve `path` (absolute or relative to `workspace_root`) into a
/// canonical path, confirming it exists and is descended from the
/// canonical `workspace_root`. Returns `None` if:
///   - `workspace_root` is `None` (fail closed — no confinement possible)
///   - the path doesn't exist
///   - the path's canonical form escapes the workspace root (symlink
///     traversal, absolute paths outside, `..` components that land
///     outside)
///
/// Canonicalization follows symlinks, so a repo-local `.env -> /etc/passwd`
/// resolves to `/etc/passwd` which doesn't start with the workspace root
/// → confinement fails. This is the primary mitigation for malicious
/// plugins or repos attempting to read outside the worktree.
fn resolve_inside_workspace(
    path: &str,
    workspace_root: Option<&std::path::Path>,
) -> Option<std::path::PathBuf> {
    let root = workspace_root?;
    let input = std::path::Path::new(path);
    let candidate = if input.is_absolute() {
        input.to_path_buf()
    } else {
        root.join(input)
    };
    let canonical = candidate.canonicalize().ok()?;
    if canonical.starts_with(root) {
        Some(canonical)
    } else {
        None
    }
}

/// Execute a subprocess, restricted to allowed CLIs.
async fn host_exec(
    lua: &Lua,
    cmd: &str,
    args_table: LuaTable,
    ctx: &HostContext,
) -> LuaResult<LuaTable> {
    // Validate command is in this plugin's manifest-declared allowlist.
    // Previously `git` was always-allowed as a convenience, but that let
    // plugins execute arbitrary shell via `git -c alias.x='!...'` without
    // declaring it — the user's install-time trust decision about which
    // CLIs this plugin may run must be the sole authority.
    let is_declared = ctx.allowed_clis.iter().any(|c| c == cmd);
    if !is_declared {
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
    async fn test_exec_git_no_longer_always_allowed() {
        // `git` was previously in an always-allowed list, which let a
        // plugin exploit `git -c alias.x='!sh ...' x` to run arbitrary
        // shell without declaring it. With the constant removed, plugins
        // must declare every CLI they use — the manifest is the sole
        // allowlist authority.
        let ctx = make_test_ctx();
        let lua = create_lua_vm(ctx).unwrap();

        let result: LuaResult<LuaTable> = lua
            .load(r#"return host.exec("git", {"--version"})"#)
            .eval_async()
            .await;

        assert!(
            result.is_err(),
            "git must not be allowed without declaration"
        );
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("not in this plugin's allowed CLIs"),
            "unexpected error: {err}"
        );
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

    /// Build a context whose workspace root is the given tempdir. Used
    /// by the confinement tests below so they can assert that paths
    /// outside that tempdir are rejected.
    fn ctx_with_worktree(worktree: &std::path::Path) -> HostContext {
        HostContext {
            plugin_name: "test".to_string(),
            allowed_clis: vec![],
            workspace_info: WorkspaceInfo {
                id: "ws-1".into(),
                name: "test".into(),
                branch: "main".into(),
                worktree_path: worktree.to_string_lossy().into_owned(),
                repo_path: worktree.to_string_lossy().into_owned(),
            },
            config: HashMap::new(),
        }
    }

    #[test]
    fn test_file_exists_rejects_absolute_path_outside_workspace() {
        // Absolute path to a file the OS is guaranteed to have at a
        // predictable location. On all supported platforms this is NOT
        // under the narrow tempdir workspace, so confinement should deny.
        let workspace = tempfile::tempdir().unwrap();
        let ctx = ctx_with_worktree(workspace.path());
        let lua = create_lua_vm(ctx).unwrap();

        // Use the Rust binary's path — exists for sure on every host
        // that runs this test, and is clearly outside the tempdir.
        let outside = std::env::current_exe().unwrap();
        let outside_s = outside.to_string_lossy().replace('\\', "\\\\");
        let exists: bool = lua
            .load(format!(r#"return host.file_exists("{outside_s}")"#))
            .eval()
            .unwrap();
        assert!(
            !exists,
            "path outside workspace must report as not existing"
        );
    }

    #[test]
    fn test_read_file_rejects_absolute_path_outside_workspace() {
        let workspace = tempfile::tempdir().unwrap();
        let ctx = ctx_with_worktree(workspace.path());
        let lua = create_lua_vm(ctx).unwrap();

        let outside = std::env::current_exe().unwrap();
        let outside_s = outside.to_string_lossy().replace('\\', "\\\\");
        let result: LuaResult<String> = lua
            .load(format!(r#"return host.read_file("{outside_s}")"#))
            .eval();
        assert!(
            result.is_err(),
            "read_file must reject path outside workspace"
        );
        let err = result.unwrap_err().to_string();
        assert!(
            err.contains("outside the workspace"),
            "unexpected error: {err}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_read_file_rejects_symlink_escaping_workspace() {
        // A `.env` inside the workspace that symlinks to a file outside
        // must not be readable — this is the path-traversal escape Codex
        // flagged as the primary attack for a malicious `.env`.
        let workspace = tempfile::tempdir().unwrap();
        let outside_dir = tempfile::tempdir().unwrap();
        let secret = outside_dir.path().join("secret.txt");
        std::fs::write(&secret, "sensitive").unwrap();

        let link = workspace.path().join(".env");
        std::os::unix::fs::symlink(&secret, &link).unwrap();

        let ctx = ctx_with_worktree(workspace.path());
        let lua = create_lua_vm(ctx).unwrap();

        // file_exists follows the symlink → resolves outside → false.
        let exists: bool = lua
            .load(r#"return host.file_exists(".env")"#)
            .eval()
            .unwrap();
        assert!(!exists, "symlink escape must report as not existing");

        // read_file follows the symlink → resolves outside → error.
        let result: LuaResult<String> = lua.load(r#"return host.read_file(".env")"#).eval();
        assert!(
            result.is_err(),
            "symlink escape must be rejected by read_file"
        );
    }

    #[test]
    fn test_file_exists_allows_path_inside_workspace() {
        // Sanity check that the confinement doesn't over-restrict legit
        // workspace files — plugins MUST still be able to detect on
        // `.envrc` / `mise.toml` / etc.
        let workspace = tempfile::tempdir().unwrap();
        std::fs::write(workspace.path().join(".envrc"), "use flake").unwrap();
        let ctx = ctx_with_worktree(workspace.path());
        let lua = create_lua_vm(ctx).unwrap();

        let exists: bool = lua
            .load(r#"return host.file_exists(".envrc")"#)
            .eval()
            .unwrap();
        assert!(exists, "file inside workspace must be visible");

        let contents: String = lua
            .load(r#"return host.read_file(".envrc")"#)
            .eval()
            .unwrap();
        assert_eq!(contents, "use flake");
    }

    #[test]
    fn test_file_exists_rejects_dotdot_traversal() {
        // `..` in a relative path must not let a plugin escape upward.
        let workspace = tempfile::tempdir().unwrap();
        let ctx = ctx_with_worktree(workspace.path());
        let lua = create_lua_vm(ctx).unwrap();

        let exists: bool = lua
            .load(r#"return host.file_exists("../../../etc/passwd")"#)
            .eval()
            .unwrap();
        assert!(!exists, "dotdot traversal must be denied");
    }
}
