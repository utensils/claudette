//! Tauri-side glue for the missing-CLI dialog.
//!
//! The `claudette` crate reports missing-CLI failures via the sentinel
//! [`claudette::missing_cli::format_err`] string so its error signatures stay
//! simple (`Result<_, String>` / `GitError::CliNotFound`). This module
//! intercepts those sentinels at the Tauri boundary, emits a structured
//! `missing-dependency` event that the frontend listens for to show the
//! install-guidance dialog, and rewrites the error into a short, friendly
//! message so any UI that surfaces the raw `Err` string is still readable.

use tauri::{AppHandle, Emitter};

use claudette::missing_cli::{self, MissingCli};

/// Event name the frontend listens for. Payload: [`MissingCli`].
pub const MISSING_DEPENDENCY_EVENT: &str = "missing-dependency";

/// If `err` carries the missing-CLI sentinel, emit the dialog event and return
/// `Some(friendly_message)` suitable for the original `Result::Err`. Returns
/// `None` for unrelated errors, letting callers fall through with the original.
pub fn handle_err(app: &AppHandle, err: &str) -> Option<String> {
    let tool = missing_cli::parse_err(err)?;
    let guidance = missing_cli::guidance_for(tool);
    emit(app, &guidance);
    Some(friendly_message(&guidance))
}

fn emit(app: &AppHandle, guidance: &MissingCli) {
    if let Err(e) = app.emit(MISSING_DEPENDENCY_EVENT, guidance) {
        tracing::warn!(
            target: "claudette::missing-cli",
            event = MISSING_DEPENDENCY_EVENT,
            error = %e,
            "failed to emit missing-cli event"
        );
    }
}

fn friendly_message(guidance: &MissingCli) -> String {
    // We only emit the Tauri event here — the actual dialog is rendered by
    // `MissingCliModal` on the frontend. Phrase the message neutrally so it
    // still reads correctly if the event listener isn't mounted yet or the
    // `emit` call above failed (see [`emit`]).
    format!(
        "{} is not installed. See the install options dialog.",
        guidance.display_name
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn friendly_message_uses_display_name() {
        let g = missing_cli::guidance_for("claude");
        let msg = friendly_message(&g);
        assert!(msg.starts_with("Claude CLI is not installed."));
    }
}
