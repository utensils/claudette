// Real implementations (compiled when the `voice` feature is enabled).
#[cfg(feature = "voice")]
use std::time::Instant;

#[cfg(feature = "voice")]
use claudette::db::Database;
#[cfg(feature = "voice")]
use tauri::{AppHandle, State};
#[cfg(all(feature = "voice", debug_assertions))]
use {serde::Serialize, tauri::Emitter};

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

#[cfg(all(feature = "voice", debug_assertions))]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct VoiceStartLatencyEvent {
    total_ms: u128,
    stream_open_ms: u128,
}

#[cfg(feature = "voice")]
#[tauri::command]
#[tracing::instrument(
    target = "claudette::voice",
    skip(app, state),
    fields(
        provider_id = tracing::field::Empty,
        total_ms = tracing::field::Empty,
        stream_open_ms = tracing::field::Empty,
    ),
)]
pub async fn voice_start_recording(
    provider_id: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let t0 = Instant::now();
    let resolved_provider_id = {
        let db = open_db(&state)?;
        state
            .voice
            .resolve_provider_id(&db, provider_id.as_deref())?
    };
    let span = tracing::Span::current();
    span.record("provider_id", resolved_provider_id.as_str());
    let latency = state
        .voice
        .start_recording(&state.db_path, &resolved_provider_id, Some(app.clone()))
        .await?;
    let total_ms = t0.elapsed().as_millis() as u64;
    let stream_open_ms = latency.stream_open_ms as u64;
    span.record("total_ms", total_ms);
    span.record("stream_open_ms", stream_open_ms);
    tracing::info!(
        target: "claudette::voice",
        total_ms,
        stream_open_ms,
        "voice start recording latency"
    );
    #[cfg(debug_assertions)]
    {
        let _ = app.emit(
            "voice://debug/start_latency",
            VoiceStartLatencyEvent {
                total_ms: total_ms as u128,
                stream_open_ms: latency.stream_open_ms,
            },
        );
    }
    #[cfg(not(debug_assertions))]
    let _ = app;
    Ok(())
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
// These preserve the JS binding surface — including parameter names — so the
// frontend's existing invoke args still deserialize cleanly and callers get
// the intended VOICE_NOT_BUILT error instead of a Tauri arg-parse failure.
#[cfg(not(feature = "voice"))]
const VOICE_NOT_BUILT: &str = "voice support not built into this binary";

#[cfg(not(feature = "voice"))]
#[tauri::command]
pub async fn voice_list_providers() -> Result<Vec<serde_json::Value>, String> {
    Err(VOICE_NOT_BUILT.into())
}

#[cfg(not(feature = "voice"))]
#[tauri::command]
pub async fn voice_set_selected_provider(
    #[allow(unused_variables)] provider_id: Option<String>,
) -> Result<(), String> {
    Err(VOICE_NOT_BUILT.into())
}

#[cfg(not(feature = "voice"))]
#[tauri::command]
pub async fn voice_set_provider_enabled(
    #[allow(unused_variables)] provider_id: String,
    #[allow(unused_variables)] enabled: bool,
) -> Result<(), String> {
    Err(VOICE_NOT_BUILT.into())
}

#[cfg(not(feature = "voice"))]
#[tauri::command]
pub async fn voice_prepare_provider(
    #[allow(unused_variables)] provider_id: String,
) -> Result<serde_json::Value, String> {
    Err(VOICE_NOT_BUILT.into())
}

#[cfg(not(feature = "voice"))]
#[tauri::command]
pub async fn voice_remove_provider_model(
    #[allow(unused_variables)] provider_id: String,
) -> Result<serde_json::Value, String> {
    Err(VOICE_NOT_BUILT.into())
}

#[cfg(not(feature = "voice"))]
#[tauri::command]
pub async fn voice_start_recording(
    #[allow(unused_variables)] provider_id: Option<String>,
) -> Result<(), String> {
    Err(VOICE_NOT_BUILT.into())
}

#[cfg(not(feature = "voice"))]
#[tauri::command]
pub async fn voice_stop_and_transcribe(
    #[allow(unused_variables)] provider_id: Option<String>,
) -> Result<String, String> {
    Err(VOICE_NOT_BUILT.into())
}

#[cfg(not(feature = "voice"))]
#[tauri::command]
pub async fn voice_cancel_recording(
    #[allow(unused_variables)] provider_id: Option<String>,
) -> Result<(), String> {
    Err(VOICE_NOT_BUILT.into())
}
