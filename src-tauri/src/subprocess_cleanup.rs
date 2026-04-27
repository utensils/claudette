//! Best-effort termination of a process and everything it spawned.
//!
//! Why we can't just `kill(-pgid, …)`: `cargo-watch`, `nohup`, `setsid` and
//! similar tools deliberately put their child commands into a new session or
//! process group so signals to the parent's PG don't propagate. Signaling the
//! shell's PG kills the shell + immediate-child commands but leaves the
//! grandchildren running, orphaned to PID 1.
//!
//! Approach: walk the process tree via `ps -A -o pid,ppid` (works on macOS
//! and Linux without extra deps), enumerate every descendant of each root,
//! then SIGTERM the whole set in parallel with a brief grace period before
//! escalating to SIGKILL. Crucially, descendants are collected BEFORE the
//! roots are killed — once the shell dies, its children re-parent to PID 1
//! and become unreachable via ancestry walk.

#[cfg(unix)]
use std::collections::HashMap;
#[cfg(unix)]
use std::time::{Duration, Instant};

/// Walk the process tree from each root and return every descendant PID
/// (not including the roots themselves). Single `ps` invocation regardless
/// of how many roots are provided.
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
