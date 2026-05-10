//! Tauri-side glue for the missing-CLI dialog.
//!
//! The `claudette` crate reports missing-CLI failures via the sentinel
//! [`claudette::missing_cli::format_err`] string so its error signatures stay
//! simple (`Result<_, String>` / `GitError::CliNotFound`). This module
//! intercepts those sentinels at the Tauri boundary, emits a structured
//! `missing-dependency` event that the frontend listens for, and rewrites
//! the error into a short, friendly message so any UI that surfaces the
//! raw `Err` string is still readable.
//!
//! On the frontend, `reportMissingCli(payload)` decides whether to
//! auto-open the install-guidance modal: the first event for a given tool
//! pops the modal (so non-chat surfaces — auth, repository, SCM, plugin
//! settings — keep their direct-modal UX), and once the user dismisses
//! the modal, subsequent events for that tool only refresh the cache.
//! The chat error banner renders an inline "View install options →" link
//! that always reopens the modal regardless of dismissal state.
//!
//! It also recognizes the sibling `MISSING_CWD:<path>` sentinel (emitted
//! when a spawn site's working directory has been deleted out from under
//! us) and routes it to a separate `missing-worktree` event so the UI can
//! show a worktree-recovery surface instead of mistakenly blaming the CLI.

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use claudette::missing_cli::{self, MissingCli};

/// Event name the frontend listens for. Payload: [`MissingCli`].
pub const MISSING_DEPENDENCY_EVENT: &str = "missing-dependency";

/// Event name fired when a spawn site's `current_dir` has gone missing.
/// Payload: [`MissingWorktree`].
pub const MISSING_WORKTREE_EVENT: &str = "missing-worktree";

/// Payload for the [`MISSING_WORKTREE_EVENT`] event. The `worktree_path` is
/// the absolute path that was supposed to exist; the frontend can use it to
/// match against any workspace it knows about and surface recovery options.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct MissingWorktree {
    pub worktree_path: String,
}

/// If `err` carries one of the structured sentinels (missing-CLI or
/// missing-worktree), emit the corresponding Tauri event and return
/// `Some(friendly_message)`. Returns `None` for unrelated errors, letting
/// callers fall through with the original.
pub fn handle_err(app: &AppHandle, err: &str) -> Option<String> {
    if let Some(tool) = missing_cli::parse_err(err) {
        let guidance = missing_cli::guidance_for(tool);
        emit_missing_cli(app, &guidance);
        return Some(friendly_message(&guidance));
    }
    if let Some(path) = missing_cli::parse_cwd_err(err) {
        let payload = MissingWorktree {
            worktree_path: path.to_string(),
        };
        emit_missing_worktree(app, &payload);
        return Some(missing_worktree_message(path));
    }
    None
}

fn emit_missing_cli(app: &AppHandle, guidance: &MissingCli) {
    if let Err(e) = app.emit(MISSING_DEPENDENCY_EVENT, guidance) {
        tracing::warn!(
            target: "claudette::missing-cli",
            event = MISSING_DEPENDENCY_EVENT,
            error = %e,
            "failed to emit missing-cli event"
        );
    }
}

fn emit_missing_worktree(app: &AppHandle, payload: &MissingWorktree) {
    if let Err(e) = app.emit(MISSING_WORKTREE_EVENT, payload) {
        tracing::warn!(
            target: "claudette::missing-cli",
            event = MISSING_WORKTREE_EVENT,
            error = %e,
            "failed to emit missing-worktree event"
        );
    }
}

fn friendly_message(guidance: &MissingCli) -> String {
    // The string is rendered both inline (chat banner) and as a fallback
    // surface when the modal listener isn't mounted. Phrase it neutrally:
    // the chat banner appends a "View install options →" link, and
    // non-chat surfaces (auth, repository, SCM, plugin settings) get the
    // modal auto-opened on the first event for the tool.
    format!("{} is not installed.", guidance.display_name)
}

fn missing_worktree_message(path: &str) -> String {
    // Keep the path verbatim — it's the only reliable signal users can use
    // to map this to a workspace they know about.
    format!(
        "Workspace directory is missing: {path}. \
         The worktree was deleted or moved — recreate it, or archive this workspace."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn friendly_message_uses_display_name() {
        let g = missing_cli::guidance_for("claude");
        let msg = friendly_message(&g);
        // The frontend matches on " is not installed." to decide whether
        // to render the inline "View install options" link, so this
        // wording is part of the cross-language contract — keep it.
        assert!(
            msg.starts_with("Claude CLI is not installed."),
            "got {msg:?}"
        );
    }

    #[test]
    fn missing_worktree_message_includes_path() {
        let m = missing_worktree_message("/tmp/gone");
        assert!(m.contains("/tmp/gone"), "got {m:?}");
        assert!(m.to_lowercase().contains("missing"));
    }
}
