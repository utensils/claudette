use claudette::agent::*;

// ─── parse_stream_line tests ────────────────────────────────────────

/// Empty string should fail to parse as JSON.
#[test]
fn test_agent_parse_stream_line_empty() {
    let result = parse_stream_line("");
    assert!(result.is_err());
}

/// A plain string (not JSON) should fail.
#[test]
fn test_agent_parse_stream_line_not_json() {
    let result = parse_stream_line("this is not json");
    assert!(result.is_err());
}

/// A valid system event should parse correctly.
#[test]
fn test_agent_parse_stream_line_system_event() {
    let line = r#"{"type":"system","subtype":"init","session_id":"sess-123"}"#;
    let event = parse_stream_line(line).unwrap();
    match event {
        StreamEvent::System {
            subtype,
            session_id,
        } => {
            assert_eq!(subtype, "init");
            assert_eq!(session_id, Some("sess-123".to_string()));
        }
        _ => panic!("Expected System event"),
    }
}

/// System event without optional session_id.
#[test]
fn test_agent_parse_stream_line_system_no_session() {
    let line = r#"{"type":"system","subtype":"heartbeat"}"#;
    let event = parse_stream_line(line).unwrap();
    match event {
        StreamEvent::System {
            subtype,
            session_id,
        } => {
            assert_eq!(subtype, "heartbeat");
            assert!(session_id.is_none());
        }
        _ => panic!("Expected System event"),
    }
}

/// Result event with all fields.
#[test]
fn test_agent_parse_stream_line_result_event() {
    let line = r#"{"type":"result","subtype":"success","result":"done","total_cost_usd":0.05,"duration_ms":1234}"#;
    let event = parse_stream_line(line).unwrap();
    match event {
        StreamEvent::Result {
            subtype,
            result,
            total_cost_usd,
            duration_ms,
        } => {
            assert_eq!(subtype, "success");
            assert_eq!(result, Some("done".to_string()));
            assert_eq!(total_cost_usd, Some(0.05));
            assert_eq!(duration_ms, Some(1234));
        }
        _ => panic!("Expected Result event"),
    }
}

/// Result event with missing optional fields.
#[test]
fn test_agent_parse_stream_line_result_minimal() {
    let line = r#"{"type":"result","subtype":"error"}"#;
    let event = parse_stream_line(line).unwrap();
    match event {
        StreamEvent::Result {
            subtype,
            result,
            total_cost_usd,
            duration_ms,
        } => {
            assert_eq!(subtype, "error");
            assert!(result.is_none());
            assert!(total_cost_usd.is_none());
            assert!(duration_ms.is_none());
        }
        _ => panic!("Expected Result event"),
    }
}

/// Unknown type tag should parse as Unknown variant, not error.
#[test]
fn test_agent_parse_stream_line_unknown_type() {
    let line = r#"{"type":"future_type_2027","data":42}"#;
    let event = parse_stream_line(line).unwrap();
    assert!(matches!(event, StreamEvent::Unknown));
}

/// Stream event with text delta.
#[test]
fn test_agent_parse_stream_line_text_delta() {
    let line = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}}"#;
    let event = parse_stream_line(line).unwrap();
    match event {
        StreamEvent::Stream { event } => match event {
            InnerStreamEvent::ContentBlockDelta { index, delta } => {
                assert_eq!(index, 0);
                match delta {
                    Delta::Text { text } => assert_eq!(text, "Hello"),
                    _ => panic!("Expected Text delta"),
                }
            }
            _ => panic!("Expected ContentBlockDelta"),
        },
        _ => panic!("Expected Stream event"),
    }
}

/// Stream event with thinking delta.
#[test]
fn test_agent_parse_stream_line_thinking_delta() {
    let line = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me think..."}}}"#;
    let event = parse_stream_line(line).unwrap();
    match event {
        StreamEvent::Stream { event } => match event {
            InnerStreamEvent::ContentBlockDelta { delta, .. } => match delta {
                Delta::Thinking { thinking } => assert_eq!(thinking, "Let me think..."),
                _ => panic!("Expected Thinking delta"),
            },
            _ => panic!("Expected ContentBlockDelta"),
        },
        _ => panic!("Expected Stream event"),
    }
}

/// Stream event with tool_use delta (partial JSON).
#[test]
fn test_agent_parse_stream_line_tool_use_delta() {
    let line = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"tool_use_delta","partial_json":"{\"pa"}}}"#;
    let event = parse_stream_line(line).unwrap();
    match event {
        StreamEvent::Stream { event } => match event {
            InnerStreamEvent::ContentBlockDelta { delta, .. } => match delta {
                Delta::ToolUse { partial_json } => {
                    assert_eq!(partial_json, Some("{\"pa".to_string()));
                }
                _ => panic!("Expected ToolUse delta"),
            },
            _ => panic!("Expected ContentBlockDelta"),
        },
        _ => panic!("Expected Stream event"),
    }
}

/// Content block start with tool_use.
#[test]
fn test_agent_parse_stream_line_content_block_start_tool() {
    let line = r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_123","name":"Read"}}}"#;
    let event = parse_stream_line(line).unwrap();
    match event {
        StreamEvent::Stream { event } => match event {
            InnerStreamEvent::ContentBlockStart { content_block, .. } => {
                match content_block.unwrap() {
                    StartContentBlock::ToolUse { id, name } => {
                        assert_eq!(id, "toolu_123");
                        assert_eq!(name, "Read");
                    }
                    _ => panic!("Expected ToolUse block"),
                }
            }
            _ => panic!("Expected ContentBlockStart"),
        },
        _ => panic!("Expected Stream event"),
    }
}

/// Assistant message with text content block.
#[test]
fn test_agent_parse_stream_line_assistant_message() {
    let line = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Hello!"}]}}"#;
    let event = parse_stream_line(line).unwrap();
    match event {
        StreamEvent::Assistant { message } => {
            assert_eq!(message.content.len(), 1);
            match &message.content[0] {
                ContentBlock::Text { text } => assert_eq!(text, "Hello!"),
                _ => panic!("Expected Text block"),
            }
        }
        _ => panic!("Expected Assistant event"),
    }
}

/// User event with tool result.
#[test]
fn test_agent_parse_stream_line_user_event() {
    let line = r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu1","content":"file contents"}]}}"#;
    let event = parse_stream_line(line).unwrap();
    match event {
        StreamEvent::User { message } => {
            assert_eq!(message.content.len(), 1);
            match &message.content[0] {
                UserContentBlock::ToolResult { tool_use_id, .. } => {
                    assert_eq!(tool_use_id, "tu1");
                }
                _ => panic!("Expected ToolResult"),
            }
        }
        _ => panic!("Expected User event"),
    }
}

/// Truncated JSON should fail to parse.
#[test]
fn test_agent_parse_stream_line_truncated_json() {
    let result = parse_stream_line(r#"{"type":"system","sub"#);
    assert!(result.is_err());
}

/// Deeply nested JSON structure should parse without stack overflow.
#[test]
fn test_agent_parse_stream_line_deeply_nested() {
    // Build a deeply nested but valid JSON that has "type" at top level
    let mut json = r#"{"type":"result","subtype":"ok","result":""#.to_string();
    for _ in 0..100 {
        json.push_str(r#"{"nested":"#);
    }
    json.push_str("null");
    for _ in 0..100 {
        json.push('}');
    }
    json.push('}');
    // This may fail to parse as valid StreamEvent, but should not panic/overflow
    let _ = parse_stream_line(&json);
}

/// JSON with extra/unknown fields should parse gracefully (forward compat).
#[test]
fn test_agent_parse_stream_line_extra_fields() {
    let line = r#"{"type":"system","subtype":"init","session_id":"s1","new_field_2027":"value","another":42}"#;
    let event = parse_stream_line(line).unwrap();
    match event {
        StreamEvent::System {
            subtype,
            session_id,
        } => {
            assert_eq!(subtype, "init");
            assert_eq!(session_id, Some("s1".to_string()));
        }
        _ => panic!("Expected System event with extra fields ignored"),
    }
}

/// Empty JSON object.
#[test]
fn test_agent_parse_stream_line_empty_object() {
    let result = parse_stream_line("{}");
    // Missing "type" field -- should fail or map to Unknown
    match result {
        Ok(StreamEvent::Unknown) => {} // acceptable
        Err(_) => {}                   // also acceptable
        other => panic!("Unexpected result: {other:?}"),
    }
}

/// JSON array instead of object.
#[test]
fn test_agent_parse_stream_line_array() {
    let result = parse_stream_line("[1,2,3]");
    assert!(result.is_err());
}

/// Null JSON.
#[test]
fn test_agent_parse_stream_line_null() {
    let result = parse_stream_line("null");
    assert!(result.is_err());
}

/// Binary-looking content (non-UTF8 won't happen in Rust &str, but control chars can).
#[test]
fn test_agent_parse_stream_line_control_chars() {
    let result = parse_stream_line("\x01\x02\x03");
    assert!(result.is_err());
}

// ─── sanitize_branch_name tests ─────────────────────────────────────

/// Empty input should return an empty string.
#[test]
fn test_agent_sanitize_branch_name_empty() {
    let result = sanitize_branch_name("", 50);
    assert_eq!(result, "");
}

/// Normal input should be lowercased and hyphenated.
#[test]
fn test_agent_sanitize_branch_name_normal() {
    let result = sanitize_branch_name("Fix Login Bug", 50);
    assert_eq!(result, result.to_lowercase());
    assert!(!result.contains(' '));
    assert!(
        result
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    );
}

/// max_len = 0 should produce an empty result.
#[test]
fn test_agent_sanitize_branch_name_max_len_zero() {
    let result = sanitize_branch_name("something", 0);
    assert!(result.is_empty());
}

/// max_len = 1 should produce at most 1 character.
#[test]
fn test_agent_sanitize_branch_name_max_len_one() {
    let result = sanitize_branch_name("hello", 1);
    assert!(result.len() <= 1);
}

/// Input with only special characters should sanitize to empty.
#[test]
fn test_agent_sanitize_branch_name_only_special_chars() {
    let result = sanitize_branch_name("@#$%^&*()", 50);
    // All chars are invalid for branch names -- should be empty
    // No leading/trailing hyphens
    assert!(!result.starts_with('-'));
    assert!(!result.ends_with('-'));
}

/// Input with leading/trailing hyphens should strip them.
#[test]
fn test_agent_sanitize_branch_name_leading_trailing_hyphens() {
    let result = sanitize_branch_name("---hello---", 50);
    assert!(
        !result.starts_with('-'),
        "Should not start with hyphen: {result}"
    );
    assert!(
        !result.ends_with('-'),
        "Should not end with hyphen: {result}"
    );
}

/// Unicode input should be stripped or transliterated.
#[test]
fn test_agent_sanitize_branch_name_unicode() {
    let result = sanitize_branch_name("修复登录错误", 50);
    // Unicode chars are not ASCII alphanumeric, so they should be stripped
    assert!(
        result
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    );
}

/// Input that's longer than max_len should be truncated.
#[test]
fn test_agent_sanitize_branch_name_truncation() {
    let long_input = "a".repeat(200);
    let result = sanitize_branch_name(&long_input, 20);
    assert!(result.len() <= 20);
}

/// Consecutive hyphens should be collapsed to a single hyphen.
#[test]
fn test_agent_sanitize_branch_name_consecutive_hyphens() {
    let result = sanitize_branch_name("hello   world   test", 50);
    assert!(
        !result.contains("--"),
        "Should not have consecutive hyphens: {result}"
    );
}

/// Input that's exactly at max_len (no truncation needed).
#[test]
fn test_agent_sanitize_branch_name_exact_max_len() {
    let input = "abcdef";
    let result = sanitize_branch_name(input, 6);
    assert!(result.len() <= 6);
}

/// Determinism: same input always produces same output.
#[test]
fn test_agent_sanitize_branch_name_deterministic() {
    let input = "Fix the Login Page!";
    let r1 = sanitize_branch_name(input, 50);
    let r2 = sanitize_branch_name(input, 50);
    let r3 = sanitize_branch_name(input, 50);
    assert_eq!(r1, r2);
    assert_eq!(r2, r3);
}

/// Dots and underscores -- are they kept or converted?
#[test]
fn test_agent_sanitize_branch_name_dots_underscores() {
    let result = sanitize_branch_name("feat.add_login", 50);
    // Dots and underscores might be converted to hyphens or stripped
    assert!(
        result
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    );
}

/// Slash characters (common in branch names like feat/foo).
#[test]
fn test_agent_sanitize_branch_name_slashes() {
    let result = sanitize_branch_name("feat/add-login", 50);
    // Slashes should probably be converted to hyphens
    assert!(!result.contains('/'));
}

/// Truncation should not leave a trailing hyphen.
#[test]
fn test_agent_sanitize_branch_name_truncation_no_trailing_hyphen() {
    // Input where truncation at max_len would leave a trailing hyphen
    let result = sanitize_branch_name("hello-world-test", 6);
    assert!(
        !result.ends_with('-'),
        "Truncation left trailing hyphen: {result}"
    );
}

// ─── build_claude_args tests ────────────────────────────────────────

/// Basic args for a first turn (non-resume). Should contain the prompt
/// and session-id, and NOT contain --resume.
#[test]
fn test_agent_build_claude_args_first_turn() {
    let settings = AgentSettings::default();
    let args = build_claude_args("sess-1", "hello", false, &[], None, &settings, false);
    let joined = args.join(" ");
    // Should contain the prompt text
    assert!(
        args.contains(&"hello".to_string()),
        "Args should contain prompt: {joined}"
    );
    // Should contain session-id
    assert!(
        joined.contains("session-id") || joined.contains("session_id"),
        "Args should reference session-id: {joined}"
    );
    assert!(
        args.contains(&"sess-1".to_string()),
        "Args should contain session ID value: {joined}"
    );
    // Should NOT be a resume
    assert!(
        !args.contains(&"--resume".to_string()),
        "First turn should not resume: {joined}"
    );
    // Should have --print flag for non-interactive mode
    assert!(
        args.contains(&"--print".to_string()),
        "Args should have --print flag: {joined}"
    );
}

/// Args for a resume turn.
#[test]
fn test_agent_build_claude_args_resume() {
    let settings = AgentSettings::default();
    let args = build_claude_args("sess-1", "continue", true, &[], None, &settings, false);
    assert!(args.contains(&"--resume".to_string()));
}

/// Args with allowed tools.
#[test]
fn test_agent_build_claude_args_with_tools() {
    let settings = AgentSettings::default();
    let tools = vec!["Bash".to_string(), "Read".to_string()];
    let args = build_claude_args("sess-1", "hello", false, &tools, None, &settings, false);
    // Check that tools are included somehow (--allowedTools or similar)
    let joined = args.join(" ");
    assert!(
        joined.contains("Bash") && joined.contains("Read"),
        "Tools should appear in args: {joined}"
    );
}

/// Args with wildcard tool ("*") should trigger bypass mode.
#[test]
fn test_agent_build_claude_args_wildcard_tools() {
    let settings = AgentSettings::default();
    let tools = vec!["*".to_string()];
    let args = build_claude_args("sess-1", "hello", false, &tools, None, &settings, false);
    let joined = args.join(" ");
    assert!(
        joined.contains("bypassPermissions") || joined.contains("bypass"),
        "Wildcard should trigger bypass mode: {joined}"
    );
}

/// Args with custom instructions.
#[test]
fn test_agent_build_claude_args_custom_instructions() {
    let settings = AgentSettings::default();
    let args = build_claude_args(
        "sess-1",
        "hello",
        false,
        &[],
        Some("Be concise"),
        &settings,
        false,
    );
    let joined = args.join(" ");
    assert!(
        joined.contains("Be concise"),
        "Custom instructions should appear in args: {joined}"
    );
}

/// Args with attachments should use stream-json input format.
#[test]
fn test_agent_build_claude_args_with_attachments() {
    let settings = AgentSettings::default();
    let args = build_claude_args("sess-1", "describe", false, &[], None, &settings, true);
    let joined = args.join(" ");
    assert!(
        joined.contains("stream-json"),
        "Attachments should trigger stream-json format: {joined}"
    );
    // Prompt should NOT be in args when using stream-json
    assert!(
        !args.contains(&"describe".to_string()),
        "Prompt should not be in args when has_attachments: {joined}"
    );
}

/// Args with plan mode enabled.
#[test]
fn test_agent_build_claude_args_plan_mode() {
    let settings = AgentSettings {
        plan_mode: true,
        ..AgentSettings::default()
    };
    let args = build_claude_args("sess-1", "plan", false, &[], None, &settings, false);
    let joined = args.join(" ");
    assert!(
        joined.contains("plan") || joined.contains("permission"),
        "Plan mode should set plan permission mode: {joined}"
    );
}

/// Args with model override.
#[test]
fn test_agent_build_claude_args_model() {
    let settings = AgentSettings {
        model: Some("opus".to_string()),
        ..AgentSettings::default()
    };
    let args = build_claude_args("sess-1", "hello", false, &[], None, &settings, false);
    let joined = args.join(" ");
    assert!(
        joined.contains("opus"),
        "Model should appear in args: {joined}"
    );
}

/// Args with MCP config.
#[test]
fn test_agent_build_claude_args_mcp_config() {
    let settings = AgentSettings {
        mcp_config: Some(r#"{"mcpServers":{}}"#.to_string()),
        ..AgentSettings::default()
    };
    let args = build_claude_args("sess-1", "hello", false, &[], None, &settings, false);
    let joined = args.join(" ");
    assert!(
        joined.contains("mcp-config") || joined.contains("mcp"),
        "MCP config should appear in args: {joined}"
    );
}

/// Empty prompt should still produce valid args.
#[test]
fn test_agent_build_claude_args_empty_prompt() {
    let settings = AgentSettings::default();
    let args = build_claude_args("sess-1", "", false, &[], None, &settings, false);
    // Should not panic; args should contain -p and the empty string
    assert!(!args.is_empty());
}

// ─── build_stdin_message tests ──────────────────────────────────────

/// Build a stdin message with no attachments.
#[test]
fn test_agent_build_stdin_message_no_attachments() {
    let msg = build_stdin_message("hello world", &[]);
    // Should be valid JSON
    let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();
    // Should have the prompt text somewhere
    let text = parsed.to_string();
    assert!(text.contains("hello world"));
}

/// Build a stdin message with an image attachment.
#[test]
fn test_agent_build_stdin_message_with_image() {
    let att = ImageAttachment {
        media_type: "image/png".to_string(),
        data_base64: "iVBORw0KGgo=".to_string(),
    };
    let msg = build_stdin_message("describe this", &[att]);
    let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();
    let text = parsed.to_string();
    assert!(text.contains("image"));
    assert!(text.contains("iVBORw0KGgo="));
}

/// Build a stdin message with a PDF attachment.
#[test]
fn test_agent_build_stdin_message_with_pdf() {
    let att = ImageAttachment {
        media_type: "application/pdf".to_string(),
        data_base64: "JVBERi0=".to_string(),
    };
    let msg = build_stdin_message("read this pdf", &[att]);
    let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();
    let text = parsed.to_string();
    assert!(text.contains("document") || text.contains("pdf"));
}

/// Build a stdin message with empty prompt and empty attachments.
#[test]
fn test_agent_build_stdin_message_empty() {
    let msg = build_stdin_message("", &[]);
    let parsed: Result<serde_json::Value, _> = serde_json::from_str(&msg);
    assert!(parsed.is_ok());
}

/// Build a stdin message with many attachments.
#[test]
fn test_agent_build_stdin_message_many_attachments() {
    let attachments: Vec<_> = (0..50)
        .map(|i| ImageAttachment {
            media_type: "image/jpeg".to_string(),
            data_base64: format!("base64data{i}"),
        })
        .collect();
    let msg = build_stdin_message("describe all", &attachments);
    let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();
    // Should contain all 50 attachments somehow
    let text = parsed.to_string();
    assert!(text.contains("base64data49"));
}

// ─── AgentSettings default ──────────────────────────────────────────

/// Default settings should have sane values.
#[test]
fn test_agent_settings_default() {
    let s = AgentSettings::default();
    assert!(s.model.is_none());
    assert!(!s.fast_mode);
    assert!(!s.thinking_enabled);
    assert!(!s.plan_mode);
    assert!(s.effort.is_none());
    assert!(!s.chrome_enabled);
    assert!(s.mcp_config.is_none());
}

// ─── ADVERSARIAL: parse_stream_line edge cases ─────────────────────

/// A JSON string containing embedded null bytes within a valid structure.
/// The parser should either reject it or handle it without panic.
#[test]
fn test_agent_parse_stream_line_null_byte_in_string() {
    let line = "{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"sess\\u0000id\"}";
    let _ = parse_stream_line(line);
    // No panic is the main assertion
}

/// Whitespace-only input should fail to parse as JSON.
#[test]
fn test_agent_parse_stream_line_whitespace_only() {
    let result = parse_stream_line("   \t\n  ");
    assert!(result.is_err());
}

/// Input with a UTF-8 BOM prefix should fail or parse gracefully.
#[test]
fn test_agent_parse_stream_line_bom_prefix() {
    let line = "\u{FEFF}{\"type\":\"system\",\"subtype\":\"init\"}";
    let result = parse_stream_line(line);
    // BOM before JSON is technically invalid JSON; serde may or may not tolerate it
    match result {
        Ok(StreamEvent::System { subtype, .. }) => assert_eq!(subtype, "init"),
        Err(_) => {} // also acceptable
        _ => panic!("Unexpected parse result"),
    }
}

/// JSON with CRLF line endings embedded in string values.
#[test]
fn test_agent_parse_stream_line_crlf_in_value() {
    let line = r#"{"type":"result","subtype":"success","result":"line1\r\nline2"}"#;
    let event = parse_stream_line(line).unwrap();
    match event {
        StreamEvent::Result { result, .. } => {
            assert!(result.is_some());
        }
        _ => panic!("Expected Result event"),
    }
}

/// JSON where the type field is present but set to JSON null.
#[test]
fn test_agent_parse_stream_line_type_null() {
    let result = parse_stream_line(r#"{"type":null,"subtype":"x"}"#);
    // type must be a string for the tag; null should fail or map to Unknown
    match result {
        Ok(StreamEvent::Unknown) => {}
        Err(_) => {}
        other => panic!("Unexpected result for null type: {other:?}"),
    }
}

/// JSON where type is an integer instead of a string.
#[test]
fn test_agent_parse_stream_line_type_integer() {
    let result = parse_stream_line(r#"{"type":42,"subtype":"x"}"#);
    match result {
        Ok(StreamEvent::Unknown) => {}
        Err(_) => {}
        other => panic!("Unexpected result for integer type: {other:?}"),
    }
}

/// A very large text delta -- ensures no allocation panic for huge strings.
#[test]
fn test_agent_parse_stream_line_huge_text_delta() {
    let big_text = "x".repeat(1_000_000);
    let line = format!(
        r#"{{"type":"stream_event","event":{{"type":"content_block_delta","index":0,"delta":{{"type":"text_delta","text":"{big_text}"}}}}}}"#
    );
    let event = parse_stream_line(&line).unwrap();
    match event {
        StreamEvent::Stream { event } => match event {
            InnerStreamEvent::ContentBlockDelta { delta, .. } => match delta {
                Delta::Text { text } => assert_eq!(text.len(), 1_000_000),
                _ => panic!("Expected Text delta"),
            },
            _ => panic!("Expected ContentBlockDelta"),
        },
        _ => panic!("Expected Stream event"),
    }
}

/// index field at usize::MAX boundary -- should parse without overflow.
#[test]
fn test_agent_parse_stream_line_max_index() {
    let line = format!(
        r#"{{"type":"stream_event","event":{{"type":"content_block_stop","index":{}}}}}"#,
        usize::MAX
    );
    let result = parse_stream_line(&line);
    // May succeed or fail depending on JSON integer handling, but must not panic
    if let Ok(StreamEvent::Stream {
        event: InnerStreamEvent::ContentBlockStop { index },
    }) = result
    {
        assert_eq!(index, usize::MAX);
    }
}

/// content_block_start without a content_block field (it's Optional).
#[test]
fn test_agent_parse_stream_line_content_block_start_no_block() {
    let line = r#"{"type":"stream_event","event":{"type":"content_block_start","index":0}}"#;
    let event = parse_stream_line(line).unwrap();
    match event {
        StreamEvent::Stream { event } => match event {
            InnerStreamEvent::ContentBlockStart {
                content_block,
                index,
            } => {
                assert_eq!(index, 0);
                assert!(content_block.is_none());
            }
            _ => panic!("Expected ContentBlockStart"),
        },
        _ => panic!("Expected Stream event"),
    }
}

/// message_start event (no extra fields).
#[test]
fn test_agent_parse_stream_line_message_start() {
    let line = r#"{"type":"stream_event","event":{"type":"message_start"}}"#;
    let event = parse_stream_line(line).unwrap();
    match event {
        StreamEvent::Stream { event } => {
            assert!(matches!(event, InnerStreamEvent::MessageStart {}));
        }
        _ => panic!("Expected Stream event"),
    }
}

/// message_stop event.
#[test]
fn test_agent_parse_stream_line_message_stop() {
    let line = r#"{"type":"stream_event","event":{"type":"message_stop"}}"#;
    let event = parse_stream_line(line).unwrap();
    match event {
        StreamEvent::Stream { event } => {
            assert!(matches!(event, InnerStreamEvent::MessageStop {}));
        }
        _ => panic!("Expected Stream event"),
    }
}

/// message_delta event.
#[test]
fn test_agent_parse_stream_line_message_delta() {
    let line = r#"{"type":"stream_event","event":{"type":"message_delta"}}"#;
    let event = parse_stream_line(line).unwrap();
    match event {
        StreamEvent::Stream { event } => {
            assert!(matches!(event, InnerStreamEvent::MessageDelta {}));
        }
        _ => panic!("Expected Stream event"),
    }
}

/// input_json_delta variant of Delta.
#[test]
fn test_agent_parse_stream_line_input_json_delta() {
    let line = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"key\":"}}}"#;
    let event = parse_stream_line(line).unwrap();
    match event {
        StreamEvent::Stream { event } => match event {
            InnerStreamEvent::ContentBlockDelta { delta, .. } => match delta {
                Delta::InputJson { partial_json } => {
                    assert_eq!(partial_json, Some("{\"key\":".to_string()));
                }
                _ => panic!("Expected InputJson delta"),
            },
            _ => panic!("Expected ContentBlockDelta"),
        },
        _ => panic!("Expected Stream event"),
    }
}

/// tool_use_delta with null partial_json (the field is #[serde(default)]).
#[test]
fn test_agent_parse_stream_line_tool_use_delta_null_json() {
    let line = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"tool_use_delta"}}}"#;
    let event = parse_stream_line(line).unwrap();
    match event {
        StreamEvent::Stream { event } => match event {
            InnerStreamEvent::ContentBlockDelta { delta, .. } => match delta {
                Delta::ToolUse { partial_json } => {
                    assert!(partial_json.is_none());
                }
                _ => panic!("Expected ToolUse delta"),
            },
            _ => panic!("Expected ContentBlockDelta"),
        },
        _ => panic!("Expected Stream event"),
    }
}

/// Unknown inner stream event type should map to InnerStreamEvent::Unknown.
#[test]
fn test_agent_parse_stream_line_unknown_inner_event() {
    let line = r#"{"type":"stream_event","event":{"type":"future_event_type","data":"whatever"}}"#;
    let event = parse_stream_line(line).unwrap();
    match event {
        StreamEvent::Stream { event } => {
            assert!(matches!(event, InnerStreamEvent::Unknown));
        }
        _ => panic!("Expected Stream event"),
    }
}

/// Unknown delta type should map to Delta::Unknown.
#[test]
fn test_agent_parse_stream_line_unknown_delta() {
    let line = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"future_delta","data":"new"}}}"#;
    let event = parse_stream_line(line).unwrap();
    match event {
        StreamEvent::Stream { event } => match event {
            InnerStreamEvent::ContentBlockDelta { delta, .. } => {
                assert!(matches!(delta, Delta::Unknown));
            }
            _ => panic!("Expected ContentBlockDelta"),
        },
        _ => panic!("Expected Stream event"),
    }
}

/// Assistant message with mixed content block types.
#[test]
fn test_agent_parse_stream_line_assistant_mixed_blocks() {
    let line = r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":"answer"},{"type":"tool_use","id":"tu1","name":"Bash"}]}}"#;
    let event = parse_stream_line(line).unwrap();
    match event {
        StreamEvent::Assistant { message } => {
            assert_eq!(message.content.len(), 3);
            assert!(matches!(&message.content[0], ContentBlock::Thinking { .. }));
            assert!(matches!(&message.content[1], ContentBlock::Text { .. }));
            assert!(matches!(&message.content[2], ContentBlock::ToolUse { .. }));
        }
        _ => panic!("Expected Assistant event"),
    }
}

/// Assistant message with an empty content array.
#[test]
fn test_agent_parse_stream_line_assistant_empty_content() {
    let line = r#"{"type":"assistant","message":{"content":[]}}"#;
    let event = parse_stream_line(line).unwrap();
    match event {
        StreamEvent::Assistant { message } => {
            assert!(message.content.is_empty());
        }
        _ => panic!("Expected Assistant event"),
    }
}

/// User event with multiple tool results.
#[test]
fn test_agent_parse_stream_line_user_multiple_tool_results() {
    let line = r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu1","content":"result1"},{"type":"tool_result","tool_use_id":"tu2","content":"result2"}]}}"#;
    let event = parse_stream_line(line).unwrap();
    match event {
        StreamEvent::User { message } => {
            assert_eq!(message.content.len(), 2);
        }
        _ => panic!("Expected User event"),
    }
}

/// User event with unknown content block type.
#[test]
fn test_agent_parse_stream_line_user_unknown_content() {
    let line = r#"{"type":"user","message":{"content":[{"type":"new_block_type","data":"x"}]}}"#;
    let event = parse_stream_line(line).unwrap();
    match event {
        StreamEvent::User { message } => {
            assert_eq!(message.content.len(), 1);
            assert!(matches!(&message.content[0], UserContentBlock::Unknown));
        }
        _ => panic!("Expected User event"),
    }
}

/// User event with empty content array.
#[test]
fn test_agent_parse_stream_line_user_empty_content() {
    let line = r#"{"type":"user","message":{"content":[]}}"#;
    let event = parse_stream_line(line).unwrap();
    match event {
        StreamEvent::User { message } => {
            assert!(message.content.is_empty());
        }
        _ => panic!("Expected User event"),
    }
}

/// content_block_start with unknown block type.
#[test]
fn test_agent_parse_stream_line_content_block_start_unknown() {
    let line = r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"future_block"}}}"#;
    let event = parse_stream_line(line).unwrap();
    match event {
        StreamEvent::Stream { event } => match event {
            InnerStreamEvent::ContentBlockStart { content_block, .. } => {
                assert!(matches!(content_block, Some(StartContentBlock::Unknown)));
            }
            _ => panic!("Expected ContentBlockStart"),
        },
        _ => panic!("Expected Stream event"),
    }
}

/// content_block_start with text type.
#[test]
fn test_agent_parse_stream_line_content_block_start_text() {
    let line = r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text"}}}"#;
    let event = parse_stream_line(line).unwrap();
    match event {
        StreamEvent::Stream { event } => match event {
            InnerStreamEvent::ContentBlockStart { content_block, .. } => {
                assert!(matches!(content_block, Some(StartContentBlock::Text {})));
            }
            _ => panic!("Expected ContentBlockStart"),
        },
        _ => panic!("Expected Stream event"),
    }
}

/// content_block_start with thinking type.
#[test]
fn test_agent_parse_stream_line_content_block_start_thinking() {
    let line = r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}}"#;
    let event = parse_stream_line(line).unwrap();
    match event {
        StreamEvent::Stream { event } => match event {
            InnerStreamEvent::ContentBlockStart { content_block, .. } => {
                assert!(matches!(
                    content_block,
                    Some(StartContentBlock::Thinking {})
                ));
            }
            _ => panic!("Expected ContentBlockStart"),
        },
        _ => panic!("Expected Stream event"),
    }
}

/// Result event with negative duration_ms.
#[test]
fn test_agent_parse_stream_line_result_negative_duration() {
    let line = r#"{"type":"result","subtype":"success","duration_ms":-1}"#;
    let event = parse_stream_line(line).unwrap();
    match event {
        StreamEvent::Result { duration_ms, .. } => {
            assert_eq!(duration_ms, Some(-1));
        }
        _ => panic!("Expected Result event"),
    }
}

/// Result event with NaN cost (JSON doesn't support NaN, so this should fail).
#[test]
fn test_agent_parse_stream_line_result_nan_cost() {
    let result = parse_stream_line(r#"{"type":"result","subtype":"x","total_cost_usd":NaN}"#);
    assert!(result.is_err(), "NaN is not valid JSON");
}

/// Result event with Infinity cost (also not valid JSON).
#[test]
fn test_agent_parse_stream_line_result_infinity_cost() {
    let result = parse_stream_line(r#"{"type":"result","subtype":"x","total_cost_usd":Infinity}"#);
    assert!(result.is_err(), "Infinity is not valid JSON");
}

/// Result with very large cost value.
#[test]
fn test_agent_parse_stream_line_result_huge_cost() {
    let line = r#"{"type":"result","subtype":"x","total_cost_usd":1e308}"#;
    let event = parse_stream_line(line).unwrap();
    match event {
        StreamEvent::Result { total_cost_usd, .. } => {
            assert!(total_cost_usd.unwrap() > 1e300);
        }
        _ => panic!("Expected Result event"),
    }
}

/// Result with zero cost.
#[test]
fn test_agent_parse_stream_line_result_zero_cost() {
    let line = r#"{"type":"result","subtype":"x","total_cost_usd":0.0,"duration_ms":0}"#;
    let event = parse_stream_line(line).unwrap();
    match event {
        StreamEvent::Result {
            total_cost_usd,
            duration_ms,
            ..
        } => {
            assert_eq!(total_cost_usd, Some(0.0));
            assert_eq!(duration_ms, Some(0));
        }
        _ => panic!("Expected Result event"),
    }
}

/// Multiple JSON objects on the same line (only the first should be parsed,
/// or the parser should reject it).
#[test]
fn test_agent_parse_stream_line_multiple_json_objects() {
    let line = r#"{"type":"system","subtype":"a"}{"type":"system","subtype":"b"}"#;
    let result = parse_stream_line(line);
    // serde_json::from_str should either parse the first object and ignore trailing,
    // or reject the input entirely. Let's see which behavior we get.
    match result {
        Ok(StreamEvent::System { subtype, .. }) => {
            // If it parses, it should be the first object
            assert_eq!(subtype, "a");
        }
        Err(_) => {} // Also acceptable: reject trailing data
        _ => panic!("Unexpected parse result for multiple objects"),
    }
}

/// JSON with escaped unicode in type field.
#[test]
fn test_agent_parse_stream_line_escaped_unicode_type() {
    // "system" spelled with unicode escapes
    let line = r#"{"type":"\u0073\u0079\u0073\u0074\u0065\u006d","subtype":"init"}"#;
    let event = parse_stream_line(line).unwrap();
    match event {
        StreamEvent::System { subtype, .. } => {
            assert_eq!(subtype, "init");
        }
        _ => panic!("Expected System event from unicode-escaped type"),
    }
}

// ─── ADVERSARIAL: sanitize_branch_name edge cases ──────────────────

/// Input containing null bytes.
#[test]
fn test_agent_sanitize_branch_name_null_bytes() {
    let result = sanitize_branch_name("hello\x00world", 50);
    assert!(
        !result.contains('\x00'),
        "Null bytes should be stripped: {result:?}"
    );
    assert!(
        result
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    );
}

/// Input containing newline characters.
#[test]
fn test_agent_sanitize_branch_name_newlines() {
    let result = sanitize_branch_name("hello\nworld\r\ntest", 50);
    assert!(!result.contains('\n'));
    assert!(!result.contains('\r'));
    assert!(
        result
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    );
}

/// Input containing tab characters.
#[test]
fn test_agent_sanitize_branch_name_tabs() {
    let result = sanitize_branch_name("hello\tworld", 50);
    assert!(!result.contains('\t'));
}

/// Mixed ASCII and Unicode -- only the ASCII alphanumeric parts should survive.
#[test]
fn test_agent_sanitize_branch_name_mixed_unicode_ascii() {
    let result = sanitize_branch_name("fix-🐛-bug-修复", 50);
    assert!(
        result
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-'),
        "Non-ASCII should be stripped: {result}"
    );
    // "fix" and "bug" should survive
    assert!(
        result.contains("fix"),
        "ASCII parts should survive: {result}"
    );
    assert!(
        result.contains("bug"),
        "ASCII parts should survive: {result}"
    );
}

/// Very large max_len should not cause issues.
#[test]
fn test_agent_sanitize_branch_name_huge_max_len() {
    let result = sanitize_branch_name("hello", usize::MAX);
    assert_eq!(result, "hello");
}

/// Input that is all hyphens.
#[test]
fn test_agent_sanitize_branch_name_all_hyphens() {
    let result = sanitize_branch_name("------", 50);
    // After stripping leading/trailing hyphens, this should be empty
    assert!(
        result.is_empty(),
        "All-hyphens input should produce empty: {result:?}"
    );
}

/// Git-reserved name "HEAD".
#[test]
fn test_agent_sanitize_branch_name_head() {
    let result = sanitize_branch_name("HEAD", 50);
    // "HEAD" lowercased is "head" -- should be a valid branch name
    assert_eq!(result, "head");
}

/// Double dots (..) are forbidden in git branch names.
#[test]
fn test_agent_sanitize_branch_name_double_dots() {
    let result = sanitize_branch_name("feat..test", 50);
    assert!(
        !result.contains(".."),
        "Double dots should not appear: {result}"
    );
}

/// Tilde (~) is forbidden in git refs.
#[test]
fn test_agent_sanitize_branch_name_tilde() {
    let result = sanitize_branch_name("feat~1", 50);
    assert!(!result.contains('~'), "Tilde should be stripped: {result}");
}

/// Caret (^) is forbidden in git refs.
#[test]
fn test_agent_sanitize_branch_name_caret() {
    let result = sanitize_branch_name("feat^2", 50);
    assert!(!result.contains('^'), "Caret should be stripped: {result}");
}

/// Colon (:) is forbidden in git refs.
#[test]
fn test_agent_sanitize_branch_name_colon() {
    let result = sanitize_branch_name("feat:test", 50);
    assert!(!result.contains(':'), "Colon should be stripped: {result}");
}

/// Backslash is forbidden in git refs.
#[test]
fn test_agent_sanitize_branch_name_backslash() {
    let result = sanitize_branch_name("feat\\test", 50);
    assert!(
        !result.contains('\\'),
        "Backslash should be stripped: {result}"
    );
}

/// Space at beginning and end.
#[test]
fn test_agent_sanitize_branch_name_spaces_padding() {
    let result = sanitize_branch_name("   hello   ", 50);
    assert!(!result.starts_with('-'));
    assert!(!result.ends_with('-'));
    assert!(result.contains("hello"));
}

/// Single character input.
#[test]
fn test_agent_sanitize_branch_name_single_char() {
    let result = sanitize_branch_name("a", 50);
    assert_eq!(result, "a");
}

/// Single non-alphanumeric character.
#[test]
fn test_agent_sanitize_branch_name_single_special_char() {
    let result = sanitize_branch_name("@", 50);
    assert!(
        result.is_empty(),
        "Single special char should produce empty: {result:?}"
    );
}

/// Truncation that splits a multi-byte sequence shouldn't happen since
/// the sanitizer works on ASCII, but let's verify with a boundary case.
#[test]
fn test_agent_sanitize_branch_name_truncation_at_hyphen_boundary() {
    // "ab-cd-ef" truncated to 3 should give "ab" (not "ab-")
    let result = sanitize_branch_name("ab-cd-ef", 3);
    assert!(result.len() <= 3);
    assert!(
        !result.ends_with('-'),
        "Truncation at hyphen boundary: {result}"
    );
}

/// Input with consecutive special characters that would produce multiple hyphens.
#[test]
fn test_agent_sanitize_branch_name_many_specials() {
    let result = sanitize_branch_name("a!@#$%^&*()b", 50);
    assert!(
        !result.contains("--"),
        "Should collapse consecutive hyphens: {result}"
    );
    // Should contain "a" and "b" connected
    assert!(result.starts_with('a'), "Should start with 'a': {result}");
}

/// Input with ZWJ (zero-width joiner) and other invisible characters.
#[test]
fn test_agent_sanitize_branch_name_invisible_chars() {
    let result = sanitize_branch_name("hello\u{200D}world\u{200B}test", 50);
    assert!(
        result
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-'),
        "Invisible chars should be stripped: {result:?}"
    );
}

/// Input with RTL override character.
#[test]
fn test_agent_sanitize_branch_name_rtl_override() {
    let result = sanitize_branch_name("hello\u{202E}dlrow", 50);
    assert!(
        result
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-'),
        "RTL override should be stripped: {result:?}"
    );
}

// ─── ADVERSARIAL: build_claude_args edge cases ─────────────────────

/// Prompt containing double quotes should be handled safely.
#[test]
fn test_agent_build_claude_args_prompt_with_quotes() {
    let settings = AgentSettings::default();
    let args = build_claude_args(
        "sess-1",
        r#"Say "hello world""#,
        false,
        &[],
        None,
        &settings,
        false,
    );
    // The prompt should appear in args (quotes preserved as part of the string)
    assert!(args.iter().any(|a| a.contains("hello world")));
}

/// Prompt containing newlines.
#[test]
fn test_agent_build_claude_args_prompt_with_newlines() {
    let settings = AgentSettings::default();
    let args = build_claude_args(
        "sess-1",
        "line1\nline2\nline3",
        false,
        &[],
        None,
        &settings,
        false,
    );
    assert!(args.iter().any(|a| a.contains("line1")));
}

/// Session ID with special characters.
#[test]
fn test_agent_build_claude_args_special_session_id() {
    let settings = AgentSettings::default();
    let args = build_claude_args(
        "sess-with spaces-&-stuff",
        "hi",
        false,
        &[],
        None,
        &settings,
        false,
    );
    let joined = args.join(" ");
    assert!(
        joined.contains("sess-with spaces-&-stuff"),
        "Session ID should be passed as-is: {joined}"
    );
}

/// All settings enabled simultaneously.
#[test]
fn test_agent_build_claude_args_all_settings() {
    let settings = AgentSettings {
        model: Some("opus".to_string()),
        fast_mode: true,
        thinking_enabled: true,
        plan_mode: true,
        effort: Some("max".to_string()),
        chrome_enabled: true,
        mcp_config: Some(r#"{"mcpServers":{}}"#.to_string()),
    };
    let args = build_claude_args(
        "sess-1",
        "hello",
        false,
        &["Bash".to_string()],
        Some("Be helpful"),
        &settings,
        false,
    );
    let joined = args.join(" ");
    // All relevant flags should appear
    assert!(joined.contains("opus"), "Model missing: {joined}");
    assert!(joined.contains("max"), "Effort level missing: {joined}");
}

/// Effort level set to each valid value.
#[test]
fn test_agent_build_claude_args_effort_levels() {
    for effort in &["low", "medium", "high", "max"] {
        let settings = AgentSettings {
            effort: Some(effort.to_string()),
            ..AgentSettings::default()
        };
        let args = build_claude_args("sess-1", "hello", false, &[], None, &settings, false);
        let joined = args.join(" ");
        assert!(
            joined.contains(effort),
            "Effort '{effort}' should appear in args: {joined}"
        );
    }
}

/// Chrome enabled should add --chrome flag.
#[test]
fn test_agent_build_claude_args_chrome_enabled() {
    let settings = AgentSettings {
        chrome_enabled: true,
        ..AgentSettings::default()
    };
    let args = build_claude_args("sess-1", "hello", false, &[], None, &settings, false);
    let joined = args.join(" ");
    assert!(joined.contains("chrome"), "Chrome flag missing: {joined}");
}

/// Fast mode enabled.
#[test]
fn test_agent_build_claude_args_fast_mode() {
    let settings = AgentSettings {
        fast_mode: true,
        ..AgentSettings::default()
    };
    let args = build_claude_args("sess-1", "hello", false, &[], None, &settings, false);
    let joined = args.join(" ");
    // fast_mode is applied via --settings, so "fast" should appear somewhere
    assert!(
        joined.contains("fast") || joined.contains("settings"),
        "Fast mode should appear in args: {joined}"
    );
}

/// Thinking enabled.
#[test]
fn test_agent_build_claude_args_thinking_enabled() {
    let settings = AgentSettings {
        thinking_enabled: true,
        ..AgentSettings::default()
    };
    let args = build_claude_args("sess-1", "hello", false, &[], None, &settings, false);
    let joined = args.join(" ");
    assert!(
        joined.contains("thinking") || joined.contains("settings"),
        "Thinking should appear in args: {joined}"
    );
}

/// Resume with attachments -- should still use stream-json.
#[test]
fn test_agent_build_claude_args_resume_with_attachments() {
    let settings = AgentSettings::default();
    let args = build_claude_args("sess-1", "more info", true, &[], None, &settings, true);
    let joined = args.join(" ");
    assert!(
        args.contains(&"--resume".to_string()),
        "Should be resume: {joined}"
    );
    assert!(
        joined.contains("stream-json"),
        "Should use stream-json: {joined}"
    );
}

/// Empty allowed tools list.
#[test]
fn test_agent_build_claude_args_empty_tools() {
    let settings = AgentSettings::default();
    let args = build_claude_args("sess-1", "hello", false, &[], None, &settings, false);
    // Should still be valid args, just no tool flags
    assert!(!args.is_empty());
}

/// Very long prompt (64KB).
#[test]
fn test_agent_build_claude_args_very_long_prompt() {
    let settings = AgentSettings::default();
    let long_prompt = "x".repeat(65536);
    let args = build_claude_args("sess-1", &long_prompt, false, &[], None, &settings, false);
    // Should not panic; prompt should be present
    assert!(args.iter().any(|a| a.len() >= 65536));
}

/// Custom instructions with special chars.
#[test]
fn test_agent_build_claude_args_custom_instructions_special() {
    let settings = AgentSettings::default();
    let instructions = "Don't use 'single quotes' or \"double quotes\" or $variables";
    let args = build_claude_args(
        "sess-1",
        "hello",
        false,
        &[],
        Some(instructions),
        &settings,
        false,
    );
    let joined = args.join(" ");
    assert!(
        joined.contains("single quotes"),
        "Custom instructions should be included: {joined}"
    );
}

// ─── ADVERSARIAL: build_stdin_message edge cases ───────────────────

/// Prompt containing JSON special characters (quotes, backslashes).
#[test]
fn test_agent_build_stdin_message_json_special_chars() {
    let prompt = r#"Say "hello" and use \backslash\ and {"json": true}"#;
    let msg = build_stdin_message(prompt, &[]);
    // Must be valid JSON despite the special chars
    let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();
    let text = parsed.to_string();
    assert!(text.contains("hello"));
}

/// Prompt with only whitespace.
#[test]
fn test_agent_build_stdin_message_whitespace_prompt() {
    let msg = build_stdin_message("   \t\n   ", &[]);
    let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();
    assert!(!parsed.is_null());
}

/// Attachment with empty media type.
#[test]
fn test_agent_build_stdin_message_empty_media_type() {
    let att = ImageAttachment {
        media_type: "".to_string(),
        data_base64: "abc=".to_string(),
    };
    let msg = build_stdin_message("test", &[att]);
    // Should still produce valid JSON
    let parsed: Result<serde_json::Value, _> = serde_json::from_str(&msg);
    assert!(
        parsed.is_ok(),
        "Empty media type should still produce valid JSON"
    );
}

/// Attachment with empty base64 data.
#[test]
fn test_agent_build_stdin_message_empty_base64() {
    let att = ImageAttachment {
        media_type: "image/png".to_string(),
        data_base64: "".to_string(),
    };
    let msg = build_stdin_message("test", &[att]);
    let parsed: Result<serde_json::Value, _> = serde_json::from_str(&msg);
    assert!(
        parsed.is_ok(),
        "Empty base64 should still produce valid JSON"
    );
}

/// Attachment with very large base64 data (1MB).
#[test]
fn test_agent_build_stdin_message_large_base64() {
    let att = ImageAttachment {
        media_type: "image/jpeg".to_string(),
        data_base64: "A".repeat(1_000_000),
    };
    let msg = build_stdin_message("test", &[att]);
    let parsed: Result<serde_json::Value, _> = serde_json::from_str(&msg);
    assert!(parsed.is_ok());
}

/// Prompt containing null bytes.
#[test]
fn test_agent_build_stdin_message_null_bytes_prompt() {
    let msg = build_stdin_message("hello\x00world", &[]);
    // Should still produce valid JSON (null bytes should be escaped)
    let parsed: Result<serde_json::Value, _> = serde_json::from_str(&msg);
    assert!(
        parsed.is_ok(),
        "Null byte in prompt should produce valid JSON"
    );
}

/// Mixed image and PDF attachments.
#[test]
fn test_agent_build_stdin_message_mixed_attachments() {
    let attachments = vec![
        ImageAttachment {
            media_type: "image/png".to_string(),
            data_base64: "img=".to_string(),
        },
        ImageAttachment {
            media_type: "application/pdf".to_string(),
            data_base64: "pdf=".to_string(),
        },
        ImageAttachment {
            media_type: "image/jpeg".to_string(),
            data_base64: "jpg=".to_string(),
        },
    ];
    let msg = build_stdin_message("describe all", &attachments);
    let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();
    let text = parsed.to_string();
    // Should contain both image and document block types
    assert!(text.contains("image") || text.contains("img="));
    assert!(text.contains("document") || text.contains("pdf="));
}

/// Prompt that is itself valid JSON.
#[test]
fn test_agent_build_stdin_message_json_prompt() {
    let prompt = r#"{"role": "user", "content": "attack"}"#;
    let msg = build_stdin_message(prompt, &[]);
    let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();
    // The JSON prompt should be embedded as a string, not parsed as structure
    let text = parsed.to_string();
    assert!(text.contains("attack"));
}

// ─── ADVERSARIAL: AgentSettings round-trip ─────────────────────────

/// AgentSettings should survive JSON round-trip serialization.
#[test]
fn test_agent_settings_json_roundtrip() {
    let settings = AgentSettings {
        model: Some("opus".to_string()),
        fast_mode: true,
        thinking_enabled: true,
        plan_mode: false,
        effort: Some("high".to_string()),
        chrome_enabled: true,
        mcp_config: Some(r#"{"servers":[]}"#.to_string()),
    };
    let json = serde_json::to_string(&settings).unwrap();
    let deserialized: AgentSettings = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized.model, settings.model);
    assert_eq!(deserialized.fast_mode, settings.fast_mode);
    assert_eq!(deserialized.thinking_enabled, settings.thinking_enabled);
    assert_eq!(deserialized.plan_mode, settings.plan_mode);
    assert_eq!(deserialized.effort, settings.effort);
    assert_eq!(deserialized.chrome_enabled, settings.chrome_enabled);
    assert_eq!(deserialized.mcp_config, settings.mcp_config);
}

/// AgentSettings deserialization with extra unknown fields should succeed
/// (forward compatibility).
#[test]
fn test_agent_settings_deserialize_extra_fields() {
    let json = r#"{"model":"sonnet","fast_mode":false,"thinking_enabled":false,"plan_mode":false,"effort":null,"chrome_enabled":false,"mcp_config":null,"future_field":"value"}"#;
    let result: Result<AgentSettings, _> = serde_json::from_str(json);
    // Should either succeed (ignoring extra fields) or fail predictably
    if let Ok(s) = result {
        assert_eq!(s.model, Some("sonnet".to_string()));
    }
}

/// AgentSettings deserialization from empty JSON object.
#[test]
fn test_agent_settings_deserialize_empty_object() {
    let result: Result<AgentSettings, _> = serde_json::from_str("{}");
    // All fields have defaults, so this might work
    if let Ok(s) = result {
        assert!(s.model.is_none());
        assert!(!s.fast_mode);
    }
}

// ─── ADVERSARIAL: StreamEvent serialization ────────────────────────

/// StreamEvent::Unknown should be serializable.
#[test]
fn test_agent_stream_event_unknown_serialize() {
    // We can't easily construct StreamEvent::Unknown directly since it uses
    // #[serde(other)], but we can parse one and then re-serialize it
    let event = parse_stream_line(r#"{"type":"futuristic_event"}"#).unwrap();
    assert!(matches!(event, StreamEvent::Unknown));
    let json = serde_json::to_string(&event);
    // Serializing an #[serde(other)] variant might produce something unexpected
    // but should not panic
    let _ = json;
}

/// StreamEvent round-trip: serialize then deserialize a System event.
#[test]
fn test_agent_stream_event_system_roundtrip() {
    let line = r#"{"type":"system","subtype":"init","session_id":"s1"}"#;
    let event = parse_stream_line(line).unwrap();
    let json = serde_json::to_string(&event).unwrap();
    let reparsed: StreamEvent = serde_json::from_str(&json).unwrap();
    match reparsed {
        StreamEvent::System {
            subtype,
            session_id,
        } => {
            assert_eq!(subtype, "init");
            assert_eq!(session_id, Some("s1".to_string()));
        }
        _ => panic!("Round-trip should preserve System event"),
    }
}

/// StreamEvent round-trip for a text delta.
#[test]
fn test_agent_stream_event_text_delta_roundtrip() {
    let line = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":5,"delta":{"type":"text_delta","text":"round trip"}}}"#;
    let event = parse_stream_line(line).unwrap();
    let json = serde_json::to_string(&event).unwrap();
    let reparsed: StreamEvent = serde_json::from_str(&json).unwrap();
    match reparsed {
        StreamEvent::Stream { event } => match event {
            InnerStreamEvent::ContentBlockDelta { index, delta } => {
                assert_eq!(index, 5);
                match delta {
                    Delta::Text { text } => assert_eq!(text, "round trip"),
                    _ => panic!("Expected Text delta after round-trip"),
                }
            }
            _ => panic!("Expected ContentBlockDelta after round-trip"),
        },
        _ => panic!("Expected Stream event after round-trip"),
    }
}

/// AgentEvent::ProcessExited serialization.
#[test]
fn test_agent_event_process_exited_serialize() {
    let event = AgentEvent::ProcessExited(Some(0));
    let json = serde_json::to_string(&event).unwrap();
    assert!(json.contains("ProcessExited") || json.contains("0"));
}

/// AgentEvent::ProcessExited with None exit code.
#[test]
fn test_agent_event_process_exited_none_serialize() {
    let event = AgentEvent::ProcessExited(None);
    let json = serde_json::to_string(&event).unwrap();
    assert!(json.contains("null") || json.contains("ProcessExited"));
}
