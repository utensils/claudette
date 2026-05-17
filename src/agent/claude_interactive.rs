//! ClaudeInteractive backend.
//!
//! Materializes a per-session settings overlay that registers Claude Code
//! hooks, then asks an `InteractiveHost` to spawn `claude` with
//! `CLAUDE_CONFIG_DIR` pointing at the overlay.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::agent::interactive_host::{HostError, InteractiveHost, SessionId, SessionSpec};

/// Long-lived handle to an interactive `claude` session running inside an
/// `InteractiveHost` (tmux on Unix, sidecar elsewhere).
///
/// Holds the stable session id, a shared handle to the host that owns the
/// session, and the per-session settings overlay (so callers can clean it
/// up when the session is torn down). The actual turn dispatch / steering
/// plumbing lands in subsequent tasks — this type's job for F2 is to bind
/// the three pieces together at construction time.
pub struct InteractiveSession {
    /// Stable session identifier (`claudette-<workspace>-<rand>`). Mirrors
    /// the `sid` embedded in the settings-overlay hook commands so that
    /// `claudette-cli chat hook` callbacks route back to this session.
    pub sid: String,
    /// The interactive host that owns the live session. Shared with the
    /// rest of the app so attach / send_input / stop can be routed
    /// through the same handle that spawned the session.
    pub host: Arc<dyn InteractiveHost>,
    /// Per-session `CLAUDE_CONFIG_DIR` overlay. Owned by the session so
    /// the directory is cleaned up alongside the session itself.
    pub overlay: SettingsOverlay,
}

impl InteractiveSession {
    /// Spin up a new interactive session: pick a session id, materialize
    /// a settings overlay, point `SessionSpec::claude_config_dir` at it,
    /// and ask the host to `ensure_session`.
    ///
    /// `overlay_parent` is the directory under which the per-session
    /// overlay subtree (`<sid>/claude-config/settings.json`) is written.
    /// `cli_bin_abs` is the absolute path to the `claudette-cli` binary
    /// that the hooks will shell out to — kept as an argument (rather
    /// than resolved internally) so dev / test callers can swap in a
    /// stub.
    pub async fn start(
        workspace_short: &str,
        host: Arc<dyn InteractiveHost>,
        spec: SessionSpec,
        overlay_parent: &Path,
        cli_bin_abs: &Path,
    ) -> Result<Self, HostError> {
        let sid_str = format!("claudette-{}-{}", workspace_short, random_hex8());
        let overlay = SettingsOverlay::materialize(overlay_parent, &sid_str, cli_bin_abs)
            .map_err(|e| HostError::Other(e.to_string()))?;
        let spec = SessionSpec {
            claude_config_dir: overlay.dir.to_string_lossy().into_owned(),
            ..spec
        };
        let sid = SessionId(sid_str.clone());
        host.ensure_session(&sid, &spec).await?;
        Ok(Self {
            sid: sid_str,
            host,
            overlay,
        })
    }
}

/// 4 cryptographically-random bytes formatted as 8 lowercase hex chars.
/// Used to disambiguate sessions within a single workspace.
fn random_hex8() -> String {
    use rand::RngCore;
    let mut buf = [0u8; 4];
    rand::thread_rng().fill_bytes(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// A transient `CLAUDE_CONFIG_DIR` overlay that registers three Claude Code
/// hooks (Stop / Notification / UserPromptSubmit) which call back into the
/// running GUI via the bundled `claudette-cli` binary.
///
/// The overlay is per-session: every interactive session gets its own
/// directory keyed by `sid`, and its hook commands embed that same `sid` so
/// the IPC callback can route events to the right channel.
#[derive(Debug, Clone)]
pub struct SettingsOverlay {
    /// Absolute path to the overlay directory. Suitable for use as
    /// `CLAUDE_CONFIG_DIR` when spawning `claude`.
    pub dir: PathBuf,
}

impl SettingsOverlay {
    /// Create a fresh per-session overlay directory and write `settings.json`
    /// registering hooks that call back via `cli_bin_abs` with `--sid <sid>`.
    ///
    /// The hook schema matches the shape used by
    /// `crate::agent::args::build_settings_json` — `hooks.<HookName>[]` with
    /// `matcher` plus a nested `hooks[]` list of `{type, command}` entries.
    pub fn materialize(parent: &Path, sid: &str, cli_bin_abs: &Path) -> std::io::Result<Self> {
        let dir = parent.join(sid).join("claude-config");
        std::fs::create_dir_all(&dir)?;

        let cli = shell_quote(cli_bin_abs.to_string_lossy().as_ref());
        let stop_cmd = format!("{cli} chat hook --sid {sid} --kind stop");
        let awaiting_cmd = format!("{cli} chat hook --sid {sid} --kind awaiting");
        let prompt_cmd = format!("{cli} chat hook --sid {sid} --kind prompt_submitted");

        let settings = serde_json::json!({
            "hooks": {
                "Stop": [{
                    "matcher": "",
                    "hooks": [{ "type": "command", "command": stop_cmd }],
                }],
                "Notification": [{
                    "matcher": "",
                    "hooks": [{ "type": "command", "command": awaiting_cmd }],
                }],
                "UserPromptSubmit": [{
                    "matcher": "",
                    "hooks": [{ "type": "command", "command": prompt_cmd }],
                }],
            }
        });
        std::fs::write(
            dir.join("settings.json"),
            serde_json::to_vec_pretty(&settings)?,
        )?;
        Ok(Self { dir })
    }

    /// Remove the overlay directory. Idempotent — returns Ok if already gone.
    pub fn cleanup(&self) -> std::io::Result<()> {
        if self.dir.exists() {
            std::fs::remove_dir_all(&self.dir)?;
        }
        Ok(())
    }
}

/// POSIX-style shell quoting for the hook command. A bare path that only
/// contains alphanumerics plus `/ _ - .` is left as-is; anything else is
/// single-quoted with embedded `'` escaped as `'\''`.
fn shell_quote(s: &str) -> String {
    if s.chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-' | '.'))
    {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlay_writes_settings_with_three_hooks() {
        let dir = tempfile::tempdir().unwrap();
        let overlay = SettingsOverlay::materialize(
            dir.path(),
            "claudette-x-y",
            Path::new("/abs/path/to/claudette-cli"),
        )
        .unwrap();
        let json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(overlay.dir.join("settings.json")).unwrap())
                .unwrap();
        let hooks = json.get("hooks").unwrap();
        for key in ["Stop", "Notification", "UserPromptSubmit"] {
            assert!(hooks.get(key).is_some(), "missing hook: {key}");
            let arr = hooks.get(key).unwrap().as_array().unwrap();
            assert_eq!(arr.len(), 1, "hook {key} should have one matcher entry");
            let entry = &arr[0];
            assert_eq!(entry.get("matcher").and_then(|v| v.as_str()), Some(""));
            let inner = entry.get("hooks").unwrap().as_array().unwrap();
            assert_eq!(inner.len(), 1);
            assert_eq!(
                inner[0].get("type").and_then(|v| v.as_str()),
                Some("command")
            );
            let cmd = inner[0].get("command").and_then(|v| v.as_str()).unwrap();
            assert!(cmd.contains("/abs/path/to/claudette-cli"), "cmd: {cmd}");
            assert!(cmd.contains("--sid claudette-x-y"), "cmd: {cmd}");
            assert!(cmd.contains("chat hook"), "cmd: {cmd}");
        }
        overlay.cleanup().unwrap();
        assert!(!overlay.dir.exists());
    }

    #[test]
    fn shell_quote_leaves_plain_paths_alone() {
        assert_eq!(
            shell_quote("/usr/local/bin/claudette-cli"),
            "/usr/local/bin/claudette-cli"
        );
    }

    #[test]
    fn shell_quote_wraps_paths_with_spaces() {
        assert_eq!(
            shell_quote("/Users/me/Application Support/cli"),
            "'/Users/me/Application Support/cli'"
        );
    }

    #[test]
    fn shell_quote_escapes_embedded_single_quotes() {
        assert_eq!(shell_quote("foo'bar"), "'foo'\\''bar'");
    }

    #[test]
    fn random_hex8_returns_8_lowercase_hex_chars() {
        let s = random_hex8();
        assert_eq!(s.len(), 8, "expected 8 chars, got {s:?}");
        assert!(
            s.chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_uppercase()),
            "expected lowercase hex digits, got {s:?}"
        );
    }
}
