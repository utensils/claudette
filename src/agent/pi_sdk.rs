use std::collections::BTreeMap;
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

use super::{
    AgentEvent, AssistantMessage, ContentBlock, ControlRequestInner, Delta, FileAttachment,
    InnerStreamEvent, StartContentBlock, StreamEvent, TurnHandle, UserContentBlock,
    UserEventMessage, UserMessageContent,
};

type PiStdin = Arc<tokio::sync::Mutex<ChildStdin>>;
type PendingRequests = Arc<tokio::sync::Mutex<BTreeMap<String, PendingPiRequest>>>;
type TurnOutput = Arc<tokio::sync::Mutex<PiTurnOutput>>;

struct PendingPiRequest {
    command: String,
    tx: oneshot::Sender<Result<Value, String>>,
}

#[derive(Default)]
struct PiTurnOutput {
    text: String,
    thinking: String,
}

#[derive(Debug, Clone)]
pub struct PiSdkOptions {
    pub model: Option<String>,
    pub thinking_level: Option<String>,
    pub session_dir: Option<PathBuf>,
    pub allowed_tools: Vec<String>,
}

pub struct PiSdkSession {
    pid: u32,
    stdin: Option<PiStdin>,
    event_tx: broadcast::Sender<AgentEvent>,
    pending: PendingRequests,
    next_request_id: AtomicI64,
    working_dir: PathBuf,
    turn_output: TurnOutput,
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
        };

        session.spawn_stdout_reader(stdout);
        session.spawn_stderr_reader(stderr);
        session.spawn_exit_watcher(child);
        let _ = session.event_tx.send(pi_command_line_event(&pi_path));
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
        self.send_request(json!({
            "type": "prompt",
            "prompt": prompt,
        }))
        .await?;

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
        tokio::spawn(async move {
            let reader = tokio::io::BufReader::new(stdout);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                match serde_json::from_str::<PiHarnessMessage>(&line) {
                    Ok(message) => {
                        route_pi_message(&event_tx, &pending, &turn_output, message).await;
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
        #[serde(default, rename = "toolCallId")]
        tool_call_id: Option<String>,
        #[serde(default, rename = "toolName")]
        tool_name: Option<String>,
        #[serde(default)]
        args: Option<Value>,
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
            let _ = event_tx.send(AgentEvent::Stream(StreamEvent::System {
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
            }));
        }
        PiHarnessMessage::TurnStart => {
            *turn_output.lock().await = PiTurnOutput::default();
            let _ = event_tx.send(AgentEvent::Stream(StreamEvent::Stream {
                event: InnerStreamEvent::MessageStart {},
            }));
            let _ = event_tx.send(AgentEvent::Stream(StreamEvent::Stream {
                event: InnerStreamEvent::ContentBlockStart {
                    index: 0,
                    content_block: Some(StartContentBlock::Text {}),
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
            tool_call_id,
            tool_name,
            args,
        } => {
            let id = tool_call_id.unwrap_or_else(|| "pi-tool".to_string());
            let name = tool_name.unwrap_or_else(|| "tool".to_string());
            let _ = event_tx.send(AgentEvent::Stream(StreamEvent::Stream {
                event: InnerStreamEvent::ContentBlockStart {
                    index: 2,
                    content_block: Some(StartContentBlock::ToolUse {
                        id: id.clone(),
                        name,
                    }),
                },
            }));
            if let Some(args) = args {
                let _ = event_tx.send(AgentEvent::Stream(StreamEvent::Stream {
                    event: InnerStreamEvent::ContentBlockDelta {
                        index: 2,
                        delta: Delta::InputJson {
                            partial_json: Some(args.to_string()),
                        },
                    },
                }));
            }
        }
        PiHarnessMessage::ToolResult {
            tool_call_id,
            tool_name,
            result,
            is_error,
        } => {
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
            if !content.is_empty() {
                let _ = event_tx.send(AgentEvent::Stream(StreamEvent::Assistant {
                    message: AssistantMessage { content },
                }));
            }
            let subtype = if error.is_some() { "error" } else { "success" };
            let _ = event_tx.send(AgentEvent::Stream(StreamEvent::Result {
                subtype: subtype.to_string(),
                result: Some(output.text.clone()),
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
    let bundled = dir.join("pi");
    bundled.exists().then_some(bundled)
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
