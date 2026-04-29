use tauri::State;

use claudette::db::Database;
use claudette::model::{ChatMessage, CompletedTurnData, ConversationCheckpoint, TurnToolActivity};
use claudette::{git, snapshot};

use crate::state::AppState;

#[tauri::command]
pub async fn list_checkpoints(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<ConversationCheckpoint>, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.list_checkpoints_for_session(&session_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn rollback_to_checkpoint(
    session_id: String,
    checkpoint_id: String,
    restore_files: bool,
    state: State<'_, AppState>,
) -> Result<Vec<ChatMessage>, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let chat_session_id = session_id;

    // Load the target checkpoint and verify ownership.
    let checkpoint = db
        .get_checkpoint(&checkpoint_id)
        .map_err(|e| e.to_string())?
        .ok_or("Checkpoint not found")?;
    // Scope the rollback to the given session — prevents a rollback in tab A
    // from pruning messages in tab B. For pre-v20 checkpoints (empty
    // chat_session_id) we accept the caller's chat_session_id as
    // authoritative, since the backfill would have assigned all such
    // messages to a single session.
    if !checkpoint.chat_session_id.is_empty() && checkpoint.chat_session_id != chat_session_id {
        return Err("Checkpoint does not belong to this session".into());
    }

    // Look up the workspace for the file-restore branch below.
    let chat_session = db
        .get_chat_session(&chat_session_id)
        .map_err(|e| e.to_string())?
        .ok_or("Chat session not found")?;
    let workspace_id = chat_session.workspace_id.clone();

    // Guard: reject if agent is running.
    {
        let agents = state.agents.read().await;
        if let Some(session) = agents.get(&chat_session_id)
            && session.active_pid.is_some()
        {
            return Err("Cannot rollback while the agent is running".into());
        }
    }

    // Attempt file restore BEFORE any destructive DB writes so that a
    // failure does not leave the DB truncated while the frontend still shows
    // the full conversation.
    if restore_files {
        let workspaces = db.list_workspaces().map_err(|e| e.to_string())?;
        let ws = workspaces
            .iter()
            .find(|w| w.id == workspace_id)
            .ok_or("Workspace not found")?;
        let wt = ws
            .worktree_path
            .as_ref()
            .ok_or("Workspace has no worktree")?;

        if checkpoint.has_file_state {
            // New path: restore from SQLite snapshot.
            snapshot::restore_snapshot(&state.db_path, &checkpoint_id, wt)
                .await
                .map_err(|e| e.to_string())?;
        } else if let Some(ref commit_hash) = checkpoint.commit_hash {
            // Legacy path: restore from git commit.
            git::restore_to_commit(wt, commit_hash)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    // Now perform the destructive DB writes — safe because the risky git
    // operation (if requested) has already succeeded above. Scoped to this
    // session so sibling tabs are untouched.
    db.delete_session_messages_after(&chat_session_id, &checkpoint.message_id)
        .map_err(|e| e.to_string())?;
    db.delete_session_checkpoints_after(&chat_session_id, checkpoint.turn_index)
        .map_err(|e| e.to_string())?;

    // Reset the per-session agent state so the next turn starts fresh.
    // Rollback discards the session's prior work — record as a failure.
    let ended_sid = {
        let mut agents = state.agents.write().await;
        agents.remove(&chat_session_id).map(|s| s.session_id)
    };
    if let Some(sid) = ended_sid.as_deref() {
        let _ = db.end_agent_session(sid, false);
    }
    db.clear_chat_session_state(&chat_session_id)
        .map_err(|e| e.to_string())?;

    // Return the truncated message list for this session.
    db.list_chat_messages_for_session(&chat_session_id)
        .map_err(|e| e.to_string())
}

/// Clear the entire conversation for a workspace, optionally restoring files
/// to the merge-base (initial state before any agent work).
#[tauri::command]
pub async fn clear_conversation(
    session_id: String,
    restore_files: bool,
    state: State<'_, AppState>,
) -> Result<Vec<ChatMessage>, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let chat_session_id = session_id;
    let chat_session = db
        .get_chat_session(&chat_session_id)
        .map_err(|e| e.to_string())?
        .ok_or("Chat session not found")?;
    let workspace_id = chat_session.workspace_id.clone();

    // Guard: reject if agent is running.
    {
        let agents = state.agents.read().await;
        if let Some(session) = agents.get(&chat_session_id)
            && session.active_pid.is_some()
        {
            return Err("Cannot clear conversation while the agent is running".into());
        }
    }

    // Optionally restore files to the merge-base before clearing.
    if restore_files {
        let workspaces = db.list_workspaces().map_err(|e| e.to_string())?;
        let ws = workspaces
            .iter()
            .find(|w| w.id == workspace_id)
            .ok_or("Workspace not found")?;
        let wt = ws
            .worktree_path
            .as_ref()
            .ok_or("Workspace has no worktree")?;
        let repos = db.list_repositories().map_err(|e| e.to_string())?;
        let repo = repos
            .iter()
            .find(|r| r.id == ws.repository_id)
            .ok_or("Repository not found")?;
        let base = match repo.base_branch.as_deref() {
            Some(b) => b.to_string(),
            None => git::default_branch(&repo.path, repo.default_remote.as_deref())
                .await
                .map_err(|e| e.to_string())?,
        };
        let merge_base = claudette::diff::merge_base(wt, &ws.branch_name, &base)
            .await
            .map_err(|e| e.to_string())?;
        git::restore_to_commit(wt, &merge_base)
            .await
            .map_err(|e| e.to_string())?;
    }

    // Delete all messages and checkpoints for this session.
    db.delete_chat_messages_for_session(&chat_session_id)
        .map_err(|e| e.to_string())?;
    // Checkpoints cascade via FK, but delete explicitly for clarity.
    db.delete_session_checkpoints_after(&chat_session_id, -1)
        .map_err(|e| e.to_string())?;

    // Reset agent session. Clearing the conversation discards the session's
    // prior work, so it did not run to completion — record as a failure.
    let ended_sid = {
        let mut agents = state.agents.write().await;
        agents.remove(&chat_session_id).map(|s| s.session_id)
    };
    if let Some(sid) = ended_sid.as_deref() {
        let _ = db.end_agent_session(sid, false);
    }
    db.clear_chat_session_state(&chat_session_id)
        .map_err(|e| e.to_string())?;

    // Return empty list.
    db.list_chat_messages_for_session(&chat_session_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_turn_tool_activities(
    checkpoint_id: String,
    message_count: i32,
    activities: Vec<TurnToolActivity>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.save_turn_tool_activities(&checkpoint_id, message_count, &activities)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn load_completed_turns(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<CompletedTurnData>, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.list_completed_turns_for_session(&session_id)
        .map_err(|e| e.to_string())
}
