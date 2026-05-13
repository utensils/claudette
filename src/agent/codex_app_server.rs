use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};
use tokio::process::{ChildStdin, Command};
use tokio::sync::broadcast;
use tokio::sync::oneshot;

use crate::process::CommandWindowExt as _;

use super::{AgentEvent, Delta, InnerStreamEvent, StartContentBlock, StreamEvent, TokenUsage};

type CodexStdin = Arc<tokio::sync::Mutex<ChildStdin>>;
type PendingRequests = Arc<tokio::sync::Mutex<BTreeMap<JsonRpcId, PendingCodexRequest>>>;

struct PendingCodexRequest {
    method: String,
    tx: oneshot::Sender<Result<JsonRpcResponse, JsonRpcError>>,
}

pub struct CodexAppServerSession {
    pid: u32,
    stdin: Option<CodexStdin>,
    event_tx: broadcast::Sender<AgentEvent>,
    pending: PendingRequests,
    next_request_id: AtomicI64,
}

impl CodexAppServerSession {
    pub async fn start(working_dir: &Path, client_version: &str) -> Result<Self, String> {
        crate::missing_cli::precheck_cwd(working_dir)?;

        let mut cmd = Command::new("codex");
        cmd.no_console_window();
        cmd.args(codex_app_server_args())
            .current_dir(working_dir)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .env("PATH", crate::env::enriched_path());

        let mut child = cmd.spawn().map_err(|e| {
            crate::missing_cli::map_spawn_err(&e, "codex", || {
                format!("Failed to spawn Codex app-server: {e}")
            })
        })?;
        let pid = child
            .id()
            .ok_or_else(|| "Codex app-server exited immediately".to_string())?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to capture Codex app-server stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to capture Codex app-server stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Failed to capture Codex app-server stderr".to_string())?;

        let (event_tx, _) = broadcast::channel(2048);
        let session = Self {
            pid,
            stdin: Some(Arc::new(tokio::sync::Mutex::new(stdin))),
            event_tx,
            pending: Arc::new(tokio::sync::Mutex::new(BTreeMap::new())),
            next_request_id: AtomicI64::new(1),
        };

        session.spawn_stdout_reader(stdout);
        session.spawn_stderr_reader(stderr);
        session.spawn_exit_watcher(child);
        let _ = session.event_tx.send(codex_command_line_event());
        session.initialize(client_version).await?;

        Ok(session)
    }

    #[cfg(test)]
    pub fn new_for_test(pid: u32) -> Self {
        let (event_tx, _) = broadcast::channel(128);
        Self {
            pid,
            stdin: None,
            event_tx,
            pending: Arc::new(tokio::sync::Mutex::new(BTreeMap::new())),
            next_request_id: AtomicI64::new(1),
        }
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn subscribe(&self) -> broadcast::Receiver<AgentEvent> {
        self.event_tx.subscribe()
    }

    pub fn publish_notification_event(&self, event: CodexNotificationEvent) {
        for event in map_notification_to_agent_events(event) {
            let _ = self.event_tx.send(event);
        }
    }

    async fn initialize(&self, client_version: &str) -> Result<(), String> {
        let request = build_initialize_request(self.next_id(), client_version);
        self.send_request(request).await?;
        self.send_notification(build_initialized_notification())
            .await
    }

    async fn send_request(&self, request: JsonRpcRequest) -> Result<JsonRpcResponse, String> {
        let stdin = self
            .stdin
            .as_ref()
            .ok_or_else(|| "Codex app-server stdin is not available".to_string())?;
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().await;
            pending.insert(
                request.id.clone(),
                PendingCodexRequest {
                    method: request.method.clone(),
                    tx,
                },
            );
        }
        let write_result = {
            let mut stdin = stdin.lock().await;
            write_jsonrpc_message(&mut *stdin, &JsonRpcMessage::Request(request.clone())).await
        };
        if let Err(err) = write_result {
            let mut pending = self.pending.lock().await;
            pending.remove(&request.id);
            return Err(err);
        }
        match rx.await.map_err(|_| {
            format!(
                "Codex app-server response channel closed for `{}`",
                request.method
            )
        })? {
            Ok(response) => Ok(response),
            Err(error) => Err(format!(
                "Codex app-server `{}` failed: {}",
                request.method, error.error.message
            )),
        }
    }

    async fn send_notification(&self, notification: JsonRpcNotification) -> Result<(), String> {
        let stdin = self
            .stdin
            .as_ref()
            .ok_or_else(|| "Codex app-server stdin is not available".to_string())?;
        let mut stdin = stdin.lock().await;
        write_jsonrpc_message(&mut *stdin, &JsonRpcMessage::Notification(notification)).await
    }

    fn next_id(&self) -> i64 {
        self.next_request_id.fetch_add(1, Ordering::Relaxed)
    }

    fn spawn_stdout_reader(&self, stdout: tokio::process::ChildStdout) {
        let event_tx = self.event_tx.clone();
        let pending = self.pending.clone();
        let pid = self.pid;
        tokio::spawn(async move {
            let mut reader = tokio::io::BufReader::new(stdout);
            while let Ok(Some(message)) = read_jsonrpc_message(&mut reader).await {
                route_app_server_message(pid, &event_tx, &pending, message).await;
            }
        });
    }

    fn spawn_stderr_reader(&self, stderr: tokio::process::ChildStderr) {
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
                        let line = line.trim();
                        if !line.is_empty() {
                            tracing::warn!(
                                target: "claudette::agent",
                                subsystem = "codex-app-server",
                                pid,
                                line,
                                "codex stderr"
                            );
                            let _ = event_tx.send(AgentEvent::Stderr(line.to_string()));
                        }
                    }
                    Err(err) => {
                        tracing::warn!(
                            target: "claudette::agent",
                            subsystem = "codex-app-server",
                            pid,
                            error = %err,
                            "failed to read codex stderr"
                        );
                        break;
                    }
                }
            }
        });
    }

    fn spawn_exit_watcher(&self, mut child: tokio::process::Child) {
        let event_tx = self.event_tx.clone();
        tokio::spawn(async move {
            let status = child.wait().await.ok().and_then(|status| status.code());
            let _ = event_tx.send(AgentEvent::ProcessExited(status));
        });
    }
}

async fn route_app_server_message(
    pid: u32,
    event_tx: &broadcast::Sender<AgentEvent>,
    pending: &PendingRequests,
    message: JsonRpcMessage,
) {
    match message {
        JsonRpcMessage::Response(response) => {
            let request = {
                let mut pending = pending.lock().await;
                response.id.as_ref().and_then(|id| pending.remove(id))
            };
            if let Some(request) = request {
                let method = request.method.clone();
                if request.tx.send(Ok(response)).is_err() {
                    tracing::warn!(
                        target: "claudette::agent",
                        subsystem = "codex-app-server",
                        pid,
                        method,
                        "codex response receiver dropped"
                    );
                }
            } else {
                tracing::warn!(
                    target: "claudette::agent",
                    subsystem = "codex-app-server",
                    pid,
                id = ?response.id,
                    "orphan codex response"
                );
            }
        }
        JsonRpcMessage::Error(error) => {
            let request = {
                let mut pending = pending.lock().await;
                error.id.as_ref().and_then(|id| pending.remove(id))
            };
            if let Some(request) = request {
                let method = request.method.clone();
                if request.tx.send(Err(error)).is_err() {
                    tracing::warn!(
                        target: "claudette::agent",
                        subsystem = "codex-app-server",
                        pid,
                        method,
                        "codex error receiver dropped"
                    );
                }
            } else {
                tracing::warn!(
                    target: "claudette::agent",
                    subsystem = "codex-app-server",
                    pid,
                id = ?error.id,
                    "orphan codex error"
                );
            }
        }
        JsonRpcMessage::Notification(notification) => {
            for event in map_notification_to_agent_events(decode_notification(notification)) {
                let _ = event_tx.send(event);
            }
        }
        JsonRpcMessage::Request(request) => {
            tracing::warn!(
                target: "claudette::agent",
                subsystem = "codex-app-server",
                pid,
                method = %request.method,
                "codex app-server request handling is not wired yet"
            );
            let _ = event_tx.send(AgentEvent::Stderr(format!(
                "Codex app-server request `{}` is not handled yet.",
                request.method
            )));
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(untagged)]
pub enum JsonRpcId {
    Integer(i64),
    String(String),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum JsonRpcMessage {
    Request(JsonRpcRequest),
    Notification(JsonRpcNotification),
    Response(JsonRpcResponse),
    Error(JsonRpcError),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JsonRpcRequest {
    pub id: JsonRpcId,
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JsonRpcNotification {
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JsonRpcResponse {
    pub id: Option<JsonRpcId>,
    pub result: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JsonRpcError {
    pub id: Option<JsonRpcId>,
    pub error: JsonRpcErrorBody,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JsonRpcErrorBody {
    pub code: i64,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CodexRoutedMessage {
    Response {
        method: String,
        response: JsonRpcResponse,
    },
    Error {
        method: String,
        error: JsonRpcError,
    },
    Notification(CodexNotificationEvent),
    ServerRequest(JsonRpcRequest),
    OrphanResponse(JsonRpcResponse),
    OrphanError(JsonRpcError),
}

#[derive(Debug, Default)]
pub struct CodexResponseRouter {
    pending: BTreeMap<JsonRpcId, String>,
}

impl CodexResponseRouter {
    pub fn track_request(&mut self, request: &JsonRpcRequest) {
        self.pending
            .insert(request.id.clone(), request.method.clone());
    }

    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }

    pub fn route(&mut self, message: JsonRpcMessage) -> CodexRoutedMessage {
        match message {
            JsonRpcMessage::Response(response) => {
                let request = response.id.as_ref().and_then(|id| self.pending.remove(id));
                match request {
                    Some(method) => CodexRoutedMessage::Response { method, response },
                    None => CodexRoutedMessage::OrphanResponse(response),
                }
            }
            JsonRpcMessage::Error(error) => {
                let request = error.id.as_ref().and_then(|id| self.pending.remove(id));
                match request {
                    Some(method) => CodexRoutedMessage::Error { method, error },
                    None => CodexRoutedMessage::OrphanError(error),
                }
            }
            JsonRpcMessage::Notification(notification) => {
                CodexRoutedMessage::Notification(decode_notification(notification))
            }
            JsonRpcMessage::Request(request) => CodexRoutedMessage::ServerRequest(request),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodexPermissionLevel {
    Readonly,
    Standard,
    Full,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CodexApprovalPolicy {
    #[serde(rename = "untrusted")]
    UnlessTrusted,
    OnRequest,
    Never,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CodexSandboxMode {
    ReadOnly,
    WorkspaceWrite,
    DangerFullAccess,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CodexSandboxPolicy {
    DangerFullAccess,
    #[serde(rename_all = "camelCase")]
    ReadOnly {
        network_access: bool,
    },
    #[serde(rename_all = "camelCase")]
    WorkspaceWrite {
        network_access: bool,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CodexPermissionMapping {
    pub approval_policy: CodexApprovalPolicy,
    pub thread_sandbox: CodexSandboxMode,
    pub turn_sandbox_policy: CodexSandboxPolicy,
}

impl CodexPermissionLevel {
    pub fn from_claudette_level(level: &str) -> Self {
        match level {
            "readonly" => Self::Readonly,
            "standard" => Self::Standard,
            "full" => Self::Full,
            _ => Self::Readonly,
        }
    }

    pub fn mapping(self) -> CodexPermissionMapping {
        match self {
            Self::Readonly => CodexPermissionMapping {
                approval_policy: CodexApprovalPolicy::UnlessTrusted,
                thread_sandbox: CodexSandboxMode::ReadOnly,
                turn_sandbox_policy: CodexSandboxPolicy::ReadOnly {
                    network_access: false,
                },
            },
            Self::Standard => CodexPermissionMapping {
                approval_policy: CodexApprovalPolicy::OnRequest,
                thread_sandbox: CodexSandboxMode::WorkspaceWrite,
                turn_sandbox_policy: CodexSandboxPolicy::WorkspaceWrite {
                    network_access: false,
                },
            },
            Self::Full => CodexPermissionMapping {
                approval_policy: CodexApprovalPolicy::Never,
                thread_sandbox: CodexSandboxMode::DangerFullAccess,
                turn_sandbox_policy: CodexSandboxPolicy::DangerFullAccess,
            },
        }
    }
}

pub fn parse_jsonrpc_line(line: &str) -> Result<JsonRpcMessage, serde_json::Error> {
    serde_json::from_str(line)
}

pub async fn read_jsonrpc_message<R>(reader: &mut R) -> Result<Option<JsonRpcMessage>, String>
where
    R: AsyncBufRead + Unpin,
{
    let mut line = String::new();
    loop {
        line.clear();
        let bytes = reader
            .read_line(&mut line)
            .await
            .map_err(|e| format!("Failed to read Codex app-server message: {e}"))?;
        if bytes == 0 {
            return Ok(None);
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        return parse_jsonrpc_line(trimmed)
            .map(Some)
            .map_err(|e| format!("Failed to parse Codex app-server JSON-RPC line: {e}"));
    }
}

pub async fn write_jsonrpc_message<W>(
    writer: &mut W,
    message: &JsonRpcMessage,
) -> Result<(), String>
where
    W: AsyncWrite + Unpin,
{
    let payload = serde_json::to_string(message)
        .map_err(|e| format!("Failed to encode Codex app-server JSON-RPC message: {e}"))?;
    writer
        .write_all(payload.as_bytes())
        .await
        .map_err(|e| format!("Failed to write Codex app-server JSON-RPC message: {e}"))?;
    writer
        .write_all(b"\n")
        .await
        .map_err(|e| format!("Failed to write Codex app-server JSON-RPC newline: {e}"))?;
    writer
        .flush()
        .await
        .map_err(|e| format!("Failed to flush Codex app-server JSON-RPC message: {e}"))?;
    Ok(())
}

pub fn codex_app_server_args() -> [&'static str; 3] {
    ["app-server", "--listen", "stdio://"]
}

pub fn build_initialize_request(id: i64, client_version: &str) -> JsonRpcRequest {
    JsonRpcRequest {
        id: JsonRpcId::Integer(id),
        method: "initialize".to_string(),
        params: Some(json!({
            "clientInfo": {
                "name": "claudette",
                "title": "Claudette",
                "version": client_version,
            },
            "capabilities": {
                "experimentalApi": true,
            },
        })),
    }
}

pub fn build_initialized_notification() -> JsonRpcNotification {
    JsonRpcNotification {
        method: "initialized".to_string(),
        params: None,
    }
}

pub fn build_thread_start_request(
    id: i64,
    model: Option<&str>,
    cwd: &Path,
    permission_level: CodexPermissionLevel,
) -> JsonRpcRequest {
    let mapping = permission_level.mapping();
    JsonRpcRequest {
        id: JsonRpcId::Integer(id),
        method: "thread/start".to_string(),
        params: Some(json!({
            "model": model,
            "modelProvider": "openai",
            "cwd": cwd,
            "approvalPolicy": mapping.approval_policy,
            "approvalsReviewer": "user",
            "sandbox": mapping.thread_sandbox,
            "threadSource": "user",
        })),
    }
}

pub fn build_turn_start_request(
    id: i64,
    thread_id: &str,
    prompt: &str,
    cwd: &Path,
    model: Option<&str>,
    permission_level: CodexPermissionLevel,
) -> JsonRpcRequest {
    let mapping = permission_level.mapping();
    JsonRpcRequest {
        id: JsonRpcId::Integer(id),
        method: "turn/start".to_string(),
        params: Some(json!({
            "threadId": thread_id,
            "input": [{
                "type": "text",
                "text": prompt,
                "textElements": [],
            }],
            "cwd": cwd,
            "approvalPolicy": mapping.approval_policy,
            "approvalsReviewer": "user",
            "sandboxPolicy": mapping.turn_sandbox_policy,
            "model": model,
        })),
    }
}

pub fn build_turn_steer_request(
    id: i64,
    thread_id: &str,
    expected_turn_id: &str,
    prompt: &str,
) -> JsonRpcRequest {
    JsonRpcRequest {
        id: JsonRpcId::Integer(id),
        method: "turn/steer".to_string(),
        params: Some(json!({
            "threadId": thread_id,
            "expectedTurnId": expected_turn_id,
            "input": [{
                "type": "text",
                "text": prompt,
                "textElements": [],
            }],
        })),
    }
}

pub fn build_turn_interrupt_request(id: i64, thread_id: &str, turn_id: &str) -> JsonRpcRequest {
    JsonRpcRequest {
        id: JsonRpcId::Integer(id),
        method: "turn/interrupt".to_string(),
        params: Some(json!({
            "threadId": thread_id,
            "turnId": turn_id,
        })),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum CodexNotificationEvent {
    AgentMessageDelta {
        thread_id: String,
        turn_id: String,
        item_id: String,
        delta: String,
    },
    ReasoningSummaryDelta {
        thread_id: String,
        turn_id: String,
        item_id: String,
        delta: String,
        summary_index: i64,
    },
    ReasoningTextDelta {
        thread_id: String,
        turn_id: String,
        item_id: String,
        delta: String,
        content_index: i64,
    },
    CommandOutputDelta {
        thread_id: String,
        turn_id: String,
        item_id: String,
        delta: String,
    },
    TokenUsageUpdated {
        thread_id: String,
        turn_id: String,
        usage: TokenUsage,
    },
    TurnCompleted {
        thread_id: String,
        turn_id: String,
        duration_ms: Option<i64>,
    },
    TurnFailed {
        thread_id: String,
        turn_id: Option<String>,
        message: String,
    },
    Unknown {
        method: String,
        params: Option<Value>,
    },
}

pub fn decode_notification(notification: JsonRpcNotification) -> CodexNotificationEvent {
    let params = notification.params;
    match (notification.method.as_str(), params.as_ref()) {
        ("item/agentMessage/delta", Some(params)) => CodexNotificationEvent::AgentMessageDelta {
            thread_id: string_field(params, "threadId"),
            turn_id: string_field(params, "turnId"),
            item_id: string_field(params, "itemId"),
            delta: string_field(params, "delta"),
        },
        ("item/reasoning/summaryTextDelta", Some(params)) => {
            CodexNotificationEvent::ReasoningSummaryDelta {
                thread_id: string_field(params, "threadId"),
                turn_id: string_field(params, "turnId"),
                item_id: string_field(params, "itemId"),
                delta: string_field(params, "delta"),
                summary_index: params
                    .get("summaryIndex")
                    .and_then(Value::as_i64)
                    .unwrap_or_default(),
            }
        }
        ("item/reasoning/textDelta", Some(params)) => CodexNotificationEvent::ReasoningTextDelta {
            thread_id: string_field(params, "threadId"),
            turn_id: string_field(params, "turnId"),
            item_id: string_field(params, "itemId"),
            delta: string_field(params, "delta"),
            content_index: params
                .get("contentIndex")
                .and_then(Value::as_i64)
                .unwrap_or_default(),
        },
        ("item/commandExecution/outputDelta", Some(params)) => {
            CodexNotificationEvent::CommandOutputDelta {
                thread_id: string_field(params, "threadId"),
                turn_id: string_field(params, "turnId"),
                item_id: string_field(params, "itemId"),
                delta: string_field(params, "delta"),
            }
        }
        ("thread/tokenUsage/updated", Some(params)) => CodexNotificationEvent::TokenUsageUpdated {
            thread_id: string_field(params, "threadId"),
            turn_id: string_field(params, "turnId"),
            usage: token_usage_from_params(params),
        },
        ("turn/completed", Some(params)) => {
            let turn = params.get("turn").unwrap_or(&Value::Null);
            CodexNotificationEvent::TurnCompleted {
                thread_id: string_field(params, "threadId"),
                turn_id: string_field(turn, "id"),
                duration_ms: turn.get("durationMs").and_then(Value::as_i64),
            }
        }
        ("turn/failed", Some(params)) => {
            let turn = params.get("turn");
            let error = turn
                .and_then(|turn| turn.get("error"))
                .or_else(|| params.get("error"))
                .unwrap_or(&Value::Null);
            CodexNotificationEvent::TurnFailed {
                thread_id: string_field(params, "threadId"),
                turn_id: turn.map(|turn| string_field(turn, "id")),
                message: string_field(error, "message"),
            }
        }
        (method, params) => CodexNotificationEvent::Unknown {
            method: method.to_string(),
            params: params.cloned(),
        },
    }
}

pub fn map_notification_to_agent_events(event: CodexNotificationEvent) -> Vec<AgentEvent> {
    match event {
        CodexNotificationEvent::AgentMessageDelta { delta, .. } if !delta.is_empty() => {
            vec![AgentEvent::Stream(StreamEvent::Stream {
                event: InnerStreamEvent::ContentBlockDelta {
                    index: 0,
                    delta: Delta::Text { text: delta },
                },
            })]
        }
        CodexNotificationEvent::ReasoningSummaryDelta { delta, .. }
        | CodexNotificationEvent::ReasoningTextDelta { delta, .. }
            if !delta.is_empty() =>
        {
            vec![AgentEvent::Stream(StreamEvent::Stream {
                event: InnerStreamEvent::ContentBlockDelta {
                    index: 1,
                    delta: Delta::Thinking { thinking: delta },
                },
            })]
        }
        CodexNotificationEvent::CommandOutputDelta { item_id, delta, .. } if !delta.is_empty() => {
            vec![AgentEvent::Stream(StreamEvent::User {
                message: super::UserEventMessage {
                    content: super::UserMessageContent::Blocks(vec![
                        super::UserContentBlock::ToolResult {
                            tool_use_id: item_id,
                            content: Value::String(delta),
                        },
                    ]),
                },
                uuid: None,
                is_replay: false,
                is_synthetic: true,
            })]
        }
        CodexNotificationEvent::TokenUsageUpdated { usage, .. } => {
            vec![AgentEvent::Stream(StreamEvent::Stream {
                event: InnerStreamEvent::MessageDelta { usage: Some(usage) },
            })]
        }
        CodexNotificationEvent::TurnCompleted { duration_ms, .. } => {
            vec![AgentEvent::Stream(StreamEvent::Result {
                subtype: "success".to_string(),
                result: None,
                total_cost_usd: None,
                duration_ms,
                usage: None,
            })]
        }
        CodexNotificationEvent::TurnFailed { message, .. } => {
            vec![AgentEvent::Stream(StreamEvent::Result {
                subtype: "error".to_string(),
                result: Some(message),
                total_cost_usd: None,
                duration_ms: None,
                usage: None,
            })]
        }
        CodexNotificationEvent::AgentMessageDelta { .. }
        | CodexNotificationEvent::ReasoningSummaryDelta { .. }
        | CodexNotificationEvent::ReasoningTextDelta { .. }
        | CodexNotificationEvent::CommandOutputDelta { .. }
        | CodexNotificationEvent::Unknown { .. } => Vec::new(),
    }
}

pub fn codex_invocation_line() -> String {
    format!("codex {}", codex_app_server_args().join(" "))
}

pub fn codex_command_line_event() -> AgentEvent {
    AgentEvent::Stream(StreamEvent::system_command_line(codex_invocation_line()))
}

pub fn codex_turn_start_events() -> Vec<AgentEvent> {
    vec![
        AgentEvent::Stream(StreamEvent::Stream {
            event: InnerStreamEvent::MessageStart {},
        }),
        AgentEvent::Stream(StreamEvent::Stream {
            event: InnerStreamEvent::ContentBlockStart {
                index: 0,
                content_block: Some(StartContentBlock::Text {}),
            },
        }),
        AgentEvent::Stream(StreamEvent::Stream {
            event: InnerStreamEvent::ContentBlockStart {
                index: 1,
                content_block: Some(StartContentBlock::Thinking {}),
            },
        }),
    ]
}

fn string_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn token_usage_from_params(params: &Value) -> TokenUsage {
    let total = params
        .get("tokenUsage")
        .and_then(|usage| usage.get("total"))
        .unwrap_or(&Value::Null);
    let input_tokens = total
        .get("inputTokens")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let cached_input_tokens = total
        .get("cachedInputTokens")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let output_tokens = total
        .get("outputTokens")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    let reasoning_output_tokens = total
        .get("reasoningOutputTokens")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    TokenUsage {
        input_tokens,
        output_tokens: output_tokens + reasoning_output_tokens,
        cache_creation_input_tokens: None,
        cache_read_input_tokens: Some(cached_input_tokens),
        iterations: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initialize_request_matches_codex_app_server_shape() {
        let request = build_initialize_request(1, "0.24.0");
        let value = serde_json::to_value(&request).expect("request serializes");

        assert_eq!(value["id"], 1);
        assert_eq!(value["method"], "initialize");
        assert_eq!(value["params"]["clientInfo"]["name"], "claudette");
        assert_eq!(value["params"]["capabilities"]["experimentalApi"], true);
        assert!(value.get("jsonrpc").is_none());
    }

    #[test]
    fn codex_app_server_invocation_uses_stdio_listener() {
        assert_eq!(
            codex_app_server_args(),
            ["app-server", "--listen", "stdio://"]
        );
        assert_eq!(
            codex_invocation_line(),
            "codex app-server --listen stdio://"
        );
    }

    #[tokio::test]
    async fn writes_jsonrpc_message_as_single_line() {
        let mut out = Vec::new();
        write_jsonrpc_message(
            &mut out,
            &JsonRpcMessage::Request(build_initialize_request(1, "0.24.0")),
        )
        .await
        .expect("message writes");

        let text = String::from_utf8(out).expect("utf8");
        assert!(text.ends_with('\n'));
        assert_eq!(text.lines().count(), 1);
        let parsed = parse_jsonrpc_line(text.trim()).expect("round trip parses");
        assert!(matches!(
            parsed,
            JsonRpcMessage::Request(JsonRpcRequest { method, .. }) if method == "initialize"
        ));
    }

    #[tokio::test]
    async fn reads_jsonrpc_messages_from_newline_stream() {
        let input = br#"
{"method":"initialized"}
{"id":7,"result":{"ok":true}}
"#;
        let mut reader = tokio::io::BufReader::new(&input[..]);

        let first = read_jsonrpc_message(&mut reader)
            .await
            .expect("read succeeds")
            .expect("first message");
        assert!(matches!(
            first,
            JsonRpcMessage::Notification(JsonRpcNotification { method, .. }) if method == "initialized"
        ));

        let second = read_jsonrpc_message(&mut reader)
            .await
            .expect("read succeeds")
            .expect("second message");
        assert!(matches!(
            second,
            JsonRpcMessage::Response(JsonRpcResponse {
                id: Some(JsonRpcId::Integer(7)),
                ..
            })
        ));

        assert!(
            read_jsonrpc_message(&mut reader)
                .await
                .expect("eof succeeds")
                .is_none()
        );
    }

    #[test]
    fn router_correlates_responses_to_tracked_requests() {
        let mut router = CodexResponseRouter::default();
        let request = build_turn_start_request(
            9,
            "thread-1",
            "hello",
            Path::new("/tmp/work"),
            None,
            CodexPermissionLevel::Readonly,
        );
        router.track_request(&request);
        assert_eq!(router.pending_len(), 1);

        let routed = router.route(JsonRpcMessage::Response(JsonRpcResponse {
            id: Some(JsonRpcId::Integer(9)),
            result: json!({"turn":{"id":"turn-1"}}),
        }));

        let CodexRoutedMessage::Response { method, response } = routed else {
            panic!("expected correlated response");
        };
        assert_eq!(method, "turn/start");
        assert_eq!(response.result["turn"]["id"], "turn-1");
        assert_eq!(router.pending_len(), 0);
    }

    #[test]
    fn router_preserves_server_requests_for_approval_layer() {
        let mut router = CodexResponseRouter::default();
        let routed = router.route(JsonRpcMessage::Request(JsonRpcRequest {
            id: JsonRpcId::String("approval-1".to_string()),
            method: "item/commandExecution/requestApproval".to_string(),
            params: Some(json!({"threadId":"thread-1"})),
        }));

        let CodexRoutedMessage::ServerRequest(request) = routed else {
            panic!("expected server request");
        };
        assert_eq!(request.method, "item/commandExecution/requestApproval");
        assert_eq!(request.params.unwrap()["threadId"], "thread-1");
    }

    #[test]
    fn router_decodes_notifications() {
        let mut router = CodexResponseRouter::default();
        let routed = router.route(JsonRpcMessage::Notification(JsonRpcNotification {
            method: "item/agentMessage/delta".to_string(),
            params: Some(json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "itemId": "message-1",
                "delta": "hello"
            })),
        }));

        let CodexRoutedMessage::Notification(CodexNotificationEvent::AgentMessageDelta {
            delta,
            ..
        }) = routed
        else {
            panic!("expected notification");
        };
        assert_eq!(delta, "hello");
    }

    #[test]
    fn router_surfaces_orphan_responses() {
        let mut router = CodexResponseRouter::default();
        let routed = router.route(JsonRpcMessage::Response(JsonRpcResponse {
            id: Some(JsonRpcId::Integer(404)),
            result: json!({"late": true}),
        }));

        assert!(matches!(
            routed,
            CodexRoutedMessage::OrphanResponse(JsonRpcResponse {
                id: Some(JsonRpcId::Integer(404)),
                ..
            })
        ));
    }

    #[test]
    fn parses_null_id_error_as_orphan_error() {
        let message =
            parse_jsonrpc_line(r#"{"id":null,"error":{"code":-32700,"message":"Parse error"}}"#)
                .expect("null-id error parses");
        let mut router = CodexResponseRouter::default();
        let routed = router.route(message);

        let CodexRoutedMessage::OrphanError(JsonRpcError { id: None, error }) = routed else {
            panic!("expected null-id orphan error");
        };
        assert_eq!(error.code, -32700);
        assert_eq!(error.message, "Parse error");
    }

    #[test]
    fn initialized_notification_omits_empty_params() {
        let value = serde_json::to_value(build_initialized_notification()).unwrap();
        assert_eq!(value, json!({"method": "initialized"}));
    }

    #[test]
    fn permission_levels_map_to_codex_policy_and_sandbox() {
        assert_eq!(
            CodexPermissionLevel::from_claudette_level("readonly").mapping(),
            CodexPermissionMapping {
                approval_policy: CodexApprovalPolicy::UnlessTrusted,
                thread_sandbox: CodexSandboxMode::ReadOnly,
                turn_sandbox_policy: CodexSandboxPolicy::ReadOnly {
                    network_access: false
                },
            }
        );
        assert_eq!(
            CodexPermissionLevel::from_claudette_level("standard").mapping(),
            CodexPermissionMapping {
                approval_policy: CodexApprovalPolicy::OnRequest,
                thread_sandbox: CodexSandboxMode::WorkspaceWrite,
                turn_sandbox_policy: CodexSandboxPolicy::WorkspaceWrite {
                    network_access: false
                },
            }
        );
        assert_eq!(
            CodexPermissionLevel::from_claudette_level("full").mapping(),
            CodexPermissionMapping {
                approval_policy: CodexApprovalPolicy::Never,
                thread_sandbox: CodexSandboxMode::DangerFullAccess,
                turn_sandbox_policy: CodexSandboxPolicy::DangerFullAccess,
            }
        );
    }

    #[test]
    fn turn_start_request_carries_text_model_and_permission_overrides() {
        let request = build_turn_start_request(
            7,
            "thread-1",
            "hello",
            Path::new("/tmp/work"),
            Some("gpt-5.1-codex"),
            CodexPermissionLevel::Standard,
        );
        let value = serde_json::to_value(request).unwrap();

        assert_eq!(value["method"], "turn/start");
        assert_eq!(value["params"]["threadId"], "thread-1");
        assert_eq!(value["params"]["input"][0]["type"], "text");
        assert_eq!(value["params"]["input"][0]["text"], "hello");
        assert_eq!(value["params"]["model"], "gpt-5.1-codex");
        assert_eq!(value["params"]["approvalPolicy"], "on-request");
        assert_eq!(
            value["params"]["sandboxPolicy"]["workspaceWrite"]["networkAccess"],
            false
        );
    }

    #[test]
    fn parses_agent_message_delta_notification() {
        let message = parse_jsonrpc_line(
            r#"{"method":"item/agentMessage/delta","params":{"threadId":"t","turnId":"u","itemId":"i","delta":"hi"}}"#,
        )
        .expect("jsonrpc parses");
        let JsonRpcMessage::Notification(notification) = message else {
            panic!("expected notification");
        };

        assert_eq!(
            decode_notification(notification),
            CodexNotificationEvent::AgentMessageDelta {
                thread_id: "t".to_string(),
                turn_id: "u".to_string(),
                item_id: "i".to_string(),
                delta: "hi".to_string(),
            }
        );
    }

    #[test]
    fn maps_token_usage_notification_to_claudette_usage() {
        let event = decode_notification(JsonRpcNotification {
            method: "thread/tokenUsage/updated".to_string(),
            params: Some(json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "tokenUsage": {
                    "total": {
                        "inputTokens": 100,
                        "cachedInputTokens": 20,
                        "outputTokens": 7,
                        "reasoningOutputTokens": 3
                    },
                    "last": {
                        "inputTokens": 100,
                        "cachedInputTokens": 20,
                        "outputTokens": 7,
                        "reasoningOutputTokens": 3
                    },
                    "modelContextWindow": 400000
                }
            })),
        });

        assert_eq!(
            event,
            CodexNotificationEvent::TokenUsageUpdated {
                thread_id: "thread-1".to_string(),
                turn_id: "turn-1".to_string(),
                usage: TokenUsage {
                    input_tokens: 100,
                    output_tokens: 10,
                    cache_creation_input_tokens: None,
                    cache_read_input_tokens: Some(20),
                    iterations: None,
                },
            }
        );
    }

    #[test]
    fn parses_reasoning_summary_delta_notification() {
        let event = decode_notification(JsonRpcNotification {
            method: "item/reasoning/summaryTextDelta".to_string(),
            params: Some(json!({
                "threadId": "thread-1",
                "turnId": "turn-1",
                "itemId": "reasoning-1",
                "delta": "checking",
                "summaryIndex": 2
            })),
        });

        assert_eq!(
            event,
            CodexNotificationEvent::ReasoningSummaryDelta {
                thread_id: "thread-1".to_string(),
                turn_id: "turn-1".to_string(),
                item_id: "reasoning-1".to_string(),
                delta: "checking".to_string(),
                summary_index: 2,
            }
        );
    }

    #[test]
    fn maps_agent_message_delta_to_claudette_text_delta() {
        let events = map_notification_to_agent_events(CodexNotificationEvent::AgentMessageDelta {
            thread_id: "thread-1".to_string(),
            turn_id: "turn-1".to_string(),
            item_id: "message-1".to_string(),
            delta: "hello".to_string(),
        });

        let [
            AgentEvent::Stream(StreamEvent::Stream {
                event:
                    InnerStreamEvent::ContentBlockDelta {
                        index,
                        delta: Delta::Text { text },
                    },
            }),
        ] = events.as_slice()
        else {
            panic!("expected text delta event");
        };
        assert_eq!(*index, 0);
        assert_eq!(text, "hello");
    }

    #[test]
    fn maps_reasoning_delta_to_claudette_thinking_delta() {
        let events = map_notification_to_agent_events(CodexNotificationEvent::ReasoningTextDelta {
            thread_id: "thread-1".to_string(),
            turn_id: "turn-1".to_string(),
            item_id: "reasoning-1".to_string(),
            delta: "because".to_string(),
            content_index: 0,
        });

        let [
            AgentEvent::Stream(StreamEvent::Stream {
                event:
                    InnerStreamEvent::ContentBlockDelta {
                        index,
                        delta: Delta::Thinking { thinking },
                    },
            }),
        ] = events.as_slice()
        else {
            panic!("expected thinking delta event");
        };
        assert_eq!(*index, 1);
        assert_eq!(thinking, "because");
    }

    #[test]
    fn maps_turn_completed_to_success_result() {
        let events = map_notification_to_agent_events(CodexNotificationEvent::TurnCompleted {
            thread_id: "thread-1".to_string(),
            turn_id: "turn-1".to_string(),
            duration_ms: Some(42),
        });

        let [
            AgentEvent::Stream(StreamEvent::Result {
                subtype,
                duration_ms,
                ..
            }),
        ] = events.as_slice()
        else {
            panic!("expected result event");
        };
        assert_eq!(subtype, "success");
        assert_eq!(*duration_ms, Some(42));
    }

    #[test]
    fn codex_start_events_prime_message_and_content_blocks() {
        let events = codex_turn_start_events();
        assert!(matches!(
            events.first(),
            Some(AgentEvent::Stream(StreamEvent::Stream {
                event: InnerStreamEvent::MessageStart {}
            }))
        ));
        assert_eq!(events.len(), 3);
    }

    #[tokio::test]
    async fn codex_session_publishes_mapped_notifications() {
        let session = CodexAppServerSession::new_for_test(4321);
        let mut rx = session.subscribe();

        session.publish_notification_event(CodexNotificationEvent::AgentMessageDelta {
            thread_id: "thread-1".to_string(),
            turn_id: "turn-1".to_string(),
            item_id: "message-1".to_string(),
            delta: "hi".to_string(),
        });

        let event = rx.recv().await.expect("event published");
        let AgentEvent::Stream(StreamEvent::Stream {
            event:
                InnerStreamEvent::ContentBlockDelta {
                    delta: Delta::Text { text },
                    ..
                },
        }) = event
        else {
            panic!("expected text delta");
        };
        assert_eq!(text, "hi");
        assert_eq!(session.pid(), 4321);
    }

    #[tokio::test]
    async fn app_server_router_delivers_pending_response() {
        let (tx, rx) = oneshot::channel();
        let pending: PendingRequests = Arc::new(tokio::sync::Mutex::new(BTreeMap::from([(
            JsonRpcId::Integer(11),
            PendingCodexRequest {
                method: "turn/start".to_string(),
                tx,
            },
        )])));
        let (event_tx, _) = broadcast::channel(8);

        route_app_server_message(
            1,
            &event_tx,
            &pending,
            JsonRpcMessage::Response(JsonRpcResponse {
                id: Some(JsonRpcId::Integer(11)),
                result: json!({"turn":{"id":"turn-1"}}),
            }),
        )
        .await;

        let response = rx
            .await
            .expect("response delivered")
            .expect("response is ok");
        assert_eq!(response.result["turn"]["id"], "turn-1");
        assert!(pending.lock().await.is_empty());
    }

    #[tokio::test]
    async fn app_server_router_emits_notification_events() {
        let pending: PendingRequests = Arc::new(tokio::sync::Mutex::new(BTreeMap::new()));
        let (event_tx, mut rx) = broadcast::channel(8);

        route_app_server_message(
            1,
            &event_tx,
            &pending,
            JsonRpcMessage::Notification(JsonRpcNotification {
                method: "item/agentMessage/delta".to_string(),
                params: Some(json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "itemId": "message-1",
                    "delta": "hello"
                })),
            }),
        )
        .await;

        let event = rx.recv().await.expect("event emitted");
        let AgentEvent::Stream(StreamEvent::Stream {
            event:
                InnerStreamEvent::ContentBlockDelta {
                    delta: Delta::Text { text },
                    ..
                },
        }) = event
        else {
            panic!("expected text delta");
        };
        assert_eq!(text, "hello");
    }
}
