//! Path-normalization helpers for cross-platform subprocess handoff.
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
