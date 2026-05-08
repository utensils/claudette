use super::AgentSettings;
use super::types::FileAttachment;

/// Flags whose value is large or sensitive and should be redacted in the
/// chat-tab CLI invocation banner. Renders as `<flag> <redacted>` in
/// `format_redacted_invocation`.
///
/// Add a flag here when:
///   - the value can carry secrets (auth tokens, API keys, hook bridge
///     socket addresses, …); OR
///   - the value is plausibly large enough to dominate the banner
///     (multi-line system prompts, JSON schemas, agent definitions).
pub(crate) const REDACTED_VALUE_FLAGS: &[&str] = &[
    "--mcp-config",           // inline JSON, may carry tokens
    "--settings",             // inline JSON, hook bridge socket+token
    "--append-system-prompt", // potentially huge user prompt
    "--system-prompt",        // twin of --append-system-prompt
    "--agents",               // inline JSON, agent definitions
    "--betas",                // experimental flag set
    "--json-schema",          // user-supplied JSON schema
];

/// Render `(claude_path, argv)` as a shell-quoted, single-line command string
/// suitable for display in the chat tab. Sensitive values are replaced with
/// `<redacted>`. The trailing prompt positional (if present) is replaced with
/// `<prompt>` so we don't duplicate the user's first message.
pub(crate) fn format_redacted_invocation(claude_path: &std::ffi::OsStr, args: &[String]) -> String {
    let mut tokens: Vec<String> = Vec::with_capacity(args.len() + 1);
    tokens.push(shell_quote(&claude_path.to_string_lossy()));

    // Determine whether the last argv element is a trailing prompt positional.
    // It is a prompt when:
    //   - argv is non-empty, AND
    //   - the last token does NOT itself look like a flag, AND
    //   - the predecessor (if any) is NOT a flag (i.e. the last token is not
    //     the value to that flag — `--resume <id>`, `--effort high`, etc.).
    // If argv has only one element and it's not a flag, treat it as prompt.
    let prompt_index: Option<usize> = if args.is_empty() {
        None
    } else {
        let last_idx = args.len() - 1;
        let last = &args[last_idx];
        let last_is_flag = looks_like_flag(last);
        if last_is_flag {
            None
        } else if last_idx == 0 {
            Some(last_idx)
        } else {
            let prev = &args[last_idx - 1];
            if looks_like_flag(prev) {
                None // last is value to that flag
            } else {
                Some(last_idx)
            }
        }
    };

    let mut prev_is_redacted_flag = false;

    for (i, raw) in args.iter().enumerate() {
        if Some(i) == prompt_index {
            tokens.push("<prompt>".to_string());
            break;
        }
        if prev_is_redacted_flag {
            tokens.push("<redacted>".to_string());
            prev_is_redacted_flag = false;
            continue;
        }
        let is_redact_flag = REDACTED_VALUE_FLAGS.contains(&raw.as_str());
        tokens.push(shell_quote(raw));
        prev_is_redacted_flag = is_redact_flag;
    }

    tokens.join(" ")
}

fn looks_like_flag(s: &str) -> bool {
    s.starts_with("--") || s.starts_with('-')
}

/// POSIX-style shell quoting: empty -> `""`; contains whitespace or shell
/// metacharacters -> single-quoted with embedded `'` escaped as `'\''`;
/// otherwise emit verbatim.
fn shell_quote(s: &str) -> String {
    if s.is_empty() {
        return "\"\"".to_string();
    }
    let needs_quoting = s.chars().any(|c| {
        c.is_whitespace()
            || matches!(
                c,
                '$' | '`'
                    | '\''
                    | '"'
                    | '\\'
                    | '*'
                    | '?'
                    | '!'
                    | '#'
                    | '&'
                    | '|'
                    | ';'
                    | '<'
                    | '>'
                    | '('
                    | ')'
                    | '['
                    | ']'
                    | '{'
                    | '}'
            )
    });
    if !needs_quoting {
        return s.to_string();
    }
    let escaped = s.replace('\'', r"'\''");
    format!("'{escaped}'")
}

/// Build the CLI arguments for a `claude -p` invocation.
///
/// When `has_attachments` is true, the prompt is omitted from the args and
/// `--input-format stream-json` is added — the prompt + images are instead
/// piped to stdin as an `SDKUserMessage` JSON line (see [`build_stdin_message`]).
pub fn build_claude_args(
    session_id: &str,
    prompt: &str,
    is_resume: bool,
    allowed_tools: &[String],
    custom_instructions: Option<&str>,
    settings: &AgentSettings,
    has_attachments: bool,
) -> Vec<String> {
    let mut args = vec![
        "--print".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--include-partial-messages".to_string(),
    ];
    // NOTE: `--permission-prompt-tool stdio` is intentionally NOT added here.
    // `run_turn` runs with stdin closed (or only used for image upload), so
    // there's nobody to answer a `can_use_tool` control_request — advertising
    // the protocol would let the CLI hang waiting for AskUserQuestion /
    // ExitPlanMode approval that no consumer is listening for. The flag is
    // added in `build_persistent_args` instead, where the Tauri bridge owns
    // the stdin and handles control_request → control_response.

    let bypass_permissions = crate::permissions::is_bypass_tools(allowed_tools);

    // The Claude CLI accepts --model during --resume startup and applies it
    // before loading the transcript. Keep passing the UI-selected model so
    // restored Claudette sessions do not silently fall back to Claude Code's
    // saved/default model, especially for custom backend model IDs.
    if let Some(ref model) = settings.model {
        args.push("--model".to_string());
        args.push(model.clone());
    }

    // Chrome is session-level — only set on the first turn.
    if !is_resume && settings.chrome_enabled {
        args.push("--chrome".to_string());
    }

    // MCP config must be set on every turn — each `claude` invocation is a fresh
    // process that doesn't inherit MCP connections from previous turns.
    if let Some(ref mcp_json) = settings.mcp_config {
        args.push("--mcp-config".to_string());
        args.push(mcp_json.clone());
    }

    // Permission mode must be set on every turn — each `claude` invocation is
    // an independent process that doesn't inherit the previous turn's flags.
    if settings.plan_mode {
        args.push("--permission-mode".to_string());
        args.push("plan".to_string());
    } else if bypass_permissions {
        args.push("--permission-mode".to_string());
        args.push("bypassPermissions".to_string());
    }

    // Per-turn settings via --settings JSON.
    if let Some(settings_json) = build_settings_json(settings) {
        args.push("--settings".to_string());
        args.push(settings_json);
    }

    // Effort level — standalone flag, not part of --settings JSON.
    // "auto" and unknown values are skipped (let the CLI use its default).
    if let Some(ref effort) = settings.effort
        && matches!(effort.as_str(), "low" | "medium" | "high" | "xhigh" | "max")
    {
        args.push("--effort".to_string());
        args.push(effort.clone());
    }

    // Add --allowedTools (only for non-bypass modes — bypassPermissions already
    // skips all permission checks, and a redundant --allowedTools can interfere).
    if !bypass_permissions && !allowed_tools.is_empty() {
        args.push("--allowedTools".to_string());
        args.push(allowed_tools.join(","));
    }

    // Only append custom instructions on the first turn — resumed sessions
    // already have the system prompt set from the initial turn.
    if !is_resume
        && let Some(instructions) = custom_instructions
        && !instructions.trim().is_empty()
    {
        args.push("--append-system-prompt".to_string());
        args.push(instructions.to_string());
    }

    // User-toggled extra flags (from the Claude flags settings UI). Inserted
    // before --resume/--session-id and the trailing prompt so the prompt
    // remains the last positional arg.
    for (name, value) in &settings.extra_claude_flags {
        args.push(name.clone());
        if let Some(v) = value {
            args.push(v.clone());
        }
    }

    if is_resume {
        args.push("--resume".to_string());
        args.push(session_id.to_string());
    } else {
        args.push("--session-id".to_string());
        args.push(session_id.to_string());
    }

    if has_attachments {
        // When images are present, the prompt is sent via stdin as a structured
        // SDKUserMessage (with content blocks). We add --input-format stream-json
        // so the CLI reads from stdin instead of the positional arg.
        args.push("--input-format".to_string());
        args.push("stream-json".to_string());
    } else {
        args.push(prompt.to_string());
    }

    args
}

pub(super) fn build_settings_json(settings: &AgentSettings) -> Option<String> {
    let mut obj = serde_json::Map::new();
    if settings.fast_mode {
        obj.insert("fastMode".to_string(), serde_json::Value::Bool(true));
    }
    if settings.thinking_enabled {
        obj.insert(
            "alwaysThinkingEnabled".to_string(),
            serde_json::Value::Bool(true),
        );
    }
    if let Some(ref hook_bridge) = settings.hook_bridge {
        let hook = serde_json::json!({
            "matcher": "",
            "hooks": [{
                "type": "command",
                "command": hook_bridge.command,
                "timeout": 5,
            }],
        });
        obj.insert(
            "hooks".to_string(),
            serde_json::json!({
                "SubagentStart": [hook.clone()],
                "PreToolUse": [hook.clone()],
                "PostToolUse": [hook.clone()],
                "PostToolUseFailure": [hook],
                "SubagentStop": [{
                    "matcher": "",
                    "hooks": [{
                        "type": "command",
                        "command": hook_bridge.command,
                        "timeout": 5,
                    }],
                }],
            }),
        );
    }
    if obj.is_empty() {
        None
    } else {
        Some(serde_json::Value::Object(obj).to_string())
    }
}

/// Build a single-line JSON payload for stdin when using `--input-format stream-json`.
///
/// Produces an `SDKUserMessage` with content blocks: one text block for the
/// prompt, then one block per attachment — text files become `"text"` blocks,
/// PDFs become `"document"` blocks, and images become `"image"` blocks.
pub fn build_stdin_message(prompt: &str, attachments: &[FileAttachment]) -> String {
    build_stdin_message_inner(prompt, attachments, None)
}

/// Build a stdin SDK user message that should be delivered to the active turn.
pub fn build_steering_stdin_message(prompt: &str, attachments: &[FileAttachment]) -> String {
    build_stdin_message_inner(prompt, attachments, Some("next"))
}

fn build_stdin_message_inner(
    prompt: &str,
    attachments: &[FileAttachment],
    priority: Option<&str>,
) -> String {
    let mut content_blocks = Vec::new();

    // Only add a text block if the prompt is non-empty — the API rejects
    // empty text content blocks with "text content blocks must be non-empty".
    if !prompt.trim().is_empty() {
        content_blocks.push(serde_json::json!({"type": "text", "text": prompt}));
    }

    for att in attachments {
        if let Some(ref text) = att.text_content {
            let label = att.filename.as_deref().unwrap_or("file");
            let block_text = format!("Content of `{label}`:\n```\n{text}\n```");
            content_blocks.push(serde_json::json!({"type": "text", "text": block_text}));
        } else if att.media_type == "application/pdf" {
            content_blocks.push(serde_json::json!({
                "type": "document",
                "source": {
                    "type": "base64",
                    "media_type": att.media_type,
                    "data": att.data_base64,
                }
            }));
        } else {
            content_blocks.push(serde_json::json!({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": att.media_type,
                    "data": att.data_base64,
                }
            }));
        }
    }

    let mut payload = serde_json::json!({
        "type": "user",
        "uuid": uuid::Uuid::new_v4().to_string(),
        "message": {
            "role": "user",
            "content": content_blocks,
        },
        "parent_tool_use_id": null,
    });
    if let Some(priority) = priority
        && let Some(obj) = payload.as_object_mut()
    {
        obj.insert(
            "priority".to_string(),
            serde_json::Value::String(priority.to_string()),
        );
    }
    payload.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_args_first_turn_no_tools() {
        let args = build_claude_args(
            "sess-1",
            "hello",
            false,
            &[],
            None,
            &AgentSettings::default(),
            false,
        );
        assert!(args.contains(&"--print".to_string()));
        assert!(args.contains(&"--session-id".to_string()));
        assert!(args.contains(&"sess-1".to_string()));
        assert!(args.last() == Some(&"hello".to_string()));
        assert!(!args.contains(&"--allowedTools".to_string()));
        assert!(!args.contains(&"--resume".to_string()));
        assert!(!args.contains(&"--append-system-prompt".to_string()));
    }

    #[test]
    fn test_build_args_resume() {
        let args = build_claude_args(
            "sess-1",
            "continue",
            true,
            &[],
            None,
            &AgentSettings::default(),
            false,
        );
        assert!(args.contains(&"--resume".to_string()));
        assert!(!args.contains(&"--session-id".to_string()));
    }

    #[test]
    fn test_build_args_with_allowed_tools() {
        let tools = vec!["Bash".to_string(), "Read".to_string(), "Edit".to_string()];
        let args = build_claude_args(
            "sess-1",
            "hello",
            false,
            &tools,
            None,
            &AgentSettings::default(),
            false,
        );
        let idx = args.iter().position(|a| a == "--allowedTools").unwrap();
        assert_eq!(args[idx + 1], "Bash,Read,Edit");
    }

    #[test]
    fn test_build_args_with_custom_instructions() {
        let args = build_claude_args(
            "sess-1",
            "hello",
            false,
            &[],
            Some("Always use TypeScript"),
            &AgentSettings::default(),
            false,
        );
        let idx = args
            .iter()
            .position(|a| a == "--append-system-prompt")
            .unwrap();
        assert_eq!(args[idx + 1], "Always use TypeScript");
    }

    #[test]
    fn test_build_args_empty_instructions_skipped() {
        let args = build_claude_args(
            "sess-1",
            "hello",
            false,
            &[],
            Some(""),
            &AgentSettings::default(),
            false,
        );
        assert!(!args.contains(&"--append-system-prompt".to_string()));
    }

    #[test]
    fn test_build_args_whitespace_instructions_skipped() {
        let args = build_claude_args(
            "sess-1",
            "hello",
            false,
            &[],
            Some("   "),
            &AgentSettings::default(),
            false,
        );
        assert!(!args.contains(&"--append-system-prompt".to_string()));
    }

    #[test]
    fn test_build_args_resume_skips_instructions() {
        let args = build_claude_args(
            "sess-1",
            "hello",
            true,
            &[],
            Some("Always use TypeScript"),
            &AgentSettings::default(),
            false,
        );
        assert!(!args.contains(&"--append-system-prompt".to_string()));
        assert!(args.contains(&"--resume".to_string()));
    }

    #[test]
    fn test_build_args_with_model() {
        let settings = AgentSettings {
            model: Some("opus".to_string()),
            ..Default::default()
        };
        let args = build_claude_args("sess-1", "hello", false, &[], None, &settings, false);
        let idx = args
            .iter()
            .position(|a| a == "--model")
            .expect("--model should be present");
        assert_eq!(args[idx + 1], "opus");
    }

    #[test]
    fn test_build_args_model_preserved_on_resume() {
        let settings = AgentSettings {
            model: Some("opus".to_string()),
            ..Default::default()
        };
        let args = build_claude_args("sess-1", "hello", true, &[], None, &settings, false);
        let idx = args
            .iter()
            .position(|a| a == "--model")
            .expect("--model should be present");
        assert_eq!(args[idx + 1], "opus");
    }

    #[test]
    fn test_build_args_plan_mode() {
        let settings = AgentSettings {
            plan_mode: true,
            ..Default::default()
        };
        let args = build_claude_args("sess-1", "hello", false, &[], None, &settings, false);
        let idx = args.iter().position(|a| a == "--permission-mode").unwrap();
        assert_eq!(args[idx + 1], "plan");
    }

    #[test]
    fn test_build_args_plan_mode_set_on_resume() {
        let settings = AgentSettings {
            plan_mode: true,
            ..Default::default()
        };
        let args = build_claude_args("sess-1", "hello", true, &[], None, &settings, false);
        // Permission mode must be set on every turn (per-process flag)
        let idx = args.iter().position(|a| a == "--permission-mode").unwrap();
        assert_eq!(args[idx + 1], "plan");
    }

    #[test]
    fn test_build_args_with_settings_json() {
        let settings = AgentSettings {
            fast_mode: true,
            thinking_enabled: true,
            ..Default::default()
        };
        let args = build_claude_args("sess-1", "hello", false, &[], None, &settings, false);
        let idx = args.iter().position(|a| a == "--settings").unwrap();
        let json: serde_json::Value = serde_json::from_str(&args[idx + 1]).unwrap();
        assert_eq!(json["fastMode"], true);
        assert_eq!(json["alwaysThinkingEnabled"], true);
    }

    #[test]
    fn test_build_args_fast_mode_only() {
        let settings = AgentSettings {
            fast_mode: true,
            ..Default::default()
        };
        let args = build_claude_args("sess-1", "hello", false, &[], None, &settings, false);
        let idx = args.iter().position(|a| a == "--settings").unwrap();
        let json: serde_json::Value = serde_json::from_str(&args[idx + 1]).unwrap();
        assert_eq!(json["fastMode"], true);
        assert!(json.get("alwaysThinkingEnabled").is_none());
    }

    #[test]
    fn test_build_args_settings_on_resume() {
        let settings = AgentSettings {
            fast_mode: true,
            thinking_enabled: true,
            ..Default::default()
        };
        // --settings should still be passed on resume (per-turn flag)
        let args = build_claude_args("sess-1", "hello", true, &[], None, &settings, false);
        assert!(args.contains(&"--settings".to_string()));
    }

    #[test]
    fn test_build_args_bypass_permissions_first_turn() {
        let tools = vec!["*".to_string()];
        let args = build_claude_args(
            "sess-1",
            "hello",
            false,
            &tools,
            None,
            &AgentSettings::default(),
            false,
        );
        // Should set permission-mode to bypassPermissions on first turn
        let pm_idx = args.iter().position(|a| a == "--permission-mode").unwrap();
        assert_eq!(args[pm_idx + 1], "bypassPermissions");
        // bypassPermissions should NOT pass --allowedTools (it interferes with the mode)
        assert!(!args.contains(&"--allowedTools".to_string()));
    }

    #[test]
    fn test_build_args_bypass_permissions_resume() {
        let tools = vec!["*".to_string()];
        let args = build_claude_args(
            "sess-1",
            "hello",
            true,
            &tools,
            None,
            &AgentSettings::default(),
            false,
        );
        // Permission mode must be set on every turn (per-process flag)
        let pm_idx = args.iter().position(|a| a == "--permission-mode").unwrap();
        assert_eq!(args[pm_idx + 1], "bypassPermissions");
        // bypassPermissions should NOT pass --allowedTools
        assert!(!args.contains(&"--allowedTools".to_string()));
    }

    #[test]
    fn test_build_args_bypass_permissions_with_plan_mode() {
        let tools = vec!["*".to_string()];
        let settings = AgentSettings {
            plan_mode: true,
            ..Default::default()
        };
        let args = build_claude_args("sess-1", "hello", false, &tools, None, &settings, false);
        // Plan mode takes precedence over bypass
        let pm_idx = args.iter().position(|a| a == "--permission-mode").unwrap();
        assert_eq!(args[pm_idx + 1], "plan");
        // Even with plan_mode, bypass tools should NOT pass --allowedTools
        assert!(!args.contains(&"--allowedTools".to_string()));
    }

    #[test]
    fn test_build_args_with_effort() {
        let settings = AgentSettings {
            effort: Some("high".to_string()),
            ..Default::default()
        };
        let args = build_claude_args("sess-1", "hello", false, &[], None, &settings, false);
        let idx = args.iter().position(|a| a == "--effort").unwrap();
        assert_eq!(args[idx + 1], "high");
    }

    #[test]
    fn test_build_args_with_effort_xhigh() {
        let settings = AgentSettings {
            effort: Some("xhigh".to_string()),
            ..Default::default()
        };
        let args = build_claude_args("sess-1", "hello", false, &[], None, &settings, false);
        let idx = args.iter().position(|a| a == "--effort").unwrap();
        assert_eq!(args[idx + 1], "xhigh");
    }

    #[test]
    fn test_build_args_effort_none_omitted() {
        let args = build_claude_args(
            "sess-1",
            "hello",
            false,
            &[],
            None,
            &AgentSettings::default(),
            false,
        );
        assert!(!args.contains(&"--effort".to_string()));
    }

    #[test]
    fn test_build_args_effort_auto_omitted() {
        let settings = AgentSettings {
            effort: Some("auto".to_string()),
            ..Default::default()
        };
        let args = build_claude_args("sess-1", "hello", false, &[], None, &settings, false);
        // "auto" means let the CLI use its default — don't pass --effort
        assert!(!args.contains(&"--effort".to_string()));
    }

    #[test]
    fn test_build_args_effort_on_resume() {
        let settings = AgentSettings {
            effort: Some("low".to_string()),
            ..Default::default()
        };
        let args = build_claude_args("sess-1", "hello", true, &[], None, &settings, false);
        let idx = args.iter().position(|a| a == "--effort").unwrap();
        assert_eq!(args[idx + 1], "low");
    }

    #[test]
    fn test_build_args_effort_with_other_settings() {
        let settings = AgentSettings {
            fast_mode: true,
            thinking_enabled: true,
            effort: Some("max".to_string()),
            ..Default::default()
        };
        let args = build_claude_args("sess-1", "hello", false, &[], None, &settings, false);
        // --effort is a standalone flag, separate from --settings JSON
        let effort_idx = args.iter().position(|a| a == "--effort").unwrap();
        assert_eq!(args[effort_idx + 1], "max");
        let settings_idx = args.iter().position(|a| a == "--settings").unwrap();
        let json: serde_json::Value = serde_json::from_str(&args[settings_idx + 1]).unwrap();
        assert_eq!(json["fastMode"], true);
        assert_eq!(json["alwaysThinkingEnabled"], true);
        // effort should NOT be in the --settings JSON
        assert!(json.get("effort").is_none());
    }

    #[test]
    fn test_build_args_with_chrome() {
        let settings = AgentSettings {
            chrome_enabled: true,
            ..Default::default()
        };
        let args = build_claude_args("sess-1", "hello", false, &[], None, &settings, false);
        assert!(args.contains(&"--chrome".to_string()));
    }

    #[test]
    fn test_build_args_chrome_skipped_on_resume() {
        let settings = AgentSettings {
            chrome_enabled: true,
            ..Default::default()
        };
        let args = build_claude_args("sess-1", "hello", true, &[], None, &settings, false);
        assert!(!args.contains(&"--chrome".to_string()));
    }

    #[test]
    fn test_build_args_with_mcp_config() {
        let settings = AgentSettings {
            mcp_config: Some(r#"{"mcpServers":{"s":{"type":"stdio","command":"x"}}}"#.to_string()),
            ..Default::default()
        };
        let args = build_claude_args("sess-1", "hello", false, &[], None, &settings, false);
        let idx = args.iter().position(|a| a == "--mcp-config").unwrap();
        assert!(args[idx + 1].contains("mcpServers"));
    }

    #[test]
    fn test_build_args_mcp_config_on_resume() {
        let settings = AgentSettings {
            mcp_config: Some(r#"{"mcpServers":{"s":{"type":"stdio","command":"x"}}}"#.to_string()),
            ..Default::default()
        };
        let args = build_claude_args("sess-1", "hello", true, &[], None, &settings, false);
        // MCP config must be passed on every turn (including resume)
        let idx = args.iter().position(|a| a == "--mcp-config").unwrap();
        assert!(args[idx + 1].contains("mcpServers"));
    }

    #[test]
    fn test_build_args_mcp_config_none_omitted() {
        let settings = AgentSettings::default();
        let args = build_claude_args("sess-1", "hello", false, &[], None, &settings, false);
        assert!(!args.contains(&"--mcp-config".to_string()));
    }

    fn default_settings() -> AgentSettings {
        AgentSettings::default()
    }

    #[test]
    fn test_build_args_without_attachments_unchanged() {
        let args = build_claude_args(
            "sess-1",
            "hello world",
            false,
            &["Bash".into(), "Read".into()],
            None,
            &default_settings(),
            false,
        );
        // Prompt should be the last positional arg.
        assert_eq!(args.last().unwrap(), "hello world");
        // Should NOT have --input-format stream-json.
        assert!(!args.contains(&"--input-format".to_string()));
    }

    #[test]
    fn test_build_args_with_attachments_uses_stream_json() {
        let args = build_claude_args(
            "sess-1",
            "describe this image",
            false,
            &["Bash".into()],
            None,
            &default_settings(),
            true,
        );
        // Should have --input-format stream-json.
        let idx = args
            .iter()
            .position(|a| a == "--input-format")
            .expect("missing --input-format");
        assert_eq!(args[idx + 1], "stream-json");
        // Prompt should NOT be a positional arg.
        assert_ne!(args.last().unwrap(), "describe this image");
    }

    #[test]
    fn test_build_stdin_message_text_only() {
        let msg = build_stdin_message("hello", &[]);
        let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();
        assert_eq!(parsed["type"], "user");
        assert!(parsed.get("priority").is_none());
        assert!(
            parsed["uuid"]
                .as_str()
                .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
        );
        assert_eq!(parsed["parent_tool_use_id"], serde_json::Value::Null);
        let content = parsed["message"]["content"].as_array().unwrap();
        assert_eq!(content.len(), 1);
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[0]["text"], "hello");
    }

    #[test]
    fn test_build_steering_stdin_message_sets_next_priority() {
        let msg = build_steering_stdin_message("steer this turn", &[]);
        let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();
        assert_eq!(parsed["type"], "user");
        assert_eq!(parsed["priority"], "next");
        assert_eq!(parsed["message"]["role"], "user");
        let content = parsed["message"]["content"].as_array().unwrap();
        assert_eq!(content[0]["text"], "steer this turn");
    }

    #[test]
    fn test_build_stdin_message_empty_prompt_omits_text_block() {
        let attachments = vec![FileAttachment {
            media_type: "image/png".into(),
            data_base64: "data".into(),
            text_content: None,
            filename: None,
        }];
        let msg = build_stdin_message("", &attachments);
        let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();
        let content = parsed["message"]["content"].as_array().unwrap();
        // Should only have the image block, no empty text block.
        assert_eq!(content.len(), 1);
        assert_eq!(content[0]["type"], "image");
    }

    #[test]
    fn test_build_stdin_message_whitespace_prompt_omits_text_block() {
        let attachments = vec![FileAttachment {
            media_type: "image/png".into(),
            data_base64: "data".into(),
            text_content: None,
            filename: None,
        }];
        let msg = build_stdin_message("   ", &attachments);
        let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();
        let content = parsed["message"]["content"].as_array().unwrap();
        assert_eq!(content.len(), 1);
        assert_eq!(content[0]["type"], "image");
    }

    #[test]
    fn test_build_stdin_message_with_image() {
        let attachments = vec![FileAttachment {
            media_type: "image/png".into(),
            data_base64: "iVBORw0KGgo=".into(),
            text_content: None,
            filename: None,
        }];
        let msg = build_stdin_message("describe this", &attachments);
        let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();
        let content = parsed["message"]["content"].as_array().unwrap();
        assert_eq!(content.len(), 2);
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[0]["text"], "describe this");
        assert_eq!(content[1]["type"], "image");
        assert_eq!(content[1]["source"]["type"], "base64");
        assert_eq!(content[1]["source"]["media_type"], "image/png");
        assert_eq!(content[1]["source"]["data"], "iVBORw0KGgo=");
    }

    #[test]
    fn test_build_stdin_message_multiple_images() {
        let attachments = vec![
            FileAttachment {
                media_type: "image/png".into(),
                data_base64: "png_data".into(),
                text_content: None,
                filename: None,
            },
            FileAttachment {
                media_type: "image/jpeg".into(),
                data_base64: "jpg_data".into(),
                text_content: None,
                filename: None,
            },
            FileAttachment {
                media_type: "image/webp".into(),
                data_base64: "webp_data".into(),
                text_content: None,
                filename: None,
            },
        ];
        let msg = build_stdin_message("compare these", &attachments);
        let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();
        let content = parsed["message"]["content"].as_array().unwrap();
        assert_eq!(content.len(), 4); // 1 text + 3 images
        assert_eq!(content[1]["source"]["media_type"], "image/png");
        assert_eq!(content[2]["source"]["media_type"], "image/jpeg");
        assert_eq!(content[3]["source"]["media_type"], "image/webp");
    }

    #[test]
    fn test_build_stdin_message_pdf_uses_document_block() {
        let attachments = vec![FileAttachment {
            media_type: "application/pdf".into(),
            data_base64: "JVBERi0xLjQ=".into(),
            text_content: None,
            filename: None,
        }];
        let msg = build_stdin_message("review this doc", &attachments);
        let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();
        let content = parsed["message"]["content"].as_array().unwrap();
        assert_eq!(content.len(), 2);
        assert_eq!(content[0]["type"], "text");
        // PDFs must use "document" type, not "image".
        assert_eq!(content[1]["type"], "document");
        assert_eq!(content[1]["source"]["type"], "base64");
        assert_eq!(content[1]["source"]["media_type"], "application/pdf");
        assert_eq!(content[1]["source"]["data"], "JVBERi0xLjQ=");
    }

    #[test]
    fn test_build_stdin_message_mixed_images_and_pdf() {
        let attachments = vec![
            FileAttachment {
                media_type: "image/png".into(),
                data_base64: "png_data".into(),
                text_content: None,
                filename: None,
            },
            FileAttachment {
                media_type: "application/pdf".into(),
                data_base64: "pdf_data".into(),
                text_content: None,
                filename: None,
            },
        ];
        let msg = build_stdin_message("here are files", &attachments);
        let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();
        let content = parsed["message"]["content"].as_array().unwrap();
        assert_eq!(content.len(), 3); // 1 text + 1 image + 1 document
        assert_eq!(content[1]["type"], "image");
        assert_eq!(content[2]["type"], "document");
    }

    #[test]
    fn test_build_stdin_message_text_file() {
        let attachments = vec![FileAttachment {
            media_type: "text/plain".into(),
            data_base64: String::new(),
            text_content: Some("fn main() {}".into()),
            filename: Some("main.rs".into()),
        }];
        let msg = build_stdin_message("review this", &attachments);
        let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();
        let content = parsed["message"]["content"].as_array().unwrap();
        assert_eq!(content.len(), 2);
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[0]["text"], "review this");
        assert_eq!(content[1]["type"], "text");
        let text = content[1]["text"].as_str().unwrap();
        assert!(text.contains("main.rs"));
        assert!(text.contains("fn main() {}"));
    }

    #[test]
    fn test_build_stdin_message_mixed_all_types() {
        let attachments = vec![
            FileAttachment {
                media_type: "text/plain".into(),
                data_base64: String::new(),
                text_content: Some("hello world".into()),
                filename: Some("readme.txt".into()),
            },
            FileAttachment {
                media_type: "image/png".into(),
                data_base64: "png_data".into(),
                text_content: None,
                filename: None,
            },
            FileAttachment {
                media_type: "application/pdf".into(),
                data_base64: "pdf_data".into(),
                text_content: None,
                filename: None,
            },
        ];
        let msg = build_stdin_message("check these", &attachments);
        let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();
        let content = parsed["message"]["content"].as_array().unwrap();
        assert_eq!(content.len(), 4); // 1 prompt + 1 text file + 1 image + 1 document
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[0]["text"], "check these");
        assert_eq!(content[1]["type"], "text");
        assert!(content[1]["text"].as_str().unwrap().contains("readme.txt"));
        assert_eq!(content[2]["type"], "image");
        assert_eq!(content[3]["type"], "document");
    }

    #[test]
    fn test_build_stdin_message_text_file_no_filename_uses_default() {
        let attachments = vec![FileAttachment {
            media_type: "text/plain".into(),
            data_base64: String::new(),
            text_content: Some("data".into()),
            filename: None,
        }];
        let msg = build_stdin_message("", &attachments);
        let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();
        let content = parsed["message"]["content"].as_array().unwrap();
        assert_eq!(content.len(), 1);
        let text = content[0]["text"].as_str().unwrap();
        assert!(text.contains("`file`"));
    }

    #[test]
    fn test_build_args_mcp_config_none_not_present() {
        // When mcp_config is None, --mcp-config should not appear at all.
        let settings = AgentSettings {
            mcp_config: None,
            ..Default::default()
        };
        let args = build_claude_args("sess-1", "hello", false, &[], None, &settings, false);
        assert!(!args.iter().any(|a| a == "--mcp-config"));
    }

    #[test]
    fn test_build_args_appends_extra_flags() {
        let settings = AgentSettings {
            extra_claude_flags: vec![
                ("--debug".to_string(), None),
                ("--add-dir".to_string(), Some("/foo".to_string())),
            ],
            ..Default::default()
        };
        let args = build_claude_args("sess-1", "hello", false, &[], None, &settings, false);

        let debug_idx = args
            .iter()
            .position(|a| a == "--debug")
            .expect("--debug should be present");
        // Boolean flag — the next arg should not be its "value".
        let after_debug = args.get(debug_idx + 1).map(String::as_str);
        assert_ne!(after_debug, Some("/foo"), "--debug should not consume /foo");

        let add_dir_idx = args
            .iter()
            .position(|a| a == "--add-dir")
            .expect("--add-dir should be present");
        assert_eq!(args[add_dir_idx + 1], "/foo");
    }

    #[test]
    fn test_build_args_extra_flags_dont_consume_prompt() {
        let settings = AgentSettings {
            extra_claude_flags: vec![
                ("--debug".to_string(), None),
                ("--add-dir".to_string(), Some("/foo".to_string())),
            ],
            ..Default::default()
        };
        let args = build_claude_args("sess-1", "hello world", false, &[], None, &settings, false);
        assert_eq!(
            args.last().map(String::as_str),
            Some("hello world"),
            "prompt must remain the last positional arg"
        );
    }

    #[test]
    fn build_claude_args_omits_stdio_permission_prompt() {
        let args = build_claude_args(
            "sid",
            "hi",
            false,
            &["Read".to_string()],
            None,
            &AgentSettings::default(),
            false,
        );
        assert!(
            !args.iter().any(|a| a == "--permission-prompt-tool"),
            "build_claude_args must not enable the stdio permission prompt"
        );
    }

    #[test]
    fn format_redacts_known_sensitive_values() {
        let args: Vec<String> = vec![
            "--print".into(),
            "--mcp-config".into(),
            r#"{"mcpServers":{"a":{}}}"#.into(),
            "--settings".into(),
            r#"{"hooks":{}}"#.into(),
            "--append-system-prompt".into(),
            "You are helpful".into(),
            "--model".into(),
            "opus".into(),
        ];
        let line = format_redacted_invocation(std::ffi::OsStr::new("/bin/claude"), &args);
        assert!(line.contains("--mcp-config <redacted>"), "{line}");
        assert!(line.contains("--settings <redacted>"), "{line}");
        assert!(line.contains("--append-system-prompt <redacted>"), "{line}");
        assert!(line.contains("--model opus"), "{line}");
    }

    #[test]
    fn format_redacts_system_prompt() {
        let args: Vec<String> = vec![
            "--system-prompt".into(),
            "You are a senior engineer. Always think before acting.".into(),
        ];
        let line = format_redacted_invocation(std::ffi::OsStr::new("/bin/claude"), &args);
        assert!(line.contains("--system-prompt <redacted>"), "{line}");
        assert!(!line.contains("senior engineer"), "{line}");
    }

    #[test]
    fn format_redacts_agents_betas_and_json_schema() {
        for flag in ["--agents", "--betas", "--json-schema"] {
            let args: Vec<String> = vec![flag.into(), "secret-value".into()];
            let line = format_redacted_invocation(std::ffi::OsStr::new("/bin/claude"), &args);
            assert!(
                line.contains(&format!("{flag} <redacted>")),
                "flag {flag} should be redacted: {line}",
            );
            assert!(
                !line.contains("secret-value"),
                "value for {flag} leaked into output: {line}",
            );
        }
    }

    #[test]
    fn format_replaces_trailing_prompt_positional() {
        let args: Vec<String> = vec![
            "--print".into(),
            "--session-id".into(),
            "abc-123".into(),
            "please read the README".into(),
        ];
        let line = format_redacted_invocation(std::ffi::OsStr::new("/bin/claude"), &args);
        assert!(line.ends_with(" <prompt>"), "{line}");
        assert!(!line.contains("please read"), "{line}");
    }

    #[test]
    fn format_keeps_resume_argv_without_prompt_tail() {
        // Persistent session: no prompt positional. Last arg is `--resume <id>`.
        let args: Vec<String> = vec![
            "--print".into(),
            "--input-format".into(),
            "stream-json".into(),
            "--resume".into(),
            "abc-123".into(),
        ];
        let line = format_redacted_invocation(std::ffi::OsStr::new("/bin/claude"), &args);
        assert!(line.ends_with("--resume abc-123"), "{line}");
        assert!(!line.contains("<prompt>"), "{line}");
    }

    #[test]
    fn format_quotes_special_chars_in_non_redacted_values() {
        let args: Vec<String> = vec![
            "--allowedTools".into(),
            "Bash,Read,Edit".into(),
            "--effort".into(),
            "high".into(),
            "--mcp-config".into(),
            "should be redacted".into(),
            "what is $HOME?".into(),
        ];
        let line = format_redacted_invocation(std::ffi::OsStr::new("/bin/claude"), &args);
        assert!(line.contains("--allowedTools Bash,Read,Edit"), "{line}");
        assert!(line.contains("--mcp-config <redacted>"), "{line}");
        assert!(line.ends_with("<prompt>"), "{line}");
    }

    #[test]
    fn format_quotes_path_with_spaces() {
        let args: Vec<String> = vec!["--model".into(), "opus".into()];
        let line = format_redacted_invocation(
            std::ffi::OsStr::new("/Users/me/Application Support/claude"),
            &args,
        );
        assert!(
            line.starts_with("'/Users/me/Application Support/claude' "),
            "{line}"
        );
    }

    #[test]
    fn format_handles_empty_string_value() {
        let args: Vec<String> = vec!["--effort".into(), "".into()];
        let line = format_redacted_invocation(std::ffi::OsStr::new("/bin/claude"), &args);
        assert!(line.contains("--effort \"\""), "{line}");
    }

    #[test]
    fn format_real_first_turn_argv_round_trip() {
        let settings = AgentSettings {
            model: Some("opus".to_string()),
            mcp_config: Some(r#"{"mcpServers":{}}"#.to_string()),
            effort: Some("high".to_string()),
            ..Default::default()
        };
        let args = build_claude_args(
            "session-uuid",
            "hello there",
            false,
            &["Bash".into(), "Read".into()],
            None,
            &settings,
            false,
        );
        let line = format_redacted_invocation(std::ffi::OsStr::new("/bin/claude"), &args);
        assert!(line.starts_with("/bin/claude --print"), "{line}");
        assert!(line.contains("--mcp-config <redacted>"), "{line}");
        assert!(line.contains("--model opus"), "{line}");
        assert!(line.contains("--allowedTools Bash,Read"), "{line}");
        assert!(line.contains("--session-id session-uuid"), "{line}");
        assert!(line.ends_with(" <prompt>"), "{line}");
    }
}
