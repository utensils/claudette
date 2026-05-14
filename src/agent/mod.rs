mod args;
pub mod background;
mod binary;
pub mod codex_app_server;
mod environment;
pub mod harness;
mod naming;
pub mod pi_sdk;
mod process;
mod session;
mod types;

use serde::{Deserialize, Serialize};

use crate::agent_backend::AgentBackendRuntime;

pub use args::{build_claude_args, build_stdin_message};
pub use binary::{
    resolve_claude_path, resolve_claude_path_blocking, resolve_codex_path,
    resolve_codex_path_blocking,
};
pub use codex_app_server::{
    CodexAppServerOptions, CodexAppServerSession, CodexPermissionLevel,
    build_codex_approval_response_payload, build_codex_user_input_response_payload,
    is_codex_approval_tool_name, normalize_codex_reasoning_effort,
};
pub use harness::{
    AgentHarnessCapabilities, AgentHarnessKind, AgentSession, ClaudeCodeHarness,
    PersistentSessionStart,
};
pub use naming::{
    generate_branch_name, generate_session_name, persist_claude_custom_title, sanitize_branch_name,
};
pub use pi_sdk::{PiSdkModel, PiSdkOptions, PiSdkSession, resolve_pi_harness_path};
pub use process::{AgentEvent, TurnHandle, run_turn, stop_agent, stop_agent_graceful};
pub use session::PersistentSession;
pub use types::{
    AssistantMessage, CompactMetadata, ContentBlock, ControlRequestInner, ControlResponsePayload,
    Delta, FileAttachment, InnerStreamEvent, StartContentBlock, StreamEvent, TokenUsage,
    TokenUsageIteration, UserContentBlock, UserEventMessage, UserMessageContent, parse_stream_line,
};

/// Per-turn settings that control CLI flags for the agent subprocess.
#[derive(Debug, Clone, Serialize, Deserialize)]
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
    /// Effort level for adaptive reasoning (`low`, `medium`, `high`, `xhigh`,
    /// `max`). `max` is Opus 4.6 only. Applied on every turn via `--effort`.
    pub effort: Option<String>,
    /// Enable Chrome browser mode via `--chrome`. Session-level: only applied
    /// on the first turn.
    pub chrome_enabled: bool,
    /// MCP config JSON string for `--mcp-config`. Per-turn: applied on every
    /// turn since each `claude` process is independent and doesn't inherit
    /// MCP connections from previous turns.
    pub mcp_config: Option<String>,
    /// When true, set `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` on the spawned CLI
    /// process so the Max-plan auto-upgrade to 1M is suppressed and the
    /// selected model runs at its 200k window. Derived frontend-side from
    /// the model registry's `contextWindowTokens`.
    pub disable_1m_context: bool,
    /// When true, redirect Claude Code agent-team teammates into Claudette
    /// session tabs. Defaults to true for new users; settings can opt out.
    pub team_agent_session_tabs_enabled: bool,
    /// Provider-specific env for alternate Claude Code backends.
    /// Empty means the normal Claude Code account/API environment is used.
    pub backend_runtime: AgentBackendRuntime,
    /// Optional bridge used by Claude Code hooks. When present, args inject
    /// command hooks and process env points those hook children back at the
    /// parent-side bridge.
    pub hook_bridge: Option<AgentHookBridge>,
    /// User-toggled extra `claude` CLI flags discovered from `claude --help`
    /// and resolved via `claude_flags_store`. Each entry is `(flag_name,
    /// optional_value)`; boolean flags carry `None`. Appended to argv on
    /// every turn after Claudette's own args.
    pub extra_claude_flags: Vec<(String, Option<String>)>,
}

impl Default for AgentSettings {
    fn default() -> Self {
        Self {
            model: None,
            fast_mode: false,
            thinking_enabled: false,
            plan_mode: false,
            effort: None,
            chrome_enabled: false,
            mcp_config: None,
            disable_1m_context: false,
            team_agent_session_tabs_enabled: true,
            backend_runtime: AgentBackendRuntime::default(),
            hook_bridge: None,
            extra_claude_flags: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentHookBridge {
    pub command: String,
    pub socket_addr: String,
    pub token: String,
}
