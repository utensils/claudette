// Real implementations (compiled when the `voice` feature is enabled).
#[cfg(feature = "voice")]
use claudette::db::Database;
#[cfg(feature = "voice")]
use tauri::{AppHandle, State};

#[cfg(feature = "voice")]
use crate::state::AppState;
#[cfg(feature = "voice")]
use crate::voice::VoiceProviderInfo;

#[cfg(feature = "voice")]
fn open_db(state: &State<'_, AppState>) -> Result<Database, String> {
    Database::open(&state.db_path).map_err(|e| e.to_string())
}

#[cfg(feature = "voice")]
#[tauri::command]
pub async fn voice_list_providers(
    state: State<'_, AppState>,
) -> Result<Vec<VoiceProviderInfo>, String> {
    let db = open_db(&state)?;
    Ok(state.voice.list_providers(&db))
}

#[cfg(feature = "voice")]
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

#[cfg(feature = "voice")]
#[tauri::command]
pub async fn voice_set_provider_enabled(
    provider_id: String,
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = open_db(&state)?;
    state.voice.set_enabled(&db, &provider_id, enabled)
}

#[cfg(feature = "voice")]
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

#[cfg(feature = "voice")]
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

#[cfg(feature = "voice")]
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

#[cfg(feature = "voice")]
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

#[cfg(feature = "voice")]
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

// Shim implementations (compiled when the `voice` feature is disabled).
// These preserve the JS binding surface so callers get a clear error instead
// of a missing-command panic.
#[cfg(not(feature = "voice"))]
const VOICE_NOT_BUILT: &str = "voice support not built into this binary";

#[cfg(not(feature = "voice"))]
#[tauri::command]
pub async fn voice_list_providers() -> Result<Vec<serde_json::Value>, String> {
    Err(VOICE_NOT_BUILT.into())
}

#[cfg(not(feature = "voice"))]
#[tauri::command]
pub async fn voice_set_selected_provider() -> Result<(), String> {
    Err(VOICE_NOT_BUILT.into())
}

#[cfg(not(feature = "voice"))]
#[tauri::command]
pub async fn voice_set_provider_enabled() -> Result<(), String> {
    Err(VOICE_NOT_BUILT.into())
}

#[cfg(not(feature = "voice"))]
#[tauri::command]
pub async fn voice_prepare_provider() -> Result<serde_json::Value, String> {
    Err(VOICE_NOT_BUILT.into())
}

#[cfg(not(feature = "voice"))]
#[tauri::command]
pub async fn voice_remove_provider_model() -> Result<serde_json::Value, String> {
    Err(VOICE_NOT_BUILT.into())
}

#[cfg(not(feature = "voice"))]
#[tauri::command]
pub async fn voice_start_recording() -> Result<(), String> {
    Err(VOICE_NOT_BUILT.into())
}

#[cfg(not(feature = "voice"))]
#[tauri::command]
pub async fn voice_stop_and_transcribe() -> Result<String, String> {
    Err(VOICE_NOT_BUILT.into())
}

#[cfg(not(feature = "voice"))]
#[tauri::command]
pub async fn voice_cancel_recording() -> Result<(), String> {
    Err(VOICE_NOT_BUILT.into())
}
