use claudette::db::Database;
use claudette::model::*;

// ─── Helper factories ───────────────────────────────────────────────

fn make_repo(id: &str, name: &str, path: &str) -> Repository {
    Repository {
        id: id.to_string(),
        path: path.to_string(),
        name: name.to_string(),
        path_slug: name.to_lowercase().replace(' ', "-"),
        icon: None,
        created_at: "2025-01-01T00:00:00Z".to_string(),
        setup_script: None,
        custom_instructions: None,
        sort_order: 0,
        branch_rename_preferences: None,
        path_valid: true,
    }
}

fn make_workspace(id: &str, repo_id: &str, name: &str) -> Workspace {
    Workspace {
        id: id.to_string(),
        repository_id: repo_id.to_string(),
        name: name.to_string(),
        branch_name: format!("branch-{name}"),
        worktree_path: None,
        status: WorkspaceStatus::Active,
        agent_status: AgentStatus::Stopped,
        status_line: String::new(),
        created_at: "2025-01-01T00:00:00Z".to_string(),
    }
}

fn make_message(id: &str, ws_id: &str, role: ChatRole, content: &str) -> ChatMessage {
    ChatMessage {
        id: id.to_string(),
        workspace_id: ws_id.to_string(),
        role,
        content: content.to_string(),
        cost_usd: None,
        duration_ms: None,
        created_at: "2025-01-01T00:00:00Z".to_string(),
        thinking: None,
    }
}

fn make_attachment(id: &str, msg_id: &str) -> Attachment {
    Attachment {
        id: id.to_string(),
        message_id: msg_id.to_string(),
        filename: "test.png".to_string(),
        media_type: "image/png".to_string(),
        data: vec![0x89, 0x50, 0x4E, 0x47],
        width: Some(100),
        height: Some(100),
        size_bytes: 4,
        created_at: "2025-01-01T00:00:00Z".to_string(),
    }
}

fn make_checkpoint(id: &str, ws_id: &str, msg_id: &str, turn: i32) -> ConversationCheckpoint {
    ConversationCheckpoint {
        id: id.to_string(),
        workspace_id: ws_id.to_string(),
        message_id: msg_id.to_string(),
        commit_hash: None,
        has_file_state: false,
        turn_index: turn,
        message_count: 1,
        created_at: "2025-01-01T00:00:00Z".to_string(),
    }
}

fn make_terminal_tab(id: i64, ws_id: &str) -> TerminalTab {
    TerminalTab {
        id,
        workspace_id: ws_id.to_string(),
        title: format!("Tab {id}"),
        is_script_output: false,
        sort_order: id as i32,
        created_at: "2025-01-01T00:00:00Z".to_string(),
    }
}

fn make_remote_connection(id: &str) -> RemoteConnection {
    RemoteConnection {
        id: id.to_string(),
        name: format!("conn-{id}"),
        host: "127.0.0.1".to_string(),
        port: 8080,
        session_token: None,
        cert_fingerprint: None,
        auto_connect: false,
        created_at: "2025-01-01T00:00:00Z".to_string(),
    }
}

// ─── Repository CRUD tests ──────────────────────────────────────────

/// Open an in-memory database and verify it returns Ok.
#[test]
fn test_db_open_in_memory() {
    let db = Database::open_in_memory();
    assert!(db.is_ok(), "open_in_memory should succeed");
}

/// Insert a repository and retrieve it by ID -- round-trip fidelity.
#[test]
fn test_db_insert_get_repository_roundtrip() {
    let db = Database::open_in_memory().unwrap();
    let repo = make_repo("r1", "My Repo", "/tmp/repo");
    db.insert_repository(&repo).unwrap();
    let fetched = db.get_repository("r1").unwrap();
    assert!(fetched.is_some());
    let fetched = fetched.unwrap();
    assert_eq!(fetched.id, "r1");
    assert_eq!(fetched.name, "My Repo");
    assert_eq!(fetched.path, "/tmp/repo");
    assert_eq!(fetched.path_slug, "my-repo");
}

/// Getting a repository that doesn't exist should return None, not error.
#[test]
fn test_db_get_repository_nonexistent() {
    let db = Database::open_in_memory().unwrap();
    let result = db.get_repository("does-not-exist").unwrap();
    assert!(result.is_none());
}

/// Inserting the same repository ID twice should trigger a constraint error.
#[test]
fn test_db_insert_repository_duplicate_id() {
    let db = Database::open_in_memory().unwrap();
    let repo = make_repo("r1", "Repo", "/tmp/r1");
    db.insert_repository(&repo).unwrap();
    let result = db.insert_repository(&repo);
    assert!(result.is_err(), "Duplicate insert should fail");
}

/// List repositories returns all inserted repos in some order.
#[test]
fn test_db_list_repositories() {
    let db = Database::open_in_memory().unwrap();
    db.insert_repository(&make_repo("r1", "A", "/a")).unwrap();
    db.insert_repository(&make_repo("r2", "B", "/b")).unwrap();
    let repos = db.list_repositories().unwrap();
    assert_eq!(repos.len(), 2);
}

/// List repositories on empty DB returns empty vec, not error.
#[test]
fn test_db_list_repositories_empty() {
    let db = Database::open_in_memory().unwrap();
    let repos = db.list_repositories().unwrap();
    assert!(repos.is_empty());
}

/// Delete a repository and verify it's gone.
#[test]
fn test_db_delete_repository_basic() {
    let db = Database::open_in_memory().unwrap();
    db.insert_repository(&make_repo("r1", "Repo", "/tmp/r"))
        .unwrap();
    db.delete_repository("r1").unwrap();
    assert!(db.get_repository("r1").unwrap().is_none());
}

/// Deleting a nonexistent repository should not error (idempotent).
#[test]
fn test_db_delete_repository_nonexistent() {
    let db = Database::open_in_memory().unwrap();
    let result = db.delete_repository("ghost");
    // Should succeed silently (DELETE WHERE id = ? affects 0 rows)
    assert!(result.is_ok());
}

/// Deleting a repository should cascade-delete all workspaces, messages,
/// attachments, and checkpoints belonging to it.
#[test]
fn test_db_delete_repository_cascade_deep() {
    let db = Database::open_in_memory().unwrap();
    let repo = make_repo("r1", "Repo", "/tmp/r");
    db.insert_repository(&repo).unwrap();

    let ws = make_workspace("w1", "r1", "ws-1");
    db.insert_workspace(&ws).unwrap();

    let msg = make_message("m1", "w1", ChatRole::User, "hello");
    db.insert_chat_message(&msg).unwrap();

    let att = make_attachment("a1", "m1");
    db.insert_attachment(&att).unwrap();

    let cp = make_checkpoint("c1", "w1", "m1", 0);
    db.insert_checkpoint(&cp).unwrap();

    let tab = make_terminal_tab(1, "w1");
    db.insert_terminal_tab(&tab).unwrap();

    // Delete the repository
    db.delete_repository("r1").unwrap();

    // Everything should be gone
    assert!(db.get_repository("r1").unwrap().is_none());
    assert!(db.list_workspaces().unwrap().is_empty());
    assert!(db.list_chat_messages("w1").unwrap().is_empty());
    assert!(db.list_attachments_for_message("m1").unwrap().is_empty());
    assert!(db.list_checkpoints("w1").unwrap().is_empty());
    assert!(db.list_terminal_tabs_by_workspace("w1").unwrap().is_empty());
}

/// Update repository path with an empty string -- should succeed but is
/// arguably invalid state.
#[test]
fn test_db_update_repository_path_empty() {
    let db = Database::open_in_memory().unwrap();
    db.insert_repository(&make_repo("r1", "R", "/tmp/r"))
        .unwrap();
    let result = db.update_repository_path("r1", "");
    assert!(result.is_ok());
    let repo = db.get_repository("r1").unwrap().unwrap();
    assert_eq!(repo.path, "");
}

/// Update repository name with a very long Unicode string.
#[test]
fn test_db_update_repository_name_unicode() {
    let db = Database::open_in_memory().unwrap();
    db.insert_repository(&make_repo("r1", "R", "/tmp/r"))
        .unwrap();
    let long_name = "🎉".repeat(10000);
    db.update_repository_name("r1", &long_name).unwrap();
    let repo = db.get_repository("r1").unwrap().unwrap();
    assert_eq!(repo.name, long_name);
}

/// Update a nonexistent repository's path -- should succeed silently (0 rows affected).
#[test]
fn test_db_update_repository_path_nonexistent() {
    let db = Database::open_in_memory().unwrap();
    let result = db.update_repository_path("ghost", "/new/path");
    assert!(result.is_ok());
}

/// Repository name containing null bytes.
#[test]
fn test_db_insert_repository_null_bytes_in_name() {
    let db = Database::open_in_memory().unwrap();
    let mut repo = make_repo("r1", "name\0with\0nulls", "/tmp/r");
    repo.name = "name\0with\0nulls".to_string();
    let result = db.insert_repository(&repo);
    // SQLite should handle this, but the data may be truncated or mangled
    assert!(result.is_ok());
}

/// Reorder repositories with an empty list should not error.
#[test]
fn test_db_reorder_repositories_empty() {
    let db = Database::open_in_memory().unwrap();
    let result = db.reorder_repositories(&[]);
    assert!(result.is_ok());
}

/// Reorder with IDs that don't exist should succeed silently.
#[test]
fn test_db_reorder_repositories_nonexistent_ids() {
    let db = Database::open_in_memory().unwrap();
    let result = db.reorder_repositories(&["ghost1".to_string(), "ghost2".to_string()]);
    assert!(result.is_ok());
}

/// Reorder with duplicate IDs -- does it assign sort orders correctly?
#[test]
fn test_db_reorder_repositories_duplicate_ids() {
    let db = Database::open_in_memory().unwrap();
    db.insert_repository(&make_repo("r1", "A", "/a")).unwrap();
    let result = db.reorder_repositories(&["r1".to_string(), "r1".to_string()]);
    // Should succeed (even though duplicate IDs are odd)
    assert!(result.is_ok());
}

/// Update repository icon to None (clearing it).
#[test]
fn test_db_update_repository_icon_clear() {
    let db = Database::open_in_memory().unwrap();
    db.insert_repository(&make_repo("r1", "R", "/r")).unwrap();
    db.update_repository_icon("r1", Some("rocket")).unwrap();
    let r = db.get_repository("r1").unwrap().unwrap();
    assert_eq!(r.icon, Some("rocket".to_string()));
    db.update_repository_icon("r1", None).unwrap();
    let r = db.get_repository("r1").unwrap().unwrap();
    assert!(r.icon.is_none());
}

/// Update setup script, custom instructions, and branch rename preferences.
#[test]
fn test_db_update_repository_optional_fields() {
    let db = Database::open_in_memory().unwrap();
    db.insert_repository(&make_repo("r1", "R", "/r")).unwrap();

    db.update_repository_setup_script("r1", Some("./setup.sh"))
        .unwrap();
    db.update_repository_custom_instructions("r1", Some("Be concise"))
        .unwrap();
    db.update_repository_branch_rename_preferences("r1", Some("kebab-case"))
        .unwrap();

    let r = db.get_repository("r1").unwrap().unwrap();
    assert_eq!(r.setup_script, Some("./setup.sh".to_string()));
    assert_eq!(r.custom_instructions, Some("Be concise".to_string()));
    assert_eq!(r.branch_rename_preferences, Some("kebab-case".to_string()));

    // Clear them
    db.update_repository_setup_script("r1", None).unwrap();
    db.update_repository_custom_instructions("r1", None)
        .unwrap();
    db.update_repository_branch_rename_preferences("r1", None)
        .unwrap();

    let r = db.get_repository("r1").unwrap().unwrap();
    assert!(r.setup_script.is_none());
    assert!(r.custom_instructions.is_none());
    assert!(r.branch_rename_preferences.is_none());
}

// ─── Workspace tests ────────────────────────────────────────────────

/// Insert and list workspaces -- verify round-trip.
#[test]
fn test_db_workspace_roundtrip() {
    let db = Database::open_in_memory().unwrap();
    db.insert_repository(&make_repo("r1", "R", "/r")).unwrap();
    let ws = make_workspace("w1", "r1", "my-workspace");
    db.insert_workspace(&ws).unwrap();
    let all = db.list_workspaces().unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].id, "w1");
    assert_eq!(all[0].name, "my-workspace");
}

/// Insert workspace with duplicate name under same repo -- should violate
/// UNIQUE constraint.
#[test]
fn test_db_insert_workspace_duplicate_name() {
    let db = Database::open_in_memory().unwrap();
    db.insert_repository(&make_repo("r1", "R", "/r")).unwrap();
    db.insert_workspace(&make_workspace("w1", "r1", "same-name"))
        .unwrap();
    let result = db.insert_workspace(&make_workspace("w2", "r1", "same-name"));
    assert!(
        result.is_err(),
        "Duplicate workspace name under same repo should fail"
    );
}

/// Two workspaces with the same name under different repos should be allowed.
#[test]
fn test_db_insert_workspace_same_name_different_repo() {
    let db = Database::open_in_memory().unwrap();
    db.insert_repository(&make_repo("r1", "R1", "/r1")).unwrap();
    db.insert_repository(&make_repo("r2", "R2", "/r2")).unwrap();
    db.insert_workspace(&make_workspace("w1", "r1", "same-name"))
        .unwrap();
    let result = db.insert_workspace(&make_workspace("w2", "r2", "same-name"));
    assert!(
        result.is_ok(),
        "Same name under different repos should be OK"
    );
}

/// Delete a workspace and verify messages and checkpoints are also deleted.
#[test]
fn test_db_delete_workspace_cascade() {
    let db = Database::open_in_memory().unwrap();
    db.insert_repository(&make_repo("r1", "R", "/r")).unwrap();
    db.insert_workspace(&make_workspace("w1", "r1", "ws"))
        .unwrap();
    db.insert_chat_message(&make_message("m1", "w1", ChatRole::User, "hi"))
        .unwrap();
    db.insert_checkpoint(&make_checkpoint("c1", "w1", "m1", 0))
        .unwrap();
    db.insert_terminal_tab(&make_terminal_tab(1, "w1")).unwrap();

    db.delete_workspace("w1").unwrap();

    assert!(db.list_chat_messages("w1").unwrap().is_empty());
    assert!(db.list_checkpoints("w1").unwrap().is_empty());
    assert!(db.list_terminal_tabs_by_workspace("w1").unwrap().is_empty());
}

/// Delete a workspace that doesn't exist -- should not error.
#[test]
fn test_db_delete_workspace_nonexistent() {
    let db = Database::open_in_memory().unwrap();
    let result = db.delete_workspace("ghost");
    assert!(result.is_ok());
}

/// Update workspace status to archived and back.
#[test]
fn test_db_update_workspace_status() {
    let db = Database::open_in_memory().unwrap();
    db.insert_repository(&make_repo("r1", "R", "/r")).unwrap();
    db.insert_workspace(&make_workspace("w1", "r1", "ws"))
        .unwrap();
    db.update_workspace_status("w1", &WorkspaceStatus::Archived, None)
        .unwrap();
    let ws = db.list_workspaces().unwrap();
    assert_eq!(ws[0].status, WorkspaceStatus::Archived);

    db.update_workspace_status("w1", &WorkspaceStatus::Active, Some("/tmp/wt"))
        .unwrap();
    let ws = db.list_workspaces().unwrap();
    assert_eq!(ws[0].status, WorkspaceStatus::Active);
    assert_eq!(ws[0].worktree_path, Some("/tmp/wt".to_string()));
}

/// Rename a workspace and verify both name and branch_name change.
#[test]
fn test_db_rename_workspace() {
    let db = Database::open_in_memory().unwrap();
    db.insert_repository(&make_repo("r1", "R", "/r")).unwrap();
    db.insert_workspace(&make_workspace("w1", "r1", "old-name"))
        .unwrap();
    db.rename_workspace("w1", "new-name", "branch-new-name")
        .unwrap();
    let ws = db.list_workspaces().unwrap();
    assert_eq!(ws[0].name, "new-name");
    assert_eq!(ws[0].branch_name, "branch-new-name");
}

/// Rename a workspace to a name that already exists under the same repo
/// should fail with uniqueness constraint.
#[test]
fn test_db_rename_workspace_to_duplicate_name() {
    let db = Database::open_in_memory().unwrap();
    db.insert_repository(&make_repo("r1", "R", "/r")).unwrap();
    db.insert_workspace(&make_workspace("w1", "r1", "name-a"))
        .unwrap();
    db.insert_workspace(&make_workspace("w2", "r1", "name-b"))
        .unwrap();
    let result = db.rename_workspace("w2", "name-a", "branch-a-copy");
    assert!(result.is_err(), "Renaming to existing name should fail");
}

/// Insert a workspace with an empty name -- does the DB allow it?
#[test]
fn test_db_insert_workspace_empty_name() {
    let db = Database::open_in_memory().unwrap();
    db.insert_repository(&make_repo("r1", "R", "/r")).unwrap();
    let ws = make_workspace("w1", "r1", "");
    // This may succeed or fail depending on constraints -- document behavior
    let result = db.insert_workspace(&ws);
    // Even if it succeeds, verify roundtrip
    if result.is_ok() {
        let all = db.list_workspaces().unwrap();
        assert_eq!(all[0].name, "");
    }
}

// ─── Chat message tests ─────────────────────────────────────────────

/// Insert and list chat messages -- verify ordering.
#[test]
fn test_db_chat_message_roundtrip() {
    let db = Database::open_in_memory().unwrap();
    db.insert_repository(&make_repo("r1", "R", "/r")).unwrap();
    db.insert_workspace(&make_workspace("w1", "r1", "ws"))
        .unwrap();
    db.insert_chat_message(&make_message("m1", "w1", ChatRole::User, "hello"))
        .unwrap();
    db.insert_chat_message(&make_message("m2", "w1", ChatRole::Assistant, "hi back"))
        .unwrap();
    let msgs = db.list_chat_messages("w1").unwrap();
    assert_eq!(msgs.len(), 2);
}

/// List messages for a nonexistent workspace should return empty, not error.
#[test]
fn test_db_list_messages_nonexistent_workspace() {
    let db = Database::open_in_memory().unwrap();
    let msgs = db.list_chat_messages("ghost").unwrap();
    assert!(msgs.is_empty());
}

/// Update message content and verify the change persists.
#[test]
fn test_db_update_message_content() {
    let db = Database::open_in_memory().unwrap();
    db.insert_repository(&make_repo("r1", "R", "/r")).unwrap();
    db.insert_workspace(&make_workspace("w1", "r1", "ws"))
        .unwrap();
    db.insert_chat_message(&make_message("m1", "w1", ChatRole::User, "original"))
        .unwrap();
    db.update_chat_message_content("m1", "updated").unwrap();
    let msgs = db.list_chat_messages("w1").unwrap();
    assert_eq!(msgs[0].content, "updated");
}

/// Update message cost with NaN -- does SQLite handle IEEE floats correctly?
#[test]
fn test_db_update_message_cost_nan() {
    let db = Database::open_in_memory().unwrap();
    db.insert_repository(&make_repo("r1", "R", "/r")).unwrap();
    db.insert_workspace(&make_workspace("w1", "r1", "ws"))
        .unwrap();
    db.insert_chat_message(&make_message("m1", "w1", ChatRole::User, "test"))
        .unwrap();
    let result = db.update_chat_message_cost("m1", f64::NAN, 1000);
    // NaN in SQLite may store as NULL or behave strangely
    assert!(result.is_ok());
}

/// Update message cost with infinity.
#[test]
fn test_db_update_message_cost_infinity() {
    let db = Database::open_in_memory().unwrap();
    db.insert_repository(&make_repo("r1", "R", "/r")).unwrap();
    db.insert_workspace(&make_workspace("w1", "r1", "ws"))
        .unwrap();
    db.insert_chat_message(&make_message("m1", "w1", ChatRole::User, "test"))
        .unwrap();
    let result = db.update_chat_message_cost("m1", f64::INFINITY, i64::MAX);
    assert!(result.is_ok());
}

/// Delete messages for a workspace -- verify they're gone.
#[test]
fn test_db_delete_messages_for_workspace() {
    let db = Database::open_in_memory().unwrap();
    db.insert_repository(&make_repo("r1", "R", "/r")).unwrap();
    db.insert_workspace(&make_workspace("w1", "r1", "ws"))
        .unwrap();
    db.insert_chat_message(&make_message("m1", "w1", ChatRole::User, "a"))
        .unwrap();
    db.insert_chat_message(&make_message("m2", "w1", ChatRole::User, "b"))
        .unwrap();
    db.delete_chat_messages_for_workspace("w1").unwrap();
    assert!(db.list_chat_messages("w1").unwrap().is_empty());
}

/// delete_messages_after should only delete messages after the given message ID.
#[test]
fn test_db_delete_messages_after() {
    let db = Database::open_in_memory().unwrap();
    db.insert_repository(&make_repo("r1", "R", "/r")).unwrap();
    db.insert_workspace(&make_workspace("w1", "r1", "ws"))
        .unwrap();
    db.insert_chat_message(&make_message("m1", "w1", ChatRole::User, "first"))
        .unwrap();
    db.insert_chat_message(&make_message("m2", "w1", ChatRole::User, "second"))
        .unwrap();
    db.insert_chat_message(&make_message("m3", "w1", ChatRole::User, "third"))
        .unwrap();

    let deleted = db.delete_messages_after("w1", "m1").unwrap();
    assert_eq!(deleted, 2);
    let msgs = db.list_chat_messages("w1").unwrap();
    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0].id, "m1");
}

/// delete_messages_after with a nonexistent message ID -- what happens?
#[test]
fn test_db_delete_messages_after_nonexistent_anchor() {
    let db = Database::open_in_memory().unwrap();
    db.insert_repository(&make_repo("r1", "R", "/r")).unwrap();
    db.insert_workspace(&make_workspace("w1", "r1", "ws"))
        .unwrap();
    db.insert_chat_message(&make_message("m1", "w1", ChatRole::User, "msg"))
        .unwrap();
    // If the anchor doesn't exist, rowid lookup may return nothing, potentially
    // deleting all or no messages
    let _deleted = db.delete_messages_after("w1", "ghost").unwrap();
    // With a nonexistent anchor, no rowid is found, so the subquery should
    // return no match and nothing gets deleted (or everything does -- bug?)
    let msgs = db.list_chat_messages("w1").unwrap();
    // We expect the message to still be there
    assert_eq!(
        msgs.len(),
        1,
        "Nonexistent anchor should not delete existing messages"
    );
}

/// last_message_per_workspace returns one message per workspace.
#[test]
fn test_db_last_message_per_workspace() {
    let db = Database::open_in_memory().unwrap();
    db.insert_repository(&make_repo("r1", "R", "/r")).unwrap();
    db.insert_workspace(&make_workspace("w1", "r1", "ws1"))
        .unwrap();
    db.insert_workspace(&make_workspace("w2", "r1", "ws2"))
        .unwrap();
    db.insert_chat_message(&make_message("m1", "w1", ChatRole::User, "first"))
        .unwrap();
    db.insert_chat_message(&make_message("m2", "w1", ChatRole::User, "second"))
        .unwrap();
    db.insert_chat_message(&make_message("m3", "w2", ChatRole::User, "only"))
        .unwrap();

    let last = db.last_message_per_workspace().unwrap();
    assert_eq!(last.len(), 2);
}

/// last_message_per_workspace on empty DB.
#[test]
fn test_db_last_message_per_workspace_empty() {
    let db = Database::open_in_memory().unwrap();
    let last = db.last_message_per_workspace().unwrap();
    assert!(last.is_empty());
}

/// Insert a message with extremely long content (1 MB).
#[test]
fn test_db_insert_message_very_long_content() {
    let db = Database::open_in_memory().unwrap();
    db.insert_repository(&make_repo("r1", "R", "/r")).unwrap();
    db.insert_workspace(&make_workspace("w1", "r1", "ws"))
        .unwrap();
    let big_content = "x".repeat(1_000_000);
    db.insert_chat_message(&make_message("m1", "w1", ChatRole::User, &big_content))
        .unwrap();
    let msgs = db.list_chat_messages("w1").unwrap();
    assert_eq!(msgs[0].content.len(), 1_000_000);
}

// ─── Attachment tests ───────────────────────────────────────────────

/// Insert and retrieve an attachment -- verify data round-trip.
#[test]
fn test_db_attachment_roundtrip() {
    let db = Database::open_in_memory().unwrap();
    db.insert_repository(&make_repo("r1", "R", "/r")).unwrap();
    db.insert_workspace(&make_workspace("w1", "r1", "ws"))
        .unwrap();
    db.insert_chat_message(&make_message("m1", "w1", ChatRole::User, "msg"))
        .unwrap();

    let att = make_attachment("a1", "m1");
    db.insert_attachment(&att).unwrap();

    let fetched = db.get_attachment("a1").unwrap().unwrap();
    assert_eq!(fetched.id, "a1");
    assert_eq!(fetched.filename, "test.png");
    assert_eq!(fetched.data, vec![0x89, 0x50, 0x4E, 0x47]);
    assert_eq!(fetched.size_bytes, 4);
}

/// Get attachment for nonexistent ID returns None.
#[test]
fn test_db_get_attachment_nonexistent() {
    let db = Database::open_in_memory().unwrap();
    assert!(db.get_attachment("ghost").unwrap().is_none());
}

/// Insert attachments batch with empty slice should succeed.
#[test]
fn test_db_insert_attachments_batch_empty() {
    let db = Database::open_in_memory().unwrap();
    let result = db.insert_attachments_batch(&[]);
    assert!(result.is_ok());
}

/// List attachments for multiple message IDs at once.
#[test]
fn test_db_list_attachments_for_messages() {
    let db = Database::open_in_memory().unwrap();
    db.insert_repository(&make_repo("r1", "R", "/r")).unwrap();
    db.insert_workspace(&make_workspace("w1", "r1", "ws"))
        .unwrap();
    db.insert_chat_message(&make_message("m1", "w1", ChatRole::User, "a"))
        .unwrap();
    db.insert_chat_message(&make_message("m2", "w1", ChatRole::User, "b"))
        .unwrap();

    db.insert_attachment(&make_attachment("a1", "m1")).unwrap();
    db.insert_attachment(&make_attachment("a2", "m2")).unwrap();

    let map = db
        .list_attachments_for_messages(&["m1".to_string(), "m2".to_string()])
        .unwrap();
    assert_eq!(map.len(), 2);
    assert!(map.contains_key("m1"));
    assert!(map.contains_key("m2"));
}

/// List attachments for messages with empty ID list.
#[test]
fn test_db_list_attachments_for_messages_empty_ids() {
    let db = Database::open_in_memory().unwrap();
    let map = db.list_attachments_for_messages(&[]).unwrap();
    assert!(map.is_empty());
}

/// Insert attachment with zero-length data.
#[test]
fn test_db_insert_attachment_empty_data() {
    let db = Database::open_in_memory().unwrap();
    db.insert_repository(&make_repo("r1", "R", "/r")).unwrap();
    db.insert_workspace(&make_workspace("w1", "r1", "ws"))
        .unwrap();
    db.insert_chat_message(&make_message("m1", "w1", ChatRole::User, "msg"))
        .unwrap();

    let att = Attachment {
        id: "a1".to_string(),
        message_id: "m1".to_string(),
        filename: String::new(),
        media_type: String::new(),
        data: vec![],
        width: None,
        height: None,
        size_bytes: 0,
        created_at: String::new(),
    };
    db.insert_attachment(&att).unwrap();
    let fetched = db.get_attachment("a1").unwrap().unwrap();
    assert!(fetched.data.is_empty());
}

// ─── Checkpoint tests ───────────────────────────────────────────────

/// Insert and list checkpoints for a workspace.
#[test]
fn test_db_checkpoint_roundtrip() {
    let db = Database::open_in_memory().unwrap();
    db.insert_repository(&make_repo("r1", "R", "/r")).unwrap();
    db.insert_workspace(&make_workspace("w1", "r1", "ws"))
        .unwrap();
    db.insert_chat_message(&make_message("m1", "w1", ChatRole::User, "msg"))
        .unwrap();
    db.insert_checkpoint(&make_checkpoint("c1", "w1", "m1", 0))
        .unwrap();
    let cps = db.list_checkpoints("w1").unwrap();
    assert_eq!(cps.len(), 1);
    assert_eq!(cps[0].id, "c1");
}

/// Get a specific checkpoint by ID.
#[test]
fn test_db_get_checkpoint() {
    let db = Database::open_in_memory().unwrap();
    db.insert_repository(&make_repo("r1", "R", "/r")).unwrap();
    db.insert_workspace(&make_workspace("w1", "r1", "ws"))
        .unwrap();
    db.insert_chat_message(&make_message("m1", "w1", ChatRole::User, "msg"))
        .unwrap();
    db.insert_checkpoint(&make_checkpoint("c1", "w1", "m1", 0))
        .unwrap();
    let cp = db.get_checkpoint("c1").unwrap();
    assert!(cp.is_some());
    assert_eq!(cp.unwrap().turn_index, 0);
}

/// Get checkpoint that doesn't exist.
#[test]
fn test_db_get_checkpoint_nonexistent() {
    let db = Database::open_in_memory().unwrap();
    assert!(db.get_checkpoint("ghost").unwrap().is_none());
}

/// latest_checkpoint returns the checkpoint with highest turn_index.
#[test]
fn test_db_latest_checkpoint() {
    let db = Database::open_in_memory().unwrap();
    db.insert_repository(&make_repo("r1", "R", "/r")).unwrap();
    db.insert_workspace(&make_workspace("w1", "r1", "ws"))
        .unwrap();
    db.insert_chat_message(&make_message("m1", "w1", ChatRole::User, "a"))
        .unwrap();
    db.insert_chat_message(&make_message("m2", "w1", ChatRole::User, "b"))
        .unwrap();
    db.insert_checkpoint(&make_checkpoint("c1", "w1", "m1", 0))
        .unwrap();
    db.insert_checkpoint(&make_checkpoint("c2", "w1", "m2", 1))
        .unwrap();
    let latest = db.latest_checkpoint("w1").unwrap().unwrap();
    assert_eq!(latest.id, "c2");
    assert_eq!(latest.turn_index, 1);
}

/// latest_checkpoint on workspace with no checkpoints.
#[test]
fn test_db_latest_checkpoint_none() {
    let db = Database::open_in_memory().unwrap();
    assert!(db.latest_checkpoint("w1").unwrap().is_none());
}

/// delete_checkpoints_after removes checkpoints with turn_index > given value.
#[test]
fn test_db_delete_checkpoints_after() {
    let db = Database::open_in_memory().unwrap();
    db.insert_repository(&make_repo("r1", "R", "/r")).unwrap();
    db.insert_workspace(&make_workspace("w1", "r1", "ws"))
        .unwrap();
    db.insert_chat_message(&make_message("m1", "w1", ChatRole::User, "a"))
        .unwrap();
    db.insert_chat_message(&make_message("m2", "w1", ChatRole::User, "b"))
        .unwrap();
    db.insert_chat_message(&make_message("m3", "w1", ChatRole::User, "c"))
        .unwrap();
    db.insert_checkpoint(&make_checkpoint("c0", "w1", "m1", 0))
        .unwrap();
    db.insert_checkpoint(&make_checkpoint("c1", "w1", "m2", 1))
        .unwrap();
    db.insert_checkpoint(&make_checkpoint("c2", "w1", "m3", 2))
        .unwrap();

    let deleted = db.delete_checkpoints_after("w1", 0).unwrap();
    assert_eq!(deleted, 2);
    let remaining = db.list_checkpoints("w1").unwrap();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].turn_index, 0);
}

/// Insert checkpoint files and retrieve them.
#[test]
fn test_db_checkpoint_files_roundtrip() {
    let db = Database::open_in_memory().unwrap();
    db.insert_repository(&make_repo("r1", "R", "/r")).unwrap();
    db.insert_workspace(&make_workspace("w1", "r1", "ws"))
        .unwrap();
    db.insert_chat_message(&make_message("m1", "w1", ChatRole::User, "msg"))
        .unwrap();
    db.insert_checkpoint(&make_checkpoint("c1", "w1", "m1", 0))
        .unwrap();

    let files = vec![CheckpointFile {
        id: "f1".to_string(),
        checkpoint_id: "c1".to_string(),
        file_path: "src/main.rs".to_string(),
        content: Some(b"fn main() {}".to_vec()),
        file_mode: 0o100644,
    }];
    db.insert_checkpoint_files(&files).unwrap();

    let fetched = db.get_checkpoint_files("c1").unwrap();
    assert_eq!(fetched.len(), 1);
    assert_eq!(fetched[0].file_path, "src/main.rs");
    assert_eq!(fetched[0].content, Some(b"fn main() {}".to_vec()));
}

/// has_checkpoint_files returns true/false correctly.
#[test]
fn test_db_has_checkpoint_files() {
    let db = Database::open_in_memory().unwrap();
    db.insert_repository(&make_repo("r1", "R", "/r")).unwrap();
    db.insert_workspace(&make_workspace("w1", "r1", "ws"))
        .unwrap();
    db.insert_chat_message(&make_message("m1", "w1", ChatRole::User, "msg"))
        .unwrap();
    db.insert_checkpoint(&make_checkpoint("c1", "w1", "m1", 0))
        .unwrap();

    assert!(!db.has_checkpoint_files("c1").unwrap());

    let files = vec![CheckpointFile {
        id: "f1".to_string(),
        checkpoint_id: "c1".to_string(),
        file_path: "file.rs".to_string(),
        content: Some(vec![]),
        file_mode: 0o100644,
    }];
    db.insert_checkpoint_files(&files).unwrap();
    assert!(db.has_checkpoint_files("c1").unwrap());
}

/// Insert checkpoint files with empty list should succeed.
#[test]
fn test_db_insert_checkpoint_files_empty() {
    let db = Database::open_in_memory().unwrap();
    let result = db.insert_checkpoint_files(&[]);
    assert!(result.is_ok());
}

/// Update checkpoint message count.
#[test]
fn test_db_update_checkpoint_message_count() {
    let db = Database::open_in_memory().unwrap();
    db.insert_repository(&make_repo("r1", "R", "/r")).unwrap();
    db.insert_workspace(&make_workspace("w1", "r1", "ws"))
        .unwrap();
    db.insert_chat_message(&make_message("m1", "w1", ChatRole::User, "msg"))
        .unwrap();
    db.insert_checkpoint(&make_checkpoint("c1", "w1", "m1", 0))
        .unwrap();
    db.update_checkpoint_message_count("c1", 42).unwrap();
    let cp = db.get_checkpoint("c1").unwrap().unwrap();
    assert_eq!(cp.message_count, 42);
}

// ─── Turn tool activity tests ───────────────────────────────────────

/// Insert and list completed turns with tool activities.
#[test]
fn test_db_turn_tool_activities_roundtrip() {
    let db = Database::open_in_memory().unwrap();
    db.insert_repository(&make_repo("r1", "R", "/r")).unwrap();
    db.insert_workspace(&make_workspace("w1", "r1", "ws"))
        .unwrap();
    db.insert_chat_message(&make_message("m1", "w1", ChatRole::User, "msg"))
        .unwrap();
    db.insert_checkpoint(&make_checkpoint("c1", "w1", "m1", 0))
        .unwrap();

    let activities = vec![TurnToolActivity {
        id: "t1".to_string(),
        checkpoint_id: "c1".to_string(),
        tool_use_id: "tu1".to_string(),
        tool_name: "Read".to_string(),
        input_json: r#"{"path":"foo.rs"}"#.to_string(),
        result_text: "contents".to_string(),
        summary: "Read foo.rs".to_string(),
        sort_order: 0,
    }];
    db.insert_turn_tool_activities(&activities).unwrap();
    let turns = db.list_completed_turns("w1").unwrap();
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0].activities.len(), 1);
    assert_eq!(turns[0].activities[0].tool_name, "Read");
}

/// save_turn_tool_activities atomically updates count + inserts activities.
#[test]
fn test_db_save_turn_tool_activities() {
    let db = Database::open_in_memory().unwrap();
    db.insert_repository(&make_repo("r1", "R", "/r")).unwrap();
    db.insert_workspace(&make_workspace("w1", "r1", "ws"))
        .unwrap();
    db.insert_chat_message(&make_message("m1", "w1", ChatRole::User, "msg"))
        .unwrap();
    db.insert_checkpoint(&make_checkpoint("c1", "w1", "m1", 0))
        .unwrap();

    let activities = vec![TurnToolActivity {
        id: "t1".to_string(),
        checkpoint_id: "c1".to_string(),
        tool_use_id: "tu1".to_string(),
        tool_name: "Edit".to_string(),
        input_json: "{}".to_string(),
        result_text: "ok".to_string(),
        summary: "Edited".to_string(),
        sort_order: 0,
    }];
    db.save_turn_tool_activities("c1", 5, &activities).unwrap();

    let cp = db.get_checkpoint("c1").unwrap().unwrap();
    assert_eq!(cp.message_count, 5);
}

// ─── Agent session tests ────────────────────────────────────────────

/// Save, get, and clear agent sessions.
#[test]
fn test_db_agent_session_lifecycle() {
    let db = Database::open_in_memory().unwrap();
    db.insert_repository(&make_repo("r1", "R", "/r")).unwrap();
    db.insert_workspace(&make_workspace("w1", "r1", "ws"))
        .unwrap();

    // No session initially
    assert!(db.get_agent_session("w1").unwrap().is_none());

    // Save a session
    db.save_agent_session("w1", "sess-123", 3).unwrap();
    let (sid, tc) = db.get_agent_session("w1").unwrap().unwrap();
    assert_eq!(sid, "sess-123");
    assert_eq!(tc, 3);

    // Update the session (upsert)
    db.save_agent_session("w1", "sess-456", 7).unwrap();
    let (sid, tc) = db.get_agent_session("w1").unwrap().unwrap();
    assert_eq!(sid, "sess-456");
    assert_eq!(tc, 7);

    // Clear the session
    db.clear_agent_session("w1").unwrap();
    assert!(db.get_agent_session("w1").unwrap().is_none());
}

/// Clear session on workspace with no session -- should not error.
#[test]
fn test_db_clear_agent_session_no_session() {
    let db = Database::open_in_memory().unwrap();
    let result = db.clear_agent_session("ghost");
    assert!(result.is_ok());
}

// ─── Terminal tab tests ─────────────────────────────────────────────

/// Insert and list terminal tabs.
#[test]
fn test_db_terminal_tab_roundtrip() {
    let db = Database::open_in_memory().unwrap();
    db.insert_repository(&make_repo("r1", "R", "/r")).unwrap();
    db.insert_workspace(&make_workspace("w1", "r1", "ws"))
        .unwrap();
    db.insert_terminal_tab(&make_terminal_tab(1, "w1")).unwrap();
    db.insert_terminal_tab(&make_terminal_tab(2, "w1")).unwrap();
    let tabs = db.list_terminal_tabs_by_workspace("w1").unwrap();
    assert_eq!(tabs.len(), 2);
}

/// max_terminal_tab_id on empty DB should return 0 (or some default).
#[test]
fn test_db_max_terminal_tab_id_empty() {
    let db = Database::open_in_memory().unwrap();
    let max_id = db.max_terminal_tab_id().unwrap();
    assert_eq!(max_id, 0);
}

/// Delete a terminal tab and verify it's gone.
#[test]
fn test_db_delete_terminal_tab() {
    let db = Database::open_in_memory().unwrap();
    db.insert_repository(&make_repo("r1", "R", "/r")).unwrap();
    db.insert_workspace(&make_workspace("w1", "r1", "ws"))
        .unwrap();
    db.insert_terminal_tab(&make_terminal_tab(1, "w1")).unwrap();
    db.delete_terminal_tab(1).unwrap();
    let tabs = db.list_terminal_tabs_by_workspace("w1").unwrap();
    assert!(tabs.is_empty());
}

/// Delete a nonexistent terminal tab -- should not error.
#[test]
fn test_db_delete_terminal_tab_nonexistent() {
    let db = Database::open_in_memory().unwrap();
    let result = db.delete_terminal_tab(999);
    assert!(result.is_ok());
}

/// Update terminal tab title.
#[test]
fn test_db_update_terminal_tab_title() {
    let db = Database::open_in_memory().unwrap();
    db.insert_repository(&make_repo("r1", "R", "/r")).unwrap();
    db.insert_workspace(&make_workspace("w1", "r1", "ws"))
        .unwrap();
    db.insert_terminal_tab(&make_terminal_tab(1, "w1")).unwrap();
    db.update_terminal_tab_title(1, "New Title").unwrap();
    let tabs = db.list_terminal_tabs_by_workspace("w1").unwrap();
    assert_eq!(tabs[0].title, "New Title");
}

/// Delete all terminal tabs for a workspace.
#[test]
fn test_db_delete_terminal_tabs_for_workspace() {
    let db = Database::open_in_memory().unwrap();
    db.insert_repository(&make_repo("r1", "R", "/r")).unwrap();
    db.insert_workspace(&make_workspace("w1", "r1", "ws"))
        .unwrap();
    db.insert_terminal_tab(&make_terminal_tab(1, "w1")).unwrap();
    db.insert_terminal_tab(&make_terminal_tab(2, "w1")).unwrap();
    db.delete_terminal_tabs_for_workspace("w1").unwrap();
    assert!(db.list_terminal_tabs_by_workspace("w1").unwrap().is_empty());
}

// ─── Remote connection tests ────────────────────────────────────────

/// Insert, list, get, and delete remote connections.
#[test]
fn test_db_remote_connection_lifecycle() {
    let db = Database::open_in_memory().unwrap();
    let conn = make_remote_connection("rc1");
    db.insert_remote_connection(&conn).unwrap();

    let all = db.list_remote_connections().unwrap();
    assert_eq!(all.len(), 1);

    let got = db.get_remote_connection("rc1").unwrap().unwrap();
    assert_eq!(got.name, "conn-rc1");

    db.delete_remote_connection("rc1").unwrap();
    assert!(db.get_remote_connection("rc1").unwrap().is_none());
}

/// Update remote connection session token and fingerprint.
#[test]
fn test_db_update_remote_connection_session() {
    let db = Database::open_in_memory().unwrap();
    db.insert_remote_connection(&make_remote_connection("rc1"))
        .unwrap();
    db.update_remote_connection_session("rc1", "tok-abc", "fp:de:ad:be:ef")
        .unwrap();
    let conn = db.get_remote_connection("rc1").unwrap().unwrap();
    assert_eq!(conn.session_token, Some("tok-abc".to_string()));
    assert_eq!(conn.cert_fingerprint, Some("fp:de:ad:be:ef".to_string()));
}

/// Get nonexistent remote connection.
#[test]
fn test_db_get_remote_connection_nonexistent() {
    let db = Database::open_in_memory().unwrap();
    assert!(db.get_remote_connection("ghost").unwrap().is_none());
}

// ─── App settings tests ─────────────────────────────────────────────

/// set and get app settings.
#[test]
fn test_db_app_settings() {
    let db = Database::open_in_memory().unwrap();
    assert!(db.get_app_setting("theme").unwrap().is_none());
    db.set_app_setting("theme", "dark").unwrap();
    assert_eq!(
        db.get_app_setting("theme").unwrap(),
        Some("dark".to_string())
    );
    // Overwrite
    db.set_app_setting("theme", "light").unwrap();
    assert_eq!(
        db.get_app_setting("theme").unwrap(),
        Some("light".to_string())
    );
}

/// Setting with empty key.
#[test]
fn test_db_app_setting_empty_key() {
    let db = Database::open_in_memory().unwrap();
    db.set_app_setting("", "value").unwrap();
    assert_eq!(db.get_app_setting("").unwrap(), Some("value".to_string()));
}

/// Setting with very long value.
#[test]
fn test_db_app_setting_long_value() {
    let db = Database::open_in_memory().unwrap();
    let big = "v".repeat(100_000);
    db.set_app_setting("k", &big).unwrap();
    assert_eq!(db.get_app_setting("k").unwrap().unwrap().len(), 100_000);
}

// ─── Slash command usage tests ──────────────────────────────────────

/// Record and retrieve slash command usage counts.
#[test]
fn test_db_slash_command_usage() {
    let db = Database::open_in_memory().unwrap();
    db.insert_repository(&make_repo("r1", "R", "/r")).unwrap();
    db.insert_workspace(&make_workspace("w1", "r1", "ws"))
        .unwrap();
    db.record_slash_command_usage("w1", "commit").unwrap();
    db.record_slash_command_usage("w1", "commit").unwrap();
    db.record_slash_command_usage("w1", "review").unwrap();

    let usage = db.get_slash_command_usage("w1").unwrap();
    assert_eq!(usage.get("commit"), Some(&2));
    assert_eq!(usage.get("review"), Some(&1));
}

/// Get slash command usage for workspace with no usage.
#[test]
fn test_db_slash_command_usage_empty() {
    let db = Database::open_in_memory().unwrap();
    let usage = db.get_slash_command_usage("ghost").unwrap();
    assert!(usage.is_empty());
}

// ─── MCP server tests ───────────────────────────────────────────────

/// Replace and list MCP servers for a repository.
#[test]
fn test_db_mcp_servers_replace_and_list() {
    let db = Database::open_in_memory().unwrap();
    db.insert_repository(&make_repo("r1", "R", "/r")).unwrap();

    let servers = vec![claudette::db::RepositoryMcpServer {
        id: "mcp1".to_string(),
        repository_id: "r1".to_string(),
        name: "test-server".to_string(),
        config_json: r#"{"command":"node","args":["server.js"]}"#.to_string(),
        source: "user".to_string(),
        created_at: "2025-01-01T00:00:00Z".to_string(),
        enabled: true,
    }];
    db.replace_repository_mcp_servers("r1", &servers).unwrap();

    let listed = db.list_repository_mcp_servers("r1").unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].name, "test-server");

    // Replace with empty -- should clear all
    db.replace_repository_mcp_servers("r1", &[]).unwrap();
    let listed = db.list_repository_mcp_servers("r1").unwrap();
    assert!(listed.is_empty());
}

/// Delete a single MCP server.
#[test]
fn test_db_delete_mcp_server() {
    let db = Database::open_in_memory().unwrap();
    db.insert_repository(&make_repo("r1", "R", "/r")).unwrap();
    let servers = vec![claudette::db::RepositoryMcpServer {
        id: "mcp1".to_string(),
        repository_id: "r1".to_string(),
        name: "s1".to_string(),
        config_json: "{}".to_string(),
        source: "user".to_string(),
        created_at: String::new(),
        enabled: true,
    }];
    db.replace_repository_mcp_servers("r1", &servers).unwrap();
    db.delete_repository_mcp_server("mcp1").unwrap();
    assert!(db.list_repository_mcp_servers("r1").unwrap().is_empty());
}

/// Delete nonexistent MCP server -- should not error.
#[test]
fn test_db_delete_mcp_server_nonexistent() {
    let db = Database::open_in_memory().unwrap();
    let result = db.delete_repository_mcp_server("ghost");
    assert!(result.is_ok());
}

// ─── Cross-entity invariant tests ───────────────────────────────────

/// Inserting a workspace for a nonexistent repo -- does FK constraint catch it?
#[test]
fn test_db_workspace_orphan_foreign_key() {
    let db = Database::open_in_memory().unwrap();
    let ws = make_workspace("w1", "no-such-repo", "ws");
    let result = db.insert_workspace(&ws);
    // If FK constraints are enabled, this should fail
    // If not, it might succeed -- which would be a bug
    assert!(
        result.is_err(),
        "Inserting a workspace for a nonexistent repository should fail with FK constraint"
    );
}

/// Inserting a message for a nonexistent workspace -- FK constraint?
#[test]
fn test_db_message_orphan_foreign_key() {
    let db = Database::open_in_memory().unwrap();
    let msg = make_message("m1", "no-such-ws", ChatRole::User, "hi");
    let result = db.insert_chat_message(&msg);
    assert!(
        result.is_err(),
        "Inserting a message for a nonexistent workspace should fail with FK constraint"
    );
}

/// Inserting an attachment for a nonexistent message -- FK constraint?
#[test]
fn test_db_attachment_orphan_foreign_key() {
    let db = Database::open_in_memory().unwrap();
    let att = make_attachment("a1", "no-such-msg");
    let result = db.insert_attachment(&att);
    assert!(
        result.is_err(),
        "Inserting an attachment for a nonexistent message should fail with FK constraint"
    );
}

/// Inserting a checkpoint for a nonexistent workspace -- FK constraint?
#[test]
fn test_db_checkpoint_orphan_foreign_key() {
    let db = Database::open_in_memory().unwrap();
    let cp = make_checkpoint("c1", "no-such-ws", "m1", 0);
    let result = db.insert_checkpoint(&cp);
    assert!(
        result.is_err(),
        "Inserting a checkpoint for a nonexistent workspace should fail with FK constraint"
    );
}
