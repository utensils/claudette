//! Unit tests for the bundled env-provider Lua plugins.
//!
//! These tests load each plugin's `init.lua` into a sandboxed Lua VM
//! and invoke its `detect` / `export` operations directly — they don't
//! go through `PluginRegistry::call_operation`, so they run faster and
//! don't depend on plugin discovery on the filesystem. The full
//! registry path is exercised by the dispatcher integration test at
//! the bottom of this file.
//!
//! External CLIs (`direnv`, `mise`, `nix`) are needed only for the
//! `export` integration tests — unit tests cover the detect and parse
//! branches synthetically. Integration tests are gated behind
//! `has_direnv` / `has_mise` / `has_nix` cfg flags emitted by
//! `build.rs`, so CI without those tools silently skips them.

use mlua::Lua;
use std::path::Path;

use crate::plugin_runtime::host_api::{HostContext, WorkspaceInfo, create_lua_vm};
use crate::plugin_runtime::manifest::PluginKind;

const DIRENV_SRC: &str = include_str!("../../plugins/env-direnv/init.lua");
const MISE_SRC: &str = include_str!("../../plugins/env-mise/init.lua");
const DOTENV_SRC: &str = include_str!("../../plugins/env-dotenv/init.lua");
const NIX_SRC: &str = include_str!("../../plugins/env-nix-devshell/init.lua");

/// Build a VM configured for the given plugin's `required_clis`.
fn make_vm(plugin: &str, allowed: &[&str], worktree: &Path) -> Lua {
    let ctx = HostContext {
        plugin_name: plugin.to_string(),
        kind: PluginKind::EnvProvider,
        allowed_clis: allowed.iter().map(|s| s.to_string()).collect(),
        workspace_info: WorkspaceInfo {
            id: "ws-1".into(),
            name: "test".into(),
            branch: "main".into(),
            worktree_path: worktree.to_string_lossy().into_owned(),
            repo_path: worktree.to_string_lossy().into_owned(),
            ..Default::default()
        },
        ..Default::default()
    };
    create_lua_vm(ctx).expect("create vm")
}

/// Run `detect(args)` against the given plugin source.
fn run_detect(plugin: &str, src: &str, allowed: &[&str], worktree: &Path) -> bool {
    let lua = make_vm(plugin, allowed, worktree);
    let path = worktree.to_string_lossy().into_owned();
    let script = format!(
        r#"
        local M = (function() {src} end)()
        return M.detect({{ worktree = "{path}" }})
        "#,
        src = src,
        path = path.replace('\\', "\\\\")
    );
    lua.load(&script).eval::<bool>().expect("detect call")
}

// ---------------------------------------------------------------------------
// env-direnv
// ---------------------------------------------------------------------------

#[test]
fn direnv_detect_finds_envrc() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join(".envrc"), "use flake").unwrap();
    assert!(run_detect(
        "env-direnv",
        DIRENV_SRC,
        &["direnv"],
        tmp.path()
    ));
}

#[test]
fn direnv_detect_skips_missing_envrc() {
    let tmp = tempfile::tempdir().unwrap();
    assert!(!run_detect(
        "env-direnv",
        DIRENV_SRC,
        &["direnv"],
        tmp.path()
    ));
}

/// Encode paths into direnv's `DIRENV_WATCHES` wire format — URL-safe
/// base64 of zlib-compressed JSON `[{"path": ..., "modtime": N, ...}, ...]`.
/// Mirrors the decoder in `host_api::decode_direnv_watches`.
fn encode_direnv_watches(paths: &[&str]) -> String {
    use base64::Engine as _;
    use flate2::Compression;
    use flate2::write::ZlibEncoder;
    use std::io::Write as _;

    let entries: Vec<serde_json::Value> = paths
        .iter()
        .map(|p| serde_json::json!({ "path": p, "modtime": 1, "exists": true }))
        .collect();
    let json = serde_json::to_string(&entries).unwrap();
    let mut enc = ZlibEncoder::new(Vec::new(), Compression::default());
    enc.write_all(json.as_bytes()).unwrap();
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(enc.finish().unwrap())
}

/// Drive env-direnv's `export` with a stubbed `host.exec` that returns
/// a caller-supplied env map (encoded as JSON) with the given
/// `DIRENV_WATCHES` value. Returns `(watched list, worktree path)`.
///
/// We override `host.exec` after VM construction so the plugin code is
/// unmodified — this is the same trick the plugin would see in prod,
/// with all other host APIs intact. The stub records the first call
/// only; the plugin invokes `direnv export json` once on the happy path.
fn direnv_export_with_stubbed_exec(
    direnv_watches: Option<&str>,
) -> (Vec<String>, tempfile::TempDir) {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join(".envrc"), "export FOO=bar\n").unwrap();
    let lua = make_vm("env-direnv", &["direnv"], tmp.path());

    // Build the JSON `host.exec` should return. direnv's real output is
    // `{VAR: "value" | null}`, so we set at least one var plus
    // optionally DIRENV_WATCHES.
    let mut env = serde_json::json!({ "FOO": "bar" });
    if let Some(w) = direnv_watches {
        env["DIRENV_WATCHES"] = serde_json::Value::String(w.to_string());
    }
    let env_json = serde_json::to_string(&env).unwrap();

    // Overwrite `host.exec` in the globals of this VM. The plugin's
    // `export` is the only path that calls it (detect uses file_exists).
    // Assert shape here so the test catches a regression where the
    // plugin spawns the wrong CLI or passes the wrong args — a silent
    // accept would let such a bug through.
    let stub_script = format!(
        r#"
        host.exec = function(cmd, args)
            if cmd ~= "direnv" then
                error("expected host.exec cmd='direnv', got: " .. tostring(cmd))
            end
            if type(args) ~= "table" or args[1] ~= "export" or args[2] ~= "json" or args[3] ~= nil then
                local got = type(args) == "table"
                    and tostring(args[1]) .. "," .. tostring(args[2]) .. "," .. tostring(args[3])
                    or tostring(args)
                error("expected host.exec args={{'export','json'}}, got: " .. got)
            end
            return {{ stdout = [==[{env_json}]==], stderr = "", code = 0 }}
        end
        "#
    );
    lua.load(&stub_script).exec().expect("install stub");

    let worktree = tmp.path().to_string_lossy().into_owned();
    let script = format!(
        r#"
        local M = (function() {src} end)()
        return M.export({{ worktree = "{path}" }})
        "#,
        src = DIRENV_SRC,
        path = worktree.replace('\\', "\\\\"),
    );
    let result: mlua::Table = lua.load(&script).eval().expect("export");
    let watched: mlua::Table = result.get("watched").expect("watched field");
    let mut out = Vec::new();
    let len = watched.len().expect("len") as usize;
    for i in 1..=len {
        out.push(watched.get::<String>(i).expect("string path"));
    }
    (out, tmp)
}

#[test]
fn direnv_export_watches_list_includes_envrc_without_direnv_watches() {
    // No DIRENV_WATCHES in the exported env (direnv didn't emit one,
    // or the .envrc has no `watch_file` directives). We still must
    // report `.envrc` as the watch target, unchanged from prior behavior.
    let (watched, _tmp) = direnv_export_with_stubbed_exec(None);
    assert_eq!(watched.len(), 1, "watched = {watched:?}");
    assert!(
        watched[0].ends_with(".envrc"),
        "expected .envrc in watched, got {watched:?}"
    );
}

#[test]
fn direnv_export_watches_list_merges_direnv_watches() {
    // `.envrc` sources `secret.env` and `.local.env` via direnv's
    // `watch_file` / `dotenv` directives. direnv emits both in
    // `DIRENV_WATCHES`; the plugin must surface them so the cache
    // invalidates when either changes. We two-phase this: first get
    // the worktree path from the helper, then re-run with a
    // DIRENV_WATCHES whose paths are rooted at that worktree so we can
    // verify dedupe against the `.envrc` the plugin self-seeds.
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join(".envrc"), "export FOO=bar\n").unwrap();
    let worktree = tmp.path().to_string_lossy().into_owned();
    let envrc_path = format!("{worktree}/.envrc");
    let secret_path = format!("{worktree}/secret.env");
    let local_path = format!("{worktree}/.local.env");
    let encoded = encode_direnv_watches(&[&envrc_path, &secret_path, &local_path]);

    let lua = make_vm("env-direnv", &["direnv"], tmp.path());
    let env_json = serde_json::to_string(&serde_json::json!({
        "FOO": "bar",
        "DIRENV_WATCHES": encoded,
    }))
    .unwrap();
    let stub = format!(
        r#"
        host.exec = function(cmd, args)
            if cmd ~= "direnv" then error("expected cmd='direnv', got: " .. tostring(cmd)) end
            if type(args) ~= "table" or args[1] ~= "export" or args[2] ~= "json" or args[3] ~= nil then
                error("expected args={{'export','json'}}")
            end
            return {{ stdout = [==[{env_json}]==], stderr = "", code = 0 }}
        end
        "#
    );
    lua.load(&stub).exec().unwrap();

    let script = format!(
        r#"
        local M = (function() {src} end)()
        return M.export({{ worktree = "{path}" }})
        "#,
        src = DIRENV_SRC,
        path = worktree.replace('\\', "\\\\"),
    );
    let result: mlua::Table = lua.load(&script).eval().unwrap();
    let watched_tbl: mlua::Table = result.get("watched").unwrap();
    let len = watched_tbl.len().unwrap() as usize;
    let watched: Vec<String> = (1..=len)
        .map(|i| watched_tbl.get::<String>(i).unwrap())
        .collect();

    assert!(
        watched.contains(&envrc_path),
        "expected {envrc_path} in watched, got {watched:?}"
    );
    assert!(
        watched.contains(&secret_path),
        "expected {secret_path} in watched, got {watched:?}"
    );
    assert!(
        watched.contains(&local_path),
        "expected {local_path} in watched, got {watched:?}"
    );
    // Dedupe: the worktree-rooted .envrc appears exactly once even
    // though both the plugin and direnv list it.
    let envrc_count = watched.iter().filter(|p| **p == envrc_path).count();
    assert_eq!(
        envrc_count, 1,
        "expected .envrc exactly once in watched, got {watched:?}"
    );
}

#[test]
fn direnv_export_watches_list_tolerates_garbage_direnv_watches() {
    // Decoder returns an empty list on unparseable input. The plugin
    // must not error — we still emit the `.envrc` baseline.
    let (watched, _tmp) = direnv_export_with_stubbed_exec(Some("not-base64!!"));
    assert_eq!(watched.len(), 1);
    assert!(watched[0].ends_with(".envrc"));
}

/// Drive env-direnv's `export` with a caller-supplied env map and
/// return the full `(env, watched)` shape the plugin returns. Used by
/// the marker-strip regression tests to assert what the dispatcher
/// would actually merge into the workspace env.
fn direnv_export_returns(
    env_in: serde_json::Value,
) -> (
    std::collections::HashMap<String, Option<String>>,
    Vec<String>,
    tempfile::TempDir,
) {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join(".envrc"), "export FOO=bar\n").unwrap();
    let lua = make_vm("env-direnv", &["direnv"], tmp.path());

    let env_json = serde_json::to_string(&env_in).unwrap();
    let stub = format!(
        r#"
        host.exec = function(cmd, args)
            if cmd ~= "direnv" then error("expected cmd='direnv', got: " .. tostring(cmd)) end
            if type(args) ~= "table" or args[1] ~= "export" or args[2] ~= "json" or args[3] ~= nil then
                error("expected args={{'export','json'}}")
            end
            return {{ stdout = [==[{env_json}]==], stderr = "", code = 0 }}
        end
        "#
    );
    lua.load(&stub).exec().unwrap();

    let worktree = tmp.path().to_string_lossy().into_owned();
    let script = format!(
        r#"
        local M = (function() {src} end)()
        return M.export({{ worktree = "{path}" }})
        "#,
        src = DIRENV_SRC,
        path = worktree.replace('\\', "\\\\"),
    );
    let result: mlua::Table = lua.load(&script).eval().expect("export");

    let env_tbl: mlua::Table = result.get("env").expect("env field");
    let mut env = std::collections::HashMap::new();
    for pair in env_tbl.pairs::<String, mlua::Value>() {
        let (k, v) = pair.unwrap();
        // direnv encodes "unset this key" as a JSON null, which lands
        // in Lua as `nil` (which `pairs` skips entirely) — so anything
        // we see here is a real string value.
        let s = match v {
            mlua::Value::String(s) => Some(s.to_str().unwrap().to_string()),
            mlua::Value::Nil => None,
            other => panic!("unexpected env value type: {other:?}"),
        };
        env.insert(k, s);
    }

    let watched_tbl: mlua::Table = result.get("watched").expect("watched field");
    let len = watched_tbl.len().expect("len") as usize;
    let watched: Vec<String> = (1..=len)
        .map(|i| watched_tbl.get::<String>(i).expect("string path"))
        .collect();

    (env, watched, tmp)
}

#[test]
fn direnv_export_strips_internal_markers_from_returned_env() {
    // Regression for the nightly-only direnv breakage: when the env
    // dispatcher merged the plugin's output into a PTY env, leaking
    // direnv's own `DIRENV_DIR` / `DIRENV_FILE` / `DIRENV_DIFF` /
    // `DIRENV_WATCHES` markers tricked the in-shell `direnv hook`
    // into concluding "already loaded for this dir" and skipping
    // its first-prompt re-export. The user then never saw shell-side
    // artifacts (numtide/devshell's `menu`, .envrc-defined functions),
    // even though `direnv reload` from inside the same shell worked
    // because that path bypasses the markers and re-evaluates the
    // .envrc cleanly.
    //
    // Pin: `direnv export json` always emits DIRENV_* memos — even
    // when the .envrc body fails to load (e.g. `use flake` couldn't
    // find `nix`). The plugin must strip every `DIRENV_*` key from
    // the returned env so the in-shell hook always does its own
    // first-prompt evaluation.
    let stubbed = serde_json::json!({
        "FOO": "bar",
        "PATH": "/bin:/usr/bin",
        "DIRENV_DIR": "-/path/to/workspace",
        "DIRENV_FILE": "/path/to/workspace/.envrc",
        "DIRENV_DIFF": "eJxxxx",
        "DIRENV_WATCHES": "eJyyyy",
    });
    let (env, _watched, _tmp) = direnv_export_returns(stubbed);

    // Real exports survive.
    assert_eq!(
        env.get("FOO").and_then(|v| v.clone()),
        Some("bar".to_string())
    );
    assert_eq!(
        env.get("PATH").and_then(|v| v.clone()),
        Some("/bin:/usr/bin".to_string())
    );
    // Every internal marker is gone — the in-shell hook will set
    // these itself the first time it runs.
    for key in ["DIRENV_DIR", "DIRENV_FILE", "DIRENV_DIFF", "DIRENV_WATCHES"] {
        assert!(
            !env.contains_key(key),
            "expected {key} to be stripped from returned env, got keys = {:?}",
            env.keys().collect::<Vec<_>>()
        );
    }
}

#[test]
fn direnv_export_strips_markers_but_keeps_watches_decoded_into_watched() {
    // The strip step happens AFTER the plugin reads `DIRENV_WATCHES`
    // for the watch list. Regressing the order would silently lose
    // user `watch_file` directives — the cache would only invalidate
    // on `.envrc` changes, missing edits to files like `secret.env`
    // sourced via `dotenv`.
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join(".envrc"), "export FOO=bar\n").unwrap();
    let worktree = tmp.path().to_string_lossy().into_owned();
    let envrc_path = format!("{worktree}/.envrc");
    let secret_path = format!("{worktree}/secret.env");
    let encoded = encode_direnv_watches(&[&envrc_path, &secret_path]);

    let lua = make_vm("env-direnv", &["direnv"], tmp.path());
    let env_json = serde_json::to_string(&serde_json::json!({
        "FOO": "bar",
        "DIRENV_WATCHES": encoded,
    }))
    .unwrap();
    let stub = format!(
        r#"
        host.exec = function(cmd, args)
            if cmd ~= "direnv" then error("expected cmd='direnv', got: " .. tostring(cmd)) end
            if type(args) ~= "table" or args[1] ~= "export" or args[2] ~= "json" or args[3] ~= nil then
                error("expected args={{'export','json'}}")
            end
            return {{ stdout = [==[{env_json}]==], stderr = "", code = 0 }}
        end
        "#
    );
    lua.load(&stub).exec().unwrap();

    let script = format!(
        r#"
        local M = (function() {src} end)()
        return M.export({{ worktree = "{path}" }})
        "#,
        src = DIRENV_SRC,
        path = worktree.replace('\\', "\\\\"),
    );
    let result: mlua::Table = lua.load(&script).eval().unwrap();

    // Watch list still picks up the secret.env that DIRENV_WATCHES
    // pointed at — the strip happens AFTER we decoded the watches.
    let watched_tbl: mlua::Table = result.get("watched").unwrap();
    let len = watched_tbl.len().unwrap() as usize;
    let watched: Vec<String> = (1..=len)
        .map(|i| watched_tbl.get::<String>(i).unwrap())
        .collect();
    assert!(
        watched.contains(&secret_path),
        "expected secret.env in watched after strip, got {watched:?}"
    );

    // But DIRENV_WATCHES is gone from the env we hand the dispatcher.
    let env_tbl: mlua::Table = result.get("env").unwrap();
    assert!(
        env_tbl
            .get::<mlua::Value>("DIRENV_WATCHES")
            .map(|v| matches!(v, mlua::Value::Nil))
            .unwrap_or(true),
        "DIRENV_WATCHES must not survive into the returned env"
    );
    // FOO survives — the strip is not greedy across non-DIRENV keys.
    assert_eq!(env_tbl.get::<String>("FOO").ok().as_deref(), Some("bar"));
}

#[test]
fn direnv_export_strip_handles_failed_use_flake_payload() {
    // Reproduces the exact wire-shape `direnv export json` returns
    // when the .envrc body failed (e.g. `use flake` couldn't find
    // `nix` because launchd-launched Claudette's host_exec PATH
    // didn't recover the user's nix profile). direnv emits ONLY the
    // four memos and no real env. Pre-fix, this leaked into the PTY,
    // tricking the shell hook into a no-op. Post-fix, the dispatcher
    // gets an empty env and the in-shell hook re-evaluates fresh.
    let stubbed = serde_json::json!({
        "DIRENV_DIR": "-/path/to/workspace",
        "DIRENV_FILE": "/path/to/workspace/.envrc",
        "DIRENV_DIFF": "eJxxxx",
        "DIRENV_WATCHES": "eJyyyy",
    });
    let (env, watched, _tmp) = direnv_export_returns(stubbed);
    assert!(
        env.is_empty(),
        "failed-payload export must contribute zero vars, got {env:?}"
    );
    // .envrc is still seeded into the watch list so editing it
    // (e.g. fixing the `use flake` issue) still busts the cache.
    assert_eq!(watched.len(), 1);
    assert!(watched[0].ends_with(".envrc"));
}

// ---------------------------------------------------------------------------
// env-mise
// ---------------------------------------------------------------------------

#[test]
fn mise_detect_finds_mise_toml() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join("mise.toml"), "[tools]\nnode = \"20\"").unwrap();
    assert!(run_detect("env-mise", MISE_SRC, &["mise"], tmp.path()));
}

#[test]
fn mise_detect_finds_hidden_mise_toml() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join(".mise.toml"), "[tools]").unwrap();
    assert!(run_detect("env-mise", MISE_SRC, &["mise"], tmp.path()));
}

#[test]
fn mise_detect_finds_tool_versions() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join(".tool-versions"), "node 20").unwrap();
    assert!(run_detect("env-mise", MISE_SRC, &["mise"], tmp.path()));
}

#[test]
fn mise_detect_skips_when_no_config() {
    let tmp = tempfile::tempdir().unwrap();
    assert!(!run_detect("env-mise", MISE_SRC, &["mise"], tmp.path()));
}

// ---------------------------------------------------------------------------
// env-dotenv (the only plugin that parses in-process)
// ---------------------------------------------------------------------------

#[test]
fn dotenv_detect_finds_env_file() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join(".env"), "FOO=bar").unwrap();
    assert!(run_detect("env-dotenv", DOTENV_SRC, &[], tmp.path()));
}

#[test]
fn dotenv_detect_skips_missing_env() {
    let tmp = tempfile::tempdir().unwrap();
    assert!(!run_detect("env-dotenv", DOTENV_SRC, &[], tmp.path()));
}

/// Drive `_parse(text)` directly so we cover quoting / comment /
/// `export`-prefix corners without touching the filesystem.
fn parse_dotenv_text(text: &str) -> std::collections::HashMap<String, String> {
    let tmp = tempfile::tempdir().unwrap();
    let lua = make_vm("env-dotenv", &[], tmp.path());
    // Escape backslashes for Lua string literal
    let escaped = text.replace('\\', "\\\\").replace('"', "\\\"");
    let script = format!(
        r#"
        local M = (function() {src} end)()
        return M._parse("{txt}")
        "#,
        src = DOTENV_SRC,
        txt = escaped.replace('\n', "\\n").replace('\r', "\\r")
    );
    let table: mlua::Table = lua.load(&script).eval().expect("_parse call");
    let mut out = std::collections::HashMap::new();
    for pair in table.pairs::<String, String>() {
        let (k, v) = pair.unwrap();
        out.insert(k, v);
    }
    out
}

#[test]
fn dotenv_parse_simple_kv() {
    let env = parse_dotenv_text("FOO=bar\nBAZ=qux\n");
    assert_eq!(env.get("FOO").map(|s| s.as_str()), Some("bar"));
    assert_eq!(env.get("BAZ").map(|s| s.as_str()), Some("qux"));
}

#[test]
fn dotenv_parse_strips_export_prefix() {
    let env = parse_dotenv_text("export FOO=bar\n");
    assert_eq!(env.get("FOO").map(|s| s.as_str()), Some("bar"));
}

#[test]
fn dotenv_parse_handles_double_quoted_values() {
    let env = parse_dotenv_text(r#"FOO="hello world""#);
    assert_eq!(env.get("FOO").map(|s| s.as_str()), Some("hello world"));
}

#[test]
fn dotenv_parse_handles_single_quoted_values() {
    let env = parse_dotenv_text("FOO='hello world'");
    assert_eq!(env.get("FOO").map(|s| s.as_str()), Some("hello world"));
}

#[test]
fn dotenv_parse_ignores_comment_lines() {
    let env = parse_dotenv_text("# this is a comment\nFOO=bar\n# another\n");
    assert_eq!(env.len(), 1);
    assert_eq!(env.get("FOO").map(|s| s.as_str()), Some("bar"));
}

#[test]
fn dotenv_parse_strips_inline_comment_on_unquoted_value() {
    let env = parse_dotenv_text("FOO=bar  # trailing comment");
    assert_eq!(env.get("FOO").map(|s| s.as_str()), Some("bar"));
}

#[test]
fn dotenv_parse_preserves_hash_in_quoted_value() {
    // Quoted `#` is data, not a comment.
    let env = parse_dotenv_text(r#"TOKEN="abc#def""#);
    assert_eq!(env.get("TOKEN").map(|s| s.as_str()), Some("abc#def"));
}

#[test]
fn dotenv_parse_skips_blank_lines_and_malformed() {
    let env = parse_dotenv_text("\n\nFOO=bar\nmalformed line\n  \nBAZ=qux\n");
    assert_eq!(env.get("FOO").map(|s| s.as_str()), Some("bar"));
    assert_eq!(env.get("BAZ").map(|s| s.as_str()), Some("qux"));
    assert_eq!(env.len(), 2);
}

// ---------------------------------------------------------------------------
// env-nix-devshell
// ---------------------------------------------------------------------------

#[test]
fn nix_detect_finds_flake() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join("flake.nix"), "{}").unwrap();
    assert!(run_detect(
        "env-nix-devshell",
        NIX_SRC,
        &["nix"],
        tmp.path()
    ));
}

#[test]
fn nix_detect_finds_shell_nix() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join("shell.nix"), "{}").unwrap();
    assert!(run_detect(
        "env-nix-devshell",
        NIX_SRC,
        &["nix"],
        tmp.path()
    ));
}

#[test]
fn nix_detect_finds_flake_even_with_envrc() {
    // Detection is a pure function of what's on disk — if flake.nix
    // exists, env-nix-devshell detects regardless of whether direnv is
    // also configured. Precedence handles the overlap at merge time
    // (direnv > nix-devshell, so direnv's vars win on collisions when
    // both plugins export), and the per-provider toggle lets users
    // disable either one if they want a single-source setup.
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(tmp.path().join("flake.nix"), "{}").unwrap();
    std::fs::write(tmp.path().join(".envrc"), "use flake").unwrap();
    assert!(run_detect(
        "env-nix-devshell",
        NIX_SRC,
        &["nix"],
        tmp.path()
    ));
}

#[test]
fn nix_detect_skips_plain_repo() {
    let tmp = tempfile::tempdir().unwrap();
    assert!(!run_detect(
        "env-nix-devshell",
        NIX_SRC,
        &["nix"],
        tmp.path()
    ));
}

// ---------------------------------------------------------------------------
// Integration: real CLIs (gated behind build.rs probes)
// ---------------------------------------------------------------------------

/// Serialize HOME/XDG env overrides across integration tests. Tokio
/// tests run in parallel by default, and `std::env::set_var` is
/// process-global — concurrent integration tests tripping over each
/// other's HOME would produce flaky failures.
#[cfg(any(has_direnv, has_mise, has_nix))]
fn env_override_mutex() -> &'static std::sync::Mutex<()> {
    static M: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    M.get_or_init(|| std::sync::Mutex::new(()))
}

/// RAII guard that redirects HOME + XDG_*_HOME to a tempdir for the
/// duration of an integration test. Restores the prior values on drop
/// so subsequent tests (and the rest of the test binary) see the real
/// user env. Holds the serialization mutex across the whole test so
/// env overrides never overlap.
///
/// Why this matters: `direnv allow` and `mise trust` write their
/// trust-cache entries under `$XDG_DATA_HOME` / `$XDG_STATE_HOME`
/// (falling back to `$HOME/.local/share`). Without isolation, the
/// integration tests pollute the developer's real trust cache with
/// tempdir paths, and fail outright in sandboxed CI environments
/// where `~/.local/...` is read-only.
#[cfg(any(has_direnv, has_mise, has_nix))]
struct ScopedHome {
    _guard: std::sync::MutexGuard<'static, ()>,
    _tmp: tempfile::TempDir,
    prior: Vec<(&'static str, Option<String>)>,
}

#[cfg(any(has_direnv, has_mise, has_nix))]
impl ScopedHome {
    fn new() -> Self {
        let guard = env_override_mutex()
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().to_path_buf();
        let xdg_data = home.join(".local/share");
        let xdg_state = home.join(".local/state");
        let xdg_cache = home.join(".cache");
        let xdg_config = home.join(".config");
        for p in [&xdg_data, &xdg_state, &xdg_cache, &xdg_config] {
            std::fs::create_dir_all(p).unwrap();
        }

        let keys = [
            ("HOME", home.to_string_lossy().into_owned()),
            ("XDG_DATA_HOME", xdg_data.to_string_lossy().into_owned()),
            ("XDG_STATE_HOME", xdg_state.to_string_lossy().into_owned()),
            ("XDG_CACHE_HOME", xdg_cache.to_string_lossy().into_owned()),
            ("XDG_CONFIG_HOME", xdg_config.to_string_lossy().into_owned()),
        ];

        let prior: Vec<(&'static str, Option<String>)> = keys
            .iter()
            .map(|(k, _)| (*k, std::env::var(*k).ok()))
            .collect();

        for (k, v) in keys {
            // SAFETY: set_var is unsafe in edition 2024 because it can
            // race with other threads reading env. `env_override_mutex`
            // serializes all integration tests that mutate these keys,
            // and the keys are restored before the mutex releases.
            unsafe {
                std::env::set_var(k, v);
            }
        }

        Self {
            _guard: guard,
            _tmp: tmp,
            prior,
        }
    }
}

#[cfg(any(has_direnv, has_mise, has_nix))]
impl Drop for ScopedHome {
    fn drop(&mut self) {
        for (k, v) in &self.prior {
            unsafe {
                match v {
                    Some(val) => std::env::set_var(k, val),
                    None => std::env::remove_var(k),
                }
            }
        }
    }
}

// Gated as Unix-only: direnv 2.36 on Windows shells out to `bash` to
// evaluate the `.envrc`, and on a default Windows install bash receives
// direnv's own binary path with forward slashes and bails with
// `/bin/bash: line 1: "C:/.../direnv.exe": No such file or directory`.
// `direnv export json` therefore exits 1 with only its own DIRENV_*
// metadata in stdout — never the user's exports. The contract this test
// pins (exported var flows through) cannot be met until direnv ships a
// non-bash Windows runtime; the sibling `integration_direnv_auto_allow_
// off_surfaces_blocked_error` test exercises the blocked-error path
// which doesn't depend on `.envrc` evaluation and is left un-gated so
// it runs on every platform.
#[cfg(all(has_direnv, unix))]
#[tokio::test]
async fn integration_direnv_export_returns_env() {
    // Redirect HOME + XDG_*_HOME into a tempdir so `direnv allow`
    // writes to a disposable cache instead of the developer's real
    // `~/.local/share/direnv/allow/`.
    let _scoped = ScopedHome::new();

    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(
        tmp.path().join(".envrc"),
        "export CLAUDETTE_DIRENV_TEST=hello\n",
    )
    .unwrap();

    // direnv requires the .envrc to be allowed. direnv reads HOME for
    // its allow-cache location, which we've redirected above.
    let status = std::process::Command::new("direnv")
        .arg("allow")
        .current_dir(tmp.path())
        .status()
        .expect("direnv allow");
    assert!(status.success(), "direnv allow failed");

    // Seed the plugin into a temp plugin dir and discover.
    let plugin_dir = tempfile::tempdir().unwrap();
    crate::plugin_runtime::seed::seed_bundled_plugins(plugin_dir.path());
    let registry = crate::plugin_runtime::PluginRegistry::discover(plugin_dir.path());
    assert!(
        registry.plugins.contains_key("env-direnv"),
        "env-direnv should be seeded + discovered"
    );

    let backend = crate::env_provider::backend::PluginRegistryBackend::new(&registry);
    let cache = crate::env_provider::cache::EnvCache::new();
    let ws_info = WorkspaceInfo {
        id: "ws-int".into(),
        name: "test".into(),
        branch: "main".into(),
        worktree_path: tmp.path().to_string_lossy().into_owned(),
        repo_path: tmp.path().to_string_lossy().into_owned(),
        ..Default::default()
    };

    let resolved = crate::env_provider::resolve_for_workspace(
        &backend,
        &cache,
        tmp.path(),
        &ws_info,
        &Default::default(),
    )
    .await;
    let direnv_source = resolved
        .sources
        .iter()
        .find(|s| s.plugin_name == "env-direnv")
        .expect("env-direnv must appear in sources");
    assert!(
        direnv_source.error.is_none(),
        "direnv errored: {:?}",
        direnv_source.error
    );
    assert_eq!(
        resolved
            .vars
            .get("CLAUDETTE_DIRENV_TEST")
            .and_then(|v| v.as_deref()),
        Some("hello"),
        "expected CLAUDETTE_DIRENV_TEST=hello in merged env; full resolved = {resolved:#?}"
    );
    // End-to-end strip pin: real `direnv export json` always emits
    // DIRENV_DIR / DIRENV_FILE / DIRENV_DIFF / DIRENV_WATCHES memos.
    // The plugin must drop them before they reach the merged env, or
    // PTYs that inherit this env tell their `direnv hook zsh` to
    // skip the first-prompt re-export and never load .envrc-defined
    // shell functions.
    for marker in ["DIRENV_DIR", "DIRENV_FILE", "DIRENV_DIFF", "DIRENV_WATCHES"] {
        assert!(
            !resolved.vars.contains_key(marker),
            "expected {marker} stripped end-to-end, got {:?}",
            resolved.vars.keys().collect::<Vec<_>>()
        );
    }
}

#[cfg(has_mise)]
#[tokio::test]
async fn integration_mise_export_returns_env() {
    // See ScopedHome for why this matters — `mise trust` writes to
    // `$XDG_STATE_HOME/mise/trusted-configs/` (or equivalents).
    let _scoped = ScopedHome::new();

    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(
        tmp.path().join("mise.toml"),
        "[env]\nCLAUDETTE_MISE_TEST = \"world\"\n",
    )
    .unwrap();

    // mise requires explicit trust for per-project config.
    let status = std::process::Command::new("mise")
        .arg("trust")
        .current_dir(tmp.path())
        .status()
        .expect("mise trust");
    assert!(status.success(), "mise trust failed");

    let plugin_dir = tempfile::tempdir().unwrap();
    crate::plugin_runtime::seed::seed_bundled_plugins(plugin_dir.path());
    let registry = crate::plugin_runtime::PluginRegistry::discover(plugin_dir.path());

    let backend = crate::env_provider::backend::PluginRegistryBackend::new(&registry);
    let cache = crate::env_provider::cache::EnvCache::new();
    let ws_info = WorkspaceInfo {
        id: "ws-int".into(),
        name: "test".into(),
        branch: "main".into(),
        worktree_path: tmp.path().to_string_lossy().into_owned(),
        repo_path: tmp.path().to_string_lossy().into_owned(),
        ..Default::default()
    };

    let resolved = crate::env_provider::resolve_for_workspace(
        &backend,
        &cache,
        tmp.path(),
        &ws_info,
        &Default::default(),
    )
    .await;
    let mise_source = resolved
        .sources
        .iter()
        .find(|s| s.plugin_name == "env-mise")
        .expect("env-mise must appear in sources");
    assert!(
        mise_source.error.is_none(),
        "mise errored: {:?}",
        mise_source.error
    );
    assert_eq!(
        resolved
            .vars
            .get("CLAUDETTE_MISE_TEST")
            .and_then(|v| v.as_deref()),
        Some("world"),
    );
}

/// repo_trust default (unset / "ask"): an unallowed .envrc must stay
/// blocked. The plugin reports the error as-is; no retry is attempted,
/// and no vars are contributed. This is the "safe by default" path that
/// honors direnv's per-path trust model — Claudette only auto-runs
/// `direnv allow` for repos the user has explicitly trusted via the
/// per-repo prompt.
#[cfg(has_direnv)]
#[tokio::test]
async fn integration_direnv_untrusted_repo_surfaces_blocked_error() {
    let _scoped = ScopedHome::new();

    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(
        tmp.path().join(".envrc"),
        "export CLAUDETTE_DIRENV_DENY=oops\n",
    )
    .unwrap();

    // Intentionally DO NOT `direnv allow` — the .envrc must stay blocked.

    let plugin_dir = tempfile::tempdir().unwrap();
    crate::plugin_runtime::seed::seed_bundled_plugins(plugin_dir.path());
    let registry = crate::plugin_runtime::PluginRegistry::discover(plugin_dir.path());
    // No `repo_trust` override set — matches a fresh repo where the
    // user hasn't responded to the trust prompt yet.

    let backend = crate::env_provider::backend::PluginRegistryBackend::new(&registry);
    let cache = crate::env_provider::cache::EnvCache::new();
    let ws_info = WorkspaceInfo {
        id: "ws-deny".into(),
        name: "test".into(),
        branch: "main".into(),
        worktree_path: tmp.path().to_string_lossy().into_owned(),
        repo_path: tmp.path().to_string_lossy().into_owned(),
        ..Default::default()
    };

    let resolved = crate::env_provider::resolve_for_workspace(
        &backend,
        &cache,
        tmp.path(),
        &ws_info,
        &Default::default(),
    )
    .await;
    let direnv_source = resolved
        .sources
        .iter()
        .find(|s| s.plugin_name == "env-direnv")
        .expect("env-direnv must appear in sources");
    assert!(
        direnv_source.error.is_some(),
        "untrusted repo must surface the blocked error, got sources={:#?}",
        resolved.sources
    );
    let err = direnv_source.error.as_ref().unwrap();
    assert!(
        err.contains("blocked") || err.contains("allow"),
        "error should describe a blocked .envrc; got: {err}"
    );
    assert_eq!(direnv_source.vars_contributed, 0);
    assert!(
        !resolved.vars.contains_key("CLAUDETTE_DIRENV_DENY"),
        "no vars should leak from a blocked .envrc"
    );
}

/// `repo_trust = "allow"` must retry after `direnv allow` when the
/// .envrc is blocked. After the retry the plugin reports success and
/// vars flow through.
// Same Unix-only gate as `integration_direnv_export_returns_env`: this
// test asserts that after `direnv allow` runs, the retried export
// surfaces user-exported vars. On Windows direnv's bash-based .envrc
// evaluation never produces those vars regardless of allow state, so
// the post-retry assertion can't be met. See that test's comment for
// the upstream bash-on-Windows root cause.
#[cfg(all(has_direnv, unix))]
#[tokio::test]
async fn integration_direnv_trusted_repo_retries_after_blocked() {
    let _scoped = ScopedHome::new();

    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(
        tmp.path().join(".envrc"),
        "export CLAUDETTE_DIRENV_AUTO=yes\n",
    )
    .unwrap();

    let plugin_dir = tempfile::tempdir().unwrap();
    crate::plugin_runtime::seed::seed_bundled_plugins(plugin_dir.path());
    let registry = crate::plugin_runtime::PluginRegistry::discover(plugin_dir.path());
    // Per-repo trust: simulates the user clicking "Trust direnv for
    // this repo" in the EnvPanel error card. The plugin's Lua sees
    // `repo_trust = "allow"` via `host.config` and auto-runs
    // `direnv allow` on first encounter with a blocked .envrc.
    registry.set_repo_setting(
        "repo-trusted",
        "env-direnv",
        "repo_trust",
        Some(serde_json::json!("allow")),
    );

    let backend = crate::env_provider::backend::PluginRegistryBackend::new(&registry);
    let cache = crate::env_provider::cache::EnvCache::new();
    let ws_info = WorkspaceInfo {
        id: "ws-auto".into(),
        name: "test".into(),
        branch: "main".into(),
        worktree_path: tmp.path().to_string_lossy().into_owned(),
        repo_path: tmp.path().to_string_lossy().into_owned(),
        repo_id: Some("repo-trusted".into()),
    };

    let resolved = crate::env_provider::resolve_for_workspace(
        &backend,
        &cache,
        tmp.path(),
        &ws_info,
        &Default::default(),
    )
    .await;
    let direnv_source = resolved
        .sources
        .iter()
        .find(|s| s.plugin_name == "env-direnv")
        .expect("env-direnv must appear in sources");
    assert!(
        direnv_source.error.is_none(),
        "trusted repo must retry past the blocked error; got {:?}",
        direnv_source.error
    );
    assert_eq!(
        resolved
            .vars
            .get("CLAUDETTE_DIRENV_AUTO")
            .and_then(|v| v.as_deref()),
        Some("yes"),
    );
}

/// repo_trust default (unset / "ask"): an untrusted mise.toml must stay
/// blocked — errors surface as-is, no retry, no vars contributed.
#[cfg(has_mise)]
#[tokio::test]
async fn integration_mise_untrusted_repo_surfaces_untrusted_error() {
    let _scoped = ScopedHome::new();

    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(
        tmp.path().join("mise.toml"),
        "[env]\nCLAUDETTE_MISE_DENY = \"nope\"\n",
    )
    .unwrap();

    // Intentionally DO NOT `mise trust` — mise.toml must stay untrusted.

    let plugin_dir = tempfile::tempdir().unwrap();
    crate::plugin_runtime::seed::seed_bundled_plugins(plugin_dir.path());
    let registry = crate::plugin_runtime::PluginRegistry::discover(plugin_dir.path());
    // No `repo_trust` override — fresh repo, user hasn't decided yet.

    let backend = crate::env_provider::backend::PluginRegistryBackend::new(&registry);
    let cache = crate::env_provider::cache::EnvCache::new();
    let ws_info = WorkspaceInfo {
        id: "ws-mise-deny".into(),
        name: "test".into(),
        branch: "main".into(),
        worktree_path: tmp.path().to_string_lossy().into_owned(),
        repo_path: tmp.path().to_string_lossy().into_owned(),
        ..Default::default()
    };

    let resolved = crate::env_provider::resolve_for_workspace(
        &backend,
        &cache,
        tmp.path(),
        &ws_info,
        &Default::default(),
    )
    .await;
    let mise_source = resolved
        .sources
        .iter()
        .find(|s| s.plugin_name == "env-mise")
        .expect("env-mise must appear in sources");
    assert!(
        mise_source.error.is_some(),
        "untrusted repo must surface untrusted error; sources={:#?}",
        resolved.sources
    );
    let err = mise_source.error.as_ref().unwrap();
    assert!(
        err.contains("trust") || err.contains("not trusted"),
        "error should mention trust; got: {err}"
    );
    assert_eq!(mise_source.vars_contributed, 0);
    assert!(!resolved.vars.contains_key("CLAUDETTE_MISE_DENY"));
}

/// `repo_trust = "allow"` must retry after `mise trust` when the
/// mise.toml is untrusted, and then report success with vars flowing
/// through.
#[cfg(has_mise)]
#[tokio::test]
async fn integration_mise_trusted_repo_retries_after_untrusted() {
    let _scoped = ScopedHome::new();

    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(
        tmp.path().join("mise.toml"),
        "[env]\nCLAUDETTE_MISE_AUTO = \"yes\"\n",
    )
    .unwrap();

    let plugin_dir = tempfile::tempdir().unwrap();
    crate::plugin_runtime::seed::seed_bundled_plugins(plugin_dir.path());
    let registry = crate::plugin_runtime::PluginRegistry::discover(plugin_dir.path());
    // Per-repo trust: simulates clicking "Trust mise for this repo".
    registry.set_repo_setting(
        "repo-trusted-mise",
        "env-mise",
        "repo_trust",
        Some(serde_json::json!("allow")),
    );

    let backend = crate::env_provider::backend::PluginRegistryBackend::new(&registry);
    let cache = crate::env_provider::cache::EnvCache::new();
    let ws_info = WorkspaceInfo {
        id: "ws-mise-auto".into(),
        name: "test".into(),
        branch: "main".into(),
        worktree_path: tmp.path().to_string_lossy().into_owned(),
        repo_path: tmp.path().to_string_lossy().into_owned(),
        repo_id: Some("repo-trusted-mise".into()),
    };

    let resolved = crate::env_provider::resolve_for_workspace(
        &backend,
        &cache,
        tmp.path(),
        &ws_info,
        &Default::default(),
    )
    .await;
    let mise_source = resolved
        .sources
        .iter()
        .find(|s| s.plugin_name == "env-mise")
        .expect("env-mise must appear in sources");
    assert!(
        mise_source.error.is_none(),
        "trusted repo must retry past the untrusted error; got {:?}",
        mise_source.error
    );
    assert_eq!(
        resolved
            .vars
            .get("CLAUDETTE_MISE_AUTO")
            .and_then(|v| v.as_deref()),
        Some("yes"),
    );
}

/// End-to-end integration test for env-nix-devshell, opt-in.
///
/// `nix print-dev-env --json` on a fresh flake with a nixpkgs input
/// evaluates the flake from scratch; that's ~3s with warm nixpkgs in
/// the store and 10–60s cold. Too slow for the default fast-test loop,
/// so this is `#[ignore]`-gated plus a `CLAUDETTE_SLOW_TESTS=1`
/// backstop. Run it explicitly:
///
///   CLAUDETTE_SLOW_TESTS=1 cargo test -p claudette \
///     integration_nix_devshell_export_returns_env -- --ignored --nocapture
///
/// The env-var check exists so `cargo test -- --include-ignored` on a
/// machine without network/Nix still no-ops instead of failing.
///
/// Platform gating: `has_nix` evaluates to false on Windows (no native
/// Nix), so this test only compiles into the binary on Linux + macOS
/// where Nix is installed.
#[cfg(has_nix)]
#[ignore = "slow: needs nix + network; run with CLAUDETTE_SLOW_TESTS=1 -- --ignored"]
#[tokio::test]
async fn integration_nix_devshell_export_returns_env() {
    if std::env::var("CLAUDETTE_SLOW_TESTS").ok().as_deref() != Some("1") {
        eprintln!(
            "integration_nix_devshell_export_returns_env: skipped (set CLAUDETTE_SLOW_TESTS=1 to run)"
        );
        return;
    }

    // Redirect HOME + XDG_* so the test uses a disposable nix config
    // (we write `experimental-features = nix-command flakes` into the
    // scoped config below — nix needs the flake subsystem enabled for
    // `print-dev-env --json`). The scoped home also keeps any cache
    // sideeffects out of the developer's real dirs.
    let _scoped = ScopedHome::new();

    // Enable flakes inside the scoped XDG_CONFIG_HOME.
    let xdg_config = std::env::var("XDG_CONFIG_HOME").expect("ScopedHome sets XDG_CONFIG_HOME");
    let nix_cfg_dir = std::path::Path::new(&xdg_config).join("nix");
    std::fs::create_dir_all(&nix_cfg_dir).unwrap();
    std::fs::write(
        nix_cfg_dir.join("nix.conf"),
        "experimental-features = nix-command flakes\n",
    )
    .unwrap();

    // Trivial flake that pulls a pinned nixpkgs and exposes a devShell
    // with one exported env var. `mkShellNoCC` avoids the cc wrapper
    // derivation — faster than the default `mkShell`. The input is
    // pinned to a specific nixos-24.11 revision so the test resolves
    // deterministically across machines and isn't at the mercy of
    // nixos-unstable moving under us (or GitHub being slow when a cache
    // miss forces a fetch).
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(
        tmp.path().join("flake.nix"),
        r#"{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/50ab793786d9de88ee30ec4e4c24fb4236fc2674";
  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAll = f: builtins.listToAttrs (map (s: { name = s; value = f s; }) systems);
    in {
      devShells = forAll (system:
        let pkgs = nixpkgs.legacyPackages.${system};
        in { default = pkgs.mkShellNoCC { CLAUDETTE_NIX_TEST = "ok"; }; });
    };
}
"#,
    )
    .unwrap();

    let plugin_dir = tempfile::tempdir().unwrap();
    crate::plugin_runtime::seed::seed_bundled_plugins(plugin_dir.path());
    let registry = crate::plugin_runtime::PluginRegistry::discover(plugin_dir.path());
    assert!(
        registry.plugins.contains_key("env-nix-devshell"),
        "env-nix-devshell should be seeded + discovered"
    );

    let backend = crate::env_provider::backend::PluginRegistryBackend::new(&registry);
    let cache = crate::env_provider::cache::EnvCache::new();
    let ws_info = WorkspaceInfo {
        id: "ws-nix".into(),
        name: "test".into(),
        branch: "main".into(),
        worktree_path: tmp.path().to_string_lossy().into_owned(),
        repo_path: tmp.path().to_string_lossy().into_owned(),
        ..Default::default()
    };

    let resolved = crate::env_provider::resolve_for_workspace(
        &backend,
        &cache,
        tmp.path(),
        &ws_info,
        &Default::default(),
    )
    .await;

    let nix_source = resolved
        .sources
        .iter()
        .find(|s| s.plugin_name == "env-nix-devshell")
        .expect("env-nix-devshell must appear in sources");
    assert!(
        nix_source.error.is_none(),
        "nix-devshell errored: {:?}",
        nix_source.error
    );
    assert_eq!(
        resolved
            .vars
            .get("CLAUDETTE_NIX_TEST")
            .and_then(|v| v.as_deref()),
        Some("ok"),
        "expected CLAUDETTE_NIX_TEST=ok in merged env; full resolved = {resolved:#?}"
    );
}
