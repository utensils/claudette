//! Background polling task that watches a PTY's foreground process group
//! and emits `pty-command-detected` / `pty-command-stopped` events when the
//! foreground command starts and finishes.
//!
//! No shell cooperation is required — we read the foreground PGID directly
//! from the master PTY via `tcgetpgrp(2)` and look up the command line via
//! `ps`. This means the sidebar command indicator works for any shell on
//! Unix without any user setup, and without writing any files to disk.
//!
//! Trade-off versus the OSC 133 path it replaces: we cannot observe exit
//! codes, only the start/stop transition. The sidebar renders a neutral
//! "stopped" state when `exit_code` is `None`.
//!
//! Windows has no analog of process groups attached to the controlling
//! terminal, so this module is Unix-only. On Windows the command indicator
//! is simply absent — `spawn` is a no-op.

#[cfg(unix)]
use std::os::fd::{FromRawFd, OwnedFd};
#[cfg(unix)]
use std::sync::Arc;
#[cfg(unix)]
use std::time::Duration;

#[cfg(unix)]
use serde::Serialize;
#[cfg(unix)]
use tauri::{AppHandle, Emitter};
#[cfg(unix)]
use tokio::sync::Notify;

#[cfg(unix)]
const POLL_INTERVAL: Duration = Duration::from_millis(300);

#[derive(Clone, Serialize)]
struct CommandEvent {
    pty_id: u64,
    command: Option<String>,
    exit_code: Option<i32>,
}

/// Spawn the polling task for a PTY.
///
/// `master_fd` is a duplicate of the master PTY file descriptor — the task
/// owns it and closes it on exit, independent of the master itself. The
/// caller signals shutdown by waking `cancel`; the task exits on the next
/// poll without one further `tcgetpgrp` call.
///
/// On non-Unix platforms this is a no-op.
#[cfg(unix)]
pub fn spawn(pty_id: u64, shell_pid: i32, master_fd: OwnedFd, cancel: Arc<Notify>, app: AppHandle) {
    use std::os::fd::AsRawFd;

    tokio::spawn(async move {
        let fd = master_fd.as_raw_fd();
        let mut last_pgrp = shell_pid;
        let mut last_command: Option<String> = None;

        loop {
            tokio::select! {
                _ = cancel.notified() => break,
                _ = tokio::time::sleep(POLL_INTERVAL) => {}
            }

            // If the shell is gone, the PTY is effectively dead — stop polling.
            if !pid_alive(shell_pid) {
                break;
            }

            let fg = match foreground_pgrp(fd) {
                Some(p) => p,
                None => continue,
            };

            if fg == last_pgrp {
                continue;
            }

            if fg == shell_pid {
                // Returned to the shell prompt — command finished.
                let _ = app.emit(
                    "pty-command-stopped",
                    CommandEvent {
                        pty_id,
                        command: last_command.take(),
                        exit_code: None,
                    },
                );
            } else {
                // New foreground group — a command started.
                let cmd = lookup_command(fg);
                last_command = cmd.clone();
                let _ = app.emit(
                    "pty-command-detected",
                    CommandEvent {
                        pty_id,
                        command: cmd,
                        exit_code: None,
                    },
                );
            }

            last_pgrp = fg;
        }

        drop(master_fd);
    });
}

/// No-op shim on non-Unix platforms.
#[cfg(not(unix))]
pub fn spawn(
    _pty_id: u64,
    _shell_pid: i32,
    _master_fd: (),
    _cancel: std::sync::Arc<tokio::sync::Notify>,
    _app: tauri::AppHandle,
) {
}

/// Duplicate the master PTY's file descriptor so the polling task can own a
/// copy with an independent lifetime. Returns `None` on non-Unix or if the
/// master does not expose a raw FD.
#[cfg(unix)]
pub fn dup_master_fd(master: &dyn portable_pty::MasterPty) -> Option<OwnedFd> {
    let raw = master.as_raw_fd()?;
    let dup = unsafe { libc::dup(raw) };
    if dup < 0 {
        return None;
    }
    Some(unsafe { OwnedFd::from_raw_fd(dup) })
}

#[cfg(not(unix))]
pub fn dup_master_fd(_master: &dyn portable_pty::MasterPty) -> Option<()> {
    None
}

#[cfg(unix)]
fn foreground_pgrp(fd: i32) -> Option<i32> {
    let pgrp = unsafe { libc::tcgetpgrp(fd) };
    if pgrp < 0 { None } else { Some(pgrp) }
}

#[cfg(unix)]
fn pid_alive(pid: i32) -> bool {
    // kill(pid, 0) succeeds iff the process exists and we have signal
    // permissions for it. ESRCH means the pid is gone; anything else
    // (including EPERM) we treat as "still alive" so a transient permission
    // error doesn't kill the tracker.
    let r = unsafe { libc::kill(pid, 0) };
    if r == 0 {
        return true;
    }
    errno() != libc::ESRCH
}

#[cfg(all(unix, any(target_os = "macos", target_os = "ios")))]
fn errno() -> i32 {
    unsafe { *libc::__error() }
}

#[cfg(all(unix, not(any(target_os = "macos", target_os = "ios"))))]
fn errno() -> i32 {
    unsafe { *libc::__errno_location() }
}

#[cfg(unix)]
fn lookup_command(pid: i32) -> Option<String> {
    // `ps -o args= -p <pid>` prints the full argv for a single pid with no
    // header. Works identically on macOS and Linux. Output is at most one
    // line; trim whitespace to drop the trailing newline.
    let output = std::process::Command::new("ps")
        .arg("-o")
        .arg("args=")
        .arg("-p")
        .arg(pid.to_string())
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use super::*;

    #[test]
    fn pid_alive_for_self() {
        let me = std::process::id() as i32;
        assert!(pid_alive(me));
    }

    #[test]
    fn pid_alive_false_for_unused_pid() {
        // PID 1 is always alive (init); use a clearly bogus high value.
        // There's no portable way to guarantee a free pid, so we settle
        // for "if it happens to exist this test is flaky" — use i32::MAX
        // which is well above the kernel's typical max_pid.
        assert!(!pid_alive(i32::MAX));
    }

    #[test]
    fn lookup_command_for_self_returns_something() {
        let me = std::process::id() as i32;
        let cmd = lookup_command(me);
        assert!(cmd.is_some(), "ps should find this test process");
        assert!(!cmd.unwrap().is_empty());
    }
}
