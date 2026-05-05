use std::path::Path;

use tokio::io::AsyncBufReadExt;
use tokio::io::BufReader;
use tokio::process::Command;
use tokio::sync::mpsc;

use crate::env::WorkspaceEnv;
use crate::process::CommandWindowExt as _;

use super::AgentSettings;
use super::args::{build_settings_json, build_stdin_message, build_steering_stdin_message};
use super::binary::resolve_claude_path;
use super::process::{AgentEvent, TurnHandle};
use super::types::{FileAttachment, StreamEvent, parse_stream_line};

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
        resolved_env: Option<&crate::env_provider::ResolvedEnv>,
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
        cmd.no_console_window();
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

        // See run_turn for layering rationale — env-provider output under
        // the CLAUDETTE_* markers, under the settings-driven context toggle.
        if let Some(env) = resolved_env {
            env.apply(&mut cmd);
        }

        cmd.env_remove("CLAUDE_CODE_DISABLE_1M_CONTEXT");
        if settings.disable_1m_context {
            cmd.env("CLAUDE_CODE_DISABLE_1M_CONTEXT", "1");
        }

        if let Some(ref bridge) = settings.hook_bridge {
            cmd.env(
                crate::agent_mcp::server::ENV_SOCKET_ADDR,
                &bridge.socket_addr,
            );
            cmd.env(crate::agent_mcp::server::ENV_TOKEN, &bridge.token);
        }

        if let Some(env) = ws_env {
            env.apply(&mut cmd);
        }

        let mut child = cmd.spawn().map_err(|e| {
            crate::missing_cli::map_spawn_err(&e, "claude", || {
                format!("Failed to spawn persistent session at {claude_path:?}: {e}")
            })
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
        attachments: &[FileAttachment],
    ) -> Result<TurnHandle, String> {
        // Subscribe BEFORE writing to stdin to avoid a race where a fast turn
        // emits events before the receiver exists (broadcast doesn't replay).
        let mut broadcast_rx = self.event_tx.subscribe();

        self.write_user_message(build_stdin_message(prompt, attachments))
            .await?;
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

    /// Send a user message to the currently active turn without creating a
    /// new per-turn receiver. This is used for mid-turn steering, where the
    /// existing active `TurnHandle` must continue to own stream attribution.
    pub async fn steer_user_message(
        &self,
        prompt: &str,
        attachments: &[FileAttachment],
    ) -> Result<(), String> {
        self.write_user_message(build_steering_stdin_message(prompt, attachments))
            .await
    }

    async fn write_user_message(&self, message: String) -> Result<(), String> {
        use tokio::io::AsyncWriteExt;

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
        Ok(())
    }

    /// Subscribe to the persistent process's raw stream-json events without
    /// sending a new turn. Used by session-level infrastructure that must
    /// observe SDK events emitted while no user turn receiver is active.
    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<AgentEvent> {
        self.event_tx.subscribe()
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

    /// Ask the persistent Claude CLI process to stop an agent-owned
    /// background task. The CLI accepts this as an SDK `control_request` on
    /// the same stream-json stdin used for user turns and permission responses.
    pub async fn send_task_stop(&self, task_id: &str) -> Result<(), String> {
        use tokio::io::AsyncWriteExt;
        let request_id = format!("claudette-stop-task-{}", uuid::Uuid::new_v4());
        let message = build_task_stop_message(&request_id, task_id);
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(message.as_bytes())
            .await
            .map_err(|e| format!("Failed to write stop_task control_request: {e}"))?;
        stdin
            .write_all(b"\n")
            .await
            .map_err(|e| format!("Failed to write stop_task control_request newline: {e}"))?;
        stdin
            .flush()
            .await
            .map_err(|e| format!("Failed to flush stop_task control_request: {e}"))?;
        Ok(())
    }

    /// Get the process ID.
    pub fn pid(&self) -> u32 {
        self.pid
    }
}

fn build_task_stop_message(request_id: &str, task_id: &str) -> String {
    serde_json::json!({
        "type": "control_request",
        "request_id": request_id,
        "request": {
            "subtype": "stop_task",
            "task_id": task_id,
        },
    })
    .to_string()
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

    let bypass_permissions = crate::permissions::is_bypass_tools(allowed_tools);

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

    // Chrome is session-level — only applied on the first turn (matches
    // `build_claude_args` and the `AgentSettings::chrome_enabled` doc).
    if !is_resume && settings.chrome_enabled {
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

    if let Some(settings_json) = build_settings_json(settings) {
        args.push("--settings".to_string());
        args.push(settings_json);
    }

    // Effort level — "auto" and unknown values are skipped (let the CLI use
    // its default). Mirrors the filter in `build_claude_args` so persistent
    // sessions and one-shot turns behave identically.
    if let Some(ref effort) = settings.effort
        && matches!(effort.as_str(), "low" | "medium" | "high" | "xhigh" | "max")
    {
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

#[cfg(test)]
mod tests {
    use super::*;

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
            disable_1m_context: false,
            hook_bridge: None,
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
    fn test_build_persistent_args_chrome_skipped_on_resume() {
        // Chrome is session-level (per `AgentSettings::chrome_enabled` docs)
        // and must not be re-applied on resume — same as `build_claude_args`.
        let settings = AgentSettings {
            chrome_enabled: true,
            ..Default::default()
        };
        let args = build_persistent_args("sess-1", true, &[], None, &settings);
        assert!(!args.contains(&"--chrome".to_string()));
    }

    #[test]
    fn test_build_persistent_args_chrome_set_on_first_turn() {
        let settings = AgentSettings {
            chrome_enabled: true,
            ..Default::default()
        };
        let args = build_persistent_args("sess-1", false, &[], None, &settings);
        assert!(args.contains(&"--chrome".to_string()));
    }

    #[test]
    fn test_build_persistent_args_effort_auto_omitted() {
        // "auto" means let the CLI use its default — don't pass --effort.
        // Mirrors the behavior of `build_claude_args` so persistent sessions
        // and one-shot turns stay in sync.
        let settings = AgentSettings {
            effort: Some("auto".to_string()),
            ..Default::default()
        };
        let args = build_persistent_args("sess-1", false, &[], None, &settings);
        assert!(!args.contains(&"--effort".to_string()));
    }

    #[test]
    fn test_build_persistent_args_effort_unknown_omitted() {
        // Unknown values are skipped — same as `build_claude_args`.
        let settings = AgentSettings {
            effort: Some("bogus".to_string()),
            ..Default::default()
        };
        let args = build_persistent_args("sess-1", false, &[], None, &settings);
        assert!(!args.contains(&"--effort".to_string()));
    }

    #[test]
    fn test_build_persistent_args_effort_xhigh_passed() {
        let settings = AgentSettings {
            effort: Some("xhigh".to_string()),
            ..Default::default()
        };
        let args = build_persistent_args("sess-1", false, &[], None, &settings);
        let idx = args.iter().position(|a| a == "--effort").unwrap();
        assert_eq!(args[idx + 1], "xhigh");
    }

    #[test]
    fn test_build_persistent_args_empty_custom_instructions_ignored() {
        // Whitespace-only instructions should be treated as absent.
        let settings = AgentSettings::default();
        let args = build_persistent_args("sess-1", false, &[], Some("   "), &settings);
        assert!(!args.iter().any(|a| a == "--append-system-prompt"));
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
    fn build_task_stop_message_writes_out_of_band_control_shape() {
        let raw = build_task_stop_message("req_123", "task_123");
        let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(parsed["type"], "control_request");
        assert_eq!(parsed["request_id"], "req_123");
        assert_eq!(parsed["request"]["subtype"], "stop_task");
        assert_eq!(parsed["request"]["task_id"], "task_123");
    }
}
