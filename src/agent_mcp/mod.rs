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

/// A built-in Claudette plugin — a Rust-implemented agent-callable surface
/// exposed via the in-process MCP bridge. Registered statically (no dynamic
/// discovery) so the settings UI has a stable, hand-curated list.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct BuiltinPlugin {
    /// Stable id, used as the setting-key suffix, the settings-UI key, and the
    /// MCP tool name (each builtin plugin maps to one always-available tool).
    pub name: &'static str,
    /// One-line title for the settings UI.
    pub title: &'static str,
    /// Longer description shown alongside the toggle.
    pub description: &'static str,
}

/// `app_settings` key for the experimental "Claudette MCP" feature, which gates
/// the agent-initiated interaction tools (`ask_user`, `request_review`,
/// `present_conclusion`) plus the system-prompt steering toward them. **Off by
/// default** — only the literal string `"true"` enables it — so the feature can
/// ship without changing behavior for anyone who hasn't opted in. Lives in the
/// Experimental settings section (not Plugins).
pub const CLAUDETTE_MCP_SETTING: &str = "claudette_mcp_enabled";

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

/// Whether the experimental "Claudette MCP" feature is enabled. **Off by
/// default**: absent or any value other than `"true"` reads as disabled, so the
/// agent-interaction tools and their prompt steering stay dark until the user
/// opts in via Settings → Experimental.
pub fn claudette_mcp_enabled(db: &crate::db::Database) -> bool {
    matches!(db.get_app_setting(CLAUDETTE_MCP_SETTING), Ok(Some(v)) if v == "true")
}

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
/// Worded as a positive instruction with the supported-type allow-list and the
/// failure-mode escape hatch both spelled out, so the model doesn't reach for
/// `send_to_user` on types it can't deliver.
pub const SYSTEM_PROMPT_NUDGE: &str = "\
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
they can open it manually.\n\
\n\
Native scheduling: this same server exposes `ScheduleWakeup`, `CronCreate`, \
`CronList`, `CronDelete`, and `Monitor`. Use `ScheduleWakeup` when you need \
Claudette to wake this chat later with a prompt. Use the cron tools for \
recurring routines. Use `Monitor` to subscribe to future output from a \
background Bash task instead of polling.";

/// System-prompt nudge for the interactive-prompt tools. Kept separate from
/// [`SYSTEM_PROMPT_NUDGE`] so each feature's toggle gates only its own
/// guidance — disabling Agent Attachments must not strip the interaction
/// guidance, and vice versa.
///
/// Deliberately reiterates the mandate that [`claude_code_mcp_rules`] also
/// states: the model strongly defaults to its native `AskUserQuestion`, so the
/// steering toward our look-alike `mcp__claudette__ask_user` has to be repeated
/// and explicit to win.
pub const INTERACTION_PROMPT_NUDGE: &str = "\
Interactive user prompts (REQUIRED tools): this Claudette workspace exposes \
the MCP tools `mcp__claudette__ask_user`, `mcp__claudette__request_review`, \
and `mcp__claudette__present_conclusion` (server `claudette`). These are the \
required way to interact with the user in Claudette — use them in preference \
to plain chat text and in preference to any similarly-named built-in tool. \
- When you need the user to answer a question or choose between options, you \
MUST call `mcp__claudette__ask_user` (NOT the native `AskUserQuestion`) and \
wait for the answer; it renders interactive options and blocks until they \
respond. \
- Before acting on a plan or a consequential, hard-to-reverse decision, you \
MUST call `mcp__claudette__request_review` and wait for the user's verdict \
(approve / deny / suggest). \
- When you finish a unit of work, call `mcp__claudette__present_conclusion` \
with a concise summary of what you did — it is recorded in the transcript and \
shown to the user as a conclusion card. \
`ask_user` and `request_review` block on the user, so only call them when you \
genuinely need input — do not call them to narrate progress.";

/// Build the combined system-prompt nudge for the Claudette MCP tools. The
/// attachment section is gated on the `send_to_user` builtin toggle and the
/// interaction section on the experimental `claudette_mcp_enabled` flag, so each
/// is steered only when actually available. Returns `None` when neither is on.
pub fn compose_mcp_nudge(
    send_to_user_enabled: bool,
    agent_interaction_enabled: bool,
) -> Option<String> {
    let mut parts: Vec<&str> = Vec::new();
    if send_to_user_enabled {
        parts.push(SYSTEM_PROMPT_NUDGE);
    }
    if agent_interaction_enabled {
        parts.push(INTERACTION_PROMPT_NUDGE);
    }
    (!parts.is_empty()).then(|| parts.join("\n\n"))
}

/// Claude-CLI-only prompt rules, appended for Claude Code sessions only (Pi /
/// Codex pass `None` — they don't expose these tools, and pointing a qwen / GPT
/// model at tools that aren't registered confuses its capability self-model).
///
/// The question / decision mandate is gated on `agent_interaction_enabled`
/// (sourced from the experimental [`CLAUDETTE_MCP_SETTING`], **off by default**):
/// - **enabled** (opt-in): the model is told to use *our* tools
///   (`mcp__claudette__ask_user` / `request_review` / `present_conclusion`) and
///   explicitly NOT the look-alike native `AskUserQuestion`. The model defaults
///   hard to its native tool, so we both amend the old native mandate and state
///   the new one imperatively here (and again in [`INTERACTION_PROMPT_NUDGE`]).
/// - **disabled** (default): falls back to the native `AskUserQuestion` mandate
///   so the model still asks via a tool rather than plain text — i.e. exactly
///   the pre-feature behavior.
///
/// The plan-mode rule is always present: `ExitPlanMode` is the real mechanism
/// for leaving the CLI's `--permission-mode plan`, independent of (and not
/// replaced by) our `request_review` tool.
pub fn claude_code_mcp_rules(agent_interaction_enabled: bool) -> String {
    let interaction_rules = if agent_interaction_enabled {
        "- Whenever you need the user to answer a question or choose between options — no matter how minor — you MUST call the `mcp__claudette__ask_user` tool and wait for the answer. Do NOT ask in plain text, and do NOT use the native `AskUserQuestion` tool — `mcp__claudette__ask_user` is the required path.\n\
- Before acting on a plan or any consequential, hard-to-reverse decision, you MUST call `mcp__claudette__request_review` and wait for the user's verdict (approve / deny / suggest).\n\
- When you finish a unit of work, call `mcp__claudette__present_conclusion` with a concise summary so it is recorded for the user."
    } else {
        "- Whenever you have a question for the user — no matter how minor — you MUST use the `AskUserQuestion` tool. No exceptions: do not ask questions in plain text output."
    };
    format!(
        "## Rules\n\n{interaction_rules}\n- Before complaining about a permissions error or denied tool call, check whether you are in plan mode. If you are in plan mode, you must exit plan mode (via `ExitPlanMode`) before retrying — many tools are intentionally blocked while planning."
    )
}

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
        // The settings UI shows `title`, not `name`. Make sure every entry's
        // title is human-readable (no underscores, capitalized).
        for p in BUILTIN_PLUGINS {
            assert!(
                !p.title.contains('_'),
                "title should be human-readable: {}",
                p.title
            );
            assert!(p.title.starts_with(|c: char| c.is_uppercase()));
            assert!(!p.description.is_empty());
        }
        assert!(BUILTIN_PLUGINS.iter().any(|p| p.name == "send_to_user"));
    }

    #[test]
    fn claudette_mcp_experimental_flag_defaults_off() {
        let db = Database::open_in_memory().unwrap();
        // Absent setting → feature is OFF (the whole point of the experimental gate).
        assert!(!claudette_mcp_enabled(&db));
        // Only the literal "true" turns it on.
        db.set_app_setting(CLAUDETTE_MCP_SETTING, "false").unwrap();
        assert!(!claudette_mcp_enabled(&db));
        db.set_app_setting(CLAUDETTE_MCP_SETTING, "true").unwrap();
        assert!(claudette_mcp_enabled(&db));
    }

    #[test]
    fn compose_mcp_nudge_gates_each_section_independently() {
        // Both on → both sections present.
        let both = compose_mcp_nudge(true, true).expect("both enabled");
        assert!(both.contains("send_to_user"));
        assert!(both.contains("ask_user"));

        // Only interaction → no attachment nudge.
        let only_interaction = compose_mcp_nudge(false, true).expect("interaction enabled");
        assert!(only_interaction.contains("ask_user"));
        assert!(!only_interaction.contains("Inline file delivery"));

        // Only attachments → no interaction nudge.
        let only_attach = compose_mcp_nudge(true, false).expect("attachments enabled");
        assert!(only_attach.contains("send_to_user"));
        assert!(!only_attach.contains("Interactive user prompts"));

        // Neither → no nudge at all.
        assert!(compose_mcp_nudge(false, false).is_none());
    }
}
