//! Workspace forking: clone a workspace at a specific conversation
//! checkpoint so the user can continue the conversation from that point
//! without disturbing the original.
//!
//! A fork creates a new workspace whose:
//!   - git worktree is branched from the checkpoint's commit (file state
//!     matches the chosen turn),
//!   - chat messages and conversation checkpoints are copied from the
//!     source workspace up to and including the chosen turn,
//!   - Claude CLI session (JSONL transcript) is copied when present so the
//!     next turn can `--resume` without losing conversational context.
//!
//! The heavy lifting lives here (rather than in `src-tauri`) so the logic
//! is testable without a Tauri runtime.

use std::path::{Path, PathBuf};

use crate::db::Database;
use crate::git;
use crate::model::{
    AgentStatus, ChatMessage, CheckpointFile, ConversationCheckpoint, TurnToolActivity, Workspace,
    WorkspaceStatus,
};
use crate::snapshot;

#[derive(Debug)]
pub enum ForkError {
    SourceWorkspaceMissing,
    SourceRepoMissing,
    CheckpointMissing,
    /// The source workspace has no worktree on disk, so we cannot resolve a
    /// base ref to branch the fork from.
    SourceWorktreeMissing,
    /// A checkpoint/message mapping was missing during the copy.
    InconsistentHistory(String),
    Db(rusqlite::Error),
    Git(git::GitError),
    Snapshot(String),
    Io(std::io::Error),
}

impl std::fmt::Display for ForkError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SourceWorkspaceMissing => write!(f, "Source workspace not found"),
            Self::SourceRepoMissing => write!(f, "Source workspace's repository not found"),
            Self::CheckpointMissing => write!(f, "Checkpoint not found"),
            Self::SourceWorktreeMissing => write!(
                f,
                "Source workspace has no worktree on disk; cannot determine base ref for fork"
            ),
            Self::InconsistentHistory(msg) => write!(f, "Inconsistent history: {msg}"),
            Self::Db(e) => write!(f, "Database error: {e}"),
            Self::Git(e) => write!(f, "Git error: {e:?}"),
            Self::Snapshot(msg) => write!(f, "Snapshot error: {msg}"),
            Self::Io(e) => write!(f, "I/O error: {e}"),
        }
    }
}

impl std::error::Error for ForkError {}

impl From<rusqlite::Error> for ForkError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Db(e)
    }
}

impl From<git::GitError> for ForkError {
    fn from(e: git::GitError) -> Self {
        Self::Git(e)
    }
}

impl From<std::io::Error> for ForkError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}

/// Inputs to [`fork_workspace_at_checkpoint`], grouped for clarity since the
/// list is long and several fields are orthogonal.
pub struct ForkInputs<'a> {
    pub source_workspace_id: &'a str,
    pub checkpoint_id: &'a str,
    /// e.g. `.../worktrees/{repo_slug}/{name}` — caller joins base dir.
    pub worktree_base: &'a Path,
    /// e.g. `"seancallan/"` or `""` — caller resolves prefix from settings.
    pub branch_prefix: &'a str,
    /// Path to the SQLite database. Needed because
    /// [`snapshot::restore_snapshot`] opens its own connection to avoid the
    /// `rusqlite::Connection: !Send` problem across await points.
    pub db_path: &'a Path,
    /// Function that produces the current timestamp string used for
    /// `Workspace::created_at`. Injected for deterministic tests.
    pub now_iso: fn() -> String,
}

pub struct ForkOutcome {
    pub workspace: Workspace,
    /// Whether a Claude session JSONL transcript was successfully copied,
    /// allowing the new workspace to `--resume` on its next turn.
    pub session_resumed: bool,
}

/// Takes `&mut Database` so the returned future is `Send` — `Database` wraps
/// a `rusqlite::Connection` (holds a `RefCell`), making `&Database: !Send`.
/// Exclusive access lets us keep the reference across the single `await`.
pub async fn fork_workspace_at_checkpoint(
    db: &mut Database,
    inputs: ForkInputs<'_>,
) -> Result<ForkOutcome, ForkError> {
    let source_ws = db
        .list_workspaces()?
        .into_iter()
        .find(|w| w.id == inputs.source_workspace_id)
        .ok_or(ForkError::SourceWorkspaceMissing)?;
    let repo = db
        .list_repositories()?
        .into_iter()
        .find(|r| r.id == source_ws.repository_id)
        .ok_or(ForkError::SourceRepoMissing)?;
    let checkpoint = db
        .get_checkpoint(inputs.checkpoint_id)?
        .ok_or(ForkError::CheckpointMissing)?;

    if checkpoint.workspace_id != source_ws.id {
        return Err(ForkError::InconsistentHistory(format!(
            "checkpoint {} does not belong to workspace {}",
            checkpoint.id, source_ws.id
        )));
    }

    // Resolve the base commit to branch from. Prefer the checkpoint's
    // recorded commit_hash (legacy path); otherwise fall back to the source
    // worktree's current HEAD — the fork still gets a stable ancestry point,
    // and the snapshot restore below will overwrite files to match the
    // chosen turn.
    let base_ref = if let Some(hash) = checkpoint.commit_hash.clone() {
        hash
    } else {
        let src_wt = source_ws
            .worktree_path
            .as_deref()
            .ok_or(ForkError::SourceWorktreeMissing)?;
        git::head_commit(src_wt).await?
    };

    let (new_name, new_branch_name) = allocate_name_and_branch(
        db,
        &source_ws.repository_id,
        &source_ws.name,
        inputs.branch_prefix,
    )?;
    let worktree_path: PathBuf = inputs.worktree_base.join(&repo.path_slug).join(&new_name);
    let worktree_path_str = worktree_path.to_string_lossy().to_string();

    let actual_path =
        git::create_worktree_from_ref(&repo.path, &new_branch_name, &worktree_path_str, &base_ref)
            .await?;

    // From here on we own a worktree + branch on disk. If any subsequent step
    // fails, roll them back best-effort so we don't leave orphan state.
    let outcome = fork_after_worktree(
        db,
        &inputs,
        &source_ws,
        &checkpoint,
        new_name,
        new_branch_name.clone(),
        actual_path.clone(),
    )
    .await;

    if outcome.is_err() {
        let _ = git::remove_worktree(&repo.path, &actual_path, true).await;
        let _ = git::branch_delete(&repo.path, &new_branch_name).await;
    }

    outcome
}

/// Steps that run after a successful `create_worktree_from_ref`. Split out so
/// the caller can funnel all failures through a single cleanup path.
async fn fork_after_worktree(
    db: &mut Database,
    inputs: &ForkInputs<'_>,
    source_ws: &Workspace,
    checkpoint: &ConversationCheckpoint,
    new_name: String,
    new_branch_name: String,
    actual_path: String,
) -> Result<ForkOutcome, ForkError> {
    // Restore the checkpoint's file snapshot (if present) onto the new
    // worktree so its files match the selected turn, not the base commit.
    if checkpoint.has_file_state {
        snapshot::restore_snapshot(inputs.db_path, &checkpoint.id, &actual_path)
            .await
            .map_err(|e| ForkError::Snapshot(e.to_string()))?;
    }

    let mut new_ws = Workspace {
        id: uuid::Uuid::new_v4().to_string(),
        repository_id: source_ws.repository_id.clone(),
        name: new_name,
        branch_name: new_branch_name,
        worktree_path: Some(actual_path.clone()),
        status: WorkspaceStatus::Active,
        agent_status: AgentStatus::Idle,
        status_line: String::new(),
        created_at: (inputs.now_iso)(),
        // Placeholder; patched below to the value `insert_workspace` actually
        // assigned (MAX+1 within repo) so callers handing this struct back
        // to the UI render the new fork at the right sidebar position.
        sort_order: 0,
    };
    db.insert_workspace(&new_ws)?;
    if let Some(o) = db.lookup_workspace_sort_order(&new_ws.id)? {
        new_ws.sort_order = o;
    }

    copy_history(db, &source_ws.id, &new_ws.id, checkpoint)?;

    let session_resumed = if let Some(src_wt) = source_ws.worktree_path.as_deref() {
        // The source's Claude CLI session id lives on the SOURCE chat
        // session — the one this checkpoint was taken in — not on the
        // workspace. Likewise the destination is the new workspace's
        // default chat session, the same one `copy_history` populated.
        let new_chat_session_id = db
            .default_session_id_for_workspace(&new_ws.id)?
            .ok_or_else(|| {
                ForkError::InconsistentHistory(format!(
                    "new workspace {} has no default session",
                    new_ws.id
                ))
            })?;
        let Some(projects_dir) = claude_projects_dir() else {
            // No discoverable home directory — graceful skip, same as a
            // missing transcript file. Fork still succeeds with a fresh
            // Claude session.
            return Ok(ForkOutcome {
                workspace: new_ws,
                session_resumed: false,
            });
        };
        copy_claude_session(
            db,
            &checkpoint.chat_session_id,
            &new_chat_session_id,
            src_wt,
            &actual_path,
            &projects_dir,
        )?
    } else {
        false
    };

    Ok(ForkOutcome {
        workspace: new_ws,
        session_resumed,
    })
}

/// Allocate a workspace name + branch name that do not collide with existing
/// workspaces in the same repository. Appends `-fork`, then `-fork-2`, etc.
fn allocate_name_and_branch(
    db: &Database,
    repo_id: &str,
    source_name: &str,
    branch_prefix: &str,
) -> Result<(String, String), ForkError> {
    let existing_names: std::collections::HashSet<String> = db
        .list_workspaces()?
        .into_iter()
        .filter(|w| w.repository_id == repo_id)
        .map(|w| w.name)
        .collect();

    let base = format!("{source_name}-fork");
    let name = if !existing_names.contains(&base) {
        base
    } else {
        let mut n = 2;
        loop {
            let candidate = format!("{source_name}-fork-{n}");
            if !existing_names.contains(&candidate) {
                break candidate;
            }
            n += 1;
        }
    };
    let branch = format!("{branch_prefix}{name}");
    Ok((name, branch))
}

/// Copy chat messages, checkpoints and tool activities from the source
/// workspace up to and including the checkpoint.
///
/// Messages and checkpoints get fresh UUIDs in the fork; we map old→new
/// message IDs so each copied checkpoint's `message_id` anchors to the new
/// message it corresponds to.
fn copy_history(
    db: &Database,
    source_ws_id: &str,
    new_ws_id: &str,
    checkpoint: &ConversationCheckpoint,
) -> Result<(), ForkError> {
    let source_messages = db.list_messages_up_to(source_ws_id, &checkpoint.message_id)?;

    // The new workspace was just created and always has exactly one default
    // session. Anchor every copied message/checkpoint to it so the forked
    // conversation is reachable from the new workspace's initial tab.
    let new_chat_session_id = db
        .default_session_id_for_workspace(new_ws_id)?
        .ok_or_else(|| {
            ForkError::InconsistentHistory(format!(
                "new workspace {new_ws_id} has no default session"
            ))
        })?;

    let mut msg_id_map: std::collections::HashMap<String, String> =
        std::collections::HashMap::with_capacity(source_messages.len());

    for msg in &source_messages {
        let new_id = uuid::Uuid::new_v4().to_string();
        msg_id_map.insert(msg.id.clone(), new_id.clone());
        let copied = ChatMessage {
            id: new_id,
            workspace_id: new_ws_id.to_string(),
            chat_session_id: new_chat_session_id.clone(),
            role: msg.role.clone(),
            content: msg.content.clone(),
            cost_usd: msg.cost_usd,
            duration_ms: msg.duration_ms,
            // created_at is set by the DB default on insert.
            created_at: String::new(),
            thinking: msg.thinking.clone(),
            input_tokens: msg.input_tokens,
            output_tokens: msg.output_tokens,
            cache_read_tokens: msg.cache_read_tokens,
            cache_creation_tokens: msg.cache_creation_tokens,
        };
        db.insert_chat_message(&copied)?;
    }

    let source_checkpoints = db.list_checkpoints_up_to(source_ws_id, checkpoint.turn_index)?;
    let source_turn_data = db.list_completed_turns(source_ws_id)?;
    let activities_by_cp: std::collections::HashMap<String, Vec<TurnToolActivity>> =
        source_turn_data
            .into_iter()
            .map(|td| (td.checkpoint_id, td.activities))
            .collect();

    for cp in source_checkpoints {
        let new_cp_id = uuid::Uuid::new_v4().to_string();
        let new_msg_id = msg_id_map.get(&cp.message_id).ok_or_else(|| {
            ForkError::InconsistentHistory(format!(
                "checkpoint {} anchors to message {} which was not copied",
                cp.id, cp.message_id
            ))
        })?;
        let new_cp = ConversationCheckpoint {
            id: new_cp_id.clone(),
            workspace_id: new_ws_id.to_string(),
            chat_session_id: new_chat_session_id.clone(),
            message_id: new_msg_id.clone(),
            commit_hash: cp.commit_hash.clone(),
            // `has_file_state` is derived by the DB from the presence of
            // `checkpoint_files` rows, so this field is informational on
            // insert; the real source of truth is the rows we copy below.
            has_file_state: cp.has_file_state,
            turn_index: cp.turn_index,
            message_count: cp.message_count,
            created_at: String::new(),
        };
        db.insert_checkpoint(&new_cp)?;

        // Copy snapshot files so rollback in the fork can restore to this
        // checkpoint. Without this, snapshot-only checkpoints (the norm
        // since Claudette migrated away from git-commit checkpoints) would
        // have neither a commit nor file data to restore from in the fork.
        if cp.has_file_state {
            let files = db.get_checkpoint_files(&cp.id)?;
            let remapped_files: Vec<CheckpointFile> = files
                .into_iter()
                .map(|f| CheckpointFile {
                    id: uuid::Uuid::new_v4().to_string(),
                    checkpoint_id: new_cp_id.clone(),
                    file_path: f.file_path,
                    content: f.content,
                    file_mode: f.file_mode,
                })
                .collect();
            if !remapped_files.is_empty() {
                db.insert_checkpoint_files(&remapped_files)?;
            }
        }

        if let Some(acts) = activities_by_cp.get(&cp.id) {
            let remapped: Vec<TurnToolActivity> = acts
                .iter()
                .map(|a| TurnToolActivity {
                    id: uuid::Uuid::new_v4().to_string(),
                    checkpoint_id: new_cp_id.clone(),
                    tool_use_id: a.tool_use_id.clone(),
                    tool_name: a.tool_name.clone(),
                    input_json: a.input_json.clone(),
                    result_text: a.result_text.clone(),
                    summary: a.summary.clone(),
                    sort_order: a.sort_order,
                    assistant_message_ordinal: a.assistant_message_ordinal,
                    agent_task_id: a.agent_task_id.clone(),
                    agent_description: a.agent_description.clone(),
                    agent_last_tool_name: a.agent_last_tool_name.clone(),
                    agent_tool_use_count: a.agent_tool_use_count,
                    agent_status: a.agent_status.clone(),
                    agent_tool_calls_json: a.agent_tool_calls_json.clone(),
                })
                .collect();
            db.insert_turn_tool_activities(&remapped)?;
        }
    }

    Ok(())
}

/// Copy Claude CLI's JSONL session transcript from the source workspace's
/// project directory to the new workspace's project directory, so the
/// forked workspace can `--resume` from the same session history.
///
/// Operates at the chat-session granularity: the source id is the chat
/// session the chosen checkpoint was taken in, and the destination is the
/// new workspace's default chat session (the one `copy_history` already
/// populated). Pre-multi-session refactor this code worked at workspace
/// granularity by reading `workspaces.session_id`; that column became dead
/// when chat sessions arrived (20260422000000_chat_sessions), and the
/// missed migration here is what made every fork start a fresh Claude
/// session — see `test_fork_resumes_claude_session` for the regression pin.
///
/// Returns `true` if the transcript was found and copied (session id is
/// persisted for the new chat session). Returns `false` if there was no
/// session to resume — in that case the new workspace simply starts a
/// fresh Claude session on its first turn, which is the intended graceful
/// degradation rather than an error.
fn copy_claude_session(
    db: &Database,
    source_chat_session_id: &str,
    new_chat_session_id: &str,
    source_worktree: &str,
    new_worktree: &str,
    projects_dir: &Path,
) -> Result<bool, ForkError> {
    let Some(source_session) = db.get_chat_session(source_chat_session_id)? else {
        return Ok(false);
    };
    let Some(session_id) = source_session.session_id else {
        return Ok(false);
    };
    let turn_count = source_session.turn_count;

    let src_file = projects_dir
        .join(claude_project_slug(source_worktree))
        .join(format!("{session_id}.jsonl"));
    if !src_file.exists() {
        return Ok(false);
    }
    let dest_dir = projects_dir.join(claude_project_slug(new_worktree));
    std::fs::create_dir_all(&dest_dir)?;
    let dest_file = dest_dir.join(format!("{session_id}.jsonl"));
    std::fs::copy(&src_file, &dest_file)?;

    db.save_chat_session_state(new_chat_session_id, &session_id, turn_count)?;
    Ok(true)
}

/// Resolve `~/.claude/projects` for the current user. Split out so tests can
/// substitute a temp directory by calling [`copy_claude_session`] with an
/// arbitrary projects dir.
fn claude_projects_dir() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".claude").join("projects"))
}

/// Convert an absolute filesystem path to Claude CLI's project slug
/// convention (used as the directory name under `~/.claude/projects/`).
///
/// Claude CLI replaces both path separators (`/`, `\`) AND `.` with `-`
/// when building the slug, so a worktree under `~/.claudette/...`
/// produces a directory like `-Users-...--claudette-...` (note the double
/// dash from `/.`). Missing the `.` — as this function did originally —
/// silently routes the JSONL copy at a non-existent directory and turns
/// every fork into a fresh Claude session.
fn claude_project_slug(path: &str) -> String {
    path.replace(['/', '\\', '.'], "-")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ChatRole, Repository};

    fn make_repo(id: &str) -> Repository {
        Repository {
            id: id.into(),
            name: "repo1".into(),
            path: "/tmp/repo1".into(),
            path_slug: "repo1".into(),
            icon: None,
            setup_script: None,
            custom_instructions: None,
            sort_order: 0,
            branch_rename_preferences: None,
            setup_script_auto_run: false,
            archive_script: None,
            archive_script_auto_run: false,
            base_branch: None,
            default_remote: None,
            path_valid: true,
            created_at: String::new(),
        }
    }

    fn make_workspace(id: &str, repo: &str, name: &str) -> Workspace {
        Workspace {
            id: id.into(),
            repository_id: repo.into(),
            name: name.into(),
            branch_name: format!("u/{name}"),
            worktree_path: Some(format!("/tmp/wt/{name}")),
            status: WorkspaceStatus::Active,
            agent_status: AgentStatus::Idle,
            status_line: String::new(),
            created_at: String::new(),
            sort_order: 0,
        }
    }

    fn make_chat_msg(
        db: &Database,
        id: &str,
        ws: &str,
        role: ChatRole,
        content: &str,
    ) -> ChatMessage {
        let chat_session_id = db
            .default_session_id_for_workspace(ws)
            .unwrap()
            .expect("workspace must have a default session for tests");
        ChatMessage {
            id: id.into(),
            workspace_id: ws.into(),
            chat_session_id,
            role,
            content: content.into(),
            cost_usd: None,
            duration_ms: None,
            created_at: String::new(),
            thinking: None,
            input_tokens: None,
            output_tokens: None,
            cache_read_tokens: None,
            cache_creation_tokens: None,
        }
    }

    fn make_checkpoint(
        db: &Database,
        id: &str,
        ws: &str,
        msg: &str,
        turn: i32,
        commit: Option<&str>,
    ) -> ConversationCheckpoint {
        let chat_session_id = db
            .default_session_id_for_workspace(ws)
            .unwrap()
            .expect("workspace must have a default session for tests");
        ConversationCheckpoint {
            id: id.into(),
            workspace_id: ws.into(),
            chat_session_id,
            message_id: msg.into(),
            commit_hash: commit.map(String::from),
            has_file_state: false,
            turn_index: turn,
            message_count: 0,
            created_at: String::new(),
        }
    }

    fn setup_db_with_history() -> Database {
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1")).unwrap();
        db.insert_workspace(&make_workspace("w1", "r1", "source"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m1", "w1", ChatRole::User, "hi"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(
            &db,
            "m2",
            "w1",
            ChatRole::Assistant,
            "hello",
        ))
        .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m3", "w1", ChatRole::User, "more"))
            .unwrap();
        db.insert_chat_message(&make_chat_msg(&db, "m4", "w1", ChatRole::Assistant, "ok"))
            .unwrap();
        db.insert_checkpoint(&make_checkpoint(&db, "cp1", "w1", "m2", 0, Some("abc")))
            .unwrap();
        db.insert_checkpoint(&make_checkpoint(&db, "cp2", "w1", "m4", 1, Some("def")))
            .unwrap();
        db.insert_turn_tool_activities(&[TurnToolActivity {
            id: "a1".into(),
            checkpoint_id: "cp1".into(),
            tool_use_id: "tu1".into(),
            tool_name: "Read".into(),
            input_json: "{}".into(),
            result_text: "ok".into(),
            summary: "read file".into(),
            sort_order: 0,
            assistant_message_ordinal: 0,
            agent_task_id: None,
            agent_description: None,
            agent_last_tool_name: None,
            agent_tool_use_count: None,
            agent_status: None,
            agent_tool_calls_json: "[]".into(),
        }])
        .unwrap();
        db.insert_turn_tool_activities(&[TurnToolActivity {
            id: "a2".into(),
            checkpoint_id: "cp2".into(),
            tool_use_id: "tu2".into(),
            tool_name: "Edit".into(),
            input_json: "{}".into(),
            result_text: "ok".into(),
            summary: "edit file".into(),
            sort_order: 0,
            assistant_message_ordinal: 0,
            agent_task_id: None,
            agent_description: None,
            agent_last_tool_name: None,
            agent_tool_use_count: None,
            agent_status: None,
            agent_tool_calls_json: "[]".into(),
        }])
        .unwrap();
        db
    }

    #[test]
    fn copy_history_copies_up_to_checkpoint_and_remaps_ids() {
        let db = setup_db_with_history();
        db.insert_workspace(&make_workspace("w-fork", "r1", "source-fork"))
            .unwrap();

        let cp1 = db.get_checkpoint("cp1").unwrap().unwrap();
        copy_history(&db, "w1", "w-fork", &cp1).unwrap();

        let forked_msgs = db.list_chat_messages("w-fork").unwrap();
        assert_eq!(forked_msgs.len(), 2);
        // New IDs, but same content.
        assert_ne!(forked_msgs[0].id, "m1");
        assert_ne!(forked_msgs[1].id, "m2");
        assert_eq!(forked_msgs[0].content, "hi");
        assert_eq!(forked_msgs[1].content, "hello");

        let forked_cps = db.list_checkpoints("w-fork").unwrap();
        assert_eq!(forked_cps.len(), 1);
        assert_ne!(forked_cps[0].id, "cp1");
        assert_eq!(forked_cps[0].turn_index, 0);
        // message_id should be remapped to the new assistant message id.
        assert_eq!(forked_cps[0].message_id, forked_msgs[1].id);
        // Commit hash carries over so the fork stays anchored.
        assert_eq!(forked_cps[0].commit_hash.as_deref(), Some("abc"));

        let forked_turns = db.list_completed_turns("w-fork").unwrap();
        assert_eq!(forked_turns.len(), 1);
        assert_eq!(forked_turns[0].activities.len(), 1);
        assert_eq!(forked_turns[0].activities[0].tool_name, "Read");
    }

    #[test]
    fn copy_history_with_second_checkpoint_includes_both() {
        let db = setup_db_with_history();
        db.insert_workspace(&make_workspace("w-fork", "r1", "source-fork"))
            .unwrap();

        let cp2 = db.get_checkpoint("cp2").unwrap().unwrap();
        copy_history(&db, "w1", "w-fork", &cp2).unwrap();

        let forked_msgs = db.list_chat_messages("w-fork").unwrap();
        assert_eq!(forked_msgs.len(), 4);

        let forked_cps = db.list_checkpoints("w-fork").unwrap();
        assert_eq!(forked_cps.len(), 2);
        assert_eq!(forked_cps[0].turn_index, 0);
        assert_eq!(forked_cps[1].turn_index, 1);
    }

    #[test]
    fn allocate_name_suffixes_on_collision() {
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1")).unwrap();
        db.insert_workspace(&make_workspace("w1", "r1", "source"))
            .unwrap();
        db.insert_workspace(&make_workspace("w2", "r1", "source-fork"))
            .unwrap();

        let (name, branch) = allocate_name_and_branch(&db, "r1", "source", "pfx/").unwrap();
        assert_eq!(name, "source-fork-2");
        assert_eq!(branch, "pfx/source-fork-2");
    }

    #[test]
    fn allocate_name_no_collision() {
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1")).unwrap();
        db.insert_workspace(&make_workspace("w1", "r1", "source"))
            .unwrap();

        let (name, branch) = allocate_name_and_branch(&db, "r1", "source", "").unwrap();
        assert_eq!(name, "source-fork");
        assert_eq!(branch, "source-fork");
    }

    #[test]
    fn claude_project_slug_replaces_separators() {
        assert_eq!(
            claude_project_slug("/Users/alice/projects/foo"),
            "-Users-alice-projects-foo"
        );
    }

    #[test]
    fn claude_project_slug_replaces_dots() {
        // Regression pin for the second-order bug discovered during
        // post-fix UAT: Claude CLI's slug replaces `.` with `-` too,
        // which Claudette worktrees (under `~/.claudette/...`) hit
        // unconditionally because of the leading dot in `.claudette`.
        // Previously slugged to `-Users-alice-.claudette-...` which
        // did not match the on-disk dir Claude CLI actually created.
        assert_eq!(
            claude_project_slug("/Users/alice/.claudette/workspaces/repo/ws"),
            "-Users-alice--claudette-workspaces-repo-ws"
        );
        // Multiple dots collapse independently — `.local/.config/file`
        // becomes `-local--config-file`. Mirrors Claude CLI behaviour
        // observed on real `~/.claude/projects/` directory listings.
        assert_eq!(
            claude_project_slug("/.local/.config/file"),
            "--local--config-file"
        );
    }

    // --- copy_claude_session regression pins ---
    //
    // These cover the multi-session migration regression: prior to the fix,
    // `copy_claude_session` read `workspaces.session_id` (a column that became
    // permanently NULL when the multi-session refactor moved live state to
    // `chat_sessions`). Every fork therefore returned `session_resumed: false`
    // and the new workspace started a fresh Claude CLI session — losing the
    // parent's conversational context. The bug looked like "the fork button
    // is broken" because the user's next prompt to the fork came back with
    // "I don't have context from a previous session".

    /// Build a fake `~/.claude/projects/<slug>/<sid>.jsonl` so
    /// `copy_claude_session` has something to copy. Returns the temp `home`
    /// dir so the caller can keep it alive (TempDir cleans on drop).
    fn write_fake_jsonl(
        projects_dir: &Path,
        worktree: &str,
        session_id: &str,
        body: &str,
    ) -> std::path::PathBuf {
        let dir = projects_dir.join(claude_project_slug(worktree));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{session_id}.jsonl"));
        std::fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn copy_claude_session_copies_jsonl_and_persists_per_chat_session_state() {
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1")).unwrap();
        db.insert_workspace(&make_workspace("w-src", "r1", "src"))
            .unwrap();
        db.insert_workspace(&make_workspace("w-fork", "r1", "src-fork"))
            .unwrap();

        // Source's chat session carries the live Claude CLI sid + turn count.
        // Post multi-session refactor THIS is the source of truth — not
        // `workspaces.session_id`, which is gone.
        let src_sid = db
            .default_session_id_for_workspace("w-src")
            .unwrap()
            .unwrap();
        let dst_sid = db
            .default_session_id_for_workspace("w-fork")
            .unwrap()
            .unwrap();
        db.save_chat_session_state(&src_sid, "claude-sid-XYZ", 7)
            .unwrap();

        let projects = tempfile::tempdir().unwrap();
        let src_wt = "/tmp/wt/src";
        let new_wt = "/tmp/wt/src-fork";
        write_fake_jsonl(projects.path(), src_wt, "claude-sid-XYZ", "{\"hi\":1}\n");

        let resumed =
            copy_claude_session(&db, &src_sid, &dst_sid, src_wt, new_wt, projects.path()).unwrap();
        assert!(
            resumed,
            "expected session_resumed=true when source has a sid + jsonl"
        );

        // JSONL physically copied into the new worktree's project dir under
        // the SAME session id (Claude CLI keys files by sid; resume reads it).
        let copied = projects
            .path()
            .join(claude_project_slug(new_wt))
            .join("claude-sid-XYZ.jsonl");
        assert!(
            copied.exists(),
            "fork's jsonl missing at {}",
            copied.display()
        );
        assert_eq!(std::fs::read_to_string(&copied).unwrap(), "{\"hi\":1}\n");

        // The destination chat session inherits the parent's sid + turn count
        // so the next agent run hits `claude --resume` with the right id.
        let dst_session = db.get_chat_session(&dst_sid).unwrap().unwrap();
        assert_eq!(dst_session.session_id.as_deref(), Some("claude-sid-XYZ"));
        assert_eq!(dst_session.turn_count, 7);
    }

    #[test]
    fn copy_claude_session_skips_when_source_has_no_session() {
        // Graceful-degradation pin: a fork from a workspace that hasn't yet
        // started a Claude session must still succeed — it just starts fresh.
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1")).unwrap();
        db.insert_workspace(&make_workspace("w-src", "r1", "src"))
            .unwrap();
        db.insert_workspace(&make_workspace("w-fork", "r1", "src-fork"))
            .unwrap();
        let src_sid = db
            .default_session_id_for_workspace("w-src")
            .unwrap()
            .unwrap();
        let dst_sid = db
            .default_session_id_for_workspace("w-fork")
            .unwrap()
            .unwrap();
        // No save_chat_session_state — source is fresh.

        let projects = tempfile::tempdir().unwrap();
        let resumed = copy_claude_session(
            &db,
            &src_sid,
            &dst_sid,
            "/tmp/wt/src",
            "/tmp/wt/src-fork",
            projects.path(),
        )
        .unwrap();
        assert!(!resumed);
        let dst_session = db.get_chat_session(&dst_sid).unwrap().unwrap();
        assert!(dst_session.session_id.is_none());
        assert_eq!(dst_session.turn_count, 0);
    }

    #[test]
    fn copy_claude_session_handles_dot_dir_paths() {
        // Regression pin: Claudette stores every worktree under
        // `~/.claudette/...`. Pre-fix, the slug function only replaced
        // path separators — so the `.` in `.claudette` survived and the
        // computed source/dest paths missed the on-disk directory Claude
        // CLI actually wrote, returning `Ok(false)` even when the
        // transcript existed. End-to-end UAT caught this; that's exactly
        // the path this test exercises.
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1")).unwrap();
        db.insert_workspace(&make_workspace("w-src", "r1", "src"))
            .unwrap();
        db.insert_workspace(&make_workspace("w-fork", "r1", "src-fork"))
            .unwrap();
        let src_sid = db
            .default_session_id_for_workspace("w-src")
            .unwrap()
            .unwrap();
        let dst_sid = db
            .default_session_id_for_workspace("w-fork")
            .unwrap()
            .unwrap();
        db.save_chat_session_state(&src_sid, "claude-sid-DOTS", 4)
            .unwrap();

        let projects = tempfile::tempdir().unwrap();
        let src_wt = "/Users/alice/.claudette/workspaces/repo/src";
        let new_wt = "/Users/alice/.claudette/workspaces/repo/src-fork";
        write_fake_jsonl(projects.path(), src_wt, "claude-sid-DOTS", "X");

        let resumed =
            copy_claude_session(&db, &src_sid, &dst_sid, src_wt, new_wt, projects.path()).unwrap();
        assert!(
            resumed,
            "fork must resume sessions for .claudette-style paths — slug must replace '.'"
        );
        let copied = projects
            .path()
            .join(claude_project_slug(new_wt))
            .join("claude-sid-DOTS.jsonl");
        assert!(copied.exists());
        // The slug must have collapsed `/.claudette` → `--claudette`,
        // matching Claude CLI's on-disk layout.
        assert!(
            copied
                .to_string_lossy()
                .contains("-Users-alice--claudette-workspaces-repo-src-fork"),
            "slug missing `--claudette` collapse: {}",
            copied.display()
        );
    }

    #[test]
    fn copy_claude_session_skips_when_jsonl_missing() {
        // Regression pin: the source has a sid persisted in chat_sessions
        // but the on-disk transcript was never written (e.g. the Claude
        // process crashed before flushing). Don't error — start fresh.
        let db = Database::open_in_memory().unwrap();
        db.insert_repository(&make_repo("r1")).unwrap();
        db.insert_workspace(&make_workspace("w-src", "r1", "src"))
            .unwrap();
        db.insert_workspace(&make_workspace("w-fork", "r1", "src-fork"))
            .unwrap();
        let src_sid = db
            .default_session_id_for_workspace("w-src")
            .unwrap()
            .unwrap();
        let dst_sid = db
            .default_session_id_for_workspace("w-fork")
            .unwrap()
            .unwrap();
        db.save_chat_session_state(&src_sid, "claude-sid-orphan", 2)
            .unwrap();

        let projects = tempfile::tempdir().unwrap();
        // Note: no write_fake_jsonl — file is absent.
        let resumed = copy_claude_session(
            &db,
            &src_sid,
            &dst_sid,
            "/tmp/wt/src",
            "/tmp/wt/src-fork",
            projects.path(),
        )
        .unwrap();
        assert!(!resumed);
        // Destination must NOT have inherited the orphan sid — the next
        // turn would otherwise try (and fail) to --resume a phantom session.
        let dst_session = db.get_chat_session(&dst_sid).unwrap().unwrap();
        assert!(dst_session.session_id.is_none());
    }

    #[test]
    fn workspaces_table_no_longer_carries_session_columns() {
        // Schema-level pin: 20260508142050 dropped `session_id` and
        // `turn_count` from `workspaces`. If a future migration accidentally
        // re-adds them (or reverts the drop), this assertion catches it
        // before the dead state can re-grow callers.
        let db = Database::open_in_memory().unwrap();
        let cols: Vec<String> = db
            .conn()
            .prepare("PRAGMA table_info(workspaces)")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(
            !cols.iter().any(|c| c == "session_id"),
            "workspaces.session_id must stay dropped — live state lives on chat_sessions; cols={cols:?}"
        );
        assert!(
            !cols.iter().any(|c| c == "turn_count"),
            "workspaces.turn_count must stay dropped — live state lives on chat_sessions; cols={cols:?}"
        );
    }
}
