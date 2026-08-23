use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::Duration,
};

use tauri::{AppHandle, Emitter, Manager};

use claudette::agent::background::{
    AgentBackgroundTaskEvent, AgentBackgroundTaskEventKind, append_terminal_output_sync,
    parse_bash_start, parse_task_notification, workspace_terminal_output_path,
};
use claudette::agent::workflow_progress::WorkflowActivityStatusEvent;
use claudette::agent::{
    AgentEvent, InnerStreamEvent, StartContentBlock, StreamEvent, WorkflowProgressEntry,
};
use claudette::chat::{
    BuildAssistantArgs, assistant_usage_fields_from_result, build_assistant_chat_message,
    extract_assistant_text, extract_event_thinking,
};
use claudette::db::{CLAUDETTE_TERMINAL_TITLE, Database};
use claudette::model::{TerminalTab, TerminalTabKind};

use crate::commands::chat::{AgentStreamPayload, now_iso};
use crate::state::{AgentSessionState, AppState};

pub(super) fn emit_agent_background_task_event(
    app: &AppHandle,
    kind: AgentBackgroundTaskEventKind,
    workspace_id: &str,
    chat_session_id: &str,
    tab: TerminalTab,
) {
    let payload = AgentBackgroundTaskEvent {
        kind,
        workspace_id: workspace_id.to_string(),
        chat_session_id: chat_session_id.to_string(),
        tab,
    };
    let _ = app.emit("agent-background-task", &payload);
}

pub(super) fn terminal_text(text: &str) -> String {
    let normalized = text.replace("\r\n", "\n");
    let mut rendered = String::with_capacity(normalized.len());
    for ch in normalized.chars() {
        match ch {
            // Progress renderers such as cargo frequently redraw one terminal
            // row with carriage returns. Clear the rest of the row so shorter
            // redraws do not leave stale text behind in the read-only terminal.
            '\r' => rendered.push_str("\r\x1b[K"),
            '\n' => rendered.push_str("\r\n"),
            _ => rendered.push(ch),
        }
    }
    rendered
}

/// Async wrapper around the lib crate's [`append_terminal_output_sync`].
/// Takes ownership of `bytes` and `path` so the call site hands a single
/// allocation across the `spawn_blocking` boundary — no extra `to_vec()`
/// copy of the (potentially multi-MB) tool-result text.
pub(super) async fn append_agent_bash_output(path: PathBuf, bytes: Vec<u8>) -> std::io::Result<()> {
    tokio::task::spawn_blocking(move || append_terminal_output_sync(&path, &bytes))
        .await
        .map_err(|err| {
            std::io::Error::other(format!("terminal output writer task join failed: {err}"))
        })?
}

/// Set of (source, destination) pairs that already have a live mirror task
/// running. Background-bash bindings can re-fire (e.g. on `--resume` replay
/// of the session transcript), and each spawn would restart reading the
/// source file from offset 0 — re-appending gigabytes of historical bash
/// output to the workspace terminal. This dedupes spawn requests so only
/// one mirror per (source, destination) pair runs at a time.
fn active_mirrors() -> &'static Mutex<HashSet<(PathBuf, PathBuf)>> {
    static ACTIVE: OnceLock<Mutex<HashSet<(PathBuf, PathBuf)>>> = OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(HashSet::new()))
}

/// RAII token that removes a mirror registration on drop. The spawned
/// mirror task owns one of these and lets it drop when the task finishes
/// — normally, via panic, or because the JoinHandle was aborted. Without
/// this, a panicking or aborted task would leave the entry behind and
/// permanently dedupe all future spawns for that `(source, destination)`.
struct MirrorRegistration {
    key: Option<(PathBuf, PathBuf)>,
}

impl Drop for MirrorRegistration {
    fn drop(&mut self) {
        if let Some(key) = self.key.take() {
            let mut active = active_mirrors().lock().unwrap_or_else(|p| p.into_inner());
            active.remove(&key);
        }
    }
}

pub(super) fn mirror_background_task_output(
    source: std::path::PathBuf,
    destination: std::path::PathBuf,
) {
    let key = (source.clone(), destination.clone());
    let registration = {
        let mut active = active_mirrors().lock().unwrap_or_else(|p| p.into_inner());
        if !active.insert(key.clone()) {
            tracing::debug!(
                target: "claudette::chat",
                source = %source.display(),
                destination = %destination.display(),
                "skipping duplicate background output mirror spawn"
            );
            return;
        }
        MirrorRegistration { key: Some(key) }
    };
    tokio::spawn(async move {
        // Held in scope for the entire mirror loop. Dropped on normal
        // completion, panic, or JoinHandle::abort — whichever happens
        // first — so the (source, destination) registration is released.
        let _registration = registration;
        use tokio::io::{AsyncReadExt, AsyncSeekExt};

        let mut offset = 0_u64;
        let mut empty_reads = 0_u32;
        let started_at = tokio::time::Instant::now();
        let mut idle_since_output: Option<tokio::time::Instant> = None;
        const ACTIVE_MIRROR_POLL: Duration = Duration::from_millis(100);
        const MAX_INITIAL_IDLE: Duration = Duration::from_secs(10 * 60);
        const MAX_IDLE_AFTER_OUTPUT: Duration = Duration::from_secs(10);
        const MAX_IDLE_TICKS_AFTER_OUTPUT: u32 = 20;
        let mut buf = vec![0_u8; 8192];
        loop {
            tokio::time::sleep(crate::tail_backoff::adaptive_tail_delay(
                ACTIVE_MIRROR_POLL,
                empty_reads,
            ))
            .await;
            let Ok(mut file) = tokio::fs::File::open(&source).await else {
                empty_reads = empty_reads.saturating_add(1);
                if offset == 0 && started_at.elapsed() >= MAX_INITIAL_IDLE {
                    tracing::debug!(target: "claudette::chat", source = %source.display(), "stopping idle background output mirror before source file appeared");
                    break;
                }
                continue;
            };
            let len = file.metadata().await.ok().map(|m| m.len()).unwrap_or(0);
            if len < offset {
                offset = 0;
            }
            if file.seek(std::io::SeekFrom::Start(offset)).await.is_err() {
                continue;
            }
            let mut wrote = false;
            loop {
                match file.read(&mut buf).await {
                    Ok(0) => break,
                    Ok(n) => {
                        offset += n as u64;
                        wrote = true;
                        let rendered = terminal_text(&String::from_utf8_lossy(&buf[..n]));
                        if let Err(err) =
                            append_agent_bash_output(destination.clone(), rendered.into_bytes())
                                .await
                        {
                            tracing::warn!(target: "claudette::chat", error = %err, "failed to mirror background output");
                        }
                    }
                    Err(_) => break,
                }
            }
            if wrote {
                empty_reads = 0;
                idle_since_output = None;
            } else {
                empty_reads = empty_reads.saturating_add(1);
                let idle_for = idle_since_output
                    .get_or_insert_with(tokio::time::Instant::now)
                    .elapsed();
                if offset == 0 && started_at.elapsed() >= MAX_INITIAL_IDLE {
                    tracing::debug!(target: "claudette::chat", source = %source.display(), "stopping idle background output mirror with no output");
                    break;
                }
                if offset > 0
                    && (empty_reads >= MAX_IDLE_TICKS_AFTER_OUTPUT
                        || idle_for >= MAX_IDLE_AFTER_OUTPUT)
                {
                    break;
                }
            }
        }
        // `_registration` drops here, releasing the (source, destination)
        // entry from `active_mirrors` so a fresh mirror can be spawned
        // later if the same background bash binding re-fires.
    });
}

pub(super) fn get_or_create_agent_shell_terminal_tab(
    db_path: &std::path::Path,
    workspace_id: &str,
    chat_session_id: &str,
) -> Option<TerminalTab> {
    // Workspace-scoped path: env-provider provisioning, setup-script,
    // and agent shell all append to the same file so the Claudette
    // Terminal tab shows one unified transcript per workspace. The
    // chat-session id still drives `agent_chat_session_id` so
    // background-task lookups by session find this tab.
    let db = Database::open(db_path).ok()?;
    let output_path = workspace_terminal_output_path(workspace_id)
        .to_string_lossy()
        .into_owned();
    if let Ok(Some(mut tab)) = db.get_agent_shell_terminal_tab_by_workspace(workspace_id) {
        let _ = db.update_agent_shell_terminal_tab_session(tab.id, chat_session_id, &output_path);
        tab.title = CLAUDETTE_TERMINAL_TITLE.to_string();
        tab.agent_chat_session_id = Some(chat_session_id.to_string());
        tab.agent_tool_use_id = None;
        tab.agent_task_id = None;
        tab.output_path = Some(output_path);
        tab.task_status = None;
        tab.task_summary = None;
        return Some(tab);
    }
    let max_id = db.max_terminal_tab_id().ok()?;
    let tab = TerminalTab {
        id: max_id + 1,
        workspace_id: workspace_id.to_string(),
        title: CLAUDETTE_TERMINAL_TITLE.to_string(),
        kind: TerminalTabKind::AgentTask,
        is_script_output: false,
        sort_order: -1,
        created_at: now_iso(),
        agent_chat_session_id: Some(chat_session_id.to_string()),
        agent_tool_use_id: None,
        agent_task_id: None,
        output_path: Some(output_path),
        task_status: None,
        task_summary: None,
    };
    db.insert_terminal_tab(&tab).ok()?;
    Some(tab)
}

/// Whether a background task's status means the task has ended.
///
/// Delegates to the shared vocabulary in `claudette::agent::workflow_progress`.
/// This used to be a local `matches!` that omitted `"error"` while the two
/// other copies of the set (the frontend's and a SQL literal) included it —
/// so an `error` notification re-armed the wake instead of resolving the run.
fn is_terminal_task_status(status: &str) -> bool {
    claudette::agent::workflow_progress::is_terminal_task_status(status)
}

pub(super) fn is_final_terminal_task_status(status: &str) -> bool {
    is_terminal_task_status(status)
}

/// Whether a `task_notification` status should *arm* the background-task wake.
/// Any non-terminal status (`running`, `starting`, or an unknown/absent value
/// treated as running) means the task is still in flight, so it belongs in
/// `running_background_tasks` — the set the `Result`-event gate reads to decide
/// whether to schedule a wake. Terminal statuses are handled by the removal
/// path in [`apply_task_notification_status`] instead.
fn should_arm_wake_for_status(status: &str) -> bool {
    !is_terminal_task_status(status)
}

/// Arm the background-task wake for *any* background task the Claude CLI
/// reports via a trusted `task_notification` System event — not just Bash.
///
/// The CLI emits `task_notification` (a live-stream-only event; it is never
/// persisted to the `.jsonl` transcript) for every background task type:
/// background Bash, the `Agent` tool run in the background, and the `Workflow`
/// tool. Historically only Bash tasks were tracked — and only by parsing
/// Bash's `Command running in background with ID:` tool-result *text*. So a
/// Workflow or backgrounded subagent left `running_background_tasks` empty,
/// the `Result`-event wake gate never armed (see `send.rs`
/// `should_wake_background_tasks`), and the eventual terminal notification hit
/// an idle stream with no armed watcher — the model was never re-invoked and
/// silently never reported back to the user.
///
/// Call this ONLY from the trusted System-event path (the CLI's structured
/// event), never from parsed tool-result *text*, so a prompt-injected fake
/// `<task-notification>` can't keep a session awake or smuggle in an
/// arbitrary output path.
pub(super) async fn arm_background_task_from_system_notification(
    app: &AppHandle,
    chat_session_id: &str,
    task_id: &str,
    output_file: Option<&str>,
) {
    let app_state = app.state::<AppState>();
    let mut agents = app_state.agents.write().await;
    if let Some(session) = agents.get_mut(chat_session_id) {
        session.running_background_tasks.insert(task_id.to_string());
        // Output path is trusted here: it originates from the CLI's own
        // System event, not from tool-result text. Recording it lets the
        // wake prompt inline the task's output (see
        // `clone_trusted_background_output_path`).
        if let Some(path) = output_file.map(str::trim).filter(|s| !s.is_empty()) {
            session
                .background_task_output_paths
                .insert(task_id.to_string(), path.to_string());
        }
    }
}

/// Apply the task-status bookkeeping for a single stream event that may carry a
/// `task_notification` — the trusted System form and both user-turn `<task-
/// notification>` text forms. Terminal statuses remove the task from
/// `running_background_tasks` (via [`apply_task_notification_status`]);
/// non-terminal System notifications re-arm it. Shared by the wake's injected-
/// turn loop and [`drain_pending_task_notifications`] so both stay in sync.
async fn apply_stream_task_notification(
    event: &AgentEvent,
    app: &AppHandle,
    db_path: &Path,
    workspace_id: &str,
    chat_session_id: &str,
) {
    if let AgentEvent::Stream(StreamEvent::System {
        subtype,
        task_id: Some(task_id),
        tool_use_id,
        output_file,
        summary,
        status: Some(status),
        ..
    }) = event
        && subtype == "task_notification"
    {
        apply_task_notification_status(
            app,
            db_path,
            workspace_id,
            chat_session_id,
            task_id,
            tool_use_id.as_deref(),
            status,
            summary.as_deref(),
            output_file.as_deref(),
        )
        .await;
        if should_arm_wake_for_status(status) {
            arm_background_task_from_system_notification(
                app,
                chat_session_id,
                task_id,
                output_file.as_deref(),
            )
            .await;
        }
    }

    if let AgentEvent::Stream(StreamEvent::User { message, .. }) = event {
        let texts: Vec<&str> = match &message.content {
            claudette::agent::UserMessageContent::Text(body) => vec![body.as_str()],
            claudette::agent::UserMessageContent::Blocks(blocks) => blocks
                .iter()
                .filter_map(|block| match block {
                    claudette::agent::UserContentBlock::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect(),
        };
        for text in texts {
            if let Some(notification) = parse_task_notification(text) {
                let status = notification.status.as_deref().unwrap_or("running");
                apply_task_notification_status(
                    app,
                    db_path,
                    workspace_id,
                    chat_session_id,
                    &notification.task_id,
                    notification.tool_use_id.as_deref(),
                    status,
                    notification.summary.as_deref(),
                    notification.output_file.as_deref(),
                )
                .await;
            }
        }
    }
}

/// Drain any events currently buffered on the session-wide broadcast receiver
/// `rx` and apply their task-status bookkeeping. Used to catch a *second*
/// background task that completes in the narrow window between the wake's first
/// loop breaking on one completion and the injected turn subscribing its own
/// receiver. That notification is retained only by this (still-alive, undrained)
/// broadcast receiver; without draining it the second task is never removed
/// from `running_background_tasks`, leaving a phantom that the continue-on-
/// timeout wake would spin on forever. Non-blocking — returns once the receiver
/// is momentarily empty.
async fn drain_pending_task_notifications(
    rx: &mut tokio::sync::broadcast::Receiver<AgentEvent>,
    app: &AppHandle,
    db_path: &Path,
    workspace_id: &str,
    chat_session_id: &str,
) {
    use tokio::sync::broadcast::error::TryRecvError;
    loop {
        match rx.try_recv() {
            Ok(event) => {
                apply_stream_task_notification(&event, app, db_path, workspace_id, chat_session_id)
                    .await;
            }
            Err(TryRecvError::Empty) | Err(TryRecvError::Closed) => break,
            Err(TryRecvError::Lagged(_)) => continue,
        }
    }
}

pub(super) fn should_defer_persistent_restart(session: &AgentSessionState) -> bool {
    should_defer_persistent_restart_for_state(
        session.persistent_session.is_some(),
        !session.running_background_tasks.is_empty(),
    )
}

fn should_defer_persistent_restart_for_state(
    has_persistent_session: bool,
    has_running_background_tasks: bool,
) -> bool {
    has_persistent_session && has_running_background_tasks
}

#[derive(Default)]
pub(super) struct BackgroundTaskInputTracker {
    bash_inputs: HashMap<usize, BashInput>,
    bash_tool_use_ids: HashSet<String>,
    /// Tool-use ids of `Workflow` invocations seen this turn. The Workflow tool
    /// always runs in the background, so any of its tool-results is a trusted
    /// launch announcement (`Workflow launched in background. Task ID: …`) we
    /// can arm the wake from — the belt-and-suspenders companion to the
    /// System-event arming, using a during-turn signal guaranteed to arrive.
    workflow_tool_use_ids: HashSet<String>,
}

struct BashInput {
    tool_use_id: String,
    input_json: String,
    start_observed: bool,
}

impl BackgroundTaskInputTracker {
    pub(super) fn observe_bash_input_delta(&mut self, event: &AgentEvent) {
        if let AgentEvent::Stream(StreamEvent::Stream {
            event:
                InnerStreamEvent::ContentBlockStart {
                    index,
                    content_block: Some(StartContentBlock::ToolUse { id, name, .. }),
                },
        }) = event
            && name == "Bash"
        {
            self.bash_tool_use_ids.insert(id.clone());
            self.bash_inputs.insert(
                *index,
                BashInput {
                    tool_use_id: id.clone(),
                    input_json: String::new(),
                    start_observed: false,
                },
            );
        }

        // Track Workflow tool-uses so their launch announcement can be trusted
        // as a wake-arming signal (see `is_workflow_tool_result`).
        if let AgentEvent::Stream(StreamEvent::Stream {
            event:
                InnerStreamEvent::ContentBlockStart {
                    content_block: Some(StartContentBlock::ToolUse { id, name, .. }),
                    ..
                },
        }) = event
            && name == "Workflow"
        {
            self.workflow_tool_use_ids.insert(id.clone());
        }

        if let AgentEvent::Stream(StreamEvent::Stream {
            event: InnerStreamEvent::ContentBlockDelta { index, delta },
        }) = event
            && let Some(input) = self.bash_inputs.get_mut(index)
        {
            match delta {
                claudette::agent::Delta::ToolUse {
                    partial_json: Some(part),
                }
                | claudette::agent::Delta::InputJson {
                    partial_json: Some(part),
                } => input.input_json.push_str(part),
                _ => {}
            }
        }
    }

    pub(super) fn is_bash_tool_result(&self, tool_use_id: &str) -> bool {
        self.bash_tool_use_ids.contains(tool_use_id)
    }

    pub(super) fn is_bash_tool_active(&self, tool_use_id: &str) -> bool {
        self.bash_inputs
            .values()
            .any(|input| input.tool_use_id == tool_use_id)
    }

    pub(super) fn finish_bash_tool_result(&mut self, tool_use_id: &str) {
        self.bash_tool_use_ids.remove(tool_use_id);
    }

    /// Whether this tool-result belongs to a `Workflow` tool-use — i.e. its
    /// text is a trusted `Workflow launched in background. Task ID: …` binding.
    pub(super) fn is_workflow_tool_result(&self, tool_use_id: &str) -> bool {
        self.workflow_tool_use_ids.contains(tool_use_id)
    }

    pub(super) fn finish_workflow_tool_result(&mut self, tool_use_id: &str) {
        self.workflow_tool_use_ids.remove(tool_use_id);
    }

    pub(super) fn mark_bash_tool_started(&mut self, tool_use_id: &str) {
        for input in self.bash_inputs.values_mut() {
            if input.tool_use_id == tool_use_id {
                input.start_observed = true;
            }
        }
    }

    pub(super) async fn observe_bash_input_stop(
        &mut self,
        event: &AgentEvent,
        app: &AppHandle,
        db_path: &Path,
        workspace_id: &str,
        chat_session_id: &str,
    ) {
        let AgentEvent::Stream(StreamEvent::Stream {
            event: InnerStreamEvent::ContentBlockStop { index },
        }) = event
        else {
            return;
        };
        let Some(input) = self.bash_inputs.remove(index) else {
            return;
        };
        let Some(start) = parse_bash_start(&input.input_json) else {
            return;
        };

        let command = start.command.as_deref();
        if start.run_in_background {
            let app_state = app.state::<AppState>();
            let mut agents = app_state.agents.write().await;
            if let Some(session) = agents.get_mut(chat_session_id) {
                session
                    .running_background_tasks
                    .insert(input.tool_use_id.clone());
            }
        }
        if input.start_observed {
            return;
        }
        // Workspace-scoped path: every agent shell command across every
        // chat session appends to the same workspace transcript. The
        // truncate-on-no-running-tasks behavior the chat-session-scoped
        // path used to do is intentionally gone — env-provider
        // provisioning + prior session history must survive into the
        // new command's view, otherwise the user loses the unified
        // Claudette Terminal transcript the moment they hit Bash again.
        let path = workspace_terminal_output_path(workspace_id);
        let echo = command
            .map(|cmd| format!("\r\n$ {}\r\n", terminal_text(cmd)))
            .unwrap_or_else(|| "\r\n$ Bash\r\n".to_string());
        if let Err(err) = append_agent_bash_output(path, echo.into_bytes()).await {
            tracing::warn!(target: "claudette::chat", error = %err, "failed to write agent bash output");
        }
        if get_or_create_agent_shell_terminal_tab(db_path, workspace_id, chat_session_id).is_some()
            && let Ok(db) = Database::open(db_path)
        {
            let _ = db.update_agent_shell_terminal_tab_status(
                chat_session_id,
                None,
                if start.run_in_background {
                    "running"
                } else {
                    "starting"
                },
                command,
            );
            if let Ok(Some(tab)) = db.get_agent_shell_terminal_tab(chat_session_id) {
                emit_agent_background_task_event(
                    app,
                    AgentBackgroundTaskEventKind::Starting,
                    workspace_id,
                    chat_session_id,
                    tab,
                );
            }
        }
    }
}

/// Persist a backgrounded `Workflow` run's terminal outcome and tell the open
/// UI about it.
///
/// This is the fix for the status pill that never cleared. The activity row
/// used to be written only from the webview's `task_notification` handler, but
/// for a backgrounded run that notification arrives *after* the launching turn
/// has ended — and the per-turn `agent-stream` forwarder is torn down at the
/// turn's `Result` (`claudette::agent::session`), so nothing carried it to the
/// webview. The write never happened, the row stayed `"running"`, and the pill
/// came back on every reload, forever.
///
/// Doing it here covers all three notification routes at once, since every one
/// of them funnels through [`apply_task_notification_status`]: the in-turn
/// stream, the wake loop's terminal break, and the post-wake drain.
///
/// Failures are logged and swallowed. A missed write costs a stale pill until
/// the next boot sweep — it must not take down the wake machinery that reports
/// the task's result back to the user.
#[allow(clippy::too_many_arguments)]
fn resolve_workflow_activity(
    app: &AppHandle,
    db: &Database,
    workspace_id: &str,
    chat_session_id: &str,
    task_id: &str,
    tool_use_id: Option<&str>,
    status: &str,
) {
    // `tool_use_id` is optional on `task_notification`, and nothing in this
    // repo pins whether the CLI populates it for every workflow. Fall back to
    // the task id, which the row records from the `task_started` /
    // `task_progress` events — those carry both, so the join is always
    // available by the time a run can end.
    let resolved_id;
    let tool_use_id = match tool_use_id {
        Some(id) => id,
        None => match db.find_workflow_activity_by_task_id(task_id) {
            Ok(Some(id)) => {
                resolved_id = id;
                resolved_id.as_str()
            }
            // No match is the ordinary case for background Bash and
            // backgrounded subagents: they share this notification path but
            // own no `Workflow` row.
            Ok(None) => return,
            Err(err) => {
                tracing::warn!(
                    target: "claudette::chat",
                    task_id,
                    error = %err,
                    "failed to resolve workflow activity by task id"
                );
                return;
            }
        },
    };
    let resolution = match db.finish_workflow_activity(tool_use_id, status, None) {
        Ok(resolution) => resolution,
        Err(err) => {
            tracing::warn!(
                target: "claudette::chat",
                tool_use_id,
                status,
                error = %err,
                "failed to persist terminal workflow status"
            );
            return;
        }
    };
    // Zero rows is the ordinary outcome for every non-Workflow background task
    // (a background Bash, a backgrounded subagent) — they share this
    // notification path but own no `Workflow` activity row. Staying quiet
    // keeps the log signal about workflows only.
    if resolution.rows_updated == 0 {
        return;
    }
    // Logged at info because this pipeline was previously invisible: a search
    // of the shipped logs for "workflow" or "task_notification" returned
    // nothing, which is part of why the wedge went undiagnosed for so long.
    tracing::info!(
        target: "claudette::chat",
        tool_use_id,
        status,
        "resolved workflow activity from terminal task notification"
    );
    let workflow_progress = resolution
        .tree_json
        .as_deref()
        .and_then(|json| serde_json::from_str::<Vec<WorkflowProgressEntry>>(json).ok());
    let _ = app.emit(
        "workflow-activity-status",
        &WorkflowActivityStatusEvent {
            workspace_id: workspace_id.to_string(),
            chat_session_id: chat_session_id.to_string(),
            tool_use_id: tool_use_id.to_string(),
            status: status.to_string(),
            workflow_progress,
        },
    );
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn apply_task_notification_status(
    app: &AppHandle,
    db_path: &std::path::Path,
    workspace_id: &str,
    chat_session_id: &str,
    task_id: &str,
    tool_use_id: Option<&str>,
    status: &str,
    summary: Option<&str>,
    output_file: Option<&str>,
) {
    let _ = get_or_create_agent_shell_terminal_tab(db_path, workspace_id, chat_session_id);
    let Ok(db) = Database::open(db_path) else {
        return;
    };
    let app_state = app.state::<AppState>();
    let trusted_output_file = {
        let agents = app_state.agents.read().await;
        agents.get(chat_session_id).and_then(|session| {
            let trusted = session
                .background_task_output_paths
                .get(task_id)
                .or_else(|| {
                    tool_use_id.and_then(|tool_use_id| {
                        session.background_task_output_paths.get(tool_use_id)
                    })
                })
                .cloned();
            output_file
                .filter(|path| trusted.as_deref() == Some(path.trim()))
                .map(str::trim)
                .map(ToOwned::to_owned)
        })
    };
    if is_terminal_task_status(status) {
        {
            let mut agents = app_state.agents.write().await;
            if let Some(session) = agents.get_mut(chat_session_id) {
                session.running_background_tasks.remove(task_id);
                session.background_task_output_paths.remove(task_id);
                if let Some(tool_use_id) = tool_use_id {
                    session.running_background_tasks.remove(tool_use_id);
                    session.background_task_output_paths.remove(tool_use_id);
                }
            }
        }
        resolve_workflow_activity(
            app,
            &db,
            workspace_id,
            chat_session_id,
            task_id,
            tool_use_id,
            status,
        );
    }
    let _ = db.update_agent_task_terminal_tab_status(
        chat_session_id,
        task_id,
        status,
        summary.filter(|s| !s.trim().is_empty()),
        trusted_output_file.as_deref(),
    );
    let _ = db.update_agent_shell_terminal_tab_status(
        chat_session_id,
        Some(task_id),
        status,
        summary.filter(|s| !s.trim().is_empty()),
    );
    let tab = db
        .get_terminal_tab_by_agent_task(chat_session_id, task_id)
        .ok()
        .flatten()
        .or_else(|| {
            db.get_agent_shell_terminal_tab(chat_session_id)
                .ok()
                .flatten()
        });
    if let Some(tab) = tab {
        emit_agent_background_task_event(
            app,
            AgentBackgroundTaskEventKind::Status,
            workspace_id,
            chat_session_id,
            tab,
        );
    }
}

#[derive(Debug, Clone)]
struct BackgroundTaskCompletion {
    task_id: String,
    tool_use_id: Option<String>,
    output_file: Option<String>,
    status: String,
    summary: Option<String>,
}

fn task_completion_from_notification(
    notification: claudette::agent::background::TaskNotification,
) -> Option<BackgroundTaskCompletion> {
    let status = notification.status.unwrap_or_else(|| "running".to_string());
    if !is_terminal_task_status(&status) {
        return None;
    }
    Some(BackgroundTaskCompletion {
        task_id: notification.task_id,
        tool_use_id: notification.tool_use_id,
        output_file: notification.output_file,
        status,
        summary: notification.summary,
    })
}

async fn read_background_output_for_prompt(output_file: Option<&str>) -> Option<String> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};

    let output_file = output_file?.trim();
    if output_file.is_empty() {
        return None;
    }
    let mut file = tokio::fs::File::open(output_file).await.ok()?;
    const MAX_OUTPUT_BYTES: u64 = 24_000;
    let len = file.metadata().await.ok()?.len();
    let start = len.saturating_sub(MAX_OUTPUT_BYTES);
    file.seek(std::io::SeekFrom::Start(start)).await.ok()?;

    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).await.ok()?;
    let mut text = String::from_utf8_lossy(&bytes).to_string();
    if start > 0 {
        text.insert_str(0, "[output truncated to last 24000 bytes]\n");
    }
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

fn markdown_code_fence_for(text: &str) -> String {
    let mut current_run = 0_usize;
    let mut longest_run = 0_usize;
    for ch in text.chars() {
        if ch == '`' {
            current_run += 1;
            longest_run = longest_run.max(current_run);
        } else {
            current_run = 0;
        }
    }
    "`".repeat(3.max(longest_run + 1))
}

fn escape_task_notification_field(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn build_background_task_completion_prompt(
    completion: &BackgroundTaskCompletion,
    trusted_output: Option<&str>,
) -> String {
    let task_id = escape_task_notification_field(&completion.task_id);
    let status = escape_task_notification_field(&completion.status);
    let mut prompt = format!(
        "A background task completed. Respond to the user now with the result.\n\n<task-notification>\n<task-id>{task_id}</task-id>\n<status>{status}</status>"
    );
    if let Some(tool_use_id) = completion.tool_use_id.as_deref() {
        let tool_use_id = escape_task_notification_field(tool_use_id);
        prompt.push_str(&format!("\n<tool-use-id>{tool_use_id}</tool-use-id>"));
    }
    if let Some(output_file) = completion.output_file.as_deref() {
        let output_file = escape_task_notification_field(output_file);
        prompt.push_str(&format!("\n<output-file>{output_file}</output-file>"));
    }
    if let Some(summary) = completion.summary.as_deref() {
        let summary = escape_task_notification_field(summary);
        prompt.push_str(&format!("\n<summary>{summary}</summary>"));
    }
    prompt.push_str("\n</task-notification>");
    if let Some(output) = trusted_output {
        let fence = markdown_code_fence_for(output);
        prompt.push_str("\n\nOutput:\n");
        prompt.push_str(&fence);
        prompt.push_str("text\n");
        prompt.push_str(output);
        if !output.ends_with('\n') {
            prompt.push('\n');
        }
        prompt.push_str(&fence);
    }
    prompt
}

async fn clone_trusted_background_output_path(
    app_state: &AppState,
    chat_session_id: &str,
    completion: &BackgroundTaskCompletion,
) -> Option<String> {
    let agents = app_state.agents.read().await;
    let session = agents.get(chat_session_id)?;
    let output_path = session
        .background_task_output_paths
        .get(&completion.task_id)
        .or_else(|| {
            completion
                .tool_use_id
                .as_deref()
                .and_then(|tool_use_id| session.background_task_output_paths.get(tool_use_id))
        })
        .cloned();
    if output_path.is_some() {
        return output_path;
    }
    tracing::warn!(
        target: "claudette::chat",
        chat_session_id,
        task_id = %completion.task_id,
        "background task completed without a trusted output path; omitting task output from wake prompt"
    );
    None
}

pub(super) fn schedule_background_task_wake(
    app: AppHandle,
    db_path: std::path::PathBuf,
    workspace_id: String,
    chat_session_id: String,
) {
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(250)).await;

        let app_state = app.state::<AppState>();
        let Some(ps) = ({
            let mut agents = app_state.agents.write().await;
            let Some(session) = agents.get_mut(&chat_session_id) else {
                return;
            };
            if session.running_background_tasks.is_empty()
                || session.background_wake_active
                || session.persistent_session.is_none()
            {
                return;
            }
            session.background_wake_active = true;
            session.persistent_session.clone()
        }) else {
            return;
        };

        let mut rx = ps.subscribe();
        let completion = loop {
            let event = match tokio::time::timeout(Duration::from_secs(600), rx.recv()).await {
                Ok(Ok(event)) => event,
                Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => continue,
                Ok(Err(tokio::sync::broadcast::error::RecvError::Closed)) => break None,
                Err(_elapsed) => {
                    // The stream was merely silent for 600s — normal for a long
                    // background task (a multi-minute Workflow) whose parent
                    // session is idle. Keep the SAME subscription and keep
                    // waiting rather than abandoning the task; dropping rx to
                    // re-subscribe would risk missing a completion emitted in
                    // the gap. Only give up if the task is no longer tracked
                    // (e.g. the user killed it from the terminal) or the
                    // persistent session went away.
                    let still_pending = {
                        let agents = app_state.agents.read().await;
                        agents.get(&chat_session_id).is_some_and(|session| {
                            !session.running_background_tasks.is_empty()
                                && session.persistent_session.is_some()
                        })
                    };
                    if still_pending {
                        continue;
                    }
                    break None;
                }
            };

            if let AgentEvent::ProcessExited(_) = &event {
                break None;
            }
            if let AgentEvent::Stream(StreamEvent::System {
                subtype,
                task_id: Some(task_id),
                tool_use_id,
                output_file,
                summary,
                status: Some(status),
                ..
            }) = &event
                && subtype == "task_notification"
                && is_terminal_task_status(status)
            {
                break Some(BackgroundTaskCompletion {
                    task_id: task_id.clone(),
                    tool_use_id: tool_use_id.clone(),
                    output_file: output_file.clone(),
                    status: status.clone(),
                    summary: summary.clone(),
                });
            }
            if let AgentEvent::Stream(StreamEvent::User { message, .. }) = &event {
                match &message.content {
                    claudette::agent::UserMessageContent::Text(body) => {
                        if let Some(notification) = parse_task_notification(body)
                            && let Some(completion) =
                                task_completion_from_notification(notification)
                        {
                            break Some(completion);
                        }
                    }
                    claudette::agent::UserMessageContent::Blocks(blocks) => {
                        let mut found = None;
                        for block in blocks {
                            if let claudette::agent::UserContentBlock::Text { text } = block
                                && let Some(notification) = parse_task_notification(text)
                                && let Some(completion) =
                                    task_completion_from_notification(notification)
                            {
                                found = Some(completion);
                                break;
                            }
                        }
                        if found.is_some() {
                            break found;
                        }
                    }
                }
            }
        };

        let Some(completion) = completion else {
            // Loop only exits without a completion when the persistent process
            // is gone (Closed / ProcessExited) or the task is no longer tracked
            // — in every case there is nothing left to wake, so just clear the
            // in-flight flag. (A mere silent-stream timeout keeps waiting above
            // and never lands here.)
            let mut agents = app_state.agents.write().await;
            if let Some(session) = agents.get_mut(&chat_session_id) {
                session.background_wake_active = false;
            }
            return;
        };

        let trusted_output_file =
            clone_trusted_background_output_path(&app_state, &chat_session_id, &completion).await;

        apply_task_notification_status(
            &app,
            &db_path,
            &workspace_id,
            &chat_session_id,
            &completion.task_id,
            completion.tool_use_id.as_deref(),
            &completion.status,
            completion.summary.as_deref(),
            completion.output_file.as_deref(),
        )
        .await;

        let trusted_output =
            read_background_output_for_prompt(trusted_output_file.as_deref()).await;
        let prompt =
            build_background_task_completion_prompt(&completion, trusted_output.as_deref());
        let local_user_message_uuid = uuid::Uuid::new_v4().to_string();
        let ps_pid = ps.pid();
        {
            let mut agents = app_state.agents.write().await;
            if let Some(session) = agents.get_mut(&chat_session_id) {
                session.active_pid = Some(ps_pid);
                session.remember_local_user_message_uuid(local_user_message_uuid.clone());
            }
        }
        // Catch any second task that completed while we were building this
        // prompt — before the injected turn subscribes its own receiver — so it
        // is removed from `running_background_tasks` instead of becoming a
        // phantom the wake would spin on. `rx` is the first loop's still-alive
        // broadcast receiver (not yet dropped).
        drain_pending_task_notifications(&mut rx, &app, &db_path, &workspace_id, &chat_session_id)
            .await;
        let handle = match ps
            .send_turn_with_uuid(&prompt, &[], &local_user_message_uuid)
            .await
        {
            Ok(handle) => handle,
            Err(err) => {
                tracing::warn!(
                    target: "claudette::chat",
                    chat_session_id = %chat_session_id,
                    error = %err,
                    "failed to deliver background task notification"
                );
                let mut agents = app_state.agents.write().await;
                if let Some(session) = agents.get_mut(&chat_session_id) {
                    session.background_wake_active = false;
                    if session.active_pid == Some(ps_pid) {
                        session.active_pid = None;
                    }
                }
                return;
            }
        };

        {
            let mut agents = app_state.agents.write().await;
            if let Some(session) = agents.get_mut(&chat_session_id) {
                session.active_pid = Some(handle.pid);
            }
        }
        crate::tray::rebuild_tray(&app);

        let mut turn_rx = handle.event_rx;
        let mut last_assistant_msg_id: Option<String> = None;
        let mut pending_thinking: Option<String> = None;
        let mut latest_usage: Option<claudette::agent::TokenUsage> = None;
        // Gap 4: a wedged CLI (no Result, no exit) would block this loop forever
        // and leave `background_wake_active` stuck true, permanently rejecting
        // every future wake for the session. A live wake turn streams events
        // frequently, so 600s of total silence is a hang — bail and skip the
        // retry re-arm below rather than stacking a wake behind a maybe-live turn.
        let mut wake_turn_wedged = false;

        loop {
            let event = match tokio::time::timeout(Duration::from_secs(600), turn_rx.recv()).await {
                Ok(Some(event)) => event,
                Ok(None) => break,
                Err(_elapsed) => {
                    tracing::warn!(
                        target: "claudette::chat",
                        chat_session_id = %chat_session_id,
                        "background wake turn produced no events for 600s; abandoning to avoid a stuck wake"
                    );
                    wake_turn_wedged = true;
                    break;
                }
            };

            apply_stream_task_notification(&event, &app, &db_path, &workspace_id, &chat_session_id)
                .await;

            super::route_turn_control_request(&app, &workspace_id, &chat_session_id, &event).await;

            if let AgentEvent::Stream(StreamEvent::Stream {
                event: InnerStreamEvent::MessageDelta { usage: Some(u) },
            }) = &event
            {
                latest_usage = Some(u.clone());
            }

            if let AgentEvent::Stream(StreamEvent::Assistant { message }) = &event {
                let full_text = extract_assistant_text(message);
                if let Some(t) = extract_event_thinking(message) {
                    pending_thinking = Some(match pending_thinking.take() {
                        Some(mut existing) => {
                            existing.push_str(&t);
                            existing
                        }
                        None => t,
                    });
                }
                if !full_text.trim().is_empty()
                    && let Ok(db) = Database::open(&db_path)
                {
                    let msg = build_assistant_chat_message(BuildAssistantArgs {
                        workspace_id: &workspace_id,
                        chat_session_id: &chat_session_id,
                        content: full_text,
                        thinking: pending_thinking.take(),
                        usage: latest_usage.take(),
                        created_at: now_iso(),
                    });
                    let msg_id = msg.id.clone();
                    if db.insert_chat_message(&msg).is_ok() {
                        last_assistant_msg_id = Some(msg_id);
                    }
                }
            }

            if let AgentEvent::Stream(StreamEvent::Result {
                total_cost_usd,
                duration_ms,
                usage,
                ..
            }) = &event
                && let Ok(db) = Database::open(&db_path)
                && let Some(ref msg_id) = last_assistant_msg_id
            {
                if let Some(usage) = usage {
                    let usage = assistant_usage_fields_from_result(usage);
                    let _ = db.update_chat_message_usage_if_missing(
                        msg_id,
                        usage.input_tokens,
                        usage.output_tokens,
                        usage.cache_read_input_tokens,
                        usage.cache_creation_input_tokens,
                    );
                }
                if let (Some(cost), Some(dur)) = (total_cost_usd, duration_ms) {
                    let _ = db.update_chat_message_cost(msg_id, *cost, *dur);
                }
            }

            let is_done = matches!(
                &event,
                AgentEvent::Stream(StreamEvent::Result { .. }) | AgentEvent::ProcessExited(_)
            );

            let payload = AgentStreamPayload {
                workspace_id: workspace_id.clone(),
                chat_session_id: chat_session_id.clone(),
                event,
            };
            let _ = app.emit("agent-stream", &payload);

            if is_done {
                break;
            }
        }

        let should_retry = {
            let mut agents = app_state.agents.write().await;
            if let Some(session) = agents.get_mut(&chat_session_id) {
                session.background_wake_active = false;
                if session.active_pid == Some(ps.pid()) {
                    session.active_pid = None;
                }
                !session.running_background_tasks.is_empty() && session.persistent_session.is_some()
            } else {
                false
            }
        };
        crate::tray::rebuild_tray(&app);

        // Skip the re-arm if the turn wedged: a duplicate wake stacked behind a
        // possibly-still-live turn would violate the single-turn invariant.
        if should_retry && !wake_turn_wedged {
            tokio::time::sleep(Duration::from_secs(5)).await;
            schedule_background_task_wake(app, db_path, workspace_id, chat_session_id);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{
        BackgroundTaskCompletion, BackgroundTaskInputTracker,
        build_background_task_completion_prompt, is_terminal_task_status, markdown_code_fence_for,
        should_arm_wake_for_status, should_defer_persistent_restart_for_state, terminal_text,
    };
    use claudette::agent::{
        AgentEvent, InnerStreamEvent, StartContentBlock, StreamEvent, UserContentBlock,
        UserEventMessage, UserMessageContent,
    };
    use serde_json::json;
    #[test]
    fn terminal_text_converts_newlines_to_terminal_newlines() {
        assert_eq!(terminal_text("one\ntwo\r\nthree"), "one\r\ntwo\r\nthree");
    }

    #[test]
    fn terminal_text_clears_carriage_return_redraws() {
        assert_eq!(
            terminal_text("Building [======]\rBuilding [>]\ndone"),
            "Building [======]\r\x1b[KBuilding [>]\r\ndone"
        );
    }

    #[test]
    fn terminal_text_preserves_ansi_sequences() {
        assert_eq!(
            terminal_text("\x1b[32mok\x1b[0m\n"),
            "\x1b[32mok\x1b[0m\r\n"
        );
    }

    #[test]
    fn terminal_text_normalizes_crlf_without_extra_clear() {
        assert_eq!(terminal_text("one\r\ntwo\r\n"), "one\r\ntwo\r\n");
    }

    #[test]
    fn persistent_restart_is_deferred_only_while_background_tasks_are_owned() {
        assert!(should_defer_persistent_restart_for_state(true, true));
        assert!(!should_defer_persistent_restart_for_state(true, false));
        assert!(!should_defer_persistent_restart_for_state(false, true));
        assert!(!should_defer_persistent_restart_for_state(false, false));
    }

    #[test]
    fn tool_results_are_shell_owned_only_after_bash_tool_start() {
        let mut tracker = BackgroundTaskInputTracker::default();
        let non_bash_result = AgentEvent::Stream(StreamEvent::User {
            message: UserEventMessage {
                content: UserMessageContent::Blocks(vec![UserContentBlock::ToolResult {
                    tool_use_id: "file-1".to_string(),
                    content: json!({"status": "completed"}),
                }]),
            },
            uuid: None,
            is_replay: false,
            is_synthetic: true,
        });

        tracker.observe_bash_input_delta(&non_bash_result);
        assert!(!tracker.is_bash_tool_result("file-1"));

        tracker.observe_bash_input_delta(&AgentEvent::Stream(StreamEvent::Stream {
            event: InnerStreamEvent::ContentBlockStart {
                index: 7,
                content_block: Some(StartContentBlock::ToolUse {
                    id: "cmd-1".to_string(),
                    name: "Bash".to_string(),
                    input: None,
                }),
            },
        }));

        assert!(tracker.is_bash_tool_result("cmd-1"));
        assert!(tracker.is_bash_tool_active("cmd-1"));
        tracker.finish_bash_tool_result("cmd-1");
        assert!(!tracker.is_bash_tool_result("cmd-1"));
    }

    #[test]
    fn completed_structured_status_can_claim_bash_tool_result_before_fallback() {
        let mut tracker = BackgroundTaskInputTracker::default();

        tracker.observe_bash_input_delta(&AgentEvent::Stream(StreamEvent::Stream {
            event: InnerStreamEvent::ContentBlockStart {
                index: 3,
                content_block: Some(StartContentBlock::ToolUse {
                    id: "cmd-1".to_string(),
                    name: "Bash".to_string(),
                    input: None,
                }),
            },
        }));
        tracker.mark_bash_tool_started("cmd-1");

        assert!(tracker.is_bash_tool_result("cmd-1"));
        tracker.finish_bash_tool_result("cmd-1");
        assert!(
            !tracker.is_bash_tool_result("cmd-1"),
            "a structured Codex terminal completion must prevent the legacy ToolResult fallback"
        );
    }

    /// Regression: this module carried its own copy of the terminal-status
    /// set that omitted `"error"`, while the frontend's copy and the boot
    /// sweep's SQL literal both included it. An `error` notification therefore
    /// re-armed the wake instead of resolving the run, and the activity row
    /// stayed in flight forever. All three now read one shared vocabulary.
    #[test]
    fn terminal_task_statuses_match_the_shared_vocabulary() {
        for status in claudette::agent::workflow_progress::TERMINAL_TASK_STATUSES {
            assert!(
                is_terminal_task_status(status),
                "{status} must be terminal here too"
            );
            assert!(
                !should_arm_wake_for_status(status),
                "{status} must not re-arm the wake"
            );
        }
        assert!(should_arm_wake_for_status("running"));
        assert!(should_arm_wake_for_status("starting"));
    }

    #[test]
    fn wake_prompt_is_tool_agnostic_not_bash_specific() {
        // Regression: the wake prompt used to say "A background Bash task
        // completed." which was both misleading for Workflow/Agent tasks and a
        // symptom of the Bash-only design that never woke them. It must be
        // tool-agnostic now that any background task can arm the wake.
        let completion = BackgroundTaskCompletion {
            task_id: "wf_123".to_string(),
            tool_use_id: Some("toolu_1".to_string()),
            output_file: None,
            status: "completed".to_string(),
            summary: Some("workflow done".to_string()),
        };
        let prompt = build_background_task_completion_prompt(&completion, None);
        assert!(
            prompt.starts_with("A background task completed."),
            "prompt should be tool-agnostic, got: {prompt}"
        );
        assert!(
            !prompt.contains("Bash"),
            "wake prompt must not hardcode Bash: {prompt}"
        );
    }

    #[test]
    fn arms_wake_only_for_non_terminal_statuses() {
        // The wake is armed off a task's non-terminal (in-flight) notification;
        // terminal statuses are handled by the removal path instead. This is
        // what lets Workflow/Agent tasks — not just Bash — schedule a wake.
        for running in ["running", "starting", "queued", "in_progress", "unknown"] {
            assert!(
                should_arm_wake_for_status(running),
                "non-terminal status {running:?} should arm the wake"
            );
        }
        for terminal in [
            "completed",
            "failed",
            "stopped",
            "killed",
            "cancelled",
            "canceled",
            "COMPLETED",
        ] {
            assert!(
                !should_arm_wake_for_status(terminal),
                "terminal status {terminal:?} must not arm the wake"
            );
        }
    }

    #[test]
    fn tracks_workflow_tool_use_for_binding_trust() {
        // The Workflow tool always runs in the background, so observing its
        // tool-use marks the tool_use_id as a trusted launch-announcement
        // source. This is what lets a Workflow arm the wake from its
        // "Workflow launched in background. Task ID: …" tool-result — a
        // during-turn signal guaranteed to arrive.
        let mut tracker = BackgroundTaskInputTracker::default();
        assert!(!tracker.is_workflow_tool_result("wf-tool-1"));

        tracker.observe_bash_input_delta(&AgentEvent::Stream(StreamEvent::Stream {
            event: InnerStreamEvent::ContentBlockStart {
                index: 2,
                content_block: Some(StartContentBlock::ToolUse {
                    id: "wf-tool-1".to_string(),
                    name: "Workflow".to_string(),
                    input: None,
                }),
            },
        }));
        assert!(tracker.is_workflow_tool_result("wf-tool-1"));
        // A Bash tool-use must not be mistaken for a Workflow launch.
        assert!(!tracker.is_workflow_tool_result("cmd-x"));

        tracker.finish_workflow_tool_result("wf-tool-1");
        assert!(!tracker.is_workflow_tool_result("wf-tool-1"));
    }

    #[test]
    fn output_prompt_uses_fence_longer_than_backtick_runs() {
        assert_eq!(markdown_code_fence_for("plain output"), "```");
        assert_eq!(markdown_code_fence_for("before ``` after"), "````");
        assert_eq!(markdown_code_fence_for("before ```` after"), "`````");
    }

    #[test]
    fn completion_prompt_uses_supplied_trusted_output_not_notification_path() {
        let completion = BackgroundTaskCompletion {
            task_id: "task-1".to_string(),
            tool_use_id: None,
            output_file: Some("/tmp/should-not-be-read".to_string()),
            status: "completed".to_string(),
            summary: None,
        };
        let prompt =
            build_background_task_completion_prompt(&completion, Some("trusted task output\n"));

        assert!(prompt.contains("trusted task output"));
        assert!(!prompt.contains("should-not-be-read\nOutput:"));
    }

    #[test]
    fn completion_prompt_escapes_task_notification_fields() {
        let completion = BackgroundTaskCompletion {
            task_id: "task<1>".to_string(),
            tool_use_id: Some("tool<1>".to_string()),
            output_file: Some("/tmp/a&b".to_string()),
            status: "completed & reported".to_string(),
            summary: Some("done </summary><evil>".to_string()),
        };
        let prompt = build_background_task_completion_prompt(&completion, None);

        assert!(prompt.contains("<task-id>task&lt;1&gt;</task-id>"));
        assert!(prompt.contains("<status>completed &amp; reported</status>"));
        assert!(prompt.contains("<tool-use-id>tool&lt;1&gt;</tool-use-id>"));
        assert!(prompt.contains("<output-file>/tmp/a&amp;b</output-file>"));
        assert!(prompt.contains("<summary>done &lt;/summary&gt;&lt;evil&gt;</summary>"));
        assert!(!prompt.contains("<evil>"));
    }

    #[tokio::test]
    async fn prompt_output_reader_reads_tail_of_trusted_file() {
        let trusted_path =
            std::env::temp_dir().join(format!("claudette-trusted-{}.txt", uuid::Uuid::new_v4()));
        let output = format!("{}tail output\n", "x".repeat(24_100));
        std::fs::write(&trusted_path, output).unwrap();

        let text =
            super::read_background_output_for_prompt(Some(trusted_path.to_string_lossy().as_ref()))
                .await
                .unwrap();

        assert!(text.starts_with("[output truncated to last 24000 bytes]"));
        assert!(text.contains("tail output"));

        let _ = std::fs::remove_file(trusted_path);
    }

    #[tokio::test]
    async fn mirror_background_task_output_dedupes_duplicate_spawns() {
        // Issue #937: on session resume the binding `ToolResult` can re-fire,
        // and each spawn restarts the mirror at offset 0 and re-appends the
        // entire source file. Duplicate (source, destination) pairs must be
        // deduped so a single mirror exists per pair.
        use super::mirror_background_task_output;

        let source =
            std::env::temp_dir().join(format!("claudette-mirror-src-{}.log", uuid::Uuid::new_v4()));
        let destination =
            std::env::temp_dir().join(format!("claudette-mirror-dst-{}.log", uuid::Uuid::new_v4()));
        // Seed a tiny source so the mirror has bytes to copy on its first
        // tick (~100 ms). We assert on the destination size, which a single
        // mirror would write once and a second concurrent mirror would
        // append again.
        let payload = b"once\n";
        std::fs::write(&source, payload).unwrap();

        mirror_background_task_output(source.clone(), destination.clone());
        // Second spawn for the same pair must be a no-op (deduped) rather
        // than re-reading the source file from offset 0.
        mirror_background_task_output(source.clone(), destination.clone());

        // Give the (single) live mirror a tick or two to flush.
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;

        let after = std::fs::read(&destination).unwrap();
        // The mirror runs `terminal_text` which converts `\n` → `\r\n`.
        // One mirror copies the source once: 5 bytes in → 6 bytes out.
        // Two mirrors would copy it twice: 12 bytes out.
        assert_eq!(
            after.len(),
            6,
            "expected exactly one mirror to have written, got {} bytes ({:?})",
            after.len(),
            String::from_utf8_lossy(&after)
        );

        let _ = std::fs::remove_file(source);
        let _ = std::fs::remove_file(destination);
    }
}
