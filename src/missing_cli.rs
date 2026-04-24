//! Detection + UX data for "required CLI is not installed" failures.
//!
//! When `Command::new("claude" | "git" | ...)`.spawn()` fails with
//! `io::ErrorKind::NotFound`, the raw OS error ("No such file or directory /
//! program not found") is useless to a new user. This module provides:
//!
//! 1. A sentinel error format ([`format_err`] / [`parse_err`]) that spawn sites
//!    return so the Tauri layer can detect the failure and surface a structured
//!    dialog instead of leaking the subprocess error.
//! 2. Per-tool × per-OS install guidance ([`guidance_for`]) rendered by the
//!    `MissingCliModal` on the frontend.

use serde::Serialize;

/// Prefix on error strings returned by spawn sites when the underlying cause
/// is `io::ErrorKind::NotFound`. Format: `"MISSING_CLI:<tool>"` (optionally
/// followed by `: <original error>` — the parser ignores anything after the
/// tool token).
pub const SPAWN_ERR_PREFIX: &str = "MISSING_CLI:";

/// Produce the sentinel error string for a spawn site that failed because the
/// named CLI is not on PATH.
pub fn format_err(tool: &str) -> String {
    format!("{SPAWN_ERR_PREFIX}{tool}")
}

/// If `err` carries the sentinel [`SPAWN_ERR_PREFIX`], return the tool token.
pub fn parse_err(err: &str) -> Option<&str> {
    let rest = err.strip_prefix(SPAWN_ERR_PREFIX)?;
    // The optional original-error suffix (produced by [`format_err`] callers
    // that append context) is documented as `": <original error>"`. Split only
    // on that unambiguous delimiter so colons inside the tool token — e.g.
    // Windows drive letters in absolute paths (`C:\Tools\gh.exe`) — are
    // preserved. Host-side normalization in `host_exec` usually collapses
    // paths to bare names before emitting the sentinel, but parsing has to
    // stay robust for legacy/hand-crafted payloads.
    Some(rest.split_once(": ").map(|(tool, _)| tool).unwrap_or(rest))
}

/// Returns `true` when the I/O error's root cause is "executable not found".
pub fn is_not_found(err: &std::io::Error) -> bool {
    err.kind() == std::io::ErrorKind::NotFound
}

/// Map an `io::Error` from a `.spawn()` / `.output()` call to either the
/// sentinel missing-CLI error (when `kind == NotFound`) or `fallback()`
/// otherwise. Keeps the call-site clean:
///
/// ```ignore
/// cmd.spawn().map_err(|e| missing_cli::map_spawn_err(&e, "claude",
///     || format!("Failed to spawn claude at {:?}: {e}", path)))?;
/// ```
pub fn map_spawn_err(
    err: &std::io::Error,
    tool: &str,
    fallback: impl FnOnce() -> String,
) -> String {
    if is_not_found(err) {
        format_err(tool)
    } else {
        fallback()
    }
}

/// One install method shown in the dialog. Either `command` (copy-paste) or
/// `url` (open in browser) is populated — the UI renders whichever is present.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct InstallOption {
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

impl InstallOption {
    fn cmd(label: &str, command: &str) -> Self {
        Self {
            label: label.to_string(),
            command: Some(command.to_string()),
            url: None,
        }
    }
    fn link(label: &str, url: &str) -> Self {
        Self {
            label: label.to_string(),
            command: None,
            url: Some(url.to_string()),
        }
    }
}

/// Structured payload for the `missing-dependency` Tauri event.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct MissingCli {
    /// Raw executable token — `"claude"`, `"git"`, `"gh"`.
    pub tool: String,
    /// Human-friendly name for the dialog title — `"Claude CLI"`.
    pub display_name: String,
    /// One-sentence explanation of why Claudette needs this tool.
    pub purpose: String,
    /// `"macos"`, `"linux"`, or `"windows"` — drives which install options the
    /// frontend shows most prominently.
    pub platform: String,
    /// Install options — ordered by recommendation. Common options (e.g. `npm`)
    /// appear on all platforms; platform-native options (`brew`, `winget`)
    /// appear only where relevant.
    pub install_options: Vec<InstallOption>,
}

/// Current OS token used in the payload.
pub fn current_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
}

/// Build the guidance payload for a given tool, targeting [`current_platform`].
/// Unknown tools fall back to a minimal "not found" entry so the dialog still
/// renders something useful.
pub fn guidance_for(tool: &str) -> MissingCli {
    let platform = current_platform().to_string();
    match tool {
        "claude" => MissingCli {
            tool: tool.to_string(),
            display_name: "Claude CLI".to_string(),
            purpose: "Claudette orchestrates Claude Code agents by running the \
                `claude` CLI as a subprocess — it needs to be installed and on PATH."
                .to_string(),
            platform,
            install_options: claude_options(),
        },
        "git" => MissingCli {
            tool: tool.to_string(),
            display_name: "Git".to_string(),
            purpose: "Claudette uses Git for repository detection, worktrees, \
                diffs, and checkpoints."
                .to_string(),
            platform,
            install_options: git_options(),
        },
        "gh" => MissingCli {
            tool: tool.to_string(),
            display_name: "GitHub CLI".to_string(),
            purpose: "Some Claudette features talk to GitHub through the `gh` CLI \
                (for example the GitHub SCM plugin)."
                .to_string(),
            platform,
            install_options: gh_options(),
        },
        other => MissingCli {
            tool: other.to_string(),
            display_name: other.to_string(),
            purpose: format!("Claudette needs `{other}` on PATH, but it wasn't found."),
            platform,
            install_options: Vec::new(),
        },
    }
}

fn claude_options() -> Vec<InstallOption> {
    let mut opts = vec![InstallOption::cmd(
        "Install with npm",
        "npm install -g @anthropic-ai/claude-code",
    )];
    if cfg!(target_os = "windows") {
        opts.push(InstallOption::link(
            "Official installer",
            "https://claude.com/product/claude-code",
        ));
    } else {
        opts.push(InstallOption::link(
            "Installation guide",
            "https://docs.claude.com/en/docs/claude-code/setup",
        ));
    }
    opts
}

fn git_options() -> Vec<InstallOption> {
    if cfg!(target_os = "macos") {
        vec![
            InstallOption::cmd("Install Xcode Command Line Tools", "xcode-select --install"),
            InstallOption::cmd("Install with Homebrew", "brew install git"),
            InstallOption::link("git-scm.com", "https://git-scm.com/download/mac"),
        ]
    } else if cfg!(target_os = "windows") {
        vec![
            InstallOption::cmd("Install with winget", "winget install --id Git.Git -e"),
            InstallOption::link("Git for Windows", "https://git-scm.com/download/win"),
        ]
    } else {
        vec![
            InstallOption::cmd("Debian / Ubuntu", "sudo apt install git"),
            InstallOption::cmd("Fedora / RHEL", "sudo dnf install git"),
            InstallOption::cmd("Arch", "sudo pacman -S git"),
            InstallOption::link("Other distros", "https://git-scm.com/download/linux"),
        ]
    }
}

fn gh_options() -> Vec<InstallOption> {
    if cfg!(target_os = "macos") {
        vec![
            InstallOption::cmd("Install with Homebrew", "brew install gh"),
            InstallOption::link("cli.github.com", "https://cli.github.com/"),
        ]
    } else if cfg!(target_os = "windows") {
        vec![
            InstallOption::cmd("Install with winget", "winget install --id GitHub.cli -e"),
            InstallOption::link("cli.github.com", "https://cli.github.com/"),
        ]
    } else {
        vec![
            InstallOption::cmd("Debian / Ubuntu", "sudo apt install gh"),
            InstallOption::cmd("Fedora / RHEL", "sudo dnf install gh"),
            InstallOption::cmd("Arch", "sudo pacman -S github-cli"),
            InstallOption::link("Install guide", "https://github.com/cli/cli#installation"),
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_and_parse_roundtrip() {
        let s = format_err("claude");
        assert_eq!(parse_err(&s), Some("claude"));
        let s2 = format!("{s}: some suffix");
        assert_eq!(parse_err(&s2), Some("claude"));
    }

    #[test]
    fn parse_err_rejects_non_sentinel() {
        assert_eq!(parse_err("Failed to spawn"), None);
        assert_eq!(parse_err(""), None);
    }

    #[test]
    fn parse_err_preserves_windows_absolute_path_tool() {
        // Regression for Copilot review on PR #417: splitting on the first
        // `:` truncated Windows absolute paths (`MISSING_CLI:C:\Tools\gh.exe`
        // parsed as `tool=C`). `parse_err` now splits only on the documented
        // `": "` suffix delimiter.
        assert_eq!(
            parse_err(r"MISSING_CLI:C:\Tools\gh.exe"),
            Some(r"C:\Tools\gh.exe")
        );
        assert_eq!(
            parse_err(r"MISSING_CLI:C:\Tools\gh.exe: No such file or directory"),
            Some(r"C:\Tools\gh.exe")
        );
    }

    #[test]
    fn is_not_found_maps_errorkind() {
        let not_found = std::io::Error::new(std::io::ErrorKind::NotFound, "program not found");
        assert!(is_not_found(&not_found));
        let other = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "nope");
        assert!(!is_not_found(&other));
    }

    #[test]
    fn map_spawn_err_returns_sentinel_on_not_found() {
        let err = std::io::Error::new(std::io::ErrorKind::NotFound, "x");
        let out = map_spawn_err(&err, "claude", || "fallback".to_string());
        assert_eq!(out, format_err("claude"));
    }

    #[test]
    fn map_spawn_err_returns_fallback_otherwise() {
        let err = std::io::Error::other("boom");
        let out = map_spawn_err(&err, "claude", || "fallback".to_string());
        assert_eq!(out, "fallback");
    }

    #[test]
    fn guidance_for_claude_has_npm_option() {
        let g = guidance_for("claude");
        assert_eq!(g.tool, "claude");
        assert_eq!(g.display_name, "Claude CLI");
        assert!(!g.purpose.is_empty());
        assert!(
            g.install_options
                .iter()
                .any(|o| o.command.as_deref() == Some("npm install -g @anthropic-ai/claude-code"))
        );
    }

    #[test]
    fn guidance_for_git_has_platform_option() {
        let g = guidance_for("git");
        assert_eq!(g.tool, "git");
        assert!(!g.install_options.is_empty());
    }

    #[test]
    fn guidance_for_gh_has_entries() {
        let g = guidance_for("gh");
        assert_eq!(g.tool, "gh");
        assert!(!g.install_options.is_empty());
    }

    #[test]
    fn guidance_for_unknown_tool_returns_fallback() {
        let g = guidance_for("fakebin");
        assert_eq!(g.tool, "fakebin");
        assert!(g.install_options.is_empty());
    }

    #[test]
    fn current_platform_is_one_of_three() {
        let p = current_platform();
        assert!(matches!(p, "macos" | "linux" | "windows"));
    }
}
