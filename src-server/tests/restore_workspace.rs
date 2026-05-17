//! Integration tests for the `restore_workspace` JSON-RPC handler.
//!
//! Mirrors the pattern in `interactive_controls.rs`: build a real
//! [`ServerState`] over a tempdir, set up a real on-disk git repo,
//! drive the workspace through `ops::workspace::{create, archive}`, then
//! exercise `handle_restore_workspace` directly so we don't have to
//! stand up a TLS WebSocket Writer.

use std::path::Path;
use std::sync::Arc;

use claudette::db::Database;
use claudette::model::Repository;
use claudette::ops::NoopHooks;
use claudette::ops::workspace::{self as ops_workspace, ArchiveParams, CreateParams};
use claudette::plugin_runtime::PluginRegistry;
use claudette_server::handler::handle_restore_workspace;
use claudette_server::ws::ServerState;

/// Build a real git repo + DB + `ServerState` so a restore test can
/// drive the full create → archive → restore cycle without mocking the
/// filesystem. Returns the temp dirs (kept alive for the test), the
/// state, and the inserted `Repository` row.
async fn setup() -> (
    tempfile::TempDir,
    tempfile::TempDir,
    Arc<ServerState>,
    Repository,
) {
    let repo_dir = tempfile::tempdir().unwrap();
    let repo_path = repo_dir.path();
    run_git(repo_path, &["init", "-b", "main"]).await;
    run_git(repo_path, &["config", "user.email", "test@test.com"]).await;
    run_git(repo_path, &["config", "user.name", "Test"]).await;
    std::fs::write(repo_path.join("README.md"), "# test").unwrap();
    run_git(repo_path, &["add", "-A"]).await;
    run_git(repo_path, &["commit", "-m", "initial"]).await;

    let state_dir = tempfile::tempdir().unwrap();
    let db_path = state_dir.path().join("test.db");
    let worktree_base = state_dir.path().join("workspaces");
    std::fs::create_dir_all(&worktree_base).unwrap();

    // Open + drop the DB so migrations land before we insert the
    // repository row through a fresh handle.
    let db = Database::open(&db_path).unwrap();
    let repo = Repository {
        id: uuid::Uuid::new_v4().to_string(),
        name: "test".to_string(),
        path: repo_path.to_string_lossy().to_string(),
        path_slug: "test".to_string(),
        icon: None,
        created_at: "0".to_string(),
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
    };
    db.insert_repository(&repo).unwrap();
    drop(db);

    let plugins = PluginRegistry::discover(state_dir.path());
    let state = Arc::new(ServerState::new_with_plugins(
        db_path,
        worktree_base,
        plugins,
    ));

    (repo_dir, state_dir, state, repo)
}

async fn run_git(cwd: &Path, args: &[&str]) {
    let status = tokio::process::Command::new("git")
        .args(args)
        .current_dir(cwd)
        .status()
        .await
        .unwrap();
    assert!(status.success(), "git {args:?} failed in {cwd:?}");
}

/// Happy path: create a workspace, archive it (worktree removed,
/// status flipped to `Archived`), then restore it through the new
/// handler. The response JSON must report `status == "Active"` and a
/// `worktree_path` that actually exists on disk.
#[tokio::test]
async fn restore_workspace_recreates_worktree_for_archived() {
    let (_repo_dir, _state_dir, state, repo) = setup().await;

    // Use the ops layer directly to set up the archived workspace so
    // the test exercises exactly the surface the server handler will
    // see at runtime.
    let worktree_base = state.worktree_base_dir.read().await.clone();
    let mut db = Database::open(&state.db_path).unwrap();
    let created = ops_workspace::create(
        &mut db,
        &NoopHooks,
        worktree_base.as_path(),
        CreateParams {
            repo_id: &repo.id,
            name: "feature",
            branch_prefix: "test/",
        },
    )
    .await
    .unwrap();
    let ws_id = created.workspace.id.clone();

    ops_workspace::archive(
        &mut db,
        &NoopHooks,
        ArchiveParams {
            workspace_id: &ws_id,
            delete_branch: false,
        },
    )
    .await
    .unwrap();
    drop(db);

    let result = handle_restore_workspace(&state, &ws_id)
        .await
        .expect("restore should succeed for an archived workspace");

    let worktree_path = result
        .get("worktree_path")
        .and_then(|v| v.as_str())
        .expect("response must include worktree_path");
    assert!(
        Path::new(worktree_path).is_dir(),
        "recreated worktree must exist on disk: {worktree_path}",
    );

    let status = result
        .pointer("/workspace/status")
        .and_then(|v| v.as_str())
        .expect("response must include workspace.status");
    // Workspace.status serializes via Serde's default for unit-variant
    // enums: the variant name verbatim, so "Active" not "active".
    assert_eq!(status, "Active");

    let workspace_id = result
        .pointer("/workspace/id")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    assert_eq!(workspace_id, ws_id);
}

/// Unknown workspace_id must surface a clear `"Workspace not found"`
/// error so a remote client can distinguish "stale list" from "server
/// is broken".
#[tokio::test]
async fn restore_workspace_errors_when_workspace_unknown() {
    let (_repo_dir, _state_dir, state, _repo) = setup().await;

    let err = handle_restore_workspace(&state, "no-such-id")
        .await
        .expect_err("must error on unknown workspace_id");
    assert!(
        err.contains("Workspace not found"),
        "unexpected error: {err}",
    );
}

/// Documents current desktop behavior: calling restore on a workspace
/// that is already `Active` falls through to `git::restore_worktree`,
/// which errors because the worktree directory already exists. Mobile
/// won't hit this path (its UI hides Active workspaces from the
/// Restore action), so a friendlier state guard is intentionally not
/// added — preserves parity with the inline Tauri implementation that
/// this RPC was extracted from.
#[tokio::test]
async fn restore_workspace_errors_when_workspace_already_active() {
    let (_repo_dir, _state_dir, state, repo) = setup().await;

    let worktree_base = state.worktree_base_dir.read().await.clone();
    let mut db = Database::open(&state.db_path).unwrap();
    let created = ops_workspace::create(
        &mut db,
        &NoopHooks,
        worktree_base.as_path(),
        CreateParams {
            repo_id: &repo.id,
            name: "feature",
            branch_prefix: "test/",
        },
    )
    .await
    .unwrap();
    drop(db);

    let err = handle_restore_workspace(&state, &created.workspace.id)
        .await
        .expect_err("restore on Active workspace must error");
    // Don't pin the exact git error string — it varies across git
    // versions. The contract under test is just "the call fails
    // rather than silently no-op'ing".
    assert!(!err.is_empty(), "error message must be non-empty");
}
