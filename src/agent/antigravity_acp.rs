//! Native Antigravity Agent Client Protocol (ACP) harness (`agy acp`).
//!
//! Speaks newline-delimited JSON-RPC 2.0 ACP over stdio against the host `agy`
//! CLI, translating ACP notifications (`session/update`) and incoming requests
//! (`session/request_permission`, `elicitation/create`) into Claudette's
//! shared [`AgentEvent`] / [`StreamEvent`] contract.
//!
//! Incorporates production lessons from `stablyai/orca`'s Antigravity ACP
//! dialect:
//! - Sets `AGY_CLI_DISABLE_AUTO_UPDATE=true` (strictly `"true"`) so background
//!   updaters never steal focus on Windows or replace `agy` mid-probe.
//! - Scrubs inherited `GEMINI_API_KEY` / `GOOGLE_API_KEY` when `agy` is using
//!   Google OAuth (no `modelProvider` in `~/.gemini/antigravity-cli/settings.json`)
//!   so an ambient API key doesn't hijack OAuth and trigger 401s.
//! - Resolves `configOptions` by `category` (`model`, `thought_level`, `mode`)
//!   so both `agy 1.4.x` (`thinking_level`) and `agy 1.5.x` (`thought_level`)
//!   work without hardcoding option IDs.
//! - Intercepts `agy 1.5+` empty-output retry notices
//!   (`⚠ Model produced invalid output.`) and turn-failure notices that close
//!   with `stopReason: "end_turn"`, formatting Google API errors cleanly.
//! - Normalizes Antigravity command/output field variants (`CommandLine`,
//!   `combinedOutput`, `exitCode`, etc.) and never auto-approves
//!   `interaction_*` user questions.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};
use tokio::process::ChildStdin;
use tokio::sync::{broadcast, mpsc, oneshot};

use crate::agent_backend::AgentBackendModel;

use super::codex_app_server::{
    CODEX_COMMAND_APPROVAL_TOOL, CODEX_FILE_CHANGE_APPROVAL_TOOL, CODEX_PERMISSIONS_APPROVAL_TOOL,
};
use super::environment::build_agent_command;
use super::{
    AgentEvent, AssistantMessage, ContentBlock, ControlRequestInner, Delta, FileAttachment,
    InnerStreamEvent, StartContentBlock, StreamEvent, TokenUsage, TurnHandle, UserContentBlock,
    UserEventMessage, UserMessageContent,
};

type AcpStdin = Arc<tokio::sync::Mutex<ChildStdin>>;
type PendingAcpRequests = Arc<tokio::sync::Mutex<BTreeMap<AcpRpcId, PendingAcpRequest>>>;

const ACP_PROTOCOL_VERSION: i64 = 1;
const MAX_ACP_STDOUT_PREAMBLE_LINES: usize = 256;
const ACP_INIT_TIMEOUT: Duration = Duration::from_secs(30);
const ACP_CONTROL_TIMEOUT: Duration = Duration::from_secs(20);
const ACP_STDERR_DRAIN_TIMEOUT: Duration = Duration::from_millis(250);
const ACP_AUTH_REQUIRED_CODE: i64 = -32000;
const ACP_MAX_IMAGE_BASE64_BYTES: usize = 28 * 1024 * 1024;
const ACP_MAX_TOTAL_IMAGE_BASE64_BYTES: usize = 30 * 1024 * 1024;
const ACP_MAX_IMAGE_COUNT: usize = 20;
const WARNING_MAX_CHARS: usize = 512;

/// Default context window reported by Antigravity Gemini models (1 MiB tokens).
pub const ANTIGRAVITY_DEFAULT_CONTEXT_WINDOW: u32 = 1_048_576;

/// Effort level suffixes used by `agy models` (e.g. `gemini-4-neon-high`).
const ANTIGRAVITY_EFFORT_SUFFIXES: &[&str] =
    &["none", "minimal", "low", "medium", "high", "xhigh", "max"];

pub const ANTIGRAVITY_AUTH_REQUIRED_MESSAGE: &str = "Antigravity is not authenticated. Run /login (or `agy acp --login` in a terminal), then send the message again.";

struct PendingAcpRequest {
    method: String,
    tx: oneshot::Sender<Result<AcpRpcResponse, AcpRpcError>>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AcpRpcId {
    Integer(i64),
    String(String),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AcpRpcMessage {
    Request(AcpRpcRequest),
    Notification(AcpRpcNotification),
    Response(AcpRpcResponse),
    Error(AcpRpcError),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AcpRpcRequest {
    pub id: AcpRpcId,
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AcpRpcNotification {
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AcpRpcResponse {
    pub id: Option<AcpRpcId>,
    pub result: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AcpRpcError {
    pub id: Option<AcpRpcId>,
    pub error: AcpRpcErrorBody,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AcpRpcErrorBody {
    pub code: i64,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AcpRpcServerResponse {
    pub jsonrpc: &'static str,
    pub id: AcpRpcId,
    pub result: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AntigravityPermissionLevel {
    Readonly,
    Standard,
    Full,
}

impl AntigravityPermissionLevel {
    pub fn from_claudette_level(level: &str) -> Self {
        match level {
            "readonly" => Self::Readonly,
            "standard" => Self::Standard,
            "full" => Self::Full,
            _ => Self::Readonly,
        }
    }
}

#[derive(Debug, Clone)]
pub struct AntigravityAcpOptions {
    pub model: Option<String>,
    pub permission_level: AntigravityPermissionLevel,
    pub plan_mode: bool,
    pub reasoning_effort: Option<String>,
    pub resume_session_id: Option<String>,
    pub custom_instructions: Option<String>,
    pub mcp_config: Option<String>,
    pub workspace_env: Option<crate::env::WorkspaceEnv>,
    pub resolved_env: Option<crate::env_provider::ResolvedEnv>,
    /// Short-lived connectivity probe mode: skips `--dangerously-skip-permissions`
    /// and never creates a session.
    pub probe_mode: bool,
}

impl Default for AntigravityAcpOptions {
    fn default() -> Self {
        Self {
            model: None,
            permission_level: AntigravityPermissionLevel::Readonly,
            plan_mode: false,
            reasoning_effort: None,
            resume_session_id: None,
            custom_instructions: None,
            mcp_config: None,
            workspace_env: None,
            resolved_env: None,
            probe_mode: false,
        }
    }
}

#[derive(Debug, Clone, Default)]
struct AcpCapabilities {
    load_session: bool,
    resume_session: bool,
    accepts_images: bool,
    supports_system_prompt_append: bool,
    agent_version: Option<String>,
}

#[derive(Debug, Default)]
struct AcpTurnState {
    text: String,
    thinking: String,
    started_tools: HashSet<String>,
    tool_names: HashMap<String, String>,
    tool_inputs: HashMap<String, Value>,
    last_context_window: Option<u64>,
    turn_failure_notice: Option<String>,
}

impl AcpTurnState {
    fn reset_for_turn(&mut self) {
        self.text.clear();
        self.thinking.clear();
        self.started_tools.clear();
        self.tool_names.clear();
        self.tool_inputs.clear();
        self.turn_failure_notice = None;
    }

    fn drain_text_and_thinking(&mut self) -> Vec<AgentEvent> {
        let mut blocks = Vec::new();
        if !self.thinking.is_empty() {
            blocks.push(ContentBlock::Thinking {
                thinking: std::mem::take(&mut self.thinking),
            });
        }
        if !self.text.is_empty() {
            blocks.push(ContentBlock::Text {
                text: std::mem::take(&mut self.text),
            });
        }
        if blocks.is_empty() {
            Vec::new()
        } else {
            vec![AgentEvent::Stream(StreamEvent::Assistant {
                message: AssistantMessage { content: blocks },
            })]
        }
    }
}

pub struct AntigravityAcpSession {
    pid: u32,
    stdin: Option<AcpStdin>,
    event_tx: broadcast::Sender<AgentEvent>,
    pending: PendingAcpRequests,
    next_request_id: AtomicI64,
    working_dir: PathBuf,
    model: Option<String>,
    permission_level: AntigravityPermissionLevel,
    plan_mode: bool,
    reasoning_effort: Option<String>,
    resume_session_id: Option<String>,
    custom_instructions: Option<String>,
    mcp_config: Option<String>,
    capabilities: Arc<tokio::sync::Mutex<AcpCapabilities>>,
    acp_session_id: Arc<tokio::sync::Mutex<Option<String>>>,
    turn_state: Arc<tokio::sync::Mutex<AcpTurnState>>,
}

impl AntigravityAcpSession {
    pub async fn start_with_options(
        working_dir: &Path,
        client_version: &str,
        options: AntigravityAcpOptions,
    ) -> Result<Self, String> {
        crate::missing_cli::precheck_cwd(working_dir)?;

        let agy_path = super::binary::resolve_agy_path().await;
        let args = antigravity_acp_args(
            options.permission_level,
            options.plan_mode,
            options.probe_mode,
        )
        .into_iter()
        .map(str::to_string)
        .collect::<Vec<_>>();
        let built_command = build_agent_command(
            agy_path.as_os_str(),
            &args,
            working_dir,
            options.resolved_env.as_ref(),
        )
        .await;
        let mut cmd = built_command.command;
        cmd.stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        apply_antigravity_acp_env(&mut cmd, agy_uses_api_key(dirs::home_dir().as_deref()));

        if let Some(env) = options.workspace_env.as_ref() {
            env.apply(&mut cmd);
        }

        let mut child = cmd.spawn().map_err(|e| {
            crate::missing_cli::map_spawn_err(&e, "agy", || {
                format!("Failed to spawn Antigravity ACP server: {e}")
            })
        })?;
        let pid = child
            .id()
            .ok_or_else(|| "Antigravity ACP server exited immediately".to_string())?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to capture Antigravity ACP stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to capture Antigravity ACP stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Failed to capture Antigravity ACP stderr".to_string())?;

        let (event_tx, _) = broadcast::channel(2048);
        let session = Self {
            pid,
            stdin: Some(Arc::new(tokio::sync::Mutex::new(stdin))),
            event_tx,
            pending: Arc::new(tokio::sync::Mutex::new(BTreeMap::new())),
            next_request_id: AtomicI64::new(1),
            working_dir: working_dir.to_path_buf(),
            model: options.model,
            permission_level: options.permission_level,
            plan_mode: options.plan_mode,
            reasoning_effort: normalize_antigravity_reasoning_effort(
                options.reasoning_effort.as_deref(),
            ),
            resume_session_id: options.resume_session_id,
            custom_instructions: options.custom_instructions,
            mcp_config: options.mcp_config,
            capabilities: Arc::new(tokio::sync::Mutex::new(AcpCapabilities::default())),
            acp_session_id: Arc::new(tokio::sync::Mutex::new(None)),
            turn_state: Arc::new(tokio::sync::Mutex::new(AcpTurnState::default())),
        };

        session.spawn_stdout_reader(stdout);
        let stderr_task = session.spawn_stderr_reader(stderr);
        session.spawn_exit_watcher(child, stderr_task);

        let command_line = crate::agent::args::format_redacted_invocation(
            &built_command.invocation_program,
            &built_command.invocation_args,
        );
        let _ = session
            .event_tx
            .send(AgentEvent::Stream(StreamEvent::system_command_line(
                command_line,
            )));

        if let Err(err) = session.initialize(client_version).await {
            fail_pending_requests(&session.pending, "Antigravity ACP initialize failed").await;
            let _ = super::process::stop_agent_graceful(pid).await;
            return Err(err);
        }

        if !options.probe_mode
            && session.resume_session_id.is_some()
            && let Err(err) = session.ensure_session().await
        {
            fail_pending_requests(&session.pending, "Antigravity ACP resume failed").await;
            let _ = super::process::stop_agent_graceful(pid).await;
            return Err(err);
        }

        Ok(session)
    }

    #[doc(hidden)]
    pub fn new_for_test(pid: u32) -> Self {
        let (event_tx, _) = broadcast::channel(128);
        Self {
            pid,
            stdin: None,
            event_tx,
            pending: Arc::new(tokio::sync::Mutex::new(BTreeMap::new())),
            next_request_id: AtomicI64::new(1),
            working_dir: PathBuf::from("/tmp"),
            model: None,
            permission_level: AntigravityPermissionLevel::Readonly,
            plan_mode: false,
            reasoning_effort: None,
            resume_session_id: None,
            custom_instructions: None,
            mcp_config: None,
            capabilities: Arc::new(tokio::sync::Mutex::new(AcpCapabilities::default())),
            acp_session_id: Arc::new(tokio::sync::Mutex::new(None)),
            turn_state: Arc::new(tokio::sync::Mutex::new(AcpTurnState::default())),
        }
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn subscribe(&self) -> broadcast::Receiver<AgentEvent> {
        self.event_tx.subscribe()
    }

    pub async fn agent_version(&self) -> Option<String> {
        self.capabilities.lock().await.agent_version.clone()
    }

    /// Lightweight readiness + auth probe using `session/list { cwd }` so no
    /// stray conversation is created in `~/.gemini`.
    pub async fn list_sessions_probe(&self) -> Result<(), String> {
        let request = AcpRpcRequest {
            id: AcpRpcId::Integer(self.next_id()),
            method: "session/list".to_string(),
            params: Some(json!({
                "cwd": self.working_dir,
            })),
        };
        self.send_request(request, Some(ACP_CONTROL_TIMEOUT))
            .await
            .map(|_| ())
    }

    pub async fn send_turn(
        &self,
        prompt: &str,
        attachments: &[FileAttachment],
    ) -> Result<TurnHandle, String> {
        let mut broadcast_rx = self.event_tx.subscribe();
        let session_id = self.ensure_session().await?;
        let accepts_images = self.capabilities.lock().await.accepts_images;
        let blocks = build_acp_prompt_blocks(prompt, attachments, accepts_images)?;

        {
            let mut state = self.turn_state.lock().await;
            state.reset_for_turn();
        }

        let _ = self.event_tx.send(acp_init_system_event(&session_id));

        let request = AcpRpcRequest {
            id: AcpRpcId::Integer(self.next_id()),
            method: "session/prompt".to_string(),
            params: Some(json!({
                "sessionId": session_id,
                "prompt": blocks,
            })),
        };

        let stdin = self
            .stdin
            .clone()
            .ok_or_else(|| "Antigravity ACP stdin is not available".to_string())?;
        let pending = self.pending.clone();
        let event_tx = self.event_tx.clone();
        let turn_state = self.turn_state.clone();
        let started_at = Instant::now();

        let (tx, rx) = oneshot::channel();
        {
            let mut map = pending.lock().await;
            map.insert(
                request.id.clone(),
                PendingAcpRequest {
                    method: request.method.clone(),
                    tx,
                },
            );
        }
        let write_result = {
            let mut writer = stdin.lock().await;
            write_acp_message(&mut *writer, &json_rpc_request_value(&request)).await
        };
        if let Err(err) = write_result {
            pending.lock().await.remove(&request.id);
            return Err(err);
        }

        // Await the `session/prompt` response concurrently while notifications
        // stream over `event_tx`, emitting the terminal `Result` when done.
        tokio::spawn(async move {
            let outcome = rx.await;
            let duration_ms = Some(started_at.elapsed().as_millis() as i64);
            let (drained, failure_notice, last_window) = {
                let mut state = turn_state.lock().await;
                let drained = state.drain_text_and_thinking();
                let notice = state.turn_failure_notice.take();
                let window = state.last_context_window;
                (drained, notice, window)
            };
            for ev in drained {
                let _ = event_tx.send(ev);
            }
            let result_event = match outcome {
                Ok(Ok(response)) => {
                    let stop_reason = response
                        .result
                        .get("stopReason")
                        .and_then(Value::as_str)
                        .unwrap_or("end_turn");
                    let usage = token_usage_from_prompt_result(&response.result, last_window);
                    if let Some(notice) = failure_notice {
                        AgentEvent::Stream(StreamEvent::Result {
                            subtype: "error".to_string(),
                            result: Some(notice),
                            total_cost_usd: None,
                            duration_ms,
                            usage,
                        })
                    } else if stop_reason == "refusal" {
                        AgentEvent::Stream(StreamEvent::Result {
                            subtype: "error".to_string(),
                            result: Some("Antigravity refused the prompt.".to_string()),
                            total_cost_usd: None,
                            duration_ms,
                            usage,
                        })
                    } else {
                        AgentEvent::Stream(StreamEvent::Result {
                            subtype: "success".to_string(),
                            result: None,
                            total_cost_usd: None,
                            duration_ms,
                            usage,
                        })
                    }
                }
                Ok(Err(rpc_error)) => AgentEvent::Stream(StreamEvent::Result {
                    subtype: "error".to_string(),
                    result: Some(format_acp_rpc_error("session/prompt", &rpc_error)),
                    total_cost_usd: None,
                    duration_ms,
                    usage: None,
                }),
                Err(_) => AgentEvent::Stream(StreamEvent::Result {
                    subtype: "error".to_string(),
                    result: Some(
                        "Antigravity ACP response channel closed before the turn completed."
                            .to_string(),
                    ),
                    total_cost_usd: None,
                    duration_ms,
                    usage: None,
                }),
            };
            let _ = event_tx.send(result_event);
        });

        let (mpsc_tx, mpsc_rx) = mpsc::channel::<AgentEvent>(128);
        tokio::spawn(async move {
            loop {
                match broadcast_rx.recv().await {
                    Ok(event) => {
                        let is_turn_end =
                            matches!(&event, AgentEvent::Stream(StreamEvent::Result { .. }));
                        let is_process_exit = matches!(&event, AgentEvent::ProcessExited(_));
                        if mpsc_tx.send(event).await.is_err() {
                            break;
                        }
                        if is_turn_end || is_process_exit {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!(
                            target: "claudette::agent",
                            subsystem = "antigravity-acp",
                            dropped_events = n,
                            "broadcast lag — antigravity per-turn receiver missed events"
                        );
                    }
                }
            }
        });

        Ok(TurnHandle {
            event_rx: mpsc_rx,
            pid: self.pid,
        })
    }

    pub async fn interrupt_turn(&self) -> Result<(), String> {
        let session_id = self
            .acp_session_id
            .lock()
            .await
            .clone()
            .ok_or_else(|| "Antigravity ACP has no active session to cancel".to_string())?;
        self.send_notification(AcpRpcNotification {
            method: "session/cancel".to_string(),
            params: Some(json!({ "sessionId": session_id })),
        })
        .await
    }

    pub async fn send_control_response(
        &self,
        request_id: &str,
        response: Value,
    ) -> Result<(), String> {
        let server_response =
            build_acp_server_response_from_control_response(request_id, response)?;
        let stdin = self
            .stdin
            .as_ref()
            .ok_or_else(|| "Antigravity ACP stdin is not available".to_string())?;
        let mut writer = stdin.lock().await;
        write_acp_message(&mut *writer, &server_response).await
    }

    async fn initialize(&self, client_version: &str) -> Result<(), String> {
        let request = build_acp_initialize_request(self.next_id(), client_version);
        let response = self.send_request(request, Some(ACP_INIT_TIMEOUT)).await?;
        let protocol_version = response
            .result
            .get("protocolVersion")
            .and_then(Value::as_i64)
            .unwrap_or_default();
        if protocol_version != ACP_PROTOCOL_VERSION {
            return Err(format!(
                "Unsupported Antigravity ACP protocol version: {protocol_version}"
            ));
        }
        let caps = parse_acp_capabilities(&response.result);
        *self.capabilities.lock().await = caps;
        Ok(())
    }

    async fn ensure_session(&self) -> Result<String, String> {
        if let Some(session_id) = self.acp_session_id.lock().await.clone() {
            return Ok(session_id);
        }
        let caps = self.capabilities.lock().await.clone();
        let mcp_servers = acp_mcp_servers_from_claude_config(self.mcp_config.as_deref());
        let meta = if caps.supports_system_prompt_append
            && let Some(instructions) = self
                .custom_instructions
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
        {
            Some(json!({
                "antigravity": {
                    "systemPrompt": {
                        "append": instructions,
                    }
                }
            }))
        } else {
            None
        };

        let (session_id, response_value) = if let Some(resume_id) =
            self.resume_session_id.as_deref()
        {
            let method = if caps.resume_session {
                "session/resume"
            } else if caps.load_session {
                "session/load"
            } else {
                return Err("Antigravity ACP server does not support resuming sessions".to_string());
            };
            let mut params = json!({
                "sessionId": resume_id,
                "cwd": self.working_dir,
                "mcpServers": mcp_servers,
            });
            if let Some(meta) = meta.clone()
                && let Some(obj) = params.as_object_mut()
            {
                obj.insert("_meta".to_string(), meta);
            }
            let response = self
                .send_request(
                    AcpRpcRequest {
                        id: AcpRpcId::Integer(self.next_id()),
                        method: method.to_string(),
                        params: Some(params),
                    },
                    Some(ACP_CONTROL_TIMEOUT),
                )
                .await?;
            let sid = response
                .result
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or(resume_id)
                .to_string();
            (sid, response.result)
        } else {
            let mut params = json!({
                "cwd": self.working_dir,
                "mcpServers": mcp_servers,
            });
            if let Some(meta) = meta
                && let Some(obj) = params.as_object_mut()
            {
                obj.insert("_meta".to_string(), meta);
            }
            let response = self
                .send_request(
                    AcpRpcRequest {
                        id: AcpRpcId::Integer(self.next_id()),
                        method: "session/new".to_string(),
                        params: Some(params),
                    },
                    Some(ACP_CONTROL_TIMEOUT),
                )
                .await?;
            let sid = response
                .result
                .get("sessionId")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    "Antigravity ACP `session/new` did not return a sessionId".to_string()
                })?
                .to_string();
            (sid, response.result)
        };

        *self.acp_session_id.lock().await = Some(session_id.clone());
        self.apply_session_options(&session_id, &response_value)
            .await;
        Ok(session_id)
    }

    async fn apply_session_options(&self, session_id: &str, session_result: &Value) {
        let mut config_options = session_result
            .get("configOptions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        // 1. Model selection (with optional leveled-ID decomposition).
        let mut effective_effort = self.reasoning_effort.clone();
        if let Some(requested_model) = self
            .model
            .as_deref()
            .map(str::trim)
            .filter(|m| !m.is_empty())
        {
            if let Some((config_id, target_value, inferred_effort)) =
                resolve_model_config_option(&config_options, requested_model)
            {
                if effective_effort.is_none() {
                    effective_effort = inferred_effort;
                }
                if let Some(updated) = self
                    .set_config_option(session_id, &config_id, &target_value)
                    .await
                {
                    config_options = updated;
                }
            } else {
                // Legacy fallback when no `category: "model"` config option exists.
                let _ = self
                    .send_request(
                        AcpRpcRequest {
                            id: AcpRpcId::Integer(self.next_id()),
                            method: "session/set_model".to_string(),
                            params: Some(json!({
                                "sessionId": session_id,
                                "modelId": requested_model,
                            })),
                        },
                        Some(ACP_CONTROL_TIMEOUT),
                    )
                    .await;
            }
        }

        // 2. Reasoning effort (`category: "thought_level"`).
        if let Some(effort) = effective_effort.as_deref()
            && let Some((config_id, value)) = resolve_effort_config_option(&config_options, effort)
            && let Some(updated) = self.set_config_option(session_id, &config_id, &value).await
        {
            config_options = updated;
        }

        // 3. Session mode (`plan`, `accept-edits`, `auto`, `default`).
        let desired_modes = desired_acp_mode_candidates(self.permission_level, self.plan_mode);
        if let Some((config_id, mode_value)) =
            resolve_mode_config_option(&config_options, &desired_modes)
        {
            let _ = self
                .set_config_option(session_id, &config_id, &mode_value)
                .await;
        } else if let Some(mode_id) = resolve_legacy_mode_id(session_result, &desired_modes) {
            let _ = self
                .send_request(
                    AcpRpcRequest {
                        id: AcpRpcId::Integer(self.next_id()),
                        method: "session/set_mode".to_string(),
                        params: Some(json!({
                            "sessionId": session_id,
                            "modeId": mode_id,
                        })),
                    },
                    Some(ACP_CONTROL_TIMEOUT),
                )
                .await;
        }
    }

    async fn set_config_option(
        &self,
        session_id: &str,
        config_id: &str,
        value: &str,
    ) -> Option<Vec<Value>> {
        let response = self
            .send_request(
                AcpRpcRequest {
                    id: AcpRpcId::Integer(self.next_id()),
                    method: "session/set_config_option".to_string(),
                    params: Some(json!({
                        "sessionId": session_id,
                        "configId": config_id,
                        "value": value,
                    })),
                },
                Some(ACP_CONTROL_TIMEOUT),
            )
            .await;
        match response {
            Ok(resp) => resp
                .result
                .get("configOptions")
                .and_then(Value::as_array)
                .cloned(),
            Err(err) => {
                tracing::warn!(
                    target: "claudette::agent",
                    subsystem = "antigravity-acp",
                    pid = self.pid,
                    config_id,
                    value,
                    error = %err,
                    "failed to apply Antigravity ACP config option"
                );
                None
            }
        }
    }

    async fn send_request(
        &self,
        request: AcpRpcRequest,
        timeout: Option<Duration>,
    ) -> Result<AcpRpcResponse, String> {
        let stdin = self
            .stdin
            .as_ref()
            .ok_or_else(|| "Antigravity ACP stdin is not available".to_string())?;
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().await;
            pending.insert(
                request.id.clone(),
                PendingAcpRequest {
                    method: request.method.clone(),
                    tx,
                },
            );
        }
        let write_result = {
            let mut writer = stdin.lock().await;
            write_acp_message(&mut *writer, &json_rpc_request_value(&request)).await
        };
        if let Err(err) = write_result {
            self.pending.lock().await.remove(&request.id);
            return Err(err);
        }
        let awaited = match timeout {
            Some(limit) => match tokio::time::timeout(limit, rx).await {
                Ok(result) => result,
                Err(_) => {
                    self.pending.lock().await.remove(&request.id);
                    return Err(format!(
                        "Antigravity ACP `{}` timed out after {}s",
                        request.method,
                        limit.as_secs()
                    ));
                }
            },
            None => rx.await,
        };
        match awaited.map_err(|_| {
            format!(
                "Antigravity ACP response channel closed for `{}`",
                request.method
            )
        })? {
            Ok(response) => Ok(response),
            Err(error) => Err(format_acp_rpc_error(&request.method, &error)),
        }
    }

    async fn send_notification(&self, notification: AcpRpcNotification) -> Result<(), String> {
        let stdin = self
            .stdin
            .as_ref()
            .ok_or_else(|| "Antigravity ACP stdin is not available".to_string())?;
        let mut writer = stdin.lock().await;
        write_acp_message(&mut *writer, &json_rpc_notification_value(&notification)).await
    }

    fn next_id(&self) -> i64 {
        self.next_request_id.fetch_add(1, Ordering::Relaxed)
    }

    fn spawn_stdout_reader(&self, stdout: tokio::process::ChildStdout) {
        let event_tx = self.event_tx.clone();
        let pending = self.pending.clone();
        let stdin = self.stdin.clone();
        let turn_state = self.turn_state.clone();
        let pid = self.pid;
        tokio::spawn(async move {
            let mut reader = tokio::io::BufReader::new(stdout);
            loop {
                match read_acp_message(&mut reader).await {
                    Ok(Some(message)) => {
                        route_acp_message(
                            pid,
                            &event_tx,
                            &pending,
                            stdin.as_ref(),
                            &turn_state,
                            message,
                        )
                        .await;
                    }
                    Ok(None) => {
                        fail_pending_requests(
                            &pending,
                            "Antigravity ACP stdout closed before responding",
                        )
                        .await;
                        break;
                    }
                    Err(err) => {
                        tracing::warn!(
                            target: "claudette::agent",
                            subsystem = "antigravity-acp",
                            pid,
                            error = %err,
                            "failed to read antigravity ACP stdout"
                        );
                        let _ = event_tx.send(AgentEvent::Stderr(err.clone()));
                        fail_pending_requests(&pending, &err).await;
                        break;
                    }
                }
            }
        });
    }

    fn spawn_stderr_reader(
        &self,
        stderr: tokio::process::ChildStderr,
    ) -> tokio::task::JoinHandle<()> {
        let event_tx = self.event_tx.clone();
        let pid = self.pid;
        tokio::spawn(async move {
            let mut reader = tokio::io::BufReader::new(stderr);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) => break,
                    Ok(_) => {
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        tracing::debug!(
                            target: "claudette::agent",
                            subsystem = "antigravity-acp",
                            pid,
                            line = trimmed,
                            "antigravity stderr"
                        );
                        let _ = event_tx.send(AgentEvent::Stderr(trimmed.to_string()));
                    }
                    Err(err) => {
                        tracing::warn!(
                            target: "claudette::agent",
                            subsystem = "antigravity-acp",
                            pid,
                            error = %err,
                            "failed to read antigravity stderr"
                        );
                        break;
                    }
                }
            }
        })
    }

    fn spawn_exit_watcher(
        &self,
        mut child: tokio::process::Child,
        stderr_task: tokio::task::JoinHandle<()>,
    ) {
        let event_tx = self.event_tx.clone();
        let pending = self.pending.clone();
        tokio::spawn(async move {
            let status = child.wait().await.ok().and_then(|s| s.code());
            let _ = tokio::time::timeout(ACP_STDERR_DRAIN_TIMEOUT, stderr_task).await;
            fail_pending_requests(&pending, "Antigravity ACP process exited").await;
            let _ = event_tx.send(AgentEvent::ProcessExited(status));
        });
    }
}

pub fn antigravity_acp_args(
    permission_level: AntigravityPermissionLevel,
    plan_mode: bool,
    probe_mode: bool,
) -> Vec<&'static str> {
    if !probe_mode && !plan_mode && permission_level == AntigravityPermissionLevel::Full {
        vec!["acp", "--dangerously-skip-permissions"]
    } else {
        vec!["acp"]
    }
}

/// Apply Antigravity subprocess environment hygiene (Orca learnings):
/// - Disable background auto-updater (`AGY_CLI_DISABLE_AUTO_UPDATE=true`) so
///   Windows focus isn't stolen and `agy` isn't replaced mid-probe.
/// - Scrub inherited `GEMINI_API_KEY` and `GOOGLE_API_KEY` when `agy` isn't
///   configured for an explicit `modelProvider` in its settings.json, preventing
///   an ambient key from overriding Google OAuth and returning 401.
pub fn apply_antigravity_acp_env(cmd: &mut tokio::process::Command, uses_api_key_provider: bool) {
    cmd.env("AGY_CLI_DISABLE_AUTO_UPDATE", "true");
    cmd.env_remove("CHROME_CRASHPAD_PIPE_NAME");
    cmd.env_remove("ANTIGRAVITY_HARNESS_PATH");
    if !uses_api_key_provider {
        cmd.env_remove("GEMINI_API_KEY");
        cmd.env_remove("GOOGLE_API_KEY");
    }
}

/// Check `~/.gemini/antigravity-cli/settings.json` for a configured
/// `modelProvider` (matches Orca's `agyUsesApiKey`).
pub fn agy_uses_api_key(home: Option<&Path>) -> bool {
    let Some(home) = home else {
        return false;
    };
    let path = home
        .join(".gemini")
        .join("antigravity-cli")
        .join("settings.json");
    let Ok(text) = std::fs::read_to_string(path) else {
        return false;
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(val) => val
            .get("modelProvider")
            .is_some_and(|provider| match provider {
                Value::Null => false,
                Value::Bool(b) => *b,
                Value::String(s) => !s.trim().is_empty(),
                _ => true,
            }),
        Err(_) => true,
    }
}

pub fn build_acp_initialize_request(id: i64, client_version: &str) -> AcpRpcRequest {
    AcpRpcRequest {
        id: AcpRpcId::Integer(id),
        method: "initialize".to_string(),
        params: Some(json!({
            "protocolVersion": ACP_PROTOCOL_VERSION,
            "clientCapabilities": {
                "fs": {
                    "readTextFile": false,
                    "writeTextFile": false,
                },
                "terminal": false,
                "elicitation": {
                    "form": {},
                },
            },
            "clientInfo": {
                "name": "claudette",
                "title": "Claudette",
                "version": client_version,
            },
        })),
    }
}

fn parse_acp_capabilities(result: &Value) -> AcpCapabilities {
    let caps = result.get("agentCapabilities");
    let load_session = caps
        .and_then(|c| c.get("loadSession").or_else(|| c.get("load_session")))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let session_caps = caps.and_then(|c| {
        c.get("sessionCapabilities")
            .or_else(|| c.get("session_capabilities"))
    });
    let resume_session = session_caps
        .and_then(|s| s.get("resume"))
        .is_some_and(|v| !v.is_null());
    let accepts_images = caps
        .and_then(|c| c.get("promptCapabilities"))
        .and_then(|p| p.get("image"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let supports_system_prompt_append = caps
        .and_then(|c| c.get("_meta"))
        .and_then(|m| m.get("antigravity"))
        .and_then(|a| a.get("systemPrompt"))
        .and_then(|sp| sp.get("append"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let agent_version = result
        .get("agentInfo")
        .and_then(|info| info.get("version"))
        .and_then(Value::as_str)
        .map(str::to_string);
    AcpCapabilities {
        load_session,
        resume_session,
        accepts_images,
        supports_system_prompt_append,
        agent_version,
    }
}

/// Translate Claudette's `--mcp-config` JSON (`{ "mcpServers": { ... } }`) into
/// the ACP `mcpServers` array expected by `session/new`, `session/resume`, and
/// `session/load`.
pub fn acp_mcp_servers_from_claude_config(mcp_config: Option<&str>) -> Vec<Value> {
    let Some(raw) = mcp_config else {
        return Vec::new();
    };
    let Ok(parsed) = serde_json::from_str::<Value>(raw) else {
        return Vec::new();
    };
    let Some(servers) = parsed
        .get("mcpServers")
        .or_else(|| parsed.get("mcp_servers"))
        .and_then(Value::as_object)
    else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (name, server) in servers {
        let Some(obj) = server.as_object() else {
            continue;
        };
        if let Some(command) = obj.get("command").and_then(Value::as_str) {
            let args: Vec<Value> = obj
                .get("args")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let env: Vec<Value> = obj
                .get("env")
                .and_then(Value::as_object)
                .map(|map| {
                    map.iter()
                        .filter_map(|(k, v)| {
                            v.as_str().map(|val| json!({ "name": k, "value": val }))
                        })
                        .collect()
                })
                .unwrap_or_default();
            out.push(json!({
                "name": name,
                "command": command,
                "args": args,
                "env": env,
            }));
        } else if let Some(url) = obj.get("url").and_then(Value::as_str) {
            let transport = match obj.get("type").and_then(Value::as_str) {
                Some("sse") => "sse",
                _ => "http",
            };
            let headers: Vec<Value> = obj
                .get("headers")
                .and_then(Value::as_object)
                .map(|map| {
                    map.iter()
                        .filter_map(|(k, v)| {
                            v.as_str().map(|val| json!({ "name": k, "value": val }))
                        })
                        .collect()
                })
                .unwrap_or_default();
            out.push(json!({
                "type": transport,
                "name": name,
                "url": url,
                "headers": headers,
            }));
        }
    }
    out
}

pub fn build_acp_prompt_blocks(
    prompt: &str,
    attachments: &[FileAttachment],
    accepts_images: bool,
) -> Result<Vec<Value>, String> {
    let mut blocks = Vec::new();
    if !prompt.is_empty() || attachments.is_empty() {
        blocks.push(json!({
            "type": "text",
            "text": prompt,
        }));
    }
    let mut image_count = 0usize;
    let mut total_image_bytes = 0usize;
    for attachment in attachments {
        if attachment.media_type.starts_with("image/") {
            if !accepts_images {
                return Err(
                    "This Antigravity ACP server does not advertise image attachment support."
                        .to_string(),
                );
            }
            if image_count >= ACP_MAX_IMAGE_COUNT {
                return Err(format!(
                    "Antigravity ACP accepts at most {ACP_MAX_IMAGE_COUNT} images per turn."
                ));
            }
            let len = attachment.data_base64.len();
            if len > ACP_MAX_IMAGE_BASE64_BYTES {
                return Err("Attached image exceeds the 20 MiB ACP attachment limit.".to_string());
            }
            if total_image_bytes + len > ACP_MAX_TOTAL_IMAGE_BASE64_BYTES {
                return Err(
                    "Combined image attachments exceed the ACP message size limit.".to_string(),
                );
            }
            image_count += 1;
            total_image_bytes += len;
            blocks.push(json!({
                "type": "image",
                "mimeType": attachment.media_type,
                "data": attachment.data_base64,
            }));
        } else if let Some(text_content) = attachment.text_content.as_deref() {
            let header = attachment
                .filename
                .as_deref()
                .map(|name| format!("Attached file ({name}):\n"))
                .unwrap_or_default();
            blocks.push(json!({
                "type": "text",
                "text": format!("{header}{text_content}"),
            }));
        } else if let Some(filename) = attachment.filename.as_deref() {
            blocks.push(json!({
                "type": "text",
                "text": format!("Attached file: {filename}"),
            }));
        }
    }
    Ok(blocks)
}

pub fn normalize_antigravity_reasoning_effort(effort: Option<&str>) -> Option<String> {
    match effort.map(str::trim).filter(|e| !e.is_empty()) {
        Some(val @ ("low" | "medium" | "high" | "xhigh")) => Some(val.to_string()),
        Some("max") => Some("xhigh".to_string()),
        Some("auto" | "default") | None => Some("high".to_string()),
        Some(_) => None,
    }
}

/// Split a leveled Antigravity model ID (e.g. `gemini-4-neon-high`) into
/// `("gemini-4-neon", "high")`.
pub fn split_antigravity_level_suffix(model_id: &str) -> Option<(&str, &str)> {
    for suffix in ANTIGRAVITY_EFFORT_SUFFIXES {
        if let Some(prefix) = model_id
            .strip_suffix(suffix)
            .and_then(|s| s.strip_suffix('-'))
            && !prefix.is_empty()
        {
            return Some((prefix, *suffix));
        }
    }
    None
}

/// Parse `agy models` stdout (`<id>\t<Display Name>` or space-aligned columns)
/// into grouped model families, matching Orca's `antigravityModelChoices`:
/// when a model family has >= 2 `<family>-<level>` variants (and the bare
/// family is not itself listed), collapse them into a single family entry whose
/// reasoning level is controlled by Claudette's effort selector.
pub fn parse_agy_model_listing(stdout: &str) -> Vec<AgentBackendModel> {
    let mut raw_models: Vec<(String, String)> = Vec::new();
    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let parsed = if let Some((id, label)) = trimmed.split_once('\t') {
            let id = id.trim();
            let label = label.trim();
            (!id.is_empty() && !label.is_empty() && !label.contains('\t'))
                .then(|| (id.to_string(), label.to_string()))
        } else {
            // Fallback when stdout is space-aligned (2+ spaces between columns).
            let mut parts = trimmed.splitn(2, "  ");
            match (parts.next(), parts.next()) {
                (Some(id), Some(rest)) => {
                    let id = id.trim();
                    let label = rest.trim();
                    (!id.is_empty() && !label.is_empty() && !id.contains(' '))
                        .then(|| (id.to_string(), label.to_string()))
                }
                _ => None,
            }
        };
        if let Some(pair) = parsed {
            raw_models.push(pair);
        }
    }
    group_antigravity_model_families(&raw_models)
}

pub fn group_antigravity_model_families(raw_models: &[(String, String)]) -> Vec<AgentBackendModel> {
    let exact_ids: HashSet<&str> = raw_models.iter().map(|(id, _)| id.as_str()).collect();
    let mut family_counts: HashMap<&str, usize> = HashMap::new();
    for (id, _) in raw_models {
        if let Some((family, _)) = split_antigravity_level_suffix(id)
            && !exact_ids.contains(family)
        {
            *family_counts.entry(family).or_default() += 1;
        }
    }

    let mut seen: HashSet<String> = HashSet::new();
    let mut result = Vec::new();
    for (id, label) in raw_models {
        if let Some((family, _)) = split_antigravity_level_suffix(id)
            && family_counts.get(family).copied().unwrap_or(0) > 1
        {
            if seen.insert(family.to_string()) {
                let clean_label = strip_trailing_parenthetical(label);
                result.push(AgentBackendModel {
                    id: family.to_string(),
                    label: clean_label.to_string(),
                    context_window_tokens: ANTIGRAVITY_DEFAULT_CONTEXT_WINDOW,
                    discovered: true,
                });
            }
        } else if seen.insert(id.clone()) {
            result.push(AgentBackendModel {
                id: id.clone(),
                label: label.clone(),
                context_window_tokens: ANTIGRAVITY_DEFAULT_CONTEXT_WINDOW,
                discovered: true,
            });
        }
    }
    result
}

fn strip_trailing_parenthetical(label: &str) -> &str {
    let trimmed = label.trim_end();
    if let Some(without_close) = trimmed.strip_suffix(')')
        && let Some(open_idx) = without_close.rfind('(')
    {
        let inside = &without_close[open_idx + 1..];
        if !inside.contains('(') && !inside.contains(')') {
            let prefix = without_close[..open_idx].trim_end();
            if !prefix.is_empty() {
                return prefix;
            }
        }
    }
    trimmed
}

fn find_config_option_by_category<'a>(
    options: &'a [Value],
    category: &str,
    fallback_ids: &[&str],
) -> Option<&'a Value> {
    options
        .iter()
        .find(|opt| opt.get("category").and_then(Value::as_str) == Some(category))
        .or_else(|| {
            options.iter().find(|opt| {
                opt.get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| fallback_ids.contains(&id))
            })
        })
}

fn config_option_values(option: &Value) -> Vec<String> {
    option
        .get("options")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            item.get("value")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect()
}

fn resolve_model_config_option(
    config_options: &[Value],
    requested_model: &str,
) -> Option<(String, String, Option<String>)> {
    let opt = find_config_option_by_category(config_options, "model", &["model"])?;
    let id = opt.get("id").and_then(Value::as_str)?.to_string();
    let choices = config_option_values(opt);
    if choices.iter().any(|c| c == requested_model) {
        return Some((id, requested_model.to_string(), None));
    }
    if let Some((family, level)) = split_antigravity_level_suffix(requested_model)
        && choices.iter().any(|c| c == family)
    {
        return Some((id, family.to_string(), Some(level.to_string())));
    }
    None
}

fn resolve_effort_config_option(
    config_options: &[Value],
    requested_effort: &str,
) -> Option<(String, String)> {
    let opt = find_config_option_by_category(
        config_options,
        "thought_level",
        &["thought_level", "thinking_level"],
    )?;
    let id = opt.get("id").and_then(Value::as_str)?.to_string();
    let choices = config_option_values(opt);
    if choices.iter().any(|c| c == requested_effort) {
        return Some((id, requested_effort.to_string()));
    }
    // Graceful downgrade (e.g. `xhigh` -> `high` on models without xhigh).
    if requested_effort == "xhigh" && choices.iter().any(|c| c == "high") {
        return Some((id, "high".to_string()));
    }
    None
}

fn desired_acp_mode_candidates(
    permission_level: AntigravityPermissionLevel,
    plan_mode: bool,
) -> Vec<&'static str> {
    if plan_mode {
        return vec!["plan", "default"];
    }
    match permission_level {
        AntigravityPermissionLevel::Readonly => vec!["default"],
        AntigravityPermissionLevel::Standard => vec!["accept-edits", "auto_edit", "default"],
        AntigravityPermissionLevel::Full => vec!["yolo", "auto", "default"],
    }
}

fn resolve_mode_config_option(
    config_options: &[Value],
    candidates: &[&str],
) -> Option<(String, String)> {
    let opt = find_config_option_by_category(config_options, "mode", &["mode"])?;
    let id = opt.get("id").and_then(Value::as_str)?.to_string();
    let choices = config_option_values(opt);
    for candidate in candidates {
        if choices.iter().any(|c| c == candidate) {
            return Some((id, (*candidate).to_string()));
        }
    }
    None
}

fn resolve_legacy_mode_id(session_result: &Value, candidates: &[&str]) -> Option<String> {
    let modes = session_result
        .get("modes")
        .and_then(|m| m.get("availableModes"))
        .and_then(Value::as_array)?;
    for candidate in candidates {
        if modes
            .iter()
            .any(|m| m.get("id").and_then(Value::as_str) == Some(*candidate))
        {
            return Some((*candidate).to_string());
        }
    }
    None
}

fn acp_init_system_event(session_id: &str) -> AgentEvent {
    AgentEvent::Stream(StreamEvent::System {
        subtype: "init".to_string(),
        session_id: Some(session_id.to_string()),
        state: None,
        detail: None,
        task_id: None,
        tool_use_id: None,
        output_file: None,
        summary: None,
        description: None,
        last_tool_name: None,
        usage: None,
        workflow_progress: None,
        status: None,
        compact_result: None,
        compact_metadata: None,
        command_line: None,
    })
}

/// Detect `agy 1.5+`'s automatic empty-output retry notice (`⚠ Model produced
/// invalid output.`) so retries don't pollute the assistant's text stream.
pub fn is_antigravity_retry_notice(text: &str) -> bool {
    text.trim() == "\u{26a0} Model produced invalid output."
}

/// Parse Antigravity executor/auth notices that arrive as `agent_message_chunk`
/// text before `stopReason: "end_turn"` (Orca `antigravity-dialect.ts` &
/// `antigravity-executor-error.ts`).
pub fn parse_antigravity_turn_failure_notice(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.starts_with("\u{26a0} UNAUTHENTICATED (code 401):") {
        return Some(format!(
            "{ANTIGRAVITY_AUTH_REQUIRED_MESSAGE}\n\nDetails: {trimmed}"
        ));
    }
    if trimmed.starts_with("\u{26a0} agent executor error:") {
        return Some(format_antigravity_executor_error(trimmed));
    }
    if trimmed == "API key not valid. Please pass a valid API key."
        || trimmed.starts_with("Agent execution error: failed to create Gemini client:")
        || trimmed.starts_with(
            "Agent connection was lost and could not be re-established: Failed to rebuild agent:",
        )
    {
        return Some(trimmed.to_string());
    }
    None
}

/// Format `⚠ agent executor error: ... Error NNN, Message: <msg>, Status: <ST>[, Details: ...]`
/// so the user sees Google's clear sentence first.
pub fn format_antigravity_executor_error(notice: &str) -> String {
    if notice.len() > 16_384 {
        return notice.to_string();
    }
    let Some(err_idx) = notice.find("Error ") else {
        return notice.to_string();
    };
    let rest = &notice[err_idx + "Error ".len()..];
    let Some((code, rest)) = rest.split_once(", Message: ") else {
        return notice.to_string();
    };
    if code.len() != 3 || !code.bytes().all(|b| b.is_ascii_digit()) {
        return notice.to_string();
    }
    let Some((raw_message, status_and_details)) = rest.split_once(", Status: ") else {
        return notice.to_string();
    };
    let (status, details) = match status_and_details.split_once(", Details: ") {
        Some((st, det)) => (st.trim(), Some(det.trim())),
        None => (status_and_details.trim(), None),
    };
    let message = raw_message.trim();
    let key_rejected = details.is_some_and(|d| d.contains("reason:API_KEY_"));
    if message.is_empty() {
        format!("Google returned error {code} ({status}).")
    } else if key_rejected {
        format!("Google rejected the API key: {message}")
    } else {
        format!("Google returned an error: {message}")
    }
}

/// Format a JSON-RPC error from `agy acp`, unwrapping Cloud Code Assist JSON
/// envelopes and mapping `-32000` to an actionable sign-in hint.
pub fn format_acp_rpc_error(method: &str, error: &AcpRpcError) -> String {
    if error.error.code == ACP_AUTH_REQUIRED_CODE {
        return ANTIGRAVITY_AUTH_REQUIRED_MESSAGE.to_string();
    }
    let raw_detail = error
        .error
        .data
        .as_ref()
        .and_then(|d| {
            d.as_str()
                .or_else(|| d.get("details").and_then(Value::as_str))
                .or_else(|| d.get("message").and_then(Value::as_str))
        })
        .unwrap_or(error.error.message.as_str());
    if let Some(cloud_msg) = extract_cloud_code_assist_message(raw_detail) {
        return cloud_msg;
    }
    format!("Antigravity ACP `{method}` failed: {raw_detail}")
}

fn extract_cloud_code_assist_message(text: &str) -> Option<String> {
    let prefix = "Cloud Code Assist API error (";
    let rest = text.strip_prefix(prefix)?;
    let (_, after_close) = rest.split_once("):")?;
    let parsed: Value = serde_json::from_str(after_close.trim()).ok()?;
    parsed
        .get("error")
        .and_then(|e| e.get("message"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .map(str::to_string)
}

fn token_usage_from_prompt_result(result: &Value, last_window: Option<u64>) -> Option<TokenUsage> {
    let usage = result.get("usage")?;
    let input_tokens = usage
        .get("inputTokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let output_tokens = usage
        .get("outputTokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let cache_read = usage.get("cachedReadTokens").and_then(Value::as_u64);
    let cache_write = usage.get("cachedWriteTokens").and_then(Value::as_u64);
    let total_tokens = usage.get("totalTokens").and_then(Value::as_u64);
    Some(TokenUsage {
        total_tokens,
        input_tokens,
        output_tokens,
        cache_creation_input_tokens: cache_write,
        cache_read_input_tokens: cache_read,
        model_context_window: last_window,
        iterations: None,
    })
}

async fn route_acp_message(
    pid: u32,
    event_tx: &broadcast::Sender<AgentEvent>,
    pending: &PendingAcpRequests,
    stdin: Option<&AcpStdin>,
    turn_state: &Arc<tokio::sync::Mutex<AcpTurnState>>,
    message: AcpRpcMessage,
) {
    match message {
        AcpRpcMessage::Response(response) => {
            let req = {
                let mut map = pending.lock().await;
                response.id.as_ref().and_then(|id| map.remove(id))
            };
            if let Some(req) = req {
                let _ = req.tx.send(Ok(response));
            }
        }
        AcpRpcMessage::Error(error) => {
            let req = {
                let mut map = pending.lock().await;
                error.id.as_ref().and_then(|id| map.remove(id))
            };
            if let Some(req) = req {
                let _ = req.tx.send(Err(error));
            }
        }
        AcpRpcMessage::Notification(notification) => {
            if notification.method == "session/update"
                && let Some(params) = notification.params.as_ref()
                && let Some(update) = params.get("update")
            {
                let events = handle_acp_session_update(turn_state, update).await;
                for event in events {
                    let _ = event_tx.send(event);
                }
            }
        }
        AcpRpcMessage::Request(request) => match acp_server_request_to_control_event(&request) {
            Ok(Some(event)) => {
                let _ = event_tx.send(event);
            }
            Ok(None) => {
                if let Some(stdin) = stdin {
                    let mut writer = stdin.lock().await;
                    let err_msg = json!({
                        "jsonrpc": "2.0",
                        "id": request.id,
                        "error": {
                            "code": -32601,
                            "message": format!("Antigravity ACP client method `{}` is not implemented", request.method),
                        }
                    });
                    let _ = write_acp_message(&mut *writer, &err_msg).await;
                }
            }
            Err(err) => {
                tracing::warn!(
                    target: "claudette::agent",
                    subsystem = "antigravity-acp",
                    pid,
                    method = %request.method,
                    error = %err,
                    "failed to route Antigravity ACP server request"
                );
                if let Some(stdin) = stdin {
                    let mut writer = stdin.lock().await;
                    let err_msg = json!({
                        "jsonrpc": "2.0",
                        "id": request.id,
                        "error": {
                            "code": -32602,
                            "message": err,
                        }
                    });
                    let _ = write_acp_message(&mut *writer, &err_msg).await;
                }
            }
        },
    }
}

async fn handle_acp_session_update(
    turn_state: &Arc<tokio::sync::Mutex<AcpTurnState>>,
    update: &Value,
) -> Vec<AgentEvent> {
    let kind = update
        .get("sessionUpdate")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match kind {
        "agent_message_chunk" => {
            let Some(text) = update
                .get("content")
                .filter(|c| c.get("type").and_then(Value::as_str) == Some("text"))
                .and_then(|c| c.get("text"))
                .and_then(Value::as_str)
            else {
                return Vec::new();
            };
            if text.is_empty() || is_antigravity_retry_notice(text) {
                return Vec::new();
            }
            if let Some(failure) = parse_antigravity_turn_failure_notice(text) {
                let mut state = turn_state.lock().await;
                state.turn_failure_notice = Some(failure);
                return Vec::new();
            }
            let mut state = turn_state.lock().await;
            state.text.push_str(text);
            vec![AgentEvent::Stream(StreamEvent::Stream {
                event: InnerStreamEvent::ContentBlockDelta {
                    index: 0,
                    delta: Delta::Text {
                        text: text.to_string(),
                    },
                },
            })]
        }
        "agent_thought_chunk" => {
            let Some(thinking) = update
                .get("content")
                .filter(|c| c.get("type").and_then(Value::as_str) == Some("text"))
                .and_then(|c| c.get("text"))
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            else {
                return Vec::new();
            };
            let mut state = turn_state.lock().await;
            state.thinking.push_str(thinking);
            vec![AgentEvent::Stream(StreamEvent::Stream {
                event: InnerStreamEvent::ContentBlockDelta {
                    index: 1,
                    delta: Delta::Thinking {
                        thinking: thinking.to_string(),
                    },
                },
            })]
        }
        "tool_call" | "tool_call_update" => {
            let Some(tool_call_id) = update
                .get("toolCallId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
            else {
                return Vec::new();
            };
            let mut events = Vec::new();
            let mut state = turn_state.lock().await;
            let tool_name = resolve_acp_tool_name(
                update,
                state.tool_names.get(tool_call_id).map(String::as_str),
            );
            state
                .tool_names
                .insert(tool_call_id.to_string(), tool_name.clone());

            let normalized_input = normalize_acp_tool_input(update);
            if let Some(input) = normalized_input {
                state.tool_inputs.insert(tool_call_id.to_string(), input);
            }

            if state.started_tools.insert(tool_call_id.to_string()) {
                events.extend(state.drain_text_and_thinking());
                let input = state
                    .tool_inputs
                    .get(tool_call_id)
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                let index = acp_tool_block_index(tool_call_id);
                events.push(AgentEvent::Stream(StreamEvent::Stream {
                    event: InnerStreamEvent::ContentBlockStart {
                        index,
                        content_block: Some(StartContentBlock::ToolUse {
                            id: tool_call_id.to_string(),
                            name: tool_name,
                            input: None,
                        }),
                    },
                }));
                events.push(AgentEvent::Stream(StreamEvent::Stream {
                    event: InnerStreamEvent::ContentBlockDelta {
                        index,
                        delta: Delta::ToolUse {
                            partial_json: Some(input.to_string()),
                        },
                    },
                }));
                events.push(AgentEvent::Stream(StreamEvent::Stream {
                    event: InnerStreamEvent::ContentBlockStop { index },
                }));
            }

            let status = update.get("status").and_then(Value::as_str);
            if matches!(status, Some("completed" | "failed")) {
                let output = extract_acp_tool_output(update).unwrap_or_default();
                let is_error = status == Some("failed")
                    || extract_acp_exit_code(update).is_some_and(|code| code != 0);
                events.push(AgentEvent::Stream(StreamEvent::User {
                    message: UserEventMessage {
                        content: UserMessageContent::Blocks(vec![UserContentBlock::ToolResult {
                            tool_use_id: tool_call_id.to_string(),
                            content: Value::String(output),
                            is_error: Some(is_error),
                        }]),
                    },
                    uuid: None,
                    is_replay: false,
                    is_synthetic: true,
                }));
            }
            events
        }
        "usage_update" => {
            let used = update.get("used").and_then(Value::as_u64).unwrap_or(0);
            let size = update.get("size").and_then(Value::as_u64);
            let mut state = turn_state.lock().await;
            if let Some(s) = size
                && s > 0
            {
                state.last_context_window = Some(s);
            }
            let usage = TokenUsage {
                total_tokens: Some(used),
                input_tokens: used,
                output_tokens: 0,
                cache_creation_input_tokens: None,
                cache_read_input_tokens: None,
                model_context_window: size.filter(|&s| s > 0).or(state.last_context_window),
                iterations: None,
            };
            vec![AgentEvent::Stream(StreamEvent::Stream {
                event: InnerStreamEvent::MessageDelta { usage: Some(usage) },
            })]
        }
        "plan" => {
            let Some(entries) = update.get("entries").and_then(Value::as_array) else {
                return Vec::new();
            };
            let todos: Vec<Value> = entries
                .iter()
                .filter_map(|entry| {
                    let content = entry.get("content").and_then(Value::as_str)?.trim();
                    if content.is_empty() {
                        return None;
                    }
                    let status = entry
                        .get("status")
                        .and_then(Value::as_str)
                        .unwrap_or("pending");
                    Some(json!({
                        "content": content,
                        "status": status,
                    }))
                })
                .collect();
            if todos.is_empty() {
                return Vec::new();
            }
            let input = json!({ "todos": todos });
            let tool_use_id = "antigravity-plan".to_string();
            let index = acp_tool_block_index(&tool_use_id);
            vec![
                AgentEvent::Stream(StreamEvent::Stream {
                    event: InnerStreamEvent::ContentBlockStart {
                        index,
                        content_block: Some(StartContentBlock::ToolUse {
                            id: tool_use_id.clone(),
                            name: "TodoWrite".to_string(),
                            input: None,
                        }),
                    },
                }),
                AgentEvent::Stream(StreamEvent::Stream {
                    event: InnerStreamEvent::ContentBlockDelta {
                        index,
                        delta: Delta::ToolUse {
                            partial_json: Some(input.to_string()),
                        },
                    },
                }),
                AgentEvent::Stream(StreamEvent::Stream {
                    event: InnerStreamEvent::ContentBlockStop { index },
                }),
                AgentEvent::Stream(StreamEvent::User {
                    message: UserEventMessage {
                        content: UserMessageContent::Blocks(vec![UserContentBlock::ToolResult {
                            tool_use_id,
                            content: Value::String("Plan updated".to_string()),
                            is_error: None,
                        }]),
                    },
                    uuid: None,
                    is_replay: false,
                    is_synthetic: true,
                }),
            ]
        }
        _ => Vec::new(),
    }
}

fn acp_tool_block_index(tool_call_id: &str) -> usize {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    tool_call_id.hash(&mut hasher);
    // Avoid colliding with text (0) and thinking (1) stream indices.
    2 + (hasher.finish() as usize % 10_000)
}

fn resolve_acp_tool_name(update: &Value, previous: Option<&str>) -> String {
    match update.get("kind").and_then(Value::as_str) {
        Some("execute") => return "Bash".to_string(),
        Some("read") => return "Read".to_string(),
        Some("edit") => return "Edit".to_string(),
        Some("search") => return "Grep".to_string(),
        Some("fetch") => return "WebFetch".to_string(),
        _ => {}
    }
    update
        .get("name")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .or(previous)
        .or_else(|| {
            update
                .get("title")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
        })
        .or_else(|| update.get("kind").and_then(Value::as_str))
        .unwrap_or("tool")
        .to_string()
}

/// Normalize Antigravity's `rawInput` command/path variants and `diff` content
/// blocks into shapes Claudette's `ToolActivityRow` renders cleanly.
pub fn normalize_acp_tool_input(update: &Value) -> Option<Value> {
    // Check for diff blocks first so edit summaries render inline diffs.
    if let Some(content) = update.get("content").and_then(Value::as_array) {
        for block in content {
            if block.get("type").and_then(Value::as_str) == Some("diff")
                && let Some(path) = block.get("path").and_then(Value::as_str)
            {
                let old_text = block
                    .get("oldText")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let new_text = block
                    .get("newText")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                return Some(json!({
                    "file_path": path,
                    "old_string": old_text,
                    "new_string": new_text,
                }));
            }
        }
    }

    let raw_input = update.get("rawInput")?;
    if let Some(obj) = raw_input.as_object() {
        let command = first_string_field(
            obj,
            &["CommandLine", "command_line", "commandLine", "command"],
        );
        let cwd = first_string_field(
            obj,
            &[
                "Cwd",
                "WorkingDirectory",
                "working_dir",
                "workingDir",
                "cwd",
            ],
        );
        if let Some(command) = command {
            let mut normalized = serde_json::Map::new();
            normalized.insert("command".to_string(), Value::String(command));
            if let Some(cwd) = cwd {
                normalized.insert("cwd".to_string(), Value::String(cwd));
            }
            return Some(Value::Object(normalized));
        }
        let file_path = first_string_field(
            obj,
            &[
                "file_path",
                "filePath",
                "TargetFile",
                "target_file",
                "path",
                "Path",
            ],
        );
        if let Some(path) = file_path {
            let mut normalized = obj.clone();
            normalized
                .entry("file_path".to_string())
                .or_insert_with(|| Value::String(path));
            return Some(Value::Object(normalized));
        }
    }
    Some(raw_input.clone())
}

fn extract_acp_exit_code(update: &Value) -> Option<i64> {
    let raw_output = update.get("rawOutput")?.as_object()?;
    raw_output
        .get("exitCode")
        .or_else(|| raw_output.get("exit_code"))
        .and_then(Value::as_i64)
}

pub fn extract_acp_tool_output(update: &Value) -> Option<String> {
    if let Some(content) = update.get("content").and_then(Value::as_array) {
        let texts: Vec<&str> = content
            .iter()
            .filter_map(|block| {
                if block.get("type").and_then(Value::as_str) == Some("content") {
                    let inner = block.get("content")?;
                    if inner.get("type").and_then(Value::as_str) == Some("text") {
                        return inner.get("text").and_then(Value::as_str);
                    }
                }
                None
            })
            .collect();
        if !texts.is_empty() {
            return Some(texts.join("\n"));
        }
    }
    let raw_output = update.get("rawOutput")?;
    if let Some(s) = raw_output.as_str() {
        return Some(s.to_string());
    }
    if let Some(obj) = raw_output.as_object() {
        if let Some(combined) = first_string_field(obj, &["combinedOutput", "combined_output"]) {
            return Some(combined);
        }
        let stdout = obj.get("stdout").and_then(Value::as_str);
        let stderr = obj.get("stderr").and_then(Value::as_str);
        if stdout.is_some() || stderr.is_some() {
            let mut parts = Vec::new();
            if let Some(s) = stdout
                && !s.is_empty()
            {
                parts.push(s);
            }
            if let Some(s) = stderr
                && !s.is_empty()
            {
                parts.push(s);
            }
            return Some(parts.join("\n"));
        }
    }
    serde_json::to_string(raw_output).ok()
}

fn first_string_field(obj: &serde_json::Map<String, Value>, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(val) = obj.get(*key).and_then(Value::as_str)
            && !val.trim().is_empty()
        {
            return Some(val.to_string());
        }
    }
    None
}

/// Convert an incoming ACP client request (`session/request_permission` or
/// `elicitation/create`) into Claudette's `StreamEvent::ControlRequest`.
pub fn acp_server_request_to_control_event(
    request: &AcpRpcRequest,
) -> Result<Option<AgentEvent>, String> {
    let request_id = serde_json::to_string(&request.id)
        .map_err(|e| format!("Failed to encode ACP request id: {e}"))?;
    let params = request.params.as_ref().unwrap_or(&Value::Null);

    match request.method.as_str() {
        "session/request_permission" => {
            let tool_call = params.get("toolCall").unwrap_or(&Value::Null);
            let tool_call_id = tool_call
                .get("toolCallId")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .unwrap_or(&request_id)
                .to_string();
            let options = params
                .get("options")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();

            // Formless servers ask user questions via `interaction_*` permission
            // requests. Map to AskUserQuestion so they are never auto-approved.
            if tool_call_id.starts_with("interaction_") {
                let question_text = tool_call
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("Question");
                let q_options: Vec<Value> = options
                    .iter()
                    .filter_map(|opt| {
                        let option_id = opt.get("optionId").and_then(Value::as_str)?;
                        let name = opt.get("name").and_then(Value::as_str).unwrap_or(option_id);
                        Some(json!({
                            "label": name,
                            "description": option_id,
                        }))
                    })
                    .collect();
                let input = json!({
                    "acpMethod": "session/request_permission",
                    "acpOptions": options,
                    "questions": [{
                        "id": "interaction",
                        "header": "Antigravity",
                        "question": question_text,
                        "options": q_options,
                    }],
                });
                return Ok(Some(AgentEvent::Stream(StreamEvent::ControlRequest {
                    request_id,
                    request: ControlRequestInner::CanUseTool {
                        tool_name: "AskUserQuestion".to_string(),
                        tool_use_id: tool_call_id,
                        input,
                    },
                })));
            }

            let kind = tool_call.get("kind").and_then(Value::as_str).unwrap_or("");
            let (tool_name, approval_kind) = match kind {
                "execute" => (CODEX_COMMAND_APPROVAL_TOOL, "commandExecution"),
                "edit" | "delete" | "move" => (CODEX_FILE_CHANGE_APPROVAL_TOOL, "fileChange"),
                _ => (CODEX_PERMISSIONS_APPROVAL_TOOL, "permissions"),
            };

            let mut input = serde_json::Map::new();
            input.insert(
                "acpMethod".to_string(),
                Value::String("session/request_permission".to_string()),
            );
            input.insert("acpOptions".to_string(), Value::Array(options.clone()));
            input.insert(
                "codexApprovalKind".to_string(),
                Value::String(approval_kind.to_string()),
            );
            input.insert(
                "codexAgentLabel".to_string(),
                Value::String("Antigravity".to_string()),
            );

            if let Some(norm) = normalize_acp_tool_input(tool_call)
                && let Some(obj) = norm.as_object()
            {
                if let Some(cmd) = obj.get("command").and_then(Value::as_str) {
                    input.insert("command".to_string(), Value::String(cmd.to_string()));
                }
                if let Some(cwd) = obj.get("cwd").and_then(Value::as_str) {
                    input.insert("cwd".to_string(), Value::String(cwd.to_string()));
                }
                if let Some(path) = obj.get("file_path").and_then(Value::as_str) {
                    input.insert("path".to_string(), Value::String(path.to_string()));
                }
                if let Some(old_s) = obj.get("old_string").and_then(Value::as_str) {
                    input.insert("oldText".to_string(), Value::String(old_s.to_string()));
                }
                if let Some(new_s) = obj.get("new_string").and_then(Value::as_str) {
                    input.insert("newText".to_string(), Value::String(new_s.to_string()));
                }
            }

            let security_warning = extract_agy_security_warning(&options);
            let title = tool_call
                .get("title")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty());
            let reason = match (title, security_warning) {
                (Some(t), Some(w)) => Some(format!("{t}\n{w}")),
                (Some(t), None) => Some(t.to_string()),
                (None, Some(w)) => Some(w),
                (None, None) => None,
            };
            if let Some(reason) = reason {
                input.insert("reason".to_string(), Value::String(reason));
            }

            Ok(Some(AgentEvent::Stream(StreamEvent::ControlRequest {
                request_id,
                request: ControlRequestInner::CanUseTool {
                    tool_name: tool_name.to_string(),
                    tool_use_id: tool_call_id,
                    input: Value::Object(input),
                },
            })))
        }
        "elicitation/create" => {
            if params.get("mode").and_then(Value::as_str) != Some("form") {
                return Ok(None);
            }
            let message = params
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let suppress_message = is_generic_question_form_message(message);
            let Some(properties) = params
                .get("requestedSchema")
                .and_then(|s| s.get("properties"))
                .and_then(Value::as_object)
            else {
                return Err("ACP elicitation form missing requestedSchema.properties".to_string());
            };

            let mut questions = Vec::new();
            let mut field_meta = Vec::new();
            for (idx, (key, prop)) in properties.iter().enumerate() {
                let prop_type = prop.get("type").and_then(Value::as_str).unwrap_or("string");
                let title = prop.get("title").and_then(Value::as_str).unwrap_or(key);
                let desc = prop.get("description").and_then(Value::as_str);
                let q_text = if !suppress_message && idx == 0 && !message.is_empty() {
                    format!("{message}\n\n{title}")
                } else if let Some(d) = desc {
                    format!("{title}\n{d}")
                } else {
                    title.to_string()
                };
                let mut options = Vec::new();
                if prop_type == "boolean" {
                    options.push(json!({ "label": "Yes", "description": "true" }));
                    options.push(json!({ "label": "No", "description": "false" }));
                } else if let Some(one_of) = prop.get("oneOf").and_then(Value::as_array) {
                    for choice in one_of {
                        if let Some(val) = choice.get("const").and_then(Value::as_str) {
                            let label = choice.get("title").and_then(Value::as_str).unwrap_or(val);
                            let cdesc = choice
                                .get("description")
                                .and_then(Value::as_str)
                                .unwrap_or("");
                            options.push(
                                json!({ "label": label, "description": cdesc, "value": val }),
                            );
                        }
                    }
                } else if let Some(enums) = prop.get("enum").and_then(Value::as_array) {
                    for val in enums.iter().filter_map(Value::as_str) {
                        options.push(json!({ "label": val, "description": "" }));
                    }
                }
                questions.push(json!({
                    "id": key,
                    "header": title,
                    "question": q_text,
                    "multiSelect": prop_type == "array",
                    "options": options,
                }));
                field_meta.push(json!({
                    "key": key,
                    "question": q_text,
                    "type": prop_type,
                    "options": options,
                }));
            }
            if questions.is_empty() {
                return Ok(None);
            }
            let tool_use_id = format!("acp-elicit-{request_id}");
            let input = json!({
                "acpMethod": "elicitation/create",
                "acpFieldMeta": field_meta,
                "questions": questions,
            });
            Ok(Some(AgentEvent::Stream(StreamEvent::ControlRequest {
                request_id,
                request: ControlRequestInner::CanUseTool {
                    tool_name: "AskUserQuestion".to_string(),
                    tool_use_id,
                    input,
                },
            })))
        }
        _ => Ok(None),
    }
}

fn is_generic_question_form_message(message: &str) -> bool {
    let trimmed = message.trim();
    if trimmed == "The agent has a question." {
        return true;
    }
    trimmed
        .strip_prefix("The agent has ")
        .and_then(|rest| rest.strip_suffix(" questions."))
        .is_some_and(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
}

fn extract_agy_security_warning(options: &[Value]) -> Option<String> {
    for opt in options {
        let Some(warning) = opt
            .get("_meta")
            .and_then(|m| m.get("agy.security.warning"))
            .and_then(Value::as_object)
        else {
            continue;
        };
        let text = warning
            .get("message")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .or_else(|| {
                warning
                    .get("title")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
            });
        if let Some(text) = text {
            return Some(text.chars().take(WARNING_MAX_CHARS).collect());
        }
    }
    None
}

/// True when `original_input` belongs to an Antigravity ACP control request.
pub fn is_antigravity_acp_control_input(original_input: &Value) -> bool {
    original_input
        .get("acpMethod")
        .and_then(Value::as_str)
        .is_some()
}

/// Build the `send_control_response` payload for an Antigravity ACP approval.
pub fn build_antigravity_approval_response_payload(
    original_input: &Value,
    approved: bool,
) -> Result<Value, String> {
    let options = original_input
        .get("acpOptions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let preferred_kinds: &[&str] = if approved {
        &["allow_once", "allow_always"]
    } else {
        &["reject_once", "reject_always"]
    };
    let selected_id = preferred_kinds.iter().find_map(|wanted| {
        options.iter().find_map(|opt| {
            (opt.get("kind").and_then(Value::as_str) == Some(*wanted))
                .then(|| opt.get("optionId").and_then(Value::as_str))
                .flatten()
                .map(str::to_string)
        })
    });
    let outcome = match selected_id {
        Some(option_id) => json!({
            "outcome": "selected",
            "optionId": option_id,
        }),
        None if approved => {
            if let Some(first_id) = options
                .first()
                .and_then(|o| o.get("optionId"))
                .and_then(Value::as_str)
            {
                json!({ "outcome": "selected", "optionId": first_id })
            } else {
                json!({ "outcome": "cancelled" })
            }
        }
        None => json!({ "outcome": "cancelled" }),
    };
    Ok(json!({
        "acpMethod": "session/request_permission",
        "response": {
            "outcome": outcome,
        },
    }))
}

/// Build the `send_control_response` payload for an Antigravity ACP question
/// (`elicitation/create` form or `interaction_*` permission request).
pub fn build_antigravity_user_input_response_payload(
    original_input: &Value,
    answers: &HashMap<String, String>,
) -> Result<Value, String> {
    let method = original_input
        .get("acpMethod")
        .and_then(Value::as_str)
        .ok_or_else(|| "Antigravity ACP user-input payload is missing acpMethod".to_string())?;
    match method {
        "session/request_permission" => {
            let options = original_input
                .get("acpOptions")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let chosen = answers.values().next().map(|s| s.trim());
            let option_id = chosen.and_then(|answer| {
                options.iter().find_map(|opt| {
                    let oid = opt.get("optionId").and_then(Value::as_str)?;
                    let name = opt.get("name").and_then(Value::as_str).unwrap_or(oid);
                    (name == answer || oid == answer).then(|| oid.to_string())
                })
            });
            let outcome = match option_id {
                Some(id) => json!({ "outcome": "selected", "optionId": id }),
                None => json!({ "outcome": "cancelled" }),
            };
            Ok(json!({
                "acpMethod": method,
                "response": { "outcome": outcome },
            }))
        }
        "elicitation/create" => {
            let mut content = serde_json::Map::new();
            if let Some(fields) = original_input.get("acpFieldMeta").and_then(Value::as_array) {
                for field in fields {
                    let Some(key) = field.get("key").and_then(Value::as_str) else {
                        continue;
                    };
                    let Some(q_text) = field.get("question").and_then(Value::as_str) else {
                        continue;
                    };
                    let Some(answer) = answers.get(q_text).or_else(|| answers.get(key)) else {
                        continue;
                    };
                    let prop_type = field
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or("string");
                    let value = match prop_type {
                        "boolean" => {
                            let lower = answer.trim().to_ascii_lowercase();
                            Value::Bool(matches!(lower.as_str(), "yes" | "true" | "1"))
                        }
                        "array" => Value::Array(
                            answer
                                .split(',')
                                .map(str::trim)
                                .filter(|s| !s.is_empty())
                                .map(|s| Value::String(s.to_string()))
                                .collect(),
                        ),
                        _ => {
                            let mapped = field
                                .get("options")
                                .and_then(Value::as_array)
                                .and_then(|opts| {
                                    opts.iter().find_map(|opt| {
                                        (opt.get("label").and_then(Value::as_str)
                                            == Some(answer.as_str()))
                                        .then(|| opt.get("value").and_then(Value::as_str))
                                        .flatten()
                                    })
                                })
                                .unwrap_or(answer.as_str());
                            Value::String(mapped.to_string())
                        }
                    };
                    content.insert(key.to_string(), value);
                }
            }
            Ok(json!({
                "acpMethod": method,
                "response": {
                    "action": "accept",
                    "content": Value::Object(content),
                },
            }))
        }
        _ => Err(format!(
            "Unsupported Antigravity ACP user-input method `{method}`"
        )),
    }
}

pub fn build_acp_server_response_from_control_response(
    request_id: &str,
    response: Value,
) -> Result<Value, String> {
    let id = serde_json::from_str::<AcpRpcId>(request_id)
        .map_err(|e| format!("Invalid Antigravity ACP server request id `{request_id}`: {e}"))?;
    if let Some(payload) = response.get("response").cloned() {
        return Ok(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": payload,
        }));
    }
    // Generic deny/cancel fallback (e.g. when draining pending permissions on Stop).
    Ok(json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": { "outcome": { "outcome": "cancelled" } },
    }))
}

fn json_rpc_request_value(request: &AcpRpcRequest) -> Value {
    let mut obj = serde_json::Map::new();
    obj.insert("jsonrpc".to_string(), Value::String("2.0".to_string()));
    obj.insert(
        "id".to_string(),
        serde_json::to_value(&request.id).unwrap_or(Value::Null),
    );
    obj.insert("method".to_string(), Value::String(request.method.clone()));
    if let Some(params) = &request.params {
        obj.insert("params".to_string(), params.clone());
    }
    Value::Object(obj)
}

fn json_rpc_notification_value(notification: &AcpRpcNotification) -> Value {
    let mut obj = serde_json::Map::new();
    obj.insert("jsonrpc".to_string(), Value::String("2.0".to_string()));
    obj.insert(
        "method".to_string(),
        Value::String(notification.method.clone()),
    );
    if let Some(params) = &notification.params {
        obj.insert("params".to_string(), params.clone());
    }
    Value::Object(obj)
}

async fn write_acp_message<W: AsyncWrite + Unpin>(
    writer: &mut W,
    value: &Value,
) -> Result<(), String> {
    let mut line = serde_json::to_string(value)
        .map_err(|e| format!("Failed to serialize Antigravity ACP JSON-RPC message: {e}"))?;
    line.push('\n');
    writer
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("Failed to write Antigravity ACP message: {e}"))?;
    writer
        .flush()
        .await
        .map_err(|e| format!("Failed to flush Antigravity ACP stdin: {e}"))
}

async fn read_acp_message<R: AsyncBufRead + Unpin>(
    reader: &mut R,
) -> Result<Option<AcpRpcMessage>, String> {
    let mut line = String::new();
    let mut skipped_preamble_lines = 0usize;
    loop {
        line.clear();
        let bytes = reader
            .read_line(&mut line)
            .await
            .map_err(|e| format!("Failed to read Antigravity ACP stdout: {e}"))?;
        if bytes == 0 {
            return Ok(None);
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if !trimmed.starts_with('{') {
            skipped_preamble_lines += 1;
            if skipped_preamble_lines > MAX_ACP_STDOUT_PREAMBLE_LINES {
                return Err(format!(
                    "Antigravity ACP stdout produced too many non-JSON lines; last: {trimmed}"
                ));
            }
            continue;
        }
        return serde_json::from_str::<AcpRpcMessage>(trimmed)
            .map(Some)
            .map_err(|e| format!("Failed to parse Antigravity ACP JSON-RPC line: {e}"));
    }
}

async fn fail_pending_requests(pending: &PendingAcpRequests, reason: &str) {
    let drained = {
        let mut map = pending.lock().await;
        std::mem::take(&mut *map)
    };
    for (id, request) in drained {
        let _ = request.tx.send(Err(AcpRpcError {
            id: Some(id),
            error: AcpRpcErrorBody {
                code: -32001,
                message: reason.to_string(),
                data: Some(json!({ "method": request.method })),
            },
        }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_agy_model_listing_groups_multi_level_families_and_keeps_singletons() {
        let stdout = "\
gemini-4-neon-high\tGemini 4 Neon (High)\n\
gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)\n\
gemini-4-neon-medium\tGemini 4 Neon (Medium)\n\
gemini-4-neon-low\tGemini 4 Neon (Low)\n\
gemini-pro-orchestrator-neon\tOrchestrator (Neon)\n\
claude-opus-5-5-high\tClaude Opus 5.5 (High)\n\
claude-opus-5-5-low\tClaude Opus 5.5 (Low)\n\
gpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n";
        let models = parse_agy_model_listing(stdout);
        let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
        let labels: Vec<&str> = models.iter().map(|m| m.label.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "gemini-4-neon",
                "gemini-pro-orchestrator-neon",
                "claude-opus-5-5",
                "gpt-oss-120b-medium",
            ]
        );
        assert_eq!(
            labels,
            vec![
                "Gemini 4 Neon",
                "Orchestrator (Neon)",
                "Claude Opus 5.5",
                "GPT-OSS 120B (Medium)",
            ]
        );
        assert!(
            models
                .iter()
                .all(|m| m.context_window_tokens == ANTIGRAVITY_DEFAULT_CONTEXT_WINDOW)
        );
    }

    #[test]
    fn resolves_model_and_effort_config_options_across_agy_versions() {
        let v14 = vec![
            json!({
                "id": "model",
                "category": "model",
                "options": [{ "value": "gemini-3.8-flash" }, { "value": "gemini-3.1-pro" }]
            }),
            json!({
                "id": "thinking_level",
                "category": "thought_level",
                "options": [{ "value": "low" }, { "value": "high" }]
            }),
        ];
        assert_eq!(
            resolve_model_config_option(&v14, "gemini-3.8-flash-high"),
            Some((
                "model".to_string(),
                "gemini-3.8-flash".to_string(),
                Some("high".to_string()),
            ))
        );
        assert_eq!(
            resolve_effort_config_option(&v14, "xhigh"),
            Some(("thinking_level".to_string(), "high".to_string()))
        );

        let v15 = vec![json!({
            "id": "thought_level",
            "category": "thought_level",
            "options": [{ "value": "low" }, { "value": "medium" }, { "value": "high" }, { "value": "xhigh" }]
        })];
        assert_eq!(
            resolve_effort_config_option(&v15, "xhigh"),
            Some(("thought_level".to_string(), "xhigh".to_string()))
        );
    }

    #[test]
    fn intercepts_retry_and_failure_notices_and_formats_executor_errors() {
        assert!(is_antigravity_retry_notice(
            "\n\u{26a0} Model produced invalid output.\n"
        ));
        assert!(!is_antigravity_retry_notice("Hello world"));

        let api_err = "\u{26a0} agent executor error: generating and executing: Error 400, Message: API key not valid., Status: INVALID_ARGUMENT, Details: [map[reason:API_KEY_INVALID]]";
        let formatted = parse_antigravity_turn_failure_notice(api_err).expect("should match");
        assert_eq!(formatted, "Google rejected the API key: API key not valid.");

        let unauth = "\u{26a0} UNAUTHENTICATED (code 401): token expired";
        let formatted_unauth = parse_antigravity_turn_failure_notice(unauth).expect("should match");
        assert!(formatted_unauth.contains("Antigravity is not authenticated"));
    }

    #[test]
    fn unwraps_cloud_code_assist_rpc_errors_and_auth_code() {
        let auth_err = AcpRpcError {
            id: Some(AcpRpcId::Integer(1)),
            error: AcpRpcErrorBody {
                code: -32000,
                message: "Authentication required".to_string(),
                data: None,
            },
        };
        assert_eq!(
            format_acp_rpc_error("session/new", &auth_err),
            ANTIGRAVITY_AUTH_REQUIRED_MESSAGE
        );

        let cca_err = AcpRpcError {
            id: Some(AcpRpcId::Integer(2)),
            error: AcpRpcErrorBody {
                code: -32603,
                message: r#"Cloud Code Assist API error (429): {"error":{"message":"Quota exceeded for model."}}"#.to_string(),
                data: None,
            },
        };
        assert_eq!(
            format_acp_rpc_error("session/prompt", &cca_err),
            "Quota exceeded for model."
        );
    }

    #[test]
    fn normalizes_antigravity_command_tool_fields_and_output() {
        let update = json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "call-1",
            "kind": "execute",
            "rawInput": {
                "CommandLine": "cargo test",
                "WorkingDirectory": "/tmp/repo"
            },
            "rawOutput": {
                "combinedOutput": "ok",
                "exit_code": 0
            }
        });
        assert_eq!(resolve_acp_tool_name(&update, None), "Bash");
        assert_eq!(
            normalize_acp_tool_input(&update),
            Some(json!({ "command": "cargo test", "cwd": "/tmp/repo" }))
        );
        assert_eq!(extract_acp_tool_output(&update).as_deref(), Some("ok"));
        assert_eq!(extract_acp_exit_code(&update), Some(0));
    }

    #[test]
    fn translates_mcp_servers_stdio_and_http_to_acp_array() {
        let cfg = r#"{
            "mcpServers": {
                "claudette": {
                    "command": "/bin/claudette",
                    "args": ["--mcp"],
                    "env": { "TOKEN": "abc" }
                },
                "remote": {
                    "type": "sse",
                    "url": "https://example.com/sse",
                    "headers": { "Authorization": "Bearer xyz" }
                }
            }
        }"#;
        let servers = acp_mcp_servers_from_claude_config(Some(cfg));
        assert_eq!(servers.len(), 2);
        let stdio = servers
            .iter()
            .find(|s| s.get("name").and_then(Value::as_str) == Some("claudette"))
            .unwrap();
        assert_eq!(
            stdio.get("command").and_then(Value::as_str),
            Some("/bin/claudette")
        );
        assert_eq!(
            stdio.get("env").and_then(Value::as_array).unwrap()[0],
            json!({ "name": "TOKEN", "value": "abc" })
        );
        let sse = servers
            .iter()
            .find(|s| s.get("name").and_then(Value::as_str) == Some("remote"))
            .unwrap();
        assert_eq!(sse.get("type").and_then(Value::as_str), Some("sse"));
        assert_eq!(
            sse.get("headers").and_then(Value::as_array).unwrap()[0],
            json!({ "name": "Authorization", "value": "Bearer xyz" })
        );
    }

    #[test]
    fn permission_request_routes_interaction_as_question_and_execute_as_approval() {
        let q_req = AcpRpcRequest {
            id: AcpRpcId::Integer(5),
            method: "session/request_permission".to_string(),
            params: Some(json!({
                "sessionId": "s1",
                "toolCall": { "toolCallId": "interaction_1", "title": "Continue?" },
                "options": [
                    { "optionId": "yes", "name": "Yes", "kind": "allow_once" },
                    { "optionId": "no", "name": "No", "kind": "reject_once" }
                ]
            })),
        };
        let ev = acp_server_request_to_control_event(&q_req)
            .unwrap()
            .expect("should produce control request");
        match ev {
            AgentEvent::Stream(StreamEvent::ControlRequest {
                request:
                    ControlRequestInner::CanUseTool {
                        tool_name, input, ..
                    },
                ..
            }) => {
                assert_eq!(tool_name, "AskUserQuestion");
                let mut answers = HashMap::new();
                answers.insert("Continue?".to_string(), "Yes".to_string());
                let reply =
                    build_antigravity_user_input_response_payload(&input, &answers).unwrap();
                assert_eq!(
                    reply["response"]["outcome"],
                    json!({ "outcome": "selected", "optionId": "yes" })
                );
            }
            other => panic!("unexpected event: {other:?}"),
        }

        let exec_req = AcpRpcRequest {
            id: AcpRpcId::Integer(6),
            method: "session/request_permission".to_string(),
            params: Some(json!({
                "sessionId": "s1",
                "toolCall": {
                    "toolCallId": "call_9",
                    "kind": "execute",
                    "title": "Run tests",
                    "rawInput": { "CommandLine": "cargo test" }
                },
                "options": [
                    {
                        "optionId": "allow_1",
                        "name": "Allow once",
                        "kind": "allow_once",
                        "_meta": { "agy.security.warning": { "message": "Modifies workspace" } }
                    },
                    { "optionId": "deny_1", "name": "Reject", "kind": "reject_once" }
                ]
            })),
        };
        let ev = acp_server_request_to_control_event(&exec_req)
            .unwrap()
            .expect("should produce approval");
        match ev {
            AgentEvent::Stream(StreamEvent::ControlRequest {
                request:
                    ControlRequestInner::CanUseTool {
                        tool_name, input, ..
                    },
                ..
            }) => {
                assert_eq!(tool_name, CODEX_COMMAND_APPROVAL_TOOL);
                assert_eq!(input["codexAgentLabel"], "Antigravity");
                assert_eq!(input["command"], "cargo test");
                assert!(
                    input["reason"]
                        .as_str()
                        .unwrap()
                        .contains("Modifies workspace")
                );
                let allow = build_antigravity_approval_response_payload(&input, true).unwrap();
                assert_eq!(
                    allow["response"]["outcome"],
                    json!({ "outcome": "selected", "optionId": "allow_1" })
                );
                let deny = build_antigravity_approval_response_payload(&input, false).unwrap();
                assert_eq!(
                    deny["response"]["outcome"],
                    json!({ "outcome": "selected", "optionId": "deny_1" })
                );
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[test]
    fn antigravity_acp_args_respects_full_access_plan_and_probe() {
        assert_eq!(
            antigravity_acp_args(AntigravityPermissionLevel::Full, false, false),
            vec!["acp", "--dangerously-skip-permissions"]
        );
        assert_eq!(
            antigravity_acp_args(AntigravityPermissionLevel::Full, true, false),
            vec!["acp"]
        );
        assert_eq!(
            antigravity_acp_args(AntigravityPermissionLevel::Full, false, true),
            vec!["acp"]
        );
        assert_eq!(
            antigravity_acp_args(AntigravityPermissionLevel::Standard, false, false),
            vec!["acp"]
        );
    }

    #[test]
    fn apply_antigravity_acp_env_disables_updater_and_scrubs_api_keys_for_oauth() {
        let mut cmd = crate::process::command("agy");
        cmd.env("GEMINI_API_KEY", "secret")
            .env("GOOGLE_API_KEY", "secret");
        apply_antigravity_acp_env(&mut cmd, false);
        let envs: Vec<_> = cmd.as_std().get_envs().collect();
        assert!(envs.iter().any(|(k, v)| *k == "AGY_CLI_DISABLE_AUTO_UPDATE"
            && v.and_then(|v| v.to_str()) == Some("true")));
        assert!(
            envs.iter()
                .any(|(k, v)| *k == "GEMINI_API_KEY" && v.is_none())
        );
        assert!(
            envs.iter()
                .any(|(k, v)| *k == "GOOGLE_API_KEY" && v.is_none())
        );
    }
}
