use claudette::db::Database;
use tauri::{AppHandle, State};

use crate::state::AppState;
use crate::voice::VoiceProviderInfo;

fn open_db(state: &State<'_, AppState>) -> Result<Database, String> {
    Database::open(&state.db_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn voice_list_providers(
    state: State<'_, AppState>,
) -> Result<Vec<VoiceProviderInfo>, String> {
    let db = open_db(&state)?;
    Ok(state.voice.list_providers(&db))
}

#[tauri::command]
pub async fn voice_set_selected_provider(
    provider_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = open_db(&state)?;
    state
        .voice
        .set_selected_provider(&db, provider_id.as_deref())
}

#[tauri::command]
pub async fn voice_set_provider_enabled(
    provider_id: String,
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = open_db(&state)?;
    state.voice.set_enabled(&db, &provider_id, enabled)
}

#[tauri::command]
pub async fn voice_prepare_provider(
    provider_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<VoiceProviderInfo, String> {
    state
        .voice
        .prepare_provider(&app, &state.db_path, &provider_id)
        .await
}

#[tauri::command]
pub async fn voice_remove_provider_model(
    provider_id: String,
    state: State<'_, AppState>,
) -> Result<VoiceProviderInfo, String> {
    state
        .voice
        .remove_provider_model(&state.db_path, &provider_id)
        .await
}

#[tauri::command]
pub async fn voice_start_recording(
    provider_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let provider_id = {
        let db = open_db(&state)?;
        state
            .voice
            .resolve_provider_id(&db, provider_id.as_deref())?
    };
    state
        .voice
        .start_recording(&state.db_path, &provider_id)
        .await
}

#[tauri::command]
pub async fn voice_stop_and_transcribe(
    provider_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let provider_id = {
        let db = open_db(&state)?;
        state
            .voice
            .resolve_provider_id(&db, provider_id.as_deref())?
    };
    state.voice.stop_and_transcribe(&provider_id).await
}

#[tauri::command]
pub async fn voice_cancel_recording(
    provider_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let provider_id = {
        let db = open_db(&state)?;
        state
            .voice
            .resolve_provider_id(&db, provider_id.as_deref())?
    };
    state.voice.cancel_recording(&provider_id).await
}
