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

#![cfg(test)]

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
        },
        config: Default::default(),
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
#[cfg(any(has_direnv, has_mise))]
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
#[cfg(any(has_direnv, has_mise))]
struct ScopedHome {
    _guard: std::sync::MutexGuard<'static, ()>,
    _tmp: tempfile::TempDir,
    prior: Vec<(&'static str, Option<String>)>,
}

#[cfg(any(has_direnv, has_mise))]
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

#[cfg(any(has_direnv, has_mise))]
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

#[cfg(has_direnv)]
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

/// auto_allow default (unset / false): an unallowed .envrc must stay
/// blocked. The plugin reports the error as-is; no retry is attempted,
/// and no vars are contributed. This is the "safe by default" path that
/// honors direnv's per-path trust model.
#[cfg(has_direnv)]
#[tokio::test]
async fn integration_direnv_auto_allow_off_surfaces_blocked_error() {
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
    // Explicit default — make sure auto_allow=false behaves the same as
    // "never configured" (manifest default).
    registry.set_setting("env-direnv", "auto_allow", Some(serde_json::json!(false)));

    let backend = crate::env_provider::backend::PluginRegistryBackend::new(&registry);
    let cache = crate::env_provider::cache::EnvCache::new();
    let ws_info = WorkspaceInfo {
        id: "ws-deny".into(),
        name: "test".into(),
        branch: "main".into(),
        worktree_path: tmp.path().to_string_lossy().into_owned(),
        repo_path: tmp.path().to_string_lossy().into_owned(),
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
        "auto_allow=false must surface the blocked error, got sources={:#?}",
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

/// auto_allow=true must retry after `direnv allow` when the .envrc is
/// blocked. After the retry the plugin reports success and vars flow
/// through.
#[cfg(has_direnv)]
#[tokio::test]
async fn integration_direnv_auto_allow_on_retries_after_blocked() {
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
    registry.set_setting("env-direnv", "auto_allow", Some(serde_json::json!(true)));

    let backend = crate::env_provider::backend::PluginRegistryBackend::new(&registry);
    let cache = crate::env_provider::cache::EnvCache::new();
    let ws_info = WorkspaceInfo {
        id: "ws-auto".into(),
        name: "test".into(),
        branch: "main".into(),
        worktree_path: tmp.path().to_string_lossy().into_owned(),
        repo_path: tmp.path().to_string_lossy().into_owned(),
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
        "auto_allow=true must retry past the blocked error; got {:?}",
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

/// auto_trust default (unset / false): an untrusted mise.toml must stay
/// blocked — errors surface as-is, no retry, no vars contributed.
#[cfg(has_mise)]
#[tokio::test]
async fn integration_mise_auto_trust_off_surfaces_untrusted_error() {
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
    registry.set_setting("env-mise", "auto_trust", Some(serde_json::json!(false)));

    let backend = crate::env_provider::backend::PluginRegistryBackend::new(&registry);
    let cache = crate::env_provider::cache::EnvCache::new();
    let ws_info = WorkspaceInfo {
        id: "ws-mise-deny".into(),
        name: "test".into(),
        branch: "main".into(),
        worktree_path: tmp.path().to_string_lossy().into_owned(),
        repo_path: tmp.path().to_string_lossy().into_owned(),
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
        "auto_trust=false must surface untrusted error; sources={:#?}",
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

/// auto_trust=true must retry after `mise trust` when the mise.toml is
/// untrusted, and then report success with vars flowing through.
#[cfg(has_mise)]
#[tokio::test]
async fn integration_mise_auto_trust_on_retries_after_untrusted() {
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
    registry.set_setting("env-mise", "auto_trust", Some(serde_json::json!(true)));

    let backend = crate::env_provider::backend::PluginRegistryBackend::new(&registry);
    let cache = crate::env_provider::cache::EnvCache::new();
    let ws_info = WorkspaceInfo {
        id: "ws-mise-auto".into(),
        name: "test".into(),
        branch: "main".into(),
        worktree_path: tmp.path().to_string_lossy().into_owned(),
        repo_path: tmp.path().to_string_lossy().into_owned(),
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
        "auto_trust=true must retry past the untrusted error; got {:?}",
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

// nix print-dev-env on a fresh flake evaluates the flake.nix from
// scratch, which can take 10-60s the first time. Skip the integration
// test for now — cargo test wall-clock matters more than coverage
// here. Unit tests + the manual verification plan cover the happy path.
