#![allow(dead_code)]

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;

use crate::env::WorkspaceEnv;

// ---------------------------------------------------------------------------
// Stream event types — maps to Claude CLI `--output-format stream-json`
// ---------------------------------------------------------------------------

/// Top-level JSON line from Claude CLI stdout.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum StreamEvent {
    #[serde(rename = "system")]
    System {
        subtype: String,
        #[serde(default)]
        session_id: Option<String>,
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
    },

    #[serde(rename = "user")]
    User { message: UserEventMessage },

    /// A permission-prompt control request sent by the CLI when
    /// `--permission-prompt-tool stdio` is active. Each `can_use_tool` request
    /// must be answered with a `control_response` keyed by `request_id` —
    /// see [`PersistentSession::send_control_response`].
    #[serde(rename = "control_request")]
    ControlRequest {
        request_id: String,
        request: ControlRequestInner,
    },

    #[serde(other)]
    Unknown,
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
    MessageDelta {},

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

/// Message payload from `user` type events (tool results fed back to the model).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserEventMessage {
    #[serde(default)]
    pub content: Vec<UserContentBlock>,
}

/// Content block within a `user` event message.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum UserContentBlock {
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

/// Parse a single JSON line from the Claude CLI stdout stream.
pub fn parse_stream_line(line: &str) -> Result<StreamEvent, serde_json::Error> {
    serde_json::from_str(line)
}

// ---------------------------------------------------------------------------
// Agent events — wrapper for all events from a turn
// ---------------------------------------------------------------------------

/// Events emitted by an agent turn (stream events + process lifecycle).
#[derive(Debug, Clone, Serialize)]
pub enum AgentEvent {
    /// A parsed stream event from stdout.
    Stream(StreamEvent),
    /// The agent process has exited.
    ProcessExited(Option<i32>),
}

// ---------------------------------------------------------------------------
// Per-turn agent settings
// ---------------------------------------------------------------------------

/// An attachment (image or document) to send alongside the prompt via stream-json stdin.
///
/// Images use `"type": "image"` content blocks; PDFs use `"type": "document"`.
/// The block type is determined by [`media_type`] in [`build_stdin_message`].
#[derive(Debug, Clone)]
pub struct ImageAttachment {
    pub media_type: String,
    pub data_base64: String,
}

/// Per-turn settings that control CLI flags for the agent subprocess.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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
    /// Effort level for adaptive reasoning (`low`, `medium`, `high`, `max`).
    /// `max` is Opus 4.6 only. Applied on every turn via `--effort`.
    pub effort: Option<String>,
    /// Enable Chrome browser mode via `--chrome`. Session-level: only applied
    /// on the first turn.
    pub chrome_enabled: bool,
    /// MCP config JSON string for `--mcp-config`. Per-turn: applied on every
    /// turn since each `claude` process is independent and doesn't inherit
    /// MCP connections from previous turns.
    pub mcp_config: Option<String>,
}

// ---------------------------------------------------------------------------
// Per-turn agent process
// ---------------------------------------------------------------------------

/// Handle for an active agent turn — holds the event receiver and process ID.
pub struct TurnHandle {
    pub event_rx: mpsc::Receiver<AgentEvent>,
    pub pid: u32,
}

/// Build the CLI arguments for a `claude -p` invocation.
///
/// When `has_attachments` is true, the prompt is omitted from the args and
/// `--input-format stream-json` is added — the prompt + images are instead
/// piped to stdin as an `SDKUserMessage` JSON line (see [`build_stdin_message`]).
pub fn build_claude_args(
    session_id: &str,
    prompt: &str,
    is_resume: bool,
    allowed_tools: &[String],
    custom_instructions: Option<&str>,
    settings: &AgentSettings,
    has_attachments: bool,
) -> Vec<String> {
    let mut args = vec![
        "--print".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--include-partial-messages".to_string(),
    ];
    // NOTE: `--permission-prompt-tool stdio` is intentionally NOT added here.
    // `run_turn` runs with stdin closed (or only used for image upload), so
    // there's nobody to answer a `can_use_tool` control_request — advertising
    // the protocol would let the CLI hang waiting for AskUserQuestion /
    // ExitPlanMode approval that no consumer is listening for. The flag is
    // added in `build_persistent_args` instead, where the Tauri bridge owns
    // the stdin and handles control_request → control_response.

    // Check if we should bypass permissions (full access with wildcard)
    let bypass_permissions = allowed_tools.len() == 1 && allowed_tools[0] == "*";

    // Model is session-level — only set on the first turn.
    if !is_resume && let Some(ref model) = settings.model {
        args.push("--model".to_string());
        args.push(model.clone());
    }

    // Chrome is session-level — only set on the first turn.
    if !is_resume && settings.chrome_enabled {
        args.push("--chrome".to_string());
    }

    // MCP config must be set on every turn — each `claude` invocation is a fresh
    // process that doesn't inherit MCP connections from previous turns.
    if let Some(ref mcp_json) = settings.mcp_config {
        args.push("--mcp-config".to_string());
        args.push(mcp_json.clone());
    }

    // Permission mode must be set on every turn — each `claude` invocation is
    // an independent process that doesn't inherit the previous turn's flags.
    if settings.plan_mode {
        args.push("--permission-mode".to_string());
        args.push("plan".to_string());
    } else if bypass_permissions {
        args.push("--permission-mode".to_string());
        args.push("bypassPermissions".to_string());
    }

    // Per-turn settings via --settings JSON.
    if settings.fast_mode || settings.thinking_enabled {
        let mut obj = serde_json::Map::new();
        if settings.fast_mode {
            obj.insert("fastMode".to_string(), serde_json::Value::Bool(true));
        }
        if settings.thinking_enabled {
            obj.insert(
                "alwaysThinkingEnabled".to_string(),
                serde_json::Value::Bool(true),
            );
        }
        args.push("--settings".to_string());
        args.push(serde_json::Value::Object(obj).to_string());
    }

    // Effort level — standalone flag, not part of --settings JSON.
    // "auto" and unknown values are skipped (let the CLI use its default).
    if let Some(ref effort) = settings.effort
        && matches!(effort.as_str(), "low" | "medium" | "high" | "xhigh" | "max")
    {
        args.push("--effort".to_string());
        args.push(effort.clone());
    }

    // Add --allowedTools (only for non-bypass modes — bypassPermissions already
    // skips all permission checks, and a redundant --allowedTools can interfere).
    if !bypass_permissions && !allowed_tools.is_empty() {
        args.push("--allowedTools".to_string());
        args.push(allowed_tools.join(","));
    }

    // Only append custom instructions on the first turn — resumed sessions
    // already have the system prompt set from the initial turn.
    if !is_resume
        && let Some(instructions) = custom_instructions
        && !instructions.trim().is_empty()
    {
        args.push("--append-system-prompt".to_string());
        args.push(instructions.to_string());
    }

    if is_resume {
        args.push("--resume".to_string());
        args.push(session_id.to_string());
    } else {
        args.push("--session-id".to_string());
        args.push(session_id.to_string());
    }

    if has_attachments {
        // When images are present, the prompt is sent via stdin as a structured
        // SDKUserMessage (with content blocks). We add --input-format stream-json
        // so the CLI reads from stdin instead of the positional arg.
        args.push("--input-format".to_string());
        args.push("stream-json".to_string());
    } else {
        args.push(prompt.to_string());
    }

    args
}

/// Build a single-line JSON payload for stdin when using `--input-format stream-json`.
///
/// Produces an `SDKUserMessage` with content blocks: one text block for the
/// prompt, then one `image` or `document` block per attachment (PDFs use the
/// `document` block type; all other supported formats use `image`).
pub fn build_stdin_message(prompt: &str, attachments: &[ImageAttachment]) -> String {
    let mut content_blocks = Vec::new();

    // Only add a text block if the prompt is non-empty — the API rejects
    // empty text content blocks with "text content blocks must be non-empty".
    if !prompt.trim().is_empty() {
        content_blocks.push(serde_json::json!({"type": "text", "text": prompt}));
    }

    for att in attachments {
        let block_type = if att.media_type == "application/pdf" {
            "document"
        } else {
            "image"
        };
        content_blocks.push(serde_json::json!({
            "type": block_type,
            "source": {
                "type": "base64",
                "media_type": att.media_type,
                "data": att.data_base64,
            }
        }));
    }

    serde_json::json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": content_blocks,
        },
        "parent_tool_use_id": null,
    })
    .to_string()
}

// ---------------------------------------------------------------------------
// Claude CLI path resolution
// ---------------------------------------------------------------------------

/// Resolve the full path to the `claude` CLI binary (async-safe).
///
/// GUI apps on macOS (and some Linux desktop environments) don't inherit the
/// user's shell PATH, so a bare `Command::new("claude")` fails with ENOENT.
/// We first check the current process PATH, then ask the user's login shell
/// for its PATH, then try well-known install locations, and finally fall back
/// to a bare `claude` command.
///
/// Successful absolute-path resolutions are cached in a `OnceLock` for the
/// lifetime of the process. The bare `"claude"` fallback is NOT cached, so
/// subsequent calls can retry resolution if the environment improves (e.g.,
/// a slow shell probe that timed out on first call).
///
/// The login-shell probe uses `std::process::Command` (blocking) with a
/// 5-second timeout that kills the subprocess on expiry. We run the entire
/// resolution inside `spawn_blocking` to avoid stalling async workers.
async fn resolve_claude_path() -> OsString {
    static RESOLVED: OnceLock<OsString> = OnceLock::new();
    if let Some(cached) = RESOLVED.get() {
        return cached.clone();
    }
    let resolved = tokio::task::spawn_blocking(|| {
        resolve_claude_path_inner(
            dirs::home_dir(),
            std::env::var_os("PATH"),
            login_shell_path,
            is_executable_file,
        )
    })
    .await
    .unwrap_or_else(|_| OsString::from("claude"));
    // Only cache absolute paths — the bare "claude" fallback should allow
    // retries on subsequent calls in case the environment improves.
    if Path::new(&resolved).is_absolute() {
        let _ = RESOLVED.set(resolved.clone());
    }
    resolved
}

/// Check that a path is a regular file with execute permission.
#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.is_file()
        && path
            .metadata()
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
}

/// Check that a path is a regular file (non-Unix fallback).
#[cfg(not(unix))]
fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

/// Pure, testable search logic — no filesystem or process side effects.
///
/// Resolution order respects the user's configured PATH first, then falls
/// back to progressively more expensive probes:
///
/// 1. Process PATH (cheap — honours shims, asdf, mise, Nix profiles, etc.)
/// 2. Login shell PATH (deferred — only runs if #1 missed, handles GUI launch)
/// 3. Well-known install locations (static fallback paths)
/// 4. Bare `"claude"` (absolute last resort)
///
/// All PATH searches skip non-absolute entries to prevent repo-local execution.
/// The `shell_path_probe` closure is called lazily so we don't pay the
/// shell-spawn cost when the process PATH already found claude.
fn resolve_claude_path_inner(
    home: Option<PathBuf>,
    process_path: Option<OsString>,
    shell_path_probe: impl FnOnce() -> Option<OsString>,
    exists: impl Fn(&Path) -> bool,
) -> OsString {
    // 1. Search the process PATH first. This respects the user's configured
    //    environment, including shims (asdf, mise, Nix, pnpm, etc.).
    //    Skip non-absolute entries (e.g. "." or "") to avoid resolving a
    //    repo-local `claude` binary relative to the working directory.
    if let Some(process_path) = process_path
        && let Some(found) = search_path_dirs(&process_path, &exists)
    {
        return found;
    }

    // 2. Probe the login shell's PATH. GUI-launched apps on macOS don't
    //    inherit the user's shell PATH, so this catches the common case
    //    where process PATH is empty/minimal. Deferred to here so we don't
    //    pay the shell-spawn cost when process PATH already found claude.
    if let Some(shell_path) = shell_path_probe()
        && let Some(found) = search_path_dirs(&shell_path, &exists)
    {
        return found;
    }

    // 3. Well-known install locations as static fallbacks.
    let mut fallback_candidates: Vec<PathBuf> = Vec::new();
    if let Some(ref home) = home {
        fallback_candidates.extend([
            home.join(".local/bin/claude"),
            home.join(".claude/local/claude"),
            home.join(".nix-profile/bin/claude"), // Nix single-user
        ]);
    }
    fallback_candidates.extend([
        PathBuf::from("/usr/local/bin/claude"),
        PathBuf::from("/opt/homebrew/bin/claude"), // macOS Homebrew
        PathBuf::from("/run/current-system/sw/bin/claude"), // NixOS system
        PathBuf::from("/nix/var/nix/profiles/default/bin/claude"), // Nix multi-user
    ]);
    for p in &fallback_candidates {
        if exists(p) {
            return p.clone().into_os_string();
        }
    }

    // 4. Nothing found — bare name as absolute last resort.
    OsString::from("claude")
}

/// Search colon-separated PATH directories for a `claude` binary.
/// Skips non-absolute entries to prevent repo-local execution.
fn search_path_dirs(path: &std::ffi::OsStr, exists: &impl Fn(&Path) -> bool) -> Option<OsString> {
    for dir in std::env::split_paths(path) {
        if !dir.is_absolute() {
            continue;
        }
        let candidate = dir.join("claude");
        if exists(&candidate) {
            return Some(candidate.into_os_string());
        }
    }
    None
}

/// Get the PATH as seen by the user's login shell.
///
/// Delegates to the shared `crate::env::shell_path()` which probes the
/// login shell once and caches the result for the process lifetime.
fn login_shell_path() -> Option<OsString> {
    crate::env::shell_path().cloned()
}

/// Run a single agent turn by spawning `claude -p` with the given prompt.
///
/// For the first turn, uses `--session-id` to establish the session.
/// For subsequent turns, uses `--resume` to continue the conversation.
///
/// `allowed_tools` pre-approves tools so they run without interactive
/// permission prompts (e.g. `["Bash", "Read", "Edit"]`).
#[allow(clippy::too_many_arguments)]
pub async fn run_turn(
    working_dir: &Path,
    session_id: &str,
    prompt: &str,
    is_resume: bool,
    allowed_tools: &[String],
    custom_instructions: Option<&str>,
    settings: &AgentSettings,
    attachments: &[ImageAttachment],
    ws_env: Option<&WorkspaceEnv>,
) -> Result<TurnHandle, String> {
    let has_attachments = !attachments.is_empty();
    let args = build_claude_args(
        session_id,
        prompt,
        is_resume,
        allowed_tools,
        custom_instructions,
        settings,
        has_attachments,
    );

    let claude_path = resolve_claude_path().await;
    let mut cmd = Command::new(&claude_path);
    cmd.args(&args)
        .current_dir(working_dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .env("PATH", crate::env::enriched_path());

    if has_attachments {
        cmd.stdin(std::process::Stdio::piped());
    } else {
        cmd.stdin(std::process::Stdio::null());
    }

    // Strip OAuth tokens inherited from a parent Claude Code session — these
    // use the sk-ant-oat* prefix and are not valid for subprocess API calls.
    // Preserve real API keys (sk-ant-api*) so users who authenticate that way
    // continue to work.
    if let Ok(key) = std::env::var("ANTHROPIC_API_KEY")
        && !key.starts_with("sk-ant-api")
    {
        cmd.env_remove("ANTHROPIC_API_KEY");
    }
    cmd.env_remove("CLAUDECODE");
    cmd.env_remove("CLAUDE_CODE_ENTRYPOINT");

    if let Some(env) = ws_env {
        env.apply(&mut cmd);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn claude at {:?}: {e}", claude_path))?;

    let pid = child
        .id()
        .ok_or_else(|| "Process exited immediately".to_string())?;

    // When images are present, pipe the prompt + image content blocks to stdin
    // as a stream-json SDKUserMessage, then close stdin to signal EOF.
    if has_attachments && let Some(mut stdin) = child.stdin.take() {
        use tokio::io::AsyncWriteExt;
        let payload = build_stdin_message(prompt, attachments);
        stdin
            .write_all(payload.as_bytes())
            .await
            .map_err(|e| format!("Failed to write image data to stdin: {e}"))?;
        stdin
            .write_all(b"\n")
            .await
            .map_err(|e| format!("Failed to write stdin newline: {e}"))?;
        // Drop closes the pipe, signalling EOF to the child.
        drop(stdin);
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture stderr".to_string())?;

    let (event_tx, event_rx) = mpsc::channel::<AgentEvent>(128);

    // Stdout reader task — parse stream-json events
    let tx_stdout = event_tx.clone();
    tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            match parse_stream_line(&line) {
                Ok(event) => {
                    if tx_stdout.send(AgentEvent::Stream(event)).await.is_err() {
                        break;
                    }
                }
                Err(e) => {
                    eprintln!("Failed to parse stream event: {e}\nLine: {line}");
                }
            }
        }
    });

    // Stderr reader task — log stderr lines
    tokio::spawn(async move {
        let reader = BufReader::new(stderr);
        let mut lines = reader.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if !line.trim().is_empty() {
                eprintln!("[agent stderr] {line}");
            }
        }
    });

    // Process exit watcher — sends ProcessExited when the child terminates
    let tx_exit = event_tx;
    tokio::spawn(async move {
        let status = child.wait().await.ok().and_then(|s| s.code());
        let _ = tx_exit.send(AgentEvent::ProcessExited(status)).await;
    });

    Ok(TurnHandle { event_rx, pid })
}

/// Stop an agent process by killing it.
pub async fn stop_agent(pid: u32) -> Result<(), String> {
    let output = tokio::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .output()
        .await
        .map_err(|e| format!("Failed to kill agent: {e}"))?;

    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "kill failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ))
    }
}

/// Gracefully stop an agent process (SIGTERM → wait → SIGKILL).
///
/// Sends SIGTERM first and allows up to 500 ms for the process to exit.
/// Falls back to SIGKILL if the deadline expires. Suitable for tearing
/// down idle persistent sessions at turn boundaries where we don't need
/// an instant kill.
pub async fn stop_agent_graceful(pid: u32) -> Result<(), String> {
    // Send SIGTERM for graceful shutdown.
    let _ = tokio::process::Command::new("kill")
        .args(["-15", &pid.to_string()])
        .output()
        .await;

    // Poll for up to 500 ms.
    for _ in 0..10 {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let probe = tokio::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .output()
            .await;
        if probe.is_ok_and(|o| !o.status.success()) {
            return Ok(());
        }
    }

    // Escalate to SIGKILL.
    stop_agent(pid).await
}

// ---------------------------------------------------------------------------
// Persistent session — long-lived process for multi-turn MCP retention
// ---------------------------------------------------------------------------

/// A persistent Claude CLI process that stays alive across turns.
///
/// Instead of spawning a new `claude --print` per turn (which kills MCP server
/// subprocesses), this keeps a single process alive and sends turns via stdin
/// using `--input-format stream-json`. MCP servers and their state (e.g.
/// playwright browser) persist for the session lifetime.
pub struct PersistentSession {
    pid: u32,
    stdin: tokio::sync::Mutex<tokio::process::ChildStdin>,
    event_tx: tokio::sync::broadcast::Sender<AgentEvent>,
}

impl PersistentSession {
    /// Start a new persistent session process.
    ///
    /// The process is spawned with `--input-format stream-json` and no prompt
    /// argument. Turns are sent via [`send_turn`] which writes `SDKUserMessage`
    /// lines to stdin.
    #[allow(clippy::too_many_arguments)]
    pub async fn start(
        working_dir: &Path,
        session_id: &str,
        is_resume: bool,
        allowed_tools: &[String],
        custom_instructions: Option<&str>,
        settings: &AgentSettings,
        ws_env: Option<&WorkspaceEnv>,
    ) -> Result<Self, String> {
        let args = build_persistent_args(
            session_id,
            is_resume,
            allowed_tools,
            custom_instructions,
            settings,
        );

        let claude_path = resolve_claude_path().await;
        let mut cmd = Command::new(&claude_path);
        cmd.args(&args)
            .current_dir(working_dir)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .env("PATH", crate::env::enriched_path());

        // Strip OAuth tokens (same as run_turn).
        if let Ok(key) = std::env::var("ANTHROPIC_API_KEY")
            && !key.starts_with("sk-ant-api")
        {
            cmd.env_remove("ANTHROPIC_API_KEY");
        }
        cmd.env_remove("CLAUDECODE");
        cmd.env_remove("CLAUDE_CODE_ENTRYPOINT");

        if let Some(env) = ws_env {
            env.apply(&mut cmd);
        }

        let mut child = cmd.spawn().map_err(|e| {
            format!(
                "Failed to spawn persistent session at {:?}: {e}",
                claude_path
            )
        })?;

        let pid = child
            .id()
            .ok_or_else(|| "Process exited immediately".to_string())?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Failed to capture stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Failed to capture stdout".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Failed to capture stderr".to_string())?;

        let (event_tx, _) = tokio::sync::broadcast::channel::<AgentEvent>(2048);

        // Background stdout reader — runs for the session lifetime.
        let tx = event_tx.clone();
        tokio::spawn(async move {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                match parse_stream_line(&line) {
                    Ok(event) => {
                        let _ = tx.send(AgentEvent::Stream(event));
                    }
                    Err(e) => {
                        eprintln!("[persistent] Failed to parse: {e}\nLine: {line}");
                    }
                }
            }
        });

        // Background stderr reader.
        tokio::spawn(async move {
            let reader = BufReader::new(stderr);
            let mut lines = reader.lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if !line.trim().is_empty() {
                    eprintln!("[persistent stderr] {line}");
                }
            }
        });

        // Process exit watcher — broadcasts ProcessExited when the child dies.
        // Owns the child handle; the process stays alive until it exits naturally
        // (stdin closed) or is killed via stop_agent(pid).
        let tx_exit = event_tx.clone();
        tokio::spawn(async move {
            let status = child.wait().await.ok().and_then(|s| s.code());
            let _ = tx_exit.send(AgentEvent::ProcessExited(status));
        });

        Ok(Self {
            pid,
            stdin: tokio::sync::Mutex::new(stdin),
            event_tx,
        })
    }

    /// Send a turn's prompt and return a handle for receiving that turn's events.
    ///
    /// The returned `TurnHandle` receives events until a `Result` event (turn
    /// complete) or `ProcessExited` (session died).
    /// Send a new turn to the persistent process via stdin.
    ///
    /// # Single-turn invariant
    ///
    /// Only one turn may be in flight at a time. The CLI serializes turns
    /// internally via `--input-format stream-json`, and the Tauri command
    /// layer checks `agent_status == Running` before allowing a new send.
    /// The returned `TurnHandle` forwards events until the first `Result`
    /// event, which marks the turn as complete.
    pub async fn send_turn(
        &self,
        prompt: &str,
        attachments: &[ImageAttachment],
    ) -> Result<TurnHandle, String> {
        use tokio::io::AsyncWriteExt;

        // Subscribe BEFORE writing to stdin to avoid a race where a fast turn
        // emits events before the receiver exists (broadcast doesn't replay).
        let mut broadcast_rx = self.event_tx.subscribe();

        let message = build_stdin_message(prompt, attachments);
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(message.as_bytes())
            .await
            .map_err(|e| format!("Failed to write to persistent session: {e}"))?;
        stdin
            .write_all(b"\n")
            .await
            .map_err(|e| format!("Failed to write newline: {e}"))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("Failed to flush stdin: {e}"))?;
        drop(stdin); // Release lock so other code can check process state.
        let (mpsc_tx, mpsc_rx) = mpsc::channel::<AgentEvent>(128);
        tokio::spawn(async move {
            loop {
                match broadcast_rx.recv().await {
                    Ok(event) => {
                        let is_turn_end =
                            matches!(&event, AgentEvent::Stream(StreamEvent::Result { .. }));
                        let is_process_exit = matches!(&event, AgentEvent::ProcessExited(_));
                        // Forward to per-turn channel.
                        if mpsc_tx.send(event).await.is_err() {
                            break;
                        }
                        if is_turn_end || is_process_exit {
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        eprintln!("[persistent] Broadcast lagged by {n} events");
                    }
                }
            }
        });

        Ok(TurnHandle {
            event_rx: mpsc_rx,
            pid: self.pid,
        })
    }

    /// Write a `control_response` line to the CLI's stdin, answering a
    /// prior `control_request: can_use_tool`. The inner `response` value is
    /// either a permission-allow (`{ behavior: "allow", updatedInput }`) or
    /// a permission-deny (`{ behavior: "deny", message }`); see
    /// `PermissionPromptToolResultSchema` in the upstream CLI.
    pub async fn send_control_response(
        &self,
        request_id: &str,
        response: serde_json::Value,
    ) -> Result<(), String> {
        use tokio::io::AsyncWriteExt;
        let message = serde_json::json!({
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": request_id,
                "response": response,
            },
        })
        .to_string();
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(message.as_bytes())
            .await
            .map_err(|e| format!("Failed to write control_response: {e}"))?;
        stdin
            .write_all(b"\n")
            .await
            .map_err(|e| format!("Failed to write control_response newline: {e}"))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("Failed to flush control_response: {e}"))?;
        Ok(())
    }

    /// Get the process ID.
    pub fn pid(&self) -> u32 {
        self.pid
    }
}

/// Build CLI arguments for a persistent session (no prompt, with `--input-format stream-json`).
///
/// When `is_resume` is true, uses `--resume` to restore conversation history
/// from a prior session. Otherwise uses `--session-id` for a fresh session.
fn build_persistent_args(
    session_id: &str,
    is_resume: bool,
    allowed_tools: &[String],
    custom_instructions: Option<&str>,
    settings: &AgentSettings,
) -> Vec<String> {
    let mut args = vec![
        "--print".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--input-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
        "--include-partial-messages".to_string(),
        // See build_claude_args for rationale.
        "--permission-prompt-tool".to_string(),
        "stdio".to_string(),
    ];

    let bypass_permissions = allowed_tools.len() == 1 && allowed_tools[0] == "*";

    if is_resume {
        args.push("--resume".to_string());
    } else {
        args.push("--session-id".to_string());
    }
    args.push(session_id.to_string());

    // Model is session-level — only set on fresh sessions, not resumes.
    if !is_resume && let Some(ref model) = settings.model {
        args.push("--model".to_string());
        args.push(model.clone());
    }

    if settings.chrome_enabled {
        args.push("--chrome".to_string());
    }

    if let Some(ref mcp_json) = settings.mcp_config {
        args.push("--mcp-config".to_string());
        args.push(mcp_json.clone());
    }

    if settings.plan_mode {
        args.push("--permission-mode".to_string());
        args.push("plan".to_string());
    } else if bypass_permissions {
        args.push("--permission-mode".to_string());
        args.push("bypassPermissions".to_string());
    }

    if settings.fast_mode || settings.thinking_enabled {
        let mut obj = serde_json::Map::new();
        if settings.fast_mode {
            obj.insert("fastMode".to_string(), serde_json::Value::Bool(true));
        }
        if settings.thinking_enabled {
            obj.insert(
                "alwaysThinkingEnabled".to_string(),
                serde_json::Value::Bool(true),
            );
        }
        args.push("--settings".to_string());
        args.push(serde_json::Value::Object(obj).to_string());
    }

    if let Some(ref effort) = settings.effort {
        args.push("--effort".to_string());
        args.push(effort.clone());
    }

    if !bypass_permissions && !allowed_tools.is_empty() {
        args.push("--allowedTools".to_string());
        args.push(allowed_tools.join(","));
    }

    // System prompt is session-level — only set on fresh sessions, not resumes.
    if !is_resume
        && let Some(instructions) = custom_instructions
        && !instructions.trim().is_empty()
    {
        args.push("--append-system-prompt".to_string());
        args.push(instructions.to_string());
    }

    // No prompt argument — prompts come via stdin as SDKUserMessage.

    args
}

// ---------------------------------------------------------------------------
// Branch name generation via Haiku
// ---------------------------------------------------------------------------

/// Sanitize a string into a valid git branch slug: lowercase ASCII
/// alphanumeric + hyphens, no leading/trailing hyphens, max `max_len` chars.
pub fn sanitize_branch_name(raw: &str, max_len: usize) -> String {
    let slug: String = raw
        .to_ascii_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();

    // Collapse consecutive hyphens.
    let mut collapsed = String::with_capacity(slug.len());
    let mut prev_hyphen = false;
    for c in slug.chars() {
        if c == '-' {
            if !prev_hyphen {
                collapsed.push(c);
            }
            prev_hyphen = true;
        } else {
            collapsed.push(c);
            prev_hyphen = false;
        }
    }

    // Trim leading/trailing hyphens, truncate.
    let trimmed = collapsed.trim_matches('-');
    if trimmed.len() <= max_len {
        return trimmed.to_string();
    }
    // Truncate at `max_len` and drop any trailing hyphens introduced by the cut.
    let truncated = &trimmed[..max_len];
    truncated.trim_end_matches('-').to_string()
}

/// Call Claude Haiku to generate a short branch name slug from the user's
/// first prompt. Returns a sanitized branch slug (e.g. `fix-login-timeout`).
/// `worktree_path` sets the subprocess CWD so the CLI picks up the correct
/// project context (CLAUDE.md) for the user's workspace — not Claudette's own.
pub async fn generate_branch_name(
    prompt_text: &str,
    worktree_path: &str,
    branch_rename_preferences: Option<&str>,
    ws_env: Option<&WorkspaceEnv>,
) -> Result<String, String> {
    // Truncate prompt to keep the Haiku call fast and cheap.
    let truncated: String = prompt_text.chars().take(200).collect();

    let claude_path = resolve_claude_path().await;
    let mut cmd = Command::new(&claude_path);
    cmd.stdin(std::process::Stdio::null())
        .env("PATH", crate::env::enriched_path());
    // Run in the user's worktree so the CLI loads *their* project context.
    cmd.current_dir(worktree_path);
    let user_message = format!(
        "Generate a short git branch name slug for the following task. \
         Output ONLY the slug — no explanation, no markdown, no quotes. \
         Lowercase letters, numbers, and hyphens only. Max 30 chars.\n\n\
         Task: {truncated}"
    );
    let mut system_prompt =
        "You are a branch name generator. Output ONLY a slug. Never answer the task itself."
            .to_string();
    if let Some(prefs) = branch_rename_preferences {
        let prefs_truncated: String = prefs.chars().take(500).collect();
        system_prompt.push_str(&format!(
            "\n\nThe user has provided the following branch naming preferences. \
             Prioritize these over your default behavior:\n{prefs_truncated}"
        ));
    }
    cmd.args([
        "--print",
        "--output-format",
        "text",
        "--model",
        "claude-haiku-4-5",
        "--append-system-prompt",
        &system_prompt,
        &user_message,
    ]);

    // Strip env vars that interfere with subprocess auth — same as run_turn.
    if let Ok(key) = std::env::var("ANTHROPIC_API_KEY")
        && !key.starts_with("sk-ant-api")
    {
        cmd.env_remove("ANTHROPIC_API_KEY");
    }
    cmd.env_remove("CLAUDECODE");
    cmd.env_remove("CLAUDE_CODE_ENTRYPOINT");

    if let Some(env) = ws_env {
        env.apply(&mut cmd);
    }

    let output = cmd.output().await.map_err(|e| {
        format!(
            "Failed to spawn claude at {:?} for branch name: {e}",
            claude_path
        )
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Haiku branch name call failed: {stderr}"));
    }

    let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let slug = sanitize_branch_name(&raw, 30);
    if slug.is_empty() {
        return Err(format!(
            "Haiku returned empty or unsanitizable output: {raw:?}"
        ));
    }
    Ok(slug)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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
        let line = r#"{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{}}}"#;
        let event = parse_stream_line(line).unwrap();
        match event {
            StreamEvent::Stream { event } => {
                assert!(matches!(event, InnerStreamEvent::MessageDelta {}));
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
            StreamEvent::User { message } => {
                assert_eq!(message.content.len(), 1);
                match &message.content[0] {
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
    fn test_build_args_first_turn_no_tools() {
        let args = build_claude_args(
            "sess-1",
            "hello",
            false,
            &[],
            None,
            &AgentSettings::default(),
            false,
        );
        assert!(args.contains(&"--print".to_string()));
        assert!(args.contains(&"--session-id".to_string()));
        assert!(args.contains(&"sess-1".to_string()));
        assert!(args.last() == Some(&"hello".to_string()));
        assert!(!args.contains(&"--allowedTools".to_string()));
        assert!(!args.contains(&"--resume".to_string()));
        assert!(!args.contains(&"--append-system-prompt".to_string()));
    }

    #[test]
    fn test_build_args_resume() {
        let args = build_claude_args(
            "sess-1",
            "continue",
            true,
            &[],
            None,
            &AgentSettings::default(),
            false,
        );
        assert!(args.contains(&"--resume".to_string()));
        assert!(!args.contains(&"--session-id".to_string()));
    }

    #[test]
    fn test_build_args_with_allowed_tools() {
        let tools = vec!["Bash".to_string(), "Read".to_string(), "Edit".to_string()];
        let args = build_claude_args(
            "sess-1",
            "hello",
            false,
            &tools,
            None,
            &AgentSettings::default(),
            false,
        );
        let idx = args.iter().position(|a| a == "--allowedTools").unwrap();
        assert_eq!(args[idx + 1], "Bash,Read,Edit");
    }

    #[test]
    fn test_build_args_with_custom_instructions() {
        let args = build_claude_args(
            "sess-1",
            "hello",
            false,
            &[],
            Some("Always use TypeScript"),
            &AgentSettings::default(),
            false,
        );
        let idx = args
            .iter()
            .position(|a| a == "--append-system-prompt")
            .unwrap();
        assert_eq!(args[idx + 1], "Always use TypeScript");
    }

    #[test]
    fn test_build_args_empty_instructions_skipped() {
        let args = build_claude_args(
            "sess-1",
            "hello",
            false,
            &[],
            Some(""),
            &AgentSettings::default(),
            false,
        );
        assert!(!args.contains(&"--append-system-prompt".to_string()));
    }

    #[test]
    fn test_build_args_whitespace_instructions_skipped() {
        let args = build_claude_args(
            "sess-1",
            "hello",
            false,
            &[],
            Some("   "),
            &AgentSettings::default(),
            false,
        );
        assert!(!args.contains(&"--append-system-prompt".to_string()));
    }

    #[test]
    fn test_build_args_resume_skips_instructions() {
        let args = build_claude_args(
            "sess-1",
            "hello",
            true,
            &[],
            Some("Always use TypeScript"),
            &AgentSettings::default(),
            false,
        );
        assert!(!args.contains(&"--append-system-prompt".to_string()));
        assert!(args.contains(&"--resume".to_string()));
    }

    #[test]
    fn test_build_args_with_model() {
        let settings = AgentSettings {
            model: Some("opus".to_string()),
            ..Default::default()
        };
        let args = build_claude_args("sess-1", "hello", false, &[], None, &settings, false);
        let idx = args.iter().position(|a| a == "--model").unwrap();
        assert_eq!(args[idx + 1], "opus");
    }

    #[test]
    fn test_build_args_model_skipped_on_resume() {
        let settings = AgentSettings {
            model: Some("opus".to_string()),
            ..Default::default()
        };
        let args = build_claude_args("sess-1", "hello", true, &[], None, &settings, false);
        assert!(!args.contains(&"--model".to_string()));
    }

    #[test]
    fn test_build_args_plan_mode() {
        let settings = AgentSettings {
            plan_mode: true,
            ..Default::default()
        };
        let args = build_claude_args("sess-1", "hello", false, &[], None, &settings, false);
        let idx = args.iter().position(|a| a == "--permission-mode").unwrap();
        assert_eq!(args[idx + 1], "plan");
    }

    #[test]
    fn test_build_args_plan_mode_set_on_resume() {
        let settings = AgentSettings {
            plan_mode: true,
            ..Default::default()
        };
        let args = build_claude_args("sess-1", "hello", true, &[], None, &settings, false);
        // Permission mode must be set on every turn (per-process flag)
        let idx = args.iter().position(|a| a == "--permission-mode").unwrap();
        assert_eq!(args[idx + 1], "plan");
    }

    #[test]
    fn test_build_args_with_settings_json() {
        let settings = AgentSettings {
            fast_mode: true,
            thinking_enabled: true,
            ..Default::default()
        };
        let args = build_claude_args("sess-1", "hello", false, &[], None, &settings, false);
        let idx = args.iter().position(|a| a == "--settings").unwrap();
        let json: serde_json::Value = serde_json::from_str(&args[idx + 1]).unwrap();
        assert_eq!(json["fastMode"], true);
        assert_eq!(json["alwaysThinkingEnabled"], true);
    }

    #[test]
    fn test_build_args_fast_mode_only() {
        let settings = AgentSettings {
            fast_mode: true,
            ..Default::default()
        };
        let args = build_claude_args("sess-1", "hello", false, &[], None, &settings, false);
        let idx = args.iter().position(|a| a == "--settings").unwrap();
        let json: serde_json::Value = serde_json::from_str(&args[idx + 1]).unwrap();
        assert_eq!(json["fastMode"], true);
        assert!(json.get("alwaysThinkingEnabled").is_none());
    }

    #[test]
    fn test_build_args_settings_on_resume() {
        let settings = AgentSettings {
            fast_mode: true,
            thinking_enabled: true,
            ..Default::default()
        };
        // --settings should still be passed on resume (per-turn flag)
        let args = build_claude_args("sess-1", "hello", true, &[], None, &settings, false);
        assert!(args.contains(&"--settings".to_string()));
    }

    #[test]
    fn test_build_args_bypass_permissions_first_turn() {
        let tools = vec!["*".to_string()];
        let args = build_claude_args(
            "sess-1",
            "hello",
            false,
            &tools,
            None,
            &AgentSettings::default(),
            false,
        );
        // Should set permission-mode to bypassPermissions on first turn
        let pm_idx = args.iter().position(|a| a == "--permission-mode").unwrap();
        assert_eq!(args[pm_idx + 1], "bypassPermissions");
        // bypassPermissions should NOT pass --allowedTools (it interferes with the mode)
        assert!(!args.contains(&"--allowedTools".to_string()));
    }

    #[test]
    fn test_build_args_bypass_permissions_resume() {
        let tools = vec!["*".to_string()];
        let args = build_claude_args(
            "sess-1",
            "hello",
            true,
            &tools,
            None,
            &AgentSettings::default(),
            false,
        );
        // Permission mode must be set on every turn (per-process flag)
        let pm_idx = args.iter().position(|a| a == "--permission-mode").unwrap();
        assert_eq!(args[pm_idx + 1], "bypassPermissions");
        // bypassPermissions should NOT pass --allowedTools
        assert!(!args.contains(&"--allowedTools".to_string()));
    }

    #[test]
    fn test_build_args_bypass_permissions_with_plan_mode() {
        let tools = vec!["*".to_string()];
        let settings = AgentSettings {
            plan_mode: true,
            ..Default::default()
        };
        let args = build_claude_args("sess-1", "hello", false, &tools, None, &settings, false);
        // Plan mode takes precedence over bypass
        let pm_idx = args.iter().position(|a| a == "--permission-mode").unwrap();
        assert_eq!(args[pm_idx + 1], "plan");
        // Even with plan_mode, bypass tools should NOT pass --allowedTools
        assert!(!args.contains(&"--allowedTools".to_string()));
    }

    // --- Branch name sanitization tests ---

    #[test]
    fn test_sanitize_simple_slug() {
        assert_eq!(sanitize_branch_name("fix-login-bug", 40), "fix-login-bug");
    }

    #[test]
    fn test_sanitize_uppercase_and_spaces() {
        assert_eq!(
            sanitize_branch_name("Fix Login Timeout", 40),
            "fix-login-timeout"
        );
    }

    #[test]
    fn test_sanitize_special_characters() {
        assert_eq!(
            sanitize_branch_name("add CSV export!!", 40),
            "add-csv-export"
        );
    }

    #[test]
    fn test_sanitize_consecutive_hyphens() {
        assert_eq!(
            sanitize_branch_name("fix---multiple---hyphens", 40),
            "fix-multiple-hyphens"
        );
    }

    #[test]
    fn test_sanitize_leading_trailing_hyphens() {
        assert_eq!(
            sanitize_branch_name("--leading-and-trailing--", 40),
            "leading-and-trailing"
        );
    }

    #[test]
    fn test_sanitize_truncation() {
        let long_input = "this-is-a-very-long-branch-name-that-exceeds-the-limit";
        let result = sanitize_branch_name(long_input, 20);
        assert!(result.len() <= 20);
        assert!(!result.ends_with('-'));
    }

    #[test]
    fn test_sanitize_empty_input() {
        assert_eq!(sanitize_branch_name("", 40), "");
    }

    #[test]
    fn test_sanitize_all_special_chars() {
        assert_eq!(sanitize_branch_name("!@#$%", 40), "");
    }

    #[test]
    fn test_sanitize_preserves_numbers() {
        assert_eq!(sanitize_branch_name("fix-issue-42", 40), "fix-issue-42");
    }

    #[test]
    fn test_build_args_with_effort() {
        let settings = AgentSettings {
            effort: Some("high".to_string()),
            ..Default::default()
        };
        let args = build_claude_args("sess-1", "hello", false, &[], None, &settings, false);
        let idx = args.iter().position(|a| a == "--effort").unwrap();
        assert_eq!(args[idx + 1], "high");
    }

    #[test]
    fn test_build_args_with_effort_xhigh() {
        let settings = AgentSettings {
            effort: Some("xhigh".to_string()),
            ..Default::default()
        };
        let args = build_claude_args("sess-1", "hello", false, &[], None, &settings, false);
        let idx = args.iter().position(|a| a == "--effort").unwrap();
        assert_eq!(args[idx + 1], "xhigh");
    }

    #[test]
    fn test_build_args_effort_none_omitted() {
        let args = build_claude_args(
            "sess-1",
            "hello",
            false,
            &[],
            None,
            &AgentSettings::default(),
            false,
        );
        assert!(!args.contains(&"--effort".to_string()));
    }

    #[test]
    fn test_build_args_effort_auto_omitted() {
        let settings = AgentSettings {
            effort: Some("auto".to_string()),
            ..Default::default()
        };
        let args = build_claude_args("sess-1", "hello", false, &[], None, &settings, false);
        // "auto" means let the CLI use its default — don't pass --effort
        assert!(!args.contains(&"--effort".to_string()));
    }

    #[test]
    fn test_build_args_effort_on_resume() {
        let settings = AgentSettings {
            effort: Some("low".to_string()),
            ..Default::default()
        };
        let args = build_claude_args("sess-1", "hello", true, &[], None, &settings, false);
        let idx = args.iter().position(|a| a == "--effort").unwrap();
        assert_eq!(args[idx + 1], "low");
    }

    #[test]
    fn test_build_args_effort_with_other_settings() {
        let settings = AgentSettings {
            fast_mode: true,
            thinking_enabled: true,
            effort: Some("max".to_string()),
            ..Default::default()
        };
        let args = build_claude_args("sess-1", "hello", false, &[], None, &settings, false);
        // --effort is a standalone flag, separate from --settings JSON
        let effort_idx = args.iter().position(|a| a == "--effort").unwrap();
        assert_eq!(args[effort_idx + 1], "max");
        let settings_idx = args.iter().position(|a| a == "--settings").unwrap();
        let json: serde_json::Value = serde_json::from_str(&args[settings_idx + 1]).unwrap();
        assert_eq!(json["fastMode"], true);
        assert_eq!(json["alwaysThinkingEnabled"], true);
        // effort should NOT be in the --settings JSON
        assert!(json.get("effort").is_none());
    }

    #[test]
    fn test_build_args_with_chrome() {
        let settings = AgentSettings {
            chrome_enabled: true,
            ..Default::default()
        };
        let args = build_claude_args("sess-1", "hello", false, &[], None, &settings, false);
        assert!(args.contains(&"--chrome".to_string()));
    }

    #[test]
    fn test_build_args_chrome_skipped_on_resume() {
        let settings = AgentSettings {
            chrome_enabled: true,
            ..Default::default()
        };
        let args = build_claude_args("sess-1", "hello", true, &[], None, &settings, false);
        assert!(!args.contains(&"--chrome".to_string()));
    }

    #[test]
    fn test_build_args_with_mcp_config() {
        let settings = AgentSettings {
            mcp_config: Some(r#"{"mcpServers":{"s":{"type":"stdio","command":"x"}}}"#.to_string()),
            ..Default::default()
        };
        let args = build_claude_args("sess-1", "hello", false, &[], None, &settings, false);
        let idx = args.iter().position(|a| a == "--mcp-config").unwrap();
        assert!(args[idx + 1].contains("mcpServers"));
    }

    #[test]
    fn test_build_args_mcp_config_on_resume() {
        let settings = AgentSettings {
            mcp_config: Some(r#"{"mcpServers":{"s":{"type":"stdio","command":"x"}}}"#.to_string()),
            ..Default::default()
        };
        let args = build_claude_args("sess-1", "hello", true, &[], None, &settings, false);
        // MCP config must be passed on every turn (including resume)
        let idx = args.iter().position(|a| a == "--mcp-config").unwrap();
        assert!(args[idx + 1].contains("mcpServers"));
    }

    #[test]
    fn test_build_args_mcp_config_none_omitted() {
        let settings = AgentSettings::default();
        let args = build_claude_args("sess-1", "hello", false, &[], None, &settings, false);
        assert!(!args.contains(&"--mcp-config".to_string()));
    }

    // -----------------------------------------------------------------------
    // resolve_claude_path_inner tests
    // -----------------------------------------------------------------------

    // Helper: no shell probe (returns None).
    fn no_shell() -> Option<OsString> {
        None
    }

    #[test]
    fn test_resolve_process_path_wins() {
        // Process PATH is checked first and should win over everything.
        let home = PathBuf::from("/home/user");
        let result = resolve_claude_path_inner(
            Some(home.clone()),
            Some(OsString::from("/custom/bin")),
            no_shell,
            |p| {
                p == Path::new("/custom/bin/claude")
                    || p == home.join(".local/bin/claude")
                    || p == Path::new("/usr/local/bin/claude")
            },
        );
        assert_eq!(result, OsString::from("/custom/bin/claude"));
    }

    #[test]
    fn test_resolve_shell_path_before_well_known() {
        // When process PATH misses, shell probe runs before well-known paths.
        let shell_path = OsString::from("/shell/bin");
        let result = resolve_claude_path_inner(
            None,
            None, // empty process PATH
            || Some(shell_path),
            |p| p == Path::new("/shell/bin/claude") || p == Path::new("/usr/local/bin/claude"),
        );
        assert_eq!(result, OsString::from("/shell/bin/claude"));
    }

    #[test]
    fn test_resolve_shell_probe_deferred() {
        // Shell probe should NOT run if process PATH already found claude.
        let probed = std::sync::atomic::AtomicBool::new(false);
        let result = resolve_claude_path_inner(
            None,
            Some(OsString::from("/good/bin")),
            || {
                probed.store(true, std::sync::atomic::Ordering::SeqCst);
                Some(OsString::from("/shell/bin"))
            },
            |p| p == Path::new("/good/bin/claude") || p == Path::new("/shell/bin/claude"),
        );
        assert_eq!(result, OsString::from("/good/bin/claude"));
        assert!(!probed.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[test]
    fn test_resolve_falls_back_to_well_known_home() {
        let home = PathBuf::from("/home/user");
        let expected = home.join(".local/bin/claude");
        let result = resolve_claude_path_inner(Some(home), None, no_shell, |p| p == expected);
        assert_eq!(result, expected.into_os_string());
    }

    #[test]
    fn test_resolve_falls_back_to_claude_local() {
        let home = PathBuf::from("/home/user");
        let expected = home.join(".claude/local/claude");
        let result = resolve_claude_path_inner(Some(home), None, no_shell, |p| p == expected);
        assert_eq!(result, expected.into_os_string());
    }

    #[test]
    fn test_resolve_falls_back_to_system() {
        let result = resolve_claude_path_inner(None, None, no_shell, |p| {
            p == Path::new("/usr/local/bin/claude")
        });
        assert_eq!(result, OsString::from("/usr/local/bin/claude"));
    }

    #[test]
    fn test_resolve_falls_back_to_homebrew() {
        let result = resolve_claude_path_inner(None, None, no_shell, |p| {
            p == Path::new("/opt/homebrew/bin/claude")
        });
        assert_eq!(result, OsString::from("/opt/homebrew/bin/claude"));
    }

    #[test]
    fn test_resolve_finds_nix_profile() {
        let home = PathBuf::from("/home/user");
        let expected = home.join(".nix-profile/bin/claude");
        let result = resolve_claude_path_inner(Some(home), None, no_shell, |p| p == expected);
        assert_eq!(result, expected.into_os_string());
    }

    #[test]
    fn test_resolve_finds_nixos_system() {
        let result = resolve_claude_path_inner(None, None, no_shell, |p| {
            p == Path::new("/run/current-system/sw/bin/claude")
        });
        assert_eq!(result, OsString::from("/run/current-system/sw/bin/claude"));
    }

    #[test]
    fn test_resolve_home_before_system_in_fallbacks() {
        // Within the well-known fallbacks, home paths are checked before system.
        let home = PathBuf::from("/home/user");
        let home_path = home.join(".local/bin/claude");
        let result = resolve_claude_path_inner(Some(home), None, no_shell, |p| {
            p == home_path || p == Path::new("/usr/local/bin/claude")
        });
        assert_eq!(result, home_path.into_os_string());
    }

    #[test]
    fn test_resolve_bare_fallback() {
        let result = resolve_claude_path_inner(None, None, no_shell, |_| false);
        assert_eq!(result, OsString::from("claude"));
    }

    #[test]
    fn test_resolve_skips_relative_in_process_path() {
        let result = resolve_claude_path_inner(
            None,
            Some(OsString::from(".:/relative/bin:/abs/bin")),
            no_shell,
            |p| {
                p == Path::new("./claude")
                    || p == Path::new("relative/bin/claude")
                    || p == Path::new("/abs/bin/claude")
            },
        );
        assert_eq!(result, OsString::from("/abs/bin/claude"));
    }

    #[test]
    fn test_resolve_skips_empty_path_entry() {
        let result =
            resolve_claude_path_inner(None, Some(OsString::from(":/good/bin:")), no_shell, |p| {
                p == Path::new("/good/bin/claude")
            });
        assert_eq!(result, OsString::from("/good/bin/claude"));
    }

    #[test]
    fn test_resolve_all_relative_falls_through_to_bare() {
        let result = resolve_claude_path_inner(
            None,
            Some(OsString::from(".:./bin:relative")),
            no_shell,
            |p| !p.is_absolute(),
        );
        assert_eq!(result, OsString::from("claude"));
    }

    #[test]
    fn test_search_path_dirs_skips_relative() {
        let path = OsString::from(".:/tmp/evil:/good/bin");
        let result = search_path_dirs(path.as_os_str(), &|p| {
            p == Path::new("/tmp/evil/claude") || p == Path::new("/good/bin/claude")
        });
        assert_eq!(result, Some(OsString::from("/tmp/evil/claude")));
    }

    #[test]
    fn test_search_path_dirs_returns_none_for_all_relative() {
        let path = OsString::from(".:relative:./bin");
        let result = search_path_dirs(path.as_os_str(), &|_| true);
        assert_eq!(result, None);
    }

    // --- build_claude_args attachment tests ---

    fn default_settings() -> AgentSettings {
        AgentSettings::default()
    }

    #[test]
    fn test_build_args_without_attachments_unchanged() {
        let args = build_claude_args(
            "sess-1",
            "hello world",
            false,
            &["Bash".into(), "Read".into()],
            None,
            &default_settings(),
            false,
        );
        // Prompt should be the last positional arg.
        assert_eq!(args.last().unwrap(), "hello world");
        // Should NOT have --input-format stream-json.
        assert!(!args.contains(&"--input-format".to_string()));
    }

    #[test]
    fn test_build_args_with_attachments_uses_stream_json() {
        let args = build_claude_args(
            "sess-1",
            "describe this image",
            false,
            &["Bash".into()],
            None,
            &default_settings(),
            true,
        );
        // Should have --input-format stream-json.
        let idx = args
            .iter()
            .position(|a| a == "--input-format")
            .expect("missing --input-format");
        assert_eq!(args[idx + 1], "stream-json");
        // Prompt should NOT be a positional arg.
        assert_ne!(args.last().unwrap(), "describe this image");
    }

    #[test]
    fn test_build_stdin_message_text_only() {
        let msg = build_stdin_message("hello", &[]);
        let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();
        assert_eq!(parsed["type"], "user");
        assert_eq!(parsed["parent_tool_use_id"], serde_json::Value::Null);
        let content = parsed["message"]["content"].as_array().unwrap();
        assert_eq!(content.len(), 1);
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[0]["text"], "hello");
    }

    #[test]
    fn test_build_stdin_message_empty_prompt_omits_text_block() {
        let attachments = vec![ImageAttachment {
            media_type: "image/png".into(),
            data_base64: "data".into(),
        }];
        let msg = build_stdin_message("", &attachments);
        let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();
        let content = parsed["message"]["content"].as_array().unwrap();
        // Should only have the image block, no empty text block.
        assert_eq!(content.len(), 1);
        assert_eq!(content[0]["type"], "image");
    }

    #[test]
    fn test_build_stdin_message_whitespace_prompt_omits_text_block() {
        let attachments = vec![ImageAttachment {
            media_type: "image/png".into(),
            data_base64: "data".into(),
        }];
        let msg = build_stdin_message("   ", &attachments);
        let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();
        let content = parsed["message"]["content"].as_array().unwrap();
        assert_eq!(content.len(), 1);
        assert_eq!(content[0]["type"], "image");
    }

    #[test]
    fn test_build_stdin_message_with_image() {
        let attachments = vec![ImageAttachment {
            media_type: "image/png".into(),
            data_base64: "iVBORw0KGgo=".into(),
        }];
        let msg = build_stdin_message("describe this", &attachments);
        let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();
        let content = parsed["message"]["content"].as_array().unwrap();
        assert_eq!(content.len(), 2);
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[0]["text"], "describe this");
        assert_eq!(content[1]["type"], "image");
        assert_eq!(content[1]["source"]["type"], "base64");
        assert_eq!(content[1]["source"]["media_type"], "image/png");
        assert_eq!(content[1]["source"]["data"], "iVBORw0KGgo=");
    }

    #[test]
    fn test_build_stdin_message_multiple_images() {
        let attachments = vec![
            ImageAttachment {
                media_type: "image/png".into(),
                data_base64: "png_data".into(),
            },
            ImageAttachment {
                media_type: "image/jpeg".into(),
                data_base64: "jpg_data".into(),
            },
            ImageAttachment {
                media_type: "image/webp".into(),
                data_base64: "webp_data".into(),
            },
        ];
        let msg = build_stdin_message("compare these", &attachments);
        let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();
        let content = parsed["message"]["content"].as_array().unwrap();
        assert_eq!(content.len(), 4); // 1 text + 3 images
        assert_eq!(content[1]["source"]["media_type"], "image/png");
        assert_eq!(content[2]["source"]["media_type"], "image/jpeg");
        assert_eq!(content[3]["source"]["media_type"], "image/webp");
    }

    #[test]
    fn test_build_stdin_message_pdf_uses_document_block() {
        let attachments = vec![ImageAttachment {
            media_type: "application/pdf".into(),
            data_base64: "JVBERi0xLjQ=".into(),
        }];
        let msg = build_stdin_message("review this doc", &attachments);
        let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();
        let content = parsed["message"]["content"].as_array().unwrap();
        assert_eq!(content.len(), 2);
        assert_eq!(content[0]["type"], "text");
        // PDFs must use "document" type, not "image".
        assert_eq!(content[1]["type"], "document");
        assert_eq!(content[1]["source"]["type"], "base64");
        assert_eq!(content[1]["source"]["media_type"], "application/pdf");
        assert_eq!(content[1]["source"]["data"], "JVBERi0xLjQ=");
    }

    #[test]
    fn test_build_stdin_message_mixed_images_and_pdf() {
        let attachments = vec![
            ImageAttachment {
                media_type: "image/png".into(),
                data_base64: "png_data".into(),
            },
            ImageAttachment {
                media_type: "application/pdf".into(),
                data_base64: "pdf_data".into(),
            },
        ];
        let msg = build_stdin_message("here are files", &attachments);
        let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap();
        let content = parsed["message"]["content"].as_array().unwrap();
        assert_eq!(content.len(), 3); // 1 text + 1 image + 1 document
        assert_eq!(content[1]["type"], "image");
        assert_eq!(content[2]["type"], "document");
    }

    // -- Persistent session args --

    #[test]
    fn test_build_persistent_args_includes_input_format() {
        let settings = AgentSettings::default();
        let args = build_persistent_args("sess-1", false, &[], None, &settings);
        assert!(args.contains(&"--input-format".to_string()));
        assert!(args.contains(&"stream-json".to_string()));
        assert!(args.contains(&"--session-id".to_string()));
        assert!(!args.contains(&"--resume".to_string()));
    }

    #[test]
    fn test_build_persistent_args_resume_mode() {
        let settings = AgentSettings::default();
        let args = build_persistent_args("old-session-id", true, &[], None, &settings);
        assert!(args.contains(&"--resume".to_string()));
        assert!(args.contains(&"old-session-id".to_string()));
        assert!(!args.contains(&"--session-id".to_string()));
    }

    #[test]
    fn test_build_persistent_args_includes_mcp_config() {
        let settings = AgentSettings {
            mcp_config: Some(r#"{"mcpServers":{"s":{"type":"stdio","command":"x"}}}"#.to_string()),
            ..Default::default()
        };
        let args = build_persistent_args("sess-1", false, &[], None, &settings);
        let idx = args.iter().position(|a| a == "--mcp-config").unwrap();
        assert!(args[idx + 1].contains("mcpServers"));
    }

    #[test]
    fn test_build_persistent_args_includes_model() {
        let settings = AgentSettings {
            model: Some("opus".to_string()),
            ..Default::default()
        };
        let args = build_persistent_args("sess-1", false, &[], None, &settings);
        let idx = args.iter().position(|a| a == "--model").unwrap();
        assert_eq!(args[idx + 1], "opus");
    }

    #[test]
    fn test_build_persistent_args_no_prompt_argument() {
        let settings = AgentSettings::default();
        let args = build_persistent_args("sess-1", false, &[], None, &settings);
        // The last arg should be either a flag or flag value, not a bare prompt.
        // Verify --print is present but no trailing prompt string.
        assert!(args.contains(&"--print".to_string()));
        assert!(args.contains(&"--output-format".to_string()));
        // Verify no bare text that could be mistaken for a prompt (not a flag).
        let non_flag_args: Vec<&String> = args
            .iter()
            .enumerate()
            .filter(|(i, a)| !a.starts_with("--") && *i > 0 && !args[i - 1].starts_with("--"))
            .map(|(_, a)| a)
            .collect();
        assert!(
            non_flag_args.is_empty(),
            "Found unexpected non-flag args: {non_flag_args:?}"
        );
    }

    #[test]
    fn test_build_persistent_args_includes_custom_instructions() {
        let settings = AgentSettings::default();
        let args = build_persistent_args("sess-1", false, &[], Some("be concise"), &settings);
        let idx = args
            .iter()
            .position(|a| a == "--append-system-prompt")
            .unwrap();
        assert_eq!(args[idx + 1], "be concise");
    }

    #[test]
    fn test_build_persistent_args_includes_allowed_tools() {
        let settings = AgentSettings::default();
        let tools = vec!["Read".to_string(), "Bash".to_string()];
        let args = build_persistent_args("sess-1", false, &tools, None, &settings);
        let idx = args.iter().position(|a| a == "--allowedTools").unwrap();
        assert_eq!(args[idx + 1], "Read,Bash");
    }

    #[test]
    fn test_build_persistent_args_bypass_permissions() {
        let settings = AgentSettings::default();
        let tools = vec!["*".to_string()];
        let args = build_persistent_args("sess-1", false, &tools, None, &settings);
        assert!(args.contains(&"bypassPermissions".to_string()));
        // Should NOT have --allowedTools when bypassing.
        assert!(!args.iter().any(|a| a == "--allowedTools"));
    }

    #[test]
    fn test_build_persistent_args_empty_allowed_tools() {
        let settings = AgentSettings::default();
        let args = build_persistent_args("sess-1", false, &[], None, &settings);
        // Empty allowed tools should not produce any --allowedTools flags.
        assert!(!args.iter().any(|a| a == "--allowedTools"));
        // And should not produce bypassPermissions either.
        assert!(!args.contains(&"bypassPermissions".to_string()));
    }

    #[test]
    fn test_build_persistent_args_mcp_with_allowed_tools() {
        // Verify MCP config and allowed tools don't interfere with each other.
        let settings = AgentSettings {
            mcp_config: Some(r#"{"mcpServers":{"s":{"type":"stdio","command":"x"}}}"#.to_string()),
            ..Default::default()
        };
        let tools = vec!["Bash".to_string(), "Read".to_string()];
        let args = build_persistent_args("sess-1", false, &tools, None, &settings);

        // Both should be present.
        let mcp_idx = args.iter().position(|a| a == "--mcp-config").unwrap();
        assert!(args[mcp_idx + 1].contains("mcpServers"));

        let idx = args.iter().position(|a| a == "--allowedTools").unwrap();
        assert_eq!(args[idx + 1], "Bash,Read");
    }

    #[test]
    fn test_build_persistent_args_all_flags_combined() {
        // Kitchen-sink test: all settings at once.
        let settings = AgentSettings {
            model: Some("claude-opus-4-20250514".to_string()),
            fast_mode: true,
            thinking_enabled: true,
            plan_mode: true,
            effort: Some("high".to_string()),
            chrome_enabled: true,
            mcp_config: Some(r#"{"mcpServers":{}}"#.to_string()),
        };
        let args = build_persistent_args(
            "sess-1",
            false,
            &["Bash".to_string()],
            Some("Be concise"),
            &settings,
        );

        assert!(args.contains(&"--model".to_string()));
        assert!(args.contains(&"claude-opus-4-20250514".to_string()));
        assert!(args.contains(&"--chrome".to_string()));
        assert!(args.contains(&"--mcp-config".to_string()));
        assert!(args.contains(&"--effort".to_string()));
        assert!(args.contains(&"high".to_string()));
        assert!(args.contains(&"--append-system-prompt".to_string()));
        assert!(args.contains(&"Be concise".to_string()));
        // plan_mode takes precedence over allowedTools.
        assert!(args.contains(&"plan".to_string()));
        // --settings should contain fastMode and alwaysThinkingEnabled.
        let settings_idx = args.iter().position(|a| a == "--settings").unwrap();
        let settings_json: serde_json::Value =
            serde_json::from_str(&args[settings_idx + 1]).unwrap();
        assert_eq!(settings_json["fastMode"], true);
        assert_eq!(settings_json["alwaysThinkingEnabled"], true);
    }

    #[test]
    fn test_build_args_mcp_config_none_not_present() {
        // When mcp_config is None, --mcp-config should not appear at all.
        let settings = AgentSettings {
            mcp_config: None,
            ..Default::default()
        };
        let args = build_claude_args("sess-1", "hello", false, &[], None, &settings, false);
        assert!(!args.iter().any(|a| a == "--mcp-config"));
    }

    #[test]
    fn test_build_persistent_args_empty_custom_instructions_ignored() {
        // Whitespace-only instructions should be treated as absent.
        let settings = AgentSettings::default();
        let args = build_persistent_args("sess-1", false, &[], Some("   "), &settings);
        assert!(!args.iter().any(|a| a == "--append-system-prompt"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_stop_agent_graceful_stops_process_before_escalation() {
        // Spawn a process that traps SIGTERM and exits cleanly.
        let mut child = tokio::process::Command::new("sh")
            .args(["-c", "trap 'exit 0' TERM; sleep 5"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("failed to spawn test child");

        let pid = child.id().expect("child pid should be available");

        let result = stop_agent_graceful(pid).await;
        assert!(
            result.is_ok(),
            "expected graceful stop to succeed: {result:?}"
        );

        tokio::time::timeout(std::time::Duration::from_secs(2), child.wait())
            .await
            .expect("child did not exit in time")
            .expect("failed to reap child");

        // kill -0 should fail for a dead process.
        let probe = tokio::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .output()
            .await;
        assert!(
            probe.is_ok_and(|o| !o.status.success()),
            "process {pid} should no longer exist after graceful stop"
        );
    }

    // --- control_request parsing + stdio permission prompt flag ---

    #[test]
    fn build_claude_args_omits_stdio_permission_prompt() {
        // run_turn doesn't keep stdin open for control_response, so the flag
        // must NOT appear here — otherwise the CLI would block on
        // AskUserQuestion / ExitPlanMode forever in non-persistent flows
        // (used by the WebSocket server in src-server/src/handler.rs).
        let args = build_claude_args(
            "sid",
            "hi",
            false,
            &["Read".to_string()],
            None,
            &AgentSettings::default(),
            false,
        );
        assert!(
            !args.iter().any(|a| a == "--permission-prompt-tool"),
            "build_claude_args must not enable the stdio permission prompt"
        );
    }

    #[test]
    fn build_persistent_args_includes_stdio_permission_prompt() {
        let args = build_persistent_args(
            "sid",
            false,
            &["Read".to_string()],
            None,
            &AgentSettings::default(),
        );
        let idx = args
            .iter()
            .position(|a| a == "--permission-prompt-tool")
            .expect("--permission-prompt-tool missing in persistent args");
        assert_eq!(args.get(idx + 1).map(String::as_str), Some("stdio"));
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
}
