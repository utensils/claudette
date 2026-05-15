use std::io::SeekFrom;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use claudette::agent::background::workspace_terminal_output_path;
use claudette::db::{CLAUDETTE_TERMINAL_TITLE, Database};
use claudette::model::{TerminalTab, TerminalTabKind};

use crate::state::{AgentTaskTailHandle, AppState};

#[tauri::command]
pub async fn create_terminal_tab(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<TerminalTab, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;

    let max_id = db.max_terminal_tab_id().map_err(|e| e.to_string())?;
    let new_id = max_id + 1;

    let existing = db
        .list_terminal_tabs_by_workspace(&workspace_id)
        .map_err(|e| e.to_string())?;
    let sort_order = existing.len() as i32;

    // Find the lowest unused terminal number to avoid title collisions.
    let mut n = 1;
    let used_titles: Vec<_> = existing.iter().map(|t| t.title.as_str()).collect();
    while used_titles.contains(&format!("Terminal {n}").as_str()) {
        n += 1;
    }

    let tab = TerminalTab {
        id: new_id,
        workspace_id,
        title: format!("Terminal {n}"),
        kind: Default::default(),
        is_script_output: false,
        sort_order,
        created_at: now_iso(),
        agent_chat_session_id: None,
        agent_tool_use_id: None,
        agent_task_id: None,
        output_path: None,
        task_status: None,
        task_summary: None,
    };

    db.insert_terminal_tab(&tab).map_err(|e| e.to_string())?;

    Ok(tab)
}

/// Synchronously ensure the Claudette Terminal tab exists for a
/// workspace, bound to the workspace-scoped provisioning output file.
/// Called from `create_workspace` / `fork_workspace_at_checkpoint` /
/// `run_workspace_setup` *before* env-provider + setup-script sinks
/// start appending — the tab needs to be in the database when the
/// frontend's `workspaces-changed` listener queries `list_terminal_tabs`
/// for the new row, or the tail won't start.
///
/// If a tab already exists for this workspace (manual setup rerun, or
/// re-fork onto the same workspace id), re-stamp its `output_path` to
/// the workspace-scoped file. A stale tab might still point at the
/// legacy `agent_bash_output_path(chat_session_id)` from before the
/// unified-transcript refactor, or at a different workspace's path if
/// the DB row was migrated — either way, the live env/setup sinks are
/// writing to `workspace_terminal_output_path(workspace_id)` and the
/// visible tab must follow. The `agent_chat_session_id` binding is
/// preserved so background-task lookups by session still resolve.
pub fn ensure_workspace_provisioning_terminal_tab(
    db_path: &std::path::Path,
    workspace_id: &str,
) -> Result<TerminalTab, String> {
    let db = Database::open(db_path).map_err(|e| e.to_string())?;
    let output_path = workspace_terminal_output_path(workspace_id)
        .to_string_lossy()
        .into_owned();

    if let Some(mut tab) = db
        .get_agent_shell_terminal_tab_by_workspace(workspace_id)
        .map_err(|e| e.to_string())?
    {
        // Rebind to the workspace-scoped file. The DB helper requires
        // a session id; reuse whatever the tab already had, falling
        // back to empty string when this is a fresh provisioning tab
        // with no session yet (the typical workspace-create case).
        let session_id = tab.agent_chat_session_id.clone().unwrap_or_default();
        db.update_agent_shell_terminal_tab_session(tab.id, &session_id, &output_path)
            .map_err(|e| e.to_string())?;
        tab.title = CLAUDETTE_TERMINAL_TITLE.to_string();
        tab.output_path = Some(output_path);
        tab.task_status = None;
        tab.task_summary = None;
        return Ok(tab);
    }

    let tab = TerminalTab {
        id: db.max_terminal_tab_id().map_err(|e| e.to_string())? + 1,
        workspace_id: workspace_id.to_string(),
        title: CLAUDETTE_TERMINAL_TITLE.to_string(),
        kind: TerminalTabKind::AgentTask,
        is_script_output: false,
        // sort_order < 0 so the Claudette Terminal sorts before any
        // user-created `Terminal 1/2/3...` tabs, matching the
        // chat-session ensure path's convention.
        sort_order: -1,
        created_at: now_iso(),
        agent_chat_session_id: None,
        agent_tool_use_id: None,
        agent_task_id: None,
        output_path: Some(output_path),
        task_status: None,
        task_summary: None,
    };
    db.insert_terminal_tab(&tab).map_err(|e| e.to_string())?;
    Ok(tab)
}

#[tauri::command]
pub async fn ensure_claudette_terminal_tab(
    workspace_id: String,
    chat_session_id: String,
    state: State<'_, AppState>,
) -> Result<TerminalTab, String> {
    // The Claudette Terminal tab is workspace-scoped now, not
    // chat-session-scoped: env-provider provisioning writes here,
    // setup-script writes here, and (per the refactor below) the
    // agent shell tool writes here. Binding to the chat-session
    // agent-shell file would lose the provisioning transcript the
    // moment the first chat session is materialized, which defeats
    // the whole reason this tab exists.
    //
    // We still update `agent_chat_session_id` so background-task
    // code that looks up the tab by session can find it.
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let output_path = workspace_terminal_output_path(&workspace_id)
        .to_string_lossy()
        .into_owned();

    if let Some(mut tab) = db
        .get_agent_shell_terminal_tab_by_workspace(&workspace_id)
        .map_err(|e| e.to_string())?
    {
        db.update_agent_shell_terminal_tab_session(tab.id, &chat_session_id, &output_path)
            .map_err(|e| e.to_string())?;
        tab.title = CLAUDETTE_TERMINAL_TITLE.to_string();
        tab.agent_chat_session_id = Some(chat_session_id);
        tab.agent_tool_use_id = None;
        tab.agent_task_id = None;
        tab.output_path = Some(output_path);
        tab.task_status = None;
        tab.task_summary = None;
        return Ok(tab);
    }

    let tab = TerminalTab {
        id: db.max_terminal_tab_id().map_err(|e| e.to_string())? + 1,
        workspace_id,
        title: CLAUDETTE_TERMINAL_TITLE.to_string(),
        kind: TerminalTabKind::AgentTask,
        is_script_output: false,
        sort_order: -1,
        created_at: now_iso(),
        agent_chat_session_id: Some(chat_session_id),
        agent_tool_use_id: None,
        agent_task_id: None,
        output_path: Some(output_path),
        task_status: None,
        task_summary: None,
    };
    db.insert_terminal_tab(&tab).map_err(|e| e.to_string())?;
    Ok(tab)
}

#[tauri::command]
pub async fn delete_terminal_tab(id: i64, state: State<'_, AppState>) -> Result<(), String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.delete_terminal_tab(id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_terminal_tabs(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<TerminalTab>, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.list_terminal_tabs_by_workspace(&workspace_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_terminal_tab_order(
    workspace_id: String,
    tab_ids: Vec<i64>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.update_terminal_tab_sort_order(&workspace_id, &tab_ids)
        .map_err(|e| e.to_string())
}

#[derive(Clone, Serialize)]
struct AgentTaskOutputPayload {
    tab_id: i64,
    data: Vec<u8>,
    reset: bool,
}

#[tauri::command]
pub async fn start_agent_task_tail(
    tab_id: i64,
    output_path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if output_path.trim().is_empty() {
        return Err("Output path is empty".to_string());
    }

    stop_agent_task_tail(tab_id, state.clone()).await?;

    let cancel = Arc::new(tokio::sync::Notify::new());
    state.agent_task_tailers.write().await.insert(
        tab_id,
        AgentTaskTailHandle {
            cancel: cancel.clone(),
        },
    );

    tokio::spawn(async move {
        tail_agent_task_file(tab_id, PathBuf::from(output_path), app, cancel).await;
    });

    Ok(())
}

#[tauri::command]
pub async fn stop_agent_task_tail(tab_id: i64, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(handle) = state.agent_task_tailers.write().await.remove(&tab_id) {
        handle.cancel.notify_waiters();
    }
    Ok(())
}

#[tauri::command]
pub async fn stop_agent_background_task(
    chat_session_id: String,
    task_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let ps = {
        let agents = state.agents.read().await;
        agents
            .get(&chat_session_id)
            .and_then(|session| session.persistent_session.clone())
    };
    let Some(ps) = ps else {
        return Err("Agent session is not running".to_string());
    };
    ps.send_task_stop(&task_id).await?;
    {
        let mut agents = state.agents.write().await;
        if let Some(session) = agents.get_mut(&chat_session_id) {
            session.running_background_tasks.remove(&task_id);
            session.background_task_output_paths.remove(&task_id);
        }
    }

    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let _ = db.update_agent_task_terminal_tab_status(
        &chat_session_id,
        &task_id,
        "stopped",
        Some("Stopped by user"),
        None,
    );
    if let Ok(Some(tab)) = db.get_terminal_tab_by_agent_task(&chat_session_id, &task_id) {
        let _ = app.emit(
            "agent-background-task",
            &claudette::agent::background::AgentBackgroundTaskEvent {
                kind: claudette::agent::background::AgentBackgroundTaskEventKind::Status,
                workspace_id: tab.workspace_id.clone(),
                chat_session_id,
                tab,
            },
        );
    }
    Ok(())
}

/// Cap the initial dump to the last ~64 KiB of an existing output file.
/// A long-lived agent shell can accumulate megabytes of history; emitting
/// it all on first attach would lock the renderer and force xterm to
/// reflow a huge buffer. New writes (the common case once the tail is
/// caught up) ignore this cap.
const INITIAL_TAIL_BYTES: u64 = 64 * 1024;

async fn tail_agent_task_file(
    tab_id: i64,
    path: PathBuf,
    app: AppHandle,
    cancel: Arc<tokio::sync::Notify>,
) {
    // Seed `offset` so the first read returns at most the last
    // INITIAL_TAIL_BYTES of an already-grown file. We still emit a `reset`
    // marker before the chunk so the frontend doesn't render half-baked
    // output ahead of a partial line — the agent shell is line-oriented
    // so an interior offset is fine for visual continuity.
    let mut offset = match tokio::fs::metadata(&path).await {
        Ok(meta) => meta.len().saturating_sub(INITIAL_TAIL_BYTES),
        Err(_) => 0,
    };
    if offset > 0 {
        let _ = app.emit(
            "agent-task-output",
            &AgentTaskOutputPayload {
                tab_id,
                data: Vec::new(),
                reset: true,
            },
        );
    }
    let mut buf = vec![0_u8; 8192];
    loop {
        tokio::select! {
            _ = cancel.notified() => break,
            _ = tokio::time::sleep(Duration::from_millis(33)) => {}
        }

        let Ok(mut file) = tokio::fs::File::open(&path).await else {
            continue;
        };
        let len = file.metadata().await.ok().map(|m| m.len()).unwrap_or(0);
        if len < offset {
            offset = 0;
            let _ = app.emit(
                "agent-task-output",
                &AgentTaskOutputPayload {
                    tab_id,
                    data: Vec::new(),
                    reset: true,
                },
            );
        }
        if file.seek(SeekFrom::Start(offset)).await.is_err() {
            continue;
        }
        loop {
            match file.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => {
                    offset += n as u64;
                    let _ = app.emit(
                        "agent-task-output",
                        &AgentTaskOutputPayload {
                            tab_id,
                            data: buf[..n].to_vec(),
                            reset: false,
                        },
                    );
                }
                Err(_) => break,
            }
        }
    }
}

fn now_iso() -> String {
    let dur = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{}", dur.as_secs())
}
