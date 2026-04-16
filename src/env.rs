//! Enriched environment for child processes.
//!
//! macOS apps launched from Finder inherit a minimal PATH
//! (`/usr/bin:/bin:/usr/sbin:/sbin`). Tools like `npx`, `node`, `python`,
//! and `claude` typically live in directories added by the user's shell
//! profile (`.zshrc`, `.bashrc`, etc.).
//!
//! This module probes the user's login shell once, caches the result, and
//! exposes it for subprocess spawning and PATH-based command lookup.

use std::ffi::OsString;
use std::path::Path;
use std::sync::OnceLock;

/// Cached login-shell PATH, resolved once per process lifetime.
static SHELL_PATH: OnceLock<Option<OsString>> = OnceLock::new();

/// Get the user's full PATH as seen by their login shell.
///
/// On first call, spawns `$SHELL -l -c 'printf "%s\n" "$PATH"'` (with a
/// 5-second timeout) and caches the result. Subsequent calls return the
/// cached value instantly.
///
/// Returns `None` if `$SHELL` is unset, the probe times out, or the shell
/// exits with non-zero status.
pub fn shell_path() -> Option<&'static OsString> {
    SHELL_PATH.get_or_init(login_shell_path_probe).as_ref()
}

/// Build a PATH string that merges the login-shell PATH with the process PATH.
///
/// If the login shell probe succeeded, its PATH is used as the base with any
/// additional process-PATH entries appended (deduped). If it failed, the
/// process PATH is returned unchanged.
///
/// This ensures that both user-installed tools (from shell profile) and any
/// extra entries set by the launching context (e.g. Tauri dev server) are
/// available.
pub fn enriched_path() -> OsString {
    let process_path = std::env::var_os("PATH").unwrap_or_default();
    let Some(shell) = shell_path() else {
        return process_path;
    };

    // Start with shell PATH entries, then append any process-PATH entries
    // that aren't already present.
    let shell_dirs: Vec<std::path::PathBuf> = std::env::split_paths(shell).collect();
    let mut merged = shell.clone();

    for dir in std::env::split_paths(&process_path) {
        if !shell_dirs.contains(&dir) {
            merged.push(":");
            merged.push(dir);
        }
    }

    merged
}

/// Probe the login shell for its PATH.
///
/// Runs `$SHELL -l -c 'printf "%s\n" "$PATH"'` with a 5-second timeout.
/// For fish shells, uses `string join :` to convert the space-separated list.
///
/// If the shell prints startup output (motd, banner, etc.), only the last
/// non-empty line is used as the PATH value.
fn login_shell_path_probe() -> Option<OsString> {
    let shell = std::env::var("SHELL").ok()?;

    // Validate: must be an absolute path.
    if !shell.starts_with('/') {
        return None;
    }

    // Fish treats $PATH as a list and prints space-separated entries.
    let is_fish = shell.ends_with("/fish");
    let cmd_arg = if is_fish {
        r#"printf '%s\n' (string join : $PATH)"#
    } else {
        r#"printf '%s\n' "$PATH""#
    };

    let mut child = std::process::Command::new(&shell)
        .args(["-l", "-c", cmd_arg])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;

    // Wait up to 5 seconds. If the shell init hangs (nvm, pyenv, etc.),
    // kill the subprocess to avoid leaking a stuck process.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(_) => break None,
        }
    };

    let status = status?;
    if !status.success() {
        return None;
    }

    let mut stdout = String::new();
    if let Some(mut out) = child.stdout.take() {
        use std::io::Read;
        let _ = out.read_to_string(&mut stdout);
    }
    // Take the last non-empty line to skip any startup banner output.
    let path = stdout
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .map(|line| line.trim().to_string())?;
    if path.is_empty() {
        None
    } else {
        Some(OsString::from(path))
    }
}

/// Search for a command binary in the enriched PATH.
///
/// Uses `which::which_in` with the enriched PATH so that commands installed
/// in the user's shell profile are found even when the app is launched from
/// Finder.
pub fn which_in_enriched_path(command: &str) -> Result<std::path::PathBuf, which::Error> {
    let path = enriched_path();
    which::which_in(command, Some(path), Path::new("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enriched_path_includes_process_path() {
        let enriched = enriched_path();
        let enriched_str = enriched.to_string_lossy();
        // /usr/bin should always be present (from process or shell PATH).
        assert!(
            enriched_str.contains("/usr/bin"),
            "enriched PATH should contain /usr/bin"
        );
    }

    #[test]
    fn enriched_path_is_nonempty() {
        let enriched = enriched_path();
        assert!(!enriched.is_empty(), "enriched PATH must never be empty");
    }

    #[test]
    fn enriched_path_contains_no_empty_entries() {
        // Empty entries (::) can cause cwd-relative resolution — ensure
        // the merge logic doesn't produce them.
        let enriched = enriched_path();
        let enriched_str = enriched.to_string_lossy();
        assert!(
            !enriched_str.contains("::"),
            "enriched PATH must not contain empty entries (::)"
        );
    }

    #[test]
    fn which_in_enriched_path_finds_echo() {
        let result = which_in_enriched_path("echo");
        assert!(result.is_ok(), "should find `echo` in enriched PATH");
    }

    #[test]
    fn which_in_enriched_path_finds_sh() {
        let result = which_in_enriched_path("sh");
        assert!(result.is_ok(), "should find `sh` in enriched PATH");
    }

    #[test]
    fn which_in_enriched_path_rejects_missing_command() {
        let result = which_in_enriched_path("nonexistent_binary_xyz_12345");
        assert!(result.is_err(), "should not find a nonexistent command");
    }

    #[test]
    fn shell_path_returns_consistent_value() {
        // Calling shell_path twice must return the same cached reference.
        let first = shell_path();
        let second = shell_path();
        match (first, second) {
            (Some(a), Some(b)) => assert!(
                std::ptr::eq(a, b),
                "shell_path must return a cached reference"
            ),
            (None, None) => {} // Both None is fine (e.g. CI with no $SHELL)
            _ => panic!("shell_path returned inconsistent results"),
        }
    }
}
