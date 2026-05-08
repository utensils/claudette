//! Discover the user-installed `claude` CLI's flag surface by running
//! `claude --help` and parsing the output.
//!
//! Used by the "Claude flags" settings section so users can opt into any
//! flag the binary supports without Claudette needing a code change for
//! each new option upstream ships.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::process::Command;
use tokio::time::timeout;

use crate::process::CommandWindowExt as _;

/// One option parsed out of `claude --help`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeFlagDef {
    pub name: String,
    pub short: Option<String>,
    pub takes_value: bool,
    pub value_placeholder: Option<String>,
    pub enum_choices: Option<Vec<String>>,
    pub description: String,
    pub is_dangerous: bool,
}

/// Flags that Claudette emits itself (in `agent::args::build_claude_args`
/// and `agent::session::build_persistent_args`) and must therefore never
/// be exposed to users for toggling — letting them flip these would break
/// the agent bridge invariants (output framing, session id ownership,
/// permission-prompt protocol, etc).
///
/// Update this when `build_claude_args` or `build_persistent_args` emits
/// a new flag.
const RESERVED_FLAGS: &[&str] = &[
    "--print",
    "--output-format",
    "--input-format",
    "--replay-user-messages",
    "--verbose",
    "--include-partial-messages",
    "--session-id",
    "--resume",
    "--model",
    "--permission-mode",
    "--permission-prompt-tool",
    "--mcp-config",
    "--settings",
    "--effort",
    "--allowedTools",
    "--append-system-prompt",
    "--chrome",
];

/// Pure parser: take `claude --help` text, return the list of flags users
/// may toggle (reserved flags filtered out). Lines that don't match the
/// expected option shape are skipped.
pub fn parse_claude_help(text: &str) -> Vec<ClaudeFlagDef> {
    let mut out = Vec::new();
    let mut in_options = false;
    for raw in text.lines() {
        let line = raw;
        let trimmed = line.trim_start();
        if trimmed.starts_with("Options:") {
            in_options = true;
            continue;
        }
        if !in_options {
            continue;
        }
        // The "Commands:" header (or any other top-level header line that
        // doesn't start with whitespace) ends the Options block.
        if !line.starts_with(' ') && !trimmed.is_empty() {
            break;
        }
        if let Some(def) = parse_option_line(line) {
            out.push(def);
        }
    }
    out.retain(|f| !RESERVED_FLAGS.contains(&f.name.as_str()));
    out
}

/// Parse a single `claude --help` option line. Returns `None` when the
/// line doesn't look like an option entry (continuation lines, blanks,
/// section headers, etc), or when upstream has marked the flag as
/// deprecated via a `[DEPRECATED …]` description prefix — there's no
/// point spending settings real estate on a flag the CLI itself is
/// telling users to stop using.
fn parse_option_line(line: &str) -> Option<ClaudeFlagDef> {
    let trimmed = line.trim_start();
    if !trimmed.starts_with('-') {
        return None;
    }
    // Split into "left part" (signature, before the description gap) and
    // "right part" (description). `claude --help` separates the two with
    // 2+ spaces; we use that as the split.
    let (sig, desc) = split_signature_and_description(trimmed)?;
    if desc.trim_start().starts_with("[DEPRECATED") {
        return None;
    }
    let (short, name, value_token) = parse_signature(sig)?;

    let (takes_value, value_placeholder, enum_choices) = match value_token {
        Some(token) => {
            let placeholder = strip_brackets(&token);
            let choices = parse_inline_choices(&placeholder);
            (true, Some(strip_choice_suffix(&placeholder)), choices)
        }
        None => (false, None, None),
    };

    // Multi-line descriptions: take only the first physical line. The fixture
    // has each option on a single line, but defensive trimming is cheap.
    let description = desc.lines().next().unwrap_or("").trim().to_string();

    // Some option lines also embed a `(choices: "a", "b")` block in the
    // description rather than inline in the placeholder.
    let enum_choices = enum_choices.or_else(|| parse_description_choices(&description));

    let is_dangerous = name.starts_with("--dangerously-");

    Some(ClaudeFlagDef {
        name,
        short,
        takes_value,
        value_placeholder,
        enum_choices,
        description,
        is_dangerous,
    })
}

/// `claude --help` separates the signature from the description with a run
/// of 2+ spaces. Returns `(signature, description)`.
fn split_signature_and_description(line: &str) -> Option<(&str, &str)> {
    let bytes = line.as_bytes();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b' ' && bytes[i + 1] == b' ' {
            let sig = line[..i].trim();
            let desc = line[i..].trim_start();
            if sig.is_empty() || desc.is_empty() {
                return None;
            }
            return Some((sig, desc));
        }
        i += 1;
    }
    None
}

/// Parse the signature portion (left of the description gap). Examples:
/// - `--add-dir <directories...>`
/// - `-c, --continue`
/// - `--allowedTools, --allowed-tools <tools...>`
/// - `-d, --debug [filter]`
/// - `-p, --print`
fn parse_signature(sig: &str) -> Option<(Option<String>, String, Option<String>)> {
    // The value placeholder, if any, runs from the last unmatched `<` or `[`
    // to the trailing `>` / `]`. Everything inside the brackets is one
    // token (including spaces, e.g. `<mode: a|b|c>`).
    let (head, value_token) = match find_value_token(sig) {
        Some((bracket_start, _)) => (
            sig[..bracket_start].trim_end(),
            Some(sig[bracket_start..].trim().to_string()),
        ),
        None => (sig, None),
    };

    // The head is one or more comma-separated forms (short and/or long).
    // Pick the first long form (`--something`) as the canonical name; if a
    // short form (`-x`) precedes it, capture that too.
    let mut short: Option<String> = None;
    let mut long: Option<String> = None;
    for tok in head.split(',') {
        let t = tok.trim();
        if let Some(rest) = t.strip_prefix("--") {
            if long.is_none() {
                long = Some(format!("--{rest}"));
            }
        } else if let Some(rest) = t.strip_prefix('-')
            && rest.len() == 1
            && short.is_none()
        {
            short = Some(format!("-{rest}"));
        }
    }
    let name = long?;
    Some((short, name, value_token))
}

/// Locate the start of a `<...>` or `[...]` value placeholder in a
/// signature string. Returns `(start_index, end_char)` if both delimiters
/// are present.
fn find_value_token(sig: &str) -> Option<(usize, char)> {
    let open = sig.char_indices().find(|(_, c)| *c == '<' || *c == '[')?;
    let close = match open.1 {
        '<' => '>',
        _ => ']',
    };
    if sig[open.0..].contains(close) {
        Some((open.0, close))
    } else {
        None
    }
}

fn strip_brackets(token: &str) -> String {
    let t = token.trim();
    let inner = t
        .strip_prefix('<')
        .and_then(|s| s.strip_suffix('>'))
        .or_else(|| t.strip_prefix('[').and_then(|s| s.strip_suffix(']')))
        .unwrap_or(t);
    // Drop a trailing `...` repeated-value indicator if present.
    inner.trim_end_matches("...").to_string()
}

/// `<x: a|b|c>` style: extract the choices list, if present.
fn parse_inline_choices(placeholder: &str) -> Option<Vec<String>> {
    let (_, after) = placeholder.split_once(':')?;
    let parts: Vec<String> = after
        .split('|')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if parts.len() >= 2 { Some(parts) } else { None }
}

fn strip_choice_suffix(placeholder: &str) -> String {
    placeholder
        .split_once(':')
        .map(|(name, _)| name.trim().to_string())
        .unwrap_or_else(|| placeholder.to_string())
}

/// `(choices: "a", "b", "c")` style — appears in `--permission-mode` etc.
fn parse_description_choices(desc: &str) -> Option<Vec<String>> {
    let start = desc.find("(choices:")?;
    let after = &desc[start + "(choices:".len()..];
    let end = after.find(')')?;
    let body = &after[..end];
    let mut out = Vec::new();
    for raw in body.split(',') {
        let t = raw.trim().trim_matches('"').trim();
        if !t.is_empty() {
            out.push(t.to_string());
        }
    }
    if out.len() >= 2 { Some(out) } else { None }
}

/// Run `claude --help` and parse it. 5-second timeout. Returns an error
/// string on spawn failure, timeout, non-zero exit with empty stdout, or
/// when parsing yields zero flags.
pub async fn discover_claude_flags() -> Result<Vec<ClaudeFlagDef>, String> {
    let claude_path = crate::agent::resolve_claude_path().await;
    let mut cmd = Command::new(&claude_path);
    cmd.no_console_window();
    cmd.arg("--help")
        .env("PATH", crate::env::enriched_path())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let fut = cmd.output();
    let output = match timeout(Duration::from_secs(5), fut).await {
        Ok(Ok(out)) => out,
        Ok(Err(e)) => return Err(format!("failed to spawn claude --help: {e}")),
        Err(_) => return Err("claude --help timed out after 5s".to_string()),
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    if stdout.trim().is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "claude --help produced no stdout (exit={:?}, stderr={})",
            output.status.code(),
            stderr.trim()
        ));
    }

    let defs = parse_claude_help(&stdout);
    if defs.is_empty() {
        return Err("no flags detected — claude --help format may have changed".to_string());
    }
    Ok(defs)
}

#[cfg(test)]
mod tests {
    use super::*;

    // The fixture is the verbatim output of `claude --help` against a
    // recent release. To regenerate after a CLI upgrade:
    //   claude --help > src/tests/fixtures/claude_help.txt
    const FIXTURE: &str = include_str!("tests/fixtures/claude_help.txt");

    fn find<'a>(defs: &'a [ClaudeFlagDef], name: &str) -> Option<&'a ClaudeFlagDef> {
        defs.iter().find(|d| d.name == name)
    }

    #[test]
    fn fixture_parses_into_nonempty_set() {
        let defs = parse_claude_help(FIXTURE);
        assert!(!defs.is_empty(), "fixture should yield flags");
    }

    #[test]
    fn dangerously_skip_permissions_is_boolean_and_dangerous() {
        let defs = parse_claude_help(FIXTURE);
        let d = find(&defs, "--dangerously-skip-permissions")
            .expect("--dangerously-skip-permissions should be parsed");
        assert!(!d.takes_value);
        assert!(d.is_dangerous);
    }

    #[test]
    fn reserved_flags_are_filtered_out() {
        let defs = parse_claude_help(FIXTURE);
        for reserved in RESERVED_FLAGS {
            assert!(
                find(&defs, reserved).is_none(),
                "{reserved} should be filtered out (reserved)"
            );
        }
    }

    #[test]
    fn value_taking_flag_keeps_placeholder() {
        let defs = parse_claude_help(FIXTURE);
        let d = find(&defs, "--add-dir").expect("--add-dir should be parsed");
        assert!(d.takes_value);
        assert_eq!(d.value_placeholder.as_deref(), Some("directories"));
    }

    #[test]
    fn short_flag_captured() {
        let defs = parse_claude_help(FIXTURE);
        let d = find(&defs, "--debug").expect("--debug should be parsed");
        assert_eq!(d.short.as_deref(), Some("-d"));
    }

    #[test]
    fn inline_enum_choices_extracted() {
        // Synthetic line in the fixture format.
        let synthetic = "Options:\n  --mode <mode: plan|acceptEdits|bypass>  Set the mode\n";
        let defs = parse_claude_help(synthetic);
        assert_eq!(defs.len(), 1);
        let choices = defs[0].enum_choices.as_ref().expect("expected choices");
        assert_eq!(choices, &vec!["plan", "acceptEdits", "bypass"]);
    }

    #[test]
    fn description_choices_extracted() {
        let synthetic = concat!(
            "Options:\n",
            "  --foo <mode>  Pick a mode (choices: \"acceptEdits\", \"plan\", \"default\")\n"
        );
        let defs = parse_claude_help(synthetic);
        assert_eq!(defs.len(), 1);
        let choices = defs[0].enum_choices.as_ref().expect("expected choices");
        assert_eq!(choices, &vec!["acceptEdits", "plan", "default"]);
    }

    #[test]
    fn deprecated_flags_are_filtered_out() {
        // Precondition: the fixture must actually contain a deprecated
        // `--mcp-debug` entry — otherwise this test would silently pass
        // even if upstream removed the flag entirely (or someone
        // regenerated the fixture against a version that no longer
        // includes it), defeating the regression guard.
        assert!(
            FIXTURE.contains("--mcp-debug"),
            "fixture must contain --mcp-debug for this test to be meaningful — \
             regenerate from a claude --help that still lists it, or update the test"
        );
        assert!(
            FIXTURE.contains("[DEPRECATED"),
            "fixture must contain a [DEPRECATED …] marker for this test to be meaningful"
        );

        let defs = parse_claude_help(FIXTURE);
        // Upstream marks `--mcp-debug` as deprecated; the parser should
        // drop it so the Settings UI doesn't surface a flag the CLI is
        // telling users to stop using. Same rule applies to any future
        // `[DEPRECATED …]`-prefixed entry.
        assert!(
            find(&defs, "--mcp-debug").is_none(),
            "--mcp-debug is marked [DEPRECATED] in claude --help and must be filtered"
        );
    }

    #[test]
    fn deprecated_prefix_filter_is_specific_to_deprecated() {
        // A description that merely *mentions* "DEPRECATED" mid-sentence
        // shouldn't be filtered — only the upstream `[DEPRECATED …]`
        // leading marker counts.
        let synthetic = concat!(
            "Options:\n",
            "  --mentions-deprecated  This is not actually DEPRECATED, just discussing it\n",
            "  --is-deprecated        [DEPRECATED. Use --new instead] Old flag\n",
        );
        let defs = parse_claude_help(synthetic);
        assert_eq!(defs.len(), 1);
        assert_eq!(defs[0].name, "--mentions-deprecated");
    }

    #[test]
    fn malformed_input_does_not_panic() {
        // Garbage in, empty (or partial) out — but no panics.
        let _ = parse_claude_help("");
        let _ = parse_claude_help("Options:\n  -- broken line\n");
        let _ = parse_claude_help("Options:\n  not even a flag\n");
        let _ = parse_claude_help("Options:\n  --x\n  --y <\n");
    }

    #[test]
    fn options_outside_section_are_ignored() {
        let txt = "Arguments:\n  --not-an-option        Some text\nOptions:\n  --real-flag        Real description\n";
        let defs = parse_claude_help(txt);
        assert_eq!(defs.len(), 1);
        assert_eq!(defs[0].name, "--real-flag");
    }

    #[test]
    fn commands_section_terminates_options() {
        let txt = concat!(
            "Options:\n",
            "  --first        First flag\n",
            "Commands:\n",
            "  --not-a-flag   Should be ignored\n",
        );
        let defs = parse_claude_help(txt);
        assert_eq!(defs.len(), 1);
        assert_eq!(defs[0].name, "--first");
    }

    /// Lock-in test: every `--…` literal that appears in `build_claude_args`
    /// (`agent/args.rs`) or `build_persistent_args` (`agent/session.rs`)
    /// MUST be in `RESERVED_FLAGS`. Forgetting to reserve a Claudette-managed
    /// flag would let users toggle it from the Settings panel and break the
    /// agent bridge (output framing, session-id ownership, etc.).
    ///
    /// Test-only flag literals (e.g. test fixtures using real claude flag
    /// names like `--debug`) are allowlisted explicitly.
    #[test]
    fn all_emitted_flags_are_reserved() {
        let args_rs = include_str!("agent/args.rs");
        let session_rs = include_str!("agent/session.rs");

        // Hand-rolled scan — find quoted "--…" literals. Avoids a `regex`
        // dep just for this lock-in. Catches all such literals (incl.
        // test fixtures); use the allowlist below to exempt non-emitter
        // occurrences.
        let mut emitted: std::collections::HashSet<String> = std::collections::HashSet::new();
        for src in [args_rs, session_rs] {
            for chunk in src.split('"').skip(1).step_by(2) {
                if chunk.starts_with("--")
                    && chunk.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
                    && chunk.len() >= 4
                {
                    emitted.insert(chunk.to_string());
                }
            }
        }

        // Flags that appear in those files but intentionally are NOT
        // reserved — test fixtures and round-trip examples that use real
        // claude flag names.
        const ALLOWLIST: &[&str] = &[
            "--debug",
            "--add-dir",
            "--effort",
            // REDACTED_VALUE_FLAGS — recognized for display-redaction only,
            // NOT emitted by Claudette. Users may pass these through; we
            // redact their values in the chat-tab CLI banner.
            "--system-prompt",
            "--agents",
            "--betas",
            "--json-schema",
        ];

        let reserved: std::collections::HashSet<&str> =
            super::RESERVED_FLAGS.iter().copied().collect();
        let allowlist: std::collections::HashSet<&str> = ALLOWLIST.iter().copied().collect();

        let mut missing: Vec<String> = emitted
            .into_iter()
            .filter(|f| !reserved.contains(f.as_str()) && !allowlist.contains(f.as_str()))
            .collect();
        missing.sort();
        assert!(
            missing.is_empty(),
            "These --flags appear in build_claude_args or build_persistent_args but are not in RESERVED_FLAGS or the test allowlist: {missing:?}",
        );
    }
}
