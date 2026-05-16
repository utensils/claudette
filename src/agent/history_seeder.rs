//! Cross-harness conversation seeding.
//!
//! When the user switches a chat session from one agent harness to
//! another (e.g. Anthropic Claude Code -> Codex app-server, or
//! Codex -> Pi SDK), the new harness can't read the prior harness's
//! native transcript:
//!
//! * Claude CLI keeps a JSONL at `~/.claude/projects/<slug>/<sid>.jsonl`.
//!   The shape is undocumented and evolves across CLI releases, so
//!   hand-rolling one is fragile.
//! * The Codex app-server JSON-RPC protocol has no `inputItems` /
//!   `historyItems` field on `thread/start` or `thread/resume`.
//! * The Pi sidecar protocol has no `seedHistory` message; the Pi
//!   SDK's `SessionManager.continueRecent` only loads transcripts
//!   that already exist on disk in its undocumented format.
//!
//! What every harness *does* accept is a user message — a first
//! `prompt` to the Pi sidecar, a first `turn/start` to Codex, a first
//! stdin write to `claude`. So that's the channel we use: render the
//! prior conversation as a single migration prelude and inject it
//! into the next user turn. The model sees the full context in one
//! shot and continues the conversation.
//!
//! Trade-offs:
//! * The new session's "turn 1" carries the entire prior conversation
//!   as input. Token cost is identical to having continued in the
//!   original harness — the model would have re-read the same
//!   transcript anyway.
//! * Tool-use blocks become inert: the prior assistant's tool calls
//!   render as text, not re-runnable tool invocations. That's fine
//!   for "remember what we were doing", not fine for "actually
//!   re-execute that bash command". This is acceptable because the
//!   conversation history is what the user wanted to preserve, not
//!   the in-flight tool state (which we explicitly drain on the
//!   reset path anyway — see `lifecycle.rs::reset_agent_session`).
//! * A future iteration may upgrade the Claude CLI branch to write a
//!   proper JSONL using `src/fork.rs`'s slug helpers, replacing the
//!   prelude there. The trait shape and Tauri command surface stay
//!   the same.

use crate::model::ChatMessage;

/// Lower-case role tag used inside the prelude so the model can parse
/// the conversation structure. Keep these matched with
/// [`build_migration_prelude`]'s output — tests pin both ends.
fn prelude_role_tag(role: &crate::model::ChatRole) -> &'static str {
    use crate::model::ChatRole;
    match role {
        ChatRole::User => "user",
        ChatRole::Assistant => "assistant",
        ChatRole::System => "system",
    }
}

/// Render a prior conversation as a single user-message prelude to
/// inject as the first turn of the migrated session.
///
/// Returns `None` when there's no history to seed (empty message
/// list, or every message would be filtered as empty). Callers
/// should treat `None` as "no prelude needed — let the user's first
/// turn flow through unchanged."
///
/// The format is plain text with explicit `<user>` / `<assistant>` /
/// `<system>` tags. We deliberately avoid the harness's native
/// transcript JSON because (a) each harness has a different format
/// and we'd need three serializers, and (b) the prelude has to round-
/// trip through a single user-message slot anyway, so we can't
/// reproduce structured tool-use even if we wrote the right JSON.
pub fn build_migration_prelude(messages: &[ChatMessage]) -> Option<String> {
    let entries: Vec<&ChatMessage> = messages
        .iter()
        .filter(|m| !m.content.trim().is_empty())
        .collect();
    if entries.is_empty() {
        return None;
    }

    let mut out = String::new();
    out.push_str(
        "[This session was just migrated from a different agent runtime. \
         The full prior conversation follows inside <conversation-history>. \
         Read it for context, then respond to the user's next message as if \
         the conversation had been continuous. Tool calls in the history are \
         informational only — do not attempt to re-execute them unless the \
         user explicitly asks.]\n\n<conversation-history>",
    );
    for msg in entries {
        let tag = prelude_role_tag(&msg.role);
        out.push_str("\n<");
        out.push_str(tag);
        out.push('>');
        if let Some(thinking) = &msg.thinking
            && !thinking.trim().is_empty()
        {
            out.push_str("\n<thinking>\n");
            out.push_str(thinking.trim());
            out.push_str("\n</thinking>");
        }
        out.push('\n');
        out.push_str(msg.content.trim());
        out.push_str("\n</");
        out.push_str(tag);
        out.push('>');
    }
    out.push_str("\n</conversation-history>\n");
    Some(out)
}

/// Combine a migration prelude with the user's actual next message,
/// producing the payload to send as turn 1 of the migrated session.
///
/// Kept separate from [`build_migration_prelude`] so the prelude can
/// be persisted and reused if the user dismisses their first draft
/// before sending — the prelude survives, only the user text changes.
pub fn merge_prelude_with_user_message(prelude: &str, user_message: &str) -> String {
    let trimmed_user = user_message.trim();
    if trimmed_user.is_empty() {
        return prelude.to_string();
    }
    format!("{prelude}\n{trimmed_user}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ChatMessage, ChatRole};

    fn msg(id: &str, role: ChatRole, content: &str) -> ChatMessage {
        ChatMessage {
            id: id.into(),
            workspace_id: "w1".into(),
            chat_session_id: "s1".into(),
            role,
            content: content.into(),
            cost_usd: None,
            duration_ms: None,
            created_at: "2026-05-15T00:00:00Z".into(),
            thinking: None,
            input_tokens: None,
            output_tokens: None,
            cache_read_tokens: None,
            cache_creation_tokens: None,
        }
    }

    #[test]
    fn empty_history_returns_none() {
        assert!(build_migration_prelude(&[]).is_none());
    }

    #[test]
    fn all_blank_messages_return_none() {
        let messages = vec![
            msg("m1", ChatRole::User, ""),
            msg("m2", ChatRole::Assistant, "   "),
            msg("m3", ChatRole::User, "\n\t  \n"),
        ];
        assert!(
            build_migration_prelude(&messages).is_none(),
            "messages whose trimmed content is empty must not produce a prelude"
        );
    }

    #[test]
    fn prelude_wraps_conversation_in_history_block() {
        let messages = vec![
            msg("m1", ChatRole::User, "How do I parse JSON in Rust?"),
            msg(
                "m2",
                ChatRole::Assistant,
                "Use `serde_json::from_str` for owned data.",
            ),
        ];

        let prelude = build_migration_prelude(&messages).expect("prelude must exist");

        assert!(
            prelude.starts_with("[This session was just migrated"),
            "prelude must lead with the framing instruction so the next model knows it's reading context, not a new task"
        );
        assert!(prelude.contains("<conversation-history>"));
        assert!(prelude.contains("</conversation-history>"));
        assert!(prelude.contains("<user>\nHow do I parse JSON in Rust?\n</user>"));
        assert!(
            prelude
                .contains("<assistant>\nUse `serde_json::from_str` for owned data.\n</assistant>")
        );
    }

    #[test]
    fn prelude_preserves_message_order() {
        let messages = vec![
            msg("m1", ChatRole::User, "first user"),
            msg("m2", ChatRole::Assistant, "first reply"),
            msg("m3", ChatRole::User, "follow up"),
            msg("m4", ChatRole::Assistant, "second reply"),
        ];

        let prelude = build_migration_prelude(&messages).expect("prelude must exist");
        // The four message bodies must appear in order, with no
        // reordering or de-duplication. Order is what makes a
        // conversation a conversation.
        let positions: Vec<_> = ["first user", "first reply", "follow up", "second reply"]
            .iter()
            .map(|needle| {
                prelude
                    .find(needle)
                    .unwrap_or_else(|| panic!("prelude missing {needle:?}"))
            })
            .collect();
        let mut sorted = positions.clone();
        sorted.sort_unstable();
        assert_eq!(positions, sorted, "messages must appear in input order");
    }

    #[test]
    fn prelude_emits_distinct_tags_per_role() {
        let messages = vec![
            msg("m1", ChatRole::System, "you are a helpful assistant"),
            msg("m2", ChatRole::User, "hi"),
            msg("m3", ChatRole::Assistant, "hello"),
        ];
        let prelude = build_migration_prelude(&messages).expect("prelude must exist");
        assert!(prelude.contains("<system>"));
        assert!(prelude.contains("<user>"));
        assert!(prelude.contains("<assistant>"));
        // The closing tags must mirror the opens.
        assert!(prelude.contains("</system>"));
        assert!(prelude.contains("</user>"));
        assert!(prelude.contains("</assistant>"));
    }

    #[test]
    fn prelude_skips_blank_messages_but_keeps_others() {
        let messages = vec![
            msg("m1", ChatRole::User, "real content"),
            msg("m2", ChatRole::Assistant, ""),
            msg("m3", ChatRole::User, "more content"),
        ];
        let prelude = build_migration_prelude(&messages).expect("prelude must exist");
        assert!(prelude.contains("real content"));
        assert!(prelude.contains("more content"));
        // Make sure we didn't emit an empty <assistant></assistant>
        // block, which would confuse the model.
        assert!(
            !prelude.contains("<assistant>\n\n</assistant>")
                && !prelude.contains("<assistant>\n</assistant>"),
            "blank messages must be filtered, not emitted as empty role blocks"
        );
    }

    #[test]
    fn prelude_includes_assistant_thinking_when_present() {
        let mut m = msg("m1", ChatRole::Assistant, "Here's the answer.");
        m.thinking = Some("Let me think about edge cases...".into());
        let prelude = build_migration_prelude(&[m]).expect("prelude must exist");

        assert!(prelude.contains("<thinking>\nLet me think about edge cases...\n</thinking>"));
        assert!(prelude.contains("Here's the answer."));
        // Thinking goes inside the role block, before the content,
        // so the prelude reads chronologically (model thought, then
        // model spoke).
        let thinking_pos = prelude.find("<thinking>").unwrap();
        let content_pos = prelude.find("Here's the answer.").unwrap();
        assert!(thinking_pos < content_pos);
    }

    #[test]
    fn merge_prelude_with_user_message_appends_user_text() {
        let prelude = "<conversation-history>...</conversation-history>";
        let merged = merge_prelude_with_user_message(prelude, "now do X");
        assert!(merged.starts_with(prelude));
        assert!(merged.ends_with("now do X"));
    }

    #[test]
    fn merge_prelude_with_empty_user_message_returns_prelude_alone() {
        // Edge case: user clicks "Send" with no text after migration.
        // We still want to ship the prelude so the new harness has
        // context — but we don't want trailing whitespace gluing
        // nothing onto the end.
        let prelude = "<conversation-history>x</conversation-history>";
        assert_eq!(merge_prelude_with_user_message(prelude, ""), prelude);
        assert_eq!(merge_prelude_with_user_message(prelude, "   \n"), prelude);
    }
}
