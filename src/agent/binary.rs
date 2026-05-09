use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Resolve the full path to the `claude` CLI binary (async-safe).
///
/// GUI apps on macOS (and some Linux desktop environments) don't inherit the
/// user's shell PATH, so a bare `Command::new("claude")` fails with ENOENT.
/// We first check the current process PATH, then ask the user's login shell
/// for its PATH, then try well-known install locations, and finally fall back
/// to a bare `claude` command.
///
/// Successful absolute-path resolutions are cached in a `OnceLock` for the
/// lifetime of the process. The bare `"claude"` fallback is NOT cached, so
/// subsequent calls can retry resolution if the environment improves (e.g.,
/// a slow shell probe that timed out on first call).
///
/// The login-shell probe uses `std::process::Command` (blocking) with a
/// 5-second timeout that kills the subprocess on expiry. On Unix we run
/// the whole resolution inside `spawn_blocking` so a cold `SHELL_PATH`
/// cache never stalls a Tokio worker — `enriched_path()` transitively
/// calls `login_shell_path_probe()` on first use, and that probe can
/// block for up to 5 s on slow shell-init files. (Startup also calls
/// [`crate::env::prewarm_shell_path`] to warm the cache up front, but we
/// keep the `spawn_blocking` wrapper as a belt-and-braces guard.)
/// On Windows the base PATH comes from the registry — a handful of
/// `Path::is_file` probes plus one registry read, sub-millisecond — so
/// we run it inline.
pub async fn resolve_claude_path() -> OsString {
    if let Some(cached) = RESOLVED_CLAUDE_PATH.get() {
        return cached.clone();
    }
    #[cfg(unix)]
    let resolved = tokio::task::spawn_blocking(resolve_claude_path_sync)
        .await
        .unwrap_or_else(|_| OsString::from(claude_bare_name()));
    #[cfg(not(unix))]
    let resolved = resolve_claude_path_sync();

    // Only cache absolute paths — the bare "claude" fallback should allow
    // retries on subsequent calls in case the environment improves.
    if Path::new(&resolved).is_absolute() {
        let _ = RESOLVED_CLAUDE_PATH.set(resolved.clone());
    }
    resolved
}

/// Resolve the `claude` CLI path from a synchronous (non-async) context.
///
/// Mirrors [`crate::git::resolve_git_path_blocking`] so callers that can't
/// `.await` (e.g. background `std::thread` startup tasks like the User-Agent
/// cache warmer) get the same lookup order — process PATH, login-shell PATH,
/// well-known install locations — instead of a bare `Command::new("claude")`
/// that misses Windows npm shims (`claude.cmd`/`claude.ps1`) and the official
/// installer paths under `%LOCALAPPDATA%`.
///
/// Shares the same `OnceLock` cache as [`resolve_claude_path`], so the first
/// call from either side populates it and subsequent calls are free.
///
/// On a cold shell-path cache we skip [`crate::env::enriched_path`] and use
/// the raw process PATH instead, matching `resolve_git_path_blocking`'s
/// behaviour: this avoids stalling for up to 5 s on the login-shell probe
/// when the caller can't afford that wait. The fallback well-known paths
/// (npm shims, `%LOCALAPPDATA%\Programs\claude`, `~/.local/bin`, etc.) still
/// run, so most installs resolve even without the enriched PATH.
pub fn resolve_claude_path_blocking() -> OsString {
    if let Some(cached) = RESOLVED_CLAUDE_PATH.get() {
        return cached.clone();
    }
    let path = if crate::env::shell_path_is_cached() {
        Some(crate::env::enriched_path())
    } else {
        std::env::var_os("PATH")
    };
    // Also gate the lazy shell-path probe inside the resolver: even with
    // `enriched_path()` skipped above, the `login_shell_path` closure
    // would still invoke `crate::env::shell_path()` (and pay the 5 s
    // probe) on a process-PATH miss. Returning `None` when the cache is
    // cold keeps the blocking helper truly non-stalling — well-known
    // fallback paths still cover typical installs.
    let resolved = resolve_claude_path_inner(
        dirs::home_dir(),
        path,
        || {
            if crate::env::shell_path_is_cached() {
                login_shell_path()
            } else {
                None
            }
        },
        is_executable_file,
    );
    if Path::new(&resolved).is_absolute() {
        let _ = RESOLVED_CLAUDE_PATH.set(resolved.clone());
    }
    resolved
}

/// Shared cache for [`resolve_claude_path`] and [`resolve_claude_path_blocking`].
/// Only populated for absolute paths — the bare-`claude` fallback stays
/// uncached so the next call gets a chance to find a real install.
static RESOLVED_CLAUDE_PATH: OnceLock<OsString> = OnceLock::new();

/// Synchronous core of [`resolve_claude_path`]. Extracted so it can run
/// inside `tokio::task::spawn_blocking` on Unix without juggling async
/// boundaries inside the resolver itself.
fn resolve_claude_path_sync() -> OsString {
    resolve_claude_path_inner(
        dirs::home_dir(),
        Some(crate::env::enriched_path()),
        login_shell_path,
        is_executable_file,
    )
}

/// Check that a path is a regular file with execute permission.
#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.is_file()
        && path
            .metadata()
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
}

/// Check that a path is a regular file (non-Unix fallback).
#[cfg(not(unix))]
fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

/// Pure, testable search logic — no filesystem or process side effects.
///
/// Resolution order respects the user's configured PATH first, then falls
/// back to progressively more expensive probes:
///
/// 1. Process PATH (cheap — honours shims, asdf, mise, Nix profiles, etc.)
/// 2. Login shell PATH (deferred — only runs if #1 missed, handles GUI launch)
/// 3. Well-known install locations (static fallback paths)
/// 4. Bare `"claude"` (absolute last resort)
///
/// All PATH searches skip non-absolute entries to prevent repo-local execution.
/// The `shell_path_probe` closure is called lazily so we don't pay the
/// shell-spawn cost when the process PATH already found claude.
fn resolve_claude_path_inner(
    home: Option<PathBuf>,
    process_path: Option<OsString>,
    shell_path_probe: impl FnOnce() -> Option<OsString>,
    exists: impl Fn(&Path) -> bool,
) -> OsString {
    // 1. Search the process PATH first. This respects the user's configured
    //    environment, including shims (asdf, mise, Nix, pnpm, etc.).
    //    Skip non-absolute entries (e.g. "." or "") to avoid resolving a
    //    repo-local `claude` binary relative to the working directory.
    if let Some(process_path) = process_path
        && let Some(found) = search_path_dirs(&process_path, &exists)
    {
        return found;
    }

    // 2. Probe the login shell's PATH. GUI-launched apps on macOS don't
    //    inherit the user's shell PATH, so this catches the common case
    //    where process PATH is empty/minimal. Deferred to here so we don't
    //    pay the shell-spawn cost when process PATH already found claude.
    if let Some(shell_path) = shell_path_probe()
        && let Some(found) = search_path_dirs(&shell_path, &exists)
    {
        return found;
    }

    // 3. Well-known install locations as static fallbacks.
    let fallback_candidates = claude_fallback_paths(home.as_deref());
    for p in &fallback_candidates {
        if exists(p) {
            return p.clone().into_os_string();
        }
    }

    // 4. Nothing found — bare name as absolute last resort.
    //    On Windows this is `claude.exe` so `CreateProcessW` doesn't add an
    //    unwanted `.com`/`.bat` match from PATHEXT resolution.
    OsString::from(claude_bare_name())
}

/// Binary filename variants for the `claude` CLI on the current target.
///
/// On Windows, the official Anthropic native installer ships `claude.exe`,
/// while `npm i -g @anthropic-ai/claude-code` produces `.cmd` and `.ps1`
/// launcher shims in `%APPDATA%\npm\`. We probe all three so both install
/// flows resolve. On Unix there's only the bare `claude` executable.
#[cfg(windows)]
fn claude_binary_variants() -> &'static [&'static str] {
    &["claude.exe", "claude.cmd", "claude.ps1"]
}

#[cfg(not(windows))]
fn claude_binary_variants() -> &'static [&'static str] {
    &["claude"]
}

#[cfg(windows)]
fn claude_bare_name() -> &'static str {
    "claude.exe"
}

#[cfg(not(windows))]
fn claude_bare_name() -> &'static str {
    "claude"
}

/// Well-known install locations for the `claude` CLI on the current target.
/// Checked in order; first extant path wins. Pure function, no IO — takes
/// `home` as a parameter so tests can inject a fixed path.
fn claude_fallback_paths(home: Option<&Path>) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();

    #[cfg(windows)]
    {
        if let Some(home) = home {
            // Official Anthropic Windows installer drops here; this is the
            // most likely hit on a fresh machine.
            out.push(home.join(".local").join("bin").join("claude.exe"));
            // npm global install — shims live under %APPDATA%\npm, which is
            // `$HOME/AppData/Roaming/npm` by default.
            out.push(
                home.join("AppData")
                    .join("Roaming")
                    .join("npm")
                    .join("claude.cmd"),
            );
            out.push(
                home.join("AppData")
                    .join("Roaming")
                    .join("npm")
                    .join("claude.ps1"),
            );
            // Hypothetical future MSI target — cheap to check and harmless
            // if absent.
            out.push(
                home.join("AppData")
                    .join("Local")
                    .join("Programs")
                    .join("claude")
                    .join("claude.exe"),
            );
        }
    }

    #[cfg(not(windows))]
    {
        if let Some(home) = home {
            out.push(home.join(".local/bin/claude"));
            out.push(home.join(".claude/local/claude"));
            out.push(home.join(".nix-profile/bin/claude"));
        }
        out.push(PathBuf::from("/usr/local/bin/claude"));
        out.push(PathBuf::from("/opt/homebrew/bin/claude"));
        out.push(PathBuf::from("/run/current-system/sw/bin/claude"));
        out.push(PathBuf::from("/nix/var/nix/profiles/default/bin/claude"));
    }

    out
}

/// Search PATH directories for a `claude` binary, trying each platform
/// filename variant (`claude.exe`/`claude.cmd`/`claude.ps1` on Windows,
/// bare `claude` elsewhere).
///
/// Skips non-absolute entries to prevent repo-local execution
/// (e.g. a `.` entry would otherwise let a malicious repo provide its own
/// `claude` binary).
fn search_path_dirs(path: &std::ffi::OsStr, exists: &impl Fn(&Path) -> bool) -> Option<OsString> {
    for dir in std::env::split_paths(path) {
        if !dir.is_absolute() {
            continue;
        }
        for name in claude_binary_variants() {
            let candidate = dir.join(name);
            if exists(&candidate) {
                return Some(candidate.into_os_string());
            }
        }
    }
    None
}

/// Get the PATH as seen by the user's login shell.
///
/// Delegates to the shared `crate::env::shell_path()` which probes the
/// login shell once and caches the result for the process lifetime.
fn login_shell_path() -> Option<OsString> {
    crate::env::shell_path().cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Used only by the Unix tests below; gated to silence the Windows-side
    // dead-code warning that `RUSTFLAGS=-Dwarnings` promotes to an error.
    #[cfg(unix)]
    fn no_shell() -> Option<OsString> {
        None
    }

    #[cfg(unix)]
    #[test]
    fn test_resolve_process_path_wins() {
        let home = PathBuf::from("/home/user");
        let result = resolve_claude_path_inner(
            Some(home.clone()),
            Some(OsString::from("/custom/bin")),
            no_shell,
            |p| {
                p == Path::new("/custom/bin/claude")
                    || p == home.join(".local/bin/claude")
                    || p == Path::new("/usr/local/bin/claude")
            },
        );
        assert_eq!(result, OsString::from("/custom/bin/claude"));
    }

    #[cfg(unix)]
    #[test]
    fn test_resolve_shell_path_before_well_known() {
        let shell_path = OsString::from("/shell/bin");
        let result = resolve_claude_path_inner(
            None,
            None,
            || Some(shell_path),
            |p| p == Path::new("/shell/bin/claude") || p == Path::new("/usr/local/bin/claude"),
        );
        assert_eq!(result, OsString::from("/shell/bin/claude"));
    }

    #[cfg(unix)]
    #[test]
    fn test_resolve_shell_probe_deferred() {
        let probed = std::sync::atomic::AtomicBool::new(false);
        let result = resolve_claude_path_inner(
            None,
            Some(OsString::from("/good/bin")),
            || {
                probed.store(true, std::sync::atomic::Ordering::SeqCst);
                Some(OsString::from("/shell/bin"))
            },
            |p| p == Path::new("/good/bin/claude") || p == Path::new("/shell/bin/claude"),
        );
        assert_eq!(result, OsString::from("/good/bin/claude"));
        assert!(!probed.load(std::sync::atomic::Ordering::SeqCst));
    }

    #[cfg(unix)]
    #[test]
    fn test_resolve_falls_back_to_well_known_home() {
        let home = PathBuf::from("/home/user");
        let expected = home.join(".local/bin/claude");
        let result = resolve_claude_path_inner(Some(home), None, no_shell, |p| p == expected);
        assert_eq!(result, expected.into_os_string());
    }

    #[cfg(unix)]
    #[test]
    fn test_resolve_falls_back_to_claude_local() {
        let home = PathBuf::from("/home/user");
        let expected = home.join(".claude/local/claude");
        let result = resolve_claude_path_inner(Some(home), None, no_shell, |p| p == expected);
        assert_eq!(result, expected.into_os_string());
    }

    #[cfg(unix)]
    #[test]
    fn test_resolve_falls_back_to_system() {
        let result = resolve_claude_path_inner(None, None, no_shell, |p| {
            p == Path::new("/usr/local/bin/claude")
        });
        assert_eq!(result, OsString::from("/usr/local/bin/claude"));
    }

    #[cfg(unix)]
    #[test]
    fn test_resolve_falls_back_to_homebrew() {
        let result = resolve_claude_path_inner(None, None, no_shell, |p| {
            p == Path::new("/opt/homebrew/bin/claude")
        });
        assert_eq!(result, OsString::from("/opt/homebrew/bin/claude"));
    }

    #[cfg(unix)]
    #[test]
    fn test_resolve_finds_nix_profile() {
        let home = PathBuf::from("/home/user");
        let expected = home.join(".nix-profile/bin/claude");
        let result = resolve_claude_path_inner(Some(home), None, no_shell, |p| p == expected);
        assert_eq!(result, expected.into_os_string());
    }

    #[cfg(unix)]
    #[test]
    fn test_resolve_finds_nixos_system() {
        let result = resolve_claude_path_inner(None, None, no_shell, |p| {
            p == Path::new("/run/current-system/sw/bin/claude")
        });
        assert_eq!(result, OsString::from("/run/current-system/sw/bin/claude"));
    }

    #[cfg(unix)]
    #[test]
    fn test_resolve_home_before_system_in_fallbacks() {
        let home = PathBuf::from("/home/user");
        let home_path = home.join(".local/bin/claude");
        let result = resolve_claude_path_inner(Some(home), None, no_shell, |p| {
            p == home_path || p == Path::new("/usr/local/bin/claude")
        });
        assert_eq!(result, home_path.into_os_string());
    }

    #[cfg(unix)]
    #[test]
    fn test_resolve_bare_fallback() {
        let result = resolve_claude_path_inner(None, None, no_shell, |_| false);
        assert_eq!(result, OsString::from("claude"));
    }

    #[cfg(unix)]
    #[test]
    fn test_resolve_skips_relative_in_process_path() {
        let result = resolve_claude_path_inner(
            None,
            Some(OsString::from(".:/relative/bin:/abs/bin")),
            no_shell,
            |p| {
                p == Path::new("./claude")
                    || p == Path::new("relative/bin/claude")
                    || p == Path::new("/abs/bin/claude")
            },
        );
        assert_eq!(result, OsString::from("/abs/bin/claude"));
    }

    #[cfg(unix)]
    #[test]
    fn test_resolve_skips_empty_path_entry() {
        let result =
            resolve_claude_path_inner(None, Some(OsString::from(":/good/bin:")), no_shell, |p| {
                p == Path::new("/good/bin/claude")
            });
        assert_eq!(result, OsString::from("/good/bin/claude"));
    }

    #[cfg(unix)]
    #[test]
    fn test_resolve_all_relative_falls_through_to_bare() {
        let result = resolve_claude_path_inner(
            None,
            Some(OsString::from(".:./bin:relative")),
            no_shell,
            |p| !p.is_absolute(),
        );
        assert_eq!(result, OsString::from("claude"));
    }

    #[cfg(unix)]
    #[test]
    fn test_search_path_dirs_skips_relative_then_returns_first_absolute_match() {
        // PATH has a leading relative entry (`.`) followed by two absolute
        // entries that both contain a `claude` binary. The relative entry
        // must be skipped, and the first absolute match wins (PATH order).
        let path = OsString::from(".:/tmp/evil:/good/bin");
        let result = search_path_dirs(path.as_os_str(), &|p| {
            p == Path::new("/tmp/evil/claude") || p == Path::new("/good/bin/claude")
        });
        assert_eq!(result, Some(OsString::from("/tmp/evil/claude")));
    }

    #[cfg(unix)]
    #[test]
    fn test_search_path_dirs_returns_none_for_all_relative() {
        let path = OsString::from(".:relative:./bin");
        let result = search_path_dirs(path.as_os_str(), &|_| true);
        assert_eq!(result, None);
    }

    #[cfg(windows)]
    #[test]
    fn test_resolve_falls_back_to_anthropic_native_windows() {
        let home = PathBuf::from(r"C:\Users\user");
        let expected = home.join(r".local\bin\claude.exe");
        let expected_clone = expected.clone();
        let result =
            resolve_claude_path_inner(Some(home), None, || None, move |p| p == expected_clone);
        assert_eq!(result, expected.into_os_string());
    }

    #[cfg(windows)]
    #[test]
    fn test_resolve_falls_back_to_npm_shim_windows() {
        let home = PathBuf::from(r"C:\Users\user");
        let expected = home.join(r"AppData\Roaming\npm\claude.cmd");
        let expected_clone = expected.clone();
        let result =
            resolve_claude_path_inner(Some(home), None, || None, move |p| p == expected_clone);
        assert_eq!(result, expected.into_os_string());
    }

    #[cfg(windows)]
    #[test]
    fn test_search_path_dirs_tries_each_variant_windows() {
        let path = OsString::from(r"C:\tools\npm");
        let expected = PathBuf::from(r"C:\tools\npm\claude.cmd");
        let expected_clone = expected.clone();
        let result = search_path_dirs(path.as_os_str(), &move |p| p == expected_clone);
        assert_eq!(result, Some(expected.into_os_string()));
    }

    #[cfg(windows)]
    #[test]
    fn test_bare_name_is_exe_on_windows() {
        assert_eq!(claude_bare_name(), "claude.exe");
    }
}
