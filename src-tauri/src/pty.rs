use std::io::{Read, Write};
use std::sync::Mutex;

use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::state::{AppState, PtyHandle};

#[derive(Clone, Serialize)]
struct PtyOutputPayload {
    pty_id: u64,
    data: Vec<u8>,
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

    // Background reader: reads PTY output and emits Tauri events.
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
    });

    let handle = PtyHandle {
        writer: Mutex::new(writer),
        master: Mutex::new(pair.master),
        child: Mutex::new(child),
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
