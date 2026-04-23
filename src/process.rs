//! Windows-safe subprocess spawning.
//!
//! When a GUI process (one linked with no attached console) spawns a child
//! via `CreateProcessW`, Windows allocates a fresh console window for the
//! child unless told otherwise. For a quiet background invocation — `git`,
//! `claude`, setup scripts, MCP servers — this surfaces as a cmd.exe window
//! that pops up, lives for the lifetime of the child, and disappears. For
//! a Tauri app that runs many short subprocesses, the flicker storm is
//! unacceptable.
//!
//! The fix is the `CREATE_NO_WINDOW` creation flag (0x08000000). This
//! trait adds a single chainable method — `.no_console_window()` — that
//! applies the flag on Windows and is a no-op on other platforms, so the
//! call site reads the same everywhere.

/// Extension trait for the two `Command` types used in this codebase
/// (`std::process::Command` and `tokio::process::Command`) that hides the
/// platform-specific incantation for suppressing the transient console
/// window Windows creates for GUI-spawned children.
///
/// Call it anywhere in the builder chain before a terminating
/// `.spawn()`/`.output()`/`.status()`:
///
/// ```ignore
/// use claudette::process::CommandWindowExt;
///
/// let out = tokio::process::Command::new("git")
///     .args(["status", "--porcelain"])
///     .no_console_window()
///     .output()
///     .await?;
/// ```
pub trait CommandWindowExt {
    /// Suppress the cmd.exe console window Windows would otherwise create
    /// for this child. No-op on Unix-likes.
    fn no_console_window(&mut self) -> &mut Self;
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

impl CommandWindowExt for std::process::Command {
    fn no_console_window(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            self.creation_flags(CREATE_NO_WINDOW);
        }
        self
    }
}

impl CommandWindowExt for tokio::process::Command {
    fn no_console_window(&mut self) -> &mut Self {
        // tokio's `Command` exposes `creation_flags` as an inherent method
        // on Windows — no `CommandExt` trait import needed here, unlike
        // the std impl above.
        #[cfg(windows)]
        self.creation_flags(CREATE_NO_WINDOW);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The trait must be callable on a newly-constructed `std::process::Command`
    /// and return `&mut Self` so it fits mid-chain with `.arg()` / `.output()`.
    /// We don't actually spawn — that would require a known-present Unix/Windows
    /// binary and makes tests flaky. The compile-and-mutate check is enough to
    /// catch breakage of the trait's shape (return type, method name, impls).
    #[test]
    fn std_command_chain_typechecks() {
        let mut cmd = std::process::Command::new("true");
        // If this compiles, the `&mut Self` return lets us keep chaining.
        let _ref: &mut std::process::Command = cmd.no_console_window().arg("-x");
    }

    #[test]
    fn tokio_command_chain_typechecks() {
        let mut cmd = tokio::process::Command::new("true");
        let _ref: &mut tokio::process::Command = cmd.no_console_window().arg("-x");
    }

    /// The trait must be idempotent: calling it twice on the same command
    /// mustn't panic, change the program name, or otherwise corrupt state.
    /// (`CommandExt::creation_flags` *sets* the value rather than OR-ing,
    /// so the second call just writes the same flag back — no bit
    /// accumulation, but the post-state is identical either way.)
    #[test]
    fn repeat_application_is_safe() {
        let mut cmd = std::process::Command::new("true");
        cmd.no_console_window();
        cmd.no_console_window();
        assert_eq!(cmd.get_program(), "true");
    }

    /// On Windows, `CREATE_NO_WINDOW` is the exact flag we want — nothing
    /// else. This guards against an accidental change to the constant (e.g.
    /// mixing up `DETACHED_PROCESS = 0x0000_0008` — close in hex but wrong
    /// semantics) without having to spawn a subprocess.
    #[cfg(windows)]
    #[test]
    fn windows_flag_is_create_no_window() {
        assert_eq!(CREATE_NO_WINDOW, 0x0800_0000);
    }

    /// On Windows, spawning a child with the flag set should succeed exactly
    /// like spawning without it — the flag only controls the console-window
    /// allocation, not the process itself. This also exercises the cfg-gated
    /// `CommandExt::creation_flags` code path end-to-end.
    #[cfg(windows)]
    #[test]
    fn windows_spawn_with_flag_succeeds() {
        // `cmd /C exit 0` is always available on Windows.
        let status = std::process::Command::new("cmd")
            .args(["/C", "exit", "0"])
            .no_console_window()
            .status()
            .expect("cmd.exe should be spawnable");
        assert!(status.success());
    }
}
