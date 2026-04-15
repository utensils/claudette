use claudette::model::*;

// ─── ChatRole tests ─────────────────────────────────────────────────

/// ChatRole::as_str should return the expected lowercase string.
#[test]
fn test_model_chat_role_as_str() {
    assert_eq!(ChatRole::User.as_str(), "user");
    assert_eq!(ChatRole::Assistant.as_str(), "assistant");
    assert_eq!(ChatRole::System.as_str(), "system");
}

/// ChatRole::from_str should parse known roles.
#[test]
fn test_model_chat_role_from_str_known() {
    assert_eq!("user".parse::<ChatRole>().unwrap(), ChatRole::User);
    assert_eq!(
        "assistant".parse::<ChatRole>().unwrap(),
        ChatRole::Assistant
    );
    assert_eq!("system".parse::<ChatRole>().unwrap(), ChatRole::System);
}

/// ChatRole::from_str with unknown value should default to User (per impl).
#[test]
fn test_model_chat_role_from_str_unknown() {
    assert_eq!("unknown".parse::<ChatRole>().unwrap(), ChatRole::User);
    assert_eq!("".parse::<ChatRole>().unwrap(), ChatRole::User);
    assert_eq!("ASSISTANT".parse::<ChatRole>().unwrap(), ChatRole::User); // case sensitive
}

/// ChatRole::from_str is infallible (Err type is Infallible).
#[test]
fn test_model_chat_role_from_str_infallible() {
    let result: Result<ChatRole, _> = "anything".parse();
    assert!(result.is_ok());
}

// ─── WorkspaceStatus tests ──────────────────────────────────────────

/// WorkspaceStatus::as_str returns expected strings.
#[test]
fn test_model_workspace_status_as_str() {
    assert_eq!(WorkspaceStatus::Active.as_str(), "active");
    assert_eq!(WorkspaceStatus::Archived.as_str(), "archived");
}

/// WorkspaceStatus::from_str parses known values.
#[test]
fn test_model_workspace_status_from_str_known() {
    assert_eq!(
        "active".parse::<WorkspaceStatus>().unwrap(),
        WorkspaceStatus::Active
    );
    assert_eq!(
        "archived".parse::<WorkspaceStatus>().unwrap(),
        WorkspaceStatus::Archived
    );
}

/// WorkspaceStatus::from_str with unknown value defaults to Active.
#[test]
fn test_model_workspace_status_from_str_unknown() {
    assert_eq!(
        "deleted".parse::<WorkspaceStatus>().unwrap(),
        WorkspaceStatus::Active
    );
    assert_eq!(
        "".parse::<WorkspaceStatus>().unwrap(),
        WorkspaceStatus::Active
    );
    assert_eq!(
        "ARCHIVED".parse::<WorkspaceStatus>().unwrap(),
        WorkspaceStatus::Active
    );
}

// ─── AgentStatus tests ──────────────────────────────────────────────

/// AgentStatus::label returns correct strings.
#[test]
fn test_model_agent_status_label() {
    assert_eq!(AgentStatus::Running.label(), "Running");
    assert_eq!(AgentStatus::Idle.label(), "Idle");
    assert_eq!(AgentStatus::Stopped.label(), "Stopped");
    assert_eq!(AgentStatus::Error("oops".to_string()).label(), "Error");
}

/// AgentStatus equality -- Error variants with different messages.
#[test]
fn test_model_agent_status_error_equality() {
    let e1 = AgentStatus::Error("msg1".to_string());
    let e2 = AgentStatus::Error("msg2".to_string());
    assert_ne!(e1, e2);
    assert_eq!(e1.label(), e2.label()); // Both say "Error"
}

/// AgentStatus::Error with empty message.
#[test]
fn test_model_agent_status_error_empty_message() {
    let e = AgentStatus::Error(String::new());
    assert_eq!(e.label(), "Error");
}

// ─── Serialization tests ────────────────────────────────────────────

/// Repository should serialize to JSON with all expected fields.
#[test]
fn test_model_repository_serialize() {
    let repo = Repository {
        id: "r1".to_string(),
        path: "/tmp".to_string(),
        name: "test".to_string(),
        path_slug: "test".to_string(),
        icon: Some("rocket".to_string()),
        created_at: "2025-01-01".to_string(),
        setup_script: None,
        custom_instructions: None,
        sort_order: 0,
        branch_rename_preferences: None,
        path_valid: true,
    };
    let json = serde_json::to_string(&repo).unwrap();
    assert!(json.contains("\"id\":\"r1\""));
    assert!(json.contains("\"path_valid\":true"));
    assert!(json.contains("\"icon\":\"rocket\""));
}

/// Workspace should serialize correctly including status enums.
#[test]
fn test_model_workspace_serialize() {
    let ws = Workspace {
        id: "w1".to_string(),
        repository_id: "r1".to_string(),
        name: "ws".to_string(),
        branch_name: "branch".to_string(),
        worktree_path: None,
        status: WorkspaceStatus::Active,
        agent_status: AgentStatus::Running,
        status_line: "working...".to_string(),
        created_at: "2025-01-01".to_string(),
    };
    let json = serde_json::to_string(&ws).unwrap();
    assert!(json.contains("\"w1\""));
    // Check that status serializes properly
    let _: serde_json::Value = serde_json::from_str(&json).unwrap();
}

/// ChatMessage should serialize with all fields.
#[test]
fn test_model_chat_message_serialize() {
    let msg = ChatMessage {
        id: "m1".to_string(),
        workspace_id: "w1".to_string(),
        role: ChatRole::Assistant,
        content: "hello".to_string(),
        cost_usd: Some(0.01),
        duration_ms: Some(500),
        created_at: "2025-01-01".to_string(),
        thinking: Some("hmm".to_string()),
    };
    let json = serde_json::to_string(&msg).unwrap();
    assert!(json.contains("\"cost_usd\":0.01"));
    assert!(json.contains("\"thinking\":\"hmm\""));
}

/// Attachment serialization should skip the data field.
#[test]
fn test_model_attachment_serialize_skips_data() {
    let att = Attachment {
        id: "a1".to_string(),
        message_id: "m1".to_string(),
        filename: "test.png".to_string(),
        media_type: "image/png".to_string(),
        data: vec![1, 2, 3, 4, 5],
        width: Some(100),
        height: Some(200),
        size_bytes: 5,
        created_at: "2025-01-01".to_string(),
    };
    let json = serde_json::to_string(&att).unwrap();
    // data field should be skipped
    assert!(
        !json.contains("[1,2,3,4,5]"),
        "data should be skipped during serialization"
    );
    // Other fields should be present
    assert!(json.contains("\"filename\":\"test.png\""));
    assert!(json.contains("\"size_bytes\":5"));
}

/// ConversationCheckpoint serialization round-trip.
#[test]
fn test_model_checkpoint_serialize_roundtrip() {
    let cp = ConversationCheckpoint {
        id: "c1".to_string(),
        workspace_id: "w1".to_string(),
        message_id: "m1".to_string(),
        commit_hash: Some("abc123".to_string()),
        has_file_state: true,
        turn_index: 5,
        message_count: 10,
        created_at: "2025-01-01".to_string(),
    };
    let json = serde_json::to_string(&cp).unwrap();
    let roundtrip: ConversationCheckpoint = serde_json::from_str(&json).unwrap();
    assert_eq!(roundtrip.id, "c1");
    assert_eq!(roundtrip.commit_hash, Some("abc123".to_string()));
    assert!(roundtrip.has_file_state);
    assert_eq!(roundtrip.turn_index, 5);
    assert_eq!(roundtrip.message_count, 10);
}

/// FileStatus enum variants serialize correctly.
#[test]
fn test_model_file_status_serialize() {
    let added = serde_json::to_string(&diff::FileStatus::Added).unwrap();
    let deleted = serde_json::to_string(&diff::FileStatus::Deleted).unwrap();
    let renamed = serde_json::to_string(&diff::FileStatus::Renamed {
        from: "old.rs".to_string(),
    })
    .unwrap();
    assert!(!added.is_empty());
    assert!(!deleted.is_empty());
    assert!(renamed.contains("old.rs"));
}

/// DiffLineType equality.
#[test]
fn test_model_diff_line_type_equality() {
    assert_eq!(diff::DiffLineType::Context, diff::DiffLineType::Context);
    assert_eq!(diff::DiffLineType::Added, diff::DiffLineType::Added);
    assert_ne!(diff::DiffLineType::Added, diff::DiffLineType::Removed);
}

/// DiffViewMode equality.
#[test]
fn test_model_diff_view_mode() {
    assert_eq!(diff::DiffViewMode::Unified, diff::DiffViewMode::Unified);
    assert_ne!(diff::DiffViewMode::Unified, diff::DiffViewMode::SideBySide);
}

/// RemoteConnection serialization.
#[test]
fn test_model_remote_connection_serialize() {
    let rc = RemoteConnection {
        id: "rc1".to_string(),
        name: "my-server".to_string(),
        host: "192.168.1.1".to_string(),
        port: 443,
        session_token: None,
        cert_fingerprint: None,
        auto_connect: true,
        created_at: "2025-01-01".to_string(),
    };
    let json = serde_json::to_string(&rc).unwrap();
    assert!(json.contains("\"auto_connect\":true"));
    assert!(json.contains("\"port\":443"));
}

/// TerminalTab serialization.
#[test]
fn test_model_terminal_tab_serialize() {
    let tab = TerminalTab {
        id: 42,
        workspace_id: "w1".to_string(),
        title: "My Terminal".to_string(),
        is_script_output: true,
        sort_order: 3,
        created_at: "2025-01-01".to_string(),
    };
    let json = serde_json::to_string(&tab).unwrap();
    assert!(json.contains("\"id\":42"));
    assert!(json.contains("\"is_script_output\":true"));
}

/// TurnToolActivity serialization roundtrip.
#[test]
fn test_model_turn_tool_activity_serialize_roundtrip() {
    let act = TurnToolActivity {
        id: "t1".to_string(),
        checkpoint_id: "c1".to_string(),
        tool_use_id: "tu1".to_string(),
        tool_name: "Bash".to_string(),
        input_json: r#"{"command":"ls"}"#.to_string(),
        result_text: "file1 file2".to_string(),
        summary: "Listed files".to_string(),
        sort_order: 0,
    };
    let json = serde_json::to_string(&act).unwrap();
    let roundtrip: TurnToolActivity = serde_json::from_str(&json).unwrap();
    assert_eq!(roundtrip.tool_name, "Bash");
    assert_eq!(roundtrip.input_json, r#"{"command":"ls"}"#);
}
