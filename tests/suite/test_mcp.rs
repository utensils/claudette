use claudette::mcp::*;

/// serialize_for_cli with empty slice should produce valid JSON with empty mcpServers.
#[test]
fn test_mcp_serialize_for_cli_empty() {
    let result = serialize_for_cli(&[]);
    let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
    assert!(parsed["mcpServers"].is_object());
    assert_eq!(parsed["mcpServers"].as_object().unwrap().len(), 0);
}

/// serialize_for_cli with one server should produce correct structure.
#[test]
fn test_mcp_serialize_for_cli_one_server() {
    let server = McpServer {
        name: "test-server".to_string(),
        config: serde_json::json!({"command": "node", "args": ["server.js"]}),
        source: McpSource::UserProjectConfig,
    };
    let result = serialize_for_cli(&[server]);
    let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
    assert!(parsed["mcpServers"]["test-server"].is_object());
    assert_eq!(parsed["mcpServers"]["test-server"]["command"], "node");
}

/// serialize_for_cli with multiple servers.
#[test]
fn test_mcp_serialize_for_cli_multiple_servers() {
    let servers = vec![
        McpServer {
            name: "s1".to_string(),
            config: serde_json::json!({"command": "a"}),
            source: McpSource::UserProjectConfig,
        },
        McpServer {
            name: "s2".to_string(),
            config: serde_json::json!({"command": "b"}),
            source: McpSource::RepoLocalConfig,
        },
    ];
    let result = serialize_for_cli(&servers);
    let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
    assert!(parsed["mcpServers"]["s1"].is_object());
    assert!(parsed["mcpServers"]["s2"].is_object());
}

/// serialize_for_cli with duplicate server names -- last one wins?
#[test]
fn test_mcp_serialize_for_cli_duplicate_names() {
    let servers = vec![
        McpServer {
            name: "dup".to_string(),
            config: serde_json::json!({"command": "first"}),
            source: McpSource::UserProjectConfig,
        },
        McpServer {
            name: "dup".to_string(),
            config: serde_json::json!({"command": "second"}),
            source: McpSource::RepoLocalConfig,
        },
    ];
    let result = serialize_for_cli(&servers);
    let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
    // JSON objects with duplicate keys -- serde_json keeps the last one
    let cmd = parsed["mcpServers"]["dup"]["command"].as_str().unwrap();
    assert_eq!(cmd, "second", "Duplicate key should keep last value");
}

/// Server name with special characters.
#[test]
fn test_mcp_serialize_for_cli_special_name() {
    let server = McpServer {
        name: "my-server/with.dots".to_string(),
        config: serde_json::json!({}),
        source: McpSource::UserProjectConfig,
    };
    let result = serialize_for_cli(&[server]);
    let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
    assert!(parsed["mcpServers"]["my-server/with.dots"].is_object());
}

/// Server name is empty string.
#[test]
fn test_mcp_serialize_for_cli_empty_name() {
    let server = McpServer {
        name: String::new(),
        config: serde_json::json!({"x": 1}),
        source: McpSource::UserProjectConfig,
    };
    let result = serialize_for_cli(&[server]);
    let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
    assert!(parsed["mcpServers"][""].is_object());
}

/// McpSource serialization round-trip.
#[test]
fn test_mcp_source_serialize_roundtrip() {
    let s1 = McpSource::UserProjectConfig;
    let s2 = McpSource::RepoLocalConfig;
    let j1 = serde_json::to_string(&s1).unwrap();
    let j2 = serde_json::to_string(&s2).unwrap();
    let r1: McpSource = serde_json::from_str(&j1).unwrap();
    let r2: McpSource = serde_json::from_str(&j2).unwrap();
    assert_eq!(r1, McpSource::UserProjectConfig);
    assert_eq!(r2, McpSource::RepoLocalConfig);
}

/// McpSource uses snake_case serialization.
#[test]
fn test_mcp_source_serde_format() {
    let j = serde_json::to_string(&McpSource::UserProjectConfig).unwrap();
    assert!(
        j.contains("user_project_config"),
        "Expected snake_case: {j}"
    );
    let j = serde_json::to_string(&McpSource::RepoLocalConfig).unwrap();
    assert!(j.contains("repo_local_config"), "Expected snake_case: {j}");
}

/// detect_mcp_servers with nonexistent path should not panic.
/// May return global/plugin MCPs even for nonexistent paths.
#[test]
fn test_mcp_detect_nonexistent_path() {
    let _result = detect_mcp_servers(std::path::Path::new("/tmp/nonexistent_path_12345"));
    // Should not panic — may still return user-global or plugin MCPs.
}

/// detect_mcp_servers with empty path should not panic.
#[test]
fn test_mcp_detect_empty_path() {
    let _result = detect_mcp_servers(std::path::Path::new(""));
}

/// detect_mcp_servers with a temp directory (no .claude.json present) should not panic.
/// May return user-global or plugin MCPs from the host environment.
#[test]
fn test_mcp_detect_clean_directory() {
    let dir = tempfile::tempdir().unwrap();
    let result = detect_mcp_servers(dir.path());
    // No project-local MCPs should appear, but globals/plugins may.
    assert!(result.iter().all(|s| !matches!(
        s.source,
        McpSource::ProjectMcpJson | McpSource::RepoLocalConfig
    )));
}

// ---------------------------------------------------------------------------
// detect_project_mcp_json tests
// ---------------------------------------------------------------------------

/// Valid .mcp.json with one server returns 1 McpServer with ProjectMcpJson source.
#[test]
fn test_mcp_detect_project_mcp_json_valid() {
    use claudette::mcp::detect_project_mcp_json;

    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join(".mcp.json"),
        r#"{"mcpServers":{"myserver":{"command":"node","args":["srv.js"]}}}"#,
    )
    .unwrap();

    let servers = detect_project_mcp_json(dir.path()).expect("should return Some");
    assert_eq!(servers.len(), 1);
    assert_eq!(servers[0].name, "myserver");
    assert_eq!(servers[0].source, McpSource::ProjectMcpJson);
    assert_eq!(servers[0].config["command"], "node");
}

/// Config missing "type" gets "type":"stdio" added by normalize_mcp_config.
#[test]
fn test_mcp_detect_project_mcp_json_adds_stdio_type() {
    use claudette::mcp::detect_project_mcp_json;

    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join(".mcp.json"),
        r#"{"mcpServers":{"srv":{"command":"node","args":["index.js"]}}}"#,
    )
    .unwrap();

    let servers = detect_project_mcp_json(dir.path()).unwrap();
    assert_eq!(servers.len(), 1);
    // normalize_mcp_config should have injected "type":"stdio".
    assert_eq!(servers[0].config["type"], "stdio");
    assert_eq!(servers[0].config["command"], "node");
}

/// Config with "type":"url" is preserved (not overwritten to "stdio").
#[test]
fn test_mcp_detect_project_mcp_json_preserves_url_type() {
    use claudette::mcp::detect_project_mcp_json;

    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join(".mcp.json"),
        r#"{"mcpServers":{"srv":{"type":"url","url":"https://example.com/mcp"}}}"#,
    )
    .unwrap();

    let servers = detect_project_mcp_json(dir.path()).unwrap();
    assert_eq!(servers.len(), 1);
    assert_eq!(servers[0].config["type"], "url");
}

/// Malformed JSON in .mcp.json returns None (not a panic).
#[test]
fn test_mcp_detect_project_mcp_json_malformed_returns_none() {
    use claudette::mcp::detect_project_mcp_json;

    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(".mcp.json"), "{{invalid json!!!").unwrap();

    assert!(detect_project_mcp_json(dir.path()).is_none());
}

/// Empty mcpServers object returns Some(empty vec).
#[test]
fn test_mcp_detect_project_mcp_json_empty_servers() {
    use claudette::mcp::detect_project_mcp_json;

    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(".mcp.json"), r#"{"mcpServers":{}}"#).unwrap();

    let servers = detect_project_mcp_json(dir.path());
    assert!(servers.is_some());
    assert!(servers.unwrap().is_empty());
}

/// No .mcp.json file returns None.
#[test]
fn test_mcp_detect_project_mcp_json_missing_file() {
    use claudette::mcp::detect_project_mcp_json;

    let dir = tempfile::tempdir().unwrap();
    assert!(detect_project_mcp_json(dir.path()).is_none());
}

// ---------------------------------------------------------------------------
// detect_mcp_servers override order
// ---------------------------------------------------------------------------

/// .mcp.json servers appear in detect_mcp_servers output with ProjectMcpJson source.
#[test]
fn test_mcp_detect_servers_project_json_included() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path();

    // Init a git repo so detect_mcp_servers doesn't trip on git operations.
    std::process::Command::new("git")
        .args(["init"])
        .current_dir(repo)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap();

    std::fs::write(
        repo.join(".mcp.json"),
        r#"{"mcpServers":{"proj-srv":{"type":"stdio","command":"echo"}}}"#,
    )
    .unwrap();

    let servers = detect_mcp_servers(repo);
    let proj_srv = servers.iter().find(|s| s.name == "proj-srv");
    assert!(proj_srv.is_some(), "proj-srv should be present in output");
    assert_eq!(proj_srv.unwrap().source, McpSource::ProjectMcpJson);
}

// ---------------------------------------------------------------------------
// rows_to_servers edge cases
// ---------------------------------------------------------------------------

/// Unknown source string falls back to UserProjectConfig.
#[test]
fn test_mcp_rows_to_servers_unknown_source() {
    use claudette::db::RepositoryMcpServer;
    use claudette::mcp::rows_to_servers;

    let row = RepositoryMcpServer {
        id: "id-1".to_string(),
        repository_id: "r1".to_string(),
        name: "srv".to_string(),
        config_json: r#"{"type":"stdio","command":"echo"}"#.to_string(),
        source: "unknown_value".to_string(),
        created_at: String::new(),
        enabled: true,
    };

    let result = rows_to_servers(&[row]);
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].0.source, McpSource::UserProjectConfig);
}

/// Row with invalid JSON in config_json is silently skipped.
#[test]
fn test_mcp_rows_to_servers_invalid_config_json() {
    use claudette::db::RepositoryMcpServer;
    use claudette::mcp::rows_to_servers;

    let row = RepositoryMcpServer {
        id: "id-bad".to_string(),
        repository_id: "r1".to_string(),
        name: "bad-srv".to_string(),
        config_json: "not json at all {{{".to_string(),
        source: "user_project_config".to_string(),
        created_at: String::new(),
        enabled: true,
    };

    let result = rows_to_servers(&[row]);
    assert!(result.is_empty(), "invalid JSON row should be skipped");
}

// ---------------------------------------------------------------------------
// normalize_mcp_config
// ---------------------------------------------------------------------------

/// Object without "type" gets "type":"stdio" added.
#[test]
fn test_mcp_normalize_config_adds_type() {
    use claudette::mcp::normalize_mcp_config;

    let config = serde_json::json!({"command": "node", "args": ["srv.js"]});
    let normalized = normalize_mcp_config(config);
    assert_eq!(normalized["type"], "stdio");
    assert_eq!(normalized["command"], "node");
}

/// Object with existing "type":"sse" is unchanged.
#[test]
fn test_mcp_normalize_config_preserves_type() {
    use claudette::mcp::normalize_mcp_config;

    let config = serde_json::json!({"type": "sse", "url": "https://example.com"});
    let normalized = normalize_mcp_config(config);
    assert_eq!(normalized["type"], "sse");
}

/// Non-object values (array, string) pass through unchanged.
#[test]
fn test_mcp_normalize_config_non_object() {
    use claudette::mcp::normalize_mcp_config;

    let arr = serde_json::json!(["a", "b"]);
    let normalized_arr = normalize_mcp_config(arr.clone());
    assert_eq!(normalized_arr, arr);

    let s = serde_json::json!("just a string");
    let normalized_s = normalize_mcp_config(s.clone());
    assert_eq!(normalized_s, s);
}

// ---------------------------------------------------------------------------
// Special character handling
// ---------------------------------------------------------------------------

/// Server name with quotes and special characters still produces valid JSON.
#[test]
fn test_mcp_serialize_for_cli_special_chars_in_name() {
    let server = McpServer {
        name: r#"my "server" with\special/chars & more"#.to_string(),
        config: serde_json::json!({"command": "echo"}),
        source: McpSource::UserProjectConfig,
    };
    let result = serialize_for_cli(&[server]);
    // Must be valid JSON.
    let parsed: serde_json::Value =
        serde_json::from_str(&result).expect("output must be valid JSON");
    let servers_obj = parsed["mcpServers"].as_object().unwrap();
    assert_eq!(servers_obj.len(), 1);
    assert!(servers_obj.contains_key(r#"my "server" with\special/chars & more"#));
}
