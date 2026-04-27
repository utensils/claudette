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
//! codes, only the start/stop transition — `pty-command-stopped` carries
//! `exit_code: None` and the frontend reacts by removing the entry from
//! the workspace's running-command map (no separate "stopped" state).
//!
//! Windows has no analog of process groups attached to the controlling
//! terminal, so this module is Unix-only. On Windows the command indicator
//! is simply absent — call sites are gated by `#[cfg(unix)]`.

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

#[cfg(unix)]
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
        // Seed `last_pgrp` from the actual foreground PGID rather than
        // assuming it equals the shell's PID. They usually match right
        // after spawn (the shell becomes session leader), but if the
        // shell has already forked a child by the time the tracker
        // starts, using `shell_pid` would treat the existing foreground
        // group as a brand-new transition and emit a spurious
        // `pty-command-detected`.
        let mut last_pgrp = foreground_pgrp(fd).unwrap_or(shell_pid);
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
                let cmd = lookup_command(fg).await;
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

/// Duplicate the master PTY's file descriptor so the polling task can own a
/// copy with an independent lifetime. The duplicated FD is set close-on-exec
/// so child processes spawned by the app (Claude CLI agents, PTY shells)
/// don't inherit it — otherwise they'd hold the PTY open and we'd never see
/// EOF on the original master. Returns `None` if the master does not expose
/// a raw FD or if the dup/fcntl syscalls fail.
#[cfg(unix)]
pub fn dup_master_fd(master: &dyn portable_pty::MasterPty) -> Option<OwnedFd> {
    let raw = master.as_raw_fd()?;
    let dup = unsafe { libc::dup(raw) };
    if dup < 0 {
        return None;
    }
    let flags = unsafe { libc::fcntl(dup, libc::F_GETFD) };
    if flags < 0 {
        unsafe { libc::close(dup) };
        return None;
    }
    if unsafe { libc::fcntl(dup, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
        unsafe { libc::close(dup) };
        return None;
    }
    Some(unsafe { OwnedFd::from_raw_fd(dup) })
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
async fn lookup_command(pid: i32) -> Option<String> {
    // `ps -o args= -p <pid>` prints the full argv for a single pid with no
    // header. Works identically on macOS and Linux. Output is at most one
    // line; trim whitespace to drop the trailing newline.
    //
    // Use tokio::process::Command so the syscall doesn't block the worker
    // thread — multiple PTYs each fire this on every command transition.
    let output = tokio::process::Command::new("ps")
        .arg("-o")
        .arg("args=")
        .arg("-p")
        .arg(pid.to_string())
        .output()
        .await
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

    #[tokio::test]
    async fn lookup_command_for_self_returns_something() {
        let me = std::process::id() as i32;
        let cmd = lookup_command(me).await;
        assert!(cmd.is_some(), "ps should find this test process");
        assert!(!cmd.unwrap().is_empty());
    }
}
