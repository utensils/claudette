use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::json;
use tokio::sync::{broadcast, mpsc};

use crate::env::WorkspaceEnv;

use super::args::{build_settings_json, format_redacted_invocation};
use super::binary::resolve_claude_path;
use super::process::{AgentEvent, TurnHandle};
use super::types::{AssistantMessage, ContentBlock, FileAttachment, StreamEvent};
use super::{AgentSettings, PersistentSessionStart};

const COMPLETED_TURN_STABLE_MS: u64 = 300;
const TURN_TIMEOUT: Duration = Duration::from_secs(60 * 30);
const STARTUP_READY_TIMEOUT: Duration = Duration::from_secs(20);
const PASTE_ACK_TIMEOUT: Duration = Duration::from_secs(10);
const THINKING_STUCK_TIMEOUT: Duration = Duration::from_secs(60);
const PASTE_REACTION_BYTES: usize = 256;
const POLL_INTERVAL: Duration = Duration::from_millis(50);
const GROWTH_SAMPLE_INTERVAL: Duration = Duration::from_secs(1);

type SharedHandle = Arc<Mutex<ptywright::ExtensionHandle>>;
type SharedCancel = Arc<Mutex<Option<ptywright::CancellationToken>>>;

/// Experimental Claude Code harness that drives interactive Claude through
/// ptywright instead of invoking `claude -p` / Agent SDK mode.
///
/// This intentionally starts as a reduced-fidelity bridge. It proves the
/// process model and switchability while the richer event translation layer
/// catches up to Claude Code's stream-json parity.
pub struct PtywrightClaudeSession {
    pid: u32,
    handle: SharedHandle,
    event_tx: broadcast::Sender<AgentEvent>,
    current_cancel: SharedCancel,
    invocation_line: String,
    invocation_emitted: AtomicBool,
}

impl PtywrightClaudeSession {
    pub async fn start(params: PersistentSessionStart<'_>) -> Result<Self, String> {
        if !params.allowed_tools.is_empty() {
            tracing::debug!(
                target: "claudette::agent",
                "ptywright Claude harness ignores Claude CLI allowed_tools for now"
            );
        }
        if params.custom_instructions.is_some() {
            tracing::debug!(
                target: "claudette::agent",
                "ptywright Claude harness ignores custom instructions for now"
            );
        }
        if params.settings.mcp_config.is_some() {
            tracing::debug!(
                target: "claudette::agent",
                "ptywright Claude harness ignores MCP config for now"
            );
        }

        crate::missing_cli::precheck_cwd(params.working_dir)?;

        let claude_path = resolve_claude_path().await;
        let claude_program = claude_path.to_string_lossy().into_owned();
        let working_dir = params.working_dir.to_path_buf();
        let settings = params.settings.clone();
        let claude_args = build_ptywright_claude_args(&settings);
        let target_args = claude_args.clone();
        let workspace_env = params.workspace_env.cloned();

        let handle = tokio::task::spawn_blocking(move || {
            let mut target = ptywright::Target::new(claude_program.clone())
                .args(target_args)
                .cwd(working_dir);
            target = apply_start_env(target, &settings, workspace_env.as_ref());

            let session = ptywright::Session::spawn(ptywright::SessionConfig::new(target))
                .map_err(|e| format!("Failed to spawn Claude through ptywright: {e}"))?;
            let pid = session.pid().unwrap_or(0);
            let extension = ptywright::LuaExtension::built_in("claude-code")
                .map_err(|e| format!("Failed to load ptywright claude-code plugin: {e}"))?;
            let handle = ptywright::ExtensionHandle::start(
                Box::new(extension),
                session,
                COMPLETED_TURN_STABLE_MS,
            );
            Ok::<_, String>((pid, handle))
        })
        .await
        .map_err(|e| format!("Failed to initialize ptywright Claude harness: {e}"))??;

        let (pid, handle) = handle;
        let invocation_line = format!(
            "{} # interactive via ptywright",
            format_redacted_invocation(claude_path.as_os_str(), &claude_args)
        );
        let (event_tx, _) = broadcast::channel(2048);

        Ok(Self {
            pid,
            handle: Arc::new(Mutex::new(handle)),
            event_tx,
            current_cancel: Arc::new(Mutex::new(None)),
            invocation_line,
            invocation_emitted: AtomicBool::new(false),
        })
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
        self.send_turn_with_uuid(prompt, attachments, &uuid::Uuid::new_v4().to_string())
            .await
    }

    pub async fn send_turn_with_uuid(
        &self,
        prompt: &str,
        attachments: &[FileAttachment],
        _user_message_uuid: &str,
    ) -> Result<TurnHandle, String> {
        if !attachments.is_empty() {
            return Err(
                "ptywright Claude harness does not support attachments yet; switch Runtime back to Claude CLI for this turn"
                    .to_string(),
            );
        }

        let (event_tx, event_rx) = mpsc::channel::<AgentEvent>(128);
        if !self.invocation_emitted.swap(true, Ordering::Relaxed) {
            let event = AgentEvent::Stream(StreamEvent::system_command_line(
                self.invocation_line.clone(),
            ));
            let _ = self.event_tx.send(event.clone());
            let _ = event_tx.try_send(event);
        }

        let handle = Arc::clone(&self.handle);
        let broadcast_tx = self.event_tx.clone();
        let current_cancel = Arc::clone(&self.current_cancel);
        let prompt = prompt.to_string();
        let pid = self.pid;
        let cancel = ptywright::CancellationToken::new();

        {
            let mut guard = current_cancel
                .lock()
                .map_err(|_| "ptywright cancel lock poisoned".to_string())?;
            *guard = Some(cancel.clone());
        }

        tokio::task::spawn_blocking(move || {
            let started = Instant::now();
            let result = run_ptywright_turn(&handle, &prompt, &cancel);

            if let Ok(mut guard) = current_cancel.lock() {
                guard.take();
            }

            match result {
                Ok(text) => {
                    let assistant = AgentEvent::Stream(StreamEvent::Assistant {
                        message: AssistantMessage {
                            content: vec![ContentBlock::Text { text: text.clone() }],
                        },
                    });
                    send_event(&broadcast_tx, &event_tx, assistant);

                    let result = AgentEvent::Stream(StreamEvent::Result {
                        subtype: "success".to_string(),
                        result: Some(text),
                        total_cost_usd: None,
                        duration_ms: Some(started.elapsed().as_millis() as i64),
                        usage: None,
                    });
                    send_event(&broadcast_tx, &event_tx, result);
                }
                Err(error) => {
                    let assistant = AgentEvent::Stream(StreamEvent::Assistant {
                        message: AssistantMessage {
                            content: vec![ContentBlock::Text {
                                text: error.clone(),
                            }],
                        },
                    });
                    send_event(&broadcast_tx, &event_tx, assistant);
                    send_event(&broadcast_tx, &event_tx, AgentEvent::Stderr(error.clone()));
                    send_event(
                        &broadcast_tx,
                        &event_tx,
                        AgentEvent::Stream(StreamEvent::Result {
                            subtype: "error".to_string(),
                            result: Some(error),
                            total_cost_usd: None,
                            duration_ms: Some(started.elapsed().as_millis() as i64),
                            usage: None,
                        }),
                    );
                }
            }
        });

        Ok(TurnHandle { event_rx, pid })
    }

    pub async fn steer_turn(
        &self,
        prompt: &str,
        attachments: &[FileAttachment],
    ) -> Result<(), String> {
        if !attachments.is_empty() {
            return Err(
                "ptywright Claude harness does not support steering attachments yet".into(),
            );
        }
        let handle = Arc::clone(&self.handle);
        let prompt = prompt.to_string();
        tokio::task::spawn_blocking(move || {
            let mut guard = handle
                .lock()
                .map_err(|_| "ptywright handle lock poisoned".to_string())?;
            guard
                .send("steer", json!({ "prompt": prompt }))
                .map_err(|e| format!("Failed to steer ptywright Claude turn: {e}"))?;
            Ok::<_, String>(())
        })
        .await
        .map_err(|e| format!("Failed to steer ptywright Claude turn: {e}"))?
    }

    pub async fn interrupt_turn(&self) -> Result<(), String> {
        if let Ok(guard) = self.current_cancel.lock()
            && let Some(cancel) = guard.as_ref()
        {
            cancel.cancel();
        }

        let handle = Arc::clone(&self.handle);
        tokio::task::spawn_blocking(move || {
            let mut guard = handle
                .lock()
                .map_err(|_| "ptywright handle lock poisoned".to_string())?;
            let cancel_result = guard
                .send("cancel", json!({}))
                .map_err(|e| format!("Failed to cancel ptywright Claude turn: {e}"));
            let terminate_result = guard
                .session()
                .terminate(Duration::from_secs(2))
                .map_err(|e| format!("Failed to terminate ptywright Claude session: {e}"));
            cancel_result?;
            terminate_result?;
            Ok::<_, String>(())
        })
        .await
        .map_err(|e| format!("Failed to cancel ptywright Claude turn: {e}"))?
    }
}

fn build_ptywright_claude_args(settings: &AgentSettings) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(model) = settings.model.as_ref() {
        args.push("--model".to_string());
        args.push(model.clone());
    }
    if let Some(settings_json) = build_settings_json(settings) {
        args.push("--settings".to_string());
        args.push(settings_json);
    }
    if let Some(effort) = settings.effort.as_ref()
        && matches!(effort.as_str(), "low" | "medium" | "high" | "xhigh" | "max")
    {
        args.push("--effort".to_string());
        args.push(effort.clone());
    }
    for (name, value) in &settings.extra_claude_flags {
        args.push(name.clone());
        if let Some(value) = value {
            args.push(value.clone());
        }
    }
    args
}

fn run_ptywright_turn(
    handle: &SharedHandle,
    prompt: &str,
    cancel: &ptywright::CancellationToken,
) -> Result<String, String> {
    let mut guard = handle
        .lock()
        .map_err(|_| "ptywright handle lock poisoned".to_string())?;
    prepare_for_prompt(&mut guard)?;
    submit_prompt(&mut guard, prompt)?;
    let state = wait_for_turn_state(&mut guard, cancel)?;

    match state.state.as_str() {
        "completed_turn" => {
            let answer = extract_turn_answer(&guard, &state, prompt);
            if answer_looks_like_claude_error(&answer) {
                Err(format!("ptywright Claude reported an error: {answer}"))
            } else {
                Ok(answer)
            }
        }
        "waiting_for_permission"
        | "waiting_for_enter_plan_mode"
        | "waiting_for_plan_approval"
        | "waiting_for_trust"
        | "waiting_for_model_select"
        | "waiting_for_external_editor"
        | "waiting_for_login" => Err(format!(
            "ptywright Claude stopped at `{}` ({}) but Claudette does not bridge that interactive state yet; switch Runtime back to Claude CLI for this turn",
            state.state, state.evidence
        )),
        "error" => Err(format!(
            "ptywright Claude reported an error: {}",
            state.evidence
        )),
        _ => Ok(extract_turn_answer(&guard, &state, prompt)),
    }
}

fn wait_for_turn_state(
    handle: &mut ptywright::ExtensionHandle,
    cancel: &ptywright::CancellationToken,
) -> Result<ptywright::ExtensionStateSnapshot, String> {
    let deadline = Instant::now() + TURN_TIMEOUT;
    let mut last_state: Option<ptywright::ExtensionStateSnapshot> = None;
    let mut growth_baseline = handle.session().transcript().len();
    let mut last_meaningful_growth_at = Instant::now();
    let mut last_growth_sample_at = Instant::now();
    while Instant::now() < deadline {
        if cancel.is_cancelled() {
            return Err("ptywright Claude turn failed: wait cancelled".to_string());
        }
        let mut state = handle
            .try_state()
            .map_err(|e| format!("Failed to inspect ptywright Claude turn state: {e}"))?;
        tracing::trace!(
            target: "claudette::agent",
            ptywright_state = %state.state,
            evidence = %state.evidence,
            "ptywright Claude turn poll"
        );
        let screen = handle.session().snapshot().plain_text;
        if answer_looks_like_claude_error(&screen) {
            return Err(format!(
                "ptywright Claude reported an error: {}",
                extract_visible_answer(&screen, &state.evidence)
            ));
        }
        if state.state == "thinking" && screen.lines().any(|line| is_completion_marker(line.trim()))
        {
            state.state = "completed_turn".to_string();
            if state.evidence.is_empty() {
                state.evidence = "completion marker observed in screen".to_string();
            }
            return Ok(state);
        }
        if state.state == "thinking" && last_growth_sample_at.elapsed() >= GROWTH_SAMPLE_INTERVAL {
            last_growth_sample_at = Instant::now();
            let transcript_len = handle.session().transcript().len();
            if transcript_len.saturating_sub(growth_baseline) >= PASTE_REACTION_BYTES {
                growth_baseline = transcript_len;
                last_meaningful_growth_at = Instant::now();
            } else if last_meaningful_growth_at.elapsed() >= THINKING_STUCK_TIMEOUT {
                let _ = handle.send("cancel", json!({}));
                let _ = handle.session().terminate(Duration::from_secs(2));
                return Err(format!(
                    "ptywright Claude turn got stuck: no meaningful PTY output for {}s while classifier reported `thinking`",
                    THINKING_STUCK_TIMEOUT.as_secs()
                ));
            }
        }
        match state.state.as_str() {
            "completed_turn"
            | "error"
            | "waiting_for_permission"
            | "waiting_for_enter_plan_mode"
            | "waiting_for_plan_approval"
            | "waiting_for_trust"
            | "waiting_for_model_select"
            | "waiting_for_external_editor"
            | "waiting_for_login" => return Ok(state),
            _ => {
                last_state = Some(state);
                std::thread::sleep(POLL_INTERVAL);
            }
        }
    }

    let evidence = last_state
        .as_ref()
        .map(|state| format!("last state `{}` ({})", state.state, state.evidence))
        .unwrap_or_else(|| "no state observed".to_string());
    Err(format!(
        "Timed out waiting for ptywright Claude turn to complete; {evidence}"
    ))
}

fn prepare_for_prompt(handle: &mut ptywright::ExtensionHandle) -> Result<(), String> {
    let deadline = Instant::now() + STARTUP_READY_TIMEOUT;
    while Instant::now() < deadline {
        let state = handle
            .try_state()
            .map_err(|e| format!("Failed to inspect ptywright Claude state: {e}"))?;
        match state.state.as_str() {
            "ready" | "waiting_for_user_input" | "completed_turn" => return Ok(()),
            "waiting_for_trust" => {
                handle
                    .send("approve_trust", json!({}))
                    .map_err(|e| format!("Failed to approve Claude workspace trust: {e}"))?;
            }
            "waiting_for_login" => {
                return Err(
                    "Claude requires sign-in; run `claude` interactively once, complete login, then retry ptywright runtime"
                        .to_string(),
                );
            }
            "error" => {
                return Err(format!(
                    "ptywright Claude reported an error: {}",
                    state.evidence
                ));
            }
            _ => std::thread::sleep(POLL_INTERVAL),
        }
    }

    Err("Timed out waiting for Claude's interactive input prompt".to_string())
}

fn submit_prompt(handle: &mut ptywright::ExtensionHandle, prompt: &str) -> Result<(), String> {
    let first = submit_prompt_once(handle, prompt)?;
    if first {
        return Ok(());
    }

    let _ = handle.send("dismiss_welcome", json!({}));
    let second = submit_prompt_once(handle, prompt)?;
    if second {
        return Ok(());
    }

    let _ = handle.send("cancel", json!({}));
    Err("Claude did not accept the ptywright prompt paste; interactive runtime cancelled the half-submitted turn".to_string())
}

fn submit_prompt_once(
    handle: &mut ptywright::ExtensionHandle,
    prompt: &str,
) -> Result<bool, String> {
    let baseline = handle.session().transcript().len();
    handle
        .send("send_prompt", json!({ "prompt": prompt }))
        .map_err(|e| format!("Failed to submit ptywright Claude prompt: {e}"))?;

    let prompt_anchor = prompt
        .trim()
        .lines()
        .next()
        .unwrap_or_default()
        .chars()
        .take(40)
        .collect::<String>();
    let deadline = Instant::now() + PASTE_ACK_TIMEOUT;
    while Instant::now() < deadline {
        let transcript = handle.session().transcript();
        let transcript_len = transcript.len();
        let grew = transcript_len.saturating_sub(baseline);
        let state = handle
            .try_state()
            .map_err(|e| format!("Failed to inspect ptywright Claude submit state: {e}"))?;
        let anchored = !prompt_anchor.is_empty() && transcript.contains(&prompt_anchor);
        tracing::trace!(
            target: "claudette::agent",
            ptywright_state = %state.state,
            grew,
            anchored,
            evidence = %state.evidence,
            "ptywright Claude prompt acknowledgement poll"
        );

        if matches!(state.state.as_str(), "completed_turn" | "error")
            || (grew >= PASTE_REACTION_BYTES && (anchored || state.state.as_str() == "thinking"))
        {
            return Ok(true);
        }

        std::thread::sleep(POLL_INTERVAL);
    }

    Ok(false)
}

fn extract_turn_answer(
    handle: &ptywright::ExtensionHandle,
    state: &ptywright::ExtensionStateSnapshot,
    prompt: &str,
) -> String {
    if let Some((turn_start, turn_end)) = transcript_bounds(handle, state)
        && let Some(slice) = handle.session().transcript_slice(turn_start, turn_end)
        && let Some(answer) = clean_transcript_answer(&slice, prompt)
    {
        return answer;
    }

    let screen = handle.session().snapshot().plain_text;
    extract_visible_answer(&screen, state.evidence.as_str())
}

fn transcript_bounds(
    handle: &ptywright::ExtensionHandle,
    state: &ptywright::ExtensionStateSnapshot,
) -> Option<(u64, u64)> {
    let metadata_bounds = state
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("transcript"))
        .and_then(|transcript| {
            let start = transcript.get("turn_start")?.as_u64()?;
            let end = transcript.get("turn_end")?.as_u64()?;
            Some((start, end))
        });

    let (start, end) = metadata_bounds.or_else(|| {
        Some((
            handle.session().transcript_marker("turn_start")?,
            handle.session().transcript_marker("turn_end")?,
        ))
    })?;

    (end > start).then_some((start, end))
}

fn clean_transcript_answer(transcript: &str, prompt: &str) -> Option<String> {
    let lines: Vec<&str> = transcript.lines().collect();
    if lines.is_empty() {
        return None;
    }

    let anchor = prompt.trim().lines().next().unwrap_or_default();
    let start = find_prompt_echo_end(&lines, anchor);
    let end = find_completion_marker_index(&lines, start).unwrap_or(lines.len());
    let mut cleaned = Vec::new();
    let mut seen = std::collections::BTreeSet::new();

    for line in &lines[start..end] {
        let trimmed = line.trim();
        if trimmed.is_empty()
            || !is_safe_transcript_line(line)
            || is_chrome_line(trimmed)
            || is_ghost_prompt_line(trimmed)
        {
            continue;
        }

        if seen.insert(trimmed.to_string()) {
            cleaned.push(line.trim_end());
        }
    }

    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned.join("\n"))
    }
}

fn find_prompt_echo_end(lines: &[&str], anchor: &str) -> usize {
    if anchor.is_empty() {
        return 0;
    }

    let mut substring_match = None;
    for (index, line) in lines.iter().enumerate().rev() {
        if !line.contains(anchor) {
            continue;
        }

        if substring_match.is_none() {
            substring_match = Some(index + 1);
        }

        if is_ghost_prompt_line(line.trim_start()) {
            return index + 1;
        }
    }

    substring_match.unwrap_or(0)
}

fn find_completion_marker_index(lines: &[&str], start: usize) -> Option<usize> {
    lines
        .iter()
        .enumerate()
        .skip(start)
        .find_map(|(index, line)| is_completion_marker(line.trim()).then_some(index))
}

fn is_safe_transcript_line(line: &str) -> bool {
    line.chars().all(|ch| {
        let code = ch as u32;
        ch == '\t' || (code >= 32 && code != 127)
    })
}

fn is_chrome_line(line: &str) -> bool {
    is_horizontal_rule(line)
        || is_spinner_line(line)
        || is_in_flight_search_line(line)
        || is_completion_marker(line)
}

fn is_horizontal_rule(line: &str) -> bool {
    !line.is_empty() && line.chars().all(|ch| matches!(ch, '─' | '━' | '═'))
}

fn is_spinner_line(line: &str) -> bool {
    let mut chars = line.chars();
    let Some(first) = chars.next() else {
        return false;
    };

    is_spinner_glyph(first) && line.contains('…') && line.len() <= 120
}

fn is_spinner_glyph(ch: char) -> bool {
    matches!(
        ch,
        '✶' | '✻'
            | '✺'
            | '✦'
            | '·'
            | '•'
            | '⠋'
            | '⠙'
            | '⠹'
            | '⠸'
            | '⠼'
            | '⠴'
            | '⠦'
            | '⠧'
            | '⠇'
            | '⠏'
            | '⏺'
            | '✽'
            | '✳'
            | '✢'
            | '⏵'
    )
}

fn is_in_flight_search_line(line: &str) -> bool {
    (line.starts_with("Searching") || line.starts_with("Reading") || line.starts_with("Listing"))
        && line.contains('…')
        && line.ends_with("(ctrl+o to expand)")
}

fn is_completion_marker(line: &str) -> bool {
    line.starts_with('✻') && line.contains(" for ") && !line.ends_with('…')
}

fn is_ghost_prompt_line(line: &str) -> bool {
    line.starts_with("❯ ") || line.starts_with("❯\u{00a0}")
}

fn answer_looks_like_claude_error(answer: &str) -> bool {
    let lower = answer.to_ascii_lowercase();
    lower.contains("your organization has disabled claude subscription access")
        || lower.contains("invalid api key")
        || lower.contains("authentication failed")
        || lower.contains("unauthorized")
        || lower.contains("oauth failed")
        || lower.contains("rate limit reached")
        || lower.contains("you've reached your usage limit")
        || lower.contains("credit balance is too low")
}

fn extract_visible_answer(screen: &str, evidence: &str) -> String {
    let trimmed = screen.trim();
    if trimmed.is_empty() {
        return format!("ptywright Claude turn completed: {evidence}");
    }
    trimmed.to_string()
}

fn send_event(
    broadcast_tx: &broadcast::Sender<AgentEvent>,
    turn_tx: &mpsc::Sender<AgentEvent>,
    event: AgentEvent,
) {
    let _ = broadcast_tx.send(event.clone());
    let _ = turn_tx.blocking_send(event);
}

fn apply_start_env(
    mut target: ptywright::Target,
    settings: &AgentSettings,
    workspace_env: Option<&WorkspaceEnv>,
) -> ptywright::Target {
    target = target.env("TERM", "xterm-256color");
    target = target.env("CLAUDETTE_PTYWRIGHT_CLAUDE", "1");
    target = target.env("CLAUDE_CODE_SKIP_PROMPT_HISTORY", "1");
    target = target.env("CLAUDE_CODE_DISABLE_MOUSE", "1");
    target = target.env("CLAUDE_CODE_DISABLE_BACKGROUND_TASKS", "1");
    target = target.env("CLAUDE_CODE_DISABLE_MESSAGE_ACTIONS", "1");
    target = target.env("CLAUDE_CODE_DISABLE_ATTACHMENTS", "1");
    target = target.env("CLAUDE_CODE_SYNTAX_HIGHLIGHT", "0");
    target = target.env("CLAUDE_CODE_ACCESSIBILITY", "1");
    target = target.env("CLAUDE_CODE_DISABLE_TERMINAL_TITLE", "1");
    target = target.env("CLAUDE_CODE_DISABLE_VIRTUAL_SCROLL", "1");
    target = target.env("NO_COLOR", "1");
    target = target.env("FORCE_COLOR", "0");

    if settings.disable_1m_context {
        target = target.env("CLAUDE_CODE_DISABLE_1M_CONTEXT", "1");
    }

    if let Some(env) = workspace_env {
        for (key, value) in env.vars() {
            target = target.env(key, value);
        }
    }

    target
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transcript_answer_removes_prompt_echo_and_completion_marker() {
        let transcript = "\
❯ Reply exactly PTYWRIGHT_OK
PTYWRIGHT_OK
✻ Done for 1s
❯\u{00a0}Try another prompt";

        assert_eq!(
            clean_transcript_answer(transcript, "Reply exactly PTYWRIGHT_OK").as_deref(),
            Some("PTYWRIGHT_OK")
        );
    }

    #[test]
    fn transcript_answer_filters_spinner_and_in_flight_chrome() {
        let transcript = "\
❯ summarize
✻ Pondering… (1s · thinking)
Searching for 1 pattern… (ctrl+o to expand)
Searched for 1 pattern (ctrl+o to expand)
The answer.
✻ Done for 2s";

        assert_eq!(
            clean_transcript_answer(transcript, "summarize").as_deref(),
            Some("Searched for 1 pattern (ctrl+o to expand)\nThe answer.")
        );
    }

    #[test]
    fn transcript_answer_rejects_control_fragment_lines() {
        let transcript = "\
❯ go
\u{1b}[?25l
clean line
✻ Done for 1s";

        assert_eq!(
            clean_transcript_answer(transcript, "go").as_deref(),
            Some("clean line")
        );
    }

    #[test]
    fn transcript_answer_falls_back_when_no_content_survives() {
        let transcript = "\
❯ go
✻ Done for 1s";

        assert!(clean_transcript_answer(transcript, "go").is_none());
    }

    #[test]
    fn claude_access_banner_is_treated_as_error() {
        assert!(answer_looks_like_claude_error(
            "Your organization has disabled Claude subscription access for Claude Code"
        ));
    }

    #[test]
    fn ptywright_args_include_selected_model() {
        let settings = AgentSettings {
            model: Some("opus".to_string()),
            ..AgentSettings::default()
        };

        assert_eq!(build_ptywright_claude_args(&settings), ["--model", "opus"]);
    }
}
