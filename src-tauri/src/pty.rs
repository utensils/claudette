use std::io::{Read, Write};
use std::sync::Mutex;

use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::commands::shell::detect_user_shell;
use crate::state::{AppState, PtyHandle};

#[derive(Clone, Serialize)]
struct PtyOutputPayload {
    pty_id: u64,
    data: Vec<u8>,
}

#[derive(Clone, Serialize)]
struct PtyExitPayload {
    pty_id: u64,
}

#[tauri::command]
pub async fn detect_shell() -> Result<String, String> {
    let (shell, _) = detect_user_shell();
    Ok(shell)
}

/// Configure the standard environment variables for a Claudette PTY session.
///
/// xterm.js implements xterm-compatible escape sequences, so we set `TERM`
/// accordingly. Without this, release builds launched from Dock/Finder
/// inherit a minimal launchd environment with no `TERM`, causing doubled
/// input and broken `clear`/`tput`.
fn configure_pty_env(cmd: &mut CommandBuilder) {
    cmd.env("TERM", "xterm-256color");
    cmd.env("CLAUDETTE_PTY", "1");
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn spawn_pty(
    working_dir: String,
    workspace_name: String,
    workspace_id: String,
    root_path: String,
    default_branch: String,
    branch_name: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<u64, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {e}"))?;

    // On Windows, worktree paths created before the `\\?\`-stripping fix
    // landed may still be stored in the DB as verbatim paths. `cmd.exe`
    // refuses to chdir into a verbatim path and falls back to C:\Windows,
    // which is exactly the symptom we just fixed at creation time. Strip
    // here too so existing workspaces open in the right directory without
    // a data migration.
    let working_dir = claudette::path::strip_verbatim_prefix(&working_dir).to_string();

    let mut cmd = CommandBuilder::new_default_prog();
    cmd.cwd(&working_dir);
    configure_pty_env(&mut cmd);

    // Resolve the env-provider layer for this workspace.
    // Unlike the agent spawn path, the PTY hosts an interactive shell that
    // runs the user's profile — so ~/.zprofile / ~/.bashrc / direnv shell
    // hooks will ALSO layer env on top of whatever we set here. The result
    // is: our CLAUDETTE_* markers + direnv/mise/dotenv/nix-devshell env is
    // the "base" the shell inherits; the user's shell profile runs after
    // and can override/add if they want.
    let ws_info = claudette::plugin_runtime::host_api::WorkspaceInfo {
        id: workspace_id.clone(),
        name: workspace_name.clone(),
        branch: branch_name.clone(),
        worktree_path: working_dir.clone(),
        repo_path: root_path.clone(),
    };
    let disabled_env_providers = {
        // Look up repo_id + per-repo env-provider disables in a single
        // DB open — this runs on every PTY spawn, so avoid duplicate
        // opens and workspace-list scans.
        use claudette::db::Database;
        Database::open(&state.db_path)
            .ok()
            .map(|db| {
                let repo_id = db
                    .list_workspaces()
                    .ok()
                    .and_then(|ws| {
                        ws.into_iter()
                            .find(|w| w.id == workspace_id)
                            .map(|w| w.repository_id)
                    })
                    .unwrap_or_default();
                if repo_id.is_empty() {
                    Default::default()
                } else {
                    crate::commands::env::load_disabled_providers(&db, &repo_id)
                }
            })
            .unwrap_or_default()
    };
    let resolved_env = {
        let registry = state.plugins.read().await;
        claudette::env_provider::resolve_with_registry(
            &registry,
            &state.env_cache,
            std::path::Path::new(&working_dir),
            &ws_info,
            &disabled_env_providers,
        )
        .await
    };
    crate::commands::env::register_resolved_with_watcher(
        &state,
        std::path::Path::new(&working_dir),
        &resolved_env.sources,
    )
    .await;
    for (k, v) in &resolved_env.vars {
        match v {
            Some(val) => cmd.env(k, val),
            // portable-pty's CommandBuilder inherits the base env, so
            // None-valued entries must be explicitly removed rather
            // than just skipped — otherwise the interactive shell
            // silently picks up the parent-process value.
            None => cmd.env_remove(k),
        }
    }

    // Set workspace context env vars for scripts and tools. Applied AFTER
    // resolved_env so CLAUDETTE_* markers always win.
    let ws_env = claudette::env::WorkspaceEnv {
        workspace_name,
        workspace_id,
        workspace_path: working_dir.clone(),
        root_path,
        default_branch,
        branch_name,
    };
    for (k, v) in ws_env.vars() {
        cmd.env(k, v);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn shell: {e}"))?;

    // Drop slave — we only need the master side.
    drop(pair.slave);

    let pty_id = state.next_pty_id();

    // Take reader and writer from the master.
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone PTY reader: {e}"))?;

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to take PTY writer: {e}"))?;

    // Background reader: forwards PTY output to xterm.js as Tauri events.
    let emitter_app = app.clone();
    let reader_pty_id = pty_id;

    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let payload = PtyOutputPayload {
                        pty_id: reader_pty_id,
                        data: buf[..n].to_vec(),
                    };
                    let _ = emitter_app.emit("pty-output", &payload);
                }
                Err(_) => break,
            }
        }
        // Reader saw EOF (or read error) — the shell process closed its end
        // of the PTY. Notify the frontend so it can tear down the pane and
        // tab. Closing via the user typing `exit` is the common case.
        let _ = emitter_app.emit(
            "pty-exit",
            &PtyExitPayload {
                pty_id: reader_pty_id,
            },
        );
    });

    // Spawn the foreground-process-group polling task. This drives the
    // sidebar command indicator without requiring shell-side cooperation.
    // Skipped on Windows (no POSIX process groups) and if we can't read
    // either the master FD or the shell's pid.
    let tracker_cancel = {
        #[cfg(unix)]
        {
            let shell_pid = child.process_id().map(|p| p as i32);
            let dup_fd = crate::pty_tracker::dup_master_fd(&*pair.master);
            match (shell_pid, dup_fd) {
                (Some(pid), Some(fd)) => {
                    let cancel = std::sync::Arc::new(tokio::sync::Notify::new());
                    crate::pty_tracker::spawn(pty_id, pid, fd, cancel.clone(), app.clone());
                    Some(cancel)
                }
                _ => None,
            }
        }
        #[cfg(not(unix))]
        {
            None
        }
    };

    let handle = PtyHandle {
        writer: Mutex::new(writer),
        master: Mutex::new(pair.master),
        child: Mutex::new(child),
        tracker_cancel,
    };

    state.ptys.write().await.insert(pty_id, handle);

    Ok(pty_id)
}

#[tauri::command]
pub async fn write_pty(
    pty_id: u64,
    data: Vec<u8>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let ptys = state.ptys.read().await;
    let handle = ptys.get(&pty_id).ok_or("PTY not found")?;

    let mut writer = handle
        .writer
        .lock()
        .map_err(|e| format!("Lock error: {e}"))?;

    writer
        .write_all(&data)
        .map_err(|e| format!("Write failed: {e}"))?;

    Ok(())
}

#[tauri::command]
pub async fn resize_pty(
    pty_id: u64,
    cols: u16,
    rows: u16,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let ptys = state.ptys.read().await;
    let handle = ptys.get(&pty_id).ok_or("PTY not found")?;

    let master = handle
        .master
        .lock()
        .map_err(|e| format!("Lock error: {e}"))?;

    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Resize failed: {e}"))
}

/// Interrupt the foreground process group of a PTY — the same effect as the
/// user pressing Ctrl+C in the terminal, invoked from outside the terminal
/// (e.g. the sidebar's running-commands list).
///
/// On Unix, we read the foreground PGID from the master FD via `tcgetpgrp`
/// and send `SIGINT` to that group. This bypasses TTY line discipline, so it
/// works even for programs that put the terminal in raw mode (TUIs/editors).
///
/// On Windows there are no POSIX process groups, so we fall back to writing
/// `\x03` (ETX) into the PTY. That delivers SIGINT-equivalent only when the
/// child has line discipline enabled, but covers the common shell case.
#[tauri::command]
pub async fn interrupt_pty_foreground(
    pty_id: u64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let ptys = state.ptys.read().await;
    let handle = ptys.get(&pty_id).ok_or("PTY not found")?;

    #[cfg(unix)]
    {
        let pgrp = {
            let master = handle
                .master
                .lock()
                .map_err(|e| format!("Lock error: {e}"))?;
            let raw = master
                .as_raw_fd()
                .ok_or("Master PTY does not expose a raw FD")?;
            unsafe { libc::tcgetpgrp(raw) }
        };
        // No foreground group (e.g. shell exited or backgrounded the
        // command) — treat as a no-op rather than an error so the UI
        // doesn't surface noise when the user clicks stale entries.
        if pgrp <= 0 {
            return Ok(());
        }
        // SAFETY: `kill(-pgrp, SIGINT)` is the standard POSIX way to deliver
        // SIGINT to every process in the group.
        let r = unsafe { libc::kill(-pgrp, libc::SIGINT) };
        if r == 0 {
            return Ok(());
        }
        let err = std::io::Error::last_os_error();
        // ESRCH means the group exited between our `tcgetpgrp` and `kill` —
        // race with normal termination, not a failure the user should see.
        if err.raw_os_error() == Some(libc::ESRCH) {
            return Ok(());
        }
        Err(format!("Failed to interrupt PTY foreground group: {err}"))
    }

    #[cfg(not(unix))]
    {
        use std::io::Write;
        let mut writer = handle
            .writer
            .lock()
            .map_err(|e| format!("Lock error: {e}"))?;
        writer
            .write_all(&[0x03])
            .map_err(|e| format!("Write failed: {e}"))?;
        Ok(())
    }
}

#[tauri::command]
pub async fn close_pty(pty_id: u64, state: State<'_, AppState>) -> Result<(), String> {
    // Pull the handle out under the write lock, then release it before doing
    // any blocking work (subtree walk, signals, the 100ms grace sleep).
    // Otherwise other PTY operations (spawn / write / resize / close) on
    // unrelated PTYs serialize behind this one for ~100ms.
    let handle = {
        let mut ptys = state.ptys.write().await;
        ptys.remove(&pty_id)
    };

    let Some(handle) = handle else {
        return Ok(());
    };

    // Wake the tracker first so it drops its duplicated master FD before
    // the handle (and the original master) goes out of scope.
    if let Some(cancel) = &handle.tracker_cancel {
        cancel.notify_one();
    }
    if let Ok(mut child) = handle.child.into_inner() {
        // Walk the shell's subtree and kill every descendant before the
        // shell itself, so cargo-watch-style grandchildren don't survive
        // by being orphaned to launchd. 100ms grace for graceful exit.
        // The walk shells out to `ps` and uses `std::thread::sleep` for
        // the grace window — wrap in spawn_blocking so we don't block
        // a tokio worker for the duration.
        #[cfg(unix)]
        if let Some(pid) = child.process_id() {
            let _ = tokio::task::spawn_blocking(move || {
                crate::subprocess_cleanup::kill_processes_with_descendants(&[pid as i32], 100);
            })
            .await;
        }
        // Belt-and-suspenders: portable-pty's kill (SIGKILL on Unix,
        // TerminateProcess on Windows) ensures the shell is gone if the
        // subtree walk didn't catch it. Then `wait()` to reap so we
        // don't leave a zombie. Both calls are blocking — wrap in
        // spawn_blocking for the same reason as above.
        let _ = tokio::task::spawn_blocking(move || {
            let _ = child.kill();
            let _ = child.wait();
        })
        .await;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Smoke tests
//
// The Tauri-wrapped `spawn_pty` / `write_pty` / `close_pty` commands require
// an `AppHandle` and `State<AppState>` which are awkward to wire up in unit
// tests. These tests exercise the exact `portable_pty` integration used by
// `spawn_pty` (open master/slave, spawn_command, try_clone_reader,
// take_writer, kill child) against `/bin/sh`, so a regression in the PTY
// bring-up path gets caught in CI even without a full Tauri harness.
// ---------------------------------------------------------------------------
#[cfg(test)]
#[cfg(unix)]
mod tests {
    use portable_pty::{CommandBuilder, PtySize, native_pty_system};
    use std::io::Read;
    use std::time::{Duration, Instant};

    /// Spawn a short-lived `sh -c <script>` in a PTY, using the same
    /// `configure_pty_env` helper as production code. Returns the master,
    /// child, and a reader for the PTY output.
    fn open_sh(
        script: &str,
    ) -> (
        Box<dyn portable_pty::MasterPty + Send>,
        Box<dyn portable_pty::Child + Send>,
        Box<dyn Read + Send>,
    ) {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty should succeed");

        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args(["-c", script]);
        super::configure_pty_env(&mut cmd);

        let child = pair
            .slave
            .spawn_command(cmd)
            .expect("spawn_command should succeed");

        drop(pair.slave);

        let reader = pair
            .master
            .try_clone_reader()
            .expect("try_clone_reader should succeed");

        (pair.master, child, reader)
    }

    /// Drain the reader with a wall-clock deadline so the test cannot hang
    /// even if the PTY somehow stays open forever.
    fn read_with_deadline(mut reader: Box<dyn Read + Send>, deadline: Duration) -> Vec<u8> {
        let end = Instant::now() + deadline;
        let mut out = Vec::with_capacity(64);
        let mut buf = [0u8; 256];
        while Instant::now() < end {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => out.extend_from_slice(&buf[..n]),
                Err(_) => break,
            }
        }
        out
    }

    #[test]
    fn pty_spawn_emits_expected_output() {
        let (master, mut child, reader) = open_sh("printf claudette-pty-ok");

        // Read until the child prints its payload and closes the PTY.
        let bytes = read_with_deadline(reader, Duration::from_secs(5));

        // The child exits on its own; make sure we reap it rather than leave
        // a zombie hanging around.
        let _ = child.wait();
        drop(master);

        let s = String::from_utf8_lossy(&bytes);
        assert!(
            s.contains("claudette-pty-ok"),
            "expected PTY output to contain marker, got: {s:?}"
        );
    }

    #[test]
    fn pty_child_kill_terminates_process() {
        // Spawn a shell that would run indefinitely, then kill it the same
        // way `close_pty` does (`child.kill()` on the boxed portable_pty
        // Child). Verifies the kill path works against a live PTY child.
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty should succeed");

        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args(["-c", "sleep 30"]);

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .expect("spawn_command should succeed");
        drop(pair.slave);

        let pid = child
            .process_id()
            .expect("child should expose a pid on unix");

        // SAFETY: kill(pid, 0) is a standard existence check.
        let alive_before = unsafe { libc::kill(pid as i32, 0) == 0 };
        assert!(alive_before, "child should be alive before kill");

        child.kill().expect("kill should succeed");
        let _ = child.wait();

        // Give the OS a moment to update the process table.
        std::thread::sleep(Duration::from_millis(50));
        let alive_after = unsafe { libc::kill(pid as i32, 0) == 0 };
        assert!(!alive_after, "child should be dead after kill");
    }

    /// Exercises the same SIGINT-to-foreground-PGID path that
    /// `interrupt_pty_foreground` uses: read `tcgetpgrp(master_fd)` and
    /// `kill(-pgrp, SIGINT)`. Verifies that a sleeping child running in
    /// the PTY's foreground group gets interrupted from outside the TTY.
    #[test]
    fn pty_interrupts_foreground_via_sigint_to_pgid() {
        // The shell traps SIGINT and exits with a marker code (42). If
        // the SIGINT is never delivered, `sleep 30` keeps the child
        // alive — the wait deadline below catches that case so the
        // test fails fast instead of dragging out for 30 seconds.
        let (master, mut child, _reader) = open_sh("trap 'exit 42' INT; sleep 30");

        // Briefly let the child install the trap and start sleeping.
        std::thread::sleep(Duration::from_millis(150));

        let raw_fd = master
            .as_raw_fd()
            .expect("master PTY should expose a raw fd");
        let pgrp = unsafe { libc::tcgetpgrp(raw_fd) };
        assert!(pgrp > 0, "tcgetpgrp should report a foreground pgid");

        // SAFETY: kill(-pgrp, SIGINT) is the POSIX-defined way to deliver
        // SIGINT to every process in the group identified by `pgrp`.
        let start = Instant::now();
        let r = unsafe { libc::kill(-pgrp, libc::SIGINT) };
        assert_eq!(r, 0, "kill(-pgrp, SIGINT) should succeed");

        // Poll `try_wait` with a short deadline — if SIGINT was actually
        // delivered, the trap runs and the child exits in tens of ms.
        // A broken signal path would let the child sleep its full 30s,
        // which we want to catch as a failure here, not let it slide.
        let deadline = Duration::from_secs(3);
        let status = loop {
            match child.try_wait().expect("try_wait should not fail") {
                Some(status) => break status,
                None => {
                    if start.elapsed() > deadline {
                        // Don't leave the child running past the test —
                        // kill it and reap before failing.
                        let _ = child.kill();
                        let _ = child.wait();
                        drop(master);
                        panic!(
                            "child did not exit within {deadline:?} after SIGINT — \
                             the kill(-pgrp, SIGINT) path is not reaching the foreground group"
                        );
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
        };
        drop(master);

        // The shell ran our SIGINT trap (`exit 42`) — not just any exit.
        // This rules out the case where the child died for an unrelated
        // reason (e.g. PTY teardown) and still happened to exit fast.
        assert_eq!(
            status.exit_code(),
            42,
            "shell should have run the SIGINT trap (exit 42), got: {status:?}"
        );
    }

    /// Verifies that `configure_pty_env` (the shared helper used by
    /// `spawn_pty`) sets `TERM=xterm-256color` in the child environment.
    #[test]
    fn pty_sets_term_env_variable() {
        let (master, mut child, reader) = open_sh("printf \"TERM=%s\" \"$TERM\"");

        let bytes = read_with_deadline(reader, Duration::from_secs(5));
        let _ = child.wait();
        drop(master);

        let s = String::from_utf8_lossy(&bytes);
        assert!(
            s.contains("TERM=xterm-256color"),
            "expected TERM=xterm-256color in PTY output, got: {s:?}"
        );
    }
}
