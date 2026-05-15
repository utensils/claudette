//! Path-normalization helpers for cross-platform subprocess handoff,
//! plus the canonical resolvers for Claudette's two on-disk roots:
//!
//! - [`claudette_home`] — the `~/.claudette/` tree (workspaces, plugins,
//!   logs, themes, cesp). Override with `$CLAUDETTE_HOME`.
//! - [`data_dir`] — the OS data directory holding `claudette.db`. On
//!   macOS `~/Library/Application Support/claudette/`; Linux
//!   `$XDG_DATA_HOME/claudette/`; Windows `%APPDATA%/claudette/`.
//!   Override with `$CLAUDETTE_DATA_DIR`.
//!
//! The two are deliberately distinct: the DB lives in the OS data dir so
//! it follows backup conventions; the rest lives under `~/.claudette/` so
//! users can discover and edit workspaces, plugins, and themes from a
//! single visible tree.
//!
//! ## Windows verbatim paths
//!
//! On Windows, `std::fs::canonicalize` / `tokio::fs::canonicalize` return a
//! *verbatim* path — `\\?\C:\Users\...`. The `\\?\` prefix disables
//! Win32 name normalization and enables long-path support, which is great
//! for Win32 file APIs but breaks anything that interprets the path as a
//! command-line CWD. In particular, `cmd.exe` sees the leading `\\`,
//! classifies it as a UNC share, refuses to `chdir` into it, and falls back
//! to `C:\Windows` with the warning:
//!
//! ```text
//! '\\?\C:\Users\foo\workspace'
//! CMD.EXE was started with the above path as the current directory.
//! UNC paths are not supported. Defaulting to Windows directory.
//! ```
//!
//! We hand canonical paths to `portable-pty` as the child CWD, which
//! eventually reaches `cmd.exe` (or any shell a user configures), so we
//! must strip the prefix before it leaves the Rust side.

use std::path::PathBuf;

/// Resolve the `~/.claudette/` tree root. Honors `$CLAUDETTE_HOME` so a
/// fresh-user dev session (`scripts/dev.sh --new`) or a cloned-state
/// dev session (`scripts/dev.sh --clone`) can be sandboxed into a tmp
/// directory without touching the real user state.
///
/// Falls back to `./.claudette` when `dirs::home_dir()` itself fails —
/// extremely unusual, mostly affects sandboxed CI.
pub fn claudette_home() -> PathBuf {
    if let Ok(custom) = std::env::var("CLAUDETTE_HOME")
        && !custom.is_empty()
    {
        return PathBuf::from(custom);
    }
    dirs::home_dir()
        .map(|h| h.join(".claudette"))
        .unwrap_or_else(|| PathBuf::from(".claudette"))
}

/// Resolve the OS data directory holding `claudette.db`. Honors
/// `$CLAUDETTE_DATA_DIR` for the same reason as [`claudette_home`].
///
/// Falls back to `./claudette` when `dirs::data_dir()` fails (very rare;
/// the closure was preserved from pre-helper inline code).
pub fn data_dir() -> PathBuf {
    if let Ok(custom) = std::env::var("CLAUDETTE_DATA_DIR")
        && !custom.is_empty()
    {
        return PathBuf::from(custom);
    }
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("claudette")
}

/// Strip the `\\?\` verbatim-path prefix when it hides a plain
/// drive-letter path (`\\?\C:\...`). Leaves the string untouched when the
/// prefix is absent or when stripping would change semantics — notably
/// `\\?\UNC\server\share\...`, which is a *real* UNC path that must keep
/// its verbatim form to stay valid.
///
/// Pure string manipulation — testable on every platform, even though it
/// only has practical effect on Windows-origin paths.
pub fn strip_verbatim_prefix(s: &str) -> &str {
    let Some(rest) = s.strip_prefix(r"\\?\") else {
        return s;
    };
    let bytes = rest.as_bytes();
    // Drive-letter form: ASCII letter followed by ':'. Reject anything
    // else (including `\\?\UNC\...` and the empty tail) so we never
    // rewrite a UNC verbatim path into a broken shorter one.
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        rest
    } else {
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The env-override paths are guarded against process-wide bleed by an
    // OnceLock mutex — tests in this module mutate `$CLAUDETTE_HOME` and
    // `$CLAUDETTE_DATA_DIR`, which are read by other suites that run in
    // the same `cargo test` process. Without the mutex one test could see
    // another's override mid-run.
    use std::sync::{Mutex, OnceLock};
    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    #[test]
    fn claudette_home_honors_env_override() {
        let _guard = env_lock().lock().unwrap_or_else(|p| p.into_inner());
        // SAFETY: protected by env_lock() so no other test in this binary
        // is reading these vars while we mutate them.
        unsafe { std::env::set_var("CLAUDETTE_HOME", "/tmp/fresh-user-home") };
        assert_eq!(claudette_home(), PathBuf::from("/tmp/fresh-user-home"));
        unsafe { std::env::remove_var("CLAUDETTE_HOME") };
    }

    #[test]
    fn claudette_home_ignores_empty_env() {
        let _guard = env_lock().lock().unwrap_or_else(|p| p.into_inner());
        unsafe { std::env::set_var("CLAUDETTE_HOME", "") };
        // Empty value falls through to the home-dir default rather than
        // becoming a relative `""` path that would land in CWD.
        let home = claudette_home();
        assert!(home.ends_with(".claudette"), "got {home:?}");
        unsafe { std::env::remove_var("CLAUDETTE_HOME") };
    }

    #[test]
    fn data_dir_honors_env_override() {
        let _guard = env_lock().lock().unwrap_or_else(|p| p.into_inner());
        unsafe { std::env::set_var("CLAUDETTE_DATA_DIR", "/tmp/fresh-user-data") };
        assert_eq!(data_dir(), PathBuf::from("/tmp/fresh-user-data"));
        unsafe { std::env::remove_var("CLAUDETTE_DATA_DIR") };
    }

    #[test]
    fn strips_drive_letter_verbatim_prefix() {
        assert_eq!(
            strip_verbatim_prefix(r"\\?\C:\Users\brink\workspace"),
            r"C:\Users\brink\workspace",
        );
    }

    #[test]
    fn strips_lowercase_drive_letter() {
        assert_eq!(strip_verbatim_prefix(r"\\?\c:\foo"), r"c:\foo");
    }

    #[test]
    fn strips_bare_drive_root() {
        // The shortest legal drive-letter verbatim path — just `\\?\C:` with
        // no trailing component. Stripping still yields a valid drive spec.
        assert_eq!(strip_verbatim_prefix(r"\\?\C:"), r"C:");
    }

    #[test]
    fn preserves_real_unc_verbatim_path() {
        // `\\?\UNC\server\share\...` is the verbatim form of `\\server\share\...`
        // and must keep the prefix — dropping it would produce `UNC\server\share`,
        // which is not a valid UNC path at all.
        let unc = r"\\?\UNC\server\share\file.txt";
        assert_eq!(strip_verbatim_prefix(unc), unc);
    }

    #[test]
    fn preserves_non_verbatim_paths_unchanged() {
        assert_eq!(strip_verbatim_prefix(r"C:\Users\brink"), r"C:\Users\brink");
        assert_eq!(strip_verbatim_prefix("/home/brink"), "/home/brink");
        assert_eq!(strip_verbatim_prefix(""), "");
    }

    #[test]
    fn preserves_malformed_verbatim_prefix() {
        // `\\?\` with a single-character tail — no colon, not a drive spec.
        // Stripping would hand `X` downstream, which is just a relative name.
        assert_eq!(strip_verbatim_prefix(r"\\?\X"), r"\\?\X");
        // Empty tail after the prefix — same reasoning.
        assert_eq!(strip_verbatim_prefix(r"\\?\"), r"\\?\");
        // Digit "drive" — real Windows drive letters are A–Z only.
        assert_eq!(strip_verbatim_prefix(r"\\?\1:\foo"), r"\\?\1:\foo");
    }
}
