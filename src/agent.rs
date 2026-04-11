#![allow(dead_code)]

use std::path::Path;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;

// ---------------------------------------------------------------------------
// Stream event types — maps to Claude CLI `--output-format stream-json`
// ---------------------------------------------------------------------------

/// Top-level JSON line from Claude CLI stdout.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum StreamEvent {
    #[serde(rename = "system")]
    System {
        subtype: String,
        #[serde(default)]
        session_id: Option<String>,
    },

    #[serde(rename = "stream_event")]
    Stream { event: InnerStreamEvent },

    #[serde(rename = "assistant")]
    Assistant { message: AssistantMessage },

    #[serde(rename = "result")]
    Result {
        subtype: String,
        #[serde(default)]
        result: Option<String>,
        #[serde(default)]
        total_cost_usd: Option<f64>,
        #[serde(default)]
        duration_ms: Option<i64>,
    },

    #[serde(rename = "user")]
    User { message: UserEventMessage },

    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum InnerStreamEvent {
    #[serde(rename = "message_start")]
    MessageStart {},

    #[serde(rename = "content_block_start")]
    ContentBlockStart {
        index: usize,
        #[serde(default)]
        content_block: Option<StartContentBlock>,
    },

    #[serde(rename = "content_block_delta")]
    ContentBlockDelta { index: usize, delta: Delta },

    #[serde(rename = "content_block_stop")]
    ContentBlockStop { index: usize },

    #[serde(rename = "message_delta")]
    MessageDelta {},

    #[serde(rename = "message_stop")]
    MessageStop {},

    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Delta {
    #[serde(rename = "text_delta")]
    Text { text: String },

    #[serde(rename = "tool_use_delta")]
    ToolUse {
        #[serde(default)]
        partial_json: Option<String>,
    },

    #[serde(rename = "input_json_delta")]
    InputJson {
        #[serde(default)]
        partial_json: Option<String>,
    },

    #[serde(other)]
    Unknown,
}

/// Content block info from `content_block_start` events.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum StartContentBlock {
    #[serde(rename = "tool_use")]
    ToolUse { id: String, name: String },

    #[serde(rename = "text")]
    Text {},

    #[serde(other)]
    Unknown,
}

/// Message payload from `user` type events (tool results fed back to the model).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserEventMessage {
    #[serde(default)]
    pub content: Vec<UserContentBlock>,
}

/// Content block within a `user` event message.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum UserContentBlock {
    #[serde(rename = "tool_result")]
    ToolResult {
        tool_use_id: String,
        #[serde(default)]
        content: serde_json::Value,
    },

    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssistantMessage {
    pub content: Vec<ContentBlock>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ContentBlock {
    #[serde(rename = "text")]
    Text { text: String },

    #[serde(rename = "tool_use")]
    ToolUse { id: String, name: String },

    #[serde(other)]
    Unknown,
}

/// Parse a single JSON line from the Claude CLI stdout stream.
pub fn parse_stream_line(line: &str) -> Result<StreamEvent, serde_json::Error> {
    serde_json::from_str(line)
}

// ---------------------------------------------------------------------------
// Agent events — wrapper for all events from a turn
// ---------------------------------------------------------------------------

/// Events emitted by an agent turn (stream events + process lifecycle).
#[derive(Debug, Clone, Serialize)]
pub enum AgentEvent {
    /// A parsed stream event from stdout.
    Stream(StreamEvent),
    /// The agent process has exited.
    ProcessExited(Option<i32>),
}

// ---------------------------------------------------------------------------
// Per-turn agent settings
// ---------------------------------------------------------------------------

/// Per-turn settings that control CLI flags for the agent subprocess.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AgentSettings {
    /// Model alias (e.g. "opus", "sonnet") or full model ID. Session-level: only
    /// applied on the first turn.
    pub model: Option<String>,
    /// Enable fast mode via `--settings`.
    pub fast_mode: bool,
    /// Enable extended thinking via `--settings`.
    pub thinking_enabled: bool,
    /// Start session in plan permission mode. Applied on every turn (each
    /// `claude` invocation is an independent process).
    pub plan_mode: bool,
}

// ---------------------------------------------------------------------------
// Per-turn agent process
// ---------------------------------------------------------------------------

/// Handle for an active agent turn — holds the event receiver and process ID.
pub struct TurnHandle {
    pub event_rx: mpsc::Receiver<AgentEvent>,
    pub pid: u32,
}

/// Build the CLI arguments for a `claude -p` invocation.
pub fn build_claude_args(
    session_id: &str,
    prompt: &str,
    is_resume: bool,
    allowed_tools: &[String],
    custom_instructions: Option<&str>,
    settings: &AgentSettings,
) -> Vec<String> {
    let mut args = vec![
        "--print".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--include-partial-messages".to_string(),
    ];

    // Check if we should bypass permissions (full access with wildcard)
    let bypass_permissions = allowed_tools.len() == 1 && allowed_tools[0] == "*";

    // Model is session-level — only set on the first turn.
    if !is_resume && let Some(ref model) = settings.model {
        args.push("--model".to_string());
        args.push(model.clone());
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
    if settings.fast_mode || settings.thinking_enabled {
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
        args.push("--settings".to_string());
        args.push(serde_json::Value::Object(obj).to_string());
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

    if is_resume {
        args.push("--resume".to_string());
        args.push(session_id.to_string());
    } else {
        args.push("--session-id".to_string());
        args.push(session_id.to_string());
    }

    args.push(prompt.to_string());
    args
}

/// Run a single agent turn by spawning `claude -p` with the given prompt.
///
/// For the first turn, uses `--session-id` to establish the session.
/// For subsequent turns, uses `--resume` to continue the conversation.
///
/// `allowed_tools` pre-approves tools so they run without interactive
/// permission prompts (e.g. `["Bash", "Read", "Edit"]`).
pub async fn run_turn(
    working_dir: &Path,
    session_id: &str,
    prompt: &str,
    is_resume: bool,
    allowed_tools: &[String],
    custom_instructions: Option<&str>,
    settings: &AgentSettings,
) -> Result<TurnHandle, String> {
    let args = build_claude_args(
        session_id,
        prompt,
        is_resume,
        allowed_tools,
        custom_instructions,
        settings,
    );

    let mut cmd = Command::new("claude");
    cmd.args(&args)
        .current_dir(working_dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    // Strip OAuth tokens inherited from a parent Claude Code session — these
    // use the sk-ant-oat* prefix and are not valid for subprocess API calls.
    // Preserve real API keys (sk-ant-api*) so users who authenticate that way
    // continue to work.
    if let Ok(key) = std::env::var("ANTHROPIC_API_KEY")
        && !key.starts_with("sk-ant-api")
    {
        cmd.env_remove("ANTHROPIC_API_KEY");
    }
    cmd.env_remove("CLAUDECODE");
    cmd.env_remove("CLAUDE_CODE_ENTRYPOINT");

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn claude: {e}"))?;

    let pid = child
        .id()
        .ok_or_else(|| "Process exited immediately".to_string())?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture stderr".to_string())?;

    let (event_tx, event_rx) = mpsc::channel::<AgentEvent>(128);

    // Stdout reader task — parse stream-json events
    let tx_stdout = event_tx.clone();
    tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            match parse_stream_line(&line) {
                Ok(event) => {
                    if tx_stdout.send(AgentEvent::Stream(event)).await.is_err() {
                        break;
                    }
                }
                Err(e) => {
                    eprintln!("Failed to parse stream event: {e}\nLine: {line}");
                }
            }
        }
    });

    // Stderr reader task — log stderr lines
    tokio::spawn(async move {
        let reader = BufReader::new(stderr);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if !line.trim().is_empty() {
                eprintln!("[agent stderr] {line}");
            }
        }
    });

    // Process exit watcher — sends ProcessExited when the child terminates
    let tx_exit = event_tx;
    tokio::spawn(async move {
        let status = child.wait().await.ok().and_then(|s| s.code());
        let _ = tx_exit.send(AgentEvent::ProcessExited(status)).await;
    });

    Ok(TurnHandle { event_rx, pid })
}

/// Stop an agent process by killing it.
pub async fn stop_agent(pid: u32) -> Result<(), String> {
    let output = tokio::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .output()
        .await
        .map_err(|e| format!("Failed to kill agent: {e}"))?;

    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "kill failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ))
    }
}

// ---------------------------------------------------------------------------
// Branch name generation via Haiku
// ---------------------------------------------------------------------------

/// Sanitize a string into a valid git branch slug: lowercase ASCII
/// alphanumeric + hyphens, no leading/trailing hyphens, max `max_len` chars.
pub fn sanitize_branch_name(raw: &str, max_len: usize) -> String {
    let slug: String = raw
        .to_ascii_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();

    // Collapse consecutive hyphens.
    let mut collapsed = String::with_capacity(slug.len());
    let mut prev_hyphen = false;
    for c in slug.chars() {
        if c == '-' {
            if !prev_hyphen {
                collapsed.push(c);
            }
            prev_hyphen = true;
        } else {
            collapsed.push(c);
            prev_hyphen = false;
        }
    }

    // Trim leading/trailing hyphens, truncate.
    let trimmed = collapsed.trim_matches('-');
    if trimmed.len() <= max_len {
        return trimmed.to_string();
    }
    // Truncate at `max_len` and drop any trailing hyphens introduced by the cut.
    let truncated = &trimmed[..max_len];
    truncated.trim_end_matches('-').to_string()
}

/// Call Claude Haiku to generate a short branch name slug from the user's
/// first prompt. Returns a sanitized branch slug (e.g. `fix-login-timeout`).
/// `worktree_path` sets the subprocess CWD so the CLI picks up the correct
/// project context (CLAUDE.md) for the user's workspace — not Claudette's own.
pub async fn generate_branch_name(
    prompt_text: &str,
    worktree_path: &str,
) -> Result<String, String> {
    // Truncate prompt to keep the Haiku call fast and cheap.
    let truncated: String = prompt_text.chars().take(200).collect();

    let mut cmd = Command::new("claude");
    cmd.stdin(std::process::Stdio::null());
    // Run in the user's worktree so the CLI loads *their* project context.
    cmd.current_dir(worktree_path);
    let user_message = format!(
        "Generate a short git branch name slug for the following task. \
         Output ONLY the slug — no explanation, no markdown, no quotes. \
         Lowercase letters, numbers, and hyphens only. Max 30 chars.\n\n\
         Task: {truncated}"
    );
    cmd.args([
        "--print",
        "--output-format",
        "text",
        "--model",
        "claude-haiku-4-5",
        "--append-system-prompt",
        "You are a branch name generator. Output ONLY a slug. Never answer the task itself.",
        &user_message,
    ]);

    // Strip env vars that interfere with subprocess auth — same as run_turn.
    if let Ok(key) = std::env::var("ANTHROPIC_API_KEY")
        && !key.starts_with("sk-ant-api")
    {
        cmd.env_remove("ANTHROPIC_API_KEY");
    }
    cmd.env_remove("CLAUDECODE");
    cmd.env_remove("CLAUDE_CODE_ENTRYPOINT");

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to spawn claude for branch name: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Haiku branch name call failed: {stderr}"));
    }

    let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let slug = sanitize_branch_name(&raw, 30);
    if slug.is_empty() {
        return Err(format!(
            "Haiku returned empty or unsanitizable output: {raw:?}"
        ));
    }
    Ok(slug)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_system_init() {
        let line = r#"{"type":"system","subtype":"init","session_id":"abc-123"}"#;
        let event = parse_stream_line(line).unwrap();
        match event {
            StreamEvent::System {
                subtype,
                session_id,
            } => {
                assert_eq!(subtype, "init");
                assert_eq!(session_id.unwrap(), "abc-123");
            }
            _ => panic!("Expected System event"),
        }
    }

    #[test]
    fn test_parse_system_without_session_id() {
        let line = r#"{"type":"system","subtype":"init"}"#;
        let event = parse_stream_line(line).unwrap();
        match event {
            StreamEvent::System {
                subtype,
                session_id,
            } => {
                assert_eq!(subtype, "init");
                assert!(session_id.is_none());
            }
            _ => panic!("Expected System event"),
        }
    }

    #[test]
    fn test_parse_message_start() {
        let line = r#"{"type":"stream_event","event":{"type":"message_start"}}"#;
        let event = parse_stream_line(line).unwrap();
        match event {
            StreamEvent::Stream { event } => {
                assert!(matches!(event, InnerStreamEvent::MessageStart {}));
            }
            _ => panic!("Expected Stream event"),
        }
    }

    #[test]
    fn test_parse_message_stop() {
        let line = r#"{"type":"stream_event","event":{"type":"message_stop"}}"#;
        let event = parse_stream_line(line).unwrap();
        match event {
            StreamEvent::Stream { event } => {
                assert!(matches!(event, InnerStreamEvent::MessageStop {}));
            }
            _ => panic!("Expected Stream event"),
        }
    }

    #[test]
    fn test_parse_message_delta() {
        let line = r#"{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{}}}"#;
        let event = parse_stream_line(line).unwrap();
        match event {
            StreamEvent::Stream { event } => {
                assert!(matches!(event, InnerStreamEvent::MessageDelta {}));
            }
            _ => panic!("Expected Stream event"),
        }
    }

    #[test]
    fn test_parse_content_block_start() {
        let line = r#"{"type":"stream_event","event":{"type":"content_block_start","index":0}}"#;
        let event = parse_stream_line(line).unwrap();
        match event {
            StreamEvent::Stream { event } => match event {
                InnerStreamEvent::ContentBlockStart { index, .. } => assert_eq!(index, 0),
                _ => panic!("Expected ContentBlockStart"),
            },
            _ => panic!("Expected Stream event"),
        }
    }

    #[test]
    fn test_parse_content_block_stop() {
        let line = r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0}}"#;
        let event = parse_stream_line(line).unwrap();
        match event {
            StreamEvent::Stream { event } => match event {
                InnerStreamEvent::ContentBlockStop { index } => assert_eq!(index, 0),
                _ => panic!("Expected ContentBlockStop"),
            },
            _ => panic!("Expected Stream event"),
        }
    }

    #[test]
    fn test_parse_content_block_delta_text() {
        let line = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello world"}}}"#;
        let event = parse_stream_line(line).unwrap();
        match event {
            StreamEvent::Stream { event } => match event {
                InnerStreamEvent::ContentBlockDelta { index, delta } => {
                    assert_eq!(index, 0);
                    match delta {
                        Delta::Text { text } => assert_eq!(text, "Hello world"),
                        _ => panic!("Expected TextDelta"),
                    }
                }
                _ => panic!("Expected ContentBlockDelta"),
            },
            _ => panic!("Expected Stream event"),
        }
    }

    #[test]
    fn test_parse_content_block_delta_tool_use() {
        let line = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"tool_use_delta","partial_json":"{\"path\":"}}}"#;
        let event = parse_stream_line(line).unwrap();
        match event {
            StreamEvent::Stream { event } => match event {
                InnerStreamEvent::ContentBlockDelta { index, delta } => {
                    assert_eq!(index, 1);
                    match delta {
                        Delta::ToolUse { partial_json } => {
                            assert_eq!(partial_json.unwrap(), r#"{"path":"#);
                        }
                        _ => panic!("Expected ToolUseDelta"),
                    }
                }
                _ => panic!("Expected ContentBlockDelta"),
            },
            _ => panic!("Expected Stream event"),
        }
    }

    #[test]
    fn test_parse_assistant_message() {
        let line =
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Hello world"}]}}"#;
        let event = parse_stream_line(line).unwrap();
        match event {
            StreamEvent::Assistant { message } => {
                assert_eq!(message.content.len(), 1);
                match &message.content[0] {
                    ContentBlock::Text { text } => assert_eq!(text, "Hello world"),
                    _ => panic!("Expected Text content block"),
                }
            }
            _ => panic!("Expected Assistant event"),
        }
    }

    #[test]
    fn test_parse_assistant_message_with_tool_use() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Let me check"},{"type":"tool_use","id":"tu_01","name":"Read"}]}}"#;
        let event = parse_stream_line(line).unwrap();
        match event {
            StreamEvent::Assistant { message } => {
                assert_eq!(message.content.len(), 2);
                match &message.content[0] {
                    ContentBlock::Text { text } => assert_eq!(text, "Let me check"),
                    _ => panic!("Expected Text"),
                }
                match &message.content[1] {
                    ContentBlock::ToolUse { id, name } => {
                        assert_eq!(id, "tu_01");
                        assert_eq!(name, "Read");
                    }
                    _ => panic!("Expected ToolUse"),
                }
            }
            _ => panic!("Expected Assistant event"),
        }
    }

    #[test]
    fn test_parse_result_success() {
        let line = r#"{"type":"result","subtype":"success","result":"full text","total_cost_usd":0.003,"duration_ms":1500}"#;
        let event = parse_stream_line(line).unwrap();
        match event {
            StreamEvent::Result {
                subtype,
                result,
                total_cost_usd,
                duration_ms,
            } => {
                assert_eq!(subtype, "success");
                assert_eq!(result.unwrap(), "full text");
                assert!((total_cost_usd.unwrap() - 0.003).abs() < f64::EPSILON);
                assert_eq!(duration_ms.unwrap(), 1500);
            }
            _ => panic!("Expected Result event"),
        }
    }

    #[test]
    fn test_parse_result_without_optional_fields() {
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

    #[test]
    fn test_parse_unknown_inner_event_type() {
        let line =
            r#"{"type":"stream_event","event":{"type":"some_future_event_type","data":123}}"#;
        let event = parse_stream_line(line).unwrap();
        match event {
            StreamEvent::Stream { event } => {
                assert!(matches!(event, InnerStreamEvent::Unknown));
            }
            _ => panic!("Expected Stream event"),
        }
    }

    #[test]
    fn test_parse_input_json_delta() {
        let line = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}}"#;
        let event = parse_stream_line(line).unwrap();
        match event {
            StreamEvent::Stream { event } => match event {
                InnerStreamEvent::ContentBlockDelta { delta, .. } => {
                    assert!(matches!(
                        delta,
                        Delta::InputJson {
                            partial_json: Some(_)
                        }
                    ));
                }
                _ => panic!("Expected ContentBlockDelta"),
            },
            _ => panic!("Expected Stream event"),
        }
    }

    #[test]
    fn test_parse_unknown_delta_type() {
        let line = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"some_future_delta","data":123}}}"#;
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

    #[test]
    fn test_parse_unknown_content_block_type() {
        let line = r#"{"type":"assistant","message":{"content":[{"type":"some_new_block"}]}}"#;
        let event = parse_stream_line(line).unwrap();
        match event {
            StreamEvent::Assistant { message } => {
                assert_eq!(message.content.len(), 1);
                assert!(matches!(message.content[0], ContentBlock::Unknown));
            }
            _ => panic!("Expected Assistant event"),
        }
    }

    #[test]
    fn test_parse_invalid_json_returns_error() {
        let result = parse_stream_line("not json at all");
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_user_event_with_tool_result() {
        let line = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_01","content":"ok"}]}}"#;
        let event = parse_stream_line(line).unwrap();
        match event {
            StreamEvent::User { message } => {
                assert_eq!(message.content.len(), 1);
                match &message.content[0] {
                    UserContentBlock::ToolResult {
                        tool_use_id,
                        content,
                    } => {
                        assert_eq!(tool_use_id, "tu_01");
                        assert_eq!(content.as_str().unwrap(), "ok");
                    }
                    _ => panic!("Expected ToolResult"),
                }
            }
            _ => panic!("Expected User event"),
        }
    }

    #[test]
    fn test_parse_extra_fields_ignored() {
        let line = r#"{"type":"system","subtype":"init","session_id":"abc","extra_field":"ignored","another":42}"#;
        let event = parse_stream_line(line).unwrap();
        match event {
            StreamEvent::System { subtype, .. } => {
                assert_eq!(subtype, "init");
            }
            _ => panic!("Expected System event"),
        }
    }

    #[test]
    fn test_build_args_first_turn_no_tools() {
        let args = build_claude_args(
            "sess-1",
            "hello",
            false,
            &[],
            None,
            &AgentSettings::default(),
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
        let args = build_claude_args("sess-1", "hello", false, &[], None, &settings);
        let idx = args.iter().position(|a| a == "--model").unwrap();
        assert_eq!(args[idx + 1], "opus");
    }

    #[test]
    fn test_build_args_model_skipped_on_resume() {
        let settings = AgentSettings {
            model: Some("opus".to_string()),
            ..Default::default()
        };
        let args = build_claude_args("sess-1", "hello", true, &[], None, &settings);
        assert!(!args.contains(&"--model".to_string()));
    }

    #[test]
    fn test_build_args_plan_mode() {
        let settings = AgentSettings {
            plan_mode: true,
            ..Default::default()
        };
        let args = build_claude_args("sess-1", "hello", false, &[], None, &settings);
        let idx = args.iter().position(|a| a == "--permission-mode").unwrap();
        assert_eq!(args[idx + 1], "plan");
    }

    #[test]
    fn test_build_args_plan_mode_set_on_resume() {
        let settings = AgentSettings {
            plan_mode: true,
            ..Default::default()
        };
        let args = build_claude_args("sess-1", "hello", true, &[], None, &settings);
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
        let args = build_claude_args("sess-1", "hello", false, &[], None, &settings);
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
        let args = build_claude_args("sess-1", "hello", false, &[], None, &settings);
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
        let args = build_claude_args("sess-1", "hello", true, &[], None, &settings);
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
        let args = build_claude_args("sess-1", "hello", false, &tools, None, &settings);
        // Plan mode takes precedence over bypass
        let pm_idx = args.iter().position(|a| a == "--permission-mode").unwrap();
        assert_eq!(args[pm_idx + 1], "plan");
        // Even with plan_mode, bypass tools should NOT pass --allowedTools
        assert!(!args.contains(&"--allowedTools".to_string()));
    }

    // --- Branch name sanitization tests ---

    #[test]
    fn test_sanitize_simple_slug() {
        assert_eq!(sanitize_branch_name("fix-login-bug", 40), "fix-login-bug");
    }

    #[test]
    fn test_sanitize_uppercase_and_spaces() {
        assert_eq!(
            sanitize_branch_name("Fix Login Timeout", 40),
            "fix-login-timeout"
        );
    }

    #[test]
    fn test_sanitize_special_characters() {
        assert_eq!(
            sanitize_branch_name("add CSV export!!", 40),
            "add-csv-export"
        );
    }

    #[test]
    fn test_sanitize_consecutive_hyphens() {
        assert_eq!(
            sanitize_branch_name("fix---multiple---hyphens", 40),
            "fix-multiple-hyphens"
        );
    }

    #[test]
    fn test_sanitize_leading_trailing_hyphens() {
        assert_eq!(
            sanitize_branch_name("--leading-and-trailing--", 40),
            "leading-and-trailing"
        );
    }

    #[test]
    fn test_sanitize_truncation() {
        let long_input = "this-is-a-very-long-branch-name-that-exceeds-the-limit";
        let result = sanitize_branch_name(long_input, 20);
        assert!(result.len() <= 20);
        assert!(!result.ends_with('-'));
    }

    #[test]
    fn test_sanitize_empty_input() {
        assert_eq!(sanitize_branch_name("", 40), "");
    }

    #[test]
    fn test_sanitize_all_special_chars() {
        assert_eq!(sanitize_branch_name("!@#$%", 40), "");
    }

    #[test]
    fn test_sanitize_preserves_numbers() {
        assert_eq!(sanitize_branch_name("fix-issue-42", 40), "fix-issue-42");
    }
}
