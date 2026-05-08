use serde::{Deserialize, Serialize};

/// Token accounting reported by the CLI on `message_delta` (per-message
/// cumulative) and `result` (turn total) events. Matches the shape of
/// Anthropic's `usage` block; cache fields are independently optional to
/// tolerate CLI responses that omit them.
///
/// On `result` events the top-level fields are AGGREGATED across internal
/// tool-use iterations. For the final iteration's per-call usage (what the
/// ContextMeter needs to reflect actual end-of-turn context size), use
/// `iterations[0]` — the CLI emits a single-entry array with the final
/// iteration's own usage block.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct TokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_creation_input_tokens: Option<u64>,
    #[serde(default)]
    pub cache_read_input_tokens: Option<u64>,
    // `skip_serializing_if` keeps absent iterations out of the re-emitted
    // Tauri payload entirely — important because `TokenUsage` rides every
    // `message_delta` event (many per turn) where `iterations` is never
    // present, and we don't want to emit `"iterations": null` on each one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iterations: Option<Vec<TokenUsageIteration>>,
}

/// Per-iteration usage snapshot, emitted by the CLI inside `result.usage`.
/// Same shape as `TokenUsage`'s aggregate fields — but values are scoped
/// to one internal API call instead of summed across all iterations.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct TokenUsageIteration {
    pub input_tokens: u64,
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_creation_input_tokens: Option<u64>,
    #[serde(default)]
    pub cache_read_input_tokens: Option<u64>,
}

/// Payload the CLI emits on `subtype: "compact_boundary"` after context
/// compaction completes. Shape verified against captured stream-json
/// in a live session. `trigger` is a `String` (not enum) so unexpected
/// future values don't crash parsing.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct CompactMetadata {
    pub trigger: String,
    pub pre_tokens: u64,
    pub post_tokens: u64,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct TaskUsage {
    #[serde(default)]
    pub total_tokens: Option<u64>,
    #[serde(default)]
    pub tool_uses: Option<u64>,
    #[serde(default)]
    pub duration_ms: Option<u64>,
}

/// Top-level JSON line from Claude CLI stdout.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(clippy::large_enum_variant)]
#[serde(tag = "type")]
// Variants are constructed one at a time from streaming JSON; we never
// hold them in collections, so the size delta between variants doesn't
// matter in practice. Boxing the larger payloads would force a deref
// at every pattern-match callsite.
#[allow(clippy::large_enum_variant)]
pub enum StreamEvent {
    #[serde(rename = "system")]
    System {
        subtype: String,
        #[serde(default)]
        session_id: Option<String>,
        /// Present on `subtype: "bridge_state"` events emitted by Claude Code
        /// Remote Control.
        #[serde(default)]
        state: Option<String>,
        /// Optional detail text on `bridge_state` and related lifecycle
        /// events.
        #[serde(default)]
        detail: Option<String>,
        /// Present on `subtype: "task_notification"` events emitted when a
        /// background task completes or fails.
        #[serde(default)]
        task_id: Option<String>,
        /// Present on `subtype: "task_notification"` events when the
        /// notification can be tied back to the originating tool use.
        #[serde(default)]
        tool_use_id: Option<String>,
        /// Present on `subtype: "task_notification"` events.
        #[serde(default)]
        output_file: Option<String>,
        /// Present on `subtype: "task_notification"` events.
        #[serde(default)]
        summary: Option<String>,
        /// Present on `task_started` / `task_progress` events emitted by
        /// Claude Code for subagent progress.
        #[serde(default)]
        description: Option<String>,
        /// Present on `task_progress` with the most recent subagent tool name.
        #[serde(default)]
        last_tool_name: Option<String>,
        /// Present on `task_progress` / `task_notification`.
        #[serde(default)]
        usage: Option<TaskUsage>,
        /// Only present on `subtype: "status"` events. Values observed:
        /// `"requesting"` (normal API call), `"compacting"` (compaction in
        /// flight), or `null` (compaction complete).
        #[serde(default)]
        status: Option<String>,
        /// Only present on the end-of-compaction `status` event. Value
        /// observed: `"success"`.
        #[serde(default)]
        compact_result: Option<String>,
        /// Only present on `subtype: "compact_boundary"` events.
        #[serde(default)]
        compact_metadata: Option<CompactMetadata>,
        /// Present on `subtype: "command_line"` events emitted at session
        /// start by the agent runner. Contains the shell-quoted, redacted
        /// `claude ...` command line for display in the chat tab. See
        /// `crate::agent::args::format_redacted_invocation`.
        #[serde(default)]
        command_line: Option<String>,
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
        #[serde(default)]
        usage: Option<TokenUsage>,
    },

    #[serde(rename = "user")]
    User {
        message: UserEventMessage,
        /// Set by the CLI when the message was autogenerated (e.g. the
        /// post-compaction continuation summary) rather than typed by the
        /// user. Note camelCase — the CLI is inconsistent about casing
        /// for this one field.
        #[serde(default, rename = "isSynthetic")]
        is_synthetic: bool,
    },

    /// A permission-prompt control request sent by the CLI when
    /// `--permission-prompt-tool stdio` is active. Each `can_use_tool` request
    /// must be answered with a `control_response` keyed by `request_id` —
    /// see [`super::PersistentSession::send_control_response`].
    #[serde(rename = "control_request")]
    ControlRequest {
        request_id: String,
        request: ControlRequestInner,
    },

    /// Response to a host-originated `control_request` sent to the Claude CLI
    /// over stream-json stdin. Remote Control enable/disable returns its
    /// session URLs here.
    #[serde(rename = "control_response")]
    ControlResponse { response: ControlResponsePayload },

    #[serde(other)]
    Unknown,
}

impl StreamEvent {
    /// Construct a `command_line` System event carrying the redacted
    /// invocation string. Centralizes the 13-field initialization so call
    /// sites in `process.rs` and `session.rs` don't duplicate it.
    pub fn system_command_line(line: String) -> Self {
        Self::System {
            subtype: "command_line".to_string(),
            session_id: None,
            state: None,
            detail: None,
            task_id: None,
            tool_use_id: None,
            output_file: None,
            summary: None,
            description: None,
            last_tool_name: None,
            usage: None,
            status: None,
            compact_result: None,
            compact_metadata: None,
            command_line: Some(line),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ControlResponsePayload {
    pub subtype: String,
    pub request_id: String,
    #[serde(default)]
    pub response: Option<serde_json::Value>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
}

/// Inner payload of a `control_request`. We only care about `can_use_tool` for
/// permission-prompt routing; other subtypes are captured as [`ControlRequestInner::Unknown`]
/// and forwarded to the frontend for observability.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "subtype")]
pub enum ControlRequestInner {
    #[serde(rename = "can_use_tool")]
    CanUseTool {
        tool_name: String,
        tool_use_id: String,
        #[serde(default)]
        input: serde_json::Value,
    },

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
    MessageDelta {
        #[serde(default)]
        usage: Option<TokenUsage>,
    },

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

    #[serde(rename = "thinking_delta")]
    Thinking { thinking: String },

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

    #[serde(rename = "thinking")]
    Thinking {},

    #[serde(other)]
    Unknown,
}

/// Message payload from `user` type events (tool results, local command
/// stdout, synthetic continuations after compaction). `content` can be
/// either a structured array of blocks (tool_result) or a plain string
/// (local-command-stdout, synthetic summary).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserEventMessage {
    #[serde(default)]
    pub content: UserMessageContent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum UserMessageContent {
    Blocks(Vec<UserContentBlock>),
    Text(String),
}

impl Default for UserMessageContent {
    fn default() -> Self {
        Self::Blocks(Vec::new())
    }
}

/// Content block within a `user` event message.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum UserContentBlock {
    #[serde(rename = "text")]
    Text {
        #[serde(default)]
        text: String,
    },

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

    #[serde(rename = "thinking")]
    Thinking { thinking: String },

    #[serde(rename = "tool_use")]
    ToolUse { id: String, name: String },

    #[serde(other)]
    Unknown,
}

/// An attachment to send alongside the prompt via stream-json stdin.
///
/// Images use `"type": "image"` content blocks; PDFs use `"type": "document"`;
/// text files (when [`text_content`] is `Some`) use `"type": "text"`.
/// The block type is determined in [`super::build_stdin_message`].
#[derive(Debug, Clone)]
pub struct FileAttachment {
    pub media_type: String,
    pub data_base64: String,
    pub text_content: Option<String>,
    pub filename: Option<String>,
}

/// Parse a single JSON line from the Claude CLI stdout stream.
pub fn parse_stream_line(line: &str) -> Result<StreamEvent, serde_json::Error> {
    serde_json::from_str(line)
}

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
                ..
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
                ..
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
        let line = r#"{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":0,"output_tokens":0}}}"#;
        let event = parse_stream_line(line).unwrap();
        match event {
            StreamEvent::Stream { event } => {
                assert!(matches!(event, InnerStreamEvent::MessageDelta { .. }));
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
    fn test_parse_content_block_start_thinking() {
        let line = r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}}"#;
        let event = parse_stream_line(line).unwrap();
        match event {
            StreamEvent::Stream { event } => match event {
                InnerStreamEvent::ContentBlockStart {
                    index,
                    content_block,
                } => {
                    assert_eq!(index, 0);
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

    #[test]
    fn test_parse_content_block_delta_thinking() {
        let line = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me analyze this..."}}}"#;
        let event = parse_stream_line(line).unwrap();
        match event {
            StreamEvent::Stream { event } => match event {
                InnerStreamEvent::ContentBlockDelta { index, delta } => {
                    assert_eq!(index, 0);
                    match delta {
                        Delta::Thinking { thinking } => {
                            assert_eq!(thinking, "Let me analyze this...")
                        }
                        _ => panic!("Expected ThinkingDelta"),
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
                ..
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
                ..
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
            StreamEvent::User { message, .. } => {
                let blocks = match &message.content {
                    UserMessageContent::Blocks(b) => b,
                    UserMessageContent::Text(_) => panic!("expected Blocks"),
                };
                assert_eq!(blocks.len(), 1);
                match &blocks[0] {
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
    fn parse_control_request_can_use_tool() {
        let line = r#"{"type":"control_request","request_id":"req-1","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","tool_use_id":"toolu_xyz","input":{"questions":[{"question":"Go?","options":[{"label":"yes"},{"label":"no"}]}]}}}"#;
        let ev = parse_stream_line(line).expect("parse");
        match ev {
            StreamEvent::ControlRequest {
                request_id,
                request,
            } => {
                assert_eq!(request_id, "req-1");
                match request {
                    ControlRequestInner::CanUseTool {
                        tool_name,
                        tool_use_id,
                        input,
                    } => {
                        assert_eq!(tool_name, "AskUserQuestion");
                        assert_eq!(tool_use_id, "toolu_xyz");
                        assert!(input.is_object());
                    }
                    _ => panic!("expected CanUseTool"),
                }
            }
            other => panic!("expected ControlRequest, got {other:?}"),
        }
    }

    #[test]
    fn parse_control_request_unknown_subtype_is_nonfatal() {
        let line =
            r#"{"type":"control_request","request_id":"req-2","request":{"subtype":"mcp_status"}}"#;
        let ev = parse_stream_line(line).expect("parse");
        match ev {
            StreamEvent::ControlRequest { request, .. } => {
                assert!(matches!(request, ControlRequestInner::Unknown));
            }
            other => panic!("expected ControlRequest, got {other:?}"),
        }
    }

    #[test]
    fn parse_control_response_success() {
        let line = r#"{"type":"control_response","response":{"subtype":"success","request_id":"req-3","response":{"session_url":"https://claude.ai/session/abc","connect_url":"https://claude.ai/connect/abc","environment_id":"env_123"}}}"#;
        let ev = parse_stream_line(line).expect("parse");
        match ev {
            StreamEvent::ControlResponse { response } => {
                assert_eq!(response.subtype, "success");
                assert_eq!(response.request_id, "req-3");
                assert_eq!(
                    response
                        .response
                        .as_ref()
                        .and_then(|v| v.get("environment_id"))
                        .and_then(serde_json::Value::as_str),
                    Some("env_123")
                );
            }
            other => panic!("expected ControlResponse, got {other:?}"),
        }
    }

    #[test]
    fn parse_control_response_error() {
        let line = r#"{"type":"control_response","response":{"subtype":"error","request_id":"req-4","error":"Run claude auth login"}}"#;
        let ev = parse_stream_line(line).expect("parse");
        match ev {
            StreamEvent::ControlResponse { response } => {
                assert_eq!(response.subtype, "error");
                assert_eq!(response.request_id, "req-4");
                assert_eq!(response.error.as_deref(), Some("Run claude auth login"));
            }
            other => panic!("expected ControlResponse, got {other:?}"),
        }
    }

    #[test]
    fn parse_bridge_state_system_event() {
        let line =
            r#"{"type":"system","subtype":"bridge_state","state":"connected","detail":"ready"}"#;
        let ev = parse_stream_line(line).expect("parse");
        match ev {
            StreamEvent::System {
                subtype,
                state,
                detail,
                ..
            } => {
                assert_eq!(subtype, "bridge_state");
                assert_eq!(state.as_deref(), Some("connected"));
                assert_eq!(detail.as_deref(), Some("ready"));
            }
            other => panic!("expected System, got {other:?}"),
        }
    }
}

#[cfg(test)]
mod token_usage_tests {
    use super::*;

    #[test]
    fn deserializes_result_with_full_usage() {
        let line = r#"{
            "type": "result",
            "subtype": "success",
            "total_cost_usd": 0.12,
            "duration_ms": 4321,
            "usage": {
                "input_tokens": 1200,
                "output_tokens": 340,
                "cache_creation_input_tokens": 500,
                "cache_read_input_tokens": 10000
            }
        }"#;
        let ev: StreamEvent = serde_json::from_str(line).unwrap();
        match ev {
            StreamEvent::Result { usage: Some(u), .. } => {
                assert_eq!(u.input_tokens, 1200);
                assert_eq!(u.output_tokens, 340);
                assert_eq!(u.cache_creation_input_tokens, Some(500));
                assert_eq!(u.cache_read_input_tokens, Some(10000));
            }
            other => panic!("expected Result with usage, got {other:?}"),
        }
    }

    #[test]
    fn deserializes_result_without_usage_or_cache() {
        let line = r#"{
            "type": "result",
            "subtype": "success",
            "total_cost_usd": 0.01,
            "duration_ms": 100
        }"#;
        let ev: StreamEvent = serde_json::from_str(line).unwrap();
        match ev {
            StreamEvent::Result { usage, .. } => assert!(usage.is_none()),
            other => panic!("expected Result, got {other:?}"),
        }
    }

    #[test]
    fn deserializes_result_with_minimal_usage() {
        let line = r#"{
            "type": "result",
            "subtype": "success",
            "usage": { "input_tokens": 10, "output_tokens": 20 }
        }"#;
        let ev: StreamEvent = serde_json::from_str(line).unwrap();
        match ev {
            StreamEvent::Result { usage: Some(u), .. } => {
                assert_eq!(u.input_tokens, 10);
                assert_eq!(u.output_tokens, 20);
                assert_eq!(u.cache_creation_input_tokens, None);
                assert_eq!(u.cache_read_input_tokens, None);
            }
            other => panic!("expected Result with usage, got {other:?}"),
        }
    }

    #[test]
    fn deserializes_message_delta_with_usage() {
        let line = r#"{
            "type": "stream_event",
            "event": {
                "type": "message_delta",
                "usage": { "input_tokens": 5, "output_tokens": 7 }
            }
        }"#;
        let ev: StreamEvent = serde_json::from_str(line).unwrap();
        match ev {
            StreamEvent::Stream {
                event: InnerStreamEvent::MessageDelta { usage: Some(u) },
            } => {
                assert_eq!(u.input_tokens, 5);
                assert_eq!(u.output_tokens, 7);
            }
            other => panic!("expected Stream(MessageDelta) with usage, got {other:?}"),
        }
    }

    #[test]
    fn deserializes_message_delta_without_usage() {
        let line = r#"{"type":"stream_event","event":{"type":"message_delta"}}"#;
        let ev: StreamEvent = serde_json::from_str(line).unwrap();
        match ev {
            StreamEvent::Stream {
                event: InnerStreamEvent::MessageDelta { usage: None },
            } => {}
            other => panic!("expected Stream(MessageDelta) no usage, got {other:?}"),
        }
    }

    #[test]
    fn deserializes_result_iterations() {
        let line = r#"{
            "type": "result",
            "subtype": "success",
            "usage": {
                "input_tokens": 100,
                "output_tokens": 200,
                "cache_read_input_tokens": 9999,
                "cache_creation_input_tokens": 55,
                "iterations": [
                    {
                        "input_tokens": 1,
                        "output_tokens": 611,
                        "cache_read_input_tokens": 131890,
                        "cache_creation_input_tokens": 573
                    }
                ]
            }
        }"#;
        let ev: StreamEvent = serde_json::from_str(line).unwrap();
        match ev {
            StreamEvent::Result { usage: Some(u), .. } => {
                let iters = u.iterations.expect("iterations should parse");
                assert_eq!(iters.len(), 1);
                assert_eq!(iters[0].input_tokens, 1);
                assert_eq!(iters[0].output_tokens, 611);
                assert_eq!(iters[0].cache_read_input_tokens, Some(131_890));
                assert_eq!(iters[0].cache_creation_input_tokens, Some(573));
            }
            other => panic!("expected Result with iterations, got {other:?}"),
        }
    }

    #[test]
    fn deserializes_result_without_iterations() {
        let line = r#"{
            "type": "result",
            "subtype": "success",
            "usage": { "input_tokens": 10, "output_tokens": 20 }
        }"#;
        let ev: StreamEvent = serde_json::from_str(line).unwrap();
        match ev {
            StreamEvent::Result { usage: Some(u), .. } => {
                assert!(u.iterations.is_none());
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }

    #[test]
    fn round_trip_preserves_iterations() {
        let line = r#"{"type":"result","subtype":"success","usage":{"input_tokens":1,"output_tokens":2,"iterations":[{"input_tokens":3,"output_tokens":4}]}}"#;
        let ev: StreamEvent = serde_json::from_str(line).unwrap();
        let re_encoded = serde_json::to_string(&ev).unwrap();
        assert!(
            re_encoded.contains("\"iterations\""),
            "iterations dropped during round trip: {re_encoded}"
        );
        assert!(
            re_encoded.contains("\"input_tokens\":3"),
            "iteration[0].input_tokens dropped: {re_encoded}"
        );
    }

    #[test]
    fn absent_iterations_are_omitted_not_nulled() {
        let line = r#"{"type":"stream_event","event":{"type":"message_delta","usage":{"input_tokens":5,"output_tokens":7}}}"#;
        let ev: StreamEvent = serde_json::from_str(line).unwrap();
        let re_encoded = serde_json::to_string(&ev).unwrap();
        assert!(
            !re_encoded.contains("\"iterations\""),
            "iterations key should be omitted when absent: {re_encoded}"
        );
    }
}

#[cfg(test)]
mod compaction_tests {
    use super::*;

    #[test]
    fn deserializes_compact_boundary_with_metadata() {
        let line = r#"{
            "type": "system",
            "subtype": "compact_boundary",
            "session_id": "sess-abc",
            "compact_metadata": {
                "trigger": "manual",
                "pre_tokens": 174144,
                "post_tokens": 8782,
                "duration_ms": 94167
            }
        }"#;
        let ev: StreamEvent = serde_json::from_str(line).unwrap();
        match ev {
            StreamEvent::System {
                subtype,
                compact_metadata: Some(meta),
                ..
            } => {
                assert_eq!(subtype, "compact_boundary");
                assert_eq!(meta.trigger, "manual");
                assert_eq!(meta.pre_tokens, 174144);
                assert_eq!(meta.post_tokens, 8782);
                assert_eq!(meta.duration_ms, 94167);
            }
            other => panic!("expected System(compact_boundary) with metadata, got {other:?}"),
        }
    }

    #[test]
    fn deserializes_status_compacting() {
        let line = r#"{
            "type": "system",
            "subtype": "status",
            "status": "compacting",
            "session_id": "sess-abc"
        }"#;
        let ev: StreamEvent = serde_json::from_str(line).unwrap();
        match ev {
            StreamEvent::System {
                subtype,
                status: Some(s),
                ..
            } => {
                assert_eq!(subtype, "status");
                assert_eq!(s, "compacting");
            }
            other => panic!("expected System(status:compacting), got {other:?}"),
        }
    }

    #[test]
    fn deserializes_task_notification_system_event() {
        let line = r#"{
            "type": "system",
            "subtype": "task_notification",
            "task_id": "task_123",
            "tool_use_id": "toolu_1",
            "status": "completed",
            "output_file": "/tmp/task_123.output",
            "summary": "Background command completed",
            "session_id": "sess-abc"
        }"#;
        let ev: StreamEvent = serde_json::from_str(line).unwrap();
        match ev {
            StreamEvent::System {
                subtype,
                task_id,
                tool_use_id,
                status,
                output_file,
                summary,
                ..
            } => {
                assert_eq!(subtype, "task_notification");
                assert_eq!(task_id.as_deref(), Some("task_123"));
                assert_eq!(tool_use_id.as_deref(), Some("toolu_1"));
                assert_eq!(status.as_deref(), Some("completed"));
                assert_eq!(output_file.as_deref(), Some("/tmp/task_123.output"));
                assert_eq!(summary.as_deref(), Some("Background command completed"));
            }
            other => panic!("expected System(task_notification), got {other:?}"),
        }
    }

    #[test]
    fn deserializes_status_null_with_compact_result() {
        let line = r#"{
            "type": "system",
            "subtype": "status",
            "status": null,
            "compact_result": "success",
            "session_id": "sess-abc"
        }"#;
        let ev: StreamEvent = serde_json::from_str(line).unwrap();
        match ev {
            StreamEvent::System {
                subtype,
                status,
                compact_result: Some(r),
                ..
            } => {
                assert_eq!(subtype, "status");
                assert!(status.is_none());
                assert_eq!(r, "success");
            }
            other => panic!("expected System(status:null + compact_result), got {other:?}"),
        }
    }

    #[test]
    fn deserializes_system_init_without_new_fields() {
        let line = r#"{"type":"system","subtype":"init","session_id":"sess-abc"}"#;
        let ev: StreamEvent = serde_json::from_str(line).unwrap();
        match ev {
            StreamEvent::System {
                subtype,
                status,
                compact_result,
                compact_metadata,
                ..
            } => {
                assert_eq!(subtype, "init");
                assert!(status.is_none());
                assert!(compact_result.is_none());
                assert!(compact_metadata.is_none());
            }
            other => panic!("expected System(init), got {other:?}"),
        }
    }

    #[test]
    fn compact_boundary_round_trip() {
        let line = r#"{"type":"system","subtype":"compact_boundary","compact_metadata":{"trigger":"auto","pre_tokens":1,"post_tokens":2,"duration_ms":3}}"#;
        let ev: StreamEvent = serde_json::from_str(line).unwrap();
        let re = serde_json::to_string(&ev).unwrap();
        assert!(
            re.contains("\"compact_metadata\""),
            "compact_metadata dropped: {re}"
        );
        assert!(re.contains("\"trigger\":\"auto\""), "trigger dropped: {re}");
        assert!(re.contains("\"pre_tokens\":1"), "pre_tokens dropped: {re}");
    }

    #[test]
    fn deserializes_user_event_with_blocks_content() {
        let line = r#"{
            "type": "user",
            "message": {
                "role": "user",
                "content": [
                    {"type":"tool_result","tool_use_id":"toolu_1","content":[]}
                ]
            }
        }"#;
        let ev: StreamEvent = serde_json::from_str(line).unwrap();
        match ev {
            StreamEvent::User {
                message,
                is_synthetic,
            } => {
                match message.content {
                    UserMessageContent::Blocks(ref blocks) => {
                        assert_eq!(blocks.len(), 1);
                    }
                    UserMessageContent::Text(_) => panic!("expected Blocks"),
                }
                assert!(!is_synthetic);
            }
            other => panic!("expected User event, got {other:?}"),
        }
    }

    #[test]
    fn deserializes_user_event_with_string_content() {
        let line = r#"{
            "type": "user",
            "message": {
                "role": "user",
                "content": "<local-command-stdout>Compacted </local-command-stdout>"
            }
        }"#;
        let ev: StreamEvent = serde_json::from_str(line).unwrap();
        match ev {
            StreamEvent::User { message, .. } => match message.content {
                UserMessageContent::Text(t) => {
                    assert!(t.contains("Compacted"));
                }
                UserMessageContent::Blocks(_) => panic!("expected Text"),
            },
            other => panic!("expected User event, got {other:?}"),
        }
    }

    #[test]
    fn deserializes_synthetic_user_event() {
        let line = r#"{
            "type": "user",
            "message": {"role":"user","content":"Summary text here"},
            "isSynthetic": true
        }"#;
        let ev: StreamEvent = serde_json::from_str(line).unwrap();
        match ev {
            StreamEvent::User {
                message,
                is_synthetic,
            } => {
                assert!(is_synthetic);
                match message.content {
                    UserMessageContent::Text(t) => {
                        assert_eq!(t, "Summary text here");
                    }
                    UserMessageContent::Blocks(_) => panic!("expected Text"),
                }
            }
            other => panic!("expected User event, got {other:?}"),
        }
    }
}
