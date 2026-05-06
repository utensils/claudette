//! Shared chat turn helpers consumed by both transports.
//!
//! The Tauri command (`src-tauri/src/commands/chat/send.rs`) and the remote
//! WebSocket handler (`src-server/src/handler.rs`) both run a chat turn and
//! persist the resulting messages. They duplicate a lot of logic — pure
//! helpers (session-flag drift, the `can_use_tool` permission response,
//! walking an `AssistantMessage`'s content blocks, `ChatMessage` builders)
//! plus an async helper that owns the per-turn checkpoint + worktree
//! snapshot dance.
//!
//! This module collects those helpers so both call sites can share them and
//! stay in lockstep. The remaining transport-specific orchestration (event
//! emission, `AppState` locking, notifications) still lives in each call
//! site — see issue #490 for the broader plan.
//!
//! See `docs/architecture` and the call sites for how these pieces are
//! composed during a turn.

use std::path::Path;

use serde::Serialize;
use serde_json::Value;

use crate::agent::{AgentEvent, AssistantMessage, CompactMetadata, ContentBlock, TokenUsage};
use crate::db::Database;
use crate::model::{ChatMessage, ChatRole, ConversationCheckpoint};
use crate::permissions::is_bypass_tools;
use crate::snapshot;

// ---------------------------------------------------------------------------
// Agent-stream event payload
// ---------------------------------------------------------------------------

/// The wire shape of an `agent-stream` event, fan-out from either bridge to
/// every connected participant (host webview via Tauri events; remote clients
/// via the WebSocket forwarder). Both transports must serialize *this*
/// struct so the JSON shape stays in lockstep with the frontend's
/// `AgentStreamPayload` TypeScript interface — drifting field names here
/// silently drops events on receivers (see commit `1e1db36` for the
/// `session_id`-vs-`chat_session_id` regression that motivated extracting
/// this type into the shared crate).
#[derive(Debug, Clone, Serialize)]
pub struct AgentStreamPayload {
    pub workspace_id: String,
    pub chat_session_id: String,
    pub event: AgentEvent,
}

// ---------------------------------------------------------------------------
// Session-flag drift detection
// ---------------------------------------------------------------------------

/// Spawn-time flags of the currently running persistent session, plus the
/// backend-observed `exited_plan` latch (set when the agent emits
/// `ExitPlanMode` during this session).
pub struct SessionFlags<'a> {
    pub plan_mode: bool,
    pub allowed_tools: &'a [String],
    pub exited_plan: bool,
    pub disable_1m_context: bool,
    pub backend_hash: &'a str,
}

/// Flags the next turn is asking for. Compared against [`SessionFlags`] to
/// decide whether the process must be torn down and respawned.
pub struct RequestedFlags<'a> {
    pub plan_mode: bool,
    pub allowed_tools: &'a [String],
    pub disable_1m_context: bool,
    pub backend_hash: &'a str,
}

/// Detect whether the persistent session's spawn-time flags have drifted
/// from what the current turn is asking for. Both `--permission-mode` and
/// `--allowedTools` are only applied when the `claude` process starts, so
/// a drift means the running process cannot serve this turn correctly and
/// must be torn down.
///
/// `exited_plan` is a backend-observed signal that the agent called
/// `ExitPlanMode` during the current session. When set alongside
/// `plan_mode`, the plan phase is over regardless of whether the frontend
/// remembered to send `plan_mode=false` — force a teardown so the CLI
/// respawns without `--permission-mode plan`.
pub fn persistent_session_flags_drifted(
    session: SessionFlags<'_>,
    requested: RequestedFlags<'_>,
) -> bool {
    session.plan_mode != requested.plan_mode
        || session.allowed_tools != requested.allowed_tools
        || session.disable_1m_context != requested.disable_1m_context
        || session.backend_hash != requested.backend_hash
        || (session.plan_mode && session.exited_plan)
}

// ---------------------------------------------------------------------------
// Permission response builder
// ---------------------------------------------------------------------------

/// Decide how to respond to a `can_use_tool` control_request that reached the
/// handler for a tool other than AskUserQuestion / ExitPlanMode.
///
/// Bypass mode + plan not active → allow (echo `updatedInput` — required by
/// the CLI's `PermissionPromptToolResultSchema`). This is the fix for "full"
/// sessions seeing spurious denials: the CLI still routes certain tools
/// (MCP servers, Skills, some built-in edge paths) through
/// `--permission-prompt-tool stdio` even under `--permission-mode
/// bypassPermissions`, so we must answer allow rather than fall through.
///
/// Plan mode is considered **inactive** once the agent has emitted
/// `ExitPlanMode` (`session_exited_plan = true`) — even though the
/// subprocess still runs with `--permission-mode plan` until the drift
/// detector respawns it on the next turn. Without this, a bypass session
/// that just had its plan approved would still deny every mutating tool
/// for the remainder of the current turn.
///
/// Otherwise (standard/readonly, or plan-mode genuinely active) → deny with
/// a message that names the escalation path; the model paraphrases this
/// string to the user.
///
/// Auto-allow in bypass mode does not bypass an MCP server's own
/// authorization — servers refuse at their layer via a normal tool_result,
/// not a control_request.
pub fn build_permission_response(
    session_allowed_tools: &[String],
    session_plan_mode: bool,
    session_exited_plan: bool,
    tool_name: &str,
    original_input: &Value,
) -> Value {
    let bypass = is_bypass_tools(session_allowed_tools);
    let plan_active = session_plan_mode && !session_exited_plan;
    if bypass && !plan_active {
        serde_json::json!({
            "behavior": "allow",
            "updatedInput": original_input,
        })
    } else {
        let msg = format!(
            "{tool_name} isn't enabled at the current permission level. Switch to 'full' in the chat toolbar (or run /permissions full) to allow it."
        );
        serde_json::json!({
            "behavior": "deny",
            "message": msg,
        })
    }
}

// ---------------------------------------------------------------------------
// Assistant message extraction
// ---------------------------------------------------------------------------

/// Concatenate every `text` content block in an assistant message.
///
/// The CLI may fire multiple assistant events per turn — one with thinking
/// blocks only, then one with text — and a single event may carry multiple
/// text blocks. Callers use the joined string as the `content` field of the
/// persisted [`ChatMessage`] and only persist when it's non-empty.
pub fn extract_assistant_text(message: &AssistantMessage) -> String {
    message
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("")
}

/// Concatenate every `thinking` content block in an assistant message.
/// Returns `None` when the message carries no thinking blocks at all.
///
/// Callers accumulate this across thinking-only events and attach it to the
/// next text-bearing assistant message that arrives in the same turn.
pub fn extract_event_thinking(message: &AssistantMessage) -> Option<String> {
    let parts: Vec<&str> = message
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Thinking { thinking } => Some(thinking.as_str()),
            _ => None,
        })
        .collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(""))
    }
}

// ---------------------------------------------------------------------------
// ChatMessage constructors
// ---------------------------------------------------------------------------

/// Inputs for [`build_assistant_chat_message`]. Bundled into a struct to keep
/// the call-site readable and to leave room for future fields without a
/// signature break.
pub struct BuildAssistantArgs<'a> {
    pub workspace_id: &'a str,
    pub chat_session_id: &'a str,
    /// Joined text from [`extract_assistant_text`].
    pub content: String,
    /// Accumulated thinking from prior events in this turn (taken from the
    /// caller's running buffer).
    pub thinking: Option<String>,
    /// Per-message usage as last seen on a `MessageDelta` event. `None`
    /// produces NULL token fields — used for historical rows and for any
    /// transport that hasn't wired token tracking yet.
    pub usage: Option<TokenUsage>,
    pub created_at: String,
}

/// Build the `ChatMessage` row to persist for an assistant turn message.
/// Maps `TokenUsage` into the four per-message token fields when present.
pub fn build_assistant_chat_message(args: BuildAssistantArgs<'_>) -> ChatMessage {
    let BuildAssistantArgs {
        workspace_id,
        chat_session_id,
        content,
        thinking,
        usage,
        created_at,
    } = args;
    ChatMessage {
        id: uuid::Uuid::new_v4().to_string(),
        workspace_id: workspace_id.to_string(),
        chat_session_id: chat_session_id.to_string(),
        role: ChatRole::Assistant,
        content,
        cost_usd: None,
        duration_ms: None,
        created_at,
        thinking,
        input_tokens: usage.as_ref().map(|u| u.input_tokens as i64),
        output_tokens: usage.as_ref().map(|u| u.output_tokens as i64),
        cache_read_tokens: usage
            .as_ref()
            .and_then(|u| u.cache_read_input_tokens.map(|n| n as i64)),
        cache_creation_tokens: usage
            .as_ref()
            .and_then(|u| u.cache_creation_input_tokens.map(|n| n as i64)),
        author_participant_id: None,
        author_display_name: None,
    }
}

/// Build the `COMPACTION:trigger:pre:post:duration` system sentinel row.
///
/// Persisted on `subtype: "compact_boundary"` events so the timeline renders
/// a divider on live + reload. `cache_read_tokens` is set to `post_tokens`
/// so the frontend's `extractLatestCallUsage` picks up the new meter
/// baseline on workspace reload.
pub fn build_compaction_sentinel(
    workspace_id: &str,
    chat_session_id: &str,
    meta: &CompactMetadata,
    created_at: String,
) -> ChatMessage {
    let sentinel = format!(
        "COMPACTION:{}:{}:{}:{}",
        meta.trigger, meta.pre_tokens, meta.post_tokens, meta.duration_ms
    );
    ChatMessage {
        id: uuid::Uuid::new_v4().to_string(),
        workspace_id: workspace_id.to_string(),
        chat_session_id: chat_session_id.to_string(),
        role: ChatRole::System,
        content: sentinel,
        cost_usd: None,
        duration_ms: None,
        created_at,
        thinking: None,
        input_tokens: None,
        output_tokens: None,
        cache_read_tokens: Some(meta.post_tokens as i64),
        cache_creation_tokens: None,
        author_participant_id: None,
        author_display_name: None,
    }
}

// ---------------------------------------------------------------------------
// Turn checkpoint creation
// ---------------------------------------------------------------------------

/// Inputs for [`create_turn_checkpoint`]. `anchor_msg_id` is the assistant
/// message id from this turn, or the user message id for tool-only turns
/// where no assistant text was emitted.
pub struct CheckpointArgs<'a> {
    pub db_path: &'a Path,
    pub workspace_id: &'a str,
    pub chat_session_id: &'a str,
    pub anchor_msg_id: &'a str,
    pub worktree_path: &'a str,
    pub created_at: String,
}

/// Create the conversation checkpoint for a just-completed turn and snapshot
/// the worktree files into SQLite.
///
/// Returns the inserted checkpoint with `has_file_state` set to `true` only
/// when the snapshot inserted at least one `checkpoint_files` row — callers
/// should use it as the payload for any `checkpoint-created` event they emit.
///
/// Returns `None` only when the DB connection or the checkpoint insert itself
/// fails. Snapshot failures are logged to stderr (mirroring the prior Tauri
/// behavior) but do not prevent the checkpoint row from existing — restoring
/// to that turn just won't be possible.
///
/// Note: `has_file_state` is **derived** by SQL on read (EXISTS over
/// `checkpoint_files`), so we don't persist the bool — we only set it on the
/// returned struct to keep the emitted payload consistent with subsequent DB
/// reads. Zero-file snapshots (empty repo, all files gitignored) return
/// `has_file_state = false` for the same reason.
pub async fn create_turn_checkpoint(args: CheckpointArgs<'_>) -> Option<ConversationCheckpoint> {
    let CheckpointArgs {
        db_path,
        workspace_id,
        chat_session_id,
        anchor_msg_id,
        worktree_path,
        created_at,
    } = args;

    let db = Database::open(db_path).ok()?;

    let turn_index = db
        .latest_checkpoint(workspace_id)
        .ok()
        .flatten()
        .map(|cp| cp.turn_index + 1)
        .unwrap_or(0);

    let mut checkpoint = ConversationCheckpoint {
        id: uuid::Uuid::new_v4().to_string(),
        workspace_id: workspace_id.to_string(),
        chat_session_id: chat_session_id.to_string(),
        message_id: anchor_msg_id.to_string(),
        commit_hash: None,
        has_file_state: false,
        turn_index,
        message_count: 0,
        created_at,
    };

    db.insert_checkpoint(&checkpoint).ok()?;
    drop(db); // release the non-Send connection before awaiting save_snapshot

    // Match the DB-derived `has_file_state` (EXISTS over `checkpoint_files`):
    // a successful snapshot that inserted zero rows still means no restore
    // capability — happens for empty / fully-ignored worktrees.
    let has_files = match snapshot::save_snapshot(db_path, &checkpoint.id, worktree_path).await {
        Ok(count) => count > 0,
        Err(e) => {
            tracing::warn!(
                target: "claudette::chat",
                workspace_id = %workspace_id,
                error = %e,
                "snapshot failed — checkpoint recorded without file restore capability"
            );
            false
        }
    };

    checkpoint.has_file_state = has_files;
    Some(checkpoint)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    use std::path::PathBuf;
    use tempfile::tempdir;

    fn s(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| (*v).to_string()).collect()
    }

    async fn make_test_db() -> (tempfile::TempDir, PathBuf) {
        let dir = tempdir().expect("tempdir");
        let db_path = dir.path().join("test.db");
        let db = crate::db::Database::open(&db_path).expect("open db");
        // Seed the FK-required rows so insert_checkpoint doesn't reject ws-1 / cs-1.
        db.execute_batch(
            "INSERT INTO repositories (id, name, path) VALUES ('r-1', 'testrepo', '/tmp/r1'); \
             INSERT INTO workspaces (id, repository_id, name, branch_name, status, status_line) \
               VALUES ('ws-1', 'r-1', 'test', 'main', 'active', ''); \
             INSERT INTO chat_sessions (id, workspace_id, name, sort_order, status) \
               VALUES ('cs-1', 'ws-1', 'Main', 0, 'active');",
        )
        .expect("seed rows");
        drop(db);
        (dir, db_path)
    }

    async fn make_test_worktree(parent: &std::path::Path) -> PathBuf {
        let wt = parent.join("wt");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(wt.join("hello.txt"), "hi").unwrap();
        init_git_repo(&wt).await;
        wt
    }

    async fn make_empty_test_worktree(parent: &std::path::Path) -> PathBuf {
        let wt = parent.join("empty_wt");
        std::fs::create_dir_all(&wt).unwrap();
        init_git_repo(&wt).await;
        wt
    }

    async fn init_git_repo(wt: &std::path::Path) {
        let output = tokio::process::Command::new(crate::git::resolve_git_path_blocking())
            .args(["init", wt.to_str().unwrap()])
            .output()
            .await
            .expect("spawn git init");
        assert!(
            output.status.success(),
            "git init failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    // -- Session-flag drift -------------------------------------------------

    fn session<'a>(
        plan_mode: bool,
        allowed_tools: &'a [String],
        exited_plan: bool,
    ) -> SessionFlags<'a> {
        SessionFlags {
            plan_mode,
            allowed_tools,
            exited_plan,
            disable_1m_context: false,
            backend_hash: "",
        }
    }

    fn requested<'a>(plan_mode: bool, allowed_tools: &'a [String]) -> RequestedFlags<'a> {
        RequestedFlags {
            plan_mode,
            allowed_tools,
            disable_1m_context: false,
            backend_hash: "",
        }
    }

    #[test]
    fn no_drift_when_plan_mode_and_tools_match() {
        let tools = s(&["Read", "Write"]);
        assert!(!persistent_session_flags_drifted(
            session(false, &tools, false),
            requested(false, &tools),
        ));
    }

    #[test]
    fn drift_when_plan_mode_flips_off_after_approval() {
        let tools = s(&["Read", "Write"]);
        assert!(persistent_session_flags_drifted(
            session(true, &tools, false),
            requested(false, &tools),
        ));
    }

    #[test]
    fn drift_when_plan_mode_flips_on() {
        let tools = s(&["Read"]);
        assert!(persistent_session_flags_drifted(
            session(false, &tools, false),
            requested(true, &tools),
        ));
    }

    #[test]
    fn drift_when_permission_level_changes() {
        let before = s(&["Read", "Glob"]);
        let after = s(&["Read", "Write", "Edit"]);
        assert!(persistent_session_flags_drifted(
            session(false, &before, false),
            requested(false, &after),
        ));
    }

    #[test]
    fn drift_when_allowed_tools_reordered() {
        // Strict equality: a different order counts as drift. Callers build
        // the list deterministically from the permission level, so any
        // observed diff signals a real configuration change.
        let before = s(&["Read", "Write"]);
        let after = s(&["Write", "Read"]);
        assert!(persistent_session_flags_drifted(
            session(false, &before, false),
            requested(false, &after),
        ));
    }

    #[test]
    fn no_drift_when_wildcard_unchanged() {
        let full = s(&["*"]);
        assert!(!persistent_session_flags_drifted(
            session(false, &full, false),
            requested(false, &full),
        ));
    }

    #[test]
    fn drift_when_escalating_to_wildcard() {
        let standard = s(&["Read", "Write", "Edit"]);
        let full = s(&["*"]);
        assert!(persistent_session_flags_drifted(
            session(false, &standard, false),
            requested(false, &full),
        ));
    }

    #[test]
    fn drift_when_demoting_from_wildcard() {
        let full = s(&["*"]);
        let readonly = s(&["Read", "Glob", "Grep"]);
        assert!(persistent_session_flags_drifted(
            session(false, &full, false),
            requested(false, &readonly),
        ));
    }

    #[test]
    fn drift_when_session_exited_plan_even_if_request_still_says_plan() {
        let tools = s(&["Read", "Write"]);
        assert!(persistent_session_flags_drifted(
            session(true, &tools, true),
            requested(true, &tools),
        ));
    }

    #[test]
    fn no_drift_when_exited_plan_but_session_never_had_plan() {
        let tools = s(&["Read"]);
        assert!(!persistent_session_flags_drifted(
            session(false, &tools, true),
            requested(false, &tools),
        ));
    }

    #[test]
    fn drift_when_disable_1m_context_flips() {
        let tools = s(&["Read", "Write"]);
        assert!(persistent_session_flags_drifted(
            SessionFlags {
                plan_mode: false,
                allowed_tools: &tools,
                exited_plan: false,
                disable_1m_context: false,
                backend_hash: "",
            },
            RequestedFlags {
                plan_mode: false,
                allowed_tools: &tools,
                disable_1m_context: true,
                backend_hash: "",
            },
        ));
        assert!(persistent_session_flags_drifted(
            SessionFlags {
                plan_mode: false,
                allowed_tools: &tools,
                exited_plan: false,
                disable_1m_context: true,
                backend_hash: "",
            },
            RequestedFlags {
                plan_mode: false,
                allowed_tools: &tools,
                disable_1m_context: false,
                backend_hash: "",
            },
        ));
    }

    #[test]
    fn no_drift_when_disable_1m_context_matches() {
        let tools = s(&["Read"]);
        assert!(!persistent_session_flags_drifted(
            SessionFlags {
                plan_mode: false,
                allowed_tools: &tools,
                exited_plan: false,
                disable_1m_context: true,
                backend_hash: "",
            },
            RequestedFlags {
                plan_mode: false,
                allowed_tools: &tools,
                disable_1m_context: true,
                backend_hash: "",
            },
        ));
    }

    #[test]
    fn drift_when_backend_hash_changes() {
        let tools = s(&["Read"]);
        assert!(persistent_session_flags_drifted(
            SessionFlags {
                plan_mode: false,
                allowed_tools: &tools,
                exited_plan: false,
                disable_1m_context: false,
                backend_hash: "anthropic",
            },
            RequestedFlags {
                plan_mode: false,
                allowed_tools: &tools,
                disable_1m_context: false,
                backend_hash: "ollama",
            },
        ));
    }

    // -- Permission response ------------------------------------------------

    #[test]
    fn permission_response_allows_bypass_session_non_plan() {
        let input = json!({ "path": "/tmp/foo" });
        let response = build_permission_response(&s(&["*"]), false, false, "Skill", &input);
        assert_eq!(response["behavior"], "allow");
        assert_eq!(response["updatedInput"], input);
    }

    #[test]
    fn permission_response_denies_bypass_session_during_active_plan() {
        let input = json!({});
        let response = build_permission_response(&s(&["*"]), true, false, "Edit", &input);
        assert_eq!(response["behavior"], "deny");
    }

    #[test]
    fn permission_response_allows_bypass_session_after_plan_exit() {
        let input = json!({ "file_path": "/tmp/fib.py", "content": "..." });
        let response = build_permission_response(&s(&["*"]), true, true, "Write", &input);
        assert_eq!(response["behavior"], "allow");
        assert_eq!(response["updatedInput"], input);
    }

    #[test]
    fn permission_response_denies_standard_session() {
        let input = json!({});
        let response =
            build_permission_response(&s(&["Read", "Write"]), false, false, "Edit", &input);
        assert_eq!(response["behavior"], "deny");
        let msg = response["message"].as_str().expect("message");
        assert!(
            msg.contains("full"),
            "message should name the escalation: {msg}"
        );
        assert!(
            msg.contains("/permissions"),
            "message should point at the slash command: {msg}"
        );
    }

    #[test]
    fn permission_response_denies_standard_session_after_plan_exit() {
        let input = json!({});
        let response =
            build_permission_response(&s(&["Read", "Write"]), true, true, "Bash", &input);
        assert_eq!(response["behavior"], "deny");
    }

    #[test]
    fn permission_response_denies_empty_session() {
        let input = json!({});
        let response = build_permission_response(&[], false, false, "Edit", &input);
        assert_eq!(response["behavior"], "deny");
    }

    #[test]
    fn permission_response_rejects_multi_element_wildcard() {
        let input = json!({});
        let response = build_permission_response(&s(&["*", "Read"]), false, false, "Edit", &input);
        assert_eq!(response["behavior"], "deny");
    }

    // -- Assistant content extraction --------------------------------------

    fn msg(blocks: Vec<ContentBlock>) -> AssistantMessage {
        AssistantMessage { content: blocks }
    }

    #[test]
    fn extract_text_joins_multiple_text_blocks() {
        let m = msg(vec![
            ContentBlock::Text {
                text: "Hello, ".into(),
            },
            ContentBlock::Text {
                text: "world!".into(),
            },
        ]);
        assert_eq!(extract_assistant_text(&m), "Hello, world!");
    }

    #[test]
    fn extract_text_skips_thinking_and_tool_use() {
        let m = msg(vec![
            ContentBlock::Thinking {
                thinking: "ignored".into(),
            },
            ContentBlock::Text {
                text: "kept".into(),
            },
            ContentBlock::ToolUse {
                id: "1".into(),
                name: "Read".into(),
            },
        ]);
        assert_eq!(extract_assistant_text(&m), "kept");
    }

    #[test]
    fn extract_text_returns_empty_for_thinking_only_message() {
        let m = msg(vec![ContentBlock::Thinking {
            thinking: "thinking".into(),
        }]);
        assert_eq!(extract_assistant_text(&m), "");
    }

    #[test]
    fn extract_thinking_returns_none_when_no_thinking_blocks() {
        let m = msg(vec![ContentBlock::Text {
            text: "answer".into(),
        }]);
        assert!(extract_event_thinking(&m).is_none());
    }

    #[test]
    fn extract_thinking_joins_multiple_thinking_blocks() {
        let m = msg(vec![
            ContentBlock::Thinking {
                thinking: "step1 ".into(),
            },
            ContentBlock::Thinking {
                thinking: "step2".into(),
            },
        ]);
        assert_eq!(extract_event_thinking(&m).as_deref(), Some("step1 step2"));
    }

    // -- ChatMessage builders ----------------------------------------------

    fn args(content: &str, usage: Option<TokenUsage>) -> BuildAssistantArgs<'static> {
        BuildAssistantArgs {
            workspace_id: "ws-1",
            chat_session_id: "cs-1",
            content: content.into(),
            thinking: None,
            usage,
            created_at: "1234".into(),
        }
    }

    #[test]
    fn build_assistant_message_populates_token_fields_when_usage_present() {
        let usage = TokenUsage {
            input_tokens: 10,
            output_tokens: 20,
            cache_creation_input_tokens: Some(30),
            cache_read_input_tokens: Some(40),
            iterations: None,
        };
        let m = build_assistant_chat_message(args("hello", Some(usage)));
        assert_eq!(m.input_tokens, Some(10));
        assert_eq!(m.output_tokens, Some(20));
        assert_eq!(m.cache_creation_tokens, Some(30));
        assert_eq!(m.cache_read_tokens, Some(40));
        assert_eq!(m.role, ChatRole::Assistant);
        assert_eq!(m.content, "hello");
        assert_eq!(m.created_at, "1234");
    }

    #[test]
    fn build_assistant_message_leaves_token_fields_null_when_usage_absent() {
        let m = build_assistant_chat_message(args("hello", None));
        assert!(m.input_tokens.is_none());
        assert!(m.output_tokens.is_none());
        assert!(m.cache_read_tokens.is_none());
        assert!(m.cache_creation_tokens.is_none());
    }

    #[test]
    fn build_assistant_message_passes_through_thinking() {
        let mut a = args("hello", None);
        a.thinking = Some("planning…".into());
        let m = build_assistant_chat_message(a);
        assert_eq!(m.thinking.as_deref(), Some("planning…"));
    }

    #[test]
    fn build_assistant_message_handles_partial_cache_fields() {
        // Older CLI / fallback responses may omit one of the cache_* fields.
        let usage = TokenUsage {
            input_tokens: 5,
            output_tokens: 7,
            cache_creation_input_tokens: None,
            cache_read_input_tokens: Some(99),
            iterations: None,
        };
        let m = build_assistant_chat_message(args("x", Some(usage)));
        assert_eq!(m.input_tokens, Some(5));
        assert_eq!(m.output_tokens, Some(7));
        assert_eq!(m.cache_creation_tokens, None);
        assert_eq!(m.cache_read_tokens, Some(99));
    }

    #[test]
    fn compaction_sentinel_encodes_metadata_and_baseline_meter() {
        let meta = CompactMetadata {
            trigger: "auto".into(),
            pre_tokens: 100_000,
            post_tokens: 25_000,
            duration_ms: 1234,
        };
        let m = build_compaction_sentinel("ws", "cs", &meta, "now".into());
        assert_eq!(m.role, ChatRole::System);
        assert_eq!(m.content, "COMPACTION:auto:100000:25000:1234");
        assert_eq!(m.cache_read_tokens, Some(25_000));
        assert!(m.cache_creation_tokens.is_none());
        assert!(m.input_tokens.is_none());
        assert!(m.output_tokens.is_none());
    }

    // -- Turn checkpoint creation -----------------

    #[tokio::test]
    async fn checkpoint_turn_index_is_zero_on_empty_workspace() {
        let (dir, db_path) = make_test_db().await;
        let wt = make_test_worktree(dir.path()).await;

        let cp = create_turn_checkpoint(CheckpointArgs {
            db_path: &db_path,
            workspace_id: "ws-1",
            chat_session_id: "cs-1",
            anchor_msg_id: "msg-1",
            worktree_path: wt.to_str().unwrap(),
            created_at: "now".into(),
        })
        .await
        .expect("checkpoint");

        assert_eq!(cp.turn_index, 0);
        assert!(
            cp.has_file_state,
            "snapshot of fixture worktree should succeed"
        );
        assert_eq!(cp.message_id, "msg-1");
        assert_eq!(cp.workspace_id, "ws-1");
        assert_eq!(cp.chat_session_id, "cs-1");

        let db = crate::db::Database::open(&db_path).unwrap();
        let row = db.latest_checkpoint("ws-1").unwrap().expect("row inserted");
        assert_eq!(row.id, cp.id);
        assert!(row.has_file_state, "DB-derived has_file_state agrees");
    }

    #[tokio::test]
    async fn checkpoint_turn_index_increments_from_latest() {
        let (dir, db_path) = make_test_db().await;
        let wt = make_test_worktree(dir.path()).await;

        {
            let db = crate::db::Database::open(&db_path).unwrap();
            let prior = crate::model::ConversationCheckpoint {
                id: "prior".into(),
                workspace_id: "ws-1".into(),
                chat_session_id: "cs-1".into(),
                message_id: "older".into(),
                commit_hash: None,
                has_file_state: false,
                turn_index: 4,
                message_count: 0,
                created_at: "earlier".into(),
            };
            db.insert_checkpoint(&prior).unwrap();
        }

        let cp = create_turn_checkpoint(CheckpointArgs {
            db_path: &db_path,
            workspace_id: "ws-1",
            chat_session_id: "cs-1",
            anchor_msg_id: "msg-2",
            worktree_path: wt.to_str().unwrap(),
            created_at: "now".into(),
        })
        .await
        .expect("checkpoint");

        assert_eq!(cp.turn_index, 5);
    }

    #[tokio::test]
    async fn checkpoint_records_row_with_has_file_state_false_on_snapshot_failure() {
        let (_dir, db_path) = make_test_db().await;
        let bogus = "/definitely/does/not/exist/anywhere";

        let cp = create_turn_checkpoint(CheckpointArgs {
            db_path: &db_path,
            workspace_id: "ws-1",
            chat_session_id: "cs-1",
            anchor_msg_id: "msg-1",
            worktree_path: bogus,
            created_at: "now".into(),
        })
        .await
        .expect("checkpoint inserted even if snapshot fails");

        assert!(!cp.has_file_state);

        let db = crate::db::Database::open(&db_path).unwrap();
        let row = db.latest_checkpoint("ws-1").unwrap().expect("row present");
        assert_eq!(row.id, cp.id);
        assert!(
            !row.has_file_state,
            "no checkpoint_files rows ⇒ derived false"
        );
    }

    #[tokio::test]
    async fn checkpoint_has_file_state_false_when_snapshot_inserts_zero_files() {
        // Empty git-init'd worktree → save_snapshot succeeds with 0 files.
        // The emitted payload's has_file_state must agree with the SQL EXISTS
        // derivation (false), or the frontend will advertise a restorable
        // checkpoint that has nothing to restore.
        let (dir, db_path) = make_test_db().await;
        let wt = make_empty_test_worktree(dir.path()).await;

        let cp = create_turn_checkpoint(CheckpointArgs {
            db_path: &db_path,
            workspace_id: "ws-1",
            chat_session_id: "cs-1",
            anchor_msg_id: "msg-1",
            worktree_path: wt.to_str().unwrap(),
            created_at: "now".into(),
        })
        .await
        .expect("checkpoint");

        assert!(
            !cp.has_file_state,
            "zero-file snapshot must report has_file_state = false"
        );

        let db = crate::db::Database::open(&db_path).unwrap();
        let row = db.latest_checkpoint("ws-1").unwrap().expect("row present");
        assert!(!row.has_file_state, "DB-derived value agrees with payload");
    }
}
