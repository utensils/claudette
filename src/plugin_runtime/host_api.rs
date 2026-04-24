use std::collections::HashMap;
use std::time::Duration;

use crate::plugin_runtime::manifest::PluginKind;
use crate::process::CommandWindowExt as _;
use mlua::LuaSerdeExt;
use mlua::prelude::*;
use tokio::process::Command;

/// Context passed to the Lua host API functions.
#[derive(Debug, Clone)]
pub struct HostContext {
    pub plugin_name: String,
    pub kind: PluginKind,
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

    // host.direnv_decode_watches(str) -> array<string>
    //
    // direnv encodes its watch list (DIRENV_WATCHES env var) as
    // URL-safe-base64-of-zlib-of-JSON `[{path, modtime, exists}, ...]`.
    // We decode in Rust because Lua has no gzip/deflate primitives.
    //
    // Returns the array of `path` strings. Unparseable input returns an
    // empty list rather than raising — direnv occasionally emits blank or
    // placeholder values we don't want to treat as fatal. Callers decide
    // what to do with the result.
    host.set(
        "direnv_decode_watches",
        lua.create_function(|_, encoded: String| Ok(decode_direnv_watches(&encoded)))?,
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

/// Decode direnv's `DIRENV_WATCHES` env-var value into the list of
/// watched paths it carries.
///
/// Format (gzenv, per direnv source): URL-safe base64 (no padding) of
/// zlib-compressed JSON `[{"path": "...", "modtime": N, "exists": bool}, ...]`.
/// Returns `path` strings only. On any parse failure (unexpected encoding,
/// truncated data, bad JSON) returns an empty vec — direnv is the source
/// of truth and emits blank/placeholder values in normal operation that
/// we shouldn't surface as plugin errors.
///
/// Size limits: the compressed input and the decompressed JSON are each
/// capped. Real-world DIRENV_WATCHES values are well under 10 KB even in
/// repos with many `watch_file` entries; the 1 MiB / 8 MiB caps below
/// are orders of magnitude higher than anything sane while still
/// bounding allocations if a malicious or broken producer hands us a
/// zip bomb.
fn decode_direnv_watches(encoded: &str) -> Vec<String> {
    use base64::Engine as _;
    use flate2::read::ZlibDecoder;
    use std::io::Read as _;

    /// Max compressed input we'll even try to decode (1 MiB).
    const MAX_COMPRESSED_BYTES: usize = 1024 * 1024;
    /// Max decompressed JSON we'll accept (8 MiB) — bounds the zlib
    /// decoder so a deliberately over-compressed payload can't blow up
    /// the heap on `read_to_string`.
    const MAX_DECOMPRESSED_BYTES: u64 = 8 * 1024 * 1024;

    let trimmed = encoded.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_COMPRESSED_BYTES {
        return Vec::new();
    }

    // direnv uses URL-safe base64 without padding; try that first, then
    // fall back to standard base64 so we tolerate either variant in the
    // wild.
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(trimmed)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(trimmed))
        .or_else(|_| base64::engine::general_purpose::STANDARD.decode(trimmed));
    let bytes = match bytes {
        Ok(b) if b.len() <= MAX_COMPRESSED_BYTES => b,
        _ => return Vec::new(),
    };

    let mut decoder = ZlibDecoder::new(&bytes[..]).take(MAX_DECOMPRESSED_BYTES);
    let mut json = String::new();
    if decoder.read_to_string(&mut json).is_err() {
        return Vec::new();
    }
    // `Take` reads at most MAX_DECOMPRESSED_BYTES; a producer handing us
    // a payload that would decompress to exactly the cap is borderline,
    // so treat "filled the cap" as an indication that the original was
    // likely truncated and skip rather than serving half-parsed data.
    if json.len() as u64 >= MAX_DECOMPRESSED_BYTES {
        return Vec::new();
    }

    let parsed: serde_json::Value = match serde_json::from_str(&json) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };

    let Some(array) = parsed.as_array() else {
        return Vec::new();
    };
    array
        .iter()
        .filter_map(|entry| entry.get("path")?.as_str().map(str::to_owned))
        .collect()
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

    // Env-provider plugins run hermetically: we clear the inherited env
    // and set only a minimal, stable baseline. This matters for tools
    // like `direnv export json` which compute a *diff* against the
    // current env — if Claudette was launched from a terminal that
    // already had the workspace's env loaded, direnv would emit only
    // the delta (handful of vars), not the full set. A hermetic baseline
    // makes the exported set deterministic and independent of how
    // Claudette was launched. SCM plugins keep inheriting the full env
    // because they depend on user-state vars like `GH_TOKEN`,
    // `SSH_AUTH_SOCK`, `XDG_CONFIG_HOME`, etc.
    if ctx.kind == PluginKind::EnvProvider {
        command.env_clear();
        command.env("PATH", crate::env::enriched_path());
        // XDG_*_HOME vars matter: direnv/mise store their allow/trust
        // caches under XDG_DATA_HOME (defaulting to $HOME/.local/share
        // when unset). Users who point those at non-default paths
        // would otherwise see their pre-approved worktrees reported
        // as blocked because we'd be looking at the default location
        // while their terminal wrote to the override.
        for key in [
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
        ] {
            if let Ok(val) = std::env::var(key) {
                command.env(key, val);
            }
        }
    } else {
        // macOS GUI apps inherit a minimal launchd PATH, so binaries like
        // `gh`/`glab` (typically in /opt/homebrew/bin) wouldn't be found.
        // Pass the enriched PATH so the child — and anything it shells out
        // to (git, credential helpers, editors) — can resolve them.
        command.env("PATH", crate::env::enriched_path());
    }
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
            kind: PluginKind::Scm,
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

    /// Escape a filesystem path for embedding inside a Lua double-quoted
    /// string literal. On Windows, paths like `C:\Users\...` contain
    /// backslashes that Lua interprets as escape sequences (`\U` etc.)
    /// — without escaping them to `\\` the path gets silently mangled.
    /// POSIX paths have no backslashes, so this is a no-op there.
    fn lua_escape(path: &std::path::Path) -> String {
        path.to_string_lossy().replace('\\', "\\\\")
    }

    #[test]
    fn test_host_file_exists_true() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("marker.txt");
        std::fs::write(&file, "hi").unwrap();

        let ctx = make_test_ctx();
        let lua = create_lua_vm(ctx).unwrap();
        let path = lua_escape(&file);
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
        let path = lua_escape(&missing);
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
        let path = lua_escape(tmp.path());
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
        let path = lua_escape(&file);
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
        let path = lua_escape(&missing);
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
            kind: PluginKind::Scm,
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
        let outside_s = lua_escape(&outside);
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
        let outside_s = lua_escape(&outside);
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

    /// Build a DIRENV_WATCHES-shaped payload from a list of paths.
    /// URL-safe base64 (no padding) over zlib-compressed JSON —
    /// mirrors the wire format emitted by direnv 2.x.
    fn encode_direnv_watches(paths: &[&str]) -> String {
        use base64::Engine as _;
        use flate2::Compression;
        use flate2::write::ZlibEncoder;
        use std::io::Write as _;

        let entries: Vec<serde_json::Value> = paths
            .iter()
            .map(|p| serde_json::json!({ "path": p, "modtime": 0, "exists": true }))
            .collect();
        let json = serde_json::to_string(&entries).unwrap();
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(json.as_bytes()).unwrap();
        let compressed = encoder.finish().unwrap();
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&compressed)
    }

    #[test]
    fn decode_direnv_watches_round_trip() {
        let encoded =
            encode_direnv_watches(&["/repo/.envrc", "/repo/secret.env", "/home/u/.config/foo"]);
        let decoded = decode_direnv_watches(&encoded);
        assert_eq!(
            decoded,
            vec![
                "/repo/.envrc".to_string(),
                "/repo/secret.env".to_string(),
                "/home/u/.config/foo".to_string(),
            ],
        );
    }

    #[test]
    fn decode_direnv_watches_empty_input_returns_empty() {
        assert!(decode_direnv_watches("").is_empty());
        assert!(decode_direnv_watches("   ").is_empty());
    }

    #[test]
    fn decode_direnv_watches_returns_empty_on_garbage() {
        // Not base64 at all.
        assert!(decode_direnv_watches("not base64!!!").is_empty());
        // Valid base64 but not zlib.
        use base64::Engine as _;
        let junk = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(b"hello world");
        assert!(decode_direnv_watches(&junk).is_empty());
    }

    #[test]
    fn decode_direnv_watches_via_lua_host_api() {
        // Round-trip through the Lua surface to confirm the host function
        // is wired up and returns a Lua sequence.
        let ctx = make_test_ctx();
        let lua = create_lua_vm(ctx).unwrap();
        let encoded = encode_direnv_watches(&["/a/.envrc", "/a/sub.env"]);

        // Embed the encoded payload as a Lua string literal. The
        // encoding is ASCII (URL-safe base64), no escape handling
        // needed.
        let script = format!(r#"return host.direnv_decode_watches("{encoded}")"#);
        let table: mlua::Table = lua.load(&script).eval().unwrap();
        assert_eq!(table.len().unwrap(), 2);
        assert_eq!(table.get::<String>(1).unwrap(), "/a/.envrc");
        assert_eq!(table.get::<String>(2).unwrap(), "/a/sub.env");
    }

    #[test]
    fn decode_direnv_watches_via_lua_accepts_empty_string() {
        let ctx = make_test_ctx();
        let lua = create_lua_vm(ctx).unwrap();
        let len: i64 = lua
            .load(r#"return #host.direnv_decode_watches("")"#)
            .eval()
            .unwrap();
        assert_eq!(len, 0);
    }

    #[test]
    fn decode_direnv_watches_rejects_oversize_compressed_input() {
        // A 2 MiB base64-safe string — over the 1 MiB compressed-input
        // cap. We don't even try to decode this: it returns empty
        // before touching zlib/JSON, so a zip-bomb-sized header never
        // allocates the decompressed buffer.
        let oversize: String = "A".repeat(2 * 1024 * 1024);
        assert!(decode_direnv_watches(&oversize).is_empty());
    }

    #[test]
    fn decode_direnv_watches_rejects_decompression_bomb() {
        // Craft a zip bomb: 16 MiB of zeros compresses to a handful of
        // bytes. The 8 MiB decompressed cap should trip and return
        // empty without filling memory with the full expansion.
        use base64::Engine as _;
        use flate2::Compression;
        use flate2::write::ZlibEncoder;
        use std::io::Write as _;

        let huge = vec![0u8; 16 * 1024 * 1024];
        let mut enc = ZlibEncoder::new(Vec::new(), Compression::best());
        enc.write_all(&huge).unwrap();
        let compressed = enc.finish().unwrap();
        // Sanity: the bomb really is small once compressed.
        assert!(
            compressed.len() < 64 * 1024,
            "compressed size {} too large for a zip bomb test",
            compressed.len()
        );
        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&compressed);
        assert!(decode_direnv_watches(&encoded).is_empty());
    }
}
