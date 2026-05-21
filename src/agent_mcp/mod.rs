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
pub mod hook;
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
    description: "Lets the agent deliver images, screenshots, PDFs, and text/data \
                  artifacts (plain text, CSV, JSON, Markdown) inline in chat. The agent \
                  reaches for this whenever you ask it to send, share, or show you a \
                  file — including artifacts produced by other tools (e.g. a Playwright \
                  screenshot, a generated CSV). Each type renders with a type-aware \
                  preview. Disable to remove the tool and stop the system prompt from \
                  nudging the agent to use it.",
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

/// `send_to_user` nudge appended only when the Agent Attachments plugin is
/// enabled. The bare `tools/list` description isn't enough on its own — a
/// model can see the tool listed and still default to "save to disk" when
/// the user says "send me a screenshot". Worded as a positive instruction
/// with the supported-type allow-list and the failure-mode escape hatch
/// both spelled out, so the model doesn't reach for `send_to_user` on types
/// it can't deliver.
pub const SEND_TO_USER_NUDGE: &str = "\
Inline file delivery: this Claudette workspace exposes the MCP tool \
`mcp__claudette__send_to_user` (server `claudette`, tool `send_to_user`). \
When the user asks you to send / share / show them a file, call this tool \
with the absolute file path AFTER the file exists on disk. Saving a file \
to disk alone does NOT surface it to the user — the file only appears \
inline in chat once you invoke this tool. If you produced the file via \
another tool (e.g. a screenshot tool that wrote to a path), follow up \
with `send_to_user` to deliver it. \
Supported types: images (PNG/JPEG/GIF/WebP/SVG), PDF, plain text, CSV, \
JSON, Markdown — each with its own size cap. For any other type \
(binaries, archives, oversized files), do NOT call this tool; the call \
will be rejected. Instead, tell the user the absolute path on disk so \
they can open it manually.";

/// Scheduling + Monitor nudge for MCP-served harnesses (Claude / Codex).
/// Always appended, regardless of the Agent Attachments toggle — the MCP
/// server is now injected unconditionally, so scheduling discoverability
/// must not regress when the user disables `send_to_user`. Pi has its own
/// nudge ([`PI_SCHEDULING_NUDGE`]) because it ships a different tool
/// surface (no `Monitor`, no MCP `mcp__claudette__` prefixes).
pub const MCP_SCHEDULING_NUDGE: &str = "\
Native scheduling: this server exposes `ScheduleWakeup`, `CronCreate`, \
`CronList`, `CronDelete`, and `Monitor`. Use `ScheduleWakeup` when you need \
Claudette to wake this chat later with a prompt. Use the cron tools for \
recurring routines. Use `Monitor` to subscribe to future output from a \
background Bash task instead of polling.";

/// Compose the Claude / Codex system-prompt nudge. `MCP_SCHEDULING_NUDGE`
/// is always included (scheduling is decoupled from the Agent Attachments
/// toggle); `SEND_TO_USER_NUDGE` is only appended when the user has the
/// Agent Attachments plugin enabled. Returns `None` when nothing applies
/// (currently unreachable — scheduling is always on — but kept symmetric
/// with the call site's `Option<String>` shape).
#[must_use]
pub fn mcp_system_prompt_nudge(send_to_user_enabled: bool) -> Option<String> {
    let mut parts: Vec<&str> = Vec::with_capacity(2);
    parts.push(MCP_SCHEDULING_NUDGE);
    if send_to_user_enabled {
        parts.push(SEND_TO_USER_NUDGE);
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n\n"))
    }
}

/// Scheduling nudge for Pi SDK sessions. Pi has no Claudette MCP bridge —
/// its scheduling tools are registered as *native* sidecar tools, so this
/// is worded without the `mcp__claudette__` prefixes [`MCP_SCHEDULING_NUDGE`]
/// uses, and omits `send_to_user` / `Monitor` (Pi ships neither).
pub const PI_SCHEDULING_NUDGE: &str = "\
Native scheduling: you have the tools `ScheduleWakeup`, `CronCreate`, \
`CronList`, and `CronDelete`. Use `ScheduleWakeup` to wake this chat later \
with a prompt; use the cron tools for recurring routines.";

/// Claude-CLI-only rules that reference MCP tools shipped by the Claude
/// Code runtime (`AskUserQuestion`, `ExitPlanMode`). These tools do not
/// exist in the Pi SDK or the Codex app-server harnesses, so the rules
/// only get appended for Claude CLI sessions — otherwise the model is
/// told to use tools it doesn't have, which is both confusing for the
/// model and a small step in the wrong direction for accuracy.
pub const CLAUDE_CODE_MCP_RULES: &str = "\
## Rules\n\
\n\
- Whenever you have a question for the user — no matter how minor — you MUST use the `AskUserQuestion` tool. No exceptions: do not ask questions in plain text output.\n\
- Before complaining about a permissions error or denied tool call, check whether you are in plan mode. If you are in plan mode, you must exit plan mode (via `ExitPlanMode`) before retrying — many tools are intentionally blocked while planning.";

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
    fn nudge_with_send_to_user_enabled_contains_both_blocks() {
        // Toggle on → scheduling + send_to_user, joined with a blank
        // line. Splitting the two strings (rather than emitting one
        // bundled `SYSTEM_PROMPT_NUDGE`) is what keeps scheduling
        // discoverable when a user disables Agent Attachments.
        let composed = mcp_system_prompt_nudge(true).expect("nudge always present");
        assert!(composed.contains("ScheduleWakeup"));
        assert!(composed.contains("Monitor"));
        assert!(composed.contains("send_to_user"));
        assert!(composed.contains("\n\n"));
    }

    #[test]
    fn nudge_with_send_to_user_disabled_keeps_scheduling_block() {
        // Toggle off → scheduling/Monitor guidance is still injected
        // (the MCP server is unconditional), but the file-delivery
        // paragraph is stripped. Pins the decoupling fix Copilot
        // flagged on #980.
        let composed = mcp_system_prompt_nudge(false).expect("scheduling is always on");
        assert!(composed.contains("ScheduleWakeup"));
        assert!(composed.contains("Monitor"));
        assert!(!composed.contains("send_to_user"));
        assert!(!composed.contains("Inline file delivery"));
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
