//! In-process MCP server that exposes Claudette-provided tools to the Claude
//! CLI. Lives as a stdio child of the CLI subprocess (spawned by the Tauri
//! parent via the `--agent-mcp` flag on its own binary) and forwards tool
//! invocations back to the parent over a token-authenticated socket.
//!
//! Layout:
//! - [`tools`] — individual tool implementations (one Rust module per tool).
//! - `protocol` (slice 4) — wire types for IPC + MCP JSON-RPC envelope.
//! - `bridge` (slice 5) — parent-side listener with RAII cleanup.
//! - `server` (slice 6) — stdio MCP server loop run by `--agent-mcp`.

pub mod bridge;
pub mod protocol;
pub mod server;
pub mod tools;

use serde::Serialize;

/// A built-in Claudette plugin — a Rust-implemented agent-callable tool
/// surfaced via the in-process MCP bridge. Registered statically (no
/// dynamic discovery) so the settings UI has a stable, hand-curated list.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct BuiltinPlugin {
    /// Stable id, used as the setting key suffix and the MCP tool name.
    pub name: &'static str,
    /// One-line title for the settings UI.
    pub title: &'static str,
    /// Longer description shown alongside the toggle.
    pub description: &'static str,
}

/// All built-in plugins shipped with Claudette. Add new ones here as the
/// agent-tool surface grows.
pub const BUILTIN_PLUGINS: &[BuiltinPlugin] = &[BuiltinPlugin {
    name: "send_to_user",
    title: "Agent Attachments",
    description: "Lets the agent deliver images, screenshots, PDFs, and small text files \
                  inline in chat. The agent reaches for this whenever you ask it to send, \
                  share, or show you a file — including artifacts produced by other tools \
                  (e.g. a Playwright screenshot). Disable to remove the tool and stop the \
                  system prompt from nudging the agent to use it.",
}];

/// Settings key pattern: `builtin_plugin:{name}:enabled`. Absent key = enabled
/// (the default), the literal string `"false"` = disabled. Mirrors the
/// pattern used for Lua plugins.
pub fn builtin_plugin_setting_key(name: &str) -> String {
    format!("builtin_plugin:{name}:enabled")
}

/// Read whether a built-in plugin is currently enabled. Treats any read
/// error as "enabled" so a transient DB failure doesn't silently disable
/// a feature the user explicitly turned on.
pub fn is_builtin_plugin_enabled(db: &crate::db::Database, name: &str) -> bool {
    match db.get_app_setting(&builtin_plugin_setting_key(name)) {
        Ok(Some(v)) => v != "false",
        _ => true,
    }
}

/// System-prompt nudge appended to every fresh persistent session so the model
/// is aware of the agent-MCP tool's purpose — the bare `tools/list` description
/// isn't enough on its own (a model can see the tool listed and still default
/// to "save to disk" when the user says "send me a screenshot").
///
/// Worded as a positive instruction with the failure mode called out.
pub const SYSTEM_PROMPT_NUDGE: &str = "\
Inline file delivery: this Claudette workspace exposes the MCP tool \
`mcp__claudette__send_to_user` (server `claudette`, tool `send_to_user`). \
When the user asks you to send / share / show / give them a file, image, \
screenshot, PDF, or text artifact, call this tool with the absolute file \
path AFTER the file exists on disk. Saving a file to disk alone does NOT \
surface it to the user — the file only appears inline in chat once you \
invoke this tool. If you produced the file via another tool (e.g. a \
screenshot tool that wrote to a path), follow up with `send_to_user` to \
deliver it.";

#[cfg(test)]
mod builtin_tests {
    use super::*;
    use crate::db::Database;

    #[test]
    fn defaults_to_enabled_when_setting_absent() {
        let db = Database::open_in_memory().unwrap();
        assert!(is_builtin_plugin_enabled(&db, "send_to_user"));
    }

    #[test]
    fn disabled_when_setting_false() {
        let db = Database::open_in_memory().unwrap();
        db.set_app_setting(&builtin_plugin_setting_key("send_to_user"), "false")
            .unwrap();
        assert!(!is_builtin_plugin_enabled(&db, "send_to_user"));
    }

    #[test]
    fn enabled_when_setting_true_or_anything_else() {
        let db = Database::open_in_memory().unwrap();
        db.set_app_setting(&builtin_plugin_setting_key("send_to_user"), "true")
            .unwrap();
        assert!(is_builtin_plugin_enabled(&db, "send_to_user"));
    }

    #[test]
    fn key_format_is_stable() {
        assert_eq!(
            builtin_plugin_setting_key("send_to_user"),
            "builtin_plugin:send_to_user:enabled"
        );
    }

    #[test]
    fn registered_plugin_has_user_facing_name() {
        // The settings UI shows `title`, not `name`. Make sure the title is
        // human-readable (no underscores, capitalized).
        let p = BUILTIN_PLUGINS
            .iter()
            .find(|p| p.name == "send_to_user")
            .expect("send_to_user must be registered");
        assert!(
            !p.title.contains('_'),
            "title should be human-readable: {}",
            p.title
        );
        assert!(p.title.starts_with(|c: char| c.is_uppercase()));
        assert!(!p.description.is_empty());
    }
}
