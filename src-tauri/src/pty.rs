use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use parking_lot::Mutex as ParkingMutex;
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::commands::shell::detect_user_shell;
use crate::osc133::{Osc133Event, Osc133Parser};
use crate::state::{AppState, PtyHandle};

#[derive(Clone, Serialize)]
struct PtyOutputPayload {
    pty_id: u64,
    data: Vec<u8>,
}

#[derive(Clone, Serialize)]
struct CommandEvent {
    pty_id: u64,
    command: Option<String>,
    exit_code: Option<i32>,
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
pub async fn spawn_pty(
    working_dir: String,
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

    let mut cmd = CommandBuilder::new_default_prog();
    cmd.cwd(&working_dir);
    configure_pty_env(&mut cmd);

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

    // OSC 133 tracking state
    let current_command = Arc::new(ParkingMutex::new(None));
    let command_running = Arc::new(ParkingMutex::new(false));
    let last_exit_code = Arc::new(ParkingMutex::new(None));

    // Background reader: reads PTY output and emits Tauri events.
    let emitter_app = app.clone();
    let reader_pty_id = pty_id;
    let cmd_clone = current_command.clone();
    let running_clone = command_running.clone();
    let exit_clone = last_exit_code.clone();

    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut parser = Osc133Parser::new();

        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = &buf[..n];

                    // Emit raw output for xterm.js
                    let payload = PtyOutputPayload {
                        pty_id: reader_pty_id,
                        data: data.to_vec(),
                    };
                    let _ = emitter_app.emit("pty-output", &payload);

                    // Parse OSC 133 sequences
                    for event in parser.feed(data) {
                        match event {
                            Osc133Event::CommandStart => {
                                // Will extract command from CommandText event or text between B and C
                            }
                            Osc133Event::CommandText { command } => {
                                // Explicit command text (used by bash/fish via OSC 133;E)
                                *cmd_clone.lock() = Some(command.clone());
                                *running_clone.lock() = true;

                                let _ = emitter_app.emit(
                                    "pty-command-detected",
                                    &CommandEvent {
                                        pty_id: reader_pty_id,
                                        command: Some(command),
                                        exit_code: None,
                                    },
                                );
                            }
                            Osc133Event::CommandExecuted => {
                                // Extract command text captured between B and C markers (zsh)
                                if let Some(cmd) = parser.extract_command() {
                                    *cmd_clone.lock() = Some(cmd.clone());
                                    *running_clone.lock() = true;

                                    let _ = emitter_app.emit(
                                        "pty-command-detected",
                                        &CommandEvent {
                                            pty_id: reader_pty_id,
                                            command: Some(cmd),
                                            exit_code: None,
                                        },
                                    );
                                }
                            }
                            Osc133Event::CommandFinished { exit_code } => {
                                *running_clone.lock() = false;
                                *exit_clone.lock() = Some(exit_code);

                                let _ = emitter_app.emit(
                                    "pty-command-stopped",
                                    &CommandEvent {
                                        pty_id: reader_pty_id,
                                        command: cmd_clone.lock().clone(),
                                        exit_code: Some(exit_code),
                                    },
                                );
                            }
                            Osc133Event::PromptStart => {
                                // Prompt appeared — reset running state and clear stale
                                // command.  Lock each mutex independently (assigning
                                // false is idempotent, no conditional needed).
                                *running_clone.lock() = false;
                                *cmd_clone.lock() = None;
                            }
                        }
                    }
                }
                Err(_) => break,
            }
        }
    });

    let handle = PtyHandle {
        writer: Mutex::new(writer),
        master: Mutex::new(pair.master),
        child: Mutex::new(child),
        current_command,
        command_running,
        last_exit_code,
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

#[tauri::command]
pub async fn close_pty(pty_id: u64, state: State<'_, AppState>) -> Result<(), String> {
    let mut ptys = state.ptys.write().await;
    if let Some(handle) = ptys.remove(&pty_id)
        && let Ok(mut child) = handle.child.into_inner()
    {
        let _ = child.kill();
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
