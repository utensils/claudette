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

impl PiSdkSession {
    pub async fn start(
        working_dir: &Path,
        session_id: &str,
        options: PiSdkOptions,
    ) -> Result<Self, String> {
        crate::missing_cli::precheck_cwd(working_dir)?;

        let pi_path = resolve_pi_harness_path().await;
        let mut cmd = Command::new(&pi_path);
        cmd.no_console_window();
        cmd.current_dir(working_dir)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .env("PATH", crate::env::enriched_path());
        if let Some(env) = options.resolved_env.as_ref() {
            apply_resolved_env_to_command(&mut cmd, env);
        }
        if let Some(env) = options.workspace_env.as_ref() {
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
            working_dir: working_dir.to_path_buf(),
            turn_output: Arc::new(tokio::sync::Mutex::new(PiTurnOutput::default())),
            init_cache: Arc::new(tokio::sync::Mutex::new(InitCache::default())),
        };

        session.spawn_stdout_reader(stdout);
        session.spawn_stderr_reader(stderr);
        session.spawn_exit_watcher(child);
        // Cache the command-line marker so the first turn's per-turn receiver
        // can replay it; sending it through `event_tx` before any subscriber
        // exists would drop it on the floor.
        session.init_cache.lock().await.command_line = Some(pi_command_line_event(&pi_path));
        session.initialize().await?;
        session
            .start_session(session_id, options)
            .await
            .map_err(|err| format!("Pi SDK harness start_session failed: {err}"))?;
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
        crate::missing_cli::precheck_cwd(working_dir)?;

        let pi_path = resolve_pi_harness_path().await;
        let mut cmd = Command::new(&pi_path);
        cmd.no_console_window();
        cmd.current_dir(working_dir)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .env("PATH", crate::env::enriched_path());
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
            working_dir: working_dir.to_path_buf(),
            turn_output: Arc::new(tokio::sync::Mutex::new(PiTurnOutput::default())),
            init_cache: Arc::new(tokio::sync::Mutex::new(InitCache::default())),
        };

        session.spawn_stdout_reader(stdout);
        session.spawn_stderr_reader(stderr);
        session.spawn_exit_watcher(child);
        session.initialize().await?;
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
        self.send_request(json!({
            "type": "start_session",
            "cwd": self.working_dir,
            "sessionId": session_id,
            "sessionDir": session_dir,
            "model": options.model,
            "thinkingLevel": options.thinking_level,
            "allowedTools": options.allowed_tools,
            "customInstructions": options.custom_instructions,
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
        #[serde(default)]
        session_id: Option<String>,
        #[serde(default, rename = "sessionId")]
        session_id_camel: Option<String>,
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
        PiHarnessMessage::Ready {
            session_id,
            session_id_camel,
        } => {
            let init_event = AgentEvent::Stream(StreamEvent::System {
                subtype: "init".to_string(),
                session_id: session_id.or(session_id_camel),
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
            // When a turn fails with no assistant text, surface the error as
            // assistant content so the user sees a message instead of a
            // silently-finalized empty turn.
            if content.is_empty()
                && let Some(err) = error_text.as_ref()
            {
                content.push(ContentBlock::Text { text: err.clone() });
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
}
