use tauri::State;

use crate::{
    boot_probation::{self, BootStage},
    state::AppState,
};

#[tauri::command]
pub fn boot_stage(stage: BootStage, detail: Option<String>) -> Result<(), String> {
    let data_dir = claudette::path::data_dir();
    if boot_probation::record_boot_stage(&data_dir, stage.clone(), detail)? {
        tracing::debug!(target: "claudette::updater", ?stage, "boot probation stage recorded");
    }
    Ok(())
}

#[tauri::command]
pub fn boot_ok(state: State<'_, AppState>) -> Result<(), String> {
    let data_dir = claudette::path::data_dir();
    boot_probation::acknowledge_boot(&data_dir, &state.boot_probation)?;
    tracing::debug!(target: "claudette::updater", "boot probation acknowledged by frontend");
    Ok(())
}
