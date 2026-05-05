use tauri::{AppHandle, State};

use claudette::agent;
use claudette::db::Database;
use claudette::model::ChatSession;

use crate::state::{AgentSessionState, AppState};

/// Overlay live runtime fields (agent_status, needs_attention, attention_kind)
/// from `AppState.agents` onto a `ChatSession` loaded from the DB. The DB
/// defaults are `Idle`/`false`/`None`; this replaces them with whatever the
/// running agent map reports.
fn hydrate_session(
    mut session: ChatSession,
    agents: &std::collections::HashMap<String, AgentSessionState>,
) -> ChatSession {
    if let Some(agent) = agents.get(&session.id) {
        session.agent_status = if agent.active_pid.is_some() {
            claudette::model::AgentStatus::Running
        } else if !agent.running_background_tasks.is_empty() {
            claudette::model::AgentStatus::IdleWithBackground
        } else {
            claudette::model::AgentStatus::Idle
        };
        session.needs_attention = agent.needs_attention;
        session.attention_kind = agent.attention_kind.map(|k| match k {
            crate::state::AttentionKind::Ask => claudette::model::AttentionKind::Ask,
            crate::state::AttentionKind::Plan => claudette::model::AttentionKind::Plan,
        });
    }
    session
}

#[tauri::command]
pub async fn list_chat_sessions(
    workspace_id: String,
    include_archived: Option<bool>,
    state: State<'_, AppState>,
) -> Result<Vec<ChatSession>, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let sessions = db
        .list_chat_sessions_for_workspace(&workspace_id, include_archived.unwrap_or(false))
        .map_err(|e| e.to_string())?;
    let agents = state.agents.read().await;
    Ok(sessions
        .into_iter()
        .map(|s| hydrate_session(s, &agents))
        .collect())
}

#[tauri::command]
pub async fn get_chat_session(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<ChatSession, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let session = db
        .get_chat_session(&session_id)
        .map_err(|e| e.to_string())?
        .ok_or("Session not found")?;
    let agents = state.agents.read().await;
    Ok(hydrate_session(session, &agents))
}

/// Body of [`create_chat_session`], extracted so unit tests can drive it
/// without going through Tauri's `State<'_, _>` plumbing. A brand-new chat
/// session has no entry in `state.agents`, so the live-agent overlay would
/// always be a no-op — we deliberately skip [`hydrate_session`] (and the
/// `state.agents` read it would require) so the "+ new session" click
/// can't get queued behind a streaming task that holds the agents lock
/// for writes per-event. The DB defaults (`Idle`, no attention) are
/// already the right values for a freshly-created session. See issue #574.
async fn create_chat_session_inner(
    state: &AppState,
    workspace_id: &str,
) -> Result<ChatSession, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.create_chat_session(workspace_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_chat_session(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<ChatSession, String> {
    create_chat_session_inner(&state, &workspace_id).await
}

#[tauri::command]
pub async fn rename_chat_session(
    session_id: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let capped = claudette::model::validate_session_name(&name).map_err(String::from)?;
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.rename_chat_session(&session_id, &capped)
        .map_err(|e| e.to_string())
}

/// Reassign `sort_order` of chat sessions in the given workspace to match the
/// supplied id sequence. Used by the unified workspace-tab drag-reorder; for
/// files/diffs the order is volatile and only needs frontend state, so this
/// command only ever touches chat sessions.
#[tauri::command]
pub async fn reorder_chat_sessions(
    workspace_id: String,
    session_ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.reorder_chat_sessions(&workspace_id, &session_ids)
        .map_err(|e| e.to_string())
}

/// Archive a chat session (soft-delete). Stops its running agent first, then
/// marks the row archived. If this was the workspace's last active session,
/// a fresh `New chat` session is created so every workspace always has ≥1
/// active session. Returns the newly created session in that case, `None`
/// otherwise — the frontend uses the return value to select the new tab.
#[tauri::command]
pub async fn archive_chat_session(
    app: AppHandle,
    session_id: String,
    state: State<'_, AppState>,
) -> Result<Option<ChatSession>, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let session = db
        .get_chat_session(&session_id)
        .map_err(|e| e.to_string())?
        .ok_or("Session not found")?;
    let workspace_id = session.workspace_id.clone();

    // Stop and remove the live agent for this session.
    // Capture the PID under the lock, then drop the lock before the async stop.
    let pid_to_stop = {
        let mut agents = state.agents.write().await;
        agents
            .remove(&session_id)
            .and_then(|mut agent| agent.active_pid.take())
    };
    if let Some(pid) = pid_to_stop {
        let _ = agent::stop_agent(pid).await;
    }

    let fresh = db
        .archive_chat_session_ensuring_active(&session_id, &workspace_id)
        .map_err(|e| e.to_string())?;

    // Rebuild the tray so per-workspace running/attention aggregates reflect
    // the removed agent (and, if this was the last session, the auto-created
    // replacement). Without this, the tray can keep showing stale state until
    // another action triggers a rebuild.
    crate::tray::rebuild_tray(&app);

    if let Some(fresh) = fresh {
        let agents = state.agents.read().await;
        return Ok(Some(hydrate_session(fresh, &agents)));
    }

    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use claudette::model::{AgentStatus, Repository, Workspace, WorkspaceStatus};
    use claudette::plugin_runtime::PluginRegistry;
    use std::path::PathBuf;
    use std::time::Duration;
    use tempfile::tempdir;

    fn make_repo(id: &str) -> Repository {
        Repository {
            id: id.into(),
            path: format!("/tmp/{id}"),
            name: id.into(),
            path_slug: id.into(),
            icon: None,
            created_at: String::new(),
            setup_script: None,
            custom_instructions: None,
            sort_order: 0,
            branch_rename_preferences: None,
            setup_script_auto_run: false,
            base_branch: None,
            default_remote: None,
            path_valid: true,
        }
    }

    fn make_workspace(id: &str, repo_id: &str) -> Workspace {
        Workspace {
            id: id.into(),
            repository_id: repo_id.into(),
            name: id.into(),
            branch_name: format!("claudette/{id}"),
            worktree_path: None,
            status: WorkspaceStatus::Active,
            agent_status: AgentStatus::Idle,
            status_line: String::new(),
            created_at: String::new(),
            sort_order: 0,
        }
    }

    fn fresh_state(db_path: PathBuf) -> AppState {
        let plugins = PluginRegistry::discover(std::path::Path::new("/nonexistent"));
        AppState::new(db_path, std::path::PathBuf::from("/tmp"), plugins)
    }

    fn make_chat_session(id: &str) -> ChatSession {
        ChatSession {
            id: id.to_string(),
            workspace_id: "w1".to_string(),
            session_id: None,
            name: "New chat".to_string(),
            name_edited: false,
            turn_count: 0,
            sort_order: 0,
            status: claudette::model::SessionStatus::Active,
            created_at: String::new(),
            archived_at: None,
            agent_status: AgentStatus::Idle,
            needs_attention: false,
            attention_kind: None,
        }
    }

    fn make_agent_state(background_tasks: &[&str], active_pid: Option<u32>) -> AgentSessionState {
        AgentSessionState {
            workspace_id: "w1".to_string(),
            session_id: "claude-session".to_string(),
            turn_count: 1,
            active_pid,
            custom_instructions: None,
            needs_attention: false,
            attention_kind: None,
            attention_notification_sent: false,
            persistent_session: None,
            mcp_config_dirty: false,
            session_plan_mode: false,
            session_allowed_tools: Vec::new(),
            session_disable_1m_context: false,
            pending_permissions: Default::default(),
            running_background_tasks: background_tasks
                .iter()
                .map(|task| (*task).to_string())
                .collect(),
            background_wake_active: false,
            session_exited_plan: false,
            session_resolved_env: Default::default(),
            mcp_bridge: None,
            last_user_msg_id: None,
            posted_env_trust_warning: false,
        }
    }

    #[test]
    fn hydrate_session_reports_idle_with_background_when_tasks_are_running() {
        let mut agents = std::collections::HashMap::new();
        agents.insert("s1".to_string(), make_agent_state(&["task-1"], None));

        let session = hydrate_session(make_chat_session("s1"), &agents);

        assert_eq!(session.agent_status, AgentStatus::IdleWithBackground);
    }

    #[test]
    fn hydrate_session_reports_running_before_background_status() {
        let mut agents = std::collections::HashMap::new();
        agents.insert("s1".to_string(), make_agent_state(&["task-1"], Some(42)));

        let session = hydrate_session(make_chat_session("s1"), &agents);

        assert_eq!(session.agent_status, AgentStatus::Running);
    }

    /// Regression test for issue #574: while a streaming task holds
    /// `state.agents.write()`, clicking "+" must still create a session
    /// promptly. Tokio's RwLock is writer-preferring, so a `read().await`
    /// queued behind a writer (and behind further writers that re-queue)
    /// can starve indefinitely. The fix is for `create_chat_session` to
    /// not touch `state.agents` at all — a brand-new session has no entry
    /// to hydrate.
    #[tokio::test]
    async fn create_chat_session_does_not_block_on_agents_writer() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        {
            let db = Database::open(&db_path).unwrap();
            db.insert_repository(&make_repo("r1")).unwrap();
            db.insert_workspace(&make_workspace("w1", "r1")).unwrap();
        }

        let state = fresh_state(db_path);

        // Hold the agents write lock for the duration of the call —
        // simulates the streaming task in `send.rs` mid-turn.
        let writer = state.agents.write().await;

        // 500ms is generous: the create itself is microseconds. If we hit
        // the timeout, the call is blocked on `state.agents.read().await`.
        let outcome = tokio::time::timeout(
            Duration::from_millis(500),
            create_chat_session_inner(&state, "w1"),
        )
        .await;

        drop(writer);

        let session = outcome
            .expect(
                "create_chat_session blocked while another task held the agents write lock — \
                 issue #574 regression",
            )
            .expect("create_chat_session_inner returned an error");
        assert_eq!(session.workspace_id, "w1");
    }
}
