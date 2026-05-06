//! Integration test for env-provider activation through the remote
//! server (issue #409).
//!
//! Spawning the real `claude` CLI in CI isn't viable, so the test
//! exercises the same code paths the handler uses (`resolve_workspace_env`
//! → `ResolvedEnv::apply`) and verifies the merged env reaches a
//! subprocess via `tokio::process::Command`. This proves the registry +
//! cache + per-repo disabled lookup are wired into `ServerState` and
//! that `apply()` is called against the spawned command — the two
//! behaviours the issue specifies.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use claudette::model::{AgentStatus, Repository, Workspace, WorkspaceStatus};
use claudette::plugin_runtime::PluginRegistry;
use claudette_server::auth::{ServerConfig, ServerSection};
use claudette_server::handler::resolve_workspace_env;
use claudette_server::ws::ServerState;

/// Build a minimal `ServerConfig` for tests. The constructors now require
/// a config (so the runtime revocation check has something to consult);
/// these tests don't exercise auth, so an empty-shares config suffices.
fn test_config() -> ServerConfig {
    ServerConfig {
        server: ServerSection {
            name: "test".into(),
            port: 0,
            bind: "127.0.0.1".into(),
        },
        auth: None,
        shares: Vec::new(),
        sessions: Vec::new(),
    }
}

/// Build a synthetic env-provider plugin in `plugin_dir/env-fixture` that
/// detects whenever `.envrc` exists in the worktree and exports
/// `FOO=bar`. Avoids the real `direnv` dependency so the test runs on
/// any CI host.
fn write_fixture_plugin(plugin_dir: &std::path::Path) {
    let dir = plugin_dir.join("env-fixture");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("plugin.json"),
        r#"{
            "name": "env-fixture",
            "display_name": "Fixture",
            "version": "1.0.0",
            "description": "test-only env-provider",
            "kind": "env-provider",
            "operations": ["detect", "export"]
        }"#,
    )
    .unwrap();
    std::fs::write(
        dir.join("init.lua"),
        r#"
        local M = {}
        function M.detect(args)
          return host.file_exists(args.worktree .. "/.envrc")
        end
        function M.export(args)
          return { env = { FOO = "bar" }, watched = { args.worktree .. "/.envrc" } }
        end
        return M
        "#,
    )
    .unwrap();
}

fn make_repo(path: &str) -> Repository {
    Repository {
        id: "repo-1".into(),
        path: path.into(),
        name: "fixture-repo".into(),
        path_slug: "fixture-repo".into(),
        icon: None,
        created_at: "2026-01-01 00:00:00".into(),
        setup_script: None,
        custom_instructions: None,
        sort_order: 0,
        branch_rename_preferences: None,
        setup_script_auto_run: false,
        archive_script: None,
        archive_script_auto_run: false,
        base_branch: None,
        default_remote: None,
        path_valid: true,
    }
}

fn make_workspace(repo_id: &str, worktree: &str) -> Workspace {
    Workspace {
        id: "ws-1".into(),
        repository_id: repo_id.into(),
        name: "fixture-ws".into(),
        branch_name: "main".into(),
        worktree_path: Some(worktree.into()),
        status: WorkspaceStatus::Active,
        agent_status: AgentStatus::Idle,
        status_line: String::new(),
        created_at: "2026-01-01 00:00:00".into(),
        sort_order: 0,
    }
}

/// Build a `ServerState` with the fixture plugin and an `.envrc` in
/// the worktree. Shared setup for the resolve and apply tests below so
/// CI failures on either side point at the same minimal scaffolding.
async fn setup_state_with_envrc() -> (
    Arc<ServerState>,
    Repository,
    Workspace,
    tempfile::TempDir, // plugin_dir kept alive
    tempfile::TempDir, // worktree kept alive
    tempfile::TempDir, // db_dir kept alive
) {
    let plugin_dir = tempfile::tempdir().unwrap();
    write_fixture_plugin(plugin_dir.path());
    let plugins = PluginRegistry::discover(plugin_dir.path());
    assert!(
        plugins.plugins.contains_key("env-fixture"),
        "fixture plugin should have been discovered"
    );

    let worktree = tempfile::tempdir().unwrap();
    std::fs::write(worktree.path().join(".envrc"), "export FOO=bar").unwrap();

    let db_dir = tempfile::tempdir().unwrap();
    let db_path = db_dir.path().join("test.db");
    let _ = claudette::db::Database::open(&db_path).unwrap();

    let state = Arc::new(ServerState::new_with_plugins(
        db_path,
        PathBuf::from(worktree.path()),
        plugins,
        test_config(),
    ));

    let repo = make_repo(&worktree.path().to_string_lossy());
    let ws = make_workspace(&repo.id, &worktree.path().to_string_lossy());
    (state, repo, ws, plugin_dir, worktree, db_dir)
}

#[tokio::test]
async fn server_resolves_envrc_to_foo_bar() {
    // Cross-platform resolve assertion: regardless of the host OS, the
    // fixture plugin's `export` must contribute `FOO=bar` to the merged
    // env when `.envrc` is present in the worktree.
    let (state, repo, ws, _pd, _wt, _db_dir) = setup_state_with_envrc().await;
    let resolved = resolve_workspace_env(
        &state,
        &ws,
        Some(&repo),
        &ws.worktree_path.clone().unwrap(),
        HashSet::new(),
    )
    .await;

    assert_eq!(
        resolved.vars.get("FOO").and_then(|v| v.as_deref()),
        Some("bar"),
        "fixture plugin should export FOO=bar (sources: {:?})",
        resolved.sources
    );
}

#[cfg(unix)]
#[tokio::test]
async fn server_applies_resolved_env_to_spawned_command() {
    // Verifies the apply path: the handler hands the resolved env to
    // `agent::run_turn`, which calls `ResolvedEnv::apply` on a Command
    // before spawning. We replicate that here against `sh -c "echo $FOO"`
    // and assert the child sees the var. Gated to Unix because the
    // assertion shells out to `sh`; the equivalent Windows surface
    // (`cmd /C echo %FOO%`) is left as a follow-up if the server ships
    // a Windows port.
    let (state, repo, ws, _pd, _wt, _db_dir) = setup_state_with_envrc().await;
    let resolved = resolve_workspace_env(
        &state,
        &ws,
        Some(&repo),
        &ws.worktree_path.clone().unwrap(),
        HashSet::new(),
    )
    .await;

    let mut cmd = tokio::process::Command::new("sh");
    cmd.arg("-c").arg("printf '%s' \"$FOO\"");
    // Drop FOO from the parent env so we can't accidentally pass.
    cmd.env_remove("FOO");
    resolved.apply(&mut cmd);
    let output = cmd.output().await.unwrap();
    assert_eq!(
        String::from_utf8_lossy(&output.stdout),
        "bar",
        "spawned command should inherit FOO from resolved env"
    );
}

#[tokio::test]
async fn server_without_plugin_registry_returns_empty_env() {
    // Regression: existing remote-server deployments that don't have
    // bundled plugins (or that used the legacy `ServerState::new`
    // constructor) must keep getting an empty `ResolvedEnv`. The
    // handler's spawn path treats this as "no env-provider activation"
    // and the agent inherits its parent env unchanged.
    let db_dir = tempfile::tempdir().unwrap();
    let db_path = db_dir.path().join("test.db");
    let _ = claudette::db::Database::open(&db_path).unwrap();

    let worktree = tempfile::tempdir().unwrap();
    let state = Arc::new(ServerState::new(
        db_path,
        PathBuf::from(worktree.path()),
        test_config(),
    ));

    let repo = make_repo(&worktree.path().to_string_lossy());
    let ws = make_workspace(&repo.id, &worktree.path().to_string_lossy());
    let resolved = resolve_workspace_env(
        &state,
        &ws,
        Some(&repo),
        &ws.worktree_path.clone().unwrap(),
        HashSet::new(),
    )
    .await;

    assert!(
        resolved.vars.is_empty(),
        "no plugin registry → empty merged env (got {:?})",
        resolved.vars
    );
    assert!(resolved.sources.is_empty());
}

#[tokio::test]
async fn server_skips_disabled_provider_per_repo() {
    // Per-repo disable lives in app_settings. The handler reads the
    // setting synchronously and passes a `HashSet` of disabled names to
    // `resolve_workspace_env`, which forwards them to the dispatcher to
    // short-circuit detect/export. This test passes the disabled set
    // directly (rather than going through the app_settings round-trip)
    // since the handler-side `load_disabled_providers` is unit-tested
    // separately and the integration concern here is "does the server
    // honor a disabled plugin?".
    let plugin_dir = tempfile::tempdir().unwrap();
    write_fixture_plugin(plugin_dir.path());
    let plugins = PluginRegistry::discover(plugin_dir.path());

    let worktree = tempfile::tempdir().unwrap();
    std::fs::write(worktree.path().join(".envrc"), "export FOO=bar").unwrap();

    let db_dir = tempfile::tempdir().unwrap();
    let db_path = db_dir.path().join("test.db");
    let _ = claudette::db::Database::open(&db_path).unwrap();

    let state = Arc::new(ServerState::new_with_plugins(
        db_path,
        PathBuf::from(worktree.path()),
        plugins,
        test_config(),
    ));

    let repo = make_repo(&worktree.path().to_string_lossy());
    let ws = make_workspace(&repo.id, &worktree.path().to_string_lossy());
    let mut disabled = HashSet::new();
    disabled.insert("env-fixture".to_string());
    let resolved = resolve_workspace_env(
        &state,
        &ws,
        Some(&repo),
        &ws.worktree_path.clone().unwrap(),
        disabled,
    )
    .await;

    assert!(
        !resolved.vars.contains_key("FOO"),
        "disabled plugin must not contribute env vars"
    );
    let source = resolved
        .sources
        .iter()
        .find(|s| s.plugin_name == "env-fixture")
        .expect("plugin appears in sources");
    assert_eq!(source.error.as_deref(), Some("disabled"));
}
