use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
use tokio::process::ChildStdin;
use tokio::sync::broadcast;
use tokio::sync::mpsc;
use tokio::sync::oneshot;

use super::environment::build_agent_command;
use super::{
    AgentEvent, AssistantMessage, ContentBlock, ControlRequestInner, Delta, FileAttachment,
    InnerStreamEvent, StartContentBlock, StreamEvent, TokenUsage, TokenUsageIteration, TurnHandle,
    UserContentBlock, UserEventMessage, UserMessageContent,
};
use crate::agent_mcp::bridge::Sink;
use crate::agent_mcp::protocol::{BridgePayload, BridgeResponse};

type PiStdin = Arc<tokio::sync::Mutex<ChildStdin>>;
/// Shared host-side tool sink. Pi has no MCP bridge, so a `host_tool`
/// sidecar message is routed straight through this `Sink` (the same
/// `ChatBridgeSink` Claude/Codex reach over their MCP socket).
type PiSink = Arc<dyn Sink>;
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
    /// Latest mid-turn error from the sidecar. Pi's `agent_end` does
    /// NOT carry an errorMessage at the event level, so we capture
    /// the `AssistantMessageEvent { type: "error" }` and
    /// `auto_retry_end { success: false, finalError }` events the
    /// harness now forwards as `turn_error`, and fold the latest
    /// into the eventual `turn_end`. Cleared on every `turn_end`.
    pending_error: Option<String>,
}

impl PiTurnOutput {
    fn fresh() -> Self {
        Self {
            text: String::new(),
            thinking: String::new(),
            tool_block_indices: HashMap::new(),
            next_tool_block_index: FIRST_TOOL_BLOCK_INDEX,
            pending_error: None,
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

// No `Debug` derive: `sink` is a `dyn Sink` trait object, which is not
// `Debug`. `PiSdkOptions` is built once and consumed, never formatted.
#[derive(Clone)]
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
    /// Extra env vars injected into the harness process, populated
    /// from Claudette's keychain-backed "keep this key private" path
    /// in the provider auth UI. Maps a Pi-recognized env var name
    /// (e.g. `OPENROUTER_API_KEY`) to its value. Empty by default.
    pub pi_provider_env: Vec<(String, String)>,
    /// Host-side tool sink for `host_tool` round-trips from the sidecar
    /// (native scheduling tools). `None` disables them — the sidecar's
    /// scheduling tools then report "scheduling unavailable".
    pub sink: Option<PiSink>,
}

pub struct PiSdkSession {
    pid: u32,
    stdin: Option<PiStdin>,
    event_tx: broadcast::Sender<AgentEvent>,
    /// Side channel for control-plane events that don't belong on the
    /// chat AgentEvent stream — OAuth challenge URLs, OAuth progress
    /// updates, and OAuth completion. Subscribed to by `pi_control.rs`
    /// for the Settings provider-management flow.
    control_tx: broadcast::Sender<PiControlEvent>,
    pending: PendingRequests,
    next_request_id: AtomicI64,
    working_dir: PathBuf,
    turn_output: TurnOutput,
    init_cache: InitCacheHandle,
    /// Host-side tool sink for `host_tool` sidecar round-trips. Cloned
    /// into the stdout reader task at spawn time.
    sink: Option<PiSink>,
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
    /// Extra env vars injected after `resolved_env` / `workspace_env`
    /// (so they win when keys collide). Used by Claudette's
    /// "keychain-only" provider auth path to push `OPENROUTER_API_KEY`,
    /// `OPENAI_API_KEY`, etc. into the harness process without
    /// touching `~/.pi/agent/auth.json`.
    extra_env: Option<&'a [(String, String)]>,
    cache_command_line: bool,
    /// Host-side tool sink, forwarded to the stdout reader so `host_tool`
    /// messages can be served the moment the sidecar starts. `None` for
    /// control-plane sessions, which never run agent tools.
    sink: Option<PiSink>,
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
            extra_env: if options.pi_provider_env.is_empty() {
                None
            } else {
                Some(&options.pi_provider_env)
            },
            cache_command_line: true,
            sink: options.sink.clone(),
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
        Self::discover_models_with_env(working_dir, None).await
    }

    /// Same as `discover_models`, but threads Claudette's keychain-
    /// only provider secrets into the control session's env so
    /// `getAvailable()` sees those providers as configured. The Tauri
    /// layer passes the `pi_local_secret_env()` snapshot here so
    /// "Refresh models" surfaces keychain-stored OpenRouter / OpenAI /
    /// etc. credentials without the user having to also write them to
    /// `~/.pi/agent/auth.json`.
    pub async fn discover_models_with_env(
        working_dir: &Path,
        extra_env: Option<&[(String, String)]>,
    ) -> Result<Vec<PiSdkModel>, String> {
        let session = Self::start_control(working_dir, extra_env).await?;
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

    /// Spawn a short-lived harness used purely for control-plane
    /// IPC (discovery, provider auth, etc.) — no chat session, no
    /// resolved env, no init-event cache. Exposed to the sibling
    /// `pi_control` module so the Settings provider-management flow
    /// can reuse the same spawn/init pipeline.
    ///
    /// `extra_env` lets callers push Claudette-private provider
    /// secrets (keychain-only path) into the control session so
    /// `list_providers` reports `configured: true` even when nothing
    /// is in `~/.pi/agent/auth.json`.
    pub(super) async fn start_control(
        working_dir: &Path,
        extra_env: Option<&[(String, String)]>,
    ) -> Result<Self, String> {
        Self::spawn_initialized(PiSpawnConfig {
            working_dir,
            resolved_env: None,
            workspace_env: None,
            extra_env,
            cache_command_line: false,
            sink: None,
        })
        .await
    }

    /// Subscribe to control-plane events (OAuth challenges, progress,
    /// completion). Subscribe BEFORE issuing the corresponding request
    /// or early events can race past you.
    pub fn subscribe_control(&self) -> broadcast::Receiver<PiControlEvent> {
        self.control_tx.subscribe()
    }

    /// Send a raw IPC request and await its response. Exposed to the
    /// `pi_control` module so it can dispatch new request types
    /// without re-implementing the request/response correlation here.
    pub(super) async fn send_request_raw(&self, request: Value) -> Result<Value, String> {
        self.send_request(request).await
    }

    /// Tell the sidecar to release its session state. Idempotent; safe
    /// to call on a session that was never started.
    pub async fn dispose(&self) -> Result<(), String> {
        self.send_request(json!({ "type": "dispose" })).await?;
        Ok(())
    }

    /// Spawn the Pi sidecar, wire its stdio readers + exit watcher, and
    /// run the `initialize` handshake. Returns a session whose
    /// background tasks already own the child handle; teardown on later
    /// errors must go through `stop_agent_graceful(pid)`, not by
    /// dropping the borrow.
    async fn spawn_initialized(config: PiSpawnConfig<'_>) -> Result<Self, String> {
        crate::missing_cli::precheck_cwd(config.working_dir)?;

        let pi_path = resolve_pi_harness_path().await;
        let built_command = build_agent_command(
            pi_path.as_os_str(),
            &[],
            config.working_dir,
            config.resolved_env,
        );
        let mut cmd = built_command.command;
        cmd.stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        if let Some(env) = config.workspace_env {
            env.apply(&mut cmd);
        }
        if let Some(extras) = config.extra_env {
            for (k, v) in extras {
                cmd.env(k, v);
            }
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
        let (control_tx, _) = broadcast::channel(64);
        let session = Self {
            pid,
            stdin: Some(Arc::new(tokio::sync::Mutex::new(stdin))),
            event_tx,
            control_tx,
            pending: Arc::new(tokio::sync::Mutex::new(BTreeMap::new())),
            next_request_id: AtomicI64::new(1),
            working_dir: config.working_dir.to_path_buf(),
            turn_output: Arc::new(tokio::sync::Mutex::new(PiTurnOutput::default())),
            init_cache: Arc::new(tokio::sync::Mutex::new(InitCache::default())),
            sink: config.sink,
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
        let (control_tx, _) = broadcast::channel(64);
        Self {
            pid,
            stdin: None,
            event_tx,
            control_tx,
            pending: Arc::new(tokio::sync::Mutex::new(BTreeMap::new())),
            next_request_id: AtomicI64::new(1),
            working_dir: PathBuf::from("/tmp"),
            turn_output: Arc::new(tokio::sync::Mutex::new(PiTurnOutput::default())),
            init_cache: Arc::new(tokio::sync::Mutex::new(InitCache::default())),
            sink: None,
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

    /// Trigger Pi's native context compaction via the sidecar's
    /// `compact` request. Returns a [`TurnHandle`] shaped exactly like
    /// [`Self::send_turn`]'s so `send_chat_message` can plug it into the
    /// same per-turn event pump without branching.
    ///
    /// Pi's `AgentSession.compact()` aborts any current operation,
    /// summarizes the conversation, and reports its lifecycle via
    /// `compaction_start` / `compaction_end` events on the session
    /// subscription. [`route_pi_message`] translates a successful
    /// `compaction_end` into a `compact_boundary` System event plus a
    /// synthetic `Result`: the boundary persists the `COMPACTION:...`
    /// sentinel, and the `Result` terminates this pump so the chat
    /// session's status flips back to Idle.
    pub async fn start_compact(&self) -> Result<TurnHandle, String> {
        // Subscribe BEFORE the request so the `compaction_start` status
        // event and the eventual boundary can't slip past before the
        // per-turn pump exists.
        let mut broadcast_rx = self.event_tx.subscribe();
        let cached = self.init_cache.lock().await.clone();
        self.send_request(json!({ "type": "compact" })).await?;

        let (mpsc_tx, mpsc_rx) = mpsc::channel::<AgentEvent>(128);
        // Replay the cached command-line + init events first, exactly as
        // `send_turn` does. The chat bridge's `got_init` flag is set when
        // it sees the `System { subtype: "init" }` event; the live init
        // is emitted once during `start_session`, before this per-turn
        // receiver subscribed. Without the replay `got_init` stays false
        // for the compaction turn, and a Pi process crash during/after
        // compaction would hit `send_chat_message`'s `!got_init` branch —
        // misclassified as an init failure, wrongly clearing session
        // state and DB rows instead of the gentler mid-turn-crash path.
        if let Some(event) = cached.command_line
            && mpsc_tx.send(event).await.is_err()
        {
            return Err("Pi SDK harness compact receiver closed".to_string());
        }
        if let Some(event) = cached.init
            && mpsc_tx.send(event).await.is_err()
        {
            return Err("Pi SDK harness compact receiver closed".to_string());
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
                            "broadcast lag — pi compact pump missed events"
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
        let control_tx = self.control_tx.clone();
        let pending = self.pending.clone();
        let turn_output = self.turn_output.clone();
        let init_cache = self.init_cache.clone();
        let stdin = self.stdin.clone();
        let sink = self.sink.clone();
        tokio::spawn(async move {
            let reader = tokio::io::BufReader::new(stdout);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                match serde_json::from_str::<PiHarnessMessage>(&line) {
                    Ok(PiHarnessMessage::HostTool {
                        request_id,
                        name,
                        args,
                    }) => {
                        // Served off the reader loop so a slow DB write
                        // never stalls stdout draining. Intercepted here
                        // because this is the only place that holds the
                        // live `stdin` + `sink`.
                        handle_host_tool(stdin.clone(), sink.clone(), request_id, name, args);
                    }
                    Ok(message) => {
                        route_pi_message(
                            &event_tx,
                            &control_tx,
                            &pending,
                            &turn_output,
                            &init_cache,
                            message,
                        )
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

/// Cumulative-across-the-turn usage emitted by the harness on
/// `turn_end`. Populates the top-level `TokenUsage` fields, which
/// `TurnFooter` / `CompletedTurn` surface as "total work for this
/// Claudette-level turn" (see `pickMeterUsageFromResult`'s docs and the
/// `aggregate semantics` comment in `useAgentStream.ts`'s `result`
/// branch). Sums every assistant message's `usage.*` for this turn so
/// the footer doesn't under-report on multi-iteration agent loops.
#[derive(Debug, Clone, Deserialize)]
struct PiAggregateUsage {
    #[serde(default, rename = "inputTokens")]
    input_tokens: Option<u64>,
    #[serde(default, rename = "outputTokens")]
    output_tokens: Option<u64>,
    #[serde(default, rename = "cacheReadTokens")]
    cache_read_tokens: Option<u64>,
    #[serde(default, rename = "cacheCreationTokens")]
    cache_creation_tokens: Option<u64>,
    /// Sum of per-message `totalTokens`. Distinct from
    /// `PiIterationUsage::total_tokens`, which is end-of-turn context
    /// occupancy.
    #[serde(default, rename = "totalTokens")]
    total_tokens: Option<u64>,
}

/// Per-final-call usage snapshot emitted by the harness on `turn_end`.
/// Maps onto Claudette's `TokenUsage` shape (specifically the
/// `iterations[0]` slot that `pickMeterUsageFromResult` reads first),
/// translating Pi's `Usage` field names (`input`, `output`, `cacheRead`,
/// `cacheWrite`) into Claudette's wire names.
#[derive(Debug, Clone, Deserialize)]
struct PiIterationUsage {
    #[serde(default, rename = "inputTokens")]
    input_tokens: Option<u64>,
    #[serde(default, rename = "outputTokens")]
    output_tokens: Option<u64>,
    #[serde(default, rename = "cacheReadTokens")]
    cache_read_tokens: Option<u64>,
    #[serde(default, rename = "cacheCreationTokens")]
    cache_creation_tokens: Option<u64>,
    /// Authoritative end-of-turn context size from
    /// `AgentSession.getContextUsage().tokens`, or the last assistant
    /// `usage.totalTokens` when the session API returns null/undefined.
    #[serde(default, rename = "totalTokens")]
    total_tokens: Option<u64>,
    /// Runtime context window from
    /// `AgentSession.getContextUsage().contextWindow`. When present it
    /// overrides the static UI model-registry capacity.
    #[serde(default, rename = "modelContextWindow")]
    model_context_window: Option<u64>,
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
    /// A native scheduling tool in the Pi sidecar wants the host to run a
    /// `BridgePayload` and return the result. Intercepted in the stdout
    /// reader loop (which holds `stdin` + `sink`) — never reaches
    /// [`route_pi_message`].
    #[serde(rename = "host_tool")]
    HostTool {
        #[serde(rename = "requestId")]
        request_id: String,
        name: String,
        #[serde(default)]
        args: Value,
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
        /// Cumulative-across-the-turn totals. Populates the top-level
        /// `TokenUsage` fields the TurnFooter / CompletedTurn surface
        /// as "total work for this turn".
        ///
        /// Absent on resumed pre-fix sessions (a sidecar predating
        /// this payload). In that case the route layer skips building
        /// a `TokenUsage` entirely — the meter holds its previous
        /// reading and the footer omits token counts, which is the
        /// same fail-safe as a missing CLI `usage` block.
        #[serde(default)]
        aggregate: Option<PiAggregateUsage>,
        /// Per-final-call usage snapshot, populated by the harness from
        /// the last `AssistantMessage.usage` plus
        /// `AgentSession.getContextUsage()` for the authoritative
        /// end-of-turn context size. The Rust side routes this into
        /// `TokenUsage.iterations[0]`, which `pickMeterUsageFromResult`
        /// reads in preference to the top-level aggregate.
        #[serde(default)]
        iteration: Option<PiIterationUsage>,
        #[serde(default, rename = "totalCostUsd")]
        total_cost_usd: Option<f64>,
        #[serde(default, rename = "durationMs")]
        duration_ms: Option<i64>,
    },
    /// Mid-turn failure surfaced by the harness when Pi's
    /// `AssistantMessageEvent` returns an `error` variant or
    /// `auto_retry_end` fails. The handler folds the error into
    /// `turn_output` so the eventual `turn_end` carries it even if
    /// pi-agent-core's top-level `agent_end` carries no
    /// errorMessage (which is the common case — see the helper in
    /// `main.ts`).
    #[serde(rename = "turn_error")]
    TurnError {
        #[serde(default)]
        error: Option<String>,
    },
    /// Pi began native context compaction. `reason` is `"manual"` (a
    /// user `/compact`), `"threshold"` (auto-compaction crossed the
    /// keep-recent budget), or `"overflow"` (context window exhausted).
    /// Arrives on the same session subscription as turn events.
    ///
    /// We currently flip the UI to "Compacting" regardless of trigger,
    /// so `reason` isn't read on the route side — but the harness
    /// continues to send it for log/diagnostic clarity and future
    /// per-trigger affordances. `#[allow(dead_code)]` keeps the field
    /// in the deserialized shape without tripping the unused-field lint.
    #[serde(rename = "compaction_start")]
    CompactionStart {
        #[serde(default)]
        #[allow(dead_code)]
        reason: Option<String>,
    },
    /// Pi finished native context compaction. The sidecar flattens Pi's
    /// `CompactionResult` and collapses "explicit abort" and "generic
    /// failure" into a single `aborted` flag meaning "did NOT free
    /// context". On the success path `tokens_before` / `tokens_after` /
    /// `duration_ms` feed the compaction divider; on the failure path
    /// `error_message` carries the reason.
    #[serde(rename = "compaction_end")]
    CompactionEnd {
        #[serde(default)]
        reason: Option<String>,
        #[serde(default)]
        aborted: bool,
        #[serde(default, rename = "willRetry")]
        will_retry: bool,
        #[serde(default, rename = "errorMessage")]
        error_message: Option<String>,
        #[serde(default, rename = "tokensBefore")]
        tokens_before: Option<u64>,
        #[serde(default, rename = "tokensAfter")]
        tokens_after: Option<u64>,
        #[serde(default, rename = "durationMs")]
        duration_ms: Option<u64>,
    },
    #[serde(rename = "error")]
    Error {
        #[serde(default)]
        error: Option<String>,
    },
    // Pi provider-auth flow events. The harness emits these unsolicited
    // during an OAuth login (the request/response pair only carries the
    // "we started" / "we finished" signal; the URL + user code live in
    // the asynchronous events below). Forwarded to `control_tx` so the
    // Settings UI subscriber can render the device-code modal.
    #[serde(rename = "oauth_challenge")]
    OAuthChallenge {
        #[serde(rename = "challengeId")]
        challenge_id: String,
        #[serde(rename = "providerId")]
        provider_id: String,
        kind: String,
        #[serde(default)]
        url: Option<String>,
        #[serde(default)]
        instructions: Option<String>,
        #[serde(default)]
        message: Option<String>,
        #[serde(default)]
        placeholder: Option<String>,
        #[serde(default, rename = "allowEmpty")]
        allow_empty: bool,
    },
    #[serde(rename = "oauth_progress")]
    OAuthProgress {
        #[serde(rename = "challengeId")]
        challenge_id: String,
        #[serde(rename = "providerId")]
        provider_id: String,
        message: String,
    },
    #[serde(rename = "oauth_complete")]
    OAuthComplete {
        #[serde(rename = "challengeId")]
        challenge_id: String,
        #[serde(rename = "providerId")]
        provider_id: String,
        ok: bool,
        #[serde(default)]
        error: Option<String>,
    },
    #[serde(other)]
    Unknown,
}

/// Control-plane events that flow over a side channel separate from the
/// main agent event stream. Used by the Settings provider-management UI
/// to drive the OAuth device-code modal.
///
/// The `type` discriminant stays snake_case to match the harness wire
/// shape (`oauth_challenge` / `oauth_progress` / `oauth_complete`), but
/// the *fields* serialize camelCase so the React modal can read
/// `challengeId` / `providerId` / `allowEmpty` directly. Without the
/// inner camelCase rename, the frontend received every id as
/// `undefined` and the OAuth flow's challenge filtering and prompt
/// submission both broke silently.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum PiControlEvent {
    // Variants get explicit `rename` because serde's default conversion
    // of `OAuthChallenge` to snake_case is `o_auth_challenge` (it
    // treats the leading capitalized "O" + "Auth" as two words).
    // Pin to the wire shape the harness emits.
    #[serde(rename = "oauth_challenge", rename_all = "camelCase")]
    OAuthChallenge {
        challenge_id: String,
        provider_id: String,
        /// `"auth"` → display URL + instructions; `"prompt"` → display
        /// `message` and an input field (e.g. GHES domain).
        kind: String,
        url: Option<String>,
        instructions: Option<String>,
        message: Option<String>,
        placeholder: Option<String>,
        allow_empty: bool,
    },
    #[serde(rename = "oauth_progress", rename_all = "camelCase")]
    OAuthProgress {
        challenge_id: String,
        provider_id: String,
        message: String,
    },
    #[serde(rename = "oauth_complete", rename_all = "camelCase")]
    OAuthComplete {
        challenge_id: String,
        provider_id: String,
        ok: bool,
        error: Option<String>,
    },
}

async fn route_pi_message(
    event_tx: &broadcast::Sender<AgentEvent>,
    control_tx: &broadcast::Sender<PiControlEvent>,
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
                            input: None,
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
        PiHarnessMessage::TurnError { error } => {
            // Defer surfacing — `turn_end` carries the consolidated
            // error block. Stashing here lets a turn that emits
            // multiple errors (e.g. retry-then-final-fail) collapse
            // into one assistant block instead of three.
            let trimmed = error
                .as_ref()
                .map(|e| e.trim().to_string())
                .filter(|e| !e.is_empty());
            if let Some(err) = trimmed {
                let mut output = turn_output.lock().await;
                output.pending_error = Some(err);
            }
        }
        PiHarnessMessage::TurnEnd {
            error,
            aggregate,
            iteration,
            total_cost_usd,
            duration_ms,
        } => {
            let mut output = turn_output.lock().await;
            // Merge any mid-turn `turn_error` events the harness
            // forwarded with the `agent_end` errorMessage walk.
            // Either source can carry the user-facing failure, and
            // we prefer the explicit end-of-turn error when both
            // exist (it's the authoritative final state).
            let pending_error = output.pending_error.take();
            let from_turn_end = error
                .as_ref()
                .map(|e| e.trim().to_string())
                .filter(|e| !e.is_empty());
            let error_text = from_turn_end.or(pending_error);
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
            //
            // The harness pre-formats `err` as markdown via
            // `renderProviderErrorMarkdown` (the **Error · HTTP X** label
            // + parsed message), so we embed it verbatim instead of
            // adding our own "Pi turn failed:" prefix that would
            // duplicate the label.
            if let Some(err) = error_text.as_ref() {
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
            // Pi splits the usage payload into two snapshots:
            //  * `aggregate` — cumulative across every assistant message
            //    in this turn. Drives `TokenUsage`'s top-level fields
            //    (TurnFooter / CompletedTurn semantics).
            //  * `iteration` — per-final-call snapshot built from the
            //    last `AssistantMessage.usage` plus
            //    `AgentSession.getContextUsage()`. Drives
            //    `iterations[0]`, which `pickMeterUsageFromResult` reads
            //    in preference to the aggregate for the ContextMeter's
            //    end-of-turn occupancy reading.
            //
            // `model_context_window` lives only on `iteration` (Pi's
            // session API exposes it there); it's also lifted to the
            // top level so consumers that don't crack iterations get
            // the live capacity. Either snapshot is sufficient to
            // populate a `TokenUsage` — emit one only when at least
            // one is present, so resumed pre-fix sessions (no payload
            // at all) result in `usage: None` rather than a zeroed
            // misreading.
            let usage = if aggregate.is_some() || iteration.is_some() {
                let iterations = iteration.as_ref().map(|it| {
                    vec![TokenUsageIteration {
                        total_tokens: it.total_tokens,
                        input_tokens: it.input_tokens.unwrap_or(0),
                        output_tokens: it.output_tokens.unwrap_or(0),
                        cache_creation_input_tokens: it.cache_creation_tokens,
                        cache_read_input_tokens: it.cache_read_tokens,
                        model_context_window: it.model_context_window,
                    }]
                });
                // Aggregate is the source of truth for top-level
                // fields; fall back to iteration when aggregate is
                // missing (older harness builds that only sent
                // iteration). model_context_window is iteration-only.
                let agg_input = aggregate
                    .as_ref()
                    .and_then(|a| a.input_tokens)
                    .or_else(|| iteration.as_ref().and_then(|it| it.input_tokens))
                    .unwrap_or(0);
                let agg_output = aggregate
                    .as_ref()
                    .and_then(|a| a.output_tokens)
                    .or_else(|| iteration.as_ref().and_then(|it| it.output_tokens))
                    .unwrap_or(0);
                let agg_cache_read = aggregate
                    .as_ref()
                    .and_then(|a| a.cache_read_tokens)
                    .or_else(|| iteration.as_ref().and_then(|it| it.cache_read_tokens));
                let agg_cache_creation = aggregate
                    .as_ref()
                    .and_then(|a| a.cache_creation_tokens)
                    .or_else(|| iteration.as_ref().and_then(|it| it.cache_creation_tokens));
                let agg_total = aggregate
                    .as_ref()
                    .and_then(|a| a.total_tokens)
                    .or_else(|| iteration.as_ref().and_then(|it| it.total_tokens));
                Some(TokenUsage {
                    total_tokens: agg_total,
                    input_tokens: agg_input,
                    output_tokens: agg_output,
                    cache_creation_input_tokens: agg_cache_creation,
                    cache_read_input_tokens: agg_cache_read,
                    model_context_window: iteration.as_ref().and_then(|it| it.model_context_window),
                    iterations,
                })
            } else {
                None
            };
            let _ = event_tx.send(AgentEvent::Stream(StreamEvent::Result {
                subtype: subtype.to_string(),
                result: Some(result_text),
                total_cost_usd,
                duration_ms,
                usage,
            }));
            output.text.clear();
            output.thinking.clear();
        }
        PiHarnessMessage::CompactionStart { .. } => {
            // Always flip the UI to "Compacting" — the turn's existing
            // spinner is a generic "Running" indicator, not a compacting
            // affordance, so users had no visual cue that auto-compaction
            // (threshold/overflow) was the reason a turn paused mid-stream.
            // `CompactionEnd` clears the status by emitting either
            // `compact_boundary` (success) or the synthetic `status:running`
            // event (auto-abort) — see the matching branch below.
            let _ = event_tx.send(pi_compacting_status_event());
        }
        PiHarnessMessage::CompactionEnd {
            reason,
            aborted,
            will_retry,
            error_message,
            tokens_before,
            tokens_after,
            duration_ms,
        } => {
            let is_manual = reason.as_deref() == Some("manual");
            if aborted {
                // No context was freed. For a manual /compact surface a
                // visible notice as an assistant text block (Pi's
                // harness already routes operational errors this way).
                // Auto-compaction failures stay quiet on the chat
                // surface: the turn continues and a `will_retry` run may
                // still succeed, so a mid-turn notice would be noise.
                // But we MUST clear the "Compacting" status the matching
                // `CompactionStart` set — no `compact_boundary` will
                // follow on the abort path, so without an explicit
                // status reset `agent_status` would stay stuck on
                // "Compacting" until the turn itself ends.
                if is_manual {
                    let detail = error_message
                        .as_deref()
                        .map(str::trim)
                        .filter(|m| !m.is_empty())
                        .unwrap_or("Pi could not compact the conversation.");
                    let _ = event_tx.send(AgentEvent::Stream(StreamEvent::Assistant {
                        message: AssistantMessage {
                            content: vec![ContentBlock::Text {
                                text: format!("Compaction did not complete: {detail}"),
                            }],
                        },
                    }));
                } else {
                    if !will_retry {
                        tracing::warn!(
                            target: "claudette::agent",
                            subsystem = "pi-sdk",
                            reason = reason.as_deref().unwrap_or("unknown"),
                            error = error_message.as_deref().unwrap_or(""),
                            "pi auto-compaction failed"
                        );
                    }
                    let _ = event_tx.send(pi_status_running_event());
                }
            } else {
                // Success → compact_boundary System event. `send.rs`'s
                // sentinel writer persists the COMPACTION:... row and the
                // CompactionDivider renders. `trigger` keeps Pi's wire
                // vocabulary (`manual` / `threshold` / `overflow`); the
                // divider's label table maps each to a friendly string.
                let trigger = reason
                    .clone()
                    .filter(|r| !r.is_empty())
                    .unwrap_or_else(|| "manual".to_string());
                let _ = event_tx.send(pi_compact_boundary_event(
                    crate::agent::types::CompactMetadata {
                        trigger,
                        pre_tokens: tokens_before.unwrap_or(0),
                        post_tokens: tokens_after.unwrap_or(0),
                        duration_ms: duration_ms.unwrap_or(0),
                    },
                ));
            }
            // The manual /compact pump (set up by `start_compact`)
            // terminates on a Result; emit one so `session.agent_status`
            // flips back to Idle. Auto-compaction rides an active turn
            // whose own `turn_end` produces the Result — emitting one
            // here would cut that turn short.
            if is_manual {
                let _ = event_tx.send(pi_compaction_finish_event());
            }
        }
        PiHarnessMessage::Error { error } => {
            let _ = event_tx.send(AgentEvent::Stderr(
                error.unwrap_or_else(|| "Pi SDK harness error".to_string()),
            ));
        }
        PiHarnessMessage::OAuthChallenge {
            challenge_id,
            provider_id,
            kind,
            url,
            instructions,
            message,
            placeholder,
            allow_empty,
        } => {
            let _ = control_tx.send(PiControlEvent::OAuthChallenge {
                challenge_id,
                provider_id,
                kind,
                url,
                instructions,
                message,
                placeholder,
                allow_empty,
            });
        }
        PiHarnessMessage::OAuthProgress {
            challenge_id,
            provider_id,
            message,
        } => {
            let _ = control_tx.send(PiControlEvent::OAuthProgress {
                challenge_id,
                provider_id,
                message,
            });
        }
        PiHarnessMessage::OAuthComplete {
            challenge_id,
            provider_id,
            ok,
            error,
        } => {
            let _ = control_tx.send(PiControlEvent::OAuthComplete {
                challenge_id,
                provider_id,
                ok,
                error,
            });
        }
        // Intercepted in `spawn_stdout_reader`'s loop before this routes —
        // listed only to keep the match exhaustive.
        PiHarnessMessage::HostTool { .. } => {}
        PiHarnessMessage::Unknown => {}
    }
}

/// Serve a `host_tool` sidecar request: run its `BridgePayload` through
/// the host `Sink` and write a `host_tool_result` line back to the
/// sidecar. Spawned as a detached task so the stdout reader keeps
/// draining while the (blocking-ish) DB write runs.
fn handle_host_tool(
    stdin: Option<PiStdin>,
    sink: Option<PiSink>,
    request_id: String,
    name: String,
    args: Value,
) {
    tokio::spawn(async move {
        let response = run_host_tool(sink, &name, args).await;
        let Some(stdin) = stdin else {
            tracing::warn!(
                target: "claudette::agent",
                subsystem = "pi-sdk",
                tool = %name,
                "host_tool result dropped — sidecar stdin unavailable"
            );
            return;
        };
        let line = json!({
            "type": "host_tool_result",
            "requestId": request_id,
            "ok": response.ok,
            "message": response.message,
            "data": response.data,
            "error": response.error,
        });
        let Ok(mut bytes) = serde_json::to_vec(&line) else {
            return;
        };
        bytes.push(b'\n');
        let mut guard = stdin.lock().await;
        if let Err(err) = guard.write_all(&bytes).await {
            tracing::warn!(
                target: "claudette::agent",
                subsystem = "pi-sdk",
                error = %err,
                "failed to write host_tool_result to sidecar"
            );
        }
    });
}

/// Map a `host_tool` request to a `BridgePayload` and run it through the
/// sink. A missing sink (control session, or a build without scheduling)
/// degrades to an error result rather than panicking.
async fn run_host_tool(sink: Option<PiSink>, name: &str, args: Value) -> BridgeResponse {
    let payload = match bridge_payload_for(name, args) {
        Ok(payload) => payload,
        Err(err) => return BridgeResponse::err(err),
    };
    match sink {
        Some(sink) => sink.handle(payload).await,
        None => BridgeResponse::err("scheduling is unavailable for this session"),
    }
}

/// Translate a native Pi scheduling tool name + arguments into the
/// shared [`BridgePayload`]. Accepts both the camelCase keys the sidecar
/// sends and the snake_case aliases the MCP server tolerates, so the two
/// tool surfaces stay interchangeable. An unknown name is an error, not
/// a panic — a future user Pi extension can add tools without this
/// dispatch table needing to recognize them.
fn bridge_payload_for(name: &str, args: Value) -> Result<BridgePayload, String> {
    let str_arg = |keys: &[&str]| -> Option<String> {
        keys.iter()
            .find_map(|k| args.get(*k).and_then(Value::as_str))
            .map(ToOwned::to_owned)
    };
    match name {
        "ScheduleWakeup" => Ok(BridgePayload::ScheduleWakeup {
            delay_seconds: ["delaySeconds", "delay_seconds"]
                .iter()
                .find_map(|k| args.get(*k).and_then(Value::as_i64)),
            fire_at: str_arg(&["fireAt", "fire_at"]),
            prompt: str_arg(&["prompt"]).ok_or("prompt is required")?,
            reason: str_arg(&["reason"]),
        }),
        "CronCreate" => Ok(BridgePayload::CronCreate {
            name: str_arg(&["name"]),
            cron_expr: str_arg(&["cron", "cron_expr"]).ok_or("cron is required")?,
            prompt: str_arg(&["prompt"]).ok_or("prompt is required")?,
            recurring: args
                .get("recurring")
                .and_then(Value::as_bool)
                .unwrap_or(true),
        }),
        "CronList" => Ok(BridgePayload::CronList),
        "CronDelete" => Ok(BridgePayload::CronDelete {
            id: str_arg(&["id", "name"]).ok_or("id is required")?,
        }),
        other => Err(format!("unknown host tool: {other}")),
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

/// In-flight indicator for a manual Pi compaction. The frontend
/// `useAgentStream` listener flips `workspace.agent_status` to
/// `"Compacting"` on this exact shape (`subtype: "status"` +
/// `status: "compacting"`), matching the Codex affordance.
fn pi_compacting_status_event() -> AgentEvent {
    AgentEvent::Stream(StreamEvent::System {
        subtype: "status".to_string(),
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
        status: Some("compacting".to_string()),
        compact_result: None,
        compact_metadata: None,
        command_line: None,
    })
}

/// Companion to [`pi_compacting_status_event`]: clears the "Compacting"
/// affordance without producing a compaction divider. Emitted when an
/// auto-compaction aborts mid-turn — the turn keeps streaming, so the
/// status needs to flip back to "Running" but no `compact_boundary`
/// belongs in the chat (the abort freed no context). Frontend handles
/// `status: "running"` by setting `agent_status` back to `"Running"`.
fn pi_status_running_event() -> AgentEvent {
    AgentEvent::Stream(StreamEvent::System {
        subtype: "status".to_string(),
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
        status: Some("running".to_string()),
        compact_result: None,
        compact_metadata: None,
        command_line: None,
    })
}

/// `compact_boundary` System event for a successful Pi compaction.
/// `send_chat_message`'s sentinel writer persists the `COMPACTION:...`
/// row from `compact_metadata`, and the `CompactionDivider` renders.
/// `compact_result` stays `None`: the `StreamEvent::System` contract
/// reserves it for the end-of-compaction *status* event (Claude CLI's
/// pattern); the boundary carries its payload in `compact_metadata`.
fn pi_compact_boundary_event(meta: crate::agent::types::CompactMetadata) -> AgentEvent {
    AgentEvent::Stream(StreamEvent::System {
        subtype: "compact_boundary".to_string(),
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
        compact_metadata: Some(meta),
        command_line: None,
    })
}

/// Synthetic terminal event that ends the per-turn pump `start_compact`
/// set up, so the chat session's status flips back to `"Idle"`. Mirrors
/// the `subtype: "success"` Result Claude's CLI emits at the end of its
/// `/compact` turn. Always `success`: the compaction *operation*
/// completed even when it freed nothing — a failure, if any, is already
/// surfaced as an assistant notice.
fn pi_compaction_finish_event() -> AgentEvent {
    AgentEvent::Stream(StreamEvent::Result {
        subtype: "success".to_string(),
        result: None,
        total_cost_usd: None,
        duration_ms: None,
        usage: None,
    })
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

    /// Build the route_pi_message dependencies pre-wired together.
    /// Returns the senders alongside a receiver so tests can drain the
    /// emitted stream events. `control_tx` is created but no test
    /// receiver is wired by default — pin a subscriber yourself if
    /// you need to assert on control-plane events.
    fn pi_state() -> (
        broadcast::Sender<AgentEvent>,
        broadcast::Sender<PiControlEvent>,
        broadcast::Receiver<AgentEvent>,
        PendingRequests,
        TurnOutput,
        InitCacheHandle,
    ) {
        let (event_tx, rx) = broadcast::channel::<AgentEvent>(64);
        let (control_tx, _) = broadcast::channel::<PiControlEvent>(64);
        let pending: PendingRequests = Arc::new(Mutex::new(BTreeMap::new()));
        let turn_output: TurnOutput = Arc::new(Mutex::new(PiTurnOutput::fresh()));
        let init_cache: InitCacheHandle = Arc::new(Mutex::new(InitCache::default()));
        (event_tx, control_tx, rx, pending, turn_output, init_cache)
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

    /// The harness emits two usage snapshots on `turn_end`:
    ///  * `aggregate` (cumulative across all assistant messages in
    ///    this Claudette-level turn) — drives the TurnFooter.
    ///  * `iteration` (per-final-call) — drives the ContextMeter via
    ///    `TokenUsage.iterations[0]`.
    ///
    /// Both use the `inputTokens` / `outputTokens` / `cacheReadTokens`
    /// / `cacheCreationTokens` / `totalTokens` shape; `iteration` also
    /// carries `modelContextWindow`. The Rust side has to deserialize
    /// that shape verbatim — a refactor that renames or reshapes any
    /// field here silently regresses the meter or the footer. Pin the
    /// wire format.
    #[test]
    fn turn_end_usage_wire_format() {
        let line = r#"{
            "type": "turn_end",
            "aggregate": {
                "inputTokens": 410700,
                "outputTokens": 9000,
                "cacheReadTokens": 0,
                "cacheCreationTokens": 0,
                "totalTokens": 419700
            },
            "iteration": {
                "inputTokens": 136900,
                "outputTokens": 3000,
                "cacheReadTokens": 0,
                "cacheCreationTokens": 0,
                "totalTokens": 139900,
                "modelContextWindow": 272000
            },
            "totalCostUsd": 0.42,
            "durationMs": 513000
        }"#;
        let msg: PiHarnessMessage = serde_json::from_str(line).unwrap();
        match msg {
            PiHarnessMessage::TurnEnd {
                aggregate: Some(agg),
                iteration: Some(it),
                total_cost_usd,
                duration_ms,
                ..
            } => {
                assert_eq!(agg.input_tokens, Some(410_700));
                assert_eq!(agg.output_tokens, Some(9000));
                assert_eq!(agg.total_tokens, Some(419_700));
                assert_eq!(it.input_tokens, Some(136_900));
                assert_eq!(it.output_tokens, Some(3000));
                assert_eq!(it.total_tokens, Some(139_900));
                assert_eq!(it.model_context_window, Some(272_000));
                assert_eq!(total_cost_usd, Some(0.42));
                assert_eq!(duration_ms, Some(513_000));
            }
            other => panic!("expected TurnEnd with both snapshots, got {other:?}"),
        }
    }

    /// Sessions resumed mid-stream from an older harness build won't
    /// send `aggregate` or `iteration`. The deserializer must accept
    /// that case and let the route layer skip building a TokenUsage
    /// rather than blow up the reader loop.
    #[test]
    fn turn_end_without_usage_parses() {
        let line = r#"{"type":"turn_end"}"#;
        let msg: PiHarnessMessage = serde_json::from_str(line).unwrap();
        assert!(matches!(
            msg,
            PiHarnessMessage::TurnEnd {
                aggregate: None,
                iteration: None,
                total_cost_usd: None,
                duration_ms: None,
                error: None,
            }
        ));
    }

    fn turn_end(error: Option<&str>) -> PiHarnessMessage {
        PiHarnessMessage::TurnEnd {
            error: error.map(str::to_string),
            aggregate: None,
            iteration: None,
            total_cost_usd: None,
            duration_ms: None,
        }
    }

    fn turn_end_with_usage() -> PiHarnessMessage {
        // Multi-iteration turn: the agent loop ran three model calls, so
        // aggregate is roughly 3 × per-final-call. The footer reads the
        // aggregate; the meter reads `iterations[0]` (the per-final-call).
        PiHarnessMessage::TurnEnd {
            error: None,
            aggregate: Some(PiAggregateUsage {
                input_tokens: Some(300),
                output_tokens: Some(150),
                cache_read_tokens: Some(60),
                cache_creation_tokens: Some(15),
                total_tokens: Some(525),
            }),
            iteration: Some(PiIterationUsage {
                input_tokens: Some(100),
                output_tokens: Some(50),
                cache_read_tokens: Some(20),
                cache_creation_tokens: Some(5),
                total_tokens: Some(175),
                model_context_window: Some(272_000),
            }),
            total_cost_usd: Some(0.0123),
            duration_ms: Some(4321),
        }
    }

    #[test]
    fn parses_pi_tool_request() {
        let value = r#"{"type":"tool_request","requestId":"r1","toolCallId":"t1","kind":"commandExecution","input":{"command":"echo hi"}}"#;
        let msg: PiHarnessMessage = serde_json::from_str(value).unwrap();
        assert!(matches!(msg, PiHarnessMessage::ToolRequest { .. }));
    }

    #[test]
    fn parses_host_tool() {
        let value = r#"{"type":"host_tool","requestId":"t1","name":"CronCreate","args":{"cron":"0 9 * * *"}}"#;
        match serde_json::from_str::<PiHarnessMessage>(value).unwrap() {
            PiHarnessMessage::HostTool {
                request_id,
                name,
                args,
            } => {
                assert_eq!(request_id, "t1");
                assert_eq!(name, "CronCreate");
                assert_eq!(args["cron"], "0 9 * * *");
            }
            other => panic!("expected HostTool, got {other:?}"),
        }
        // Zero-parameter tools omit `args`; the field must still parse.
        let no_args = r#"{"type":"host_tool","requestId":"t2","name":"CronList"}"#;
        assert!(matches!(
            serde_json::from_str::<PiHarnessMessage>(no_args).unwrap(),
            PiHarnessMessage::HostTool { .. }
        ));
    }

    #[test]
    fn bridge_payload_for_maps_each_scheduling_tool() {
        // camelCase keys (what the sidecar sends).
        match bridge_payload_for(
            "ScheduleWakeup",
            json!({ "prompt": "ping", "delaySeconds": 60, "reason": "later" }),
        )
        .unwrap()
        {
            BridgePayload::ScheduleWakeup {
                delay_seconds,
                prompt,
                reason,
                ..
            } => {
                assert_eq!(delay_seconds, Some(60));
                assert_eq!(prompt, "ping");
                assert_eq!(reason.as_deref(), Some("later"));
            }
            other => panic!("expected ScheduleWakeup, got {other:?}"),
        }
        // snake_case aliases still work — parity with the MCP server.
        assert!(matches!(
            bridge_payload_for(
                "ScheduleWakeup",
                json!({ "prompt": "p", "delay_seconds": 5 })
            )
            .unwrap(),
            BridgePayload::ScheduleWakeup {
                delay_seconds: Some(5),
                ..
            }
        ));
        // CronCreate defaults `recurring` to true.
        match bridge_payload_for("CronCreate", json!({ "cron": "0 9 * * *", "prompt": "go" }))
            .unwrap()
        {
            BridgePayload::CronCreate {
                cron_expr,
                recurring,
                name,
                ..
            } => {
                assert_eq!(cron_expr, "0 9 * * *");
                assert!(recurring);
                assert_eq!(name, None);
            }
            other => panic!("expected CronCreate, got {other:?}"),
        }
        assert!(matches!(
            bridge_payload_for("CronList", json!({})).unwrap(),
            BridgePayload::CronList
        ));
        // CronDelete accepts `name` as an alias for `id`.
        assert!(matches!(
            bridge_payload_for("CronDelete", json!({ "name": "morning" })).unwrap(),
            BridgePayload::CronDelete { .. }
        ));
    }

    #[test]
    fn bridge_payload_for_rejects_bad_input() {
        assert!(bridge_payload_for("ScheduleWakeup", json!({})).is_err());
        assert!(bridge_payload_for("CronCreate", json!({ "prompt": "x" })).is_err());
        assert!(bridge_payload_for("CronDelete", json!({})).is_err());
        // An unrecognized tool is an error, not a panic — leaves room
        // for future user Pi extensions to add their own host tools.
        assert!(
            bridge_payload_for("SomeFutureExtensionTool", json!({}))
                .unwrap_err()
                .contains("unknown host tool")
        );
    }

    #[tokio::test]
    async fn run_host_tool_forwards_payload_to_sink() {
        struct RecordingSink {
            last: std::sync::Mutex<Option<BridgePayload>>,
        }
        impl Sink for RecordingSink {
            fn handle(
                &self,
                payload: BridgePayload,
            ) -> std::pin::Pin<Box<dyn std::future::Future<Output = BridgeResponse> + Send + '_>>
            {
                Box::pin(async move {
                    *self.last.lock().unwrap() = Some(payload);
                    BridgeResponse::message("ok")
                })
            }
        }
        let recorder = Arc::new(RecordingSink {
            last: std::sync::Mutex::new(None),
        });
        let sink: PiSink = recorder.clone();
        let response = run_host_tool(Some(sink), "CronDelete", json!({ "id": "task-9" })).await;
        assert!(response.ok);
        match recorder.last.lock().unwrap().clone() {
            Some(BridgePayload::CronDelete { id }) => assert_eq!(id, "task-9"),
            other => panic!("expected CronDelete to reach the sink, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn run_host_tool_degrades_without_sink_or_on_bad_input() {
        // No sink (control session / scheduling-disabled build).
        let no_sink = run_host_tool(None, "CronList", json!({})).await;
        assert!(!no_sink.ok && no_sink.error.is_some());
        // Bad args never reach the sink.
        let bad = run_host_tool(None, "ScheduleWakeup", json!({})).await;
        assert!(!bad.ok && bad.error.is_some());
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
        let (event_tx, control_tx, mut rx, pending, turn_output, init_cache) = pi_state();

        route_pi_message(
            &event_tx,
            &control_tx,
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
        let (event_tx, control_tx, mut rx, pending, turn_output, init_cache) = pi_state();
        route_pi_message(
            &event_tx,
            &control_tx,
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
        let (event_tx, control_tx, mut rx, pending, turn_output, init_cache) = pi_state();
        route_pi_message(
            &event_tx,
            &control_tx,
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
        let (event_tx, control_tx, _rx, pending, turn_output, init_cache) = pi_state();
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
            &control_tx,
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
        let (event_tx, control_tx, _rx, pending, turn_output, init_cache) = pi_state();
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
            &control_tx,
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
        let (event_tx, control_tx, _rx, pending, turn_output, init_cache) = pi_state();
        route_pi_message(
            &event_tx,
            &control_tx,
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
        let (event_tx, control_tx, mut rx, pending, turn_output, init_cache) = pi_state();
        route_pi_message(
            &event_tx,
            &control_tx,
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
        let (event_tx, control_tx, mut rx, pending, turn_output, init_cache) = pi_state();
        // Pollute prior state so we can verify the reset.
        turn_output.lock().await.text.push_str("stale");
        route_pi_message(
            &event_tx,
            &control_tx,
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
        let (event_tx, control_tx, mut rx, pending, turn_output, init_cache) = pi_state();
        route_pi_message(
            &event_tx,
            &control_tx,
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
            &control_tx,
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
        let (event_tx, control_tx, mut rx, pending, turn_output, init_cache) = pi_state();
        route_pi_message(
            &event_tx,
            &control_tx,
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
        let (event_tx, control_tx, mut rx, pending, turn_output, init_cache) = pi_state();
        route_pi_message(
            &event_tx,
            &control_tx,
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
        let (event_tx, control_tx, mut rx, pending, turn_output, init_cache) = pi_state();
        // Prime the index by emitting a start first
        route_pi_message(
            &event_tx,
            &control_tx,
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
            &control_tx,
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
        let (event_tx, control_tx, mut rx, pending, turn_output, init_cache) = pi_state();
        // Open block first
        turn_output.lock().await.tool_index("call-r");

        route_pi_message(
            &event_tx,
            &control_tx,
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
        let (event_tx, control_tx, mut rx, pending, turn_output, init_cache) = pi_state();
        route_pi_message(
            &event_tx,
            &control_tx,
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
        let (event_tx, control_tx, mut rx, pending, turn_output, init_cache) = pi_state();
        {
            let mut output = turn_output.lock().await;
            output.text.push_str("final answer");
            output.thinking.push_str("ponder");
        }
        route_pi_message(
            &event_tx,
            &control_tx,
            &pending,
            &turn_output,
            &init_cache,
            turn_end(None),
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

    /// Pi's agent_end carries per-assistant-message usage. The harness
    /// sums it into turn_end, and Rust must preserve it on Result so
    /// the regular chat bridge updates the footer and Usage meter.
    #[tokio::test]
    async fn turn_end_maps_usage_cost_and_duration_to_result() {
        let (event_tx, control_tx, mut rx, pending, turn_output, init_cache) = pi_state();
        turn_output.lock().await.text.push_str("metered answer");
        route_pi_message(
            &event_tx,
            &control_tx,
            &pending,
            &turn_output,
            &init_cache,
            turn_end_with_usage(),
        )
        .await;
        let _assistant = next_event(&mut rx).await;
        match next_event(&mut rx).await {
            AgentEvent::Stream(StreamEvent::Result {
                usage,
                total_cost_usd,
                duration_ms,
                ..
            }) => {
                let usage = usage.expect("Pi usage should be forwarded");
                // Top-level fields are the cumulative turn aggregate
                // (TurnFooter / CompletedTurn semantics). They must
                // NOT be the per-final-call snapshot — otherwise a
                // multi-iteration turn under-reports total work.
                assert_eq!(usage.total_tokens, Some(525));
                assert_eq!(usage.input_tokens, 300);
                assert_eq!(usage.output_tokens, 150);
                assert_eq!(usage.cache_read_input_tokens, Some(60));
                assert_eq!(usage.cache_creation_input_tokens, Some(15));
                // model_context_window is iteration-only on the
                // protocol side (Pi exposes it via getContextUsage),
                // but we lift it to the top level too so consumers
                // that don't crack `iterations` still see the live
                // capacity.
                assert_eq!(usage.model_context_window, Some(272_000));
                // iterations[0] is the per-final-call snapshot for the
                // ContextMeter — must reflect just the final call, not
                // the cumulative.
                let iters = usage.iterations.expect("iterations[0] must be populated");
                assert_eq!(iters.len(), 1);
                assert_eq!(iters[0].input_tokens, 100);
                assert_eq!(iters[0].output_tokens, 50);
                assert_eq!(iters[0].cache_read_input_tokens, Some(20));
                assert_eq!(iters[0].cache_creation_input_tokens, Some(5));
                assert_eq!(iters[0].total_tokens, Some(175));
                assert_eq!(iters[0].model_context_window, Some(272_000));
                assert_eq!(total_cost_usd, Some(0.0123));
                assert_eq!(duration_ms, Some(4321));
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }

    /// Pre-aggregate harness builds (or any future sidecar variant
    /// that emits only the per-final-call snapshot) must still
    /// produce a usable `TokenUsage`. The route layer falls back to
    /// the iteration values for the top-level fields when aggregate
    /// is absent — better to show single-iteration totals than no
    /// totals at all.
    #[tokio::test]
    async fn turn_end_iteration_only_falls_back_to_iteration_for_top_level() {
        let (event_tx, control_tx, mut rx, pending, turn_output, init_cache) = pi_state();
        turn_output.lock().await.text.push_str("answer");
        route_pi_message(
            &event_tx,
            &control_tx,
            &pending,
            &turn_output,
            &init_cache,
            PiHarnessMessage::TurnEnd {
                error: None,
                aggregate: None,
                iteration: Some(PiIterationUsage {
                    input_tokens: Some(100),
                    output_tokens: Some(50),
                    cache_read_tokens: Some(20),
                    cache_creation_tokens: Some(5),
                    total_tokens: Some(175),
                    model_context_window: Some(272_000),
                }),
                total_cost_usd: None,
                duration_ms: None,
            },
        )
        .await;
        let _assistant = next_event(&mut rx).await;
        match next_event(&mut rx).await {
            AgentEvent::Stream(StreamEvent::Result {
                usage: Some(usage), ..
            }) => {
                // No aggregate available → top-level mirrors iteration.
                assert_eq!(usage.input_tokens, 100);
                assert_eq!(usage.output_tokens, 50);
                assert_eq!(usage.cache_read_input_tokens, Some(20));
                assert_eq!(usage.cache_creation_input_tokens, Some(5));
                assert_eq!(usage.total_tokens, Some(175));
                let iters = usage.iterations.expect("iterations populated");
                assert_eq!(iters[0].input_tokens, 100);
            }
            other => panic!("expected Result with usage, got {other:?}"),
        }
    }

    /// Turn-end with neither aggregate nor iteration (a sidecar
    /// predating this payload, or a turn that produced no LLM usage
    /// at all) must produce `usage: None` rather than zeroes. Zeroes
    /// would poison the meter; `None` lets it hold its previous
    /// reading.
    #[tokio::test]
    async fn turn_end_without_usage_emits_no_token_usage() {
        let (event_tx, control_tx, mut rx, pending, turn_output, init_cache) = pi_state();
        turn_output.lock().await.text.push_str("answer");
        route_pi_message(
            &event_tx,
            &control_tx,
            &pending,
            &turn_output,
            &init_cache,
            turn_end(None),
        )
        .await;
        let _assistant = next_event(&mut rx).await;
        match next_event(&mut rx).await {
            AgentEvent::Stream(StreamEvent::Result { usage, .. }) => {
                assert!(
                    usage.is_none(),
                    "no aggregate + no iteration → no TokenUsage"
                );
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
        let (event_tx, control_tx, mut rx, pending, turn_output, init_cache) = pi_state();
        turn_output.lock().await.text.push_str("partial");
        route_pi_message(
            &event_tx,
            &control_tx,
            &pending,
            &turn_output,
            &init_cache,
            turn_end(Some("rate limit")),
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
        let (event_tx, control_tx, mut rx, pending, turn_output, init_cache) = pi_state();
        route_pi_message(
            &event_tx,
            &control_tx,
            &pending,
            &turn_output,
            &init_cache,
            turn_end(None),
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

    /// A mid-turn `turn_error` (forwarded by the harness from a Pi
    /// `AssistantMessageEvent { type: "error" }` or a failed
    /// `auto_retry_end`) followed by a clean-looking `turn_end` must
    /// still surface the error to the user. Without this, every
    /// Copilot 401 / OpenRouter 5xx came through as "Agent stopped"
    /// with no chat message.
    #[tokio::test]
    async fn turn_error_promotes_pending_error_into_turn_end() {
        let (event_tx, control_tx, mut rx, pending, turn_output, init_cache) = pi_state();
        route_pi_message(
            &event_tx,
            &control_tx,
            &pending,
            &turn_output,
            &init_cache,
            PiHarnessMessage::TurnError {
                error: Some("401 Unauthorized".to_string()),
            },
        )
        .await;
        // turn_error itself produces no chat event — it stashes the
        // error on turn_output until turn_end finalizes the turn.
        assert!(try_recv_now(&mut rx).is_none());
        route_pi_message(
            &event_tx,
            &control_tx,
            &pending,
            &turn_output,
            &init_cache,
            turn_end(None),
        )
        .await;
        match next_event(&mut rx).await {
            AgentEvent::Stream(StreamEvent::Assistant { message }) => {
                let last = message.content.last().expect("error block");
                match last {
                    ContentBlock::Text { text } => {
                        assert!(text.contains("401 Unauthorized"), "got {text:?}")
                    }
                    other => panic!("expected Text, got {other:?}"),
                }
            }
            other => panic!("expected Assistant, got {other:?}"),
        }
        match next_event(&mut rx).await {
            AgentEvent::Stream(StreamEvent::Result {
                subtype, result, ..
            }) => {
                assert_eq!(subtype, "error");
                assert!(result.unwrap().contains("401 Unauthorized"));
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }

    /// When BOTH `turn_error` (mid-turn) and `turn_end { error }`
    /// (agent_end walk surfaced one too) arrive, `turn_end`'s error
    /// wins. It's the authoritative final state — if Pi reports a
    /// different message there, that's what the user should see.
    #[tokio::test]
    async fn turn_end_error_wins_over_pending_error() {
        let (event_tx, control_tx, mut rx, pending, turn_output, init_cache) = pi_state();
        route_pi_message(
            &event_tx,
            &control_tx,
            &pending,
            &turn_output,
            &init_cache,
            PiHarnessMessage::TurnError {
                error: Some("retry-time error".to_string()),
            },
        )
        .await;
        route_pi_message(
            &event_tx,
            &control_tx,
            &pending,
            &turn_output,
            &init_cache,
            turn_end(Some("final 500")),
        )
        .await;
        match next_event(&mut rx).await {
            AgentEvent::Stream(StreamEvent::Assistant { message }) => {
                let last = message.content.last().expect("error block");
                match last {
                    ContentBlock::Text { text } => {
                        assert!(text.contains("final 500"), "got {text:?}");
                        assert!(!text.contains("retry-time error"), "got {text:?}");
                    }
                    other => panic!("expected Text, got {other:?}"),
                }
            }
            other => panic!("expected Assistant, got {other:?}"),
        }
        let _ = next_event(&mut rx).await;
    }

    /// Pending error must be cleared between turns so a successful
    /// turn N+1 doesn't inherit turn N's failure.
    #[tokio::test]
    async fn pending_error_is_cleared_between_turns() {
        let (event_tx, control_tx, mut rx, pending, turn_output, init_cache) = pi_state();
        route_pi_message(
            &event_tx,
            &control_tx,
            &pending,
            &turn_output,
            &init_cache,
            PiHarnessMessage::TurnError {
                error: Some("turn1 failed".to_string()),
            },
        )
        .await;
        route_pi_message(
            &event_tx,
            &control_tx,
            &pending,
            &turn_output,
            &init_cache,
            turn_end(None),
        )
        .await;
        // Drain turn-1 finalize events.
        let _ = next_event(&mut rx).await;
        let _ = next_event(&mut rx).await;

        // Turn 2: clean run; must NOT re-surface the turn-1 error.
        turn_output.lock().await.text.push_str("hello");
        route_pi_message(
            &event_tx,
            &control_tx,
            &pending,
            &turn_output,
            &init_cache,
            turn_end(None),
        )
        .await;
        match next_event(&mut rx).await {
            AgentEvent::Stream(StreamEvent::Assistant { message }) => {
                for block in &message.content {
                    if let ContentBlock::Text { text } = block {
                        assert!(!text.contains("turn1 failed"));
                    }
                }
            }
            other => panic!("expected Assistant, got {other:?}"),
        }
        match next_event(&mut rx).await {
            AgentEvent::Stream(StreamEvent::Result { subtype, .. }) => {
                assert_eq!(subtype, "success");
            }
            other => panic!("expected Result, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn error_message_emits_stderr() {
        let (event_tx, control_tx, mut rx, pending, turn_output, init_cache) = pi_state();
        route_pi_message(
            &event_tx,
            &control_tx,
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
        let (event_tx, control_tx, mut rx, pending, turn_output, init_cache) = pi_state();
        route_pi_message(
            &event_tx,
            &control_tx,
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

    /// Drain every event currently buffered on the receiver.
    fn drain_events(rx: &mut broadcast::Receiver<AgentEvent>) -> Vec<AgentEvent> {
        let mut events = Vec::new();
        while let Ok(event) = rx.try_recv() {
            events.push(event);
        }
        events
    }

    /// The sidecar emits camelCase keys; pin the rename mapping so a
    /// wire-shaped success `compaction_end` deserializes with every
    /// field populated.
    #[test]
    fn parses_compaction_end_success() {
        let line = r#"{"type":"compaction_end","reason":"manual","aborted":false,"willRetry":false,"tokensBefore":120000,"tokensAfter":30000,"durationMs":4200}"#;
        match serde_json::from_str::<PiHarnessMessage>(line).unwrap() {
            PiHarnessMessage::CompactionEnd {
                reason,
                aborted,
                will_retry,
                error_message,
                tokens_before,
                tokens_after,
                duration_ms,
            } => {
                assert_eq!(reason.as_deref(), Some("manual"));
                assert!(!aborted);
                assert!(!will_retry);
                assert!(error_message.is_none());
                assert_eq!(tokens_before, Some(120000));
                assert_eq!(tokens_after, Some(30000));
                assert_eq!(duration_ms, Some(4200));
            }
            other => panic!("expected CompactionEnd, got {other:?}"),
        }
    }

    /// The aborted/failed variant carries no token counts — make sure
    /// the absent fields default cleanly and `errorMessage` decodes.
    #[test]
    fn parses_compaction_end_aborted_without_tokens() {
        let line = r#"{"type":"compaction_end","reason":"manual","aborted":true,"willRetry":false,"errorMessage":"context provider 500"}"#;
        match serde_json::from_str::<PiHarnessMessage>(line).unwrap() {
            PiHarnessMessage::CompactionEnd {
                aborted,
                error_message,
                tokens_before,
                tokens_after,
                duration_ms,
                ..
            } => {
                assert!(aborted);
                assert_eq!(error_message.as_deref(), Some("context provider 500"));
                assert!(tokens_before.is_none());
                assert!(tokens_after.is_none());
                assert!(duration_ms.is_none());
            }
            other => panic!("expected CompactionEnd, got {other:?}"),
        }
    }

    #[test]
    fn parses_compaction_start() {
        let msg: PiHarnessMessage =
            serde_json::from_str(r#"{"type":"compaction_start","reason":"threshold"}"#).unwrap();
        match msg {
            PiHarnessMessage::CompactionStart { reason } => {
                assert_eq!(reason.as_deref(), Some("threshold"));
            }
            other => panic!("expected CompactionStart, got {other:?}"),
        }
    }

    /// A manual /compact runs a dedicated per-turn pump, so its
    /// `compaction_start` flips the UI to "Compacting" via a
    /// `status` System event.
    #[tokio::test]
    async fn route_compaction_start_manual_emits_compacting_status() {
        let (event_tx, control_tx, mut rx, pending, turn_output, init_cache) = pi_state();
        route_pi_message(
            &event_tx,
            &control_tx,
            &pending,
            &turn_output,
            &init_cache,
            PiHarnessMessage::CompactionStart {
                reason: Some("manual".to_string()),
            },
        )
        .await;
        match next_event(&mut rx).await {
            AgentEvent::Stream(StreamEvent::System {
                subtype, status, ..
            }) => {
                assert_eq!(subtype, "status");
                assert_eq!(status.as_deref(), Some("compacting"));
            }
            other => panic!("expected status System event, got {other:?}"),
        }
        assert!(try_recv_now(&mut rx).is_none());
    }

    /// Auto-compaction (threshold/overflow) must also flip the UI to
    /// "Compacting". The active turn's generic "Running" spinner is
    /// indistinguishable from a normal LLM call, so without this event
    /// users had no signal that Pi paused to compact — they saw a
    /// stalled turn and ran `/compact` manually.
    #[tokio::test]
    async fn route_compaction_start_threshold_emits_compacting_status() {
        let (event_tx, control_tx, mut rx, pending, turn_output, init_cache) = pi_state();
        route_pi_message(
            &event_tx,
            &control_tx,
            &pending,
            &turn_output,
            &init_cache,
            PiHarnessMessage::CompactionStart {
                reason: Some("threshold".to_string()),
            },
        )
        .await;
        match next_event(&mut rx).await {
            AgentEvent::Stream(StreamEvent::System {
                subtype, status, ..
            }) => {
                assert_eq!(subtype, "status");
                assert_eq!(status.as_deref(), Some("compacting"));
            }
            other => panic!("expected status System event, got {other:?}"),
        }
        assert!(try_recv_now(&mut rx).is_none());
    }

    /// Same goes for `overflow` (context window exhausted) — the user
    /// needs the same affordance regardless of which auto-trigger
    /// fired.
    #[tokio::test]
    async fn route_compaction_start_overflow_emits_compacting_status() {
        let (event_tx, control_tx, mut rx, pending, turn_output, init_cache) = pi_state();
        route_pi_message(
            &event_tx,
            &control_tx,
            &pending,
            &turn_output,
            &init_cache,
            PiHarnessMessage::CompactionStart {
                reason: Some("overflow".to_string()),
            },
        )
        .await;
        match next_event(&mut rx).await {
            AgentEvent::Stream(StreamEvent::System { status, .. }) => {
                assert_eq!(status.as_deref(), Some("compacting"));
            }
            other => panic!("expected status System event, got {other:?}"),
        }
    }

    /// A successful manual `compaction_end` produces exactly the
    /// compact_boundary System event (carrying Pi's token counts) plus
    /// the synthetic Result that terminates `start_compact`'s pump.
    #[tokio::test]
    async fn route_compaction_end_manual_success_emits_boundary_and_finish() {
        let (event_tx, control_tx, mut rx, pending, turn_output, init_cache) = pi_state();
        route_pi_message(
            &event_tx,
            &control_tx,
            &pending,
            &turn_output,
            &init_cache,
            PiHarnessMessage::CompactionEnd {
                reason: Some("manual".to_string()),
                aborted: false,
                will_retry: false,
                error_message: None,
                tokens_before: Some(120000),
                tokens_after: Some(30000),
                duration_ms: Some(4200),
            },
        )
        .await;
        let events = drain_events(&mut rx);
        assert_eq!(events.len(), 2, "boundary + finish, nothing else");
        match &events[0] {
            AgentEvent::Stream(StreamEvent::System {
                subtype,
                compact_metadata,
                compact_result,
                ..
            }) => {
                assert_eq!(subtype, "compact_boundary");
                assert!(compact_result.is_none());
                let meta = compact_metadata.as_ref().expect("compact_metadata set");
                assert_eq!(meta.trigger, "manual");
                assert_eq!(meta.pre_tokens, 120000);
                assert_eq!(meta.post_tokens, 30000);
                assert_eq!(meta.duration_ms, 4200);
            }
            other => panic!("expected compact_boundary System event, got {other:?}"),
        }
        match &events[1] {
            AgentEvent::Stream(StreamEvent::Result { subtype, .. }) => {
                assert_eq!(subtype, "success");
            }
            other => panic!("expected synthetic Result, got {other:?}"),
        }
    }

    /// Auto-compaction rides an active turn whose own `turn_end`
    /// produces the Result — a threshold `compaction_end` emits only the
    /// divider boundary, never a Result that would cut the turn short.
    #[tokio::test]
    async fn route_compaction_end_threshold_success_emits_boundary_only() {
        let (event_tx, control_tx, mut rx, pending, turn_output, init_cache) = pi_state();
        route_pi_message(
            &event_tx,
            &control_tx,
            &pending,
            &turn_output,
            &init_cache,
            PiHarnessMessage::CompactionEnd {
                reason: Some("threshold".to_string()),
                aborted: false,
                will_retry: false,
                error_message: None,
                tokens_before: Some(150000),
                tokens_after: Some(40000),
                duration_ms: Some(3100),
            },
        )
        .await;
        let events = drain_events(&mut rx);
        assert_eq!(events.len(), 1, "boundary only — no terminating Result");
        match &events[0] {
            AgentEvent::Stream(StreamEvent::System {
                subtype,
                compact_metadata,
                ..
            }) => {
                assert_eq!(subtype, "compact_boundary");
                assert_eq!(
                    compact_metadata.as_ref().expect("metadata set").trigger,
                    "threshold",
                );
            }
            other => panic!("expected compact_boundary System event, got {other:?}"),
        }
    }

    /// A failed manual compaction freed no context: surface a visible
    /// assistant notice (never a divider) plus the Result that ends the
    /// pump. The error text rides the notice.
    #[tokio::test]
    async fn route_compaction_end_manual_aborted_emits_notice_and_finish() {
        let (event_tx, control_tx, mut rx, pending, turn_output, init_cache) = pi_state();
        route_pi_message(
            &event_tx,
            &control_tx,
            &pending,
            &turn_output,
            &init_cache,
            PiHarnessMessage::CompactionEnd {
                reason: Some("manual".to_string()),
                aborted: true,
                will_retry: false,
                error_message: Some("context provider 500".to_string()),
                tokens_before: None,
                tokens_after: None,
                duration_ms: None,
            },
        )
        .await;
        let events = drain_events(&mut rx);
        assert_eq!(events.len(), 2, "notice + finish, no boundary");
        match &events[0] {
            AgentEvent::Stream(StreamEvent::Assistant { message }) => {
                let text = match message.content.first() {
                    Some(ContentBlock::Text { text }) => text.as_str(),
                    other => panic!("expected text content, got {other:?}"),
                };
                assert!(
                    text.contains("context provider 500"),
                    "carries the error: {text}"
                );
            }
            other => panic!("expected assistant notice, got {other:?}"),
        }
        assert!(
            matches!(
                &events[1],
                AgentEvent::Stream(StreamEvent::Result { subtype, .. }) if subtype == "success"
            ),
            "manual pump must still terminate on a Result",
        );
    }

    /// An auto-compaction failure must not inject a notice or
    /// terminating Result — the turn it rides owns those — but it MUST
    /// clear the "Compacting" status that the matching
    /// `CompactionStart` set. Otherwise `agent_status` stays stuck on
    /// "Compacting" until the turn itself ends.
    #[tokio::test]
    async fn route_compaction_end_threshold_aborted_emits_running_status() {
        let (event_tx, control_tx, mut rx, pending, turn_output, init_cache) = pi_state();
        route_pi_message(
            &event_tx,
            &control_tx,
            &pending,
            &turn_output,
            &init_cache,
            PiHarnessMessage::CompactionEnd {
                reason: Some("threshold".to_string()),
                aborted: true,
                will_retry: false,
                error_message: Some("boom".to_string()),
                tokens_before: None,
                tokens_after: None,
                duration_ms: None,
            },
        )
        .await;
        match next_event(&mut rx).await {
            AgentEvent::Stream(StreamEvent::System {
                subtype, status, ..
            }) => {
                assert_eq!(subtype, "status");
                assert_eq!(status.as_deref(), Some("running"));
            }
            other => panic!("expected status:running System event, got {other:?}"),
        }
        assert!(
            try_recv_now(&mut rx).is_none(),
            "must not emit a boundary or notice on auto-abort",
        );
    }

    /// Unknown variants (e.g. a future-protocol message Claudette
    /// doesn't recognize yet) must not crash the reader loop.
    #[tokio::test]
    async fn unknown_variant_is_silently_ignored() {
        let (event_tx, control_tx, mut rx, pending, turn_output, init_cache) = pi_state();
        route_pi_message(
            &event_tx,
            &control_tx,
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
    fn pi_control_event_uses_camel_case_field_names() {
        // The React OAuth modal reads `challengeId` / `providerId` /
        // `allowEmpty` straight off the Tauri event payload. If these
        // serialize as snake_case the UI receives undefined ids,
        // silently dropping every challenge into the filter check.
        // Pin the wire shape so a future struct rename can't regress.
        let event = PiControlEvent::OAuthChallenge {
            challenge_id: "c1".to_string(),
            provider_id: "github-copilot".to_string(),
            kind: "auth".to_string(),
            url: Some("https://github.com/login/device".to_string()),
            instructions: Some("ABCD-1234".to_string()),
            message: None,
            placeholder: None,
            allow_empty: false,
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["type"], "oauth_challenge");
        assert_eq!(json["challengeId"], "c1");
        assert_eq!(json["providerId"], "github-copilot");
        assert_eq!(json["allowEmpty"], false);
        assert!(json.get("challenge_id").is_none());
        assert!(json.get("provider_id").is_none());
        assert!(json.get("allow_empty").is_none());

        let complete = PiControlEvent::OAuthComplete {
            challenge_id: "c1".to_string(),
            provider_id: "openrouter".to_string(),
            ok: true,
            error: None,
        };
        let json = serde_json::to_value(&complete).unwrap();
        assert_eq!(json["type"], "oauth_complete");
        assert_eq!(json["challengeId"], "c1");
        assert_eq!(json["providerId"], "openrouter");
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
