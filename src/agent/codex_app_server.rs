use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt};
use tokio::process::{ChildStdin, Command};
use tokio::sync::broadcast;
use tokio::sync::mpsc;
use tokio::sync::oneshot;

use crate::process::CommandWindowExt as _;

use super::{
    AgentEvent, AssistantMessage, ContentBlock, ControlRequestInner, Delta, FileAttachment,
    InnerStreamEvent, StartContentBlock, StreamEvent, TokenUsage, TurnHandle,
};

type CodexStdin = Arc<tokio::sync::Mutex<ChildStdin>>;
type PendingRequests = Arc<tokio::sync::Mutex<BTreeMap<JsonRpcId, PendingCodexRequest>>>;
type TurnOutputBuffer = Arc<tokio::sync::Mutex<CodexTurnOutput>>;

struct PendingCodexRequest {
    method: String,
    tx: oneshot::Sender<Result<JsonRpcResponse, JsonRpcError>>,
}

#[derive(Debug, Default)]
struct CodexTurnOutput {
    text: String,
    thinking: String,
}

#[derive(Debug, Clone)]
pub struct CodexAppServerOptions {
    pub model: Option<String>,
    pub permission_level: CodexPermissionLevel,
}

impl Default for CodexAppServerOptions {
    fn default() -> Self {
        Self {
            model: None,
            permission_level: CodexPermissionLevel::Readonly,
        }
    }
}

pub struct CodexAppServerSession {
    pid: u32,
    stdin: Option<CodexStdin>,
    event_tx: broadcast::Sender<AgentEvent>,
    pending: PendingRequests,
    next_request_id: AtomicI64,
    working_dir: PathBuf,
    model: Option<String>,
    permission_level: CodexPermissionLevel,
    thread_id: Arc<tokio::sync::Mutex<Option<String>>>,
    active_turn_id: Arc<tokio::sync::Mutex<Option<String>>>,
    turn_output: TurnOutputBuffer,
}

impl CodexAppServerSession {
    pub async fn start(working_dir: &Path, client_version: &str) -> Result<Self, String> {
        Self::start_with_options(
            working_dir,
            client_version,
            CodexAppServerOptions::default(),
        )
        .await
    }

    pub async fn start_with_options(
        working_dir: &Path,
        client_version: &str,
        options: CodexAppServerOptions,
    ) -> Result<Self, String> {
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
            working_dir: working_dir.to_path_buf(),
            model: options.model,
            permission_level: options.permission_level,
            thread_id: Arc::new(tokio::sync::Mutex::new(None)),
            active_turn_id: Arc::new(tokio::sync::Mutex::new(None)),
            turn_output: Arc::new(tokio::sync::Mutex::new(CodexTurnOutput::default())),
        };

        session.spawn_stdout_reader(stdout);
        session.spawn_stderr_reader(stderr);
        session.spawn_exit_watcher(child);
        let _ = session.event_tx.send(codex_command_line_event());
        if let Err(err) = session.initialize(client_version).await {
            fail_pending_requests(&session.pending, "Codex app-server initialize failed").await;
            if let Err(stop_err) = super::process::stop_agent_graceful(pid).await {
                tracing::warn!(
                    target: "claudette::agent",
                    subsystem = "codex-app-server",
                    pid,
                    error = %stop_err,
                    "failed to stop codex app-server after initialize failure"
                );
            }
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
            permission_level: CodexPermissionLevel::Readonly,
            thread_id: Arc::new(tokio::sync::Mutex::new(None)),
            active_turn_id: Arc::new(tokio::sync::Mutex::new(None)),
            turn_output: Arc::new(tokio::sync::Mutex::new(CodexTurnOutput::default())),
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

    pub async fn send_turn(
        &self,
        prompt: &str,
        attachments: &[FileAttachment],
    ) -> Result<TurnHandle, String> {
        if !attachments.is_empty() {
            return Err("Codex app-server attachments are not wired yet".to_string());
        }
        let mut broadcast_rx = self.event_tx.subscribe();
        let thread_id = self.ensure_thread().await?;
        let response = self
            .send_request(build_turn_start_request(
                self.next_id(),
                &thread_id,
                prompt,
                &self.working_dir,
                self.model.as_deref(),
                self.permission_level,
            ))
            .await?;
        let turn_id = turn_id_from_response(&response)?;
        *self.active_turn_id.lock().await = Some(turn_id);
        for event in codex_turn_start_events() {
            let _ = self.event_tx.send(event);
        }

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
                            subsystem = "codex-app-server",
                            dropped_events = n,
                            "broadcast lag — codex per-turn receiver missed events"
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
            return Err("Codex app-server steering attachments are not wired yet".to_string());
        }
        let thread_id = self.ensure_thread().await?;
        let turn_id = self
            .active_turn_id
            .lock()
            .await
            .clone()
            .ok_or_else(|| "Codex app-server has no active turn to steer".to_string())?;
        self.send_request(build_turn_steer_request(
            self.next_id(),
            &thread_id,
            &turn_id,
            prompt,
        ))
        .await?;
        Ok(())
    }

    pub async fn interrupt_turn(&self) -> Result<(), String> {
        let thread_id = self
            .thread_id
            .lock()
            .await
            .clone()
            .ok_or_else(|| "Codex app-server has no thread to interrupt".to_string())?;
        let turn_id = self
            .active_turn_id
            .lock()
            .await
            .clone()
            .ok_or_else(|| "Codex app-server has no active turn to interrupt".to_string())?;
        self.send_request(build_turn_interrupt_request(
            self.next_id(),
            &thread_id,
            &turn_id,
        ))
        .await?;
        *self.active_turn_id.lock().await = None;
        Ok(())
    }

    pub async fn read_account(
        &self,
        refresh_token: bool,
    ) -> Result<CodexAppServerAccountStatus, String> {
        let response = self
            .send_request(build_account_read_request(self.next_id(), refresh_token))
            .await?;
        account_status_from_response(&response)
    }

    pub async fn list_models(&self) -> Result<Vec<CodexAppServerModel>, String> {
        let mut cursor: Option<String> = None;
        let mut models = Vec::new();
        loop {
            let response = self
                .send_request(build_model_list_request(self.next_id(), cursor.as_deref()))
                .await?;
            let page = model_list_from_response(&response)?;
            models.extend(page.models);
            cursor = page.next_cursor;
            if cursor.is_none() {
                break;
            }
        }
        Ok(models)
    }

    pub async fn send_control_response(
        &self,
        request_id: &str,
        response: Value,
    ) -> Result<(), String> {
        let server_response =
            build_codex_server_response_from_control_response(request_id, response)?;
        let stdin = self
            .stdin
            .as_ref()
            .ok_or_else(|| "Codex app-server stdin is not available".to_string())?;
        let mut stdin = stdin.lock().await;
        write_jsonrpc_message(&mut *stdin, &server_response).await
    }

    async fn initialize(&self, client_version: &str) -> Result<(), String> {
        let request = build_initialize_request(self.next_id(), client_version);
        self.send_request(request).await?;
        self.send_notification(build_initialized_notification())
            .await
    }

    async fn ensure_thread(&self) -> Result<String, String> {
        if let Some(thread_id) = self.thread_id.lock().await.clone() {
            return Ok(thread_id);
        }
        let response = self
            .send_request(build_thread_start_request(
                self.next_id(),
                self.model.as_deref(),
                &self.working_dir,
                self.permission_level,
            ))
            .await?;
        let thread_id = thread_id_from_response(&response)?;
        *self.thread_id.lock().await = Some(thread_id.clone());
        Ok(thread_id)
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
        let stdin = self.stdin.clone();
        let active_turn_id = self.active_turn_id.clone();
        let turn_output = self.turn_output.clone();
        let pid = self.pid;
        tokio::spawn(async move {
            let mut reader = tokio::io::BufReader::new(stdout);
            loop {
                match read_jsonrpc_message(&mut reader).await {
                    Ok(Some(message)) => {
                        route_app_server_message(
                            pid,
                            &event_tx,
                            &pending,
                            stdin.as_ref(),
                            Some(&active_turn_id),
                            Some(&turn_output),
                            message,
                        )
                        .await;
                    }
                    Ok(None) => {
                        fail_pending_requests(
                            &pending,
                            "Codex app-server stdout closed before responding",
                        )
                        .await;
                        break;
                    }
                    Err(err) => {
                        tracing::warn!(
                            target: "claudette::agent",
                            subsystem = "codex-app-server",
                            pid,
                            error = %err,
                            "failed to read codex stdout"
                        );
                        let _ = event_tx.send(AgentEvent::Stderr(err.clone()));
                        fail_pending_requests(&pending, &err).await;
                        break;
                    }
                }
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
        let pending = self.pending.clone();
        tokio::spawn(async move {
            let status = child.wait().await.ok().and_then(|status| status.code());
            fail_pending_requests(&pending, "Codex app-server process exited").await;
            let _ = event_tx.send(AgentEvent::ProcessExited(status));
        });
    }
}

async fn route_app_server_message(
    pid: u32,
    event_tx: &broadcast::Sender<AgentEvent>,
    pending: &PendingRequests,
    stdin: Option<&CodexStdin>,
    active_turn_id: Option<&Arc<tokio::sync::Mutex<Option<String>>>>,
    turn_output: Option<&TurnOutputBuffer>,
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
            let notification = decode_notification(notification);
            if let Some(turn_output) = turn_output {
                update_turn_output_buffer(turn_output, &notification).await;
            }
            if notification_finishes_turn(&notification)
                && let Some(active_turn_id) = active_turn_id
            {
                *active_turn_id.lock().await = None;
            }
            if notification_finishes_turn(&notification)
                && let Some(turn_output) = turn_output
                && let Some(event) = drain_turn_output_buffer(turn_output).await
            {
                let _ = event_tx.send(event);
            }
            for event in map_notification_to_agent_events(notification) {
                let _ = event_tx.send(event);
            }
        }
        JsonRpcMessage::Request(request) => {
            let method = request.method.clone();
            match codex_server_request_to_control_event(&request) {
                Ok(Some(event)) => {
                    let _ = event_tx.send(event);
                    tracing::debug!(
                        target: "claudette::agent",
                        subsystem = "codex-app-server",
                        pid,
                        method = %method,
                        "routed codex app-server server request to host approval prompt"
                    );
                }
                Ok(None) => {
                    if let Some(stdin) = stdin {
                        let mut stdin = stdin.lock().await;
                        let error = JsonRpcMessage::Error(JsonRpcError {
                            id: Some(request.id),
                            error: JsonRpcErrorBody {
                                code: -32601,
                                message: format!(
                                    "Codex app-server request `{method}` is not implemented"
                                ),
                                data: None,
                            },
                        });
                        if let Err(err) = write_jsonrpc_message(&mut *stdin, &error).await {
                            tracing::warn!(
                                target: "claudette::agent",
                                subsystem = "codex-app-server",
                                pid,
                                error = %err,
                                "failed to write codex server-request error response"
                            );
                        }
                    }
                    let _ = event_tx.send(AgentEvent::Stderr(format!(
                        "Codex app-server request `{}` is not handled yet.",
                        method
                    )));
                }
                Err(err) => {
                    tracing::warn!(
                        target: "claudette::agent",
                        subsystem = "codex-app-server",
                        pid,
                        error = %err,
                        method = %method,
                        "failed to route codex app-server server request"
                    );
                    if let Some(stdin) = stdin {
                        let mut stdin = stdin.lock().await;
                        let error = JsonRpcMessage::Error(JsonRpcError {
                            id: Some(request.id),
                            error: JsonRpcErrorBody {
                                code: -32603,
                                message: err,
                                data: None,
                            },
                        });
                        let _ = write_jsonrpc_message(&mut *stdin, &error).await;
                    }
                }
            }
        }
    }
}

async fn fail_pending_requests(pending: &PendingRequests, reason: &str) {
    let drained = {
        let mut pending = pending.lock().await;
        std::mem::take(&mut *pending)
    };
    for (id, request) in drained {
        let _ = request.tx.send(Err(JsonRpcError {
            id: Some(id),
            error: JsonRpcErrorBody {
                code: -32000,
                message: reason.to_string(),
                data: Some(json!({ "method": request.method })),
            },
        }));
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

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct JsonRpcServerResponse {
    pub id: JsonRpcId,
    pub method: String,
    pub response: Value,
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

pub async fn write_jsonrpc_message<W, M>(writer: &mut W, message: &M) -> Result<(), String>
where
    W: AsyncWrite + Unpin,
    M: Serialize + ?Sized,
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

pub const CODEX_COMMAND_APPROVAL_TOOL: &str = "CodexCommandApproval";
pub const CODEX_FILE_CHANGE_APPROVAL_TOOL: &str = "CodexFileChangeApproval";
pub const CODEX_PERMISSIONS_APPROVAL_TOOL: &str = "CodexPermissionsApproval";

pub fn is_codex_approval_tool_name(tool_name: &str) -> bool {
    matches!(
        tool_name,
        CODEX_COMMAND_APPROVAL_TOOL
            | CODEX_FILE_CHANGE_APPROVAL_TOOL
            | CODEX_PERMISSIONS_APPROVAL_TOOL
    )
}

fn codex_server_request_tool(method: &str) -> Option<(&'static str, &'static str)> {
    match method {
        "item/commandExecution/requestApproval" => {
            Some((CODEX_COMMAND_APPROVAL_TOOL, "commandExecution"))
        }
        "item/fileChange/requestApproval" => Some((CODEX_FILE_CHANGE_APPROVAL_TOOL, "fileChange")),
        "item/permissions/requestApproval" => {
            Some((CODEX_PERMISSIONS_APPROVAL_TOOL, "permissions"))
        }
        _ => None,
    }
}

pub fn is_supported_codex_server_request(method: &str) -> bool {
    codex_server_request_tool(method).is_some()
}

fn codex_request_id_as_control_id(id: &JsonRpcId) -> Result<String, String> {
    serde_json::to_string(id).map_err(|e| format!("Failed to encode Codex request id: {e}"))
}

fn codex_tool_use_id(request: &JsonRpcRequest, request_id: &str) -> String {
    request
        .params
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|params| {
            params
                .get("itemId")
                .or_else(|| params.get("approvalId"))
                .or_else(|| params.get("id"))
                .and_then(Value::as_str)
        })
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| format!("codex-approval-{request_id}"))
}

pub fn codex_server_request_to_control_event(
    request: &JsonRpcRequest,
) -> Result<Option<AgentEvent>, String> {
    let Some((tool_name, approval_kind)) = codex_server_request_tool(&request.method) else {
        return Ok(None);
    };
    let request_id = codex_request_id_as_control_id(&request.id)?;
    let mut input = request
        .params
        .as_ref()
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    input.insert(
        "codexMethod".to_string(),
        Value::String(request.method.clone()),
    );
    input.insert(
        "codexApprovalKind".to_string(),
        Value::String(approval_kind.to_string()),
    );
    let tool_use_id = codex_tool_use_id(request, &request_id);
    Ok(Some(AgentEvent::Stream(StreamEvent::ControlRequest {
        request_id,
        request: ControlRequestInner::CanUseTool {
            tool_name: tool_name.to_string(),
            tool_use_id,
            input: Value::Object(input),
        },
    })))
}

pub fn build_codex_server_response_from_control_response(
    request_id: &str,
    response: Value,
) -> Result<JsonRpcServerResponse, String> {
    let id = serde_json::from_str::<JsonRpcId>(request_id)
        .map_err(|e| format!("Invalid Codex server request id `{request_id}`: {e}"))?;
    let method = response
        .get("codexMethod")
        .and_then(Value::as_str)
        .ok_or_else(|| "Codex control response is missing codexMethod".to_string())?;
    if !is_supported_codex_server_request(method) {
        return Err(format!("Unsupported Codex server request `{method}`"));
    }
    let payload = response
        .get("response")
        .cloned()
        .ok_or_else(|| "Codex control response is missing response payload".to_string())?;
    Ok(JsonRpcServerResponse {
        id,
        method: method.to_string(),
        response: payload,
    })
}

pub fn build_codex_approval_response_payload(
    tool_name: &str,
    original_input: &Value,
    approved: bool,
) -> Result<Value, String> {
    let method = original_input
        .get("codexMethod")
        .and_then(Value::as_str)
        .ok_or_else(|| "Codex approval input is missing codexMethod".to_string())?;
    match tool_name {
        CODEX_COMMAND_APPROVAL_TOOL | CODEX_FILE_CHANGE_APPROVAL_TOOL => Ok(json!({
            "codexMethod": method,
            "response": {
                "decision": if approved { "accept" } else { "decline" },
            },
        })),
        CODEX_PERMISSIONS_APPROVAL_TOOL => {
            let permissions = if approved {
                original_input
                    .get("permissions")
                    .cloned()
                    .unwrap_or_else(|| json!({}))
            } else {
                json!({})
            };
            Ok(json!({
                "codexMethod": method,
                "response": {
                    "permissions": permissions,
                    "scope": "turn",
                },
            }))
        }
        _ => Err(format!(
            "Pending tool `{tool_name}` is not a Codex approval"
        )),
    }
}

pub fn build_codex_server_request_response(
    request: &JsonRpcRequest,
) -> Option<JsonRpcServerResponse> {
    let (tool_name, _) = codex_server_request_tool(&request.method)?;
    let mut original_input = request
        .params
        .as_ref()
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    original_input.insert(
        "codexMethod".to_string(),
        Value::String(request.method.clone()),
    );
    let response =
        build_codex_approval_response_payload(tool_name, &Value::Object(original_input), false)
            .ok()?;
    let request_id = codex_request_id_as_control_id(&request.id).ok()?;
    build_codex_server_response_from_control_response(&request_id, response).ok()
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

pub fn build_account_read_request(id: i64, refresh_token: bool) -> JsonRpcRequest {
    JsonRpcRequest {
        id: JsonRpcId::Integer(id),
        method: "account/read".to_string(),
        params: Some(json!({
            "refreshToken": refresh_token,
        })),
    }
}

pub fn build_model_list_request(id: i64, cursor: Option<&str>) -> JsonRpcRequest {
    JsonRpcRequest {
        id: JsonRpcId::Integer(id),
        method: "model/list".to_string(),
        params: Some(json!({
            "cursor": cursor,
            "limit": 100,
            "includeHidden": false,
        })),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexAppServerAccountStatus {
    pub authenticated: bool,
    pub requires_openai_auth: bool,
    pub account_type: Option<String>,
    pub email: Option<String>,
    pub plan_type: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexAppServerModel {
    pub id: String,
    pub label: String,
    pub hidden: bool,
    pub is_default: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexAppServerModelPage {
    pub models: Vec<CodexAppServerModel>,
    pub next_cursor: Option<String>,
}

pub fn account_status_from_response(
    response: &JsonRpcResponse,
) -> Result<CodexAppServerAccountStatus, String> {
    let account = response.result.get("account").unwrap_or(&Value::Null);
    let requires_openai_auth = response
        .result
        .get("requiresOpenaiAuth")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let account_type = account
        .get("type")
        .and_then(Value::as_str)
        .map(str::to_string);
    Ok(CodexAppServerAccountStatus {
        authenticated: account_type.is_some(),
        requires_openai_auth,
        account_type,
        email: account
            .get("email")
            .and_then(Value::as_str)
            .map(str::to_string),
        plan_type: account
            .get("planType")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

pub fn model_list_from_response(
    response: &JsonRpcResponse,
) -> Result<CodexAppServerModelPage, String> {
    let data = response
        .result
        .get("data")
        .and_then(Value::as_array)
        .ok_or("Codex app-server model/list response did not include `data`")?;
    let models = data
        .iter()
        .filter_map(|model| {
            let raw_id = model
                .get("model")
                .or_else(|| model.get("id"))
                .and_then(Value::as_str)?;
            let id = raw_id.trim();
            if id.is_empty() {
                return None;
            }
            let label = model
                .get("displayName")
                .and_then(Value::as_str)
                .filter(|label| !label.trim().is_empty())
                .unwrap_or(id);
            Some(CodexAppServerModel {
                id: id.to_string(),
                label: label.to_string(),
                hidden: model
                    .get("hidden")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                is_default: model
                    .get("isDefault")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            })
        })
        .collect();
    let next_cursor = response
        .result
        .get("nextCursor")
        .and_then(Value::as_str)
        .filter(|cursor| !cursor.trim().is_empty())
        .map(str::to_string);
    Ok(CodexAppServerModelPage {
        models,
        next_cursor,
    })
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
    ItemStarted {
        thread_id: String,
        turn_id: String,
        item: Value,
    },
    ItemCompleted {
        thread_id: String,
        turn_id: String,
        item: Value,
    },
    TurnDiffUpdated {
        thread_id: String,
        turn_id: String,
        diff: String,
    },
    Unknown {
        method: String,
        params: Option<Value>,
    },
}

fn notification_finishes_turn(event: &CodexNotificationEvent) -> bool {
    matches!(
        event,
        CodexNotificationEvent::TurnCompleted { .. } | CodexNotificationEvent::TurnFailed { .. }
    )
}

async fn update_turn_output_buffer(
    buffer: &TurnOutputBuffer,
    notification: &CodexNotificationEvent,
) {
    let mut buffer = buffer.lock().await;
    match notification {
        CodexNotificationEvent::AgentMessageDelta { delta, .. } => {
            buffer.text.push_str(delta);
        }
        CodexNotificationEvent::ReasoningSummaryDelta { delta, .. }
        | CodexNotificationEvent::ReasoningTextDelta { delta, .. } => {
            buffer.thinking.push_str(delta);
        }
        _ => {}
    }
}

async fn drain_turn_output_buffer(buffer: &TurnOutputBuffer) -> Option<AgentEvent> {
    let mut buffer = buffer.lock().await;
    if buffer.text.trim().is_empty() && buffer.thinking.trim().is_empty() {
        buffer.text.clear();
        buffer.thinking.clear();
        return None;
    }

    let mut content = Vec::new();
    if !buffer.thinking.trim().is_empty() {
        content.push(ContentBlock::Thinking {
            thinking: std::mem::take(&mut buffer.thinking),
        });
    }
    if !buffer.text.trim().is_empty() {
        content.push(ContentBlock::Text {
            text: std::mem::take(&mut buffer.text),
        });
    } else {
        buffer.text.clear();
    }

    Some(AgentEvent::Stream(StreamEvent::Assistant {
        message: AssistantMessage { content },
    }))
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
            let message = string_field(error, "message");
            CodexNotificationEvent::TurnFailed {
                thread_id: string_field(params, "threadId"),
                turn_id: turn.map(|turn| string_field(turn, "id")),
                message: if message.is_empty() {
                    "Codex turn failed".to_string()
                } else {
                    message
                },
            }
        }
        ("item/started", Some(params)) => CodexNotificationEvent::ItemStarted {
            thread_id: string_field(params, "threadId"),
            turn_id: string_field(params, "turnId"),
            item: params.get("item").cloned().unwrap_or(Value::Null),
        },
        ("item/completed", Some(params)) => CodexNotificationEvent::ItemCompleted {
            thread_id: string_field(params, "threadId"),
            turn_id: string_field(params, "turnId"),
            item: params.get("item").cloned().unwrap_or(Value::Null),
        },
        ("turn/diff/updated", Some(params)) => CodexNotificationEvent::TurnDiffUpdated {
            thread_id: string_field(params, "threadId"),
            turn_id: string_field(params, "turnId"),
            diff: string_field(params, "diff"),
        },
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
        CodexNotificationEvent::ItemStarted { item, .. } => {
            map_codex_item_started_to_agent_events(&item)
        }
        CodexNotificationEvent::ItemCompleted { item, .. } => {
            map_codex_item_completed_to_agent_events(&item)
        }
        CodexNotificationEvent::AgentMessageDelta { .. }
        | CodexNotificationEvent::ReasoningSummaryDelta { .. }
        | CodexNotificationEvent::ReasoningTextDelta { .. }
        | CodexNotificationEvent::CommandOutputDelta { .. }
        | CodexNotificationEvent::TurnDiffUpdated { .. }
        | CodexNotificationEvent::Unknown { .. } => Vec::new(),
    }
}

fn map_codex_item_started_to_agent_events(item: &Value) -> Vec<AgentEvent> {
    let Some((item_id, tool_name, input)) = codex_item_tool_use(item) else {
        return Vec::new();
    };
    let index = codex_item_index(&item_id);
    vec![
        AgentEvent::Stream(StreamEvent::Stream {
            event: InnerStreamEvent::ContentBlockStart {
                index,
                content_block: Some(StartContentBlock::ToolUse {
                    id: item_id,
                    name: tool_name,
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
    ]
}

fn map_codex_item_completed_to_agent_events(item: &Value) -> Vec<AgentEvent> {
    let Some((item_id, _tool_name, _input)) = codex_item_tool_use(item) else {
        return Vec::new();
    };
    let index = codex_item_index(&item_id);
    vec![
        AgentEvent::Stream(StreamEvent::Stream {
            event: InnerStreamEvent::ContentBlockStop { index },
        }),
        AgentEvent::Stream(StreamEvent::User {
            message: super::UserEventMessage {
                content: super::UserMessageContent::Blocks(vec![
                    super::UserContentBlock::ToolResult {
                        tool_use_id: item_id,
                        content: codex_item_result_content(item),
                    },
                ]),
            },
            uuid: None,
            is_replay: false,
            is_synthetic: true,
        }),
    ]
}

fn codex_item_tool_use(item: &Value) -> Option<(String, String, Value)> {
    let item_type = item.get("type").and_then(Value::as_str)?;
    let item_id = string_field(item, "id");
    if item_id.is_empty() {
        return None;
    }
    match item_type {
        "commandExecution" => Some((
            item_id,
            "Bash".to_string(),
            json!({
                "command": item.get("command").and_then(Value::as_str).unwrap_or_default(),
                "cwd": item.get("cwd").and_then(Value::as_str),
            }),
        )),
        "fileChange" => Some((
            item_id,
            "Edit".to_string(),
            json!({
                "changes": item.get("changes").cloned().unwrap_or_else(|| json!([])),
            }),
        )),
        "mcpToolCall" => {
            let server = string_field(item, "server");
            let tool = string_field(item, "tool");
            Some((
                item_id,
                format!(
                    "mcp__{}__{}",
                    sanitize_tool_segment(&server),
                    sanitize_tool_segment(&tool)
                ),
                item.get("arguments").cloned().unwrap_or(Value::Null),
            ))
        }
        _ => None,
    }
}

fn codex_item_result_content(item: &Value) -> Value {
    match item.get("type").and_then(Value::as_str) {
        Some("commandExecution") => item
            .get("aggregatedOutput")
            .filter(|value| !value.is_null())
            .cloned()
            .unwrap_or_else(|| {
                json!({
                    "status": item.get("status").cloned().unwrap_or(Value::Null),
                    "exitCode": item.get("exitCode").cloned().unwrap_or(Value::Null),
                })
            }),
        Some("fileChange") => json!({
            "status": item.get("status").cloned().unwrap_or(Value::Null),
            "changes": item.get("changes").cloned().unwrap_or_else(|| json!([])),
        }),
        Some("mcpToolCall") => item
            .get("result")
            .filter(|value| !value.is_null())
            .cloned()
            .or_else(|| item.get("error").filter(|value| !value.is_null()).cloned())
            .unwrap_or_else(
                || json!({ "status": item.get("status").cloned().unwrap_or(Value::Null) }),
            ),
        _ => Value::Null,
    }
}

fn codex_item_index(item_id: &str) -> usize {
    let hash = item_id.bytes().fold(0_usize, |acc, byte| {
        acc.wrapping_mul(31).wrapping_add(byte as usize)
    });
    2 + (hash % 10_000)
}

fn sanitize_tool_segment(segment: &str) -> String {
    let sanitized = segment
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    if sanitized.is_empty() {
        "unknown".to_string()
    } else {
        sanitized
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

fn thread_id_from_response(response: &JsonRpcResponse) -> Result<String, String> {
    response_id_from_response(response, "thread", "thread/start")
}

fn turn_id_from_response(response: &JsonRpcResponse) -> Result<String, String> {
    response_id_from_response(response, "turn", "turn/start")
}

fn response_id_from_response(
    response: &JsonRpcResponse,
    object_key: &str,
    method: &str,
) -> Result<String, String> {
    let id = response
        .result
        .get(object_key)
        .and_then(|value| value.get("id"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if id.is_empty() {
        Err(format!(
            "Codex app-server `{method}` response did not include `{object_key}.id`"
        ))
    } else {
        Ok(id)
    }
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
    async fn writes_codex_server_response_with_response_field() {
        let request = JsonRpcRequest {
            id: JsonRpcId::Integer(8),
            method: "item/commandExecution/requestApproval".to_string(),
            params: None,
        };
        let response =
            build_codex_server_request_response(&request).expect("approval request is handled");
        let mut out = Vec::new();

        write_jsonrpc_message(&mut out, &response)
            .await
            .expect("response writes");

        let value: Value = serde_json::from_slice(&out).expect("json response");
        assert_eq!(
            value,
            json!({
                "id": 8,
                "method": "item/commandExecution/requestApproval",
                "response": {
                    "decision": "decline"
                }
            })
        );
    }

    #[test]
    fn builds_codex_control_response_for_approved_command() {
        let response = build_codex_approval_response_payload(
            CODEX_COMMAND_APPROVAL_TOOL,
            &json!({
                "codexMethod": "item/commandExecution/requestApproval",
                "command": "cargo test",
            }),
            true,
        )
        .expect("response payload");
        let server_response =
            build_codex_server_response_from_control_response("8", response).expect("response");

        assert_eq!(server_response.id, JsonRpcId::Integer(8));
        assert_eq!(
            server_response.method,
            "item/commandExecution/requestApproval"
        );
        assert_eq!(server_response.response, json!({ "decision": "accept" }));
    }

    #[test]
    fn builds_codex_control_response_for_denied_permission_grant() {
        let response = build_codex_approval_response_payload(
            CODEX_PERMISSIONS_APPROVAL_TOOL,
            &json!({
                "codexMethod": "item/permissions/requestApproval",
                "permissions": { "sandbox": "workspace-write" },
            }),
            false,
        )
        .expect("response payload");
        let server_response =
            build_codex_server_response_from_control_response("\"perm-1\"", response)
                .expect("response");

        assert_eq!(server_response.id, JsonRpcId::String("perm-1".to_string()));
        assert_eq!(server_response.method, "item/permissions/requestApproval");
        assert_eq!(
            server_response.response,
            json!({
                "permissions": {},
                "scope": "turn"
            })
        );
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
    fn extracts_thread_and_turn_ids_from_app_server_responses() {
        let thread = JsonRpcResponse {
            id: Some(JsonRpcId::Integer(1)),
            result: json!({"thread":{"id":"thread-1"}}),
        };
        let turn = JsonRpcResponse {
            id: Some(JsonRpcId::Integer(2)),
            result: json!({"turn":{"id":"turn-1"}}),
        };

        assert_eq!(thread_id_from_response(&thread).unwrap(), "thread-1");
        assert_eq!(turn_id_from_response(&turn).unwrap(), "turn-1");
    }

    #[test]
    fn missing_turn_id_is_a_structured_error() {
        let response = JsonRpcResponse {
            id: Some(JsonRpcId::Integer(2)),
            result: json!({"turn":{}}),
        };

        assert_eq!(
            turn_id_from_response(&response).unwrap_err(),
            "Codex app-server `turn/start` response did not include `turn.id`"
        );
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
    fn turn_interrupt_request_carries_thread_and_turn_ids() {
        let request = build_turn_interrupt_request(10, "thread-1", "turn-1");
        let value = serde_json::to_value(request).unwrap();

        assert_eq!(value["method"], "turn/interrupt");
        assert_eq!(value["params"]["threadId"], "thread-1");
        assert_eq!(value["params"]["turnId"], "turn-1");
    }

    #[test]
    fn account_read_request_can_request_token_refresh() {
        let request = build_account_read_request(12, true);
        let value = serde_json::to_value(request).unwrap();

        assert_eq!(value["method"], "account/read");
        assert_eq!(value["params"]["refreshToken"], true);
    }

    #[test]
    fn model_list_request_uses_default_picker_shape() {
        let request = build_model_list_request(13, Some("100"));
        let value = serde_json::to_value(request).unwrap();

        assert_eq!(value["method"], "model/list");
        assert_eq!(value["params"]["cursor"], "100");
        assert_eq!(value["params"]["limit"], 100);
        assert_eq!(value["params"]["includeHidden"], false);
    }

    #[test]
    fn parses_account_read_response() {
        let response = JsonRpcResponse {
            id: Some(JsonRpcId::Integer(12)),
            result: json!({
                "account": {
                    "type": "chatgpt",
                    "email": "dev@example.com",
                    "planType": "plus"
                },
                "requiresOpenaiAuth": false
            }),
        };

        assert_eq!(
            account_status_from_response(&response).expect("account parses"),
            CodexAppServerAccountStatus {
                authenticated: true,
                requires_openai_auth: false,
                account_type: Some("chatgpt".to_string()),
                email: Some("dev@example.com".to_string()),
                plan_type: Some("plus".to_string()),
            }
        );
    }

    #[test]
    fn parses_openai_required_chatgpt_account_as_authenticated() {
        let response = JsonRpcResponse {
            id: Some(JsonRpcId::Integer(12)),
            result: json!({
                "account": {
                    "type": "chatgpt",
                    "email": "dev@example.com",
                    "planType": "pro"
                },
                "requiresOpenaiAuth": true
            }),
        };

        let status = account_status_from_response(&response).expect("account parses");

        assert!(status.authenticated);
        assert!(status.requires_openai_auth);
        assert_eq!(status.account_type.as_deref(), Some("chatgpt"));
        assert_eq!(status.email.as_deref(), Some("dev@example.com"));
        assert_eq!(status.plan_type.as_deref(), Some("pro"));
    }

    #[test]
    fn parses_unauthenticated_account_read_response() {
        let response = JsonRpcResponse {
            id: Some(JsonRpcId::Integer(12)),
            result: json!({
                "account": null,
                "requiresOpenaiAuth": true
            }),
        };

        assert_eq!(
            account_status_from_response(&response).expect("account parses"),
            CodexAppServerAccountStatus {
                authenticated: false,
                requires_openai_auth: true,
                account_type: None,
                email: None,
                plan_type: None,
            }
        );
    }

    #[test]
    fn parses_model_list_response() {
        let response = JsonRpcResponse {
            id: Some(JsonRpcId::Integer(13)),
            result: json!({
                "data": [
                    {
                        "id": "model-id",
                        "model": "gpt-5.4",
                        "displayName": "GPT-5.4",
                        "hidden": false,
                        "isDefault": true
                    },
                    {
                        "id": "fallback-id",
                        "displayName": "",
                        "hidden": false,
                        "isDefault": false
                    }
                ],
                "nextCursor": "200"
            }),
        };

        let page = model_list_from_response(&response).expect("models parse");

        assert_eq!(
            page,
            CodexAppServerModelPage {
                models: vec![
                    CodexAppServerModel {
                        id: "gpt-5.4".to_string(),
                        label: "GPT-5.4".to_string(),
                        hidden: false,
                        is_default: true,
                    },
                    CodexAppServerModel {
                        id: "fallback-id".to_string(),
                        label: "fallback-id".to_string(),
                        hidden: false,
                        is_default: false,
                    },
                ],
                next_cursor: Some("200".to_string()),
            }
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
    fn parses_item_lifecycle_notifications() {
        let item = json!({
            "type": "mcpToolCall",
            "id": "mcp-1",
            "server": "github",
            "tool": "search_issues",
            "status": "inProgress",
            "arguments": {"query": "codex"}
        });

        assert_eq!(
            decode_notification(JsonRpcNotification {
                method: "item/started".to_string(),
                params: Some(json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "item": item,
                    "startedAtMs": 1
                })),
            }),
            CodexNotificationEvent::ItemStarted {
                thread_id: "thread-1".to_string(),
                turn_id: "turn-1".to_string(),
                item: json!({
                    "type": "mcpToolCall",
                    "id": "mcp-1",
                    "server": "github",
                    "tool": "search_issues",
                    "status": "inProgress",
                    "arguments": {"query": "codex"}
                }),
            }
        );
    }

    #[test]
    fn parses_turn_failed_with_default_message() {
        let event = decode_notification(JsonRpcNotification {
            method: "turn/failed".to_string(),
            params: Some(json!({
                "threadId": "thread-1",
                "turn": {"id": "turn-1", "error": {}}
            })),
        });

        assert_eq!(
            event,
            CodexNotificationEvent::TurnFailed {
                thread_id: "thread-1".to_string(),
                turn_id: Some("turn-1".to_string()),
                message: "Codex turn failed".to_string(),
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
    fn maps_mcp_item_started_to_tool_use_block() {
        let events = map_notification_to_agent_events(CodexNotificationEvent::ItemStarted {
            thread_id: "thread-1".to_string(),
            turn_id: "turn-1".to_string(),
            item: json!({
                "type": "mcpToolCall",
                "id": "mcp-1",
                "server": "github",
                "tool": "search_issues",
                "status": "inProgress",
                "arguments": {"query": "codex"}
            }),
        });

        assert_eq!(events.len(), 2);
        let AgentEvent::Stream(StreamEvent::Stream {
            event:
                InnerStreamEvent::ContentBlockStart {
                    content_block: Some(StartContentBlock::ToolUse { id, name }),
                    ..
                },
        }) = &events[0]
        else {
            panic!("expected tool-use start");
        };
        assert_eq!(id, "mcp-1");
        assert_eq!(name, "mcp__github__search_issues");
    }

    #[test]
    fn maps_file_change_completed_to_tool_result() {
        let events = map_notification_to_agent_events(CodexNotificationEvent::ItemCompleted {
            thread_id: "thread-1".to_string(),
            turn_id: "turn-1".to_string(),
            item: json!({
                "type": "fileChange",
                "id": "file-1",
                "status": "completed",
                "changes": [{"path": "/tmp/a.rs", "kind": "update", "diff": "@@"}]
            }),
        });

        assert_eq!(events.len(), 2);
        let AgentEvent::Stream(StreamEvent::User { message, .. }) = &events[1] else {
            panic!("expected tool result");
        };
        let super::super::UserMessageContent::Blocks(blocks) = &message.content else {
            panic!("expected block content");
        };
        let super::super::UserContentBlock::ToolResult {
            tool_use_id,
            content,
        } = &blocks[0]
        else {
            panic!("expected tool result block");
        };
        assert_eq!(tool_use_id, "file-1");
        assert_eq!(content["status"], "completed");
        assert_eq!(content["changes"][0]["path"], "/tmp/a.rs");
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
    async fn codex_interrupt_requires_started_thread() {
        let session = CodexAppServerSession::new_for_test(4321);

        assert_eq!(
            session.interrupt_turn().await.unwrap_err(),
            "Codex app-server has no thread to interrupt"
        );
    }

    #[tokio::test]
    async fn send_turn_failure_does_not_publish_start_events() {
        let session = CodexAppServerSession::new_for_test(4321);
        let mut rx = session.subscribe();

        let err = match session.send_turn("hello", &[]).await {
            Ok(_) => panic!("test session has no stdin"),
            Err(err) => err,
        };

        assert!(err.contains("stdin is not available"));
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(25), rx.recv())
                .await
                .is_err(),
            "failed turn start should not emit a stray start event"
        );
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
            None,
            None,
            None,
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
            None,
            None,
            None,
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

    #[tokio::test]
    async fn app_server_router_clears_active_turn_on_terminal_notification() {
        let pending: PendingRequests = Arc::new(tokio::sync::Mutex::new(BTreeMap::new()));
        let active_turn_id = Arc::new(tokio::sync::Mutex::new(Some("turn-1".to_string())));
        let (event_tx, mut rx) = broadcast::channel(8);

        route_app_server_message(
            1,
            &event_tx,
            &pending,
            None,
            Some(&active_turn_id),
            None,
            JsonRpcMessage::Notification(JsonRpcNotification {
                method: "turn/completed".to_string(),
                params: Some(json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "durationMs": 42
                })),
            }),
        )
        .await;

        assert_eq!(*active_turn_id.lock().await, None);
        assert!(matches!(
            rx.recv().await.expect("event emitted"),
            AgentEvent::Stream(StreamEvent::Result { subtype, .. }) if subtype == "success"
        ));
    }

    #[tokio::test]
    async fn app_server_router_synthesizes_assistant_message_on_turn_completion() {
        let pending: PendingRequests = Arc::new(tokio::sync::Mutex::new(BTreeMap::new()));
        let turn_output = Arc::new(tokio::sync::Mutex::new(CodexTurnOutput::default()));
        let (event_tx, mut rx) = broadcast::channel(8);

        route_app_server_message(
            1,
            &event_tx,
            &pending,
            None,
            None,
            Some(&turn_output),
            JsonRpcMessage::Notification(JsonRpcNotification {
                method: "item/reasoning/textDelta".to_string(),
                params: Some(json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "itemId": "reasoning-1",
                    "delta": "thinking"
                })),
            }),
        )
        .await;
        route_app_server_message(
            1,
            &event_tx,
            &pending,
            None,
            None,
            Some(&turn_output),
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
        route_app_server_message(
            1,
            &event_tx,
            &pending,
            None,
            None,
            Some(&turn_output),
            JsonRpcMessage::Notification(JsonRpcNotification {
                method: "turn/completed".to_string(),
                params: Some(json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1"
                })),
            }),
        )
        .await;

        let _thinking_delta = rx.recv().await.expect("thinking delta");
        let _text_delta = rx.recv().await.expect("text delta");
        let AgentEvent::Stream(StreamEvent::Assistant { message }) =
            rx.recv().await.expect("assistant event")
        else {
            panic!("expected synthesized assistant event");
        };
        assert!(matches!(
            &message.content[..],
            [
                ContentBlock::Thinking { thinking },
                ContentBlock::Text { text },
            ] if thinking == "thinking" && text == "hello"
        ));
        assert!(matches!(
            rx.recv().await.expect("result event"),
            AgentEvent::Stream(StreamEvent::Result { subtype, .. }) if subtype == "success"
        ));
    }

    #[tokio::test]
    async fn app_server_router_surfaces_unknown_server_request() {
        let pending: PendingRequests = Arc::new(tokio::sync::Mutex::new(BTreeMap::new()));
        let (event_tx, mut rx) = broadcast::channel(8);

        route_app_server_message(
            1,
            &event_tx,
            &pending,
            None,
            None,
            None,
            JsonRpcMessage::Request(JsonRpcRequest {
                id: JsonRpcId::String("req-1".to_string()),
                method: "item/tool/requestUserInput".to_string(),
                params: None,
            }),
        )
        .await;

        let AgentEvent::Stderr(line) = rx.recv().await.expect("stderr event") else {
            panic!("expected stderr event");
        };
        assert!(line.contains("request `item/tool/requestUserInput`"));
    }

    #[tokio::test]
    async fn app_server_router_routes_command_approval_requests_to_control_prompt() {
        let pending: PendingRequests = Arc::new(tokio::sync::Mutex::new(BTreeMap::new()));
        let (event_tx, mut rx) = broadcast::channel(8);

        route_app_server_message(
            1,
            &event_tx,
            &pending,
            None,
            None,
            None,
            JsonRpcMessage::Request(JsonRpcRequest {
                id: JsonRpcId::Integer(42),
                method: "item/commandExecution/requestApproval".to_string(),
                params: Some(json!({
                    "threadId": "thread-1",
                    "turnId": "turn-1",
                    "itemId": "cmd-1"
                })),
            }),
        )
        .await;

        let AgentEvent::Stream(StreamEvent::ControlRequest {
            request_id,
            request:
                ControlRequestInner::CanUseTool {
                    tool_name,
                    tool_use_id,
                    input,
                },
        }) = rx.recv().await.expect("control event")
        else {
            panic!("expected control request");
        };
        assert_eq!(request_id, "42");
        assert_eq!(tool_name, CODEX_COMMAND_APPROVAL_TOOL);
        assert_eq!(tool_use_id, "cmd-1");
        assert_eq!(
            input["codexMethod"],
            "item/commandExecution/requestApproval"
        );
        assert_eq!(input["codexApprovalKind"], "commandExecution");
    }

    #[tokio::test]
    async fn fail_pending_requests_resolves_all_waiters() {
        let (tx, rx) = oneshot::channel();
        let pending: PendingRequests = Arc::new(tokio::sync::Mutex::new(BTreeMap::from([(
            JsonRpcId::Integer(99),
            PendingCodexRequest {
                method: "initialize".to_string(),
                tx,
            },
        )])));

        fail_pending_requests(&pending, "gone").await;

        let error = rx
            .await
            .expect("waiter resolved")
            .expect_err("waiter failed");
        assert_eq!(error.id, Some(JsonRpcId::Integer(99)));
        assert_eq!(error.error.message, "gone");
        assert!(pending.lock().await.is_empty());
    }
}
