use tauri::State;

use crate::{boot_probation, state::AppState};

#[tauri::command]
pub async fn boot_ok(state: State<'_, AppState>) -> Result<(), String> {
    let data_dir = claudette::path::data_dir();
    boot_probation::acknowledge_boot(&data_dir, &state.boot_probation).await?;
    tracing::debug!(target: "claudette::updater", "boot probation acknowledged by frontend");
    Ok(())
}
