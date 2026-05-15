use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio::process::{ChildStdin, Command};
use tokio::sync::broadcast;
use tokio::sync::mpsc;
use tokio::sync::oneshot;

use crate::process::CommandWindowExt as _;

use super::environment::apply_resolved_env_to_command;
use super::{
    AgentEvent, AssistantMessage, ContentBlock, ControlRequestInner, Delta, FileAttachment,
    InnerStreamEvent, StartContentBlock, StreamEvent, TurnHandle, UserContentBlock,
    UserEventMessage, UserMessageContent,
};

type PiStdin = Arc<tokio::sync::Mutex<ChildStdin>>;
type PendingRequests = Arc<tokio::sync::Mutex<BTreeMap<String, PendingPiRequest>>>;
type TurnOutput = Arc<tokio::sync::Mutex<PiTurnOutput>>;
type InitCacheHandle = Arc<tokio::sync::Mutex<InitCache>>;

struct PendingPiRequest {
    command: String,
    tx: oneshot::Sender<Result<Value, String>>,
}

// Tool block indices start at 2 because index 0 is reserved for the text block
// and index 1 for the thinking block opened in TurnStart.
const FIRST_TOOL_BLOCK_INDEX: u32 = 2;

struct PiTurnOutput {
    text: String,
    thinking: String,
    tool_block_indices: HashMap<String, u32>,
    next_tool_block_index: u32,
}

impl PiTurnOutput {
    fn fresh() -> Self {
        Self {
            text: String::new(),
            thinking: String::new(),
            tool_block_indices: HashMap::new(),
            next_tool_block_index: FIRST_TOOL_BLOCK_INDEX,
        }
    }

    fn tool_index(&mut self, tool_call_id: &str) -> u32 {
        if let Some(idx) = self.tool_block_indices.get(tool_call_id).copied() {
            return idx;
        }
        let idx = self.next_tool_block_index;
        self.next_tool_block_index += 1;
        self.tool_block_indices
            .insert(tool_call_id.to_string(), idx);
        idx
    }
}

impl Default for PiTurnOutput {
    fn default() -> Self {
        Self::fresh()
    }
}

// Events emitted before any subscriber exists (the harness command-line marker
// and the post-`start_session` init event) are dropped by `broadcast::send`.
// We cache them on the session and replay them into each turn's per-turn
// receiver after it subscribes, so the chat bridge always sees the init event
// and persists the sidecar invocation.
#[derive(Default, Clone)]
struct InitCache {
    command_line: Option<AgentEvent>,
    init: Option<AgentEvent>,
}

#[derive(Debug, Clone)]
pub struct PiSdkOptions {
    pub model: Option<String>,
    pub thinking_level: Option<String>,
    pub session_dir: Option<PathBuf>,
    pub allowed_tools: Vec<String>,
    pub custom_instructions: Option<String>,
    pub workspace_env: Option<crate::env::WorkspaceEnv>,
    pub resolved_env: Option<crate::env_provider::ResolvedEnv>,
    /// `ModelRegistry.registerProvider` payload the sidecar applies
    /// before spawning the agent session. Used by Ollama / LM Studio
    /// routes to make Claudette-configured local servers reachable
    /// through Pi without the user having to maintain a separate
    /// `~/.pi/agent/models.json`.
    pub pi_provider_override: Option<crate::agent_backend::PiProviderOverride>,
}

pub struct PiSdkSession {
    pid: u32,
    stdin: Option<PiStdin>,
    event_tx: broadcast::Sender<AgentEvent>,
    pending: PendingRequests,
    next_request_id: AtomicI64,
    working_dir: PathBuf,
    turn_output: TurnOutput,
    init_cache: InitCacheHandle,
}

/// Setup knobs for `PiSdkSession::spawn_initialized`. `start` and
/// `start_control` differ only in whether they apply caller env, cache
/// the command-line marker, and (in the case of `start`) follow with a
/// `start_session` request. Everything else — spawn, stdio capture,
/// reader/exit-watcher wiring, init handshake, error-path teardown —
/// is identical, so it lives in the helper.
struct PiSpawnConfig<'a> {
    working_dir: &'a Path,
    resolved_env: Option<&'a crate::env_provider::ResolvedEnv>,
    workspace_env: Option<&'a crate::env::WorkspaceEnv>,
    cache_command_line: bool,
}

impl PiSdkSession {
    pub async fn start(
        working_dir: &Path,
        session_id: &str,
        options: PiSdkOptions,
    ) -> Result<Self, String> {
        let session = Self::spawn_initialized(PiSpawnConfig {
            working_dir,
            resolved_env: options.resolved_env.as_ref(),
            workspace_env: options.workspace_env.as_ref(),
            cache_command_line: true,
        })
        .await?;
        if let Err(err) = session.start_session(session_id, options).await {
            // Same teardown story as `spawn_initialized`: the exit watcher
            // owns `child`, so kill the leftover sidecar by PID instead of
            // dropping the borrow.
            let _ = crate::agent::stop_agent_graceful(session.pid).await;
            return Err(format!("Pi SDK harness start_session failed: {err}"));
        }
        Ok(session)
    }

    pub async fn discover_models(working_dir: &Path) -> Result<Vec<PiSdkModel>, String> {
        let session = Self::start_control(working_dir).await?;
        let value = session
            .send_request(json!({ "type": "discover_models" }))
            .await?;
        let models = value
            .get("models")
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new()));
        let models = serde_json::from_value::<Vec<PiSdkModel>>(models)
            .map_err(|e| format!("Invalid Pi model discovery response: {e}"))?;
        let _ = session.send_request(json!({ "type": "dispose" })).await;
        Ok(models)
    }

    async fn start_control(working_dir: &Path) -> Result<Self, String> {
        Self::spawn_initialized(PiSpawnConfig {
            working_dir,
            resolved_env: None,
            workspace_env: None,
            cache_command_line: false,
        })
        .await
    }

    /// Spawn the Pi sidecar, wire its stdio readers + exit watcher, and
    /// run the `initialize` handshake. Returns a session whose
    /// background tasks already own the child handle; teardown on later
    /// errors must go through `stop_agent_graceful(pid)`, not by
    /// dropping the borrow.
    async fn spawn_initialized(config: PiSpawnConfig<'_>) -> Result<Self, String> {
        crate::missing_cli::precheck_cwd(config.working_dir)?;

        let pi_path = resolve_pi_harness_path().await;
        let mut cmd = Command::new(&pi_path);
        cmd.no_console_window();
        cmd.current_dir(config.working_dir)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .env("PATH", crate::env::enriched_path());
        if let Some(env) = config.resolved_env {
            apply_resolved_env_to_command(&mut cmd, env);
        }
        if let Some(env) = config.workspace_env {
            env.apply(&mut cmd);
        }
        if let Some(package_dir) = resolve_pi_package_dir(&pi_path) {
            cmd.env("PI_PACKAGE_DIR", package_dir);
        }

        let mut child = cmd.spawn().map_err(|e| {
            crate::missing_cli::map_spawn_err(&e, "claudette-pi-harness", || {
                format!(
                    "Failed to spawn Pi SDK harness at {}: {e}",
                    pi_path.display()
                )
            })
        })?;
        let pid = child
            .id()
            .ok_or_else(|| "Pi SDK harness exited immediately".to_string())?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to capture Pi SDK harness stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to capture Pi SDK harness stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Failed to capture Pi SDK harness stderr".to_string())?;

        let (event_tx, _) = broadcast::channel(2048);
        let session = Self {
            pid,
            stdin: Some(Arc::new(tokio::sync::Mutex::new(stdin))),
            event_tx,
            pending: Arc::new(tokio::sync::Mutex::new(BTreeMap::new())),
            next_request_id: AtomicI64::new(1),
            working_dir: config.working_dir.to_path_buf(),
            turn_output: Arc::new(tokio::sync::Mutex::new(PiTurnOutput::default())),
            init_cache: Arc::new(tokio::sync::Mutex::new(InitCache::default())),
        };

        session.spawn_stdout_reader(stdout);
        session.spawn_stderr_reader(stderr);
        session.spawn_exit_watcher(child);
        if config.cache_command_line {
            // Cache the command-line marker so the first turn's per-turn
            // receiver can replay it; sending through `event_tx` before
            // any subscriber exists would drop it on the floor.
            session.init_cache.lock().await.command_line = Some(pi_command_line_event(&pi_path));
        }
        // `spawn_exit_watcher` moved `child` into a background task, so we
        // no longer hold the kill handle directly. If `initialize` fails the
        // session goes out of scope; closing stdin would normally make the
        // sidecar exit, but it can hang mid-handshake while a request is
        // pending. Send an explicit graceful stop on the error path so a
        // half-started Pi process never lingers.
        if let Err(err) = session.initialize().await {
            let _ = crate::agent::stop_agent_graceful(pid).await;
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
            turn_output: Arc::new(tokio::sync::Mutex::new(PiTurnOutput::default())),
            init_cache: Arc::new(tokio::sync::Mutex::new(InitCache::default())),
        }
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn subscribe(&self) -> broadcast::Receiver<AgentEvent> {
        self.event_tx.subscribe()
    }

    pub async fn send_turn(
        &self,
        prompt: &str,
        attachments: &[FileAttachment],
    ) -> Result<TurnHandle, String> {
        if !attachments.is_empty() {
            return Err("Pi SDK harness does not support Claudette attachments yet".to_string());
        }
        let mut broadcast_rx = self.event_tx.subscribe();
        let cached = self.init_cache.lock().await.clone();
        self.send_request(json!({
            "type": "prompt",
            "prompt": prompt,
        }))
        .await?;

        let (mpsc_tx, mpsc_rx) = mpsc::channel::<AgentEvent>(128);
        // Replay the cached command-line + init events into this turn's
        // receiver before forwarding live stream events. The bridge's
        // got_init flag depends on seeing the System { subtype: "init" }
        // event, which is otherwise emitted before any subscriber exists.
        if let Some(event) = cached.command_line
            && mpsc_tx.send(event).await.is_err()
        {
            return Err("Pi SDK harness turn receiver closed".to_string());
        }
        if let Some(event) = cached.init
            && mpsc_tx.send(event).await.is_err()
        {
            return Err("Pi SDK harness turn receiver closed".to_string());
        }
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
                            subsystem = "pi-sdk",
                            dropped_events = n,
                            "broadcast lag — pi per-turn receiver missed events"
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

    pub async fn steer_turn(
        &self,
        prompt: &str,
        attachments: &[FileAttachment],
    ) -> Result<(), String> {
        if !attachments.is_empty() {
            return Err("Pi SDK harness does not support Claudette attachments yet".to_string());
        }
        self.send_request(json!({
            "type": "steer",
            "prompt": prompt,
        }))
        .await?;
        Ok(())
    }

    pub async fn interrupt_turn(&self) -> Result<(), String> {
        self.send_request(json!({ "type": "abort" })).await?;
        Ok(())
    }

    pub async fn send_control_response(
        &self,
        request_id: &str,
        response: Value,
    ) -> Result<(), String> {
        let decision = response
            .get("response")
            .and_then(|value| value.get("decision"))
            .and_then(Value::as_str)
            .unwrap_or_else(|| {
                response
                    .get("behavior")
                    .and_then(Value::as_str)
                    .unwrap_or("decline")
            });
        let request_type = if matches!(decision, "accept" | "allow") {
            "approve_tool"
        } else {
            "deny_tool"
        };
        self.send_request(json!({
            "type": request_type,
            "requestId": request_id,
        }))
        .await?;
        Ok(())
    }

    async fn initialize(&self) -> Result<(), String> {
        self.send_request(json!({ "type": "initialize" })).await?;
        Ok(())
    }

    async fn start_session(&self, session_id: &str, options: PiSdkOptions) -> Result<(), String> {
        let session_dir = options
            .session_dir
            .as_ref()
            .map(|path| path.to_string_lossy().to_string());
        // Build the optional provider override block. The sidecar
        // forwards it straight into `ModelRegistry.registerProvider`,
        // making a Claudette-side Ollama / LM Studio entry reachable
        // through Pi without the user having to wire it up in
        // `~/.pi/agent/models.json` first.
        let provider_override = options.pi_provider_override.as_ref().map(|p| {
            json!({
                "provider": p.provider,
                "baseUrl": p.base_url,
                "modelId": p.model_id,
                "modelLabel": p.model_label,
                "contextWindow": p.context_window,
            })
        });
        self.send_request(json!({
            "type": "start_session",
            "cwd": self.working_dir,
            "sessionId": session_id,
            "sessionDir": session_dir,
            "model": options.model,
            "thinkingLevel": options.thinking_level,
            "allowedTools": options.allowed_tools,
            "customInstructions": options.custom_instructions,
            "providerOverride": provider_override,
        }))
        .await?;
        Ok(())
    }

    async fn send_request(&self, mut request: Value) -> Result<Value, String> {
        let stdin = self
            .stdin
            .as_ref()
            .ok_or_else(|| "Pi SDK harness stdin is not available".to_string())?;
        let id = self.next_id();
        let command = request
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        request["id"] = Value::String(id.clone());
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().await;
            pending.insert(id.clone(), PendingPiRequest { command, tx });
        }
        let mut line = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
        line.push(b'\n');
        let write_result = {
            let mut stdin = stdin.lock().await;
            stdin.write_all(&line).await
        };
        if let Err(err) = write_result {
            let mut pending = self.pending.lock().await;
            pending.remove(&id);
            return Err(format!("write to Pi SDK harness: {err}"));
        }
        rx.await
            .map_err(|_| "Pi SDK harness response channel closed".to_string())?
    }

    fn next_id(&self) -> String {
        format!(
            "pi-{}",
            self.next_request_id.fetch_add(1, Ordering::Relaxed)
        )
    }

    fn spawn_stdout_reader(&self, stdout: tokio::process::ChildStdout) {
        let event_tx = self.event_tx.clone();
        let pending = self.pending.clone();
        let turn_output = self.turn_output.clone();
        let init_cache = self.init_cache.clone();
        tokio::spawn(async move {
            let reader = tokio::io::BufReader::new(stdout);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                match serde_json::from_str::<PiHarnessMessage>(&line) {
                    Ok(message) => {
                        route_pi_message(&event_tx, &pending, &turn_output, &init_cache, message)
                            .await;
                    }
                    Err(err) => {
                        let msg = format!("Failed to parse Pi SDK harness line: {err}: {line}");
                        tracing::warn!(target: "claudette::agent", subsystem = "pi-sdk", %msg);
                        let _ = event_tx.send(AgentEvent::Stderr(msg));
                    }
                }
            }
            fail_pending_requests(&pending, "Pi SDK harness stdout closed").await;
        });
    }

    fn spawn_stderr_reader(&self, stderr: tokio::process::ChildStderr) {
        let event_tx = self.event_tx.clone();
        tokio::spawn(async move {
            let reader = tokio::io::BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if !line.trim().is_empty() {
                    tracing::warn!(target: "claudette::agent", subsystem = "pi-sdk", line = %line, "pi harness stderr");
                    let _ = event_tx.send(AgentEvent::Stderr(line));
                }
            }
        });
    }

    fn spawn_exit_watcher(&self, mut child: tokio::process::Child) {
        let event_tx = self.event_tx.clone();
        let pending = self.pending.clone();
        tokio::spawn(async move {
            let status = child.wait().await.ok().and_then(|status| status.code());
            fail_pending_requests(&pending, "Pi SDK harness exited").await;
            let _ = event_tx.send(AgentEvent::ProcessExited(status));
        });
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum PiHarnessMessage {
    #[serde(rename = "response")]
    Response {
        id: String,
        command: String,
        success: bool,
        #[serde(default)]
        data: Option<Value>,
        #[serde(default)]
        error: Option<String>,
    },
    #[serde(rename = "ready")]
    Ready {
        // Canonical wire key is `sessionId` (sidecar emits camelCase),
        // but accept snake_case too so hand-crafted JSONL fixtures and
        // any future protocol change don't silently drop the id.
        #[serde(default, rename = "sessionId", alias = "session_id")]
        session_id: Option<String>,
    },
    #[serde(rename = "turn_start")]
    TurnStart,
    #[serde(rename = "assistant_delta")]
    AssistantDelta { delta: String },
    #[serde(rename = "thinking_delta")]
    ThinkingDelta { delta: String },
    #[serde(rename = "tool_request")]
    ToolRequest {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        kind: String,
        input: Value,
    },
    #[serde(rename = "tool_update")]
    ToolUpdate {
        #[serde(default)]
        phase: Option<String>,
        #[serde(default, rename = "toolCallId")]
        tool_call_id: Option<String>,
        #[serde(default, rename = "toolName")]
        tool_name: Option<String>,
        #[serde(default)]
        args: Option<Value>,
        #[serde(default)]
        result: Option<Value>,
    },
    #[serde(rename = "tool_result")]
    ToolResult {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        #[serde(default)]
        result: Option<Value>,
        #[serde(default, rename = "isError")]
        is_error: bool,
    },
    #[serde(rename = "turn_end")]
    TurnEnd {
        #[serde(default)]
        error: Option<String>,
    },
    #[serde(rename = "error")]
    Error {
        #[serde(default)]
        error: Option<String>,
    },
    #[serde(other)]
    Unknown,
}

async fn route_pi_message(
    event_tx: &broadcast::Sender<AgentEvent>,
    pending: &PendingRequests,
    turn_output: &TurnOutput,
    init_cache: &InitCacheHandle,
    message: PiHarnessMessage,
) {
    match message {
        PiHarnessMessage::Response {
            id,
            command,
            success,
            data,
            error,
        } => {
            let pending_request = pending.lock().await.remove(&id);
            if let Some(pending_request) = pending_request {
                let result = if success {
                    Ok(data.unwrap_or(Value::Null))
                } else {
                    Err(error.unwrap_or_else(|| format!("Pi `{command}` failed")))
                };
                let _ = pending_request.tx.send(result);
            } else {
                tracing::warn!(
                    target: "claudette::agent",
                    subsystem = "pi-sdk",
                    id = %id,
                    command = %command,
                    "received response for unknown Pi request"
                );
            }
        }
        PiHarnessMessage::Ready { session_id } => {
            let init_event = AgentEvent::Stream(StreamEvent::System {
                subtype: "init".to_string(),
                session_id,
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
                command_line: None,
            });
            // Cache for replay into per-turn receivers. Ready arrives during
            // start_session, before send_turn subscribes — without the cache
            // the init event reaches no subscribers and the chat bridge's
            // got_init flag stays false.
            init_cache.lock().await.init = Some(init_event.clone());
            let _ = event_tx.send(init_event);
        }
        PiHarnessMessage::TurnStart => {
            *turn_output.lock().await = PiTurnOutput::fresh();
            let _ = event_tx.send(AgentEvent::Stream(StreamEvent::Stream {
                event: InnerStreamEvent::MessageStart {},
            }));
            let _ = event_tx.send(AgentEvent::Stream(StreamEvent::Stream {
                event: InnerStreamEvent::ContentBlockStart {
                    index: 0,
                    content_block: Some(StartContentBlock::Text {}),
                },
            }));
            let _ = event_tx.send(AgentEvent::Stream(StreamEvent::Stream {
                event: InnerStreamEvent::ContentBlockStart {
                    index: 1,
                    content_block: Some(StartContentBlock::Thinking {}),
                },
            }));
        }
        PiHarnessMessage::AssistantDelta { delta } => {
            turn_output.lock().await.text.push_str(&delta);
            let _ = event_tx.send(AgentEvent::Stream(StreamEvent::Stream {
                event: InnerStreamEvent::ContentBlockDelta {
                    index: 0,
                    delta: Delta::Text { text: delta },
                },
            }));
        }
        PiHarnessMessage::ThinkingDelta { delta } => {
            turn_output.lock().await.thinking.push_str(&delta);
            let _ = event_tx.send(AgentEvent::Stream(StreamEvent::Stream {
                event: InnerStreamEvent::ContentBlockDelta {
                    index: 1,
                    delta: Delta::Thinking { thinking: delta },
                },
            }));
        }
        PiHarnessMessage::ToolRequest {
            request_id,
            tool_call_id,
            kind,
            mut input,
        } => {
            let (tool_name, approval_kind) = if kind == "fileChange" {
                ("CodexFileChangeApproval", "fileChange")
            } else {
                ("CodexCommandApproval", "commandExecution")
            };
            if let Value::Object(ref mut object) = input {
                object.insert(
                    "codexMethod".to_string(),
                    Value::String("pi/tool/requestApproval".to_string()),
                );
                object.insert(
                    "codexApprovalKind".to_string(),
                    Value::String(approval_kind.to_string()),
                );
                // The shared approval card i18n ("{{agent}} wants approval
                // before …") interpolates whichever agent originated the
                // request. Without this tag the React side falls back to
                // the Codex default, which is wrong for Pi.
                object.insert(
                    "codexAgentLabel".to_string(),
                    Value::String("Pi".to_string()),
                );
            }
            let _ = event_tx.send(AgentEvent::Stream(StreamEvent::ControlRequest {
                request_id,
                request: ControlRequestInner::CanUseTool {
                    tool_name: tool_name.to_string(),
                    tool_use_id: tool_call_id,
                    input,
                },
            }));
        }
        PiHarnessMessage::ToolUpdate {
            phase,
            tool_call_id,
            tool_name,
            args,
            result,
        } => {
            let id = tool_call_id.unwrap_or_else(|| "pi-tool".to_string());
            let name = tool_name.unwrap_or_else(|| "tool".to_string());
            let phase_str = phase.as_deref().unwrap_or("start");
            // Allocate a stable per-tool block index so concurrent or
            // sequential tool calls don't collide on a single index in the
            // frontend's block table.
            let block_index = turn_output.lock().await.tool_index(&id);
            if phase_str == "start" {
                let _ = event_tx.send(AgentEvent::Stream(StreamEvent::Stream {
                    event: InnerStreamEvent::ContentBlockStart {
                        index: block_index as usize,
                        content_block: Some(StartContentBlock::ToolUse {
                            id: id.clone(),
                            name,
                        }),
                    },
                }));
            }
            if let Some(args) = args
                && phase_str == "start"
            {
                let _ = event_tx.send(AgentEvent::Stream(StreamEvent::Stream {
                    event: InnerStreamEvent::ContentBlockDelta {
                        index: block_index as usize,
                        delta: Delta::InputJson {
                            partial_json: Some(args.to_string()),
                        },
                    },
                }));
            }
            if let Some(result) = result
                && phase_str == "update"
            {
                let _ = event_tx.send(AgentEvent::Stream(StreamEvent::User {
                    message: UserEventMessage {
                        content: UserMessageContent::Blocks(vec![UserContentBlock::ToolResult {
                            tool_use_id: id,
                            content: result,
                        }]),
                    },
                    uuid: None,
                    is_replay: false,
                    is_synthetic: true,
                }));
            }
        }
        PiHarnessMessage::ToolResult {
            tool_call_id,
            tool_name,
            result,
            is_error,
        } => {
            // Close the per-tool block now that the tool has produced its
            // final result. We only emit the stop when we actually allocated
            // an index for this tool earlier; a result without a matching
            // start would have no block to close.
            let block_index = turn_output
                .lock()
                .await
                .tool_block_indices
                .get(&tool_call_id)
                .copied();
            if let Some(idx) = block_index {
                let _ = event_tx.send(AgentEvent::Stream(StreamEvent::Stream {
                    event: InnerStreamEvent::ContentBlockStop {
                        index: idx as usize,
                    },
                }));
            }
            let content = result.unwrap_or_else(|| json!({ "ok": !is_error }));
            let _ = event_tx.send(AgentEvent::Stream(StreamEvent::User {
                message: UserEventMessage {
                    content: UserMessageContent::Blocks(vec![UserContentBlock::ToolResult {
                        tool_use_id: tool_call_id,
                        content: json!({
                            "tool": tool_name,
                            "result": content,
                            "is_error": is_error,
                        }),
                    }]),
                },
                uuid: None,
                is_replay: false,
                is_synthetic: false,
            }));
        }
        PiHarnessMessage::TurnEnd { error } => {
            let mut output = turn_output.lock().await;
            let error_text = error
                .as_ref()
                .map(|e| e.trim().to_string())
                .filter(|e| !e.is_empty());
            let mut content = Vec::new();
            if !output.thinking.trim().is_empty() {
                content.push(ContentBlock::Thinking {
                    thinking: output.thinking.clone(),
                });
            }
            if !output.text.trim().is_empty() {
                content.push(ContentBlock::Text {
                    text: output.text.clone(),
                });
            }
            // When a turn fails, always surface the error as an assistant
            // text block — even when partial text was already streamed.
            // The frontend renders assistant content but ignores
            // `Result.result`, so without this an error after partial
            // text would finalize with only the partial text visible and
            // the failure invisible.
            if let Some(err) = error_text.as_ref() {
                content.push(ContentBlock::Text {
                    text: format!("Pi turn failed: {err}"),
                });
            }
            if !content.is_empty() {
                let _ = event_tx.send(AgentEvent::Stream(StreamEvent::Assistant {
                    message: AssistantMessage { content },
                }));
            }
            let subtype = if error_text.is_some() {
                "error"
            } else {
                "success"
            };
            // Embed the error in the Result payload (alongside any captured
            // text) so downstream consumers that only read Result.result —
            // not Stderr — still have something to display.
            let result_text = match (output.text.trim().is_empty(), error_text.as_ref()) {
                (true, Some(err)) => err.clone(),
                (false, Some(err)) => format!("{}\n\n{}", output.text, err),
                _ => output.text.clone(),
            };
            let _ = event_tx.send(AgentEvent::Stream(StreamEvent::Result {
                subtype: subtype.to_string(),
                result: Some(result_text),
                total_cost_usd: None,
                duration_ms: None,
                usage: None,
            }));
            output.text.clear();
            output.thinking.clear();
        }
        PiHarnessMessage::Error { error } => {
            let _ = event_tx.send(AgentEvent::Stderr(
                error.unwrap_or_else(|| "Pi SDK harness error".to_string()),
            ));
        }
        PiHarnessMessage::Unknown => {}
    }
}

async fn fail_pending_requests(pending: &PendingRequests, reason: &str) {
    let mut pending = pending.lock().await;
    for (_, pending) in std::mem::take(&mut *pending) {
        let _ = pending.tx.send(Err(format!(
            "Pi SDK harness `{}` failed: {reason}",
            pending.command
        )));
    }
}

pub async fn resolve_pi_harness_path() -> PathBuf {
    if let Ok(path) = std::env::var("CLAUDETTE_PI_HARNESS") {
        return PathBuf::from(path);
    }
    let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("claudette-app"));
    let dir = exe.parent().unwrap_or_else(|| Path::new("."));
    let suffix = std::env::consts::EXE_SUFFIX;
    let bundled = dir.join(format!("claudette-pi-harness{suffix}"));
    if bundled.exists() {
        return bundled;
    }
    let triple = host_triple();
    let staged = PathBuf::from("src-tauri")
        .join("binaries")
        .join(format!("claudette-pi-harness-{triple}{suffix}"));
    if staged.exists() {
        return staged;
    }
    PathBuf::from(format!("claudette-pi-harness{suffix}"))
}

fn host_triple() -> &'static str {
    match (std::env::consts::ARCH, std::env::consts::OS) {
        ("aarch64", "macos") => "aarch64-apple-darwin",
        ("x86_64", "macos") => "x86_64-apple-darwin",
        ("x86_64", "linux") => "x86_64-unknown-linux-gnu",
        ("aarch64", "linux") => "aarch64-unknown-linux-gnu",
        ("x86_64", "windows") => "x86_64-pc-windows-msvc",
        ("aarch64", "windows") => "aarch64-pc-windows-msvc",
        _ => "unknown",
    }
}

fn resolve_pi_package_dir(harness_path: &Path) -> Option<PathBuf> {
    let near_harness = harness_path.parent()?.join("pi");
    if near_harness.exists() {
        return Some(near_harness);
    }
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    [
        dir.join("pi"),
        dir.join("binaries").join("pi"),
        dir.join("resources").join("binaries").join("pi"),
        dir.parent()
            .unwrap_or(dir)
            .join("Resources")
            .join("binaries")
            .join("pi"),
    ]
    .into_iter()
    .find(|candidate| candidate.exists())
}

fn pi_command_line_event(path: &Path) -> AgentEvent {
    AgentEvent::Stream(StreamEvent::system_command_line(format!(
        "{}",
        path.display()
    )))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PiSdkModel {
    pub id: String,
    pub label: String,
    #[serde(default, rename = "contextWindowTokens")]
    pub context_window_tokens: Option<u32>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use tokio::sync::Mutex;
    use tokio::time::{Duration, timeout};

    /// Build the four route_pi_message dependencies pre-wired together.
    /// Returns the sender alongside a receiver so tests can drain the
    /// emitted stream events.
    fn pi_state() -> (
        broadcast::Sender<AgentEvent>,
        broadcast::Receiver<AgentEvent>,
        PendingRequests,
        TurnOutput,
        InitCacheHandle,
    ) {
        let (event_tx, rx) = broadcast::channel::<AgentEvent>(64);
        let pending: PendingRequests = Arc::new(Mutex::new(BTreeMap::new()));
        let turn_output: TurnOutput = Arc::new(Mutex::new(PiTurnOutput::fresh()));
        let init_cache: InitCacheHandle = Arc::new(Mutex::new(InitCache::default()));
        (event_tx, rx, pending, turn_output, init_cache)
    }

    async fn next_event(rx: &mut broadcast::Receiver<AgentEvent>) -> AgentEvent {
        timeout(Duration::from_secs(1), rx.recv())
            .await
            .expect("event delivered before timeout")
            .expect("event ok")
    }

    fn try_recv_now(rx: &mut broadcast::Receiver<AgentEvent>) -> Option<AgentEvent> {
        rx.try_recv().ok()
    }

    #[test]
    fn parses_pi_tool_request() {
        let value = r#"{"type":"tool_request","requestId":"r1","toolCallId":"t1","kind":"commandExecution","input":{"command":"echo hi"}}"#;
        let msg: PiHarnessMessage = serde_json::from_str(value).unwrap();
        assert!(matches!(msg, PiHarnessMessage::ToolRequest { .. }));
    }

    #[test]
    fn test_session_reports_pid() {
        let session = PiSdkSession::new_for_test(42);
        assert_eq!(session.pid(), 42);
    }

    #[test]
    fn pi_turn_output_tool_index_is_stable_and_monotonic() {
        // Tool blocks need stable indices so the React side can attach
        // streamed args/results to the right card. The first id should
        // map to FIRST_TOOL_BLOCK_INDEX (text=0, thinking=1), and the
        // same id revisited must reuse its slot.
        let mut output = PiTurnOutput::fresh();
        let a = output.tool_index("call-a");
        let b = output.tool_index("call-b");
        let a_again = output.tool_index("call-a");

        assert_eq!(a, FIRST_TOOL_BLOCK_INDEX);
        assert_eq!(b, FIRST_TOOL_BLOCK_INDEX + 1);
        assert_eq!(a_again, a, "revisiting an id must reuse its slot");
    }

    #[test]
    fn pi_turn_output_default_matches_fresh() {
        let d = PiTurnOutput::default();
        assert!(d.text.is_empty());
        assert!(d.thinking.is_empty());
        assert!(d.tool_block_indices.is_empty());
        assert_eq!(d.next_tool_block_index, FIRST_TOOL_BLOCK_INDEX);
    }

    #[test]
    fn pi_sdk_session_next_id_is_monotonic_and_prefixed() {
        let session = PiSdkSession::new_for_test(1);
        let first = session.next_id();
        let second = session.next_id();
        assert!(
            first.starts_with("pi-"),
            "next_id must carry the `pi-` prefix"
        );
        assert_ne!(first, second);
    }

    /// The sidecar emits `sessionId` (camelCase); we keep `session_id` as
    /// an alias so hand-crafted JSONL fixtures don't silently drop the id
    /// after the field collapse. Pin both wire forms.
    #[test]
    fn parses_ready_with_either_session_id_key() {
        for line in [
            r#"{"type":"ready","sessionId":"abc123"}"#,
            r#"{"type":"ready","session_id":"abc123"}"#,
        ] {
            let msg: PiHarnessMessage = serde_json::from_str(line).unwrap();
            match msg {
                PiHarnessMessage::Ready { session_id } => {
                    assert_eq!(session_id.as_deref(), Some("abc123"));
                }
                _ => panic!("expected Ready, got: {line}"),
            }
        }
    }

    #[test]
    fn parses_ready_without_session_id() {
        let msg: PiHarnessMessage = serde_json::from_str(r#"{"type":"ready"}"#).unwrap();
        match msg {
            PiHarnessMessage::Ready { session_id } => assert!(session_id.is_none()),
            _ => panic!("expected Ready"),
        }
    }

    /// Regression: the approval card's localized title/description
    /// interpolates `{{agent}}` from `codexAgentLabel`. Without this
    /// injection, Pi approvals would render as "Codex wants approval…"
    /// — confusing the user about which harness is running. The Codex
    /// app-server path leaves the field absent, so this is Pi-only.
    #[tokio::test]
    async fn pi_tool_request_injects_codex_agent_label() {
        let (event_tx, mut rx, pending, turn_output, init_cache) = pi_state();

        route_pi_message(
            &event_tx,
            &pending,
            &turn_output,
            &init_cache,
            PiHarnessMessage::ToolRequest {
                request_id: "req-1".to_string(),
                tool_call_id: "tool-1".to_string(),
                kind: "commandExecution".to_string(),
                input: serde_json::json!({ "command": "ls" }),
            },
        )
        .await;

        let event = next_event(&mut rx).await;
        match event {
            AgentEvent::Stream(StreamEvent::ControlRequest { request, .. }) => match request {
                ControlRequestInner::CanUseTool { input, .. } => {
                    let label = input.get("codexAgentLabel").and_then(Value::as_str);
                    assert_eq!(label, Some("Pi"));
                }
                other => panic!("expected CanUseTool, got {other:?}"),
            },
            other => panic!("expected ControlRequest, got {other:?}"),
        }
    }

    /// `fileChange` is the only Pi tool kind that maps to the file-write
    /// approval card; everything else falls back to the command-execution
    /// card. Pin both branches so a future kind addition doesn't silently
    /// route file changes through the wrong card.
    #[tokio::test]
    async fn pi_tool_request_file_change_uses_file_change_approval() {
        let (event_tx, mut rx, pending, turn_output, init_cache) = pi_state();
        route_pi_message(
            &event_tx,
            &pending,
            &turn_output,
            &init_cache,
            PiHarnessMessage::ToolRequest {
                request_id: "req-2".to_string(),
                tool_call_id: "tool-2".to_string(),
                kind: "fileChange".to_string(),
                input: serde_json::json!({ "path": "/tmp/x" }),
            },
        )
        .await;

        match next_event(&mut rx).await {
            AgentEvent::Stream(StreamEvent::ControlRequest { request, .. }) => match request {
                ControlRequestInner::CanUseTool {
                    tool_name, input, ..
                } => {
                    assert_eq!(tool_name, "CodexFileChangeApproval");
                    assert_eq!(
                        input.get("codexApprovalKind").and_then(Value::as_str),
                        Some("fileChange"),
                    );
                    assert_eq!(
                        input.get("codexMethod").and_then(Value::as_str),
                        Some("pi/tool/requestApproval"),
                    );
                }
                other => panic!("expected CanUseTool, got {other:?}"),
            },
            other => panic!("expected ControlRequest, got {other:?}"),
        }
    }

    /// A non-object input (rare but legal JSON) must not be silently
    /// dropped — the harness should still forward the request, just
    /// without the metadata it can't inject.
    #[tokio::test]
    async fn pi_tool_request_with_non_object_input_skips_injection() {
        let (event_tx, mut rx, pending, turn_output, init_cache) = pi_state();
        route_pi_message(
            &event_tx,
            &pending,
            &turn_output,
            &init_cache,
            PiHarnessMessage::ToolRequest {
                request_id: "req-3".to_string(),
                tool_call_id: "tool-3".to_string(),
                kind: "commandExecution".to_string(),
                input: Value::String("ls".to_string()),
            },
        )
        .await;
        match next_event(&mut rx).await {
            AgentEvent::Stream(StreamEvent::ControlRequest { request, .. }) => match request {
                ControlRequestInner::CanUseTool { input, .. } => {
                    assert!(input.is_string(), "non-object input must round-trip");
                }
                other => panic!("expected CanUseTool, got {other:?}"),
            },
            other => panic!("expected ControlRequest, got {other:?}"),
        }
    }

    /// Successful response wakes the pending oneshot with the payload;
    /// failure delivers the harness-reported error string verbatim.
    #[tokio::test]
    async fn response_success_wakes_pending_oneshot() {
        let (event_tx, _rx, pending, turn_output, init_cache) = pi_state();
        let (tx, rx) = oneshot::channel();
        pending.lock().await.insert(
            "id-1".to_string(),
            PendingPiRequest {
                command: "initialize".to_string(),
                tx,
            },
        );
        route_pi_message(
            &event_tx,
            &pending,
            &turn_output,
            &init_cache,
            PiHarnessMessage::Response {
                id: "id-1".to_string(),
                command: "initialize".to_string(),
                success: true,
                data: Some(json!({"ok": true})),
                error: None,
            },
        )
        .await;
        let result = rx.await.expect("oneshot delivered").expect("ok payload");
        assert_eq!(result, json!({"ok": true}));
        assert!(pending.lock().await.is_empty());
    }

    #[tokio::test]
    async fn response_failure_propagates_error_string() {
        let (event_tx, _rx, pending, turn_output, init_cache) = pi_state();
        let (tx, rx) = oneshot::channel();
        pending.lock().await.insert(
            "id-2".to_string(),
            PendingPiRequest {
                command: "prompt".to_string(),
                tx,
            },
        );
        route_pi_message(
            &event_tx,
            &pending,
            &turn_output,
            &init_cache,
            PiHarnessMessage::Response {
                id: "id-2".to_string(),
                command: "prompt".to_string(),
                success: false,
                data: None,
                error: Some("model unavailable".to_string()),
            },
        )
        .await;
        let err = rx.await.expect("oneshot delivered").expect_err("err path");
        assert_eq!(err, "model unavailable");
    }

    /// A response for an id with no waiter must not panic and must not
    /// poison the pending map — the harness logs and continues.
    #[tokio::test]
    async fn response_for_unknown_id_is_swallowed() {
        let (event_tx, _rx, pending, turn_output, init_cache) = pi_state();
        route_pi_message(
            &event_tx,
            &pending,
            &turn_output,
            &init_cache,
            PiHarnessMessage::Response {
                id: "ghost".to_string(),
                command: "abort".to_string(),
                success: true,
                data: None,
                error: None,
            },
        )
        .await;
        assert!(pending.lock().await.is_empty());
    }

    /// Ready emits the System init event and caches it for late
    /// subscribers — the chat bridge's `got_init` flag depends on this.
    #[tokio::test]
    async fn ready_emits_and_caches_init_event() {
        let (event_tx, mut rx, pending, turn_output, init_cache) = pi_state();
        route_pi_message(
            &event_tx,
            &pending,
            &turn_output,
            &init_cache,
            PiHarnessMessage::Ready {
                session_id: Some("sess-1".to_string()),
            },
        )
        .await;
        match next_event(&mut rx).await {
            AgentEvent::Stream(StreamEvent::System {
                subtype,
                session_id,
                ..
            }) => {
                assert_eq!(subtype, "init");
                assert_eq!(session_id.as_deref(), Some("sess-1"));
            }
            other => panic!("expected System init, got {other:?}"),
        }
        assert!(init_cache.lock().await.init.is_some());
    }

    /// TurnStart resets per-turn state and emits MessageStart + the two
    /// pre-allocated ContentBlockStart events (text=0, thinking=1).
    #[tokio::test]
    async fn turn_start_emits_message_and_block_starts() {
        let (event_tx, mut rx, pending, turn_output, init_cache) = pi_state();
        // Pollute prior state so we can verify the reset.
        turn_output.lock().await.text.push_str("stale");
        route_pi_message(
            &event_tx,
            &pending,
            &turn_output,
            &init_cache,
            PiHarnessMessage::TurnStart,
        )
        .await;

        let first = next_event_kind(&mut rx).await;
        let second = next_event_kind(&mut rx).await;
        let third = next_event_kind(&mut rx).await;
        assert!(matches!(first, InnerKind::MessageStart));
        assert!(matches!(second, InnerKind::ContentBlockStart(0)));
        assert!(matches!(third, InnerKind::ContentBlockStart(1)));

        assert!(turn_output.lock().await.text.is_empty());
    }

    #[tokio::test]
    async fn assistant_delta_appends_text_and_streams_block() {
        let (event_tx, mut rx, pending, turn_output, init_cache) = pi_state();
        route_pi_message(
            &event_tx,
            &pending,
            &turn_output,
            &init_cache,
            PiHarnessMessage::AssistantDelta {
                delta: "hello ".to_string(),
            },
        )
        .await;
        route_pi_message(
            &event_tx,
            &pending,
            &turn_output,
            &init_cache,
            PiHarnessMessage::AssistantDelta {
                delta: "world".to_string(),
            },
        )
        .await;
        // Drain both delta events
        for expected in ["hello ", "world"] {
            match next_event(&mut rx).await {
                AgentEvent::Stream(StreamEvent::Stream {
                    event: InnerStreamEvent::ContentBlockDelta { index, delta },
                }) => {
                    assert_eq!(index, 0);
                    match delta {
                        Delta::Text { text } => assert_eq!(text, expected),
                        other => panic!("expected Text delta, got {other:?}"),
                    }
                }
                other => panic!("expected ContentBlockDelta, got {other:?}"),
            }
        }
        assert_eq!(turn_output.lock().await.text, "hello world");
    }

    #[tokio::test]
    async fn thinking_delta_appends_thinking_and_streams_block_one() {
        let (event_tx, mut rx, pending, turn_output, init_cache) = pi_state();
        route_pi_message(
            &event_tx,
            &pending,
            &turn_output,
            &init_cache,
            PiHarnessMessage::ThinkingDelta {
                delta: "musing...".to_string(),
            },
        )
        .await;
        match next_event(&mut rx).await {
            AgentEvent::Stream(StreamEvent::Stream {
                event: InnerStreamEvent::ContentBlockDelta { index, delta },
            }) => {
                assert_eq!(index, 1);
                match delta {
                    Delta::Thinking { thinking } => assert_eq!(thinking, "musing..."),
                    other => panic!("expected Thinking delta, got {other:?}"),
                }
            }
            other => panic!("expected ContentBlockDelta, got {other:?}"),
        }
        assert_eq!(turn_output.lock().await.thinking, "musing...");
    }

    /// Tool start allocates a stable block index per tool_call_id and
    /// streams the args as an InputJson delta in the same block.
    #[tokio::test]
    async fn tool_update_start_opens_block_and_streams_args() {
        let (event_tx, mut rx, pending, turn_output, init_cache) = pi_state();
        route_pi_message(
            &event_tx,
            &pending,
            &turn_output,
            &init_cache,
            PiHarnessMessage::ToolUpdate {
                phase: Some("start".to_string()),
                tool_call_id: Some("call-7".to_string()),
                tool_name: Some("read_file".to_string()),
                args: Some(json!({"path": "/etc/hosts"})),
                result: None,
            },
        )
        .await;
        // First event: ContentBlockStart
        match next_event(&mut rx).await {
            AgentEvent::Stream(StreamEvent::Stream {
                event: InnerStreamEvent::ContentBlockStart { index, .. },
            }) => {
                assert_eq!(index, FIRST_TOOL_BLOCK_INDEX as usize);
            }
            other => panic!("expected ContentBlockStart, got {other:?}"),
        }
        // Second event: InputJson delta carrying args
        match next_event(&mut rx).await {
            AgentEvent::Stream(StreamEvent::Stream {
                event: InnerStreamEvent::ContentBlockDelta { index, delta },
            }) => {
                assert_eq!(index, FIRST_TOOL_BLOCK_INDEX as usize);
                match delta {
                    Delta::InputJson { partial_json } => {
                        let parsed: Value =
                            serde_json::from_str(&partial_json.expect("args present")).unwrap();
                        assert_eq!(parsed["path"], "/etc/hosts");
                    }
                    other => panic!("expected InputJson, got {other:?}"),
                }
            }
            other => panic!("expected ContentBlockDelta, got {other:?}"),
        }
    }

    /// A mid-tool `update` phase reports the intermediate result back as
    /// a synthetic User tool-result event — useful for streaming
    /// long-running tool progress to the chat UI without closing the
    /// block.
    #[tokio::test]
    async fn tool_update_update_phase_emits_synthetic_user_result() {
        let (event_tx, mut rx, pending, turn_output, init_cache) = pi_state();
        // Prime the index by emitting a start first
        route_pi_message(
            &event_tx,
            &pending,
            &turn_output,
            &init_cache,
            PiHarnessMessage::ToolUpdate {
                phase: Some("start".to_string()),
                tool_call_id: Some("call-9".to_string()),
                tool_name: Some("bash".to_string()),
                args: None,
                result: None,
            },
        )
        .await;
        let _ = next_event(&mut rx).await; // ContentBlockStart

        route_pi_message(
            &event_tx,
            &pending,
            &turn_output,
            &init_cache,
            PiHarnessMessage::ToolUpdate {
                phase: Some("update".to_string()),
                tool_call_id: Some("call-9".to_string()),
                tool_name: None,
                args: None,
                result: Some(json!({"stdout": "progress..."})),
            },
        )
        .await;
        match next_event(&mut rx).await {
            AgentEvent::Stream(StreamEvent::User {
                message,
                is_synthetic,
                ..
            }) => {
                assert!(is_synthetic, "update-phase results must be synthetic");
                match message.content {
                    UserMessageContent::Blocks(blocks) => {
                        assert!(matches!(blocks[0], UserContentBlock::ToolResult { .. }));
                    }
                    _ => panic!("expected block content"),
                }
            }
            other => panic!("expected User event, got {other:?}"),
        }
    }

    /// A tool result closes the per-tool block (if we ever opened one)
    /// and forwards the result content as a non-synthetic user event so
    /// the SDK transcript reflects the tool output.
    #[tokio::test]
    async fn tool_result_closes_block_and_forwards_payload() {
        let (event_tx, mut rx, pending, turn_output, init_cache) = pi_state();
        // Open block first
        turn_output.lock().await.tool_index("call-r");

        route_pi_message(
            &event_tx,
            &pending,
            &turn_output,
            &init_cache,
            PiHarnessMessage::ToolResult {
                tool_call_id: "call-r".to_string(),
                tool_name: "read_file".to_string(),
                result: Some(json!({"text": "ok"})),
                is_error: false,
            },
        )
        .await;
        match next_event(&mut rx).await {
            AgentEvent::Stream(StreamEvent::Stream {
                event: InnerStreamEvent::ContentBlockStop { index },
            }) => {
                assert_eq!(index, FIRST_TOOL_BLOCK_INDEX as usize);
            }
            other => panic!("expected ContentBlockStop, got {other:?}"),
        }
        match next_event(&mut rx).await {
            AgentEvent::Stream(StreamEvent::User {
                message,
                is_synthetic,
                ..
            }) => {
                assert!(!is_synthetic, "final tool result is not synthetic");
                match message.content {
                    UserMessageContent::Blocks(blocks) => match &blocks[0] {
                        UserContentBlock::ToolResult { content, .. } => {
                            assert_eq!(content["tool"], "read_file");
                            assert_eq!(content["is_error"], false);
                        }
                        other => panic!("expected ToolResult, got {other:?}"),
                    },
                    _ => panic!("expected block content"),
                }
            }
            other => panic!("expected User event, got {other:?}"),
        }
    }

    /// A tool result with no prior start has no block to close, so the
    /// harness skips the Stop event entirely and only emits the user
    /// payload. Without this branch a stray result would emit a Stop on
    /// an invalid index and confuse the frontend's block table.
    #[tokio::test]
    async fn tool_result_without_prior_start_skips_block_stop() {
        let (event_tx, mut rx, pending, turn_output, init_cache) = pi_state();
        route_pi_message(
            &event_tx,
            &pending,
            &turn_output,
            &init_cache,
            PiHarnessMessage::ToolResult {
                tool_call_id: "ghost-call".to_string(),
                tool_name: "bash".to_string(),
                result: None,
                is_error: true,
            },
        )
        .await;
        match next_event(&mut rx).await {
            AgentEvent::Stream(StreamEvent::User { message, .. }) => match message.content {
                UserMessageContent::Blocks(blocks) => match &blocks[0] {
                    UserContentBlock::ToolResult { content, .. } => {
                        assert_eq!(content["is_error"], true);
                        // Fallback content was synthesized from is_error
                        assert_eq!(content["result"], json!({"ok": false}));
                    }
                    other => panic!("expected ToolResult, got {other:?}"),
                },
                _ => panic!("expected block content"),
            },
            other => panic!("expected User event, got {other:?}"),
        }
        // No stray Stop event should remain queued
        assert!(try_recv_now(&mut rx).is_none());
    }

    /// Successful turn end emits any accumulated text/thinking as the
    /// final Assistant message and a Result with subtype `success`.
    #[tokio::test]
    async fn turn_end_success_finalizes_assistant_and_result() {
        let (event_tx, mut rx, pending, turn_output, init_cache) = pi_state();
        {
            let mut output = turn_output.lock().await;
            output.text.push_str("final answer");
            output.thinking.push_str("ponder");
        }
        route_pi_message(
            &event_tx,
            &pending,
            &turn_output,
            &init_cache,
            PiHarnessMessage::TurnEnd { error: None },
        )
        .await;
        let assistant = next_event(&mut rx).await;
        let result = next_event(&mut rx).await;
        match assistant {
            AgentEvent::Stream(StreamEvent::Assistant { message }) => {
                assert_eq!(message.content.len(), 2);
                assert!(matches!(message.content[0], ContentBlock::Thinking { .. }));
                assert!(matches!(message.content[1], ContentBlock::Text { .. }));
            }
            other => panic!("expected Assistant, got {other:?}"),
        }
        match result {
            AgentEvent::Stream(StreamEvent::Result {
                subtype, result, ..
            }) => {
                assert_eq!(subtype, "success");
                assert_eq!(result.as_deref(), Some("final answer"));
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }

    /// Turn-end with an error must surface the error text both as a
    /// trailing assistant block (so the chat shows the failure even
    /// after partial output) and inside Result.result (consumers that
    /// only read the Result still see it).
    #[tokio::test]
    async fn turn_end_error_surfaces_error_in_assistant_and_result() {
        let (event_tx, mut rx, pending, turn_output, init_cache) = pi_state();
        turn_output.lock().await.text.push_str("partial");
        route_pi_message(
            &event_tx,
            &pending,
            &turn_output,
            &init_cache,
            PiHarnessMessage::TurnEnd {
                error: Some("rate limit".to_string()),
            },
        )
        .await;
        match next_event(&mut rx).await {
            AgentEvent::Stream(StreamEvent::Assistant { message }) => {
                // First block: partial text; last block: failure text
                let last = message
                    .content
                    .last()
                    .expect("error block must be appended");
                match last {
                    ContentBlock::Text { text } => assert!(text.contains("rate limit")),
                    other => panic!("expected trailing Text, got {other:?}"),
                }
            }
            other => panic!("expected Assistant, got {other:?}"),
        }
        match next_event(&mut rx).await {
            AgentEvent::Stream(StreamEvent::Result {
                subtype, result, ..
            }) => {
                assert_eq!(subtype, "error");
                let result = result.expect("result text present");
                assert!(result.contains("partial"));
                assert!(result.contains("rate limit"));
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }

    /// When the turn produced no text and no thinking, the assistant
    /// message is skipped (would be an empty body), but the Result is
    /// still emitted so the chat bridge knows the turn closed.
    #[tokio::test]
    async fn turn_end_with_empty_output_skips_assistant() {
        let (event_tx, mut rx, pending, turn_output, init_cache) = pi_state();
        route_pi_message(
            &event_tx,
            &pending,
            &turn_output,
            &init_cache,
            PiHarnessMessage::TurnEnd { error: None },
        )
        .await;
        match next_event(&mut rx).await {
            AgentEvent::Stream(StreamEvent::Result { subtype, .. }) => {
                assert_eq!(subtype, "success");
            }
            other => panic!("expected Result, got {other:?}"),
        }
        assert!(try_recv_now(&mut rx).is_none());
    }

    #[tokio::test]
    async fn error_message_emits_stderr() {
        let (event_tx, mut rx, pending, turn_output, init_cache) = pi_state();
        route_pi_message(
            &event_tx,
            &pending,
            &turn_output,
            &init_cache,
            PiHarnessMessage::Error {
                error: Some("oops".to_string()),
            },
        )
        .await;
        match next_event(&mut rx).await {
            AgentEvent::Stderr(line) => assert_eq!(line, "oops"),
            other => panic!("expected Stderr, got {other:?}"),
        }
    }

    /// Error with no message must still emit *something* on stderr so
    /// the chat shows the failure cause; falling back to silence would
    /// strand the user.
    #[tokio::test]
    async fn error_message_with_no_text_falls_back_to_default() {
        let (event_tx, mut rx, pending, turn_output, init_cache) = pi_state();
        route_pi_message(
            &event_tx,
            &pending,
            &turn_output,
            &init_cache,
            PiHarnessMessage::Error { error: None },
        )
        .await;
        match next_event(&mut rx).await {
            AgentEvent::Stderr(line) => assert!(!line.is_empty()),
            other => panic!("expected Stderr, got {other:?}"),
        }
    }

    /// Unknown variants (e.g. a future-protocol message Claudette
    /// doesn't recognize yet) must not crash the reader loop.
    #[tokio::test]
    async fn unknown_variant_is_silently_ignored() {
        let (event_tx, mut rx, pending, turn_output, init_cache) = pi_state();
        route_pi_message(
            &event_tx,
            &pending,
            &turn_output,
            &init_cache,
            PiHarnessMessage::Unknown,
        )
        .await;
        assert!(try_recv_now(&mut rx).is_none());
    }

    #[tokio::test]
    async fn fail_pending_requests_drains_and_errors_each() {
        let pending: PendingRequests = Arc::new(Mutex::new(BTreeMap::new()));
        let (tx_a, rx_a) = oneshot::channel();
        let (tx_b, rx_b) = oneshot::channel();
        {
            let mut p = pending.lock().await;
            p.insert(
                "a".to_string(),
                PendingPiRequest {
                    command: "prompt".to_string(),
                    tx: tx_a,
                },
            );
            p.insert(
                "b".to_string(),
                PendingPiRequest {
                    command: "abort".to_string(),
                    tx: tx_b,
                },
            );
        }
        fail_pending_requests(&pending, "sidecar exited").await;
        assert!(pending.lock().await.is_empty());
        let a = rx_a.await.expect("delivered");
        let b = rx_b.await.expect("delivered");
        for r in [a, b] {
            let err = r.expect_err("fail path");
            assert!(err.contains("sidecar exited"));
        }
    }

    #[tokio::test]
    async fn resolve_pi_harness_path_honors_env_override() {
        // SAFETY: tests inside this module run single-threaded for the
        // env-mutation block. The CI runner is concurrent in general but
        // this test is the only one touching CLAUDETTE_PI_HARNESS.
        unsafe { std::env::set_var("CLAUDETTE_PI_HARNESS", "/tmp/sidecar-mock") };
        let path = resolve_pi_harness_path().await;
        unsafe { std::env::remove_var("CLAUDETTE_PI_HARNESS") };
        assert_eq!(path, PathBuf::from("/tmp/sidecar-mock"));
    }

    #[test]
    fn host_triple_resolves_to_known_target() {
        let triple = host_triple();
        // We don't pin a specific host (CI runs Linux + macOS) but the
        // mapping must always produce a recognized rustc target triple
        // rather than silently dropping a new platform onto the
        // catch-all "unknown" arm.
        let known = [
            "aarch64-apple-darwin",
            "x86_64-apple-darwin",
            "x86_64-unknown-linux-gnu",
            "aarch64-unknown-linux-gnu",
            "x86_64-pc-windows-msvc",
            "aarch64-pc-windows-msvc",
        ];
        assert!(
            known.contains(&triple),
            "host_triple() returned `{triple}` — add the new platform mapping",
        );
    }

    #[test]
    fn pi_command_line_event_carries_path_as_subtype() {
        let event = pi_command_line_event(Path::new("/opt/bin/claudette-pi-harness"));
        match event {
            AgentEvent::Stream(StreamEvent::System {
                subtype,
                command_line,
                ..
            }) => {
                assert_eq!(subtype, "command_line");
                assert_eq!(
                    command_line.as_deref(),
                    Some("/opt/bin/claudette-pi-harness")
                );
            }
            other => panic!("expected System command_line, got {other:?}"),
        }
    }

    #[test]
    fn resolve_pi_package_dir_finds_sibling_pi_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let harness = tmp.path().join("claudette-pi-harness");
        std::fs::write(&harness, b"").unwrap();
        let pi_dir = tmp.path().join("pi");
        std::fs::create_dir(&pi_dir).unwrap();
        assert_eq!(resolve_pi_package_dir(&harness), Some(pi_dir));
    }

    #[test]
    fn resolve_pi_package_dir_returns_none_when_no_sibling_or_app_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let harness = tmp.path().join("claudette-pi-harness");
        std::fs::write(&harness, b"").unwrap();
        // No sibling `pi/`, and we can't guarantee the test binary's
        // exe-relative candidates don't accidentally exist on disk, so
        // we only assert that *if* the call returns Some, the result
        // exists. The interesting branch — sibling preference — is
        // covered by the test above.
        if let Some(path) = resolve_pi_package_dir(&harness) {
            assert!(path.exists());
        }
    }

    #[test]
    fn pi_sdk_model_roundtrips_with_optional_context() {
        let with = serde_json::from_str::<PiSdkModel>(
            r#"{"id":"openai/gpt-5.4","label":"GPT-5.4","contextWindowTokens":272000}"#,
        )
        .unwrap();
        assert_eq!(with.id, "openai/gpt-5.4");
        assert_eq!(with.context_window_tokens, Some(272_000));

        let without = serde_json::from_str::<PiSdkModel>(r#"{"id":"x/y","label":"Y"}"#).unwrap();
        assert!(without.context_window_tokens.is_none());

        // The wire form is camelCase — pin the rename so a future
        // serde-rename refactor doesn't silently break Pi discovery.
        let serialized = serde_json::to_value(&with).unwrap();
        assert!(serialized.get("contextWindowTokens").is_some());
        assert!(serialized.get("context_window_tokens").is_none());
    }

    // ===== Helpers used only by TurnStart =====

    #[derive(Debug)]
    enum InnerKind {
        MessageStart,
        ContentBlockStart(usize),
        Other,
    }

    async fn next_event_kind(rx: &mut broadcast::Receiver<AgentEvent>) -> InnerKind {
        match next_event(rx).await {
            AgentEvent::Stream(StreamEvent::Stream {
                event: InnerStreamEvent::MessageStart {},
            }) => InnerKind::MessageStart,
            AgentEvent::Stream(StreamEvent::Stream {
                event: InnerStreamEvent::ContentBlockStart { index, .. },
            }) => InnerKind::ContentBlockStart(index),
            _ => InnerKind::Other,
        }
    }
}
