//! Enriched environment for child processes.
//!
//! macOS apps launched from Finder inherit a minimal PATH
//! (`/usr/bin:/bin:/usr/sbin:/sbin`). Tools like `npx`, `node`, `python`,
//! and `claude` typically live in directories added by the user's shell
//! login profile (`.zprofile`, `.bash_profile`, `.profile`, etc.).
//!
//! This module probes the user's login shell once, caches the result, and
//! exposes it for subprocess spawning and PATH-based command lookup.
//!
//! It also defines [`WorkspaceEnv`], the set of `CLAUDETTE_*` environment
//! variables injected into every subprocess.

use std::ffi::OsString;
use std::path::Path;
use std::sync::OnceLock;
use crate::process::CommandWindowExt as _;

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
/// On Unix, the login shell is probed once (cached) and its PATH becomes the
/// base — this catches GUI-launched apps that don't inherit the user's shell
/// profile.
///
/// On Windows, we instead read the current `HKCU\Environment\Path` +
/// `HKLM\...\Environment\Path` from the registry on every call. That gives us
/// "fresh" PATH values after a `winget` / installer update without requiring
/// the user to log out and back in — the process env block we inherited at
/// launch is frozen, but the registry always reflects the current truth.
///
/// Process PATH is then appended (deduped) so any entries the launching
/// context added beyond the registry (e.g. Tauri dev server) are preserved.
pub fn enriched_path() -> OsString {
    let process_path = std::env::var_os("PATH").unwrap_or_default();

    let base = match base_path() {
        Some(p) => p,
        None => return process_path,
    };

    // Start with the base (login-shell on Unix, registry on Windows) and
    // append any non-empty process-PATH entries not already present.
    let mut merged_dirs: Vec<std::path::PathBuf> = std::env::split_paths(&base)
        .filter(|dir| !dir.as_os_str().is_empty())
        .collect();

    for dir in std::env::split_paths(&process_path) {
        if !dir.as_os_str().is_empty() && !merged_dirs.contains(&dir) {
            merged_dirs.push(dir);
        }
    }

    std::env::join_paths(&merged_dirs).unwrap_or(process_path)
}

#[cfg(unix)]
fn base_path() -> Option<OsString> {
    shell_path().cloned()
}

#[cfg(windows)]
fn base_path() -> Option<OsString> {
    windows_registry_path()
}

/// Read the current `Path` value from `HKCU\Environment` +
/// `HKLM\...\Environment`, expand any `%VAR%` references against the current
/// process env, and return the merged string.
///
/// We do NOT cache this — the whole point is to see changes made after
/// claudette started (winget installs, user edits via System Properties).
/// The cost is two registry reads + string operations, which is
/// sub-millisecond and only runs on subprocess-spawn paths.
///
/// Returns `None` only when both keys fail to open (pathological state; we
/// fall back to the frozen process PATH in that case).
#[cfg(windows)]
pub fn windows_registry_path() -> Option<OsString> {
    use winreg::RegKey;
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);

    // Machine PATH first, user PATH after — matches how Windows itself
    // builds the effective PATH when a new session starts.
    let machine = hklm
        .open_subkey(r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment")
        .and_then(|k| k.get_value::<String, _>("Path"))
        .ok();
    let user = hkcu
        .open_subkey("Environment")
        .and_then(|k| k.get_value::<String, _>("Path"))
        .ok();

    if machine.is_none() && user.is_none() {
        return None;
    }

    let combined = match (machine, user) {
        (Some(m), Some(u)) if !u.is_empty() => format!("{m};{u}"),
        (Some(m), _) => m,
        (None, Some(u)) => u,
        (None, None) => unreachable!(),
    };

    Some(OsString::from(expand_env_vars_windows(&combined)))
}

/// Expand `%VAR%` placeholders against the current process env.
/// Case-insensitive match on the var name (Windows convention). Unknown
/// placeholders are left as-is so the string is still usable for diagnosis.
#[cfg(windows)]
fn expand_env_vars_windows(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if let Some(end) = bytes[i + 1..].iter().position(|&b| b == b'%') {
                let name = &input[i + 1..i + 1 + end];
                // Case-insensitive lookup — Windows env-var names are
                // case-insensitive so `%PATH%` and `%Path%` must resolve
                // the same way.
                let matched = std::env::vars_os().find_map(|(k, v)| {
                    if k.to_string_lossy().eq_ignore_ascii_case(name) {
                        Some(v)
                    } else {
                        None
                    }
                });
                match matched {
                    Some(v) => out.push_str(&v.to_string_lossy()),
                    None => {
                        // Unknown var — leave the original `%NAME%` in place.
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                i += 1 + end + 1;
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
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

    let mut child = std::process::Command::new(&shell).no_console_window()
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

// ---------------------------------------------------------------------------
// WorkspaceEnv — CLAUDETTE_* environment variables
// ---------------------------------------------------------------------------

/// The set of `CLAUDETTE_*` environment variables injected into every
/// subprocess that Claudette spawns (terminals, setup scripts, agent,
/// notification commands). Mirrors the `CONDUCTOR_*` env var convention.
#[derive(Debug, Clone)]
pub struct WorkspaceEnv {
    pub workspace_name: String,
    pub workspace_id: String,
    pub workspace_path: String,
    pub root_path: String,
    pub default_branch: String,
    pub branch_name: String,
}

impl WorkspaceEnv {
    /// Build from a workspace, its repo path, and the resolved default branch.
    pub fn from_workspace(
        ws: &crate::model::Workspace,
        repo_path: &str,
        default_branch: String,
    ) -> Self {
        Self {
            workspace_name: ws.name.clone(),
            workspace_id: ws.id.clone(),
            workspace_path: ws.worktree_path.clone().unwrap_or_default(),
            root_path: repo_path.to_string(),
            default_branch,
            branch_name: ws.branch_name.clone(),
        }
    }

    /// Return the 6 env var key-value pairs.  Useful for command builders
    /// that don't implement `std::process::Command`'s API (e.g. portable-pty).
    pub fn vars(&self) -> [(&str, &str); 6] {
        [
            ("CLAUDETTE_WORKSPACE_NAME", &self.workspace_name),
            ("CLAUDETTE_WORKSPACE_ID", &self.workspace_id),
            ("CLAUDETTE_WORKSPACE_PATH", &self.workspace_path),
            ("CLAUDETTE_ROOT_PATH", &self.root_path),
            ("CLAUDETTE_DEFAULT_BRANCH", &self.default_branch),
            ("CLAUDETTE_BRANCH_NAME", &self.branch_name),
        ]
    }

    /// Apply env vars to a `tokio::process::Command`.
    pub fn apply(&self, cmd: &mut tokio::process::Command) {
        for (k, v) in self.vars() {
            cmd.env(k, v);
        }
    }

    /// Apply env vars to a `std::process::Command`.
    pub fn apply_std(&self, cmd: &mut std::process::Command) {
        for (k, v) in self.vars() {
            cmd.env(k, v);
        }
    }
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

    fn sample_env() -> WorkspaceEnv {
        WorkspaceEnv {
            workspace_name: "fix-auth-bug".into(),
            workspace_id: "abc-123".into(),
            workspace_path: "/tmp/worktrees/repo/fix-auth-bug".into(),
            root_path: "/home/user/repo".into(),
            default_branch: "main".into(),
            branch_name: "claudette/fix-auth-bug".into(),
        }
    }

    #[test]
    fn vars_returns_all_six_pairs() {
        let env = sample_env();
        let vars = env.vars();
        assert_eq!(vars.len(), 6);
        assert_eq!(vars[0], ("CLAUDETTE_WORKSPACE_NAME", "fix-auth-bug"));
        assert_eq!(vars[1], ("CLAUDETTE_WORKSPACE_ID", "abc-123"));
        assert_eq!(
            vars[2],
            (
                "CLAUDETTE_WORKSPACE_PATH",
                "/tmp/worktrees/repo/fix-auth-bug"
            )
        );
        assert_eq!(vars[3], ("CLAUDETTE_ROOT_PATH", "/home/user/repo"));
        assert_eq!(vars[4], ("CLAUDETTE_DEFAULT_BRANCH", "main"));
        assert_eq!(vars[5], ("CLAUDETTE_BRANCH_NAME", "claudette/fix-auth-bug"));
    }

    #[test]
    fn apply_std_sets_env_on_command() {
        let env = sample_env();
        let mut cmd = std::process::Command::new("echo");
        cmd.no_console_window();
        env.apply_std(&mut cmd);

        let envs: Vec<_> = cmd.get_envs().collect();
        assert!(envs.contains(&(
            std::ffi::OsStr::new("CLAUDETTE_WORKSPACE_NAME"),
            Some(std::ffi::OsStr::new("fix-auth-bug"))
        )));
        assert!(envs.contains(&(
            std::ffi::OsStr::new("CLAUDETTE_ROOT_PATH"),
            Some(std::ffi::OsStr::new("/home/user/repo"))
        )));
    }

    // -----------------------------------------------------------------------
    // Windows env-var expansion tests
    // -----------------------------------------------------------------------
    //
    // The registry stores PATH entries like `%SystemRoot%\System32`
    // unexpanded (REG_EXPAND_SZ). Since Rust's `std::env::split_paths`
    // does not expand `%VAR%` references, we have to do it ourselves
    // before handing the value back. These tests exercise the corner
    // cases of that hand-rolled expander without requiring a real
    // Windows environment.

    /// Bare strings with no `%VAR%` references must pass through byte-for-
    /// byte — that's the overwhelmingly common case on most machines.
    #[cfg(windows)]
    #[test]
    fn expand_passthrough_without_vars() {
        assert_eq!(
            expand_env_vars_windows(r"C:\Windows;C:\Users\user\.local\bin"),
            r"C:\Windows;C:\Users\user\.local\bin"
        );
    }

    /// A defined env var must be substituted. We lean on `SystemRoot`,
    /// which is guaranteed to exist on any real Windows session that
    /// could reach this code.
    #[cfg(windows)]
    #[test]
    fn expand_replaces_defined_var() {
        let system_root = std::env::var("SystemRoot")
            .expect("SystemRoot must be defined in a Windows test env");
        let expanded = expand_env_vars_windows(r"%SystemRoot%\System32");
        assert_eq!(expanded, format!(r"{system_root}\System32"));
    }

    /// Case-insensitive match: Windows env-var names are not
    /// case-sensitive, so `%systemroot%` and `%SystemRoot%` must resolve
    /// to the same value.
    #[cfg(windows)]
    #[test]
    fn expand_is_case_insensitive() {
        let upper = expand_env_vars_windows(r"%SYSTEMROOT%\System32");
        let lower = expand_env_vars_windows(r"%systemroot%\System32");
        assert_eq!(upper, lower);
    }

    /// An unknown var must be left as-is rather than turning into an
    /// empty string — a user reading the resolved PATH should still be
    /// able to see *which* var failed to resolve.
    #[cfg(windows)]
    #[test]
    fn expand_leaves_unknown_var_intact() {
        let nonce = "CLAUDETTE_TEST_NONEXISTENT_VAR_XYZ_9876";
        // Safety: the env-var name is unique to this test so clearing
        // it is guaranteed not to race with other tests.
        // (And we don't rely on any prior value.)
        let out = expand_env_vars_windows(&format!(r"prefix;%{nonce}%;suffix"));
        assert_eq!(out, format!(r"prefix;%{nonce}%;suffix"));
    }

    /// A lone `%` at end-of-string is not a var reference and must be
    /// preserved. Without this guard the expander could read past the
    /// input or emit empty output.
    #[cfg(windows)]
    #[test]
    fn expand_tolerates_unmatched_percent() {
        assert_eq!(expand_env_vars_windows(r"C:\foo%"), r"C:\foo%");
    }
}
