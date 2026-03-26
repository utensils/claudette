#![allow(dead_code)]

use std::path::Path;

use serde::Deserialize;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;

// ---------------------------------------------------------------------------
// Stream event types — maps to Claude CLI `--output-format stream-json`
// ---------------------------------------------------------------------------

/// Top-level JSON line from Claude CLI stdout.
#[derive(Debug, Clone, Deserialize)]
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

#[derive(Debug, Clone, Deserialize)]
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

#[derive(Debug, Clone, Deserialize)]
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
#[derive(Debug, Clone, Deserialize)]
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
#[derive(Debug, Clone, Deserialize)]
pub struct UserEventMessage {
    #[serde(default)]
    pub content: Vec<UserContentBlock>,
}

/// Content block within a `user` event message.
#[derive(Debug, Clone, Deserialize)]
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

#[derive(Debug, Clone, Deserialize)]
pub struct AssistantMessage {
    pub content: Vec<ContentBlock>,
}

#[derive(Debug, Clone, Deserialize)]
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
#[derive(Debug, Clone)]
pub enum AgentEvent {
    /// A parsed stream event from stdout.
    Stream(StreamEvent),
    /// The agent process has exited.
    ProcessExited(Option<i32>),
}

// ---------------------------------------------------------------------------
// Per-turn agent process
// ---------------------------------------------------------------------------

/// Handle for an active agent turn — holds the event receiver and process ID.
pub struct TurnHandle {
    pub event_rx: mpsc::Receiver<AgentEvent>,
    pub pid: u32,
}

/// Run a single agent turn by spawning `claude -p` with the given prompt.
///
/// For the first turn, uses `--session-id` to establish the session.
/// For subsequent turns, uses `--resume` to continue the conversation.
pub async fn run_turn(
    working_dir: &Path,
    session_id: &str,
    prompt: &str,
    is_resume: bool,
) -> Result<TurnHandle, String> {
    let mut args = vec![
        "--print".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--include-partial-messages".to_string(),
    ];

    if is_resume {
        args.push("--resume".to_string());
        args.push(session_id.to_string());
    } else {
        args.push("--session-id".to_string());
        args.push(session_id.to_string());
    }

    // Prompt as positional argument
    args.push(prompt.to_string());

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
}
