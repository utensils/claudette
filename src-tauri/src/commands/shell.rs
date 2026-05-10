use serde::Serialize;

// `Bash`/`Zsh`/`Fish`/`Unknown` are only constructed on POSIX targets;
// `PowerShell`/`Cmd` only on Windows. Both halves are part of the
// `detect_user_shell` API though, so blanket `dead_code` keeps either
// side of the cfg compiling under CI's `-Dwarnings` without scattering
// `cfg_attr` markers across each variant.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ShellType {
    Bash,
    Zsh,
    Fish,
    /// PowerShell — either modern `pwsh.exe` (PowerShell 7+) or the
    /// in-box `powershell.exe` (Windows PowerShell 5.1). Both auto-load
    /// the user's `$PROFILE` when launched interactively in a ConPTY,
    /// so spawning the bare exe is enough to get the user's prompt,
    /// aliases, and module imports.
    PowerShell,
    /// `cmd.exe` — the last-resort Windows fallback when no PowerShell
    /// is on PATH. Honours `HKCU\Software\Microsoft\Command Processor\AutoRun`
    /// for any user-supplied init, so again no extra args needed.
    Cmd,
    Unknown,
}

pub fn detect_user_shell() -> (String, ShellType) {
    #[cfg(target_os = "windows")]
    {
        windows_detect_user_shell()
    }
    #[cfg(not(target_os = "windows"))]
    {
        posix_detect_user_shell()
    }
}

/// POSIX-side detection: `$SHELL` is the user's stated preference; fall
/// back to a sensible per-platform default so a launchd / systemd-spawned
/// release build (which inherits a stripped env) still gets a real shell.
#[cfg(not(target_os = "windows"))]
fn posix_detect_user_shell() -> (String, ShellType) {
    if let Ok(shell) = std::env::var("SHELL") {
        let shell_type = match shell.as_str() {
            s if s.contains("bash") => ShellType::Bash,
            s if s.contains("zsh") => ShellType::Zsh,
            s if s.contains("fish") => ShellType::Fish,
            _ => ShellType::Unknown,
        };
        return (shell, shell_type);
    }

    #[cfg(target_os = "macos")]
    {
        ("/bin/zsh".to_string(), ShellType::Zsh)
    }
    #[cfg(target_os = "linux")]
    {
        ("/bin/bash".to_string(), ShellType::Bash)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        ("/bin/sh".to_string(), ShellType::Unknown)
    }
}

/// Windows-side detection. portable-pty's `new_default_prog()` falls
/// back to `cmd.exe` here, which never loads any user-customizable
/// profile — so an integrated terminal looks nothing like the user's
/// regular Windows Terminal session.
///
/// `pwsh.exe` (PowerShell 7+) and `powershell.exe` (Windows PowerShell
/// 5.1) read profiles from totally different paths
/// (`Documents\PowerShell\…` vs `Documents\WindowsPowerShell\…`), so
/// blindly preferring `pwsh.exe` when the user has only ever written a
/// PS5.1 profile drops them into an empty PS7 banner with none of their
/// prompt customizations. The fix: pick the flavour whose profile the
/// user has actually written.
///
/// Resolution order:
///   1. `pwsh.exe` on PATH **and** a PS7 profile exists  — modern PS, configured
///   2. `powershell.exe` on PATH **and** a PS5.1 profile exists, **and** no PS7 profile — match what the user actually customizes
///   3. `pwsh.exe` on PATH                               — modern default when no profile signal either way
///   4. `powershell.exe` on PATH                         — in-box fallback
///   5. `%ComSpec%`                                      — user's deliberate cmd override, if set
///   6. `%WINDIR%\System32\cmd.exe`                      — guaranteed-present last resort
#[cfg(target_os = "windows")]
fn windows_detect_user_shell() -> (String, ShellType) {
    let path = std::env::var_os("PATH");
    let comspec = std::env::var_os("ComSpec");
    let windir = std::env::var_os("WINDIR");
    let userprofile = std::env::var_os("USERPROFILE");
    detect_windows_shell_inner(
        path.as_deref(),
        comspec.as_deref(),
        windir.as_deref(),
        userprofile.as_deref(),
    )
}

/// Which PowerShell flavour we're checking for a user profile.
#[cfg(target_os = "windows")]
#[derive(Debug, Clone, Copy)]
enum PsFlavour {
    /// PowerShell 7+ (`pwsh.exe`). Reads from `Documents\PowerShell\…`.
    Pwsh,
    /// Windows PowerShell 5.1 (`powershell.exe`). Reads from
    /// `Documents\WindowsPowerShell\…`.
    WindowsPs,
}

/// Pure-function core of `windows_detect_user_shell`, parameterised on
/// the env values it consults so tests don't have to mutate the
/// process-wide environment (which would race with parallel tests).
#[cfg(target_os = "windows")]
fn detect_windows_shell_inner(
    path_env: Option<&std::ffi::OsStr>,
    comspec: Option<&std::ffi::OsStr>,
    windir: Option<&std::ffi::OsStr>,
    userprofile: Option<&std::ffi::OsStr>,
) -> (String, ShellType) {
    let pwsh = find_in_path("pwsh.exe", path_env);
    let powershell = find_in_path("powershell.exe", path_env);

    let userprofile_path = userprofile.map(std::path::Path::new);
    let has_pwsh_profile = has_powershell_profile(PsFlavour::Pwsh, userprofile_path);
    let has_ps51_profile = has_powershell_profile(PsFlavour::WindowsPs, userprofile_path);

    // 1: PS7 + PS7 profile → run the configured PS7 setup.
    if has_pwsh_profile && let Some(p) = pwsh.clone() {
        return (p, ShellType::PowerShell);
    }
    // 2: PS5.1 profile, no PS7 profile, PS5.1 installed → match the
    //    user's actual customizations rather than their unconfigured
    //    PS7. This is the fallthrough that previously left OneDrive
    //    PS5.1 users staring at a bare `pwsh.exe` banner.
    if has_ps51_profile
        && !has_pwsh_profile
        && let Some(p) = powershell.clone()
    {
        return (p, ShellType::PowerShell);
    }
    // 3: No profile signal — prefer modern PS7 if installed.
    if let Some(p) = pwsh {
        return (p, ShellType::PowerShell);
    }
    // 4: Fall back to in-box Windows PowerShell.
    if let Some(p) = powershell {
        return (p, ShellType::PowerShell);
    }
    // 5: Honour an explicit cmd override.
    if let Some(cs) = comspec.and_then(|s| s.to_str()).filter(|s| !s.is_empty()) {
        return (cs.to_string(), ShellType::Cmd);
    }
    // 6: Always-present last resort.
    let win = windir.and_then(|s| s.to_str()).unwrap_or(r"C:\Windows");
    (format!(r"{win}\System32\cmd.exe"), ShellType::Cmd)
}

#[cfg(target_os = "windows")]
fn find_in_path(name: &str, path_env: Option<&std::ffi::OsStr>) -> Option<String> {
    let path_env = path_env?;
    for dir in std::env::split_paths(path_env) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    None
}

/// True if the user has any per-host or all-hosts profile written for
/// the given PowerShell flavour. We check both the regular `Documents`
/// folder and OneDrive-redirected `OneDrive\Documents` because Office
/// 365 / Windows 11 Backup commonly redirects Documents into OneDrive
/// (this is exactly how the bug surfaced on the original report — the
/// user's PS5.1 profile lived under `OneDrive\Documents\…`, so the old
/// "always pick pwsh" heuristic missed it and they got an empty PS7
/// banner with no prompt customizations).
///
/// We deliberately don't probe `$PSHOME`-rooted all-users profiles —
/// those are sysadmin territory, much rarer than per-user profiles, and
/// using their presence as a signal would mislead detection on
/// corp-managed machines.
#[cfg(target_os = "windows")]
fn has_powershell_profile(flavour: PsFlavour, userprofile: Option<&std::path::Path>) -> bool {
    let Some(home) = userprofile else {
        return false;
    };
    let dir = match flavour {
        PsFlavour::Pwsh => "PowerShell",
        PsFlavour::WindowsPs => "WindowsPowerShell",
    };
    for docs in ["Documents", r"OneDrive\Documents"] {
        // Per-host (`Microsoft.PowerShell_profile.ps1`) and all-hosts
        // (`Profile.ps1`) both count: either kind of file means the
        // user has set something up for this PowerShell flavour.
        for filename in ["Microsoft.PowerShell_profile.ps1", "Profile.ps1"] {
            let candidate = home.join(docs).join(dir).join(filename);
            if candidate.is_file() {
                return true;
            }
        }
    }
    false
}

#[tauri::command]
pub async fn open_in_editor(path: String) -> Result<(), String> {
    // Expand a leading `~/` (or bare `~`) using the host's home dir.
    // `opener::open` shells out to the OS handler, which doesn't perform
    // shell-style tilde expansion — without this, the markdown autolinker
    // emitting `~/Downloads/foo.csv` would silently fail to open.
    let expanded = expand_home_tilde(&path);
    if !is_acceptable_open_target(&expanded) {
        return Err(format!(
            "refusing to open non-file path {expanded:?} via open_in_editor — \
             this command opens local files only; use open_url for HTTP(S)"
        ));
    }
    // Run synchronously so errors propagate back to the frontend instead
    // of getting silently dropped on stderr inside a spawned task. The
    // helper is a thin wrapper around `open` / `xdg-open` / `cmd start`,
    // all of which return as soon as the OS hands off — no blocking.
    opener::open(&expanded).map_err(|e| format!("Failed to open {expanded:?}: {e}"))
}

/// Whether a string looks like a local file path we should hand to the OS
/// opener. Reject URLs (`opener::open` happily opens `https://…` or even
/// `javascript:` on some platforms) so a crafted markdown link with a
/// `claudettepath:` href can't be smuggled into a generic URL trampoline.
/// Also reject relative paths — the autolinker only emits absolute matches,
/// and a relative input would resolve against an unpredictable cwd.
fn is_acceptable_open_target(s: &str) -> bool {
    if s.is_empty() {
        return false;
    }
    // Any `<scheme>://…` shape is a URL, not a file. Use the same heuristic
    // hast-util-sanitize uses: a colon before the first `/`, `?`, or `#`.
    let colon = s.find(':');
    let slash = s.find('/');
    if let Some(c) = colon
        && (slash.is_none() || c < slash.unwrap_or(usize::MAX))
        && s[c..].starts_with("://")
    {
        return false;
    }
    // POSIX absolute (`/foo/bar`).
    if s.starts_with('/') {
        return true;
    }
    // Windows UNC (`\\server\share\…`) or back-slash absolute (`\foo`).
    if s.starts_with('\\') {
        return true;
    }
    // Windows drive (`C:\…` or `C:/…`).
    let mut chars = s.chars();
    if let (Some(first), Some(second), Some(third)) = (chars.next(), chars.next(), chars.next())
        && first.is_ascii_alphabetic()
        && second == ':'
        && (third == '\\' || third == '/')
    {
        return true;
    }
    false
}

/// Expand a leading `~` or `~/` to the user's home directory. Returns the
/// input unchanged if it doesn't start with `~`, or if the home dir can't
/// be resolved (best-effort: callers still see a sensible error from the
/// OS open command instead of a silent expansion failure).
fn expand_home_tilde(path: &str) -> String {
    if path == "~" {
        if let Some(home) = dirs::home_dir() {
            return home.to_string_lossy().into_owned();
        }
    } else if let Some(rest) = path.strip_prefix("~/")
        && let Some(home) = dirs::home_dir()
    {
        return home.join(rest).to_string_lossy().into_owned();
    }
    path.to_string()
}

/// Returns true if the URL uses a scheme safe for opening in the system browser.
fn is_safe_url_scheme(url: &str) -> bool {
    url.starts_with("http://") || url.starts_with("https://") || url.starts_with("mailto:")
}

#[tauri::command]
pub async fn open_url(url: String) -> Result<(), String> {
    if !is_safe_url_scheme(&url) {
        return Err(format!("Blocked URL with unsupported scheme: {url}"));
    }
    tauri::async_runtime::spawn(async move {
        if let Err(e) = opener::open(&url) {
            tracing::warn!(
                target: "claudette::ui",
                url = %url,
                error = %e,
                "failed to open URL in system browser"
            );
        }
    });
    Ok(())
}

pub(crate) mod opener {
    use claudette::process::CommandWindowExt as _;
    use std::process::Command;

    pub fn open(path: &str) -> std::io::Result<()> {
        #[cfg(target_os = "macos")]
        let cmd = Command::new("open").no_console_window().arg(path).spawn();

        #[cfg(target_os = "linux")]
        let cmd = Command::new("xdg-open")
            .no_console_window()
            .arg(path)
            .spawn();

        #[cfg(target_os = "windows")]
        let cmd = Command::new("cmd")
            .no_console_window()
            .args(["/C", "start", "", path])
            .spawn();

        #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
        let cmd = Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "Unsupported platform",
        ));

        cmd.map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_safe_url_scheme_allows_http() {
        assert!(is_safe_url_scheme("http://example.com"));
    }

    #[test]
    fn is_safe_url_scheme_allows_https() {
        assert!(is_safe_url_scheme("https://github.com/utensils/claudette"));
    }

    #[test]
    fn is_safe_url_scheme_allows_mailto() {
        assert!(is_safe_url_scheme("mailto:user@example.com"));
    }

    #[test]
    fn is_safe_url_scheme_blocks_file() {
        assert!(!is_safe_url_scheme("file:///etc/passwd"));
    }

    #[test]
    fn is_safe_url_scheme_blocks_javascript() {
        assert!(!is_safe_url_scheme("javascript:alert(1)"));
    }

    #[test]
    fn is_safe_url_scheme_blocks_data() {
        assert!(!is_safe_url_scheme("data:text/html,<h1>hi</h1>"));
    }

    #[test]
    fn is_safe_url_scheme_blocks_empty() {
        assert!(!is_safe_url_scheme(""));
    }

    #[test]
    fn is_safe_url_scheme_blocks_relative_path() {
        assert!(!is_safe_url_scheme("/some/path"));
    }

    #[test]
    fn is_safe_url_scheme_blocks_fragment() {
        assert!(!is_safe_url_scheme("#section"));
    }

    #[test]
    fn expand_home_tilde_expands_tilde_slash() {
        let Some(home) = dirs::home_dir() else {
            // Test machines without a resolvable home dir return the
            // input unchanged — verify that path explicitly so the
            // test still says something meaningful.
            assert_eq!(expand_home_tilde("~/foo"), "~/foo");
            return;
        };
        let expected = home.join("foo").to_string_lossy().into_owned();
        assert_eq!(expand_home_tilde("~/foo"), expected);
    }

    #[test]
    fn expand_home_tilde_expands_bare_tilde() {
        let Some(home) = dirs::home_dir() else {
            assert_eq!(expand_home_tilde("~"), "~");
            return;
        };
        assert_eq!(expand_home_tilde("~"), home.to_string_lossy().to_string());
    }

    #[test]
    fn expand_home_tilde_leaves_absolute_paths_alone() {
        assert_eq!(expand_home_tilde("/tmp/foo.csv"), "/tmp/foo.csv");
        assert_eq!(
            expand_home_tilde("C:\\Users\\foo.csv"),
            "C:\\Users\\foo.csv"
        );
    }

    #[test]
    fn expand_home_tilde_does_not_expand_user_specific_tilde() {
        // `~root/foo` is shell sugar for "root's home" — we don't try
        // to handle that. The string passes through unchanged so the
        // OS open command can decide.
        assert_eq!(expand_home_tilde("~root/foo"), "~root/foo");
    }

    #[test]
    fn is_acceptable_open_target_accepts_posix_absolute() {
        assert!(is_acceptable_open_target("/tmp/foo.csv"));
        assert!(is_acceptable_open_target("/etc"));
    }

    #[test]
    fn is_acceptable_open_target_accepts_windows_drive() {
        assert!(is_acceptable_open_target("C:\\Users\\foo.csv"));
        assert!(is_acceptable_open_target("c:/Users/foo.csv"));
    }

    #[test]
    fn is_acceptable_open_target_accepts_unc() {
        assert!(is_acceptable_open_target("\\\\server\\share\\file.txt"));
    }

    #[test]
    fn is_acceptable_open_target_rejects_urls() {
        assert!(!is_acceptable_open_target("https://example.com"));
        assert!(!is_acceptable_open_target("http://example.com/path"));
        assert!(!is_acceptable_open_target("file:///etc/passwd"));
        // Even a "claudettepath:" prefix gets stripped by the frontend
        // before invocation, but if a crafted link slipped through with
        // a URL payload after the scheme we still reject:
        assert!(!is_acceptable_open_target("javascript://alert(1)"));
    }

    #[test]
    fn is_acceptable_open_target_rejects_relative_and_empty() {
        assert!(!is_acceptable_open_target(""));
        assert!(!is_acceptable_open_target("foo/bar.csv"));
        assert!(!is_acceptable_open_target("./foo.csv"));
        assert!(!is_acceptable_open_target("../foo.csv"));
    }

    #[test]
    fn is_acceptable_open_target_rejects_drive_without_separator() {
        // `C:foo` is a Windows-relative-to-current-dir-on-drive path —
        // unpredictable; reject.
        assert!(!is_acceptable_open_target("C:foo.csv"));
    }

    // ---------------------------------------------------------------------
    // Windows shell detection
    //
    // These tests pin the resolution order pwsh-with-profile →
    // powershell-with-profile → pwsh → powershell → ComSpec →
    // %WINDIR%\System32\cmd.exe so a regression that quietly drops back
    // to `cmd.exe` (the original bug) or quietly drops the user into an
    // unconfigured `pwsh.exe` despite a PS5.1 profile being present (the
    // OneDrive-redirect bug surfaced in follow-up testing) gets caught
    // in CI. They call `detect_windows_shell_inner` directly with
    // synthetic env values rather than mutating the process environment,
    // so the tests are safe to run under cargo's parallel test harness.
    // ---------------------------------------------------------------------
    #[cfg(target_os = "windows")]
    mod windows_shell {
        use super::super::{ShellType, detect_windows_shell_inner};
        use std::ffi::{OsStr, OsString};
        use std::fs::{self, File};
        use std::path::{Path, PathBuf};
        use tempfile::TempDir;

        /// Drop an empty file at `<dir>/<name>` so `Path::is_file()`
        /// returns true for it. Content is irrelevant — the lookup is a
        /// pure existence check.
        fn touch(dir: &Path, name: &str) {
            File::create(dir.join(name)).expect("create stub exe");
        }

        /// Build a `PATH`-style OsString joining the supplied dirs with
        /// the platform separator.
        fn join_path<P: AsRef<Path>>(dirs: &[P]) -> OsString {
            std::env::join_paths(dirs.iter().map(|p| p.as_ref())).expect("join_paths")
        }

        /// Which `Documents` parent we want the synthetic profile under
        /// — `Documents\` (regular) vs `OneDrive\Documents\` (the
        /// Office 365 / Win11 Backup redirect that originally hid the
        /// user's PS5.1 profile from the heuristic).
        enum DocsKind {
            Regular,
            OneDrive,
        }

        /// Drop a `Microsoft.PowerShell_profile.ps1` for the given
        /// flavour under a fake USERPROFILE so `has_powershell_profile`
        /// observes it the same way it would in production.
        fn touch_profile(home: &Path, flavour: &str, docs: DocsKind) -> PathBuf {
            let docs_dir = match docs {
                DocsKind::Regular => home.join("Documents"),
                DocsKind::OneDrive => home.join("OneDrive").join("Documents"),
            };
            let dir = docs_dir.join(flavour);
            fs::create_dir_all(&dir).expect("create profile dir");
            let path = dir.join("Microsoft.PowerShell_profile.ps1");
            File::create(&path).expect("create profile file");
            path
        }

        #[test]
        fn prefers_pwsh_when_only_pwsh_profile_present() {
            let pwsh_dir = TempDir::new().unwrap();
            let ps_dir = TempDir::new().unwrap();
            let home = TempDir::new().unwrap();
            touch(pwsh_dir.path(), "pwsh.exe");
            touch(ps_dir.path(), "powershell.exe");
            touch_profile(home.path(), "PowerShell", DocsKind::Regular);

            let path = join_path(&[pwsh_dir.path(), ps_dir.path()]);
            let (shell, kind) = detect_windows_shell_inner(
                Some(path.as_os_str()),
                None,
                None,
                Some(home.path().as_os_str()),
            );

            assert_eq!(kind, ShellType::PowerShell);
            assert!(
                shell.ends_with("pwsh.exe"),
                "pwsh.exe + PS7 profile should win, got {shell:?}"
            );
        }

        #[test]
        fn prefers_powershell_when_only_ps51_profile_present() {
            // Both PowerShells installed, but the user has only ever
            // written a Windows PowerShell profile — the original report.
            // Spawning `pwsh.exe` here would drop them at an unconfigured
            // PS7 banner, which is exactly the bug.
            let pwsh_dir = TempDir::new().unwrap();
            let ps_dir = TempDir::new().unwrap();
            let home = TempDir::new().unwrap();
            touch(pwsh_dir.path(), "pwsh.exe");
            touch(ps_dir.path(), "powershell.exe");
            touch_profile(home.path(), "WindowsPowerShell", DocsKind::Regular);

            let path = join_path(&[pwsh_dir.path(), ps_dir.path()]);
            let (shell, kind) = detect_windows_shell_inner(
                Some(path.as_os_str()),
                None,
                None,
                Some(home.path().as_os_str()),
            );

            assert_eq!(kind, ShellType::PowerShell);
            assert!(
                shell.ends_with("powershell.exe"),
                "PS5.1 profile should pull in powershell.exe over pwsh.exe, got {shell:?}"
            );
        }

        #[test]
        fn detects_ps51_profile_through_onedrive_redirect() {
            // The exact shape of the original bug report: PS profile
            // lives at `<USERPROFILE>\OneDrive\Documents\WindowsPowerShell\…`
            // because Office/Win11 Backup redirected Documents into
            // OneDrive. The detection must see through that redirect.
            let pwsh_dir = TempDir::new().unwrap();
            let ps_dir = TempDir::new().unwrap();
            let home = TempDir::new().unwrap();
            touch(pwsh_dir.path(), "pwsh.exe");
            touch(ps_dir.path(), "powershell.exe");
            touch_profile(home.path(), "WindowsPowerShell", DocsKind::OneDrive);

            let path = join_path(&[pwsh_dir.path(), ps_dir.path()]);
            let (shell, kind) = detect_windows_shell_inner(
                Some(path.as_os_str()),
                None,
                None,
                Some(home.path().as_os_str()),
            );

            assert_eq!(kind, ShellType::PowerShell);
            assert!(
                shell.ends_with("powershell.exe"),
                "OneDrive-redirected PS5.1 profile must beat unconfigured pwsh.exe, got {shell:?}"
            );
        }

        #[test]
        fn prefers_pwsh_when_both_profiles_present() {
            // Both profiles → modern PS wins. PS7 users who also have a
            // legacy PS5.1 profile around get PS7, which matches their
            // expectation when they explicitly installed PS7.
            let pwsh_dir = TempDir::new().unwrap();
            let ps_dir = TempDir::new().unwrap();
            let home = TempDir::new().unwrap();
            touch(pwsh_dir.path(), "pwsh.exe");
            touch(ps_dir.path(), "powershell.exe");
            touch_profile(home.path(), "PowerShell", DocsKind::Regular);
            touch_profile(home.path(), "WindowsPowerShell", DocsKind::Regular);

            let path = join_path(&[pwsh_dir.path(), ps_dir.path()]);
            let (shell, kind) = detect_windows_shell_inner(
                Some(path.as_os_str()),
                None,
                None,
                Some(home.path().as_os_str()),
            );

            assert_eq!(kind, ShellType::PowerShell);
            assert!(
                shell.ends_with("pwsh.exe"),
                "both profiles present → modern PS wins, got {shell:?}"
            );
        }

        #[test]
        fn defaults_to_pwsh_when_no_profile_signal() {
            // Both shells installed, neither has a profile → modern PS
            // is the right default. (PS7 in this state is not "broken";
            // it just shows a clean prompt with no customizations,
            // which is identical to a stock PS5.1 prompt.)
            let pwsh_dir = TempDir::new().unwrap();
            let ps_dir = TempDir::new().unwrap();
            let home = TempDir::new().unwrap();
            touch(pwsh_dir.path(), "pwsh.exe");
            touch(ps_dir.path(), "powershell.exe");

            let path = join_path(&[pwsh_dir.path(), ps_dir.path()]);
            let (shell, kind) = detect_windows_shell_inner(
                Some(path.as_os_str()),
                None,
                None,
                Some(home.path().as_os_str()),
            );

            assert_eq!(kind, ShellType::PowerShell);
            assert!(
                shell.ends_with("pwsh.exe"),
                "no profile signal → prefer pwsh.exe, got {shell:?}"
            );
        }

        #[test]
        fn falls_back_to_powershell_when_pwsh_missing() {
            let only_ps = TempDir::new().unwrap();
            touch(only_ps.path(), "powershell.exe");

            let path = join_path(&[only_ps.path()]);
            let (shell, kind) =
                detect_windows_shell_inner(Some(path.as_os_str()), None, None, None);

            assert_eq!(kind, ShellType::PowerShell);
            assert!(
                shell.ends_with("powershell.exe"),
                "expected powershell.exe fallback, got {shell:?}"
            );
        }

        #[test]
        fn falls_back_to_comspec_when_no_powershell() {
            let empty = TempDir::new().unwrap();
            let path = join_path(&[empty.path()]);
            let comspec: OsString = r"C:\Custom\cmd.exe".into();

            let (shell, kind) = detect_windows_shell_inner(
                Some(path.as_os_str()),
                Some(comspec.as_os_str()),
                None,
                None,
            );

            assert_eq!(kind, ShellType::Cmd);
            assert_eq!(shell, r"C:\Custom\cmd.exe");
        }

        #[test]
        fn ignores_empty_comspec() {
            let empty = TempDir::new().unwrap();
            let path = join_path(&[empty.path()]);
            let blank_comspec: OsString = "".into();
            let windir: OsString = r"D:\WindowsTest".into();

            let (shell, kind) = detect_windows_shell_inner(
                Some(path.as_os_str()),
                Some(blank_comspec.as_os_str()),
                Some(windir.as_os_str()),
                None,
            );

            assert_eq!(kind, ShellType::Cmd);
            assert_eq!(shell, r"D:\WindowsTest\System32\cmd.exe");
        }

        #[test]
        fn final_fallback_uses_windir_system32_cmd() {
            let empty = TempDir::new().unwrap();
            let path = join_path(&[empty.path()]);
            let windir: OsString = r"D:\WindowsTest".into();

            let (shell, kind) = detect_windows_shell_inner(
                Some(path.as_os_str()),
                None,
                Some(windir.as_os_str()),
                None,
            );

            assert_eq!(kind, ShellType::Cmd);
            assert_eq!(shell, r"D:\WindowsTest\System32\cmd.exe");
        }

        #[test]
        fn missing_windir_uses_default_c_windows() {
            let empty = TempDir::new().unwrap();
            let path = join_path(&[empty.path()]);

            let (shell, kind) =
                detect_windows_shell_inner(Some(path.as_os_str()), None, None, None);

            assert_eq!(kind, ShellType::Cmd);
            assert_eq!(shell, r"C:\Windows\System32\cmd.exe");
        }

        #[test]
        fn missing_path_still_resolves_to_cmd() {
            // No PATH at all (e.g. an exotic launchd-style minimal env)
            // should still produce a runnable shell rather than panic.
            let none: Option<&OsStr> = None;
            let (shell, kind) = detect_windows_shell_inner(none, none, none, none);
            assert_eq!(kind, ShellType::Cmd);
            assert_eq!(shell, r"C:\Windows\System32\cmd.exe");
        }
    }
}
