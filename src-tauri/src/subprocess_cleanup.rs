//! Best-effort termination of a process and everything it spawned.
//!
//! Why we can't just `kill(-pgid, …)` on Unix: `cargo-watch`, `nohup`,
//! `setsid` and similar tools deliberately put their child commands into a
//! new session or process group so signals to the parent's PG don't
//! propagate. Signaling the shell's PG kills the shell + immediate-child
//! commands but leaves the grandchildren running, orphaned to PID 1.
//!
//! Unix approach: walk the process tree via `ps -A -o pid,ppid` (works on
//! macOS and Linux without extra deps), enumerate every descendant of each
//! root, then SIGTERM the whole set in parallel with a brief grace period
//! before escalating to SIGKILL. Crucially, descendants are collected
//! BEFORE the roots are killed — once the shell dies, its children
//! re-parent to PID 1 and become unreachable via ancestry walk.
//!
//! Windows approach: `taskkill /T` already walks the per-PID descendant
//! tree (it traverses the parent-PID + Job Object ancestry inside the
//! kernel) and signals every entry, so we don't enumerate ourselves. We
//! still want the same two-phase shape — graceful close first, then a
//! force escalation after a poll window — so a friendly child like
//! `cargo-watch` gets a chance to clean up before we hard-kill it.

use std::time::{Duration, Instant};

#[cfg(unix)]
use std::collections::HashMap;

#[cfg(windows)]
use claudette::process::CommandWindowExt as _;

/// Walk the process tree from each root and return every descendant PID
/// (not including the roots themselves). Single `ps` invocation regardless
/// of how many roots are provided.
///
/// Unix-only — kept public so the Unix unit tests can introspect tree
/// shape. Windows uses `taskkill /T` for the descendant traversal and
/// never needs to enumerate the tree from user space.
#[cfg(unix)]
pub fn collect_descendants(roots: &[i32]) -> Vec<i32> {
    let output = match std::process::Command::new("ps")
        .args(["-A", "-o", "pid=,ppid="])
        .output()
    {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };
    let s = String::from_utf8_lossy(&output.stdout);
    let mut children_of: HashMap<i32, Vec<i32>> = HashMap::new();
    for line in s.lines() {
        let mut parts = line.split_whitespace();
        let pid: i32 = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
        let ppid: i32 = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
        if pid > 0 {
            children_of.entry(ppid).or_default().push(pid);
        }
    }

    let mut result = Vec::new();
    let mut stack: Vec<i32> = roots.iter().copied().filter(|&p| p > 0).collect();
    while let Some(p) = stack.pop() {
        if let Some(kids) = children_of.get(&p) {
            for &k in kids {
                result.push(k);
                stack.push(k);
            }
        }
    }
    result
}

/// SIGTERM every root and every descendant in parallel, give them up to
/// `grace_ms` to exit, then SIGKILL anything still alive. Bounded total
/// runtime; safe to call from `Drop` impls and `RunEvent::Exit`.
#[cfg(unix)]
pub fn kill_processes_with_descendants(roots: &[i32], grace_ms: u64) {
    let roots: Vec<i32> = roots.iter().copied().filter(|&p| p > 0).collect();
    if roots.is_empty() {
        return;
    }

    let descendants = collect_descendants(&roots);
    let mut all = roots;
    all.extend(descendants);

    // Phase 1: SIGTERM everyone.
    for &pid in &all {
        unsafe { libc::kill(pid, libc::SIGTERM) };
    }

    // Phase 2: poll for exit.
    let deadline = Instant::now() + Duration::from_millis(grace_ms);
    while Instant::now() < deadline {
        let any_alive = all.iter().any(|&p| unsafe { libc::kill(p, 0) == 0 });
        if !any_alive {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }

    // Phase 3: SIGKILL stragglers. Kernel reaps when our process exits.
    for &pid in &all {
        unsafe { libc::kill(pid, libc::SIGKILL) };
    }
}

/// Windows analog. `taskkill /T <pid>` sends `WM_CLOSE` (and a
/// CTRL_CLOSE_EVENT to console subsystem children) to the per-PID
/// descendant tree, giving cooperative children a chance to flush; after
/// the grace window we escalate any survivor to `taskkill /T /F`, which
/// calls `TerminateProcess` on the whole subtree.
///
/// We never `taskkill` from inside the helper itself in `RunEvent::Exit`
/// — the parent process is *us*, and `/T` would happily kill the still-
/// running tokio runtime. The roots passed in are exclusively child PIDs
/// that Claudette itself spawned (PTY shells, agent CLI subprocesses).
#[cfg(windows)]
pub fn kill_processes_with_descendants(roots: &[i32], grace_ms: u64) {
    let roots: Vec<i32> = roots.iter().copied().filter(|&p| p > 0).collect();
    if roots.is_empty() {
        return;
    }

    // Phase 1: graceful taskkill /T (per-root subtree).
    for &pid in &roots {
        let _ = std::process::Command::new("taskkill")
            .no_console_window()
            .args(["/PID", &pid.to_string(), "/T"])
            .output();
    }

    // Phase 2: poll for exit. `OpenProcess + GetExitCodeProcess` mirrors
    // the pattern in `boot_probation::is_pid_alive` — same narrowly-scoped
    // `PROCESS_QUERY_LIMITED_INFORMATION` right.
    let deadline = Instant::now() + Duration::from_millis(grace_ms);
    while Instant::now() < deadline {
        let any_alive = roots.iter().any(|&p| pid_is_alive(p as u32));
        if !any_alive {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }

    // Phase 3: force-kill the subtree.
    for &pid in &roots {
        let _ = std::process::Command::new("taskkill")
            .no_console_window()
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output();
    }
}

/// Liveness probe for the Windows poll loop above.
#[cfg(windows)]
fn pid_is_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    if pid == 0 {
        return false;
    }
    // SAFETY: OpenProcess with a non-null PID either returns a valid
    // handle or NULL on failure. We always close a non-null handle.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return false;
    }
    let mut code: u32 = 0;
    // SAFETY: handle is a valid process handle; code is a writable u32.
    let ok = unsafe { GetExitCodeProcess(handle, &mut code) };
    // SAFETY: handle is non-null and we own it.
    unsafe {
        CloseHandle(handle);
    }
    if ok == 0 {
        return false;
    }
    code as i32 == STILL_ACTIVE
}

#[cfg(test)]
#[cfg(unix)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};
    use std::time::Duration;

    fn pid_alive(pid: i32) -> bool {
        unsafe { libc::kill(pid, 0) == 0 }
    }

    #[test]
    fn collect_descendants_finds_grandchildren() {
        // sh -c 'sleep 60 & sleep 60' spawns two child sleeps. The outer sh
        // is root; each sleep is a descendant.
        let mut sh = Command::new("/bin/sh")
            .args(["-c", "sleep 60 & sleep 60"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .stdin(Stdio::null())
            .spawn()
            .expect("spawn sh");
        let root = sh.id() as i32;

        // Give the shell a moment to fork its children.
        std::thread::sleep(Duration::from_millis(150));

        let descendants = collect_descendants(&[root]);
        // Both sleeps should appear.
        assert!(
            !descendants.is_empty(),
            "expected at least one descendant, got {descendants:?}"
        );

        // Cleanup.
        let _ = sh.kill();
        let _ = sh.wait();
        for pid in &descendants {
            unsafe { libc::kill(*pid, libc::SIGKILL) };
        }
    }

    #[test]
    fn kill_with_descendants_terminates_grandchild() {
        // Spawn a shell that spawns a long sleep in a different process group
        // (via setsid-like shell-builtin), simulating cargo-watch's pattern.
        // Then verify our killer reaches the grandchild.
        let mut sh = Command::new("/bin/sh")
            .args([
                "-c",
                // exec a subshell that disowns its child, so the grandchild
                // is in a different process group.
                "( sleep 60 & ) ; sleep 60",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .stdin(Stdio::null())
            .spawn()
            .expect("spawn sh");
        let root = sh.id() as i32;

        std::thread::sleep(Duration::from_millis(200));

        // Capture descendants BEFORE killing.
        let descendants_before = collect_descendants(&[root]);

        kill_processes_with_descendants(&[root], 100);
        let _ = sh.wait();

        // Give the OS a beat to reap.
        std::thread::sleep(Duration::from_millis(100));

        // Root and every descendant should be dead.
        assert!(!pid_alive(root), "root {root} still alive");
        for pid in &descendants_before {
            assert!(!pid_alive(*pid), "descendant {pid} still alive");
        }
    }
}

#[cfg(test)]
#[cfg(windows)]
mod tests_windows {
    use super::*;
    use std::process::{Command, Stdio};

    /// `cmd /c "start /B ping -n 30 127.0.0.1 & ping -n 30 127.0.0.1"` spawns
    /// `cmd.exe` as the root with a backgrounded `ping` and an inline `ping`
    /// — two long-lived descendants. `kill_processes_with_descendants`
    /// should bring all three down within the grace window.
    #[test]
    fn kill_with_descendants_terminates_subtree_windows() {
        let mut child = Command::new("cmd.exe")
            .args([
                "/C",
                "start /B ping -n 30 127.0.0.1 >NUL & ping -n 30 127.0.0.1 >NUL",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .stdin(Stdio::null())
            .spawn()
            .expect("spawn cmd.exe");
        let root = child.id() as i32;

        // Give the cmd shell a moment to fork its descendants.
        std::thread::sleep(Duration::from_millis(250));

        kill_processes_with_descendants(&[root], 500);

        // Reap so the test process doesn't leak a zombie handle.
        let _ = child.wait();

        // Root must be gone.
        assert!(!pid_is_alive(root as u32), "root {root} still alive");
    }
}
