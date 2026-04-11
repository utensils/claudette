use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use parking_lot::Mutex as ParkingMutex;
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

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

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum ShellType {
    Bash,
    Zsh,
    Fish,
    Unknown,
}

fn detect_user_shell() -> (String, ShellType) {
    // Try $SHELL environment variable first
    if let Ok(shell) = std::env::var("SHELL") {
        let shell_type = match shell.as_str() {
            s if s.contains("bash") => ShellType::Bash,
            s if s.contains("zsh") => ShellType::Zsh,
            s if s.contains("fish") => ShellType::Fish,
            _ => ShellType::Unknown,
        };
        return (shell, shell_type);
    }

    // Fallback: use system default
    #[cfg(target_os = "macos")]
    let default = ("/bin/zsh".to_string(), ShellType::Zsh);

    #[cfg(target_os = "linux")]
    let default = ("/bin/bash".to_string(), ShellType::Bash);

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let default = ("/bin/sh".to_string(), ShellType::Unknown);

    default
}

#[tauri::command]
pub async fn detect_shell() -> Result<String, String> {
    let (shell, _) = detect_user_shell();
    Ok(shell)
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

    // Set CLAUDETTE_PTY environment variable to enable shell integration
    cmd.env("CLAUDETTE_PTY", "1");

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
                                // Prompt appeared - reset running state if still set
                                if *running_clone.lock() {
                                    *running_clone.lock() = false;
                                }
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
