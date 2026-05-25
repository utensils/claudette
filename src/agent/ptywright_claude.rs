use std::collections::{BTreeSet, hash_map::DefaultHasher};
use std::env;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tokio::sync::{broadcast, mpsc};

use crate::env::WorkspaceEnv;

use super::args::{build_settings_json, format_redacted_invocation};
use super::binary::resolve_claude_path;
use super::process::{AgentEvent, TurnHandle};
use super::types::{
    AssistantMessage, ContentBlock, Delta, FileAttachment, InnerStreamEvent, StartContentBlock,
    StreamEvent, UserContentBlock, UserEventMessage, UserMessageContent,
};
use super::{AgentSettings, PersistentSessionStart};

const COMPLETED_TURN_STABLE_MS: u64 = 300;
const TURN_TIMEOUT: Duration = Duration::from_secs(60 * 30);
const STARTUP_READY_TIMEOUT: Duration = Duration::from_secs(20);
const CANCEL_SETTLE_TIMEOUT: Duration = Duration::from_secs(5);
const PASTE_ACK_TIMEOUT: Duration = Duration::from_secs(10);
const PASTE_REACTION_BYTES: usize = 256;
const POLL_INTERVAL: Duration = Duration::from_millis(50);
const SUBMIT_NUDGE_INTERVAL: Duration = Duration::from_millis(750);

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
    working_dir: PathBuf,
    claude_session_id: String,
}

impl PtywrightClaudeSession {
    pub fn can_resume_session(working_dir: &Path, session_id: &str) -> bool {
        claude_jsonl_transcript_path(working_dir, session_id).is_some_and(|path| path.is_file())
    }

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
        let session_working_dir = working_dir.clone();
        let claude_session_id = params.session_id.to_string();
        let settings = params.settings.clone();
        let claude_args =
            build_ptywright_claude_args(params.session_id, params.is_resume, &settings);
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

        let (pid, mut handle) = handle;
        if params.is_resume {
            validate_resume_start(&mut handle).inspect_err(|_| {
                let _ = handle.session().terminate(Duration::from_secs(2));
            })?;
        }
        let invocation_line = format!(
            "{} # interactive via ptywright",
            format_redacted_invocation(claude_path.as_os_str(), &claude_args)
        );
        tracing::debug!(
            target: "claudette::agent",
            pid,
            invocation = %invocation_line,
            "ptywright Claude session started"
        );
        let (event_tx, _) = broadcast::channel(2048);

        Ok(Self {
            pid,
            handle: Arc::new(Mutex::new(handle)),
            event_tx,
            current_cancel: Arc::new(Mutex::new(None)),
            invocation_line,
            invocation_emitted: AtomicBool::new(false),
            working_dir: session_working_dir,
            claude_session_id,
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
        let working_dir = self.working_dir.clone();
        let claude_session_id = self.claude_session_id.clone();
        let cancel = ptywright::CancellationToken::new();

        {
            let mut guard = current_cancel
                .lock()
                .map_err(|_| "ptywright cancel lock poisoned".to_string())?;
            *guard = Some(cancel.clone());
        }

        tokio::task::spawn_blocking(move || {
            let started = Instant::now();
            tracing::debug!(
                target: "claudette::agent",
                pid,
                prompt_len = prompt.len(),
                "ptywright Claude turn started"
            );
            let result = run_ptywright_turn(
                &handle,
                &prompt,
                &cancel,
                &broadcast_tx,
                &event_tx,
                &working_dir,
                &claude_session_id,
            );

            if let Ok(mut guard) = current_cancel.lock() {
                guard.take();
            }

            match result {
                Ok(text) => {
                    tracing::debug!(
                        target: "claudette::agent",
                        pid,
                        duration_ms = started.elapsed().as_millis(),
                        response_len = text.len(),
                        "ptywright Claude turn succeeded"
                    );
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
                    tracing::warn!(
                        target: "claudette::agent",
                        pid,
                        duration_ms = started.elapsed().as_millis(),
                        error = %error,
                        "ptywright Claude turn failed"
                    );
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
            cancel_ptywright_turn(&mut guard)
                .map_err(|e| format!("Failed to cancel ptywright Claude turn: {e}"))?;
            Ok::<_, String>(())
        })
        .await
        .map_err(|e| format!("Failed to cancel ptywright Claude turn: {e}"))?
    }
}

fn build_ptywright_claude_args(
    session_id: &str,
    is_resume: bool,
    settings: &AgentSettings,
) -> Vec<String> {
    let mut args = Vec::new();
    if is_resume {
        args.push("--resume".to_string());
        args.push(session_id.to_string());
    } else {
        args.push("--session-id".to_string());
        args.push(session_id.to_string());
    }
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
    broadcast_tx: &broadcast::Sender<AgentEvent>,
    turn_tx: &mpsc::Sender<AgentEvent>,
    working_dir: &Path,
    claude_session_id: &str,
) -> Result<String, String> {
    {
        let mut guard = handle
            .lock()
            .map_err(|_| "ptywright handle lock poisoned".to_string())?;
        tracing::debug!(
            target: "claudette::agent",
            prompt_len = prompt.len(),
            "ptywright Claude preparing prompt"
        );
        prepare_for_prompt(&mut guard)?;
        tracing::debug!(
            target: "claudette::agent",
            prompt_len = prompt.len(),
            "ptywright Claude submitting prompt"
        );
        submit_prompt(&mut guard, prompt)?;
    }
    let state = wait_for_turn_state(handle, cancel, prompt, broadcast_tx, turn_tx)?;
    tracing::debug!(
        target: "claudette::agent",
        ptywright_state = %state.state,
        evidence = %state.evidence,
        sequence = state.sequence,
        metadata_keys = ?metadata_keys(state.metadata.as_ref()),
        "ptywright Claude terminal state observed"
    );

    match state.state.as_str() {
        "completed_turn" => {
            let guard = handle
                .lock()
                .map_err(|_| "ptywright handle lock poisoned".to_string())?;
            let answer =
                extract_turn_answer(&guard, &state, prompt, working_dir, claude_session_id);
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
        _ => {
            let guard = handle
                .lock()
                .map_err(|_| "ptywright handle lock poisoned".to_string())?;
            Ok(extract_turn_answer(
                &guard,
                &state,
                prompt,
                working_dir,
                claude_session_id,
            ))
        }
    }
}

fn validate_resume_start(handle: &mut ptywright::ExtensionHandle) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        let state = handle
            .try_state()
            .map_err(|e| format!("Failed to inspect ptywright Claude resume state: {e}"))?;
        let screen = handle.session().snapshot().plain_text;
        if answer_looks_like_claude_error(&screen) {
            return Err(format!(
                "ptywright Claude resume failed: {}",
                extract_visible_answer(&screen, &state.evidence)
            ));
        }
        if matches!(
            state.state.as_str(),
            "ready" | "waiting_for_user_input" | "completed_turn"
        ) && has_visible_input_prompt(&screen)
        {
            return Ok(());
        }
        std::thread::sleep(POLL_INTERVAL);
    }
    Ok(())
}

fn wait_for_turn_state(
    handle: &SharedHandle,
    cancel: &ptywright::CancellationToken,
    prompt: &str,
    broadcast_tx: &broadcast::Sender<AgentEvent>,
    turn_tx: &mpsc::Sender<AgentEvent>,
) -> Result<ptywright::ExtensionStateSnapshot, String> {
    let deadline = Instant::now() + TURN_TIMEOUT;
    let mut last_state: Option<ptywright::ExtensionStateSnapshot> = None;
    let mut last_log_state = String::new();
    let mut last_log_at = Instant::now() - Duration::from_secs(60);
    let mut last_ignored_completed_sequence = None;
    let mut last_ignored_completed_log_at = Instant::now() - Duration::from_secs(60);
    let mut tool_activity = PtywrightToolActivityEmitter::default();
    let mut assistant_text = PtywrightAssistantTextEmitter::default();
    while Instant::now() < deadline {
        if cancel.is_cancelled() {
            return Err("ptywright Claude turn failed: wait cancelled".to_string());
        }
        let (state, screen, transcript_len, current_turn_answer, prompt_editable) = {
            let guard = handle
                .lock()
                .map_err(|_| "ptywright handle lock poisoned".to_string())?;
            let state = guard
                .try_state()
                .map_err(|e| format!("Failed to inspect ptywright Claude turn state: {e}"))?;
            let screen = guard.session().snapshot().plain_text;
            let transcript_len = guard.session().transcript().len();
            let current_turn_answer = current_turn_has_answer(&guard, &state, prompt);
            let prompt_editable = current_prompt_still_editable(&guard, prompt);
            (
                state,
                screen,
                transcript_len,
                current_turn_answer,
                prompt_editable,
            )
        };
        if state.state != last_log_state || last_log_at.elapsed() >= Duration::from_secs(5) {
            tracing::debug!(
                target: "claudette::agent",
                ptywright_state = %state.state,
                evidence = %state.evidence,
                sequence = state.sequence,
                transcript_len,
                metadata_keys = ?metadata_keys(state.metadata.as_ref()),
                screen_tail = %debug_tail(&screen, 800),
                "ptywright Claude turn poll"
            );
            last_log_state = state.state.clone();
            last_log_at = Instant::now();
        } else {
            tracing::trace!(
                target: "claudette::agent",
                ptywright_state = %state.state,
                evidence = %state.evidence,
                sequence = state.sequence,
                transcript_len,
                "ptywright Claude turn poll"
            );
        }
        if answer_looks_like_claude_error(&screen) {
            tool_activity.finish_all(broadcast_tx, turn_tx, "error");
            assistant_text.finish(broadcast_tx, turn_tx);
            return Err(format!(
                "ptywright Claude reported an error: {}",
                extract_visible_answer(&screen, &state.evidence)
            ));
        }
        assistant_text.observe_state(&state, broadcast_tx, turn_tx);
        tool_activity.observe_state(&state, &screen, broadcast_tx, turn_tx);
        match state.state.as_str() {
            "completed_turn" => {
                if current_turn_answer {
                    tool_activity.finish_all(broadcast_tx, turn_tx, "completed");
                    assistant_text.finish(broadcast_tx, turn_tx);
                    return Ok(state);
                }
                if last_ignored_completed_sequence != Some(state.sequence)
                    || last_ignored_completed_log_at.elapsed() >= Duration::from_secs(5)
                {
                    tracing::debug!(
                        target: "claudette::agent",
                        ptywright_state = %state.state,
                        evidence = %state.evidence,
                        sequence = state.sequence,
                        has_structured_turn = structured_turn_text(&state).is_some(),
                        prompt_editable,
                        "ptywright Claude ignored stale completed_turn without current turn answer"
                    );
                    last_ignored_completed_sequence = Some(state.sequence);
                    last_ignored_completed_log_at = Instant::now();
                } else {
                    tracing::trace!(
                        target: "claudette::agent",
                        ptywright_state = %state.state,
                        evidence = %state.evidence,
                        sequence = state.sequence,
                        "ptywright Claude ignored stale completed_turn without current turn answer"
                    );
                }
                last_state = Some(state);
                std::thread::sleep(POLL_INTERVAL);
            }
            "error"
            | "waiting_for_permission"
            | "waiting_for_enter_plan_mode"
            | "waiting_for_plan_approval"
            | "waiting_for_trust"
            | "waiting_for_model_select"
            | "waiting_for_external_editor"
            | "waiting_for_login" => {
                tool_activity.finish_all(broadcast_tx, turn_tx, "interrupted");
                assistant_text.finish(broadcast_tx, turn_tx);
                return Ok(state);
            }
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
    let mut last_log_state = String::new();
    let mut last_log_at = Instant::now() - Duration::from_secs(60);
    let mut last_trust_approval_at = Instant::now() - Duration::from_secs(60);
    while Instant::now() < deadline {
        let state = handle
            .try_state()
            .map_err(|e| format!("Failed to inspect ptywright Claude state: {e}"))?;
        let screen = handle.session().snapshot().plain_text;
        if answer_looks_like_claude_error(&screen) {
            return Err(format!(
                "ptywright Claude reported an error: {}",
                extract_visible_answer(&screen, &state.evidence)
            ));
        }
        if state.state != last_log_state || last_log_at.elapsed() >= Duration::from_secs(2) {
            tracing::debug!(
                target: "claudette::agent",
                ptywright_state = %state.state,
                evidence = %state.evidence,
                sequence = state.sequence,
                metadata_keys = ?metadata_keys(state.metadata.as_ref()),
                "ptywright Claude prepare poll"
            );
            last_log_state = state.state.clone();
            last_log_at = Instant::now();
        }
        match state.state.as_str() {
            "ready" | "waiting_for_user_input" | "completed_turn" => return Ok(()),
            "cancelling" => {
                tracing::debug!(
                    target: "claudette::agent",
                    evidence = %state.evidence,
                    "ptywright Claude settling stale cancel before prompt"
                );
                settle_ptywright_cancel(handle);
                std::thread::sleep(POLL_INTERVAL);
            }
            "waiting_for_trust" => {
                if last_trust_approval_at.elapsed() < Duration::from_millis(500) {
                    std::thread::sleep(POLL_INTERVAL);
                    continue;
                }
                tracing::debug!(
                    target: "claudette::agent",
                    evidence = %state.evidence,
                    "ptywright Claude auto-approving workspace trust prompt"
                );
                handle
                    .send("approve_trust", json!({}))
                    .map_err(|e| format!("Failed to approve Claude workspace trust: {e}"))?;
                last_trust_approval_at = Instant::now();
                std::thread::sleep(Duration::from_millis(200));
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

fn cancel_ptywright_turn(handle: &mut ptywright::ExtensionHandle) -> Result<(), String> {
    handle
        .send("cancel", json!({}))
        .map_err(|e| format!("send cancel failed: {e}"))?;
    settle_ptywright_cancel(handle);
    Ok(())
}

fn settle_ptywright_cancel(handle: &mut ptywright::ExtensionHandle) {
    match handle.wait(
        "wait_cancel_settled_matcher",
        json!({}),
        CANCEL_SETTLE_TIMEOUT,
    ) {
        Ok((state, _)) => {
            tracing::debug!(
                target: "claudette::agent",
                ptywright_state = %state.state,
                evidence = %state.evidence,
                sequence = state.sequence,
                "ptywright Claude cancel settled"
            );
        }
        Err(error) => {
            tracing::debug!(
                target: "claudette::agent",
                error = %error,
                "ptywright Claude cancel settle wait did not complete"
            );
        }
    }
    handle.set_last_intent(None);
}

fn submit_prompt(handle: &mut ptywright::ExtensionHandle, prompt: &str) -> Result<(), String> {
    let first = submit_prompt_once(handle, prompt)?;
    if first {
        tracing::debug!(
            target: "claudette::agent",
            "ptywright Claude prompt accepted on first attempt"
        );
        return Ok(());
    }

    tracing::debug!(
        target: "claudette::agent",
        "ptywright Claude first prompt submit did not acknowledge; dismissing welcome and retrying"
    );
    let _ = handle.send("dismiss_welcome", json!({}));
    let second = submit_prompt_once(handle, prompt)?;
    if second {
        tracing::debug!(
            target: "claudette::agent",
            "ptywright Claude prompt accepted on second attempt"
        );
        return Ok(());
    }

    let _ = cancel_ptywright_turn(handle);
    Err("Claude did not accept the ptywright prompt paste; interactive runtime cancelled the half-submitted turn".to_string())
}

fn submit_prompt_once(
    handle: &mut ptywright::ExtensionHandle,
    prompt: &str,
) -> Result<bool, String> {
    let baseline = handle.session().transcript().len();
    tracing::debug!(
        target: "claudette::agent",
        baseline_transcript_len = baseline,
        prompt_len = prompt.len(),
        "ptywright Claude prompt send intent"
    );
    handle
        .send("send_prompt", json!({ "prompt": prompt }))
        .map_err(|e| format!("Failed to submit ptywright Claude prompt: {e}"))?;

    let prompt_anchor = prompt_anchor(prompt);
    let deadline = Instant::now() + PASTE_ACK_TIMEOUT;
    let mut last_log_at = Instant::now() - Duration::from_secs(60);
    let mut last_submit_nudge_at = Instant::now();
    while Instant::now() < deadline {
        let transcript = handle.session().transcript();
        let transcript_len = transcript.len();
        let grew = transcript_len.saturating_sub(baseline);
        let screen = handle.session().snapshot().plain_text;
        let state = handle
            .try_state()
            .map_err(|e| format!("Failed to inspect ptywright Claude submit state: {e}"))?;
        let anchored = !prompt_anchor.is_empty() && transcript.contains(&prompt_anchor);
        let editable_prompt = prompt_still_editable(&screen, &prompt_anchor);
        let submitted =
            prompt_submission_observed(grew, anchored, state.state.as_str(), editable_prompt);
        tracing::trace!(
            target: "claudette::agent",
            ptywright_state = %state.state,
            grew,
            anchored,
            editable_prompt,
            evidence = %state.evidence,
            "ptywright Claude prompt acknowledgement poll"
        );
        if last_log_at.elapsed() >= Duration::from_secs(1) {
            tracing::debug!(
                target: "claudette::agent",
                ptywright_state = %state.state,
                evidence = %state.evidence,
                transcript_len,
                grew,
                anchored,
                editable_prompt,
                submitted,
                screen_tail = %debug_tail(&screen, 500),
                "ptywright Claude prompt acknowledgement poll"
            );
            last_log_at = Instant::now();
        }

        if editable_prompt && last_submit_nudge_at.elapsed() >= SUBMIT_NUDGE_INTERVAL {
            tracing::debug!(
                target: "claudette::agent",
                ptywright_state = %state.state,
                evidence = %state.evidence,
                "ptywright Claude prompt still editable; nudging Enter"
            );
            handle
                .send("key", json!({ "key": "enter" }))
                .map_err(|e| format!("Failed to nudge ptywright Claude prompt submit: {e}"))?;
            last_submit_nudge_at = Instant::now();
        }

        if state.state == "error" || submitted {
            tracing::debug!(
                target: "claudette::agent",
                ptywright_state = %state.state,
                evidence = %state.evidence,
                transcript_len,
                grew,
                anchored,
                editable_prompt,
                "ptywright Claude prompt acknowledged"
            );
            return Ok(true);
        }

        std::thread::sleep(POLL_INTERVAL);
    }

    tracing::warn!(
        target: "claudette::agent",
        prompt_len = prompt.len(),
        baseline_transcript_len = baseline,
        transcript_len = handle.session().transcript().len(),
        screen_tail = %debug_tail(&handle.session().snapshot().plain_text, 800),
        "ptywright Claude prompt acknowledgement timed out"
    );
    Ok(false)
}

fn extract_turn_answer(
    handle: &ptywright::ExtensionHandle,
    state: &ptywright::ExtensionStateSnapshot,
    prompt: &str,
    working_dir: &Path,
    claude_session_id: &str,
) -> String {
    if let Some(answer) = latest_claude_jsonl_assistant_text(working_dir, claude_session_id) {
        tracing::debug!(
            target: "claudette::agent",
            response_len = answer.len(),
            "ptywright Claude extracted assistant text from Claude JSONL transcript"
        );
        return answer;
    }

    if let Some((turn_start, turn_end)) = transcript_bounds(handle, state) {
        if let Some(slice) = handle.session().transcript_slice(turn_start, turn_end) {
            if let Some(answer) = clean_transcript_answer(&slice, prompt) {
                tracing::debug!(
                    target: "claudette::agent",
                    turn_start,
                    turn_end,
                    response_len = answer.len(),
                    "ptywright Claude extracted transcript turn text"
                );
                return answer;
            }
            tracing::debug!(
                target: "claudette::agent",
                turn_start,
                turn_end,
                "ptywright Claude transcript slice had no current-turn answer"
            );
            if let Some(answer) = clean_transcript_answer_from_start(handle, turn_start, prompt) {
                tracing::debug!(
                    target: "claudette::agent",
                    turn_start,
                    transcript_len = handle.session().transcript().len(),
                    response_len = answer.len(),
                    "ptywright Claude extracted expanded transcript turn text"
                );
                return answer;
            }
            if let Some(text) = current_structured_turn_text(handle, state, prompt) {
                tracing::debug!(
                    target: "claudette::agent",
                    turn_start,
                    turn_end,
                    response_len = text.len(),
                    "ptywright Claude extracted structured turn text after transcript filter"
                );
                return text.to_string();
            }
        } else if let Some(text) = structured_turn_text(state) {
            tracing::debug!(
                target: "claudette::agent",
                turn_start,
                turn_end,
                response_len = text.len(),
                "ptywright Claude extracted structured turn text after transcript eviction"
            );
            return text.to_string();
        }
    } else if let Some(text) = structured_turn_text(state) {
        tracing::debug!(
            target: "claudette::agent",
            response_len = text.len(),
            "ptywright Claude extracted structured turn text"
        );
        return text.to_string();
    }

    let screen = handle.session().snapshot().plain_text;
    tracing::debug!(
        target: "claudette::agent",
        ptywright_state = %state.state,
        evidence = %state.evidence,
        screen_len = screen.len(),
        "ptywright Claude falling back to visible screen text"
    );
    extract_visible_answer(&screen, state.evidence.as_str())
}

fn current_turn_has_answer(
    handle: &ptywright::ExtensionHandle,
    state: &ptywright::ExtensionStateSnapshot,
    prompt: &str,
) -> bool {
    if let Some((turn_start, turn_end)) = transcript_bounds(handle, state)
        && let Some(slice) = handle.session().transcript_slice(turn_start, turn_end)
        && clean_transcript_answer(&slice, prompt).is_some()
    {
        return true;
    }

    if let Some((turn_start, _)) = transcript_bounds(handle, state)
        && clean_transcript_answer_from_start(handle, turn_start, prompt).is_some()
    {
        return true;
    }

    current_structured_turn_text(handle, state, prompt).is_some()
}

fn current_structured_turn_text<'a>(
    handle: &ptywright::ExtensionHandle,
    state: &'a ptywright::ExtensionStateSnapshot,
    prompt: &str,
) -> Option<&'a str> {
    let text = structured_turn_text(state)?;
    if current_prompt_still_editable(handle, prompt) {
        None
    } else {
        Some(text)
    }
}

fn structured_turn_text(state: &ptywright::ExtensionStateSnapshot) -> Option<&str> {
    state
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("turn"))
        .and_then(|turn| turn.get("text"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
}

fn structured_partial_turn_text(state: &ptywright::ExtensionStateSnapshot) -> Option<&str> {
    state
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("turn"))
        .and_then(|turn| turn.get("partial_text"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
}

fn latest_claude_jsonl_assistant_text(working_dir: &Path, session_id: &str) -> Option<String> {
    let transcript_path = claude_jsonl_transcript_path(working_dir, session_id)?;
    if !transcript_path.is_file() {
        return None;
    }
    for attempt in 0..5 {
        if let Some(text) = assistant_text_from_jsonl_transcript(&transcript_path) {
            return Some(text);
        }
        if attempt < 4 {
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    None
}

fn claude_jsonl_transcript_path(working_dir: &Path, session_id: &str) -> Option<PathBuf> {
    let projects_dir = claude_projects_dir()?;
    Some(
        projects_dir
            .join(claude_project_slug(working_dir))
            .join(format!("{session_id}.jsonl")),
    )
}

fn claude_projects_dir() -> Option<PathBuf> {
    if let Some(config_dir) = env::var_os("CLAUDE_CONFIG_DIR")
        && !config_dir.is_empty()
    {
        return Some(PathBuf::from(config_dir).join("projects"));
    }
    dirs::home_dir().map(|home| home.join(".claude").join("projects"))
}

fn claude_project_slug(path: &Path) -> String {
    path.to_string_lossy().replace(['/', '\\', '.'], "-")
}

fn assistant_text_from_jsonl_transcript(path: &Path) -> Option<String> {
    let content = fs::read_to_string(path).ok()?;
    content
        .lines()
        .rev()
        .find_map(assistant_text_from_jsonl_line)
}

fn assistant_text_from_jsonl_line(line: &str) -> Option<String> {
    let value: Value = serde_json::from_str(line).ok()?;
    if value.get("type")?.as_str()? != "assistant" {
        return None;
    }
    let message = value.get("message")?;
    if message.get("role")?.as_str()? != "assistant" {
        return None;
    }
    let content = message.get("content")?.as_array()?;
    let text_blocks = content
        .iter()
        .filter_map(|block| {
            if block.get("type")?.as_str()? == "text" {
                Some(block.get("text")?.as_str()?.trim())
            } else {
                None
            }
        })
        .filter(|text| !text.is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();

    (!text_blocks.is_empty()).then(|| text_blocks.join("\n\n"))
}

fn current_prompt_still_editable(handle: &ptywright::ExtensionHandle, prompt: &str) -> bool {
    let screen = handle.session().snapshot().plain_text;
    prompt_still_editable(&screen, &prompt_anchor(prompt))
}

fn prompt_anchor(prompt: &str) -> String {
    prompt
        .trim()
        .lines()
        .next()
        .unwrap_or_default()
        .chars()
        .take(40)
        .collect::<String>()
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

fn clean_transcript_answer_from_start(
    handle: &ptywright::ExtensionHandle,
    turn_start: u64,
    prompt: &str,
) -> Option<String> {
    let end = u64::try_from(handle.session().transcript().len()).ok()?;
    if end <= turn_start {
        return None;
    }
    let slice = handle.session().transcript_slice(turn_start, end)?;
    clean_transcript_answer(&slice, prompt)
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
        || is_tool_status_line(line)
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

fn is_tool_status_line(line: &str) -> bool {
    line.starts_with('⎿')
        || line == "(No output)"
        || line.starts_with("Allowed by auto mode classifier")
        || line.contains("⎿  Allowed by auto mode classifier")
        || line.contains("⎿  (No output)")
        || line.contains("Allowed by auto mode classifier ")
        || line == "Recalling"
        || (line.starts_with("Recalling ") && line.contains(" memory") && line.ends_with('…'))
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
        || lower.contains("no conversation found with session id")
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

fn prompt_submission_observed(
    grew: usize,
    anchored: bool,
    ptywright_state: &str,
    editable_prompt: bool,
) -> bool {
    grew >= PASTE_REACTION_BYTES
        && !editable_prompt
        && (anchored || ptywright_state == "thinking" || ptywright_state == "completed_turn")
}

fn prompt_still_editable(screen: &str, prompt_anchor: &str) -> bool {
    if prompt_anchor.is_empty() {
        return false;
    }

    let lines: Vec<&str> = screen.lines().collect();
    let Some(prompt_index) = lines.iter().enumerate().rev().find_map(|(index, line)| {
        let trimmed = line.trim();
        if is_prompt_line(trimmed) && trimmed.contains(prompt_anchor) {
            Some(index)
        } else {
            None
        }
    }) else {
        return false;
    };

    lines[prompt_index + 1..]
        .iter()
        .all(|line| is_prompt_trailing_chrome(line))
}

fn is_prompt_line(line: &str) -> bool {
    line.starts_with("❯ ") || line.starts_with("❯\u{00a0}") || line.starts_with("> ")
}

fn has_visible_input_prompt(screen: &str) -> bool {
    screen.lines().any(|line| {
        let trimmed = line.trim();
        trimmed == "❯" || trimmed == ">" || is_prompt_line(trimmed)
    })
}

fn is_prompt_trailing_chrome(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed.is_empty()
        || trimmed == "❯"
        || trimmed == ">"
        || is_horizontal_rule(trimmed)
        || trimmed.contains("⏵⏵")
        || trimmed.contains(" @ ")
        || trimmed.contains("· /")
        || trimmed.contains("Claude in Chrome enabled")
        || trimmed.contains("MCP server failed")
        || trimmed.contains("connectors need auth")
        || trimmed.contains("/effort")
}

fn metadata_keys(metadata: Option<&serde_json::Value>) -> Vec<String> {
    metadata
        .and_then(serde_json::Value::as_object)
        .map(|object| object.keys().cloned().collect())
        .unwrap_or_default()
}

fn debug_tail(text: &str, max_chars: usize) -> String {
    let mut chars = text.chars().rev().take(max_chars).collect::<Vec<_>>();
    chars.reverse();
    chars.into_iter().collect()
}

struct PtywrightToolActivityEmitter {
    active: std::collections::BTreeMap<String, EmittedPtywrightTool>,
    completed_keys: BTreeSet<String>,
    next_index: usize,
}

#[derive(Clone, Debug, PartialEq)]
struct VisiblePtywrightTool {
    key: String,
    name: String,
    summary: String,
    status: String,
    input: Value,
}

struct EmittedPtywrightTool {
    id: String,
    index: usize,
    name: String,
    summary: String,
}

impl PtywrightToolActivityEmitter {
    fn observe_state(
        &mut self,
        state: &ptywright::ExtensionStateSnapshot,
        screen: &str,
        broadcast_tx: &broadcast::Sender<AgentEvent>,
        turn_tx: &mpsc::Sender<AgentEvent>,
    ) {
        let visible = metadata_visible_tools(state)
            .or_else(|| visible_ptywright_tool(screen).map(|tool| vec![tool]))
            .unwrap_or_default();
        let visible_keys = visible
            .iter()
            .map(|tool| tool.key.clone())
            .collect::<BTreeSet<_>>();

        let mut finished = Vec::new();
        for key in self.active.keys() {
            let visible_tool = visible.iter().find(|tool| &tool.key == key);
            if visible_tool.is_none_or(|tool| tool.status != "running") {
                finished.push(key.clone());
            }
        }
        for key in finished {
            self.finish_key(&key, broadcast_tx, turn_tx, "completed");
        }

        for tool in visible {
            if self.active.contains_key(&tool.key) || self.completed_keys.contains(&tool.key) {
                continue;
            }
            let key = tool.key.clone();
            let status = tool.status.clone();
            self.start_tool(tool, state.sequence, broadcast_tx, turn_tx);
            if status != "running" {
                self.finish_key(&key, broadcast_tx, turn_tx, "completed");
            }
        }

        for key in self
            .active
            .keys()
            .filter(|key| !visible_keys.contains(*key))
            .cloned()
            .collect::<Vec<_>>()
        {
            self.finish_key(&key, broadcast_tx, turn_tx, "completed");
        }
    }

    fn start_tool(
        &mut self,
        visible: VisiblePtywrightTool,
        sequence: u64,
        broadcast_tx: &broadcast::Sender<AgentEvent>,
        turn_tx: &mpsc::Sender<AgentEvent>,
    ) {
        let index = self.next_index;
        self.next_index += 1;
        let id = format!("ptywright-tool-{sequence}-{index}");
        let input = visible.input.clone();
        self.completed_keys.insert(visible.key.clone());
        tracing::debug!(
            target: "claudette::agent",
            tool_use_id = %id,
            tool_name = %visible.name,
            summary = %visible.summary,
            "ptywright Claude observed visible tool activity"
        );
        send_event(
            broadcast_tx,
            turn_tx,
            AgentEvent::Stream(StreamEvent::Stream {
                event: InnerStreamEvent::ContentBlockStart {
                    index,
                    content_block: Some(StartContentBlock::ToolUse {
                        id: id.clone(),
                        name: visible.name.clone(),
                        input: Some(input),
                    }),
                },
            }),
        );
        self.active.insert(
            visible.key.clone(),
            EmittedPtywrightTool {
                id,
                index,
                name: visible.name,
                summary: visible.summary,
            },
        );
    }

    fn finish_key(
        &mut self,
        key: &str,
        broadcast_tx: &broadcast::Sender<AgentEvent>,
        turn_tx: &mpsc::Sender<AgentEvent>,
        status: &str,
    ) {
        let Some(active) = self.active.remove(key) else {
            return;
        };
        send_event(
            broadcast_tx,
            turn_tx,
            AgentEvent::Stream(StreamEvent::Stream {
                event: InnerStreamEvent::ContentBlockStop {
                    index: active.index,
                },
            }),
        );
        send_event(
            broadcast_tx,
            turn_tx,
            AgentEvent::Stream(StreamEvent::User {
                message: UserEventMessage {
                    content: UserMessageContent::Blocks(vec![UserContentBlock::ToolResult {
                        tool_use_id: active.id.clone(),
                        content: json!({
                            "status": status,
                            "summary": active.summary,
                            "source": "ptywright-screen"
                        }),
                    }]),
                },
                uuid: None,
                is_replay: false,
                is_synthetic: true,
            }),
        );
        tracing::debug!(
            target: "claudette::agent",
            tool_use_id = %active.id,
            tool_name = %active.name,
            status,
            "ptywright Claude completed visible tool activity"
        );
    }

    fn finish_all(
        &mut self,
        broadcast_tx: &broadcast::Sender<AgentEvent>,
        turn_tx: &mpsc::Sender<AgentEvent>,
        status: &str,
    ) {
        for key in self.active.keys().cloned().collect::<Vec<_>>() {
            self.finish_key(&key, broadcast_tx, turn_tx, status);
        }
    }
}

impl Default for PtywrightToolActivityEmitter {
    fn default() -> Self {
        Self {
            active: std::collections::BTreeMap::new(),
            completed_keys: BTreeSet::new(),
            next_index: 1,
        }
    }
}

#[derive(Default)]
struct PtywrightAssistantTextEmitter {
    started: bool,
    emitted: String,
}

impl PtywrightAssistantTextEmitter {
    fn observe_state(
        &mut self,
        state: &ptywright::ExtensionStateSnapshot,
        broadcast_tx: &broadcast::Sender<AgentEvent>,
        turn_tx: &mpsc::Sender<AgentEvent>,
    ) {
        let Some(text) =
            structured_partial_turn_text(state).or_else(|| structured_turn_text(state))
        else {
            return;
        };
        self.emit_to(text, broadcast_tx, turn_tx);
    }

    fn finish(
        &mut self,
        broadcast_tx: &broadcast::Sender<AgentEvent>,
        turn_tx: &mpsc::Sender<AgentEvent>,
    ) {
        if self.emitted.is_empty() {
            return;
        }
        send_event(
            broadcast_tx,
            turn_tx,
            AgentEvent::Stream(StreamEvent::Stream {
                event: InnerStreamEvent::ContentBlockStop { index: 0 },
            }),
        );
        send_event(
            broadcast_tx,
            turn_tx,
            AgentEvent::Stream(StreamEvent::Stream {
                event: InnerStreamEvent::MessageStop {},
            }),
        );
    }

    fn emit_to(
        &mut self,
        text: &str,
        broadcast_tx: &broadcast::Sender<AgentEvent>,
        turn_tx: &mpsc::Sender<AgentEvent>,
    ) {
        if text.len() <= self.emitted.len() || !text.starts_with(&self.emitted) {
            return;
        }
        if !self.started {
            self.started = true;
            send_event(
                broadcast_tx,
                turn_tx,
                AgentEvent::Stream(StreamEvent::Stream {
                    event: InnerStreamEvent::MessageStart {},
                }),
            );
            send_event(
                broadcast_tx,
                turn_tx,
                AgentEvent::Stream(StreamEvent::Stream {
                    event: InnerStreamEvent::ContentBlockStart {
                        index: 0,
                        content_block: Some(StartContentBlock::Text {}),
                    },
                }),
            );
        }
        let delta = text[self.emitted.len()..].to_string();
        self.emitted.push_str(&delta);
        send_event(
            broadcast_tx,
            turn_tx,
            AgentEvent::Stream(StreamEvent::Stream {
                event: InnerStreamEvent::ContentBlockDelta {
                    index: 0,
                    delta: Delta::Text { text: delta },
                },
            }),
        );
    }
}

fn visible_ptywright_tool(screen: &str) -> Option<VisiblePtywrightTool> {
    let lines = screen.lines().collect::<Vec<_>>();
    if let Some(tool) = visible_ptywright_edit(&lines) {
        return Some(tool);
    }

    for (index, line) in lines.iter().enumerate().rev() {
        let trimmed = line.trim();
        if let Some(name) = trimmed
            .strip_prefix("● Running tool:")
            .or_else(|| trimmed.strip_prefix("⏺ Running tool:"))
            .map(str::trim)
            .filter(|name| !name.is_empty())
        {
            let summary = next_tool_summary(&lines, index + 1).unwrap_or_else(|| name.to_string());
            let summary = clean_tool_summary(&summary);
            let input = tool_input(name, &summary, &[])?;
            return Some(VisiblePtywrightTool {
                key: format!("running:{name}:{summary}"),
                name: name.to_string(),
                summary,
                status: "running".to_string(),
                input,
            });
        }

        let Some(rest) = trimmed.strip_prefix("⏺").map(str::trim) else {
            continue;
        };
        if !(rest.contains("(ctrl+o to expand)") || rest.ends_with('…')) {
            continue;
        }
        let summary = clean_tool_summary(rest);
        let name = infer_tool_name_from_progress(rest);
        let paths = tool_callout_paths(&lines, index + 1);
        let input = tool_input(&name, &summary, &paths)?;
        let key_detail = if paths.is_empty() {
            summary.clone()
        } else {
            paths.join(",")
        };
        return Some(VisiblePtywrightTool {
            key: format!("progress:{name}:{key_detail}"),
            name,
            summary,
            status: "running".to_string(),
            input,
        });
    }
    None
}

fn metadata_visible_tools(
    state: &ptywright::ExtensionStateSnapshot,
) -> Option<Vec<VisiblePtywrightTool>> {
    let tools = state
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("tools"))
        .and_then(Value::as_array)?;
    let parsed = tools
        .iter()
        .filter_map(|tool| {
            let name = tool.get("name")?.as_str()?.trim();
            if name.is_empty() {
                return None;
            }
            let summary = tool
                .get("summary")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|summary| !summary.is_empty())
                .unwrap_or(name);
            let key = tool
                .get("key")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| format!("{name}:{summary}"));
            let status = tool
                .get("status")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|status| !status.is_empty())
                .unwrap_or("completed");
            let input = tool.get("input").cloned().unwrap_or_else(|| {
                tool_input(name, summary, &[]).unwrap_or_else(|| json!({ "description": summary }))
            });
            Some(VisiblePtywrightTool {
                key: format!("metadata:{key}"),
                name: name.to_string(),
                summary: summary.to_string(),
                status: status.to_string(),
                input,
            })
        })
        .collect::<Vec<_>>();
    (!parsed.is_empty()).then_some(parsed)
}

#[derive(Clone, Debug)]
struct VisibleDiffLine {
    sign: char,
    line_number: Option<usize>,
    content: String,
}

fn visible_ptywright_edit(lines: &[&str]) -> Option<VisiblePtywrightTool> {
    let mut groups: Vec<(usize, Vec<VisibleDiffLine>)> = Vec::new();
    let mut current_start = 0;
    let mut current = Vec::new();

    for (index, line) in lines.iter().enumerate() {
        if let Some(diff_line) = parse_visible_diff_line(line) {
            if current.is_empty() {
                current_start = index;
            }
            current.push(diff_line);
        } else if !current.is_empty() {
            groups.push((current_start, std::mem::take(&mut current)));
        }
    }
    if !current.is_empty() {
        groups.push((current_start, current));
    }

    let (start, group) = groups
        .into_iter()
        .rev()
        .find(|(_, group)| visible_diff_group_has_edit(group))?;
    let path = latest_tool_callout_path_before(lines, start).unwrap_or_else(|| "unknown".into());
    let patch = synthetic_patch_for_visible_diff(&path, &group);
    let summary = path.clone();
    Some(VisiblePtywrightTool {
        key: format!("edit:{path}:{}", stable_key_suffix(&patch)),
        name: "Edit".to_string(),
        summary,
        status: "completed".to_string(),
        input: json!({
            "file_path": path,
            "patch": patch
        }),
    })
}

fn parse_visible_diff_line(line: &str) -> Option<VisibleDiffLine> {
    let trimmed = line.trim_start();
    let mut digit_end = 0;
    for (index, ch) in trimmed.char_indices() {
        if ch.is_ascii_digit() {
            digit_end = index + ch.len_utf8();
        } else {
            break;
        }
    }

    let line_number = if digit_end > 0 {
        trimmed[..digit_end].parse::<usize>().ok()
    } else {
        None
    };
    let rest = if digit_end > 0 {
        trimmed[digit_end..].trim_start()
    } else {
        trimmed
    };
    if rest.starts_with("+++") || rest.starts_with("---") {
        return None;
    }
    let sign = rest.chars().next()?;
    if sign != '+' && sign != '-' {
        return None;
    }
    let content = rest[sign.len_utf8()..].trim_start().to_string();
    if line_number.is_none() && looks_like_file_list_entry(&content) {
        return None;
    }
    Some(VisibleDiffLine {
        sign,
        line_number,
        content,
    })
}

fn visible_diff_group_has_edit(group: &[VisibleDiffLine]) -> bool {
    group.iter().any(|line| line.line_number.is_some())
        && group
            .iter()
            .any(|line| line.sign == '+' || line.sign == '-')
}

fn looks_like_file_list_entry(content: &str) -> bool {
    let trimmed = content.trim();
    !trimmed.is_empty()
        && !trimmed.contains(' ')
        && (trimmed.contains('/') || trimmed.contains('.'))
}

fn synthetic_patch_for_visible_diff(path: &str, group: &[VisibleDiffLine]) -> String {
    let old_start = group
        .iter()
        .find(|line| line.sign == '-')
        .and_then(|line| line.line_number)
        .or_else(|| group.iter().find_map(|line| line.line_number))
        .unwrap_or(1);
    let new_start = group
        .iter()
        .find(|line| line.sign == '+')
        .and_then(|line| line.line_number)
        .unwrap_or(old_start);
    let mut lines = vec![
        format!("diff --git a/{path} b/{path}"),
        format!("--- a/{path}"),
        format!("+++ b/{path}"),
        format!("@@ -{old_start} +{new_start} @@"),
    ];
    lines.extend(
        group
            .iter()
            .map(|line| format!("{}{}", line.sign, line.content)),
    );
    lines.join("\n")
}

fn stable_key_suffix(value: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    value.hash(&mut hasher);
    hasher.finish()
}

fn tool_input(name: &str, summary: &str, paths: &[String]) -> Option<Value> {
    let path = paths
        .first()
        .cloned()
        .or_else(|| path_from_tool_summary(summary));
    match name {
        "Read" | "Write" | "Edit" => path.map(|path| json!({ "file_path": path })),
        "Grep" => Some(json!({ "pattern": summary })),
        "LS" => Some(json!({ "path": path.unwrap_or_else(|| ".".to_string()) })),
        "Bash" => Some(json!({
            "command": summary.strip_prefix("$ ").unwrap_or(summary)
        })),
        _ => Some(json!({ "description": summary })),
    }
}

fn path_from_tool_summary(summary: &str) -> Option<String> {
    summary
        .split_whitespace()
        .rev()
        .find_map(clean_path_candidate)
}

fn tool_callout_paths(lines: &[&str], start: usize) -> Vec<String> {
    let mut paths = Vec::new();
    for line in lines.iter().skip(start).take(12) {
        let trimmed = line.trim();
        if trimmed.starts_with('⏺')
            || trimmed.starts_with('●')
            || trimmed.starts_with('✻')
            || is_prompt_line(trimmed)
            || is_horizontal_rule(trimmed)
        {
            break;
        }
        if let Some(path) = tool_callout_path(trimmed) {
            paths.push(path);
        }
    }
    paths
}

fn latest_tool_callout_path_before(lines: &[&str], before: usize) -> Option<String> {
    lines[..before.min(lines.len())]
        .iter()
        .rev()
        .find_map(|line| tool_callout_path(line.trim()))
}

fn tool_callout_path(trimmed: &str) -> Option<String> {
    let rest = trimmed.strip_prefix('⎿')?.trim();
    clean_path_candidate(rest)
}

fn clean_path_candidate(candidate: &str) -> Option<String> {
    let path = candidate
        .trim()
        .trim_matches(|c| matches!(c, '`' | '\'' | '"' | ',' | ';' | ':' | ')' | '('));
    if path.is_empty() || path.len() > 512 || path.contains('\n') {
        return None;
    }
    if path.starts_with("$ ") || path.starts_with("Tip:") || path.starts_with("tip:") {
        return None;
    }
    if path.contains('/') || path.contains('.') || path.starts_with('~') {
        Some(path.to_string())
    } else {
        None
    }
}

fn clean_tool_summary(summary: &str) -> String {
    summary
        .replace("(ctrl+o to expand)", "")
        .replace("(ctrl+O to expand)", "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

fn next_tool_summary(lines: &[&str], start: usize) -> Option<String> {
    for line in lines.iter().skip(start) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if is_tool_summary_chrome(trimmed) {
            continue;
        }
        return Some(trimmed.to_string());
    }
    None
}

fn is_tool_summary_chrome(line: &str) -> bool {
    line == "Esc to interrupt"
        || is_horizontal_rule(line)
        || is_prompt_line(line)
        || line.contains("⏵⏵")
        || line.contains(" @ ")
        || line.contains("· /")
}

fn infer_tool_name_from_progress(progress: &str) -> String {
    let first = progress
        .split(|c: char| c.is_whitespace() || c == '(' || c == ':')
        .next()
        .unwrap_or("Tool")
        .trim_matches(|c: char| !c.is_alphanumeric() && c != '-' && c != '_');
    match first {
        "Reading" | "Read" => "Read",
        "Searching" | "Search" | "Grep" => "Grep",
        "Listing" | "List" => "LS",
        "Running" | "Bash" => "Bash",
        "Writing" | "Write" => "Write",
        "Updating" | "Editing" | "Edit" => "Edit",
        "" => "Tool",
        other => other,
    }
    .to_string()
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
    fn transcript_answer_filters_tool_status_chrome() {
        let transcript = "\
❯ continue
Recalling
Recalling 1 memory…
⎿  (No output)
⎿  Allowed by auto mode classifier Bash(git -C /tmp/project log main..branch --oneline)
⎿  (No output)
The branch is identical to main — no commits ahead.
Could you remind me what we were working on?
✻ Done for 28s";

        assert_eq!(
            clean_transcript_answer(transcript, "continue").as_deref(),
            Some(
                "The branch is identical to main — no commits ahead.\nCould you remind me what we were working on?"
            )
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
    fn editable_prompt_detection_matches_unsubmitted_claude_input() {
        let screen = "\
 ▐▛███▜▌   Claude Code v2.1.150
▝▜█████▛▘  Sonnet 4.6 · Claude Max

────────────────────────────────────────────────────────────────────────────────
❯\u{00a0}tell me about this project
────────────────────────────────────────────────────────────────────────────────
  jamesbrink @ halcyon workspaces/claudex/brazen-cedar  james-brink/project-i…
  ⏵⏵ auto mode on (shift+tab to cycle)
                                            Claude in Chrome enabled · /chrome";

        assert!(prompt_still_editable(screen, "tell me about this project"));
    }

    #[test]
    fn editable_prompt_detection_releases_after_spinner_starts() {
        let screen = "\
❯ ping

✽ Sautéing…

────────────────────────────────────────────────────────────────────────────────
❯\u{00a0}
────────────────────────────────────────────────────────────────────────────────
  jamesbrink @ halcyon workspaces/claudex/brazen-cedar
  ⏵⏵ auto mode on (shift+tab to cycle)";

        assert!(!prompt_still_editable(screen, "ping"));
    }

    #[test]
    fn editable_prompt_detection_releases_after_answer_completes() {
        let screen = "\
❯ ping

⏺ pong

✻ Baked for 4s

────────────────────────────────────────────────────────────────────────────────
❯\u{00a0}
────────────────────────────────────────────────────────────────────────────────
  jamesbrink @ halcyon workspaces/claudex/brazen-cedar
                                       2 claude.ai connectors need auth · /mcp";

        assert!(!prompt_still_editable(screen, "ping"));
    }

    #[test]
    fn prompt_submission_ack_rejects_stale_completed_turn_when_prompt_still_editable() {
        assert!(!prompt_submission_observed(
            PASTE_REACTION_BYTES + 1,
            true,
            "completed_turn",
            true,
        ));
    }

    #[test]
    fn prompt_submission_ack_accepts_completed_turn_after_prompt_leaves_input() {
        assert!(prompt_submission_observed(
            PASTE_REACTION_BYTES + 1,
            true,
            "completed_turn",
            false,
        ));
    }

    #[test]
    fn prompt_submission_ack_accepts_thinking_after_prompt_leaves_input() {
        assert!(prompt_submission_observed(
            PASTE_REACTION_BYTES + 1,
            false,
            "thinking",
            false,
        ));
    }

    #[test]
    fn visible_tool_activity_parses_running_tool_row() {
        let screen = "\
Claude Code

● Running tool: Edit
  Updating src/lib.rs

Esc to interrupt";

        assert_eq!(
            visible_ptywright_tool(screen),
            Some(VisiblePtywrightTool {
                key: "running:Edit:Updating src/lib.rs".to_string(),
                name: "Edit".to_string(),
                summary: "Updating src/lib.rs".to_string(),
                status: "running".to_string(),
                input: json!({
                    "file_path": "src/lib.rs"
                }),
            })
        );
    }

    #[test]
    fn visible_tool_activity_parses_collapsible_progress_row() {
        let screen = "\
❯ explore

⏺ Reading 3 files… (ctrl+o to expand)

────────────────────────────────────────────────────────────────────────────────";

        assert!(visible_ptywright_tool(screen).is_none());
    }

    #[test]
    fn visible_tool_activity_parses_read_file_path_from_callout() {
        let screen = "\
 README.md

⏺ Reading 1 file… (ctrl+o to expand)
  ⎿  README.md

────────────────────────────────────────────────────────────────────────────────";

        assert_eq!(
            visible_ptywright_tool(screen),
            Some(VisiblePtywrightTool {
                key: "progress:Read:README.md".to_string(),
                name: "Read".to_string(),
                summary: "Reading 1 file…".to_string(),
                status: "running".to_string(),
                input: json!({
                    "file_path": "README.md"
                }),
            })
        );
    }

    #[test]
    fn visible_tool_activity_ignores_pathless_read_chrome_callouts() {
        let screen = "\
⏺ Reading 1 file… (ctrl+o to expand)
  ⎿  Tip: Use /theme to change the color theme
  ⎿  $ ls website/content

────────────────────────────────────────────────────────────────────────────────";

        assert!(visible_ptywright_tool(screen).is_none());
    }

    #[test]
    fn visible_tool_activity_uses_standard_grep_input_shape() {
        let screen = "\
❯ are the docs up to date?

⏺ Searching for 1 pattern, reading 2 files… (ctrl+o to expand)

────────────────────────────────────────────────────────────────────────────────";

        assert_eq!(
            visible_ptywright_tool(screen),
            Some(VisiblePtywrightTool {
                key: "progress:Grep:Searching for 1 pattern, reading 2 files…".to_string(),
                name: "Grep".to_string(),
                summary: "Searching for 1 pattern, reading 2 files…".to_string(),
                status: "running".to_string(),
                input: json!({
                    "pattern": "Searching for 1 pattern, reading 2 files…"
                }),
            })
        );
    }

    #[test]
    fn visible_tool_activity_parses_edit_diff_from_visible_hunk() {
        let screen = "\
⏺ Reading 1 file… (ctrl+o to expand)
  ⎿  README.md

  32 -All four paths are supported.
  32 +All four install paths are supported.

✻ Worked for 2s";

        let tool = visible_ptywright_tool(screen).expect("visible edit");
        assert_eq!(tool.name, "Edit");
        assert_eq!(tool.summary, "README.md");
        assert_eq!(tool.input["file_path"], "README.md");
        let patch = tool.input["patch"].as_str().expect("patch");
        assert!(patch.contains("diff --git a/README.md b/README.md"));
        assert!(patch.contains("-All four paths are supported."));
        assert!(patch.contains("+All four install paths are supported."));
    }

    #[test]
    fn ptywright_metadata_surfaces_visible_tool_calls() {
        let mut state = ptywright::ExtensionStateSnapshot::new("thinking", 17);
        state.metadata = Some(json!({
            "tools": [
                {
                    "key": "Read:README.md",
                    "name": "Read",
                    "summary": "README.md",
                    "status": "completed",
                    "input": { "file_path": "README.md" }
                },
                {
                    "key": "Bash:git status",
                    "name": "Bash",
                    "summary": "$ git status",
                    "status": "running",
                    "input": { "command": "git status" }
                }
            ]
        }));

        assert_eq!(
            metadata_visible_tools(&state),
            Some(vec![
                VisiblePtywrightTool {
                    key: "metadata:Read:README.md".to_string(),
                    name: "Read".to_string(),
                    summary: "README.md".to_string(),
                    status: "completed".to_string(),
                    input: json!({ "file_path": "README.md" }),
                },
                VisiblePtywrightTool {
                    key: "metadata:Bash:git status".to_string(),
                    name: "Bash".to_string(),
                    summary: "$ git status".to_string(),
                    status: "running".to_string(),
                    input: json!({ "command": "git status" }),
                }
            ])
        );
    }

    #[test]
    fn ptywright_partial_turn_text_reads_structured_metadata() {
        let mut state = ptywright::ExtensionStateSnapshot::new("thinking", 23);
        state.metadata = Some(json!({
            "turn": {
                "partial_text": "**Heading**\n\nLive paragraph."
            }
        }));

        assert_eq!(
            structured_partial_turn_text(&state),
            Some("**Heading**\n\nLive paragraph.")
        );
    }

    #[test]
    fn assistant_text_from_jsonl_preserves_markdown_newlines() {
        let line = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hidden"},{"type":"text","text":"**Heading**\n\nFirst paragraph.\n\n- One\n- Two"}]}}"#;

        assert_eq!(
            assistant_text_from_jsonl_line(line),
            Some("**Heading**\n\nFirst paragraph.\n\n- One\n- Two".to_string())
        );
    }

    #[test]
    fn tool_summary_strips_terminal_expand_hint() {
        assert_eq!(
            clean_tool_summary("Reading 1 file… (ctrl+o to expand)"),
            "Reading 1 file…"
        );
    }

    #[test]
    fn visible_tool_activity_ignores_answer_bullets() {
        let screen = "\
❯ explain

⏺ This is normal assistant prose.

✻ Worked for 2s
❯\u{00a0}";

        assert!(visible_ptywright_tool(screen).is_none());
    }

    #[test]
    fn claude_access_banner_is_treated_as_error() {
        assert!(answer_looks_like_claude_error(
            "Your organization has disabled Claude subscription access for Claude Code"
        ));
    }

    #[test]
    fn claude_missing_conversation_banner_is_treated_as_error() {
        assert!(answer_looks_like_claude_error(
            "No conversation found with session ID: de60e996-0fd3-41fc-940b-d404f7890869"
        ));
    }

    #[test]
    fn ptywright_args_include_selected_model() {
        let settings = AgentSettings {
            model: Some("opus".to_string()),
            ..AgentSettings::default()
        };

        assert_eq!(
            build_ptywright_claude_args("session-1", true, &settings),
            ["--resume", "session-1", "--model", "opus"]
        );
    }

    #[test]
    fn ptywright_args_seed_new_session_id() {
        let settings = AgentSettings::default();

        assert_eq!(
            build_ptywright_claude_args("session-1", false, &settings),
            ["--session-id", "session-1"]
        );
    }
}
