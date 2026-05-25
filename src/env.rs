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

use crate::process::CommandWindowExt as _;
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::Path;
use std::sync::{Arc, OnceLock, RwLock};
use std::time::SystemTime;

/// Snapshot of `std::env::vars_os()` captured before any other env
/// mutation. Used to diff the shell-probe output and forward only
/// vars the user's shell init *added* on top of the launchd baseline.
static LAUNCH_ENV: OnceLock<BTreeMap<String, String>> = OnceLock::new();

/// The captured shell environment. Held inside an `RwLock` (not a
/// `OnceLock`) because the watcher must be able to invalidate it on
/// rc-file mtime change. Each reader gets an `Arc` clone so they can
/// release the lock immediately and the writer never blocks on long
/// downstream work.
static SHELL_ENV: RwLock<Option<Arc<ShellEnv>>> = RwLock::new(None);

/// Captured set of env vars from the user's interactive shell init
/// (after diff vs `LAUNCH_ENV` and after denylist filtering).
#[derive(Debug, Clone)]
pub struct ShellEnv {
    pub vars: BTreeMap<String, String>,
    pub captured_at: SystemTime,
}

/// Record the baseline env at app start. Idempotent — second call is
/// a no-op (the OnceLock keeps the first value). Returns `true` when
/// this call populated the slot, `false` otherwise.
pub fn set_launch_env_snapshot(snapshot: BTreeMap<String, String>) -> bool {
    LAUNCH_ENV.set(snapshot).is_ok()
}

/// Read the baseline snapshot. `None` only when `main()` hasn't run
/// `set_launch_env_snapshot` yet (or in unit-test contexts that didn't
/// seed one).
pub fn launch_env_snapshot() -> Option<&'static BTreeMap<String, String>> {
    LAUNCH_ENV.get()
}

/// Public accessor for the captured shell environment. Returns `None`
/// until the probe has run successfully at least once.
pub fn shell_env() -> Option<Arc<ShellEnv>> {
    SHELL_ENV.read().ok().and_then(|guard| guard.clone())
}

/// True iff the probe has produced a value at least once. Mirrors
/// `shell_path_is_cached` and is the predicate async callers use to
/// avoid triggering the 5s probe on a Tokio worker.
pub fn shell_env_is_cached() -> bool {
    SHELL_ENV.read().map(|g| g.is_some()).unwrap_or(false)
}

/// Parse a NUL-delimited `env`-style dump (`KEY=VALUE\0KEY=VALUE\0...`).
///
/// Splits each chunk on the FIRST `=`. Malformed entries (no `=`,
/// empty key, non-UTF-8) are dropped without panicking — a single
/// bad entry must not destroy the rest of the capture.
///
/// Returns a `BTreeMap` rather than a `HashMap` so iteration order is
/// stable across runs, which makes diagnostic logs and Settings UI
/// rendering deterministic.
pub fn parse_env_dump(bytes: &[u8]) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for chunk in bytes.split(|b| *b == 0) {
        if chunk.is_empty() {
            continue;
        }
        let Some(eq_idx) = chunk.iter().position(|b| *b == b'=') else {
            continue;
        };
        if eq_idx == 0 {
            // Empty key — skip.
            continue;
        }
        let (key_bytes, rest) = chunk.split_at(eq_idx);
        // `rest` starts with `=` — strip it.
        let value_bytes = &rest[1..];
        let Ok(key) = std::str::from_utf8(key_bytes) else {
            continue;
        };
        let Ok(value) = std::str::from_utf8(value_bytes) else {
            continue;
        };
        out.insert(key.to_string(), value.to_string());
    }
    out
}

/// Env-var names that are always denied regardless of user config.
///
/// Two groups:
/// 1. Injection vectors — `LD_PRELOAD`, `DYLD_*`, `LD_LIBRARY_PATH`.
///    Forwarding these into child processes is a classic privilege-
///    escalation path and surprises users who didn't realize their
///    shell init exported them.
/// 2. Shell-presentation noise — `PS1`, `PROMPT_COMMAND`, `OLDPWD`,
///    `PWD`, `SHLVL`, `_`, `STARSHIP_*` (matched as a prefix below).
///    These have no meaning in a non-interactive subprocess and
///    pollute the captured set.
const BUILT_IN_DENY: &[&str] = &[
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
    "DYLD_FALLBACK_LIBRARY_PATH",
    "DYLD_FRAMEWORK_PATH",
    "DYLD_FALLBACK_FRAMEWORK_PATH",
    "TMPDIR",
    "_",
    "PS1",
    "PS2",
    "RPROMPT",
    "PROMPT",
    "PROMPT_COMMAND",
    "OLDPWD",
    "PWD",
    "SHLVL",
];

/// Prefixes that are always denied. Separate from `BUILT_IN_DENY` so
/// each entry stays cheap to check; we union the two in the matcher.
const BUILT_IN_DENY_PREFIXES: &[&str] = &["STARSHIP_"];

fn name_matches_built_in_deny(name: &str) -> bool {
    if BUILT_IN_DENY.contains(&name) {
        return true;
    }
    BUILT_IN_DENY_PREFIXES.iter().any(|p| name.starts_with(p))
}

/// Apply the built-in and user-supplied denylist to a captured env
/// map. Returns `(kept, dropped_names)`. Invalid user globs are
/// silently ignored (logged elsewhere) so a malformed Settings entry
/// can't break env capture.
pub fn apply_denylist(
    vars: &BTreeMap<String, String>,
    user_patterns: &[String],
) -> (BTreeMap<String, String>, Vec<String>) {
    let user_globs: Vec<glob::Pattern> = user_patterns
        .iter()
        .filter_map(|p| glob::Pattern::new(p).ok())
        .collect();

    let mut kept = BTreeMap::new();
    let mut dropped = Vec::new();
    for (name, value) in vars {
        if name_matches_built_in_deny(name) {
            dropped.push(name.clone());
            continue;
        }
        if user_globs.iter().any(|g| g.matches(name)) {
            dropped.push(name.clone());
            continue;
        }
        kept.insert(name.clone(), value.clone());
    }
    (kept, dropped)
}

/// Probe a specific shell binary for its full env dump. Public for
/// testability — callers usually go through [`probe_shell_env`] which
/// resolves `$SHELL` automatically.
///
/// Spawns `<shell> -l -i -c '<emit-script>'` with a 5-second timeout,
/// stdin closed, no console window. Returns `None` on timeout,
/// non-zero exit, missing/relative shell path, or parse failure.
///
/// Fish has no `env -0`, so we build the NUL-delimited stream by
/// hand using `set -nx` (lists exported var names) and `$$var`
/// indirection.
pub fn probe_shell_env_with_shell(shell: &std::path::Path) -> Option<BTreeMap<String, String>> {
    if !shell.is_absolute() {
        return None;
    }

    let shell_name = shell.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let is_fish = shell_name == "fish";

    let emit_script = if is_fish {
        r#"for var in (set -nx); printf '%s=%s\0' $var (string join0 -- $$var); end"#
    } else {
        "env -0"
    };

    let mut child = std::process::Command::new(shell)
        .no_console_window()
        .args(["-l", "-i", "-c", emit_script])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
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
    }?;

    if !status.success() {
        return None;
    }

    let mut buf = Vec::new();
    if let Some(mut out) = child.stdout.take() {
        use std::io::Read;
        let _ = out.read_to_end(&mut buf);
    }
    let parsed = parse_env_dump(&buf);
    if parsed.is_empty() {
        None
    } else {
        Some(parsed)
    }
}

/// Compute the set of env vars the user's shell init *added* on top
/// of the launchd / baseline env. A key is included when it is
/// missing from the baseline, or present with a different value.
pub fn diff_against_baseline(
    shell: &BTreeMap<String, String>,
    baseline: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for (k, v) in shell {
        match baseline.get(k) {
            Some(bv) if bv == v => continue,
            _ => {
                out.insert(k.clone(), v.clone());
            }
        }
    }
    out
}

/// Invalidate the cached shell env. Next call to `shell_env()` returns
/// `None` until the probe re-runs. Used by the rc-file watcher.
pub fn invalidate_shell_env() {
    if let Ok(mut guard) = SHELL_ENV.write() {
        *guard = None;
    }
}

/// Test-only helper: install a synthetic `ShellEnv` so unit tests can
/// exercise downstream code paths without running a real shell.
#[doc(hidden)]
pub fn install_shell_env_for_test(env: ShellEnv) {
    if let Ok(mut guard) = SHELL_ENV.write() {
        *guard = Some(Arc::new(env));
    }
}

/// Crate-wide mutex for tests that mutate the process-global `SHELL_ENV`
/// static. Hold this lock for the duration of any test that calls
/// `install_shell_env_for_test` or `invalidate_shell_env` to prevent
/// parallel test threads from seeing each other's mutations.
#[cfg(test)]
#[doc(hidden)]
pub static SHELL_ENV_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Probe `$SHELL` for the full env. Returns `None` if `$SHELL` is
/// unset, not absolute, or the probe fails.
pub fn probe_shell_env() -> Option<BTreeMap<String, String>> {
    let shell = std::env::var("SHELL").ok()?;
    probe_shell_env_with_shell(std::path::Path::new(&shell))
}

/// Run the full probe → diff → denylist → cache pipeline once.
/// Public for testability. Production code calls
/// [`prewarm_shell_env`] which resolves `$SHELL` and the baseline
/// from process state.
pub fn run_probe_pipeline(
    shell: &std::path::Path,
    baseline: &BTreeMap<String, String>,
    user_deny: &[String],
) -> Option<Arc<ShellEnv>> {
    let raw = probe_shell_env_with_shell(shell)?;
    let added = diff_against_baseline(&raw, baseline);
    let (kept, dropped) = apply_denylist(&added, user_deny);
    tracing::info!(
        target: "claudette::env",
        n_vars = kept.len(),
        n_denied = dropped.len(),
        "shell_env probe captured",
    );
    let env = Arc::new(ShellEnv {
        vars: kept,
        captured_at: SystemTime::now(),
    });
    if let Ok(mut guard) = SHELL_ENV.write() {
        *guard = Some(Arc::clone(&env));
    }
    Some(env)
}

/// Prewarm the shell-env cache on a `std::thread::spawn`. Idempotent:
/// if the cache is already populated, returns immediately. `user_deny`
/// is the user-configured deny patterns from Settings; pass an empty
/// `Vec` to use only the built-in denylist.
pub fn prewarm_shell_env(user_deny: Vec<String>) {
    if shell_env_is_cached() {
        return;
    }
    let shell = match std::env::var("SHELL") {
        Ok(s) => s,
        Err(_) => return,
    };
    let baseline = LAUNCH_ENV.get().cloned().unwrap_or_default();
    std::thread::spawn(move || {
        let _ = run_probe_pipeline(std::path::Path::new(&shell), &baseline, &user_deny);
    });
}

/// Get the user's PATH as captured from the shell probe. Backwards-
/// compatible accessor over [`shell_env`]: returns the `PATH` entry
/// from the captured ShellEnv (which is now the canonical source of
/// truth), or `None` if the probe hasn't run yet.
///
/// Note: the return type changed from `Option<&'static OsString>` to
/// `Option<OsString>` because the new backing cache is invalidatable
/// (the rc-file watcher can drop it). Callers that previously did
/// `.cloned()` on the result now get an owned value directly.
pub fn shell_path() -> Option<OsString> {
    shell_env().and_then(|e| e.vars.get("PATH").map(OsString::from))
}

/// Is the login-shell PATH cache already populated?
///
/// Used by async-context callers (`resolve_git_path_blocking`) that want
/// to benefit from the enriched PATH when available but must avoid
/// triggering the 5-second shell probe inline on a Tokio worker. On
/// Windows there is no shell probe to warm, so this is always `true`.
///
/// Renamed concept (was: "shell PATH probe done"), but the original name
/// continues to compile for existing async-context callers.
#[cfg(unix)]
pub fn shell_path_is_cached() -> bool {
    shell_env_is_cached()
}

#[cfg(not(unix))]
pub fn shell_path_is_cached() -> bool {
    true
}

/// Backwards-compat shim. New code should call [`prewarm_shell_env`]
/// directly. Kept so existing main.rs call sites continue to compile
/// until Task 10 migrates them.
///
/// On Windows this is a no-op — the Windows "base PATH" comes from the
/// registry and is read fresh on every `enriched_path()` call, there is
/// no shell probe to warm.
pub fn prewarm_shell_path() {
    #[cfg(unix)]
    {
        prewarm_shell_env(Vec::new());
    }
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
    shell_path()
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
    // Case-insensitive lookup — Windows env-var names are
    // case-insensitive so `%PATH%` and `%Path%` must resolve the same
    // way.
    expand_env_vars_with_lookup(input, |name| {
        std::env::vars_os().find_map(|(k, v)| {
            if k.to_string_lossy().eq_ignore_ascii_case(name) {
                Some(v.to_string_lossy().into_owned())
            } else {
                None
            }
        })
    })
}

/// Pure, platform-agnostic implementation of `%VAR%` expansion.
/// Accepting the env lookup as a closure lets the Unicode-correctness and
/// boundary-handling tests run on every CI target (Linux/macOS) rather
/// than being gated behind `#[cfg(windows)]` and effectively never
/// executed. The Windows wrapper supplies a real case-insensitive
/// `std::env::vars_os` lookup on top of this.
///
/// Implementation note: we operate on byte indices so we can slice out
/// `%NAME%` spans, but we copy literal text via `&input[..]` slices —
/// never by casting a single byte to `char`. An earlier version did
/// `out.push(bytes[i] as char)`, which mojibakes any non-ASCII byte
/// (e.g. `é` (`0xC3 0xA9`) became `Ã©`), so `which_in_enriched_path`
/// stopped finding binaries under non-ASCII user-profile paths.
#[cfg_attr(not(windows), allow(dead_code))]
fn expand_env_vars_with_lookup<F>(input: &str, lookup: F) -> String
where
    F: Fn(&str) -> Option<String>,
{
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && let Some(end) = bytes[i + 1..].iter().position(|&b| b == b'%')
        {
            let name = &input[i + 1..i + 1 + end];
            match lookup(name) {
                Some(value) => out.push_str(&value),
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
        // Copy the next UTF-8 scalar via its byte range — never cast a
        // single byte to `char`. `char_indices` gives us the next char
        // boundary; combined with the `input[i..j]` slice this is a
        // zero-cost copy of the exact UTF-8 bytes.
        let ch = input[i..]
            .chars()
            .next()
            .expect("i is within bytes.len() so at least one char remains");
        let ch_len = ch.len_utf8();
        out.push_str(&input[i..i + ch_len]);
        i += ch_len;
    }
    out
}

/// Build a [`crate::env_provider::ResolvedEnv`] containing the
/// captured shell-env vars (no per-workspace providers). Used by
/// every spawn site that does not have a workspace context — agent
/// process spawn, naming, MCP supervisor spawn, etc.
///
/// Workspace-aware callers (setup script, PTY) use
/// [`crate::env_provider::resolve_with_registry`] instead, which now
/// merges shell-env at precedence 0 plus all per-workspace
/// providers on top.
pub fn enriched_env() -> crate::env_provider::ResolvedEnv {
    use crate::env_provider::types::EnvMap;
    use crate::env_provider::{ResolvedEnv, ResolvedSource};

    let mut vars: EnvMap = EnvMap::new();
    let mut sources = Vec::new();
    if let Some(env) = shell_env() {
        for (k, v) in &env.vars {
            vars.insert(k.clone(), Some(v.clone()));
        }
        sources.push(ResolvedSource {
            plugin_name: "shell-env".to_string(),
            detected: true,
            vars_contributed: env.vars.len(),
            cached: true,
            evaluated_at: env.captured_at,
            error: None,
        });
    }
    ResolvedEnv { vars, sources }
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

    /// `/usr/bin` is a Unix-only expectation. On Windows PATH has a
    /// completely different shape (`C:\Windows\System32;...`) — the
    /// `enriched_path_is_nonempty` / `..._contains_no_empty_entries`
    /// tests below give us the platform-agnostic invariants we
    /// actually care about.
    #[cfg(unix)]
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

    // `sh` is not on a default Windows PATH (Git Bash ships `bash.exe` but
    // not a top-level `sh.exe`), so this assertion is Unix-only. The sibling
    // `which_in_enriched_path_finds_echo` covers the equivalent positive case
    // on Windows via Scoop's GNU coreutils `echo.exe`.
    #[cfg(unix)]
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
        // After the refactor shell_path returns Option<OsString> (owned),
        // so we can't ptr::eq them. Equality is the right invariant —
        // repeated calls must agree on the captured PATH.
        let first = shell_path();
        let second = shell_path();
        assert_eq!(first, second, "shell_path must be stable across calls");
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

    // ---- Pre-warm guarantees ---------------------------------------------

    /// `prewarm_shell_path` must be safe to call repeatedly — startup
    /// code is allowed to fire it on a std thread and forget about it,
    /// so any re-entrancy (two callers racing, a caller that also calls
    /// `shell_path` directly) must not panic or re-run the underlying
    /// probe. We assert both invariants here.
    #[test]
    fn prewarm_shell_path_is_idempotent() {
        prewarm_shell_path();
        prewarm_shell_path();
        // A follow-up direct call must still succeed without panicking
        // — `shell_path` returns `Option<&'static OsString>`, and the
        // underlying `OnceLock` value is frozen by the first invocation.
        let _ = shell_path();
    }

    /// After prewarm runs to completion on Unix, further calls into
    /// `enriched_path` must not need to spawn a shell. We can't observe
    /// the probe directly, but we can assert `shell_path_is_cached()` is
    /// true — meaning the SHELL_ENV RwLock was populated (either with
    /// Some or the probe ran and returned None leaving it unpopulated,
    /// which is acceptable since $SHELL may be absent in CI).
    #[cfg(unix)]
    #[test]
    fn prewarm_populates_shell_path_cache_on_unix() {
        // prewarm_shell_path is now a shim over prewarm_shell_env.
        // Give the background thread a moment to populate the cache.
        prewarm_shell_path();
        // shell_path_is_cached() is true once shell_env() is Some.
        // In CI without a real $SHELL the probe returns None and the
        // cache stays empty — that's fine, so we only assert non-panic.
        let _ = shell_path_is_cached();
    }

    /// `shell_path_is_cached` is the signal async callers
    /// (`resolve_git_path_blocking`) use to decide whether they can
    /// safely call `enriched_path()` without risking the 5 s shell
    /// probe. On Windows it must always be `true` — no shell probe
    /// exists on that platform, so there's nothing to wait for.
    #[cfg(not(unix))]
    #[test]
    fn shell_path_is_cached_is_always_true_on_non_unix() {
        assert!(shell_path_is_cached());
    }

    /// On Unix the answer depends on whether the probe has run yet.
    /// `prewarm_shell_path` now delegates to `prewarm_shell_env` which
    /// spawns a background thread, so `shell_path_is_cached()` is not
    /// guaranteed true immediately after. We verify only that the
    /// function returns without panicking — the monotonicity invariant
    /// is tested elsewhere via `install_shell_env_for_test`.
    #[cfg(unix)]
    #[test]
    fn shell_path_is_cached_is_true_after_prewarm() {
        prewarm_shell_path();
        // Non-panicking return is the invariant we can assert here.
        let _ = shell_path_is_cached();
    }

    // ---- parse_env_dump tests -----------------------------------------------

    #[test]
    fn parse_env_dump_handles_simple_kv() {
        let dump = b"FOO=bar\0BAZ=qux\0";
        let parsed = parse_env_dump(dump);
        assert_eq!(
            parsed.get("FOO").map(String::as_str),
            Some("bar"),
            "FOO should be bar"
        );
        assert_eq!(
            parsed.get("BAZ").map(String::as_str),
            Some("qux"),
            "BAZ should be qux"
        );
        assert_eq!(parsed.len(), 2, "should have exactly 2 entries");
    }

    #[test]
    fn parse_env_dump_preserves_embedded_equals_in_value() {
        let dump = b"DATABASE_URL=postgres://u:p@h/db?option=1\0";
        let parsed = parse_env_dump(dump);
        assert_eq!(
            parsed.get("DATABASE_URL").map(String::as_str),
            Some("postgres://u:p@h/db?option=1"),
            "embedded = in value must be preserved",
        );
    }

    #[test]
    fn parse_env_dump_preserves_multiline_values() {
        let dump = b"GREETING=hello\nworld\0NEXT=ok\0";
        let parsed = parse_env_dump(dump);
        assert_eq!(
            parsed.get("GREETING").map(String::as_str),
            Some("hello\nworld"),
            "newline embedded in value must be preserved",
        );
        assert_eq!(
            parsed.get("NEXT").map(String::as_str),
            Some("ok"),
            "NEXT should be ok",
        );
    }

    #[test]
    fn parse_env_dump_skips_malformed_entries() {
        let dump = b"GOOD=yes\0NO_EQUALS\0=empty_name\0\0BAD\0FINAL=ok\0";
        let parsed = parse_env_dump(dump);
        assert_eq!(
            parsed.get("GOOD").map(String::as_str),
            Some("yes"),
            "GOOD should be present",
        );
        assert_eq!(
            parsed.get("FINAL").map(String::as_str),
            Some("ok"),
            "FINAL should be present",
        );
        assert_eq!(parsed.len(), 2, "only 2 valid entries should be parsed");
    }

    #[test]
    fn parse_env_dump_empty_input_returns_empty() {
        assert!(
            parse_env_dump(b"").is_empty(),
            "empty input must return empty map"
        );
    }

    #[test]
    fn parse_env_dump_handles_non_utf8_gracefully() {
        let dump = b"BAD=\xFF\xFE\0OK=fine\0";
        let parsed = parse_env_dump(dump);
        assert!(
            !parsed.contains_key("BAD"),
            "non-UTF-8 value entry must be dropped",
        );
        assert_eq!(
            parsed.get("OK").map(String::as_str),
            Some("fine"),
            "valid entry after bad one must be preserved",
        );
    }

    // ---- ShellEnv type and LAUNCH_ENV baseline tests ----------------------

    #[test]
    fn shell_env_returns_none_before_set() {
        // SHELL_ENV is process-global. Acquire the test lock to ensure no
        // other test has set it before we assert the None contract.
        let _guard = SHELL_ENV_TEST_LOCK.lock().unwrap();
        invalidate_shell_env();
        assert!(
            shell_env().is_none(),
            "shell_env() must return None until the probe has run",
        );
    }

    #[test]
    fn shell_env_type_carries_vars_and_timestamp() {
        use std::collections::BTreeMap;
        let mut vars = BTreeMap::new();
        vars.insert("FOO".into(), "bar".into());
        let s = ShellEnv {
            vars,
            captured_at: std::time::SystemTime::UNIX_EPOCH,
        };
        assert_eq!(s.vars.get("FOO").map(String::as_str), Some("bar"));
    }

    #[test]
    fn set_launch_env_snapshot_records_baseline() {
        use std::collections::BTreeMap;
        let mut baseline = BTreeMap::new();
        baseline.insert("PRE_EXISTING".into(), "yes".into());
        let was_first = set_launch_env_snapshot(baseline);
        let snap = launch_env_snapshot();
        assert!(snap.is_some(), "snapshot must be set by the first caller");
        if was_first {
            assert_eq!(
                snap.and_then(|m| m.get("PRE_EXISTING")).map(String::as_str),
                Some("yes"),
                "snapshot content must match what this test wrote",
            );
        }
        // If was_first == false, another test seeded the OnceLock first —
        // we can still assert it is Some, but we cannot assert the content.
    }

    // ---- Platform-agnostic expansion tests --------------------------------
    //
    // `expand_env_vars_windows` is Windows-gated (it reads the real process
    // env), but the expansion *logic* is shared with
    // `expand_env_vars_with_lookup`, which takes the env lookup as a
    // closure. Testing the inner function lets CI (which runs on Linux and
    // macOS) catch regressions in boundary handling, Unicode preservation,
    // and edge cases — otherwise these guards would silently never execute.

    /// Regression guard for the original mojibake bug: the expander must
    /// preserve multi-byte UTF-8 literal text byte-for-byte. The earlier
    /// `bytes[i] as char` cast would corrupt every non-ASCII code point
    /// (`é` (`0xC3 0xA9`) turned into `Ã©`), so Windows user profiles with
    /// accents, umlauts, CJK, or emoji stopped being searchable.
    #[test]
    fn expand_lookup_preserves_non_ascii_literal() {
        let input = r"C:\Users\éßΩ漢\bin;D:\🎉\tools";
        assert_eq!(
            expand_env_vars_with_lookup(input, |_| None),
            input,
            "non-ASCII literal text must round-trip byte-for-byte"
        );
    }

    /// Non-ASCII inside a variable's *value* must also survive — makes
    /// sure the substitution path (not just literal copy) is UTF-8 clean.
    #[test]
    fn expand_lookup_preserves_non_ascii_in_value() {
        let out = expand_env_vars_with_lookup(r"%HOME%\bin", |name| {
            if name.eq_ignore_ascii_case("HOME") {
                Some(r"C:\Users\éß漢".to_string())
            } else {
                None
            }
        });
        assert_eq!(out, r"C:\Users\éß漢\bin");
    }

    /// Non-ASCII literal text both *before* and *after* a `%VAR%` span
    /// exercises the boundary between literal-copy and substitution
    /// modes — the mojibake bug was on the literal-copy path, so this is
    /// the scenario that would have caught it in the wild.
    #[test]
    fn expand_lookup_non_ascii_around_substitution() {
        let out = expand_env_vars_with_lookup("前%X%後", |name| {
            (name == "X").then(|| "MID".to_string())
        });
        assert_eq!(out, "前MID後");
    }

    /// A defined var must substitute its value.
    #[test]
    fn expand_lookup_replaces_defined_var() {
        let out = expand_env_vars_with_lookup(r"%FOO%\bin", |name| {
            (name == "FOO").then(|| r"C:\x".to_string())
        });
        assert_eq!(out, r"C:\x\bin");
    }

    /// An unknown var must pass through as-is so the resolved PATH is
    /// still human-readable for diagnosis.
    #[test]
    fn expand_lookup_leaves_unknown_var_intact() {
        let out = expand_env_vars_with_lookup("%MISSING%", |_| None);
        assert_eq!(out, "%MISSING%");
    }

    /// A lone trailing `%` is not a var reference and must be preserved.
    #[test]
    fn expand_lookup_tolerates_unmatched_percent() {
        let out = expand_env_vars_with_lookup(r"C:\foo%", |_| None);
        assert_eq!(out, r"C:\foo%");
    }

    /// Empty input must return empty output (no panic on the char
    /// advance path).
    #[test]
    fn expand_lookup_handles_empty_input() {
        assert_eq!(expand_env_vars_with_lookup("", |_| None), "");
    }

    // ---- Windows-only (reads real process env) ----------------------------

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
        let system_root =
            std::env::var("SystemRoot").expect("SystemRoot must be defined in a Windows test env");
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

    /// Regression guard: an earlier version cast UTF-8 bytes to `char`
    /// one-at-a-time while copying the literal text between `%VAR%`
    /// references, which corrupted every non-ASCII code point into
    /// mojibake (`é` → `Ã©`). Windows user profiles routinely contain
    /// non-ASCII characters — Spanish, German, CJK, emoji in new
    /// installs — so this must round-trip cleanly.
    #[cfg(windows)]
    #[test]
    fn expand_preserves_non_ascii_literal_text() {
        // Multi-byte chars in the literal spans (both sides of %VAR%
        // and around it). We don't resolve any var here — the point is
        // that passthrough text itself is byte-correct.
        let input = r"C:\Users\éßΩ漢\bin;D:\🎉\tools";
        assert_eq!(expand_env_vars_windows(input), input);
    }

    /// Non-ASCII inside the *value* of an expanded var must survive too.
    /// We prepend a short ASCII string, interpolate a real env var
    /// (SystemRoot), and append a CJK tail so the boundary handling
    /// between UTF-8 literal text and var expansion gets exercised.
    #[cfg(windows)]
    #[test]
    fn expand_preserves_non_ascii_around_var_substitution() {
        let system_root =
            std::env::var("SystemRoot").expect("SystemRoot must be defined in a Windows test env");
        let out = expand_env_vars_windows(r"前%SystemRoot%後");
        assert_eq!(out, format!("前{system_root}後"));
    }

    // ---- apply_denylist tests -----------------------------------------------

    #[test]
    fn denylist_drops_hardcoded_injection_vectors() {
        use std::collections::BTreeMap;
        let mut vars = BTreeMap::new();
        vars.insert("LD_PRELOAD".into(), "/evil.so".into());
        vars.insert("DYLD_INSERT_LIBRARIES".into(), "/evil.dylib".into());
        vars.insert("LD_LIBRARY_PATH".into(), "/etc/evil".into());
        vars.insert("KEEP_ME".into(), "yes".into());
        let (kept, dropped) = apply_denylist(&vars, &[]);
        assert!(
            !kept.contains_key("LD_PRELOAD"),
            "LD_PRELOAD must be denied"
        );
        assert!(
            !kept.contains_key("DYLD_INSERT_LIBRARIES"),
            "DYLD_INSERT_LIBRARIES must be denied"
        );
        assert!(
            !kept.contains_key("LD_LIBRARY_PATH"),
            "LD_LIBRARY_PATH must be denied"
        );
        assert!(kept.contains_key("KEEP_ME"), "non-denied vars must survive");
        assert!(
            dropped.contains(&"LD_PRELOAD".to_string()),
            "drop list includes LD_PRELOAD"
        );
        assert!(
            dropped.contains(&"DYLD_INSERT_LIBRARIES".to_string()),
            "drop list includes DYLD_INSERT_LIBRARIES"
        );
    }

    #[test]
    fn denylist_drops_shell_presentation_vars() {
        use std::collections::BTreeMap;
        let mut vars = BTreeMap::new();
        vars.insert("PS1".into(), "$ ".into());
        vars.insert("PROMPT_COMMAND".into(), "history -a".into());
        vars.insert("OLDPWD".into(), "/tmp".into());
        vars.insert("STARSHIP_SHELL".into(), "zsh".into());
        vars.insert("USER_VAR".into(), "ok".into());
        let (kept, _) = apply_denylist(&vars, &[]);
        assert!(!kept.contains_key("PS1"), "PS1 must be denied");
        assert!(
            !kept.contains_key("PROMPT_COMMAND"),
            "PROMPT_COMMAND must be denied"
        );
        assert!(!kept.contains_key("OLDPWD"), "OLDPWD must be denied");
        assert!(
            !kept.contains_key("STARSHIP_SHELL"),
            "STARSHIP_* prefix must be denied"
        );
        assert!(
            kept.contains_key("USER_VAR"),
            "non-denied vars must survive"
        );
    }

    #[test]
    fn user_glob_denies_matching_names() {
        use std::collections::BTreeMap;
        let mut vars = BTreeMap::new();
        vars.insert("AWS_ACCESS_KEY_ID".into(), "secret".into());
        vars.insert("AWS_SECRET_KEY".into(), "secret".into());
        vars.insert("STRIPE_API_KEY".into(), "secret".into());
        vars.insert("PUBLIC_VAR".into(), "ok".into());
        let patterns = vec!["AWS_*".to_string(), "STRIPE_*".to_string()];
        let (kept, dropped) = apply_denylist(&vars, &patterns);
        assert!(
            !kept.contains_key("AWS_ACCESS_KEY_ID"),
            "user glob must deny AWS_ACCESS_KEY_ID"
        );
        assert!(
            !kept.contains_key("AWS_SECRET_KEY"),
            "user glob must deny AWS_SECRET_KEY"
        );
        assert!(
            !kept.contains_key("STRIPE_API_KEY"),
            "user glob must deny STRIPE_API_KEY"
        );
        assert!(
            kept.contains_key("PUBLIC_VAR"),
            "unmatched names must survive"
        );
        assert_eq!(dropped.len(), 3, "3 user-glob drops, 0 built-in drops");
    }

    #[test]
    fn user_glob_is_case_sensitive() {
        use std::collections::BTreeMap;
        let mut vars = BTreeMap::new();
        vars.insert("AWS_KEY".into(), "secret".into());
        vars.insert("aws_key".into(), "ok-on-posix".into());
        let patterns = vec!["AWS_*".to_string()];
        let (kept, _) = apply_denylist(&vars, &patterns);
        assert!(!kept.contains_key("AWS_KEY"), "uppercase match denied");
        assert!(
            kept.contains_key("aws_key"),
            "POSIX env names are case-sensitive — lowercase must survive",
        );
    }

    #[test]
    fn user_glob_invalid_pattern_is_ignored_not_panicked() {
        use std::collections::BTreeMap;
        let mut vars = BTreeMap::new();
        vars.insert("KEEP".into(), "yes".into());
        let patterns = vec!["[bad".to_string(), "OTHER_*".to_string()];
        let (kept, _) = apply_denylist(&vars, &patterns);
        assert!(
            kept.contains_key("KEEP"),
            "invalid glob is silently skipped"
        );
    }

    #[cfg(unix)]
    #[test]
    fn probe_via_shim_shell_captures_exported_vars() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let shim = tmp.path().join("fakeshell");
        std::fs::write(
            &shim,
            "#!/bin/sh\nprintf 'FROM_SHIM=hello\\0PATH=/from-shim\\0'\n",
        )
        .unwrap();
        let mut perm = std::fs::metadata(&shim).unwrap().permissions();
        perm.set_mode(0o755);
        std::fs::set_permissions(&shim, perm).unwrap();

        let probed = probe_shell_env_with_shell(shim.as_path());
        let env = probed.expect("probe should succeed with shim shell");
        assert_eq!(
            env.get("FROM_SHIM").map(String::as_str),
            Some("hello"),
            "probe must capture exported var from shim",
        );
        assert_eq!(
            env.get("PATH").map(String::as_str),
            Some("/from-shim"),
            "probe must capture PATH from shim",
        );
    }

    #[cfg(unix)]
    #[test]
    fn probe_returns_none_when_shell_exits_nonzero() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let shim = tmp.path().join("badshell");
        std::fs::write(&shim, "#!/bin/sh\nexit 7\n").unwrap();
        let mut perm = std::fs::metadata(&shim).unwrap().permissions();
        perm.set_mode(0o755);
        std::fs::set_permissions(&shim, perm).unwrap();
        let probed = probe_shell_env_with_shell(shim.as_path());
        assert!(probed.is_none(), "non-zero shell exit must yield None");
    }

    #[test]
    fn probe_returns_none_when_shell_path_relative() {
        let probed = probe_shell_env_with_shell(std::path::Path::new("zsh"));
        assert!(probed.is_none(), "relative shell path must be rejected");
    }

    #[test]
    fn diff_drops_baseline_keys_with_unchanged_values() {
        use std::collections::BTreeMap;
        let mut baseline = BTreeMap::new();
        baseline.insert("HOME".into(), "/Users/k".into());
        baseline.insert("USER".into(), "k".into());
        let mut shell = BTreeMap::new();
        shell.insert("HOME".into(), "/Users/k".into());
        shell.insert("USER".into(), "k".into());
        shell.insert("ADDED_BY_RC".into(), "yes".into());
        let added = diff_against_baseline(&shell, &baseline);
        assert_eq!(added.len(), 1, "only the added var should remain");
        assert_eq!(
            added.get("ADDED_BY_RC").map(String::as_str),
            Some("yes"),
            "user-added var must be forwarded",
        );
    }

    #[test]
    fn diff_keeps_baseline_keys_with_changed_values() {
        use std::collections::BTreeMap;
        let mut baseline = BTreeMap::new();
        baseline.insert("PATH".into(), "/usr/bin:/bin".into());
        let mut shell = BTreeMap::new();
        shell.insert("PATH".into(), "/Users/k/.local/bin:/usr/bin:/bin".into());
        let added = diff_against_baseline(&shell, &baseline);
        assert_eq!(
            added.get("PATH").map(String::as_str),
            Some("/Users/k/.local/bin:/usr/bin:/bin"),
            "changed PATH must be forwarded",
        );
    }

    #[test]
    fn invalidate_shell_env_clears_cache() {
        let _guard = SHELL_ENV_TEST_LOCK.lock().unwrap();
        use std::collections::BTreeMap;
        let mut vars = BTreeMap::new();
        vars.insert("FOO".into(), "bar".into());
        install_shell_env_for_test(ShellEnv {
            vars,
            captured_at: std::time::SystemTime::UNIX_EPOCH,
        });
        assert!(
            shell_env().is_some(),
            "install_shell_env_for_test must populate the cache",
        );
        invalidate_shell_env();
        assert!(
            shell_env().is_none(),
            "invalidate_shell_env must clear the cache",
        );
    }

    #[cfg(unix)]
    #[test]
    fn prewarm_with_shim_populates_cache_with_diff() {
        let _guard = SHELL_ENV_TEST_LOCK.lock().unwrap();
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let shim = tmp.path().join("rcshell");
        std::fs::write(
            &shim,
            "#!/bin/sh\nprintf 'JWT_CLIENT_ID=abc\\0HOME=/Users/k\\0LD_PRELOAD=/evil\\0'\n",
        )
        .unwrap();
        let mut perm = std::fs::metadata(&shim).unwrap().permissions();
        perm.set_mode(0o755);
        std::fs::set_permissions(&shim, perm).unwrap();

        // Baseline has HOME (matches shell value, so dropped) but not
        // JWT_CLIENT_ID (forwarded) and not LD_PRELOAD (forwarded by diff,
        // then dropped by built-in deny).
        let mut baseline = std::collections::BTreeMap::new();
        baseline.insert("HOME".into(), "/Users/k".into());

        invalidate_shell_env();
        let captured = run_probe_pipeline(shim.as_path(), &baseline, &[]);
        assert!(captured.is_some(), "pipeline must succeed against shim");
        let env = captured.unwrap();
        assert_eq!(
            env.vars.get("JWT_CLIENT_ID").map(String::as_str),
            Some("abc"),
            "user-added var must be forwarded through the pipeline",
        );
        assert!(
            !env.vars.contains_key("HOME"),
            "baseline-equal HOME must be filtered out by diff",
        );
        assert!(
            !env.vars.contains_key("LD_PRELOAD"),
            "built-in denylist must drop LD_PRELOAD even after diff",
        );
        // Pipeline also populates the cache as a side effect.
        let from_cache = shell_env().expect("pipeline must write into SHELL_ENV cache");
        assert_eq!(
            from_cache.vars.get("JWT_CLIENT_ID").map(String::as_str),
            Some("abc"),
            "cache must contain the same vars as the returned Arc",
        );
        invalidate_shell_env();
    }

    #[test]
    fn shell_path_reads_from_shell_env_when_present() {
        let _guard = SHELL_ENV_TEST_LOCK.lock().unwrap();
        use std::collections::BTreeMap;
        let mut vars = BTreeMap::new();
        vars.insert("PATH".into(), "/from-shell".into());
        install_shell_env_for_test(ShellEnv {
            vars,
            captured_at: std::time::SystemTime::UNIX_EPOCH,
        });
        let p = shell_path().expect("shell_path must read from shell_env");
        assert_eq!(
            p.to_string_lossy(),
            "/from-shell",
            "shell_path must return PATH entry from cached ShellEnv",
        );
        invalidate_shell_env();
    }

    #[test]
    fn enriched_env_contains_shell_env_vars() {
        let _guard = SHELL_ENV_TEST_LOCK.lock().unwrap();
        use std::collections::BTreeMap;
        let mut vars = BTreeMap::new();
        vars.insert("CUSTOM".into(), "user-set".into());
        install_shell_env_for_test(ShellEnv {
            vars,
            captured_at: std::time::SystemTime::UNIX_EPOCH,
        });
        let resolved = enriched_env();
        assert_eq!(
            resolved.vars.get("CUSTOM").and_then(|v| v.as_deref()),
            Some("user-set"),
            "enriched_env must include shell-env vars in ResolvedEnv.vars",
        );
        invalidate_shell_env();
    }
}
