# Claude Agent SDK — Rust Implementation Specification

This document specifies a Rust-native agent SDK for Claudette, derived from analysis of the
TypeScript `@anthropic-ai/claude-agent-sdk` (v2.1.85). The goal is an open-source implementation
that communicates with the Claude Code CLI subprocess over stdio using the same JSON protocol.

## Architecture Overview

The TypeScript SDK works by:

1. Spawning the `claude` CLI as a child process (Node/Bun/Deno)
2. Communicating via **stdin** (user messages, outbound control requests) and **stdout** (SDK messages, inbound control requests for permissions, control responses)
3. The CLI handles all Anthropic API interaction, tool execution, and session persistence internally
4. The SDK consumer iterates an async stream of `SDKMessage` events

**We do the same in Rust**: spawn `claude` as a `tokio::process::Command`, pipe stdin/stdout,
parse the JSON protocol, and surface events to the Iced UI.

## Process Lifecycle

The current implementation spawns a **new `claude` process per turn** using `--session-id`
(first turn) or `--resume` (subsequent turns). The CLI persists session state to JSONL files
in `~/.claude/projects/`, so each invocation picks up where the last left off.

The `AgentSession` struct (below) wraps a **single turn's process**. When the process exits
(the result message arrives), the session is done. To continue the conversation, `send()` spawns
a fresh process with `--resume`. This matches the current `agent::run_turn()` pattern.

Future optimization: a single long-lived process with stdin streaming for multi-turn, avoiding
per-turn process startup overhead. The spec's `AgentSession` API is designed to support either
model without changing the caller.

### Process Spawning

```
claude --print \
  --output-format stream-json \
  --verbose \
  --include-partial-messages \
  [--session-id <uuid>]          # first turn
  [--resume <session-id>]        # subsequent turns
  [--allowedTools "Read,Edit,Bash,..."]
  [--permission-mode default|acceptEdits|plan|dontAsk|bypassPermissions]
  "<prompt>"
```

### Environment Cleanup

Strip inherited Claude Code env vars to avoid auth conflicts:

```rust
cmd.env_remove("ANTHROPIC_API_KEY"); // only if not sk-ant-api* prefix
cmd.env_remove("CLAUDECODE");
cmd.env_remove("CLAUDE_CODE_ENTRYPOINT");
```

## Message Protocol

All messages are newline-delimited JSON on stdout. Each has a `type` field as discriminant.

The protocol is actively evolving. Implementations **must** handle unknown message types
gracefully (see `Unknown` variant below) to avoid crashes when the CLI introduces new types.

### SDKMessage (stdout → Claudette)

A union of message types. The `type` field determines which variant:

| type | subtype | Rust Enum Variant | Description |
|------|---------|-------------------|-------------|
| `system` | `init` | `Init` | Session initialized — lists tools, model, mcp servers, permission mode |
| `system` | `status` | `Status` | Status change (e.g. `compacting`) |
| `system` | `api_retry` | `ApiRetry` | Retryable API error, will retry after delay |
| `system` | `compact_boundary` | `CompactBoundary` | Context window compaction occurred |
| `system` | `session_state_changed` | `SessionStateChanged` | State: `idle`, `running`, `requires_action` |
| `assistant` | — | `AssistantMessage` | Complete assistant response with `BetaMessage` content blocks |
| `stream_event` | — | `PartialAssistant` | Streaming delta (text chunks, tool_use blocks) |
| `user` | — | `UserMessage` | Echo of user message |
| `user_message_replay` | — | `UserMessageReplay` | Replayed user message from resumed session |
| `result` | `success` | `ResultSuccess` | Turn complete — cost, usage, num_turns |
| `result` | `error_*` | `ResultError` | Turn failed — error type, cost, usage |
| `tool_use_summary` | — | `ToolUseSummary` | Summary of a tool execution |
| `tool_progress` | — | `ToolProgress` | Progress update during long tool execution |
| `hook_started` | — | `HookStarted` | Hook execution started |
| `hook_progress` | — | `HookProgress` | Hook execution progress |
| `hook_response` | — | `HookResponse` | Hook execution result |
| `task_notification` | — | `TaskNotification` | Background task status change |
| `task_started` | — | `TaskStarted` | Background task started |
| `task_progress` | — | `TaskProgress` | Background task progress |
| `auth_status` | — | `AuthStatus` | Authentication status change |
| `local_command_output` | — | `LocalCommandOutput` | Output from slash command |
| `rate_limit_event` | — | `RateLimitEvent` | Rate limit info for subscription users |
| `files_persisted` | — | `FilesPersisted` | Files saved to disk |
| `elicitation_complete` | — | `ElicitationComplete` | MCP elicitation finished |
| `prompt_suggestion` | — | `PromptSuggestion` | Predicted next user prompt |
| `control_request` | `can_use_tool` | `ControlRequest` | Permission request from CLI (see Permission flow) |
| `control_response` | — | `ControlResponse` | Response to an outbound control request |

### SDKUserMessage (Claudette → stdin)

```json
{
  "type": "user",
  "content": "the user's prompt text"
}
```

For multi-turn conversations with streaming input, messages are written to the process stdin
as newline-delimited JSON.

### Control Protocol (bidirectional on stdin/stdout)

Control requests flow in **both directions**:

**Outbound requests (Claudette → stdin):**
- `{ "type": "control_request", "subtype": "initialize", ... }` — session init with hooks/mcp
- `{ "type": "control_request", "subtype": "interrupt" }` — abort current turn
- `{ "type": "control_request", "subtype": "set_permission_mode", "mode": "..." }`
- `{ "type": "control_request", "subtype": "set_model", "model": "..." }`
- `{ "type": "control_request", "subtype": "get_settings" }`

**Inbound requests (CLI → stdout → Claudette):**
- `{ "type": "control_request", "subtype": "can_use_tool", "request_id": "...", "tool_name": "Bash", "tool_input": {...}, ... }` — permission request

**Responses (both directions):**
- `{ "type": "control_response", "subtype": "success", "request_id": "...", "response": {...} }`
- `{ "type": "control_response", "subtype": "error", "request_id": "...", "error": "..." }`

**Permission flow (CLI asks Claudette for approval):**
1. stdout: `{ "type": "control_request", "subtype": "can_use_tool", "request_id": "abc", "tool_name": "Bash", "tool_input": {"command": "ls -la"}, "title": "Claude wants to run: ls -la", "display_name": "Run command" }`
2. Claudette shows approval UI to user
3. stdin: `{ "type": "control_response", "subtype": "success", "request_id": "abc", "response": { "behavior": "allow" } }`
4. or: `{ "type": "control_response", "subtype": "success", "request_id": "abc", "response": { "behavior": "deny", "message": "User denied" } }`

## Rust Data Model

### Core Message Types

```rust
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Top-level message from the CLI's stdout stream.
///
/// Uses `serde_json::Value` deserialization with manual dispatch rather than
/// `#[serde(tag = "type")]` to support the `Unknown` catch-all for forward
/// compatibility with new message types the CLI may introduce.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
pub enum SdkMessage {
    #[serde(rename = "system")]
    System(SystemMessage),
    #[serde(rename = "assistant")]
    Assistant(AssistantMessage),
    #[serde(rename = "stream_event")]
    StreamEvent(PartialAssistantMessage),
    #[serde(rename = "user")]
    User(UserMessage),
    #[serde(rename = "user_message_replay")]
    UserReplay(UserMessage),
    #[serde(rename = "result")]
    Result(ResultMessage),
    #[serde(rename = "control_request")]
    ControlRequest(InboundControlRequest),
    #[serde(rename = "control_response")]
    ControlResponse(ControlResponseMessage),
    #[serde(rename = "tool_use_summary")]
    ToolUseSummary(ToolUseSummaryMessage),
    #[serde(rename = "tool_progress")]
    ToolProgress(GenericEventMessage),
    #[serde(rename = "hook_started")]
    HookStarted(GenericEventMessage),
    #[serde(rename = "hook_progress")]
    HookProgress(GenericEventMessage),
    #[serde(rename = "hook_response")]
    HookResponse(GenericEventMessage),
    #[serde(rename = "task_notification")]
    TaskNotification(GenericEventMessage),
    #[serde(rename = "task_started")]
    TaskStarted(GenericEventMessage),
    #[serde(rename = "task_progress")]
    TaskProgress(GenericEventMessage),
    #[serde(rename = "auth_status")]
    AuthStatus(AuthStatusMessage),
    #[serde(rename = "local_command_output")]
    LocalCommandOutput(GenericEventMessage),
    #[serde(rename = "rate_limit_event")]
    RateLimitEvent(RateLimitEventMessage),
    #[serde(rename = "files_persisted")]
    FilesPersisted(GenericEventMessage),
    #[serde(rename = "elicitation_complete")]
    ElicitationComplete(GenericEventMessage),
    #[serde(rename = "prompt_suggestion")]
    PromptSuggestion(PromptSuggestionMessage),
    /// Catch-all for unknown/future message types. The protocol is actively
    /// evolving — new types must not crash the stdout reader.
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "subtype")]
pub enum SystemMessage {
    #[serde(rename = "init")]
    Init {
        tools: Vec<String>,
        model: String,
        permission_mode: PermissionMode,
        mcp_servers: Vec<McpServerInfo>,
        claude_code_version: String,
        cwd: String,
        uuid: Uuid,
        session_id: String,
    },
    #[serde(rename = "status")]
    Status {
        status: Option<String>,
        permission_mode: Option<PermissionMode>,
        uuid: Uuid,
        session_id: String,
    },
    #[serde(rename = "api_retry")]
    ApiRetry {
        attempt: u32,
        max_retries: u32,
        retry_delay_ms: u64,
        error_status: Option<u16>,
        uuid: Uuid,
        session_id: String,
    },
    #[serde(rename = "session_state_changed")]
    SessionStateChanged {
        state: SessionState,
        uuid: Uuid,
        session_id: String,
    },
    #[serde(rename = "compact_boundary")]
    CompactBoundary {
        uuid: Uuid,
        session_id: String,
    },
    /// Catch-all for unknown system subtypes.
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AssistantMessage {
    pub message: serde_json::Value, // BetaMessage — complex nested type
    pub parent_tool_use_id: Option<String>,
    pub error: Option<String>,
    pub uuid: Uuid,
    pub session_id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PartialAssistantMessage {
    pub event: serde_json::Value, // BetaRawMessageStreamEvent
    pub parent_tool_use_id: Option<String>,
    pub uuid: Uuid,
    pub session_id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UserMessage {
    pub content: serde_json::Value,
    pub uuid: Uuid,
    pub session_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "subtype")]
pub enum ResultMessage {
    #[serde(rename = "success")]
    Success {
        result: String,
        duration_ms: u64,
        duration_api_ms: u64,
        num_turns: u32,
        total_cost_usd: f64,
        usage: Usage,
        uuid: Uuid,
        session_id: String,
    },
    #[serde(rename = "error_during_execution")]
    ErrorDuringExecution { errors: Vec<String>, uuid: Uuid, session_id: String },
    #[serde(rename = "error_max_turns")]
    ErrorMaxTurns { uuid: Uuid, session_id: String },
    #[serde(rename = "error_max_budget_usd")]
    ErrorMaxBudget { uuid: Uuid, session_id: String },
    #[serde(other)]
    Unknown,
}

/// Inbound control request from the CLI (arrives on stdout).
/// Currently only `can_use_tool` is expected.
#[derive(Debug, Clone, Deserialize)]
pub struct InboundControlRequest {
    pub subtype: String,
    pub request_id: String,
    /// Tool name (present when subtype == "can_use_tool")
    #[serde(default)]
    pub tool_name: Option<String>,
    /// Tool input arguments
    #[serde(default)]
    pub tool_input: Option<serde_json::Value>,
    /// Human-readable prompt: "Claude wants to run: ls -la"
    #[serde(default)]
    pub title: Option<String>,
    /// Short label: "Run command"
    #[serde(default)]
    pub display_name: Option<String>,
    /// Explanatory subtitle
    #[serde(default)]
    pub description: Option<String>,
    /// Unique ID for this tool call
    #[serde(default)]
    pub tool_use_id: Option<String>,
    /// Permission update suggestions for "always allow" flows
    #[serde(default)]
    pub suggestions: Option<Vec<serde_json::Value>>,
}

/// Response to a control request (written to stdin).
#[derive(Debug, Clone, Serialize)]
pub struct ControlResponseEnvelope {
    #[serde(rename = "type")]
    pub msg_type: String, // always "control_response"
    pub subtype: String,  // "success" or "error"
    pub request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Control response received from the CLI (on stdout).
#[derive(Debug, Clone, Deserialize)]
pub struct ControlResponseMessage {
    pub subtype: String,
    pub request_id: String,
    #[serde(default)]
    pub response: Option<serde_json::Value>,
    #[serde(default)]
    pub error: Option<String>,
}

/// Generic event message — used as a stub for message types that don't need
/// detailed parsing yet. Preserves the full JSON for logging/debugging.
/// Replace with specific structs as features are implemented.
#[derive(Debug, Clone, Deserialize)]
pub struct GenericEventMessage {
    #[serde(flatten)]
    pub data: serde_json::Value,
}

/// Tool use summary emitted after a tool completes execution.
#[derive(Debug, Clone, Deserialize)]
pub struct ToolUseSummaryMessage {
    pub tool_name: Option<String>,
    pub tool_use_id: Option<String>,
    #[serde(flatten)]
    pub data: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AuthStatusMessage {
    pub is_authenticating: Option<bool>,
    pub output: Option<Vec<String>>,
    pub error: Option<String>,
    pub uuid: Uuid,
    pub session_id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RateLimitEventMessage {
    pub rate_limit_info: serde_json::Value,
    pub uuid: Uuid,
    pub session_id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PromptSuggestionMessage {
    pub suggestion: String,
    pub uuid: Uuid,
    pub session_id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct McpServerInfo {
    pub name: String,
    pub status: String,
}
```

### Permission Types

```rust
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum PermissionMode {
    Default,
    AcceptEdits,
    BypassPermissions,
    Plan,
    DontAsk,
}

/// User's decision for a permission request.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "behavior")]
pub enum PermissionDecision {
    #[serde(rename = "allow")]
    Allow {
        /// Modified tool input for this specific invocation (rare).
        #[serde(skip_serializing_if = "Option::is_none")]
        updated_input: Option<serde_json::Value>,
        /// Permission rule updates for "always allow" — returned from
        /// the `suggestions` field of the inbound `can_use_tool` request.
        /// Include these to grant blanket future allowances for the tool.
        #[serde(skip_serializing_if = "Option::is_none")]
        updated_permissions: Option<Vec<serde_json::Value>>,
    },
    #[serde(rename = "deny")]
    Deny {
        message: String,
        /// If true, also interrupts the current turn.
        #[serde(skip_serializing_if = "Option::is_none")]
        interrupt: Option<bool>,
    },
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Idle,
    Running,
    RequiresAction,
}
```

### Usage / Cost

```rust
#[derive(Debug, Clone, Deserialize)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_input_tokens: Option<u64>,
    pub cache_read_input_tokens: Option<u64>,
}
```

## Rust Runtime Layer

### AgentSession

Wraps a single conversation with the `claude` CLI. Internally manages per-turn process
spawning (current model) or a persistent process (future optimization).

```rust
pub struct AgentSession {
    session_id: String,
    working_dir: PathBuf,
    config: SessionConfig,
    state: SessionState,
    /// Active turn state — present only while a turn is running.
    /// Contains the child process, stdin writer, and stdout reader channels.
    active_turn: Option<ActiveTurn>,
}

struct ActiveTurn {
    child: tokio::process::Child,
    stdin_tx: mpsc::Sender<String>,
    message_rx: mpsc::Receiver<SdkMessage>,
}

impl AgentSession {
    /// Create a new session (generates a session_id, does not spawn yet)
    pub fn new(config: SessionConfig) -> Self;

    /// Send a user message, spawning a new claude process for this turn.
    /// Returns a receiver for streaming SDK messages.
    pub async fn send(&mut self, message: &str) -> Result<mpsc::Receiver<SdkMessage>, AgentError>;

    /// Respond to a permission request (writes control_response to stdin)
    pub async fn respond_permission(
        &self,
        request_id: &str,
        decision: PermissionDecision,
    ) -> Result<(), AgentError>;

    /// Interrupt the current turn
    pub async fn interrupt(&self) -> Result<(), AgentError>;

    /// Close the session and kill any active process
    pub fn close(&mut self);
}

pub struct SessionConfig {
    pub working_dir: PathBuf,
    pub session_id: Option<String>,     // None = auto-generate
    pub model: Option<String>,
    pub permission_mode: PermissionMode,
    pub allowed_tools: Vec<String>,
    pub disallowed_tools: Vec<String>,
    pub max_turns: Option<u32>,
    pub include_partial_messages: bool,
}
```

### Integration with Iced

The `AgentSession` maps to Iced's architecture:

1. **Message variants** (in `message.rs`):
   - `AgentMessage(SdkMessage)` — streamed from stdout reader task
   - `AgentPermissionRequest(InboundControlRequest)` — surfaces approval dialog
   - `AgentPermissionResponse(String, PermissionDecision)` — user approved/denied

2. **Subscription**: A tokio task reads stdout line by line, deserializes `SdkMessage`,
   and sends them as Iced messages via a channel.

3. **Permission UI**: When a `control_request` with `subtype: "can_use_tool"` arrives on
   stdout, the UI shows an approval modal with:
   - `title`: "Claude wants to run: ls -la" (from the request)
   - `display_name`: "Run command" (from the request)
   - `description`: Context about the operation (from the request)
   - **Allow** / **Deny** buttons
   - **Always allow** option: passes back the `suggestions` from the inbound request as
     `updated_permissions` in the allow response, granting blanket future permission

## Implementation Phases

### Phase 1: Replace current agent spawning
- Replace `agent::run_turn()` with `AgentSession` / `send()`
- Parse `SdkMessage` from stdout instead of ad-hoc stream parsing
- Keep per-turn process spawning with `--print --output-format stream-json`
- Map SDK messages to existing chat panel UI

### Phase 2: Permission handling
- Parse `can_use_tool` control requests from stdout
- Build approval modal in `ui/modal.rs`
- Write `control_response` to stdin on user decision
- Track `SessionState` for UI indicators

### Phase 3: Session management
- Use `--session-id` / `--resume` for conversation continuity
- Persist session ID in SQLite alongside workspace
- Support `--continue` for resuming most recent session

### Phase 4: Advanced features
- MCP server configuration passthrough
- Hook support
- Rate limit display
- Structured output
- Subagent support
- Long-lived process with stdin streaming (avoid per-turn spawn overhead)

## Key Differences from TypeScript SDK

| Aspect | TS SDK | Rust Implementation |
|--------|--------|-------------------|
| Runtime | Node/Bun subprocess | Same (spawns `claude` CLI) |
| Serialization | Internal bundled code | `serde_json` with tagged enums + `Unknown` catch-all |
| Async model | AsyncGenerator | `tokio::mpsc` channels + Iced subscriptions |
| Permission UI | Callback (`canUseTool`) | Iced modal dialog via message passing |
| MCP servers | In-process SDK servers | CLI-managed only (Phase 4 for in-process) |
| Session storage | JSONL files in `~/.claude/` | CLI handles persistence; we track session_id |
| Forward compat | N/A (same codebase) | `#[serde(other)] Unknown` variants on all enums |

## References

- SDK types: `@anthropic-ai/claude-agent-sdk/sdk.d.ts` (4155 lines)
- SDK tools: `@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts` (2710 lines)
- Bridge types: `@anthropic-ai/claude-agent-sdk/bridge.d.ts` (199 lines)
- Browser types: `@anthropic-ai/claude-agent-sdk/browser-sdk.d.ts` (52 lines)
- Runtime: `sdk.mjs` (spawns CLI, pipes stdio, parses JSON)
