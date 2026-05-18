use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use claudette::db::Database;
use claudette::scheduling::{ScheduledTask, ScheduledTaskKind, cron_to_human};

use crate::state::AppState;

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
pub async fn schedule_wakeup(
    session_id: String,
    delay_seconds: Option<i64>,
    fire_at: Option<String>,
    prompt: String,
    reason: Option<String>,
    state: State<'_, AppState>,
) -> Result<ScheduledTaskView, String> {
    if prompt.trim().is_empty() {
        return Err("prompt is required".to_string());
    }
    let fire_at = resolve_fire_at(delay_seconds, fire_at.as_deref())?;
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let task = db
        .create_agent_wakeup(&session_id, fire_at, prompt.trim(), reason.as_deref())
        .map_err(|e| e.to_string())?;
    state.scheduler_notify.notify_waiters();
    Ok(task.into())
}

#[tauri::command]
pub async fn create_cron_routine(
    session_id: String,
    name: Option<String>,
    cron_expr: String,
    prompt: String,
    recurring: Option<bool>,
    state: State<'_, AppState>,
) -> Result<ScheduledTaskView, String> {
    if prompt.trim().is_empty() {
        return Err("prompt is required".to_string());
    }
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let task = db
        .create_agent_cron_task(
            &session_id,
            name.as_deref(),
            cron_expr.trim(),
            prompt.trim(),
            recurring.unwrap_or(true),
        )
        .map_err(|e| e.to_string())?;
    state.scheduler_notify.notify_waiters();
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
    let (due, next_fire) = {
        let db = match Database::open(&state.db_path) {
            Ok(db) => db,
            Err(err) => {
                tracing::warn!(target: "claudette::scheduling", error = %err, "failed to open db for scheduler");
                return Duration::from_secs(60);
            }
        };
        let due = db.due_agent_scheduled_tasks(now).unwrap_or_else(|err| {
            tracing::warn!(target: "claudette::scheduling", error = %err, "failed to load due scheduled tasks");
            Vec::new()
        });
        let next_fire = db.next_agent_schedule_fire_at().ok().flatten();
        (due, next_fire)
    };

    for task in due {
        if let Err(err) = mark_and_dispatch_due_task(app.clone(), task, now).await {
            tracing::warn!(target: "claudette::scheduling", error = %err, "failed to fire scheduled task");
        }
    }

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
    dispatch_task_prompt(app, task, "scheduled").await
}

pub async fn dispatch_task_prompt(
    app: AppHandle,
    task: ScheduledTask,
    source: &str,
) -> Result<(), String> {
    let prompt = build_dispatch_prompt(&task, source);
    dispatch_prompt_to_session(app, task.chat_session_id, prompt).await
}

pub async fn dispatch_prompt_to_session(
    app: AppHandle,
    chat_session_id: String,
    prompt: String,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    crate::commands::chat::send::send_chat_message(
        chat_session_id,
        None,
        prompt,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        None,
        app.clone(),
        state,
    )
    .await
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
            chat_session_id: "chat-1".into(),
            workspace_id: "ws-1".into(),
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
}
