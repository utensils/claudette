use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use claudette::db::Database;
use claudette::model::{ChatMessage, ChatRole};
use claudette::scheduling::{ScheduleTarget, ScheduledTask, ScheduledTaskKind, cron_to_human};

use crate::state::AppState;

/// Resolve the GUI/IPC command arguments into a [`ScheduleTarget`].
///
/// `create_new_session` requires a `workspace_id` (the scheduler makes a fresh
/// session there each fire); otherwise a concrete `session_id` is reused.
fn build_schedule_target(
    session_id: Option<String>,
    workspace_id: Option<String>,
    create_new_session: Option<bool>,
) -> Result<ScheduleTarget, String> {
    if create_new_session.unwrap_or(false) {
        let ws = workspace_id
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .ok_or("workspace_id is required when create_new_session is set")?;
        Ok(ScheduleTarget::NewSessionInWorkspace(ws))
    } else {
        let sid = session_id
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        match sid {
            Some(sid) => Ok(ScheduleTarget::Session(sid)),
            // A caller that supplied only a workspace likely meant new-session.
            None if workspace_id.is_some() => Err(
                "session_id is required, or set create_new_session: true to target a workspace"
                    .to_string(),
            ),
            None => Err("session_id is required".to_string()),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ScheduledTaskView {
    #[serde(flatten)]
    pub task: ScheduledTask,
    pub human_schedule: Option<String>,
}

impl From<ScheduledTask> for ScheduledTaskView {
    fn from(task: ScheduledTask) -> Self {
        let human_schedule = task.cron_expr.as_deref().map(cron_to_human);
        Self {
            task,
            human_schedule,
        }
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn schedule_wakeup(
    session_id: Option<String>,
    workspace_id: Option<String>,
    create_new_session: Option<bool>,
    delay_seconds: Option<i64>,
    fire_at: Option<String>,
    prompt: String,
    reason: Option<String>,
    backend_id: Option<String>,
    model: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ScheduledTaskView, String> {
    if prompt.trim().is_empty() {
        return Err("prompt is required".to_string());
    }
    let target = build_schedule_target(session_id, workspace_id, create_new_session)?;
    let fire_at = resolve_fire_at(delay_seconds, fire_at.as_deref())?;
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let task = db
        .create_agent_wakeup(
            &target,
            fire_at,
            prompt.trim(),
            reason.as_deref(),
            backend_id.as_deref(),
            model.as_deref(),
        )
        .map_err(|e| e.to_string())?;
    state.scheduler_notify.notify_waiters();
    post_creation_note(
        &app,
        &state.db_path,
        &task.workspace_id,
        task.chat_session_id.as_deref(),
        format!(
            "Scheduled wakeup for {}. Manage it from the scheduler (clock icon in the sidebar).",
            fire_at.to_rfc3339()
        ),
    );
    Ok(task.into())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn create_cron_routine(
    session_id: Option<String>,
    workspace_id: Option<String>,
    create_new_session: Option<bool>,
    name: Option<String>,
    cron_expr: String,
    prompt: String,
    recurring: Option<bool>,
    backend_id: Option<String>,
    model: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ScheduledTaskView, String> {
    if prompt.trim().is_empty() {
        return Err("prompt is required".to_string());
    }
    let target = build_schedule_target(session_id, workspace_id, create_new_session)?;
    let cron_expr = cron_expr.trim().to_string();
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let task = db
        .create_agent_cron_task(
            &target,
            name.as_deref(),
            &cron_expr,
            prompt.trim(),
            recurring.unwrap_or(true),
            backend_id.as_deref(),
            model.as_deref(),
        )
        .map_err(|e| e.to_string())?;
    state.scheduler_notify.notify_waiters();
    post_creation_note(
        &app,
        &state.db_path,
        &task.workspace_id,
        task.chat_session_id.as_deref(),
        format!(
            "Looping (`{cron_expr}` — {}). Manage it from the scheduler (clock icon in the sidebar).",
            cron_to_human(&cron_expr)
        ),
    );
    Ok(task.into())
}

#[tauri::command]
pub async fn list_scheduled_routines(
    state: State<'_, AppState>,
) -> Result<Vec<ScheduledTaskView>, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let rows = db.list_agent_scheduled_tasks().map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(Into::into).collect())
}

#[tauri::command]
pub async fn delete_scheduled_routine(
    id: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let deleted = db
        .delete_agent_scheduled_task(&id)
        .map_err(|e| e.to_string())?;
    state.scheduler_notify.notify_waiters();
    Ok(serde_json::json!({ "deleted": deleted }))
}

#[tauri::command]
pub async fn run_scheduled_routine(
    id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let task = {
        let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
        db.list_agent_scheduled_tasks()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|task| task.id == id || task.name.as_deref() == Some(id.as_str()))
            .ok_or_else(|| format!("scheduled routine not found: {id}"))?
    };
    dispatch_task_prompt(app, task, "manual").await?;
    Ok(serde_json::json!({ "ok": true }))
}

pub fn start_scheduler(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let wait = run_due_tasks_once(app.clone()).await;
            let notify = app.state::<AppState>().scheduler_notify.clone();
            tokio::select! {
                _ = notify.notified() => {}
                _ = tokio::time::sleep(wait) => {}
            }
        }
    });
}

async fn run_due_tasks_once(app: AppHandle) -> Duration {
    let state = app.state::<AppState>();
    let now = Utc::now();
    let due = {
        let db = match Database::open(&state.db_path) {
            Ok(db) => db,
            Err(err) => {
                tracing::warn!(target: "claudette::scheduling", error = %err, "failed to open db for scheduler");
                return Duration::from_secs(60);
            }
        };
        match db.disable_due_agent_scheduled_tasks_without_worktrees(
            now,
            "workspace_unavailable",
            "Workspace is archived or has no worktree",
        ) {
            Ok(count) if count > 0 => {
                tracing::info!(
                    target: "claudette::scheduling",
                    count,
                    "paused scheduled tasks for unavailable workspaces"
                );
            }
            Ok(_) => {}
            Err(err) => {
                tracing::warn!(
                    target: "claudette::scheduling",
                    error = %err,
                    "failed to pause scheduled tasks for unavailable workspaces"
                );
            }
        }
        let due = db.due_agent_scheduled_tasks(now).unwrap_or_else(|err| {
            tracing::warn!(target: "claudette::scheduling", error = %err, "failed to load due scheduled tasks");
            Vec::new()
        });
        due
    };

    for task in due {
        if let Err(err) = mark_and_dispatch_due_task(app.clone(), task, now).await {
            tracing::warn!(target: "claudette::scheduling", error = %err, "failed to fire scheduled task");
        }
    }

    let next_fire = Database::open(&state.db_path)
        .ok()
        .and_then(|db| db.next_agent_schedule_fire_at().ok().flatten());

    next_fire
        .and_then(|value| DateTime::parse_from_rfc3339(&value).ok())
        .map(|dt| dt.with_timezone(&Utc))
        .and_then(|dt| (dt - Utc::now()).to_std().ok())
        .unwrap_or_else(|| Duration::from_secs(60))
        .clamp(Duration::from_millis(250), Duration::from_secs(60))
}

async fn mark_and_dispatch_due_task(
    app: AppHandle,
    task: ScheduledTask,
    now: DateTime<Utc>,
) -> Result<(), String> {
    {
        let state = app.state::<AppState>();
        let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
        let updated = db
            .mark_agent_scheduled_task_fired(&task, now)
            .map_err(|e| e.to_string())?;
        if updated == 0 {
            return Ok(());
        }
    }
    match dispatch_task_prompt(app.clone(), task.clone(), "scheduled").await {
        Ok(()) => Ok(()),
        Err(err) => {
            let state = app.state::<AppState>();
            if let Ok(db) = Database::open(&state.db_path) {
                let result = if is_terminal_scheduled_task_error(&err) {
                    db.disable_agent_scheduled_task_after_failure(
                        &task.id,
                        Utc::now(),
                        "terminal_dispatch_error",
                        &err,
                    )
                } else {
                    db.record_agent_scheduled_task_failure(&task.id, Utc::now(), &err)
                };
                if let Err(db_err) = result {
                    tracing::warn!(
                        target: "claudette::scheduling",
                        task_id = %task.id,
                        error = %db_err,
                        "failed to record scheduled task dispatch failure"
                    );
                }
            }
            Err(err)
        }
    }
}

pub async fn dispatch_task_prompt(
    app: AppHandle,
    task: ScheduledTask,
    source: &str,
) -> Result<(), String> {
    let prompt = build_dispatch_prompt(&task, source);
    // Resolve where this fire lands. `create_new_session` rows make a fresh
    // session in the target workspace on every fire (so a recurring cron gets
    // a clean session per run); reuse rows dispatch into their stored session.
    if task.create_new_session {
        let state = app.state::<AppState>();
        let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
        let session = db
            .create_chat_session(&task.workspace_id)
            .map_err(|e| e.to_string())?;
        let session_id = session.id.clone();
        let result = dispatch_prompt_to_session_inner(
            app.clone(),
            session_id.clone(),
            prompt,
            task.backend_id,
            task.model,
            Some(task.id),
            // Announce the fresh session to the frontend so its tab appears
            // before the live `chat-message` lands.
            Some(session),
        )
        .await;
        if result.is_err()
            && let Ok(db) = Database::open(&app.state::<AppState>().db_path)
        {
            // The fire never started — roll back the empty session we made so
            // a persistently-failing cron doesn't accrete blank tabs.
            let _ = db.archive_chat_session(&session_id);
        }
        result
    } else {
        let session_id = task
            .chat_session_id
            .clone()
            .ok_or("scheduled task has no target session")?;
        // Forward the row's pinned backend / model so a cron created from a
        // Codex or Pi chat fires on the same runtime it was scheduled under.
        // Either being `None` keeps the existing global-default fallback.
        dispatch_prompt_to_session_inner(
            app,
            session_id,
            prompt,
            task.backend_id,
            task.model,
            Some(task.id),
            None,
        )
        .await
    }
}

/// Dispatch a backend-originated prompt into a session (used by the agent
/// `Monitor` tool). Renders the injected prompt like any other backend-origin
/// send — see [`dispatch_prompt_to_session_inner`].
pub async fn dispatch_prompt_to_session(
    app: AppHandle,
    chat_session_id: String,
    prompt: String,
) -> Result<(), String> {
    dispatch_prompt_to_session_inner(app, chat_session_id, prompt, None, None, None, None).await
}

/// Run the turn via `send_chat_message` (which persists the user row by the
/// `message_id` we pass, carrying `scheduled_task_id` for the "Scheduled"
/// badge), then — only on success — emit the user message as a `chat-message`
/// so a focused session renders it live, the same way Claude Remote Control
/// surfaces remote-origin prompts that skip the GUI's optimistic insert.
///
/// Emitting *after* `send_chat_message` returns `Ok` (it persists + spawns the
/// stream task, then returns) avoids leaving a phantom badged prompt on screen
/// when send fails before persisting (e.g. an unresolvable pinned backend).
/// When `announce_session` is set (a freshly created new-session fire), its
/// `chat-session-created` event is emitted first so the tab exists before the
/// message arrives.
#[allow(clippy::too_many_arguments)]
async fn dispatch_prompt_to_session_inner(
    app: AppHandle,
    chat_session_id: String,
    prompt: String,
    backend_id: Option<String>,
    model: Option<String>,
    scheduled_task_id: Option<String>,
    announce_session: Option<claudette::model::ChatSession>,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let message_id = uuid::Uuid::new_v4().to_string();

    let result = crate::commands::chat::send::send_chat_message(
        chat_session_id.clone(),
        Some(message_id.clone()),
        prompt.clone(),
        None,
        None,
        model,
        None,
        None,
        None,
        None,
        None,
        None,
        backend_id,
        None,
        scheduled_task_id.clone(),
        app.clone(),
        state,
    )
    .await;

    if result.is_ok() {
        if let Some(session) = announce_session {
            let _ = app.emit("chat-session-created", &session);
        }
        // The row is already persisted by `send_chat_message` (via
        // `prepare_user_send`) under `message_id`; this emit just mirrors it
        // into the live store. Best-effort: a focused session renders it, and
        // a reload reads the same persisted row.
        if let Ok(db) = Database::open(&app.state::<AppState>().db_path)
            && let Ok(Some(session)) = db.get_chat_session(&chat_session_id)
        {
            let user_msg = ChatMessage {
                id: message_id,
                workspace_id: session.workspace_id,
                chat_session_id,
                role: ChatRole::User,
                content: prompt,
                cost_usd: None,
                duration_ms: None,
                created_at: crate::commands::chat::now_iso(),
                thinking: None,
                input_tokens: None,
                output_tokens: None,
                cache_read_tokens: None,
                cache_creation_tokens: None,
                scheduled_task_id,
            };
            let _ = app.emit("chat-message", &user_msg);
        }
    }

    result
}

/// Append a system-role chat message announcing that a wakeup / cron was
/// scheduled, and emit `chat-system-message` so the chat panel renders it
/// inline. Persisted to the DB so it survives reloads (and is visible
/// across all backends without any frontend per-backend code) — replaces
/// the prior frontend `addLocalMessage` which evaporated on refresh.
/// Best-effort: a failure here doesn't unwind the scheduling itself.
fn post_creation_note(
    app: &AppHandle,
    db_path: &std::path::Path,
    workspace_id: &str,
    chat_session_id: Option<&str>,
    content: String,
) {
    // New-session tasks have no session at schedule time — there's nowhere to
    // post the confirmation, so skip it. The task still appears in the
    // scheduler view.
    let Some(chat_session_id) = chat_session_id else {
        return;
    };
    let message = ChatMessage {
        id: uuid::Uuid::new_v4().to_string(),
        workspace_id: workspace_id.to_string(),
        chat_session_id: chat_session_id.to_string(),
        role: ChatRole::System,
        content,
        cost_usd: None,
        duration_ms: None,
        // Match the format every other Tauri-emitted chat message uses
        // (Unix-seconds string from `now_iso()`). Mixing formats breaks
        // the frontend's string-sort over `created_at`.
        created_at: crate::commands::chat::now_iso(),
        thinking: None,
        input_tokens: None,
        output_tokens: None,
        cache_read_tokens: None,
        cache_creation_tokens: None,
        scheduled_task_id: None,
    };
    match Database::open(db_path).and_then(|db| db.insert_chat_message(&message)) {
        Ok(()) => {
            let _ = app.emit("chat-system-message", &message);
        }
        Err(err) => {
            tracing::warn!(
                target: "claudette::scheduling",
                error = %err,
                "failed to persist schedule confirmation message"
            );
        }
    }
}

fn build_dispatch_prompt(task: &ScheduledTask, source: &str) -> String {
    let label = match task.kind {
        ScheduledTaskKind::Wakeup => "Scheduled wakeup fired",
        ScheduledTaskKind::Cron => "Scheduled routine fired",
    };
    let mut prompt = format!("{label} ({source}).");
    if let Some(name) = task.name.as_deref().filter(|s| !s.trim().is_empty()) {
        prompt.push_str(&format!("\nName: {name}"));
    }
    if let Some(reason) = task.reason.as_deref().filter(|s| !s.trim().is_empty()) {
        prompt.push_str(&format!("\nReason: {reason}"));
    }
    if let Some(cron) = task.cron_expr.as_deref() {
        prompt.push_str(&format!("\nSchedule: {cron} ({})", cron_to_human(cron)));
    }
    prompt.push_str("\n\n");
    prompt.push_str(&task.prompt);
    prompt
}

fn is_terminal_scheduled_task_error(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    error.contains("workspace has no worktree")
        || error.contains("workspace not found")
        || error.contains("chat session not found")
        || error.contains("repository not found")
}

fn resolve_fire_at(
    delay_seconds: Option<i64>,
    fire_at: Option<&str>,
) -> Result<DateTime<Utc>, String> {
    match (delay_seconds, fire_at) {
        (Some(seconds), _) if seconds <= 0 => Err("delay_seconds must be positive".to_string()),
        (Some(seconds), _) => Ok(Utc::now() + chrono::Duration::seconds(seconds)),
        (None, Some(value)) => DateTime::parse_from_rfc3339(value)
            .map(|dt| dt.with_timezone(&Utc))
            .map_err(|e| format!("fire_at must be RFC3339: {e}")),
        (None, None) => Err("delay_seconds or fire_at is required".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(kind: ScheduledTaskKind) -> ScheduledTask {
        ScheduledTask {
            id: "task-1".into(),
            chat_session_id: Some("chat-1".into()),
            workspace_id: "ws-1".into(),
            create_new_session: false,
            kind,
            name: Some("morning".into()),
            prompt: "Check the PR".into(),
            reason: Some("daily review".into()),
            fire_at: None,
            cron_expr: Some("0 9 * * 1-5".into()),
            recurring: true,
            enabled: true,
            created_at: "now".into(),
            updated_at: "now".into(),
            last_fired_at: None,
            next_fire_at: None,
            failure_count: 0,
            last_failed_at: None,
            last_error: None,
            disabled_reason: None,
            backend_id: None,
            model: None,
        }
    }

    #[test]
    fn dispatch_prompt_carries_schedule_context() {
        let prompt = build_dispatch_prompt(&task(ScheduledTaskKind::Cron), "scheduled");
        assert!(prompt.contains("Scheduled routine fired"));
        assert!(prompt.contains("Name: morning"));
        assert!(prompt.contains("Reason: daily review"));
        assert!(prompt.contains("Check the PR"));
    }

    #[test]
    fn terminal_scheduler_errors_are_classified() {
        assert!(is_terminal_scheduled_task_error(
            "Workspace has no worktree"
        ));
        assert!(is_terminal_scheduled_task_error("chat session not found"));
        assert!(!is_terminal_scheduled_task_error("network timeout"));
    }
}
