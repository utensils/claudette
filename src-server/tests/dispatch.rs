//! Tests that drive the server through its public `dispatch` /
//! `handle_request` entrypoints, the same path a WSS client takes.

use std::path::Path;
use std::sync::Arc;

use claudette::db::Database;
use claudette::model::Repository;
use claudette::plugin_runtime::PluginRegistry;
use claudette_server::handler::{dispatch, handle_request};
use claudette_server::ws::ServerState;
use serde_json::json;

struct Fixture {
    _repo_dir: tempfile::TempDir,
    _state_dir: tempfile::TempDir,
    state: Arc<ServerState>,
    repo: Repository,
}

async fn setup() -> Fixture {
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
        required_inputs: None,
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
    Fixture {
        _repo_dir: repo_dir,
        _state_dir: state_dir,
        state,
        repo,
    }
}

async fn run_git(cwd: &Path, args: &[&str]) {
    let status = claudette::process::command("git")
        .args(args)
        .current_dir(cwd)
        .status()
        .await
        .unwrap();
    assert!(status.success(), "git {args:?} failed in {cwd:?}");
}

#[tokio::test]
async fn unknown_method_is_a_json_rpc_error() {
    let f = setup().await;
    let resp = handle_request(&f.state, &json!({"id": 7, "method": "nope", "params": {}})).await;
    assert_eq!(resp["id"], 7);
    assert_eq!(resp["error"]["message"], "Unknown method: nope");
    assert!(resp.get("result").is_none());
}

#[tokio::test]
async fn session_crud_round_trips_through_dispatch() {
    let f = setup().await;
    let created = dispatch(
        &f.state,
        "create_workspace",
        json!({"repository_id": f.repo.id, "name": "remote-ws"}),
    )
    .await
    .unwrap();
    let workspace_id = created["workspace"]["id"].as_str().unwrap().to_string();
    let default_session_id = created["default_session_id"].as_str().unwrap().to_string();

    let sessions = dispatch(
        &f.state,
        "list_chat_sessions",
        json!({"workspace_id": workspace_id}),
    )
    .await
    .unwrap();
    let ids: Vec<&str> = sessions
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, vec![default_session_id.as_str()]);

    let second = dispatch(
        &f.state,
        "create_chat_session",
        json!({"workspace_id": workspace_id}),
    )
    .await
    .unwrap();
    let second_id = second["id"].as_str().unwrap().to_string();

    dispatch(
        &f.state,
        "rename_chat_session",
        json!({"chat_session_id": second_id, "name": "Renamed"}),
    )
    .await
    .unwrap();
    let fetched = dispatch(
        &f.state,
        "get_chat_session",
        json!({"chat_session_id": second_id}),
    )
    .await
    .unwrap();
    assert_eq!(fetched["name"], "Renamed");

    dispatch(
        &f.state,
        "archive_chat_session",
        json!({"chat_session_id": second_id}),
    )
    .await
    .unwrap();
    let active = dispatch(
        &f.state,
        "list_chat_sessions",
        json!({"workspace_id": workspace_id}),
    )
    .await
    .unwrap();
    assert_eq!(active.as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn emitted_events_reach_every_subscriber() {
    let f = setup().await;
    let mut a = f.state.events.subscribe();
    let mut b = f.state.events.subscribe();
    f.state
        .emit(json!({"event": "pty-exit", "payload": {"pty_id": 1}}));
    assert_eq!(a.recv().await.unwrap()["event"], "pty-exit");
    assert_eq!(b.recv().await.unwrap()["payload"]["pty_id"], 1);
}
