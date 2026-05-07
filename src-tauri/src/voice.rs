use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use candle_core::{D, Device, IndexOp, Tensor};
use candle_nn::{VarBuilder, ops::softmax};
use candle_transformers::models::whisper::{self as whisper, Config, audio};
use claudette::db::Database;
use cpal::Sample;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use futures_util::StreamExt;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokenizers::Tokenizer;
use tokio::io::AsyncWriteExt;
use tokio::task::AbortHandle;

#[cfg(target_os = "macos")]
use crate::platform_speech::PlatformSpeechAvailability;
use crate::platform_speech::{
    DefaultPlatformSpeechEngine, PlatformSpeechAvailabilityStatus, PlatformSpeechEngine,
};

const SELECTED_PROVIDER_KEY: &str = "voice:selected_provider";
const AUTO_PROVIDER_KEY: &str = "voice:auto_provider";
const PLATFORM_ID: &str = "voice-platform-system";
const DISTIL_ID: &str = "voice-distil-whisper-candle";
const DISTIL_CACHE_DIR: &str = "distil-whisper-large-v3";
const DISTIL_READY_MESSAGE: &str = "Ready for offline transcription";
const TARGET_SAMPLE_RATE: u32 = whisper::SAMPLE_RATE as u32;
const DISTIL_TRANSCRIPTION_TIMEOUT: Duration = Duration::from_secs(90);
const MIN_SIGNAL_PEAK: f32 = 0.001;
const DISTIL_MODEL_FILES: [(&str, Option<u64>); 5] = [
    ("config.json", None),
    ("generation_config.json", None),
    ("preprocessor_config.json", None),
    ("tokenizer.json", None),
    ("model.safetensors", Some(100_000_000)),
];
const WHISPER_LANGUAGE_CODES: [&str; 99] = [
    "en", "zh", "de", "es", "ru", "ko", "fr", "ja", "pt", "tr", "pl", "ca", "nl", "ar", "sv", "it",
    "id", "hi", "fi", "vi", "he", "uk", "el", "ms", "cs", "ro", "da", "hu", "ta", "no", "th", "ur",
    "hr", "bg", "lt", "la", "mi", "ml", "cy", "sk", "te", "fa", "lv", "bn", "sr", "az", "sl", "kn",
    "et", "mk", "br", "eu", "is", "hy", "ne", "mn", "bs", "kk", "sq", "sw", "gl", "mr", "pa", "si",
    "km", "sn", "yo", "so", "af", "oc", "ka", "be", "tg", "sd", "gu", "am", "yi", "lo", "uz", "fo",
    "ht", "ps", "tk", "nn", "mt", "sa", "lb", "my", "bo", "tl", "mg", "as", "tt", "haw", "ln",
    "ha", "ba", "jw", "su",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum VoiceProviderKind {
    Platform,
    LocalModel,
    External,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum VoiceProviderStatus {
    Ready,
    NeedsSetup,
    Downloading,
    EngineUnavailable,
    Unavailable,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum VoiceRecordingMode {
    Native,
    Webview,
}

/// Payload emitted on the `voice://level` Tauri event at ~30 Hz during recording.
/// `level` is linear RMS of the mic buffer window, clamped to [0.0, 1.0].
/// Full-scale sine wave ≈ 0.707; typical speech 0.05–0.3; silence < 0.01.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceLevelPayload {
    pub level: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceProviderMetadata {
    pub id: String,
    pub name: String,
    pub description: String,
    pub kind: VoiceProviderKind,
    pub recording_mode: VoiceRecordingMode,
    pub privacy_label: String,
    pub offline: bool,
    pub download_required: bool,
    pub model_size_label: Option<String>,
    pub cache_path: Option<String>,
    pub accelerator_label: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceProviderInfo {
    #[serde(flatten)]
    pub metadata: VoiceProviderMetadata,
    pub status: VoiceProviderStatus,
    pub status_label: String,
    pub enabled: bool,
    pub selected: bool,
    pub setup_required: bool,
    pub can_remove_model: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceDownloadProgress {
    pub provider_id: String,
    pub filename: String,
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
    pub overall_downloaded_bytes: u64,
    pub overall_total_bytes: Option<u64>,
    pub percent: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceErrorEvent {
    pub provider_id: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone)]
pub(crate) struct CapturedAudio {
    pub(crate) samples: Vec<f32>,
    pub(crate) sample_rate: u32,
}

/// Cancels the level-emitter Tokio task when dropped.
struct LevelTask(AbortHandle);

impl Drop for LevelTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}

struct RecordingSession {
    samples: Arc<Mutex<Vec<f32>>>,
    stream_error: Arc<Mutex<Option<String>>>,
    sample_rate: u32,
    _stream: Option<cpal::Stream>,
    /// Kept alive to abort the level-emitter task when recording stops.
    _level_task: Option<LevelTask>,
}

impl RecordingSession {
    #[cfg(test)]
    fn from_samples(samples: Vec<f32>, sample_rate: u32) -> Self {
        Self {
            samples: Arc::new(Mutex::new(samples)),
            stream_error: Arc::new(Mutex::new(None)),
            sample_rate,
            _stream: None,
            _level_task: None,
        }
    }

    #[cfg(test)]
    fn from_samples_with_stream_error(
        samples: Vec<f32>,
        sample_rate: u32,
        stream_error: impl Into<String>,
    ) -> Self {
        Self {
            samples: Arc::new(Mutex::new(samples)),
            stream_error: Arc::new(Mutex::new(Some(stream_error.into()))),
            sample_rate,
            _stream: None,
            _level_task: None,
        }
    }

    fn finish(self) -> Result<CapturedAudio, String> {
        drop(self._stream);
        if let Some(err) = self.stream_error.lock().clone() {
            return Err(format!("Microphone input failed: {err}"));
        }
        let samples = self.samples.lock().clone();
        Ok(CapturedAudio {
            samples: resample_to_target_rate(&samples, self.sample_rate),
            sample_rate: TARGET_SAMPLE_RATE,
        })
    }
}

trait AudioRecorder: Send + Sync {
    fn start(&self) -> Result<RecordingSession, String>;
}

trait VoiceTranscriber: Send + Sync {
    fn transcribe(
        &self,
        cache_path: &Path,
        audio: CapturedAudio,
        cancel: &Arc<AtomicBool>,
    ) -> Result<String, String>;
}

struct CpalAudioRecorder;

struct CandleWhisperTranscriber;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CandleBackend {
    #[cfg(target_os = "macos")]
    Metal,
    #[cfg(not(target_os = "macos"))]
    Cpu,
}

impl CandleBackend {
    fn label(self) -> &'static str {
        match self {
            #[cfg(target_os = "macos")]
            Self::Metal => "Metal",
            #[cfg(not(target_os = "macos"))]
            Self::Cpu => "CPU",
        }
    }

    fn accelerator_label(self) -> &'static str {
        match self {
            #[cfg(target_os = "macos")]
            Self::Metal => "Metal via Candle",
            #[cfg(not(target_os = "macos"))]
            Self::Cpu => "CPU via Candle",
        }
    }
}

trait CandleBackendChecker: Send + Sync {
    fn ready_backend(&self) -> Result<CandleBackend, String>;
}

struct DefaultCandleBackendChecker;

impl CandleBackendChecker for DefaultCandleBackendChecker {
    fn ready_backend(&self) -> Result<CandleBackend, String> {
        ensure_candle_backend_ready()
    }
}

#[async_trait]
pub trait VoiceProvider: Send + Sync {
    fn id(&self) -> &'static str;
    fn metadata(&self, registry: &VoiceProviderRegistry) -> VoiceProviderMetadata;
    fn status(&self, registry: &VoiceProviderRegistry, db: &Database) -> VoiceProviderInfo;
    async fn prepare(
        &self,
        registry: &VoiceProviderRegistry,
        app: &AppHandle,
        db_path: &Path,
    ) -> Result<VoiceProviderInfo, String>;
}

/// Timing data returned from a successful `start_recording` call.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceStartLatency {
    /// True if a future prompt-safe warm path ran before this start call.
    /// Currently false because microphone-related startup prewarming is
    /// intentionally disabled to avoid macOS TCC prompts on launch.
    pub was_prewarmed: bool,
    /// Milliseconds spent opening the cpal input stream.
    pub stream_open_ms: u128,
}

pub struct VoiceProviderRegistry {
    model_root: PathBuf,
    active_recording: Mutex<Option<RecordingSession>>,
    recorder: Arc<dyn AudioRecorder>,
    transcriber: Arc<dyn VoiceTranscriber>,
    platform_speech: Arc<dyn PlatformSpeechEngine>,
    backend_checker: Arc<dyn CandleBackendChecker>,
    transcription_timeout: Duration,
    was_prewarmed: AtomicBool,
    active_distil_cancel: Mutex<Option<Arc<AtomicBool>>>,
}

fn compute_rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum_sq: f32 = samples.iter().map(|s| s * s).sum();
    (sum_sq / samples.len() as f32).sqrt().min(1.0)
}

/// Spawn a Tokio task that emits `voice://level` events at ~30 Hz.
///
/// The task reads samples accumulated since its last tick, computes RMS
/// over that window, and emits a normalized [0.0, 1.0] level. The first
/// three ticks are suppressed so the buffer has time to fill before the
/// frontend sees any signal (avoids a flash of empty bars at recording start).
///
/// Returns an `AbortHandle`; store it in a `LevelTask` so the task is
/// cancelled automatically when recording stops.
fn spawn_level_emitter(app: AppHandle, samples: Arc<Mutex<Vec<f32>>>) -> AbortHandle {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(33));
        let mut offset = 0usize;
        let mut tick = 0u8;
        loop {
            interval.tick().await;
            let (level, new_offset) = {
                let s = samples.lock();
                let window = &s[offset.min(s.len())..];
                let rms = compute_rms(window);
                (rms, s.len())
            };
            offset = new_offset;
            tick = tick.saturating_add(1);
            if tick > 3 {
                let _ = app.emit("voice://level", VoiceLevelPayload { level });
            }
        }
    })
    .abort_handle()
}

impl VoiceProviderRegistry {
    pub fn new(model_root: PathBuf) -> Self {
        Self::with_runtime(
            model_root,
            Arc::new(CpalAudioRecorder),
            Arc::new(CandleWhisperTranscriber),
        )
    }

    fn with_runtime(
        model_root: PathBuf,
        recorder: Arc<dyn AudioRecorder>,
        transcriber: Arc<dyn VoiceTranscriber>,
    ) -> Self {
        Self::with_runtime_and_timeout(
            model_root,
            recorder,
            transcriber,
            DISTIL_TRANSCRIPTION_TIMEOUT,
        )
    }

    fn with_runtime_and_timeout(
        model_root: PathBuf,
        recorder: Arc<dyn AudioRecorder>,
        transcriber: Arc<dyn VoiceTranscriber>,
        transcription_timeout: Duration,
    ) -> Self {
        Self::with_runtime_backend_and_timeout(
            model_root,
            recorder,
            transcriber,
            Arc::new(DefaultPlatformSpeechEngine::new()),
            Arc::new(DefaultCandleBackendChecker),
            transcription_timeout,
        )
    }

    #[cfg(test)]
    fn with_platform_runtime(
        model_root: PathBuf,
        recorder: Arc<dyn AudioRecorder>,
        transcriber: Arc<dyn VoiceTranscriber>,
        platform_speech: Arc<dyn PlatformSpeechEngine>,
    ) -> Self {
        Self::with_runtime_backend_and_timeout(
            model_root,
            recorder,
            transcriber,
            platform_speech,
            Arc::new(DefaultCandleBackendChecker),
            DISTIL_TRANSCRIPTION_TIMEOUT,
        )
    }

    #[cfg(test)]
    fn with_runtime_and_backend(
        model_root: PathBuf,
        recorder: Arc<dyn AudioRecorder>,
        transcriber: Arc<dyn VoiceTranscriber>,
        backend_checker: Arc<dyn CandleBackendChecker>,
    ) -> Self {
        Self::with_runtime_backend_and_timeout(
            model_root,
            recorder,
            transcriber,
            Arc::new(DefaultPlatformSpeechEngine::new()),
            backend_checker,
            DISTIL_TRANSCRIPTION_TIMEOUT,
        )
    }

    fn with_runtime_backend_and_timeout(
        model_root: PathBuf,
        recorder: Arc<dyn AudioRecorder>,
        transcriber: Arc<dyn VoiceTranscriber>,
        platform_speech: Arc<dyn PlatformSpeechEngine>,
        backend_checker: Arc<dyn CandleBackendChecker>,
        transcription_timeout: Duration,
    ) -> Self {
        Self {
            model_root,
            active_recording: Mutex::new(None),
            recorder,
            transcriber,
            platform_speech,
            backend_checker,
            transcription_timeout,
            was_prewarmed: AtomicBool::new(false),
            active_distil_cancel: Mutex::new(None),
        }
    }

    pub fn default_model_root() -> PathBuf {
        dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".claudette")
            .join("models")
            .join("voice")
    }

    pub fn distil_cache_path(&self) -> PathBuf {
        self.model_root.join(DISTIL_CACHE_DIR)
    }

    pub fn list_providers(&self, db: &Database) -> Vec<VoiceProviderInfo> {
        vec![
            PlatformVoiceProvider.status(self, db),
            DistilWhisperCandleProvider.status(self, db),
        ]
    }

    pub fn set_selected_provider(
        &self,
        db: &Database,
        provider_id: Option<&str>,
    ) -> Result<(), String> {
        if let Some(provider_id) = provider_id {
            self.ensure_known(provider_id)?;
            db.set_app_setting(SELECTED_PROVIDER_KEY, provider_id)
                .map_err(|e| e.to_string())?;
        } else {
            db.delete_app_setting(SELECTED_PROVIDER_KEY)
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn set_enabled(
        &self,
        db: &Database,
        provider_id: &str,
        enabled: bool,
    ) -> Result<(), String> {
        self.ensure_known(provider_id)?;
        db.set_app_setting(
            &enabled_key(provider_id),
            if enabled { "true" } else { "false" },
        )
        .map_err(|e| e.to_string())
    }

    pub async fn prepare_provider(
        &self,
        app: &AppHandle,
        db_path: &Path,
        provider_id: &str,
    ) -> Result<VoiceProviderInfo, String> {
        match provider_id {
            PLATFORM_ID => PlatformVoiceProvider.prepare(self, app, db_path).await,
            DISTIL_ID => {
                DistilWhisperCandleProvider
                    .prepare(self, app, db_path)
                    .await
            }
            _ => Err(format!("Unknown voice provider: {provider_id}")),
        }
    }

    pub async fn remove_provider_model(
        &self,
        db_path: &Path,
        provider_id: &str,
    ) -> Result<VoiceProviderInfo, String> {
        self.ensure_known(provider_id)?;
        if provider_id != DISTIL_ID {
            return Err("This provider does not use a removable local model".to_string());
        }

        let path = self.distil_cache_path();
        if tokio::fs::try_exists(&path)
            .await
            .map_err(|e| e.to_string())?
        {
            tokio::fs::remove_dir_all(&path)
                .await
                .map_err(|e| format!("Failed to remove model cache: {e}"))?;
        }
        let db = Database::open(db_path).map_err(|e| e.to_string())?;
        db.set_app_setting(&model_status_key(provider_id), "not-installed")
            .map_err(|e| e.to_string())?;
        Ok(DistilWhisperCandleProvider.status(self, &db))
    }

    pub async fn start_recording(
        &self,
        db_path: &Path,
        provider_id: &str,
        app: Option<AppHandle>,
    ) -> Result<VoiceStartLatency, String> {
        self.ensure_known(provider_id)?;
        // Kept in the debug latency payload so older frontend diagnostics
        // still receive a stable shape. Voice startup prewarming is disabled
        // because macOS can show microphone TCC prompts during audio setup.
        let was_prewarmed = self.was_prewarmed.load(Ordering::Relaxed);
        let stream_open_ms = match provider_id {
            PLATFORM_ID => self.start_platform_recording(db_path, app).await,
            DISTIL_ID => self.start_distil_recording(db_path, app).await,
            _ => Err(format!("Unknown voice provider: {provider_id}")),
        }?;
        Ok(VoiceStartLatency {
            was_prewarmed,
            stream_open_ms,
        })
    }

    pub async fn stop_and_transcribe(&self, provider_id: &str) -> Result<String, String> {
        self.ensure_known(provider_id)?;
        match provider_id {
            PLATFORM_ID => self.stop_platform_recording().await,
            DISTIL_ID => self.stop_distil_recording().await,
            _ => Err(format!("Unknown voice provider: {provider_id}")),
        }
    }

    pub async fn cancel_recording(&self, provider_id: &str) -> Result<(), String> {
        self.ensure_known(provider_id)?;
        match provider_id {
            PLATFORM_ID => self.cancel_platform_recording().await,
            DISTIL_ID => self.cancel_distil_recording().await,
            _ => Err(format!("Unknown voice provider: {provider_id}")),
        }
    }

    async fn start_platform_recording(
        &self,
        db_path: &Path,
        app: Option<AppHandle>,
    ) -> Result<u128, String> {
        {
            let db = Database::open(db_path).map_err(|e| e.to_string())?;
            if !self.enabled(&db, PLATFORM_ID) {
                return Err("System dictation is disabled".to_string());
            }
            let platform_speech = Arc::clone(&self.platform_speech);
            let availability = tokio::task::spawn_blocking(move || platform_speech.prepare())
                .await
                .map_err(|e| format!("System dictation permission task failed: {e}"))?;
            if availability.status != PlatformSpeechAvailabilityStatus::Ready {
                return Err(availability.message);
            }
        }

        let mut active = self.active_recording.lock();
        if active.is_some() {
            return Err("Voice recording is already active".to_string());
        }
        let t_stream = Instant::now();
        let mut session = self.recorder.start()?;
        let stream_open_ms = t_stream.elapsed().as_millis();
        if let Some(app) = app {
            let abort = spawn_level_emitter(app, Arc::clone(&session.samples));
            session._level_task = Some(LevelTask(abort));
        }
        *active = Some(session);
        Ok(stream_open_ms)
    }

    async fn stop_platform_recording(&self) -> Result<String, String> {
        let session = self
            .active_recording
            .lock()
            .take()
            .ok_or_else(|| "No voice recording is active".to_string())?;
        let audio = session.finish()?;
        if audio.samples.is_empty() {
            return Err("No audio was captured".to_string());
        }
        validate_captured_audio(&audio)?;

        let platform_speech = Arc::clone(&self.platform_speech);
        let timeout = self.transcription_timeout;
        let task = tokio::task::spawn_blocking(move || platform_speech.transcribe(audio));
        let transcript = tokio::time::timeout(timeout, task)
            .await
            .map_err(|_| {
                format!(
                    "System dictation timed out after {} seconds. Try a shorter recording.",
                    timeout.as_secs()
                )
            })?
            .map_err(|e| format!("System dictation task failed: {e}"))??;
        let transcript = transcript.trim().to_string();
        if transcript.is_empty() {
            return Err(
                "No speech was recognized. Try again closer to the microphone.".to_string(),
            );
        }
        Ok(transcript)
    }

    async fn cancel_platform_recording(&self) -> Result<(), String> {
        let _ = self.active_recording.lock().take();
        #[cfg(target_os = "macos")]
        crate::platform_speech::cancel_active_transcription();
        Ok(())
    }

    async fn start_distil_recording(
        &self,
        db_path: &Path,
        app: Option<AppHandle>,
    ) -> Result<u128, String> {
        {
            let db = Database::open(db_path).map_err(|e| e.to_string())?;
            if !self.enabled(&db, DISTIL_ID) {
                return Err("Distil-Whisper voice input is disabled".to_string());
            }
            if !distil_model_ready(&self.distil_cache_path()) {
                return Err("Download the Distil-Whisper model before recording".to_string());
            }
            self.ensure_candle_backend_ready()?;
        }

        let mut active = self.active_recording.lock();
        if active.is_some() {
            return Err("Voice recording is already active".to_string());
        }
        let t_stream = Instant::now();
        let mut session = self.recorder.start()?;
        let stream_open_ms = t_stream.elapsed().as_millis();
        if let Some(app) = app {
            let abort = spawn_level_emitter(app, Arc::clone(&session.samples));
            session._level_task = Some(LevelTask(abort));
        }
        *active = Some(session);
        Ok(stream_open_ms)
    }

    async fn stop_distil_recording(&self) -> Result<String, String> {
        let session = self
            .active_recording
            .lock()
            .take()
            .ok_or_else(|| "No voice recording is active".to_string())?;
        let audio = session.finish()?;
        if audio.samples.is_empty() {
            return Err("No audio was captured".to_string());
        }
        validate_captured_audio(&audio)?;

        let cancel = Arc::new(AtomicBool::new(false));
        *self.active_distil_cancel.lock() = Some(Arc::clone(&cancel));

        let cache_path = self.distil_cache_path();
        let transcriber = Arc::clone(&self.transcriber);
        let timeout = self.transcription_timeout;
        let cancel_for_task = Arc::clone(&cancel);
        let task = tokio::task::spawn_blocking(move || {
            transcriber.transcribe(&cache_path, audio, &cancel_for_task)
        });
        let result = tokio::time::timeout(timeout, task).await;

        // On timeout, signal the worker to bail at its next cancel poll so it
        // doesn't keep grinding on a transcript that's already been discarded.
        if result.is_err() {
            cancel.store(true, Ordering::Relaxed);
        }

        // Vacate our slot in the registry, but only if a newer transcription
        // hasn't already replaced it.
        {
            let mut active = self.active_distil_cancel.lock();
            if active.as_ref().is_some_and(|a| Arc::ptr_eq(a, &cancel)) {
                *active = None;
            }
        }

        let transcript = result
            .map_err(|_| {
                format!(
                    "Voice transcription timed out after {} seconds. Try a shorter recording or check the selected voice provider.",
                    timeout.as_secs()
                )
            })?
            .map_err(|e| format!("Voice transcription task failed: {e}"))??;
        let transcript = transcript.trim().to_string();
        if transcript.is_empty() {
            return Err(
                "No speech was recognized. Try again closer to the microphone.".to_string(),
            );
        }
        Ok(transcript)
    }

    async fn cancel_distil_recording(&self) -> Result<(), String> {
        if let Some(cancel) = self.active_distil_cancel.lock().clone() {
            cancel.store(true, Ordering::Relaxed);
        }
        let _ = self.active_recording.lock().take();
        Ok(())
    }

    fn ensure_known(&self, provider_id: &str) -> Result<(), String> {
        match provider_id {
            PLATFORM_ID | DISTIL_ID => Ok(()),
            _ => Err(format!("Unknown voice provider: {provider_id}")),
        }
    }

    fn selected_provider(&self, db: &Database) -> Option<String> {
        db.get_app_setting(SELECTED_PROVIDER_KEY).ok().flatten()
    }

    fn auto_provider_enabled(&self, db: &Database) -> bool {
        db.get_app_setting(AUTO_PROVIDER_KEY)
            .ok()
            .flatten()
            .map(|v| v != "false")
            .unwrap_or(true)
    }

    fn enabled(&self, db: &Database, provider_id: &str) -> bool {
        db.get_app_setting(&enabled_key(provider_id))
            .ok()
            .flatten()
            .map(|v| v != "false")
            .unwrap_or(true)
    }

    fn ensure_candle_backend_ready(&self) -> Result<CandleBackend, String> {
        self.backend_checker.ready_backend()
    }

    pub(crate) fn resolve_provider_id(
        &self,
        db: &Database,
        requested: Option<&str>,
    ) -> Result<String, String> {
        if let Some(requested) = requested {
            self.ensure_known(requested)?;
            return Ok(requested.to_string());
        }
        if let Some(selected) = self.selected_provider(db) {
            self.ensure_known(&selected)?;
            return Ok(selected);
        }
        if self.auto_provider_enabled(db) {
            return Ok(PLATFORM_ID.to_string());
        }
        Err("No voice provider is selected".to_string())
    }
}

struct PlatformVoiceProvider;

#[cfg(target_os = "macos")]
fn platform_recording_mode() -> VoiceRecordingMode {
    VoiceRecordingMode::Native
}

#[cfg(not(target_os = "macos"))]
fn platform_recording_mode() -> VoiceRecordingMode {
    VoiceRecordingMode::Webview
}

#[cfg(target_os = "macos")]
fn platform_description() -> &'static str {
    "Uses native Apple Speech recognition through the operating system. Requires Microphone and Speech Recognition permission."
}

#[cfg(not(target_os = "macos"))]
fn platform_description() -> &'static str {
    "Uses the webview or operating system speech recognition surface when available. Requires microphone and speech recognition permission."
}

#[cfg(target_os = "macos")]
fn platform_privacy_label() -> &'static str {
    "Uses Apple Speech services; offline behavior varies by OS language support"
}

#[cfg(not(target_os = "macos"))]
fn platform_privacy_label() -> &'static str {
    "Uses platform services; offline behavior varies by OS"
}

#[cfg(target_os = "macos")]
fn platform_accelerator_label() -> &'static str {
    "Apple Speech"
}

#[cfg(not(target_os = "macos"))]
fn platform_accelerator_label() -> &'static str {
    "No setup"
}

#[cfg(target_os = "macos")]
fn platform_status_from_availability(
    availability: PlatformSpeechAvailability,
) -> (VoiceProviderStatus, String, bool, Option<String>) {
    match availability.status {
        PlatformSpeechAvailabilityStatus::Ready => (
            VoiceProviderStatus::Ready,
            availability.message,
            false,
            None,
        ),
        PlatformSpeechAvailabilityStatus::NeedsMicrophonePermission
        | PlatformSpeechAvailabilityStatus::NeedsSpeechPermission
        | PlatformSpeechAvailabilityStatus::NeedsAssets => (
            VoiceProviderStatus::NeedsSetup,
            availability.message.clone(),
            true,
            Some(availability.message),
        ),
        PlatformSpeechAvailabilityStatus::EngineUnavailable => (
            VoiceProviderStatus::EngineUnavailable,
            "System dictation engine unavailable".to_string(),
            false,
            Some(availability.message),
        ),
        PlatformSpeechAvailabilityStatus::Unavailable => (
            VoiceProviderStatus::Unavailable,
            availability.message.clone(),
            false,
            Some(availability.message),
        ),
    }
}

#[async_trait]
impl VoiceProvider for PlatformVoiceProvider {
    fn id(&self) -> &'static str {
        PLATFORM_ID
    }

    fn metadata(&self, _registry: &VoiceProviderRegistry) -> VoiceProviderMetadata {
        VoiceProviderMetadata {
            id: self.id().to_string(),
            name: "System dictation".to_string(),
            description: platform_description().to_string(),
            kind: VoiceProviderKind::Platform,
            recording_mode: platform_recording_mode(),
            privacy_label: platform_privacy_label().to_string(),
            offline: false,
            download_required: false,
            model_size_label: None,
            cache_path: None,
            accelerator_label: Some(platform_accelerator_label().to_string()),
        }
    }

    fn status(&self, registry: &VoiceProviderRegistry, db: &Database) -> VoiceProviderInfo {
        let enabled = registry.enabled(db, self.id());
        #[cfg(target_os = "macos")]
        let (status, status_label, setup_required, error) = if !enabled {
            (
                VoiceProviderStatus::Unavailable,
                "Disabled".to_string(),
                false,
                None,
            )
        } else {
            platform_status_from_availability(registry.platform_speech.availability())
        };
        #[cfg(not(target_os = "macos"))]
        let (status, status_label, setup_required, error) = if enabled {
            (
                VoiceProviderStatus::Ready,
                "Ready when webview speech recognition and OS permissions are available"
                    .to_string(),
                false,
                None,
            )
        } else {
            (
                VoiceProviderStatus::Unavailable,
                "Disabled".to_string(),
                false,
                None,
            )
        };
        VoiceProviderInfo {
            metadata: self.metadata(registry),
            status,
            status_label,
            enabled,
            selected: registry.selected_provider(db).as_deref() == Some(self.id()),
            setup_required,
            can_remove_model: false,
            error,
        }
    }

    async fn prepare(
        &self,
        registry: &VoiceProviderRegistry,
        _app: &AppHandle,
        db_path: &Path,
    ) -> Result<VoiceProviderInfo, String> {
        #[cfg(target_os = "macos")]
        {
            let _ = registry.platform_speech.prepare();
        }
        let db = Database::open(db_path).map_err(|e| e.to_string())?;
        Ok(self.status(registry, &db))
    }
}

struct DistilWhisperCandleProvider;

#[async_trait]
impl VoiceProvider for DistilWhisperCandleProvider {
    fn id(&self) -> &'static str {
        DISTIL_ID
    }

    fn metadata(&self, registry: &VoiceProviderRegistry) -> VoiceProviderMetadata {
        let cache_path = registry.distil_cache_path();
        VoiceProviderMetadata {
            id: self.id().to_string(),
            name: "Distil-Whisper Large v3".to_string(),
            description: "Private offline transcription using distil-whisper/distil-large-v3 through the native provider interface.".to_string(),
            kind: VoiceProviderKind::LocalModel,
            recording_mode: VoiceRecordingMode::Native,
            privacy_label: "Private after download; audio stays local".to_string(),
            offline: true,
            download_required: true,
            model_size_label: Some("About 1.5 GB plus tokenizer/config files".to_string()),
            cache_path: Some(cache_path.display().to_string()),
            accelerator_label: None,
        }
    }

    fn status(&self, registry: &VoiceProviderRegistry, db: &Database) -> VoiceProviderInfo {
        let enabled = registry.enabled(db, self.id());
        if !enabled {
            return VoiceProviderInfo {
                metadata: self.metadata(registry),
                status: VoiceProviderStatus::Unavailable,
                status_label: "Disabled".to_string(),
                enabled: false,
                selected: false,
                setup_required: false,
                can_remove_model: false,
                error: None,
            };
        }

        let cache_path = registry.distil_cache_path();
        let model_status = db
            .get_app_setting(&model_status_key(self.id()))
            .ok()
            .flatten();
        let installed = distil_model_ready(&cache_path);
        let backend_status = registry.ensure_candle_backend_ready();

        let mut metadata = self.metadata(registry);
        metadata.accelerator_label = Some(match &backend_status {
            Ok(backend) => backend.accelerator_label().to_string(),
            Err(err) => format!("Unavailable: {err}"),
        });

        let (status, status_label, setup_required, error) =
            if model_status.as_deref() == Some("downloading") {
                (
                    VoiceProviderStatus::Downloading,
                    "Downloading model".to_string(),
                    true,
                    None,
                )
            } else if let Err(err) = &backend_status {
                (
                    VoiceProviderStatus::EngineUnavailable,
                    "Voice engine unavailable".to_string(),
                    false,
                    Some(err.clone()),
                )
            } else if installed {
                let backend = backend_status.expect("backend availability checked");
                (
                    VoiceProviderStatus::Ready,
                    format!("{DISTIL_READY_MESSAGE} ({})", backend.label()),
                    false,
                    None,
                )
            } else if model_status
                .as_deref()
                .is_some_and(|status| status.starts_with("error:"))
            {
                (
                    VoiceProviderStatus::Error,
                    "Download failed".to_string(),
                    true,
                    model_status.map(|s| s.trim_start_matches("error:").to_string()),
                )
            } else {
                (
                    VoiceProviderStatus::NeedsSetup,
                    "Download required".to_string(),
                    true,
                    None,
                )
            };

        VoiceProviderInfo {
            metadata,
            status,
            status_label,
            enabled,
            selected: registry.selected_provider(db).as_deref() == Some(self.id()),
            setup_required,
            can_remove_model: installed,
            error,
        }
    }

    async fn prepare(
        &self,
        registry: &VoiceProviderRegistry,
        app: &AppHandle,
        db_path: &Path,
    ) -> Result<VoiceProviderInfo, String> {
        let cache_path = registry.distil_cache_path();
        tokio::fs::create_dir_all(&cache_path)
            .await
            .map_err(|e| format!("Failed to create model cache: {e}"))?;
        {
            let db = Database::open(db_path).map_err(|e| e.to_string())?;
            db.set_app_setting(&model_status_key(self.id()), "downloading")
                .map_err(|e| e.to_string())?;
        }

        let result = download_distil_model(app, self.id(), &cache_path).await;
        match result {
            Ok(()) => {
                let db = Database::open(db_path).map_err(|e| e.to_string())?;
                db.set_app_setting(&model_status_key(self.id()), "installed")
                    .map_err(|e| e.to_string())?;
                let info = self.status(registry, &db);
                let _ = app.emit("voice-provider-status", &info);
                Ok(info)
            }
            Err(err) => {
                let db = Database::open(db_path).map_err(|e| e.to_string())?;
                let _ = db.set_app_setting(&model_status_key(self.id()), &format!("error:{err}"));
                let _ = app.emit(
                    "voice-error",
                    VoiceErrorEvent {
                        provider_id: Some(self.id().to_string()),
                        message: err.clone(),
                    },
                );
                Err(err)
            }
        }
    }
}

fn enabled_key(provider_id: &str) -> String {
    format!("voice:{provider_id}:enabled")
}

fn model_status_key(provider_id: &str) -> String {
    format!("voice:{provider_id}:model_status")
}

fn distil_model_ready(cache_path: &Path) -> bool {
    DISTIL_MODEL_FILES.iter().all(|(filename, min_size)| {
        let path = cache_path.join(filename);
        if let Some(min_size) = min_size {
            path.metadata().is_ok_and(|m| m.len() >= *min_size)
        } else {
            path.is_file()
        }
    })
}

#[cfg(target_os = "macos")]
fn select_candle_device() -> Result<(Device, CandleBackend), String> {
    if !candle_core::utils::metal_is_available() {
        return Err(
            "Candle Metal is not available in this macOS build. Rebuild the app with candle-core/metal enabled."
                .to_string(),
        );
    }

    let device = Device::new_metal(0)
        .map_err(|e| format!("Failed to initialize Candle Metal device: {e}"))?;
    Ok((device, CandleBackend::Metal))
}

#[cfg(not(target_os = "macos"))]
fn select_candle_device() -> Result<(Device, CandleBackend), String> {
    Ok((Device::Cpu, CandleBackend::Cpu))
}

fn ensure_candle_backend_ready() -> Result<CandleBackend, String> {
    static BACKEND_READY: OnceLock<Result<CandleBackend, String>> = OnceLock::new();

    BACKEND_READY
        .get_or_init(check_candle_backend_ready)
        .clone()
}

fn check_candle_backend_ready() -> Result<CandleBackend, String> {
    let (device, backend) = select_candle_device()?;
    verify_candle_whisper_backend_for(&device, backend)?;
    Ok(backend)
}

fn verify_candle_whisper_backend_for(
    device: &Device,
    backend: CandleBackend,
) -> Result<(), String> {
    verify_candle_whisper_backend(device)
        .map_err(|err| format!("Candle {} Whisper backend failed {err}", backend.label()))
}

fn verify_candle_whisper_backend(device: &Device) -> Result<(), String> {
    probe_candle_whisper_op("conv1d", || {
        let input = Tensor::new(
            &[[
                [0.1_f32, 0.2, -0.1, 0.0, 0.3, -0.3, 0.4, 0.5],
                [0.5_f32, -0.4, 0.3, -0.2, 0.1, 0.0, -0.1, 0.2],
            ]],
            device,
        )?;
        let kernel = Tensor::new(
            &[
                [[0.2_f32, 0.1, -0.1], [0.0_f32, 0.3, 0.2]],
                [[-0.2_f32, 0.4, 0.1], [0.1_f32, -0.3, 0.2]],
            ],
            device,
        )?;
        let output = input.conv1d(&kernel, 1, 1, 1, 1)?;
        let _ = output.to_vec3::<f32>()?;
        Ok(())
    })?;
    probe_candle_whisper_op("gelu", || {
        let output = Tensor::new(&[-1.0_f32, 0.0, 1.0, 2.0], device)?.gelu()?;
        let _ = output.to_vec1::<f32>()?;
        Ok(())
    })?;
    probe_candle_whisper_op("layer_norm", || {
        let xs = Tensor::new(&[[1.0_f32, 2.0], [3.0, 4.0]], device)?;
        let alpha = Tensor::new(&[1.0_f32, 1.0], device)?;
        let beta = Tensor::new(&[0.0_f32, 0.0], device)?;
        let output = candle_nn::ops::layer_norm(&xs, &alpha, &beta, 1e-5)?;
        let _ = output.to_vec2::<f32>()?;
        Ok(())
    })?;
    probe_candle_whisper_op("softmax", || {
        let logits = Tensor::new(&[[1.0_f32, 2.0, 3.0]], device)?;
        let output = softmax(&logits, D::Minus1)?;
        let _ = output.to_vec2::<f32>()?;
        Ok(())
    })?;
    probe_candle_whisper_op("matmul", || {
        let lhs = Tensor::new(&[[1.0_f32, 2.0, 3.0], [4.0, 5.0, 6.0]], device)?;
        let rhs = Tensor::new(&[[1.0_f32, 2.0], [3.0, 4.0], [5.0, 6.0]], device)?;
        let output = lhs.matmul(&rhs)?;
        let _ = output.to_vec2::<f32>()?;
        Ok(())
    })?;
    probe_candle_whisper_op("broadcast_add", || {
        let matrix = Tensor::new(&[[1.0_f32, 2.0, 3.0], [4.0, 5.0, 6.0]], device)?;
        let bias = Tensor::new(&[0.5_f32, -0.5, 1.0], device)?;
        let output = matrix.broadcast_add(&bias)?;
        let _ = output.to_vec2::<f32>()?;
        Ok(())
    })?;
    probe_candle_whisper_op("index_select", || {
        let source = Tensor::new(&[[1.0_f32, 2.0], [3.0, 4.0], [5.0, 6.0]], device)?;
        let indexes = Tensor::new(&[2_u32, 0], device)?;
        let output = source.index_select(&indexes, 0)?;
        let _ = output.to_vec2::<f32>()?;
        Ok(())
    })?;
    probe_candle_whisper_op("scalar_readback", || {
        let value = Tensor::new(&[42.0_f32], device)?.i(0)?.to_scalar::<f32>()?;
        if (value - 42.0).abs() > f32::EPSILON {
            return Err(candle_core::Error::Msg(format!(
                "expected 42.0, got {value}"
            )));
        }
        Ok(())
    })
}

fn probe_candle_whisper_op(
    op: &'static str,
    run: impl FnOnce() -> candle_core::Result<()>,
) -> Result<(), String> {
    run().map_err(|e| format!("{op}: {e}"))
}

fn validate_captured_audio(audio: &CapturedAudio) -> Result<(), String> {
    let peak = audio
        .samples
        .iter()
        .fold(0.0_f32, |peak, sample| peak.max(sample.abs()));
    if peak < MIN_SIGNAL_PEAK {
        return Err("No speech was detected. Check microphone input and try again.".to_string());
    }
    Ok(())
}

fn normalize_interleaved_f32(input: &[f32], channels: u16) -> Vec<f32> {
    normalize_interleaved_samples(input, channels)
}

fn normalize_interleaved_f64(input: &[f64], channels: u16) -> Vec<f32> {
    normalize_interleaved_samples(input, channels)
}

fn normalize_interleaved_i8(input: &[i8], channels: u16) -> Vec<f32> {
    normalize_interleaved_samples(input, channels)
}

fn normalize_interleaved_i16(input: &[i16], channels: u16) -> Vec<f32> {
    normalize_interleaved_samples(input, channels)
}

fn normalize_interleaved_i24(input: &[cpal::I24], channels: u16) -> Vec<f32> {
    normalize_interleaved_samples(input, channels)
}

fn normalize_interleaved_i32(input: &[i32], channels: u16) -> Vec<f32> {
    normalize_interleaved_samples(input, channels)
}

fn normalize_interleaved_i64(input: &[i64], channels: u16) -> Vec<f32> {
    normalize_interleaved_samples(input, channels)
}

fn normalize_interleaved_u8(input: &[u8], channels: u16) -> Vec<f32> {
    normalize_interleaved_samples(input, channels)
}

fn normalize_interleaved_u16(input: &[u16], channels: u16) -> Vec<f32> {
    normalize_interleaved_samples(input, channels)
}

fn normalize_interleaved_u24(input: &[cpal::U24], channels: u16) -> Vec<f32> {
    normalize_interleaved_samples(input, channels)
}

fn normalize_interleaved_u32(input: &[u32], channels: u16) -> Vec<f32> {
    normalize_interleaved_samples(input, channels)
}

fn normalize_interleaved_u64(input: &[u64], channels: u16) -> Vec<f32> {
    normalize_interleaved_samples(input, channels)
}

fn normalize_interleaved_samples<T>(input: &[T], channels: u16) -> Vec<f32>
where
    T: cpal::Sample + Copy,
    f64: cpal::FromSample<T>,
{
    mix_interleaved_to_mono(input, channels, |sample| {
        f64::from_sample(sample).clamp(-1.0, 1.0) as f32
    })
}

fn mix_interleaved_to_mono<T>(
    input: &[T],
    channels: u16,
    mut convert: impl FnMut(T) -> f32,
) -> Vec<f32>
where
    T: Copy,
{
    let channel_count = usize::from(channels.max(1));
    input
        .chunks(channel_count)
        .map(|frame| frame.iter().copied().map(&mut convert).sum::<f32>() / frame.len() as f32)
        .collect()
}

fn resample_to_target_rate(samples: &[f32], sample_rate: u32) -> Vec<f32> {
    if samples.is_empty() || sample_rate == TARGET_SAMPLE_RATE {
        return samples.to_vec();
    }

    let output_len =
        (samples.len() as u64 * u64::from(TARGET_SAMPLE_RATE) / u64::from(sample_rate)).max(1);
    let ratio = sample_rate as f64 / TARGET_SAMPLE_RATE as f64;
    (0..output_len)
        .map(|out_index| {
            let source = out_index as f64 * ratio;
            let left = source.floor() as usize;
            let right = (left + 1).min(samples.len() - 1);
            let frac = (source - left as f64) as f32;
            samples[left] * (1.0 - frac) + samples[right] * frac
        })
        .collect()
}

impl AudioRecorder for CpalAudioRecorder {
    fn start(&self) -> Result<RecordingSession, String> {
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or_else(|| "No default microphone input device is available".to_string())?;
        let supported_config = device
            .default_input_config()
            .map_err(|e| format!("Failed to read microphone input config: {e}"))?;
        let sample_rate = supported_config.sample_rate();
        let channels = supported_config.channels();
        let stream_config: cpal::StreamConfig = supported_config.clone().into();
        let samples = Arc::new(Mutex::new(Vec::<f32>::new()));
        let stream_error = Arc::new(Mutex::new(None));

        macro_rules! build_input_stream {
            ($sample_ty:ty, $normalize:path) => {{
                let samples = Arc::clone(&samples);
                let stream_error = Arc::clone(&stream_error);
                device.build_input_stream(
                    &stream_config,
                    move |data: &[$sample_ty], _| {
                        samples.lock().extend($normalize(data, channels));
                    },
                    move |err| {
                        *stream_error.lock() = Some(err.to_string());
                        eprintln!("voice input stream error: {err}");
                    },
                    None,
                )
            }};
        }

        let stream = match supported_config.sample_format() {
            cpal::SampleFormat::I8 => build_input_stream!(i8, normalize_interleaved_i8),
            cpal::SampleFormat::I16 => build_input_stream!(i16, normalize_interleaved_i16),
            cpal::SampleFormat::I24 => build_input_stream!(cpal::I24, normalize_interleaved_i24),
            cpal::SampleFormat::I32 => build_input_stream!(i32, normalize_interleaved_i32),
            cpal::SampleFormat::I64 => build_input_stream!(i64, normalize_interleaved_i64),
            cpal::SampleFormat::U8 => build_input_stream!(u8, normalize_interleaved_u8),
            cpal::SampleFormat::U16 => build_input_stream!(u16, normalize_interleaved_u16),
            cpal::SampleFormat::U24 => build_input_stream!(cpal::U24, normalize_interleaved_u24),
            cpal::SampleFormat::U32 => build_input_stream!(u32, normalize_interleaved_u32),
            cpal::SampleFormat::U64 => build_input_stream!(u64, normalize_interleaved_u64),
            cpal::SampleFormat::F32 => build_input_stream!(f32, normalize_interleaved_f32),
            cpal::SampleFormat::F64 => build_input_stream!(f64, normalize_interleaved_f64),
            other => {
                return Err(format!("Unsupported microphone sample format: {other:?}"));
            }
        }
        .map_err(|e| format!("Failed to open microphone input stream: {e}"))?;
        stream
            .play()
            .map_err(|e| format!("Failed to start microphone input stream: {e}"))?;

        Ok(RecordingSession {
            samples,
            stream_error,
            sample_rate,
            _stream: Some(stream),
            _level_task: None,
        })
    }
}

impl VoiceTranscriber for CandleWhisperTranscriber {
    fn transcribe(
        &self,
        cache_path: &Path,
        captured: CapturedAudio,
        cancel: &Arc<AtomicBool>,
    ) -> Result<String, String> {
        transcribe_distil_whisper(cache_path, captured, cancel)
    }
}

enum WhisperModel {
    Normal(whisper::model::Whisper),
}

impl WhisperModel {
    fn config(&self) -> &Config {
        match self {
            Self::Normal(model) => &model.config,
        }
    }

    fn encoder_forward(&mut self, input: &Tensor, flush: bool) -> candle_core::Result<Tensor> {
        match self {
            Self::Normal(model) => model.encoder.forward(input, flush),
        }
    }

    fn decoder_forward(
        &mut self,
        input: &Tensor,
        audio_features: &Tensor,
        flush: bool,
    ) -> candle_core::Result<Tensor> {
        match self {
            Self::Normal(model) => model.decoder.forward(input, audio_features, flush),
        }
    }

    fn decoder_final_linear(&self, input: &Tensor) -> candle_core::Result<Tensor> {
        match self {
            Self::Normal(model) => model.decoder.final_linear(input),
        }
    }
}

struct WhisperDecoder {
    model: WhisperModel,
    tokenizer: Tokenizer,
    suppress_tokens: Tensor,
    sot_token: u32,
    transcribe_token: u32,
    eot_token: u32,
    no_speech_token: Option<u32>,
    no_timestamps_token: u32,
    language_token: Option<u32>,
}

struct WhisperDecodingResult {
    text: String,
    avg_logprob: f64,
    no_speech_prob: f64,
}

impl WhisperDecoder {
    fn new(model: WhisperModel, tokenizer: Tokenizer, device: &Device) -> Result<Self, String> {
        let no_timestamps_token = token_id(&tokenizer, whisper::NO_TIMESTAMPS_TOKEN)?;
        let suppress_tokens = (0..model.config().vocab_size as u32)
            .map(|index| {
                if model.config().suppress_tokens.contains(&index) {
                    f32::NEG_INFINITY
                } else {
                    0.0
                }
            })
            .collect::<Vec<_>>();
        let suppress_tokens = Tensor::new(suppress_tokens.as_slice(), device)
            .map_err(|e| format!("Failed to build Whisper token suppression mask: {e}"))?;

        Ok(Self {
            sot_token: token_id(&tokenizer, whisper::SOT_TOKEN)?,
            transcribe_token: token_id(&tokenizer, whisper::TRANSCRIBE_TOKEN)?,
            eot_token: token_id(&tokenizer, whisper::EOT_TOKEN)?,
            no_speech_token: whisper::NO_SPEECH_TOKENS
                .iter()
                .find_map(|token| token_id(&tokenizer, token).ok()),
            no_timestamps_token,
            language_token: None,
            model,
            tokenizer,
            suppress_tokens,
        })
    }

    fn run(&mut self, mel: &Tensor, cancel: &Arc<AtomicBool>) -> Result<String, String> {
        if self.language_token.is_none() {
            self.language_token = self.detect_language_token(mel)?;
        }
        let (_, _, content_frames) = mel
            .dims3()
            .map_err(|e| format!("Invalid Whisper mel tensor: {e}"))?;
        let mut seek = 0;
        let mut text = String::new();

        while seek < content_frames {
            if cancel.load(Ordering::Relaxed) {
                return Err("Transcription cancelled.".to_string());
            }
            let segment_size = usize::min(content_frames - seek, whisper::N_FRAMES);
            let segment = mel
                .narrow(2, seek, segment_size)
                .map_err(|e| format!("Failed to slice Whisper mel segment: {e}"))?;
            let decoded = self.decode(&segment, cancel)?;
            if decoded.no_speech_prob > whisper::NO_SPEECH_THRESHOLD
                && decoded.avg_logprob < whisper::LOGPROB_THRESHOLD
            {
                seek += segment_size;
                continue;
            }
            if !decoded.text.trim().is_empty() {
                if !text.is_empty() {
                    text.push(' ');
                }
                text.push_str(decoded.text.trim());
            }
            seek += segment_size;
        }

        Ok(text.trim().to_string())
    }

    fn detect_language_token(&mut self, mel: &Tensor) -> Result<Option<u32>, String> {
        let language_token_ids = WHISPER_LANGUAGE_CODES
            .iter()
            .filter_map(|code| self.tokenizer.token_to_id(&format!("<|{code}|>")))
            .collect::<Vec<_>>();
        if language_token_ids.is_empty() {
            return Ok(None);
        }

        let (_, _, seq_len) = mel
            .dims3()
            .map_err(|e| format!("Invalid Whisper mel tensor: {e}"))?;
        let mel = mel
            .narrow(
                2,
                0,
                usize::min(seq_len, self.model.config().max_source_positions),
            )
            .map_err(|e| format!("Failed to slice Whisper language mel segment: {e}"))?;
        let audio_features = self
            .model
            .encoder_forward(&mel, true)
            .map_err(|e| format!("Whisper language encoder failed: {e}"))?;
        let tokens = Tensor::new(&[[self.sot_token]], mel.device())
            .map_err(|e| format!("Failed to build Whisper language token tensor: {e}"))?;
        let token_ids = Tensor::new(language_token_ids.as_slice(), mel.device())
            .map_err(|e| format!("Failed to build Whisper language token list: {e}"))?;
        let decoded = self
            .model
            .decoder_forward(&tokens, &audio_features, true)
            .map_err(|e| format!("Whisper language decoder failed: {e}"))?;
        let logits = self
            .model
            .decoder_final_linear(
                &decoded
                    .i(..1)
                    .map_err(|e| format!("Failed to slice Whisper language logits: {e}"))?,
            )
            .and_then(|logits| logits.i(0))
            .and_then(|logits| logits.i(0))
            .and_then(|logits| logits.index_select(&token_ids, 0))
            .map_err(|e| format!("Whisper language logits failed: {e}"))?;
        let probs = softmax(&logits, D::Minus1)
            .map_err(|e| format!("Whisper language softmax failed: {e}"))?;
        let values = probs
            .to_vec1::<f32>()
            .map_err(|e| format!("Failed to read Whisper language probabilities: {e}"))?;
        values
            .iter()
            .enumerate()
            .max_by(|(_, left), (_, right)| left.total_cmp(right))
            .map(|(index, _)| Some(language_token_ids[index]))
            .ok_or_else(|| "Whisper returned no language probabilities".to_string())
    }

    fn decode(
        &mut self,
        mel: &Tensor,
        cancel: &Arc<AtomicBool>,
    ) -> Result<WhisperDecodingResult, String> {
        let audio_features = self
            .model
            .encoder_forward(mel, true)
            .map_err(|e| format!("Whisper encoder failed: {e}"))?;
        let mut tokens = decoder_prompt_tokens(
            self.sot_token,
            self.language_token,
            self.transcribe_token,
            self.no_timestamps_token,
        );
        let sample_len = self.model.config().max_target_positions / 2;
        let mut sum_logprob = 0.0_f64;
        let mut generated_tokens = 0_usize;
        let mut no_speech_prob = f64::NAN;

        for index in 0..sample_len {
            if cancel.load(Ordering::Relaxed) {
                return Err("Transcription cancelled.".to_string());
            }
            let tokens_tensor = Tensor::new(tokens.as_slice(), mel.device())
                .and_then(|tensor| tensor.unsqueeze(0))
                .map_err(|e| format!("Failed to build Whisper token tensor: {e}"))?;
            let decoded = self
                .model
                .decoder_forward(&tokens_tensor, &audio_features, index == 0)
                .map_err(|e| format!("Whisper decoder failed: {e}"))?;
            if index == 0
                && let Some(no_speech_token) = self.no_speech_token
            {
                let logits =
                    self.model
                        .decoder_final_linear(&decoded.i(..1).map_err(|e| {
                            format!("Failed to slice Whisper no-speech logits: {e}")
                        })?)
                        .and_then(|logits| logits.i(0))
                        .and_then(|logits| logits.i(0))
                        .map_err(|e| format!("Whisper no-speech logits failed: {e}"))?;
                no_speech_prob = softmax(&logits, D::Minus1)
                    .and_then(|probs| probs.i(no_speech_token as usize))
                    .and_then(|prob| prob.to_scalar::<f32>())
                    .map_err(|e| format!("Whisper no-speech probability failed: {e}"))?
                    as f64;
            }
            let (_, seq_len, _) = decoded
                .dims3()
                .map_err(|e| format!("Invalid Whisper decoder output: {e}"))?;
            let logits = self
                .model
                .decoder_final_linear(
                    &decoded
                        .i((..1, seq_len - 1..))
                        .map_err(|e| format!("Failed to slice Whisper logits: {e}"))?,
                )
                .and_then(|logits| logits.i(0))
                .and_then(|logits| logits.i(0))
                .and_then(|logits| logits.broadcast_add(&self.suppress_tokens))
                .map_err(|e| format!("Whisper logits failed: {e}"))?;
            let (next_token, next_prob) = greedy_token_with_prob(&logits)?;
            tokens.push(next_token);
            if next_token == self.eot_token {
                break;
            }
            generated_tokens += 1;
            if next_prob > 0.0 {
                sum_logprob += next_prob.ln();
            }
        }

        let text = self
            .tokenizer
            .decode(&tokens, true)
            .map(|text| text.trim().to_string())
            .map_err(|e| format!("Failed to decode Whisper tokens: {e}"))?;
        Ok(WhisperDecodingResult {
            text,
            avg_logprob: sum_logprob / generated_tokens.max(1) as f64,
            no_speech_prob,
        })
    }
}

fn decoder_prompt_tokens(
    sot_token: u32,
    language_token: Option<u32>,
    transcribe_token: u32,
    no_timestamps_token: u32,
) -> Vec<u32> {
    let mut tokens = vec![sot_token];
    if let Some(language_token) = language_token {
        tokens.push(language_token);
    }
    tokens.push(transcribe_token);
    tokens.push(no_timestamps_token);
    tokens
}

fn greedy_token_with_prob(logits: &Tensor) -> Result<(u32, f64), String> {
    let probs = softmax(logits, D::Minus1).map_err(|e| format!("Whisper softmax failed: {e}"))?;
    let values = probs
        .to_vec1::<f32>()
        .map_err(|e| format!("Failed to read Whisper logits: {e}"))?;
    values
        .iter()
        .enumerate()
        .max_by(|(_, left), (_, right)| left.total_cmp(right))
        .map(|(index, prob)| (index as u32, f64::from(*prob)))
        .ok_or_else(|| "Whisper returned no token logits".to_string())
}

fn token_id(tokenizer: &Tokenizer, token: &str) -> Result<u32, String> {
    tokenizer
        .token_to_id(token)
        .ok_or_else(|| format!("Whisper tokenizer is missing token {token}"))
}

fn transcribe_distil_whisper(
    cache_path: &Path,
    captured: CapturedAudio,
    cancel: &Arc<AtomicBool>,
) -> Result<String, String> {
    if captured.sample_rate != TARGET_SAMPLE_RATE {
        return Err(format!(
            "Expected {TARGET_SAMPLE_RATE} Hz audio, got {} Hz",
            captured.sample_rate
        ));
    }
    if !distil_model_ready(cache_path) {
        return Err("Distil-Whisper model files are incomplete".to_string());
    }

    let config_path = cache_path.join("config.json");
    let tokenizer_path = cache_path.join("tokenizer.json");
    let weights_path = cache_path.join("model.safetensors");
    let config: Config = serde_json::from_str(
        &std::fs::read_to_string(&config_path)
            .map_err(|e| format!("Failed to read Whisper config: {e}"))?,
    )
    .map_err(|e| format!("Failed to parse Whisper config: {e}"))?;
    let tokenizer = Tokenizer::from_file(&tokenizer_path)
        .map_err(|e| format!("Failed to load tokenizer: {e}"))?;
    let backend = ensure_candle_backend_ready()?;
    let (device, _) = select_candle_device()?;
    let backend_label = backend.label();
    let mel_filters = build_mel_filters(config.num_mel_bins);
    let mel = audio::pcm_to_mel(&config, &captured.samples, &mel_filters);
    let mel_len = mel.len() / config.num_mel_bins;
    let mel = Tensor::from_vec(mel, (1, config.num_mel_bins, mel_len), &device)
        .map_err(|e| format!("Failed to build Whisper mel tensor on {backend_label}: {e}"))?;
    let var_builder =
        unsafe { VarBuilder::from_mmaped_safetensors(&[weights_path], whisper::DTYPE, &device) }
            .map_err(|e| format!("Failed to load Whisper weights on {backend_label}: {e}"))?;
    let model = whisper::model::Whisper::load(&var_builder, config)
        .map_err(|e| format!("Failed to initialize Whisper model on {backend_label}: {e}"))?;
    let mut decoder = WhisperDecoder::new(WhisperModel::Normal(model), tokenizer, &device)?;
    decoder
        .run(&mel, cancel)
        .map_err(|e| format!("Whisper transcription failed on {backend_label}: {e}"))
}

fn build_mel_filters(num_mel_bins: usize) -> Vec<f32> {
    let freq_bins = whisper::N_FFT / 2 + 1;
    let min_mel = hz_to_mel(0.0);
    let max_mel = hz_to_mel(TARGET_SAMPLE_RATE as f32 / 2.0);
    let mel_points = (0..num_mel_bins + 2)
        .map(|index| {
            let fraction = index as f32 / (num_mel_bins + 1) as f32;
            mel_to_hz(min_mel + fraction * (max_mel - min_mel))
        })
        .collect::<Vec<_>>();
    let fft_freqs = (0..freq_bins)
        .map(|index| index as f32 * TARGET_SAMPLE_RATE as f32 / whisper::N_FFT as f32)
        .collect::<Vec<_>>();
    let mut filters = vec![0.0; num_mel_bins * freq_bins];

    for mel_index in 0..num_mel_bins {
        let left = mel_points[mel_index];
        let center = mel_points[mel_index + 1];
        let right = mel_points[mel_index + 2];
        for (freq_index, freq) in fft_freqs.iter().copied().enumerate() {
            let value = if freq < left || freq > right {
                0.0
            } else if freq <= center {
                (freq - left) / (center - left)
            } else {
                (right - freq) / (right - center)
            };
            filters[mel_index * freq_bins + freq_index] = value.max(0.0);
        }
    }

    filters
}

fn hz_to_mel(hz: f32) -> f32 {
    2595.0 * (1.0 + hz / 700.0).log10()
}

fn mel_to_hz(mel: f32) -> f32 {
    700.0 * (10_f32.powf(mel / 2595.0) - 1.0)
}

async fn download_distil_model(
    app: &AppHandle,
    provider_id: &str,
    cache_path: &Path,
) -> Result<(), String> {
    let known_total = DISTIL_MODEL_FILES
        .iter()
        .filter_map(|(_, size)| *size)
        .sum::<u64>();
    let mut overall_downloaded = 0_u64;
    let client = reqwest::Client::new();

    for (filename, known_size) in DISTIL_MODEL_FILES {
        let destination = cache_path.join(filename);
        if destination.is_file() {
            overall_downloaded += destination.metadata().map(|m| m.len()).unwrap_or(0);
            continue;
        }

        let url = format!(
            "https://huggingface.co/distil-whisper/distil-large-v3/resolve/main/{filename}"
        );
        let response = client
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("Failed to download {filename}: {e}"))?
            .error_for_status()
            .map_err(|e| format!("Failed to download {filename}: {e}"))?;

        let total = response.content_length().or(known_size);
        let part_path = destination.with_extension("part");
        let mut file = tokio::fs::File::create(&part_path)
            .await
            .map_err(|e| format!("Failed to write {filename}: {e}"))?;
        let mut stream = response.bytes_stream();
        let mut downloaded = 0_u64;

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("Failed while downloading {filename}: {e}"))?;
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("Failed to write {filename}: {e}"))?;
            downloaded += chunk.len() as u64;
            let denominator = known_total.max(total.unwrap_or(0));
            let percent = if denominator > 0 {
                Some(((overall_downloaded + downloaded) as f64 / denominator as f64).min(1.0))
            } else {
                None
            };
            let _ = app.emit(
                "voice-download-progress",
                VoiceDownloadProgress {
                    provider_id: provider_id.to_string(),
                    filename: filename.to_string(),
                    downloaded_bytes: downloaded,
                    total_bytes: total,
                    overall_downloaded_bytes: overall_downloaded + downloaded,
                    overall_total_bytes: if known_total > 0 {
                        Some(known_total)
                    } else {
                        None
                    },
                    percent,
                },
            );
        }
        file.flush()
            .await
            .map_err(|e| format!("Failed to flush {filename}: {e}"))?;
        tokio::fs::rename(&part_path, &destination)
            .await
            .map_err(|e| format!("Failed to finalize {filename}: {e}"))?;
        overall_downloaded += downloaded;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tempfile::tempdir;

    fn test_db_path() -> (tempfile::TempDir, PathBuf) {
        let dir = tempdir().expect("tempdir");
        let db_path = dir.path().join("claudette.db");
        let db = Database::open(&db_path).expect("open db");
        drop(db);
        (dir, db_path)
    }

    fn open_test_db(path: &Path) -> Database {
        Database::open(path).expect("open db")
    }

    fn write_complete_distil_model(cache_path: &Path) {
        std::fs::create_dir_all(cache_path).expect("create model cache");
        std::fs::write(cache_path.join("tokenizer.json"), "{}").expect("write tokenizer");
        std::fs::write(cache_path.join("config.json"), "{}").expect("write config");
        std::fs::write(cache_path.join("generation_config.json"), "{}")
            .expect("write generation config");
        std::fs::write(cache_path.join("preprocessor_config.json"), "{}")
            .expect("write preprocessor config");
        let model_file =
            std::fs::File::create(cache_path.join("model.safetensors")).expect("create model");
        model_file.set_len(100_000_001).expect("size model");
    }

    #[cfg(target_os = "macos")]
    fn run_minimal_whisper_forward(device: &Device) -> Result<(), String> {
        let config = Config {
            num_mel_bins: 4,
            max_source_positions: 4,
            d_model: 8,
            encoder_attention_heads: 2,
            encoder_layers: 1,
            vocab_size: 16,
            max_target_positions: 4,
            decoder_attention_heads: 2,
            decoder_layers: 1,
            suppress_tokens: Vec::new(),
        };
        let vb = VarBuilder::zeros(whisper::DTYPE, device);
        let mut model = whisper::model::Whisper::load(&vb, config.clone())
            .map_err(|e| format!("load minimal whisper: {e}"))?;
        let mel = Tensor::zeros(
            (1, config.num_mel_bins, config.max_source_positions * 2),
            whisper::DTYPE,
            device,
        )
        .map_err(|e| format!("build minimal mel: {e}"))?;
        let audio_features = model
            .encoder
            .forward(&mel, true)
            .map_err(|e| format!("minimal encoder forward: {e}"))?;
        let tokens =
            Tensor::new(&[[1_u32]], device).map_err(|e| format!("build minimal tokens: {e}"))?;
        let decoded = model
            .decoder
            .forward(&tokens, &audio_features, true)
            .map_err(|e| format!("minimal decoder forward: {e}"))?;
        let logits = model
            .decoder
            .final_linear(&decoded)
            .map_err(|e| format!("minimal decoder logits: {e}"))?;
        let _ = logits
            .to_vec3::<f32>()
            .map_err(|e| format!("read minimal logits: {e}"))?;
        Ok(())
    }

    fn read_wav_fixture(path: &Path) -> Result<CapturedAudio, String> {
        let mut reader =
            hound::WavReader::open(path).map_err(|e| format!("Failed to open WAV fixture: {e}"))?;
        let spec = reader.spec();
        if spec.channels == 0 {
            return Err("WAV fixture has no audio channels".to_string());
        }

        let samples = match (spec.sample_format, spec.bits_per_sample) {
            (hound::SampleFormat::Float, 32) => {
                let samples = reader
                    .samples::<f32>()
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| format!("Failed to read f32 WAV samples: {e}"))?;
                normalize_interleaved_f32(&samples, spec.channels)
            }
            (hound::SampleFormat::Int, 16) => {
                let samples = reader
                    .samples::<i16>()
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| format!("Failed to read i16 WAV samples: {e}"))?;
                normalize_interleaved_i16(&samples, spec.channels)
            }
            (hound::SampleFormat::Int, 24 | 32) => {
                let samples = reader
                    .samples::<i32>()
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| format!("Failed to read i32 WAV samples: {e}"))?;
                normalize_interleaved_i32(&samples, spec.channels)
            }
            (sample_format, bits) => {
                return Err(format!(
                    "Unsupported WAV fixture format: {sample_format:?} {bits}-bit"
                ));
            }
        };

        Ok(CapturedAudio {
            samples: resample_to_target_rate(&samples, spec.sample_rate),
            sample_rate: TARGET_SAMPLE_RATE,
        })
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn candle_metal_feature_is_enabled_on_macos() {
        assert!(candle_core::utils::metal_is_available());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn candle_metal_layer_norm_runs_on_macos() {
        let device = Device::new_metal(0).expect("metal device");
        let xs = Tensor::new(&[[1.0_f32, 2.0], [3.0, 4.0]], &device).expect("input tensor");
        let alpha = Tensor::new(&[1.0_f32, 1.0], &device).expect("alpha tensor");
        let beta = Tensor::new(&[0.0_f32, 0.0], &device).expect("beta tensor");

        candle_nn::ops::layer_norm(&xs, &alpha, &beta, 1e-5).expect("metal layer norm should run");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn candle_metal_whisper_ops_probe_runs_on_macos() {
        let device = Device::new_metal(0).expect("metal device");

        verify_candle_whisper_backend(&device).expect("metal whisper op probe should run");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn minimal_whisper_forward_runs_on_selected_metal_backend() {
        let device = Device::new_metal(0).expect("metal device");

        run_minimal_whisper_forward(&device).expect("minimal whisper forward should run");
    }

    #[test]
    fn distil_provider_reports_engine_unavailable_when_backend_probe_fails() {
        let (_db_dir, db_path) = test_db_path();
        let model_dir = tempdir().expect("model dir");
        write_complete_distil_model(&model_dir.path().join(DISTIL_CACHE_DIR));
        let db = open_test_db(&db_path);
        let registry = VoiceProviderRegistry::with_runtime_and_backend(
            model_dir.path().to_path_buf(),
            Arc::new(FakeRecorder::new(vec![0.1])),
            Arc::new(FakeTranscriber::ok("ignored")),
            Arc::new(FakeBackendChecker::err(
                "Candle Metal Whisper backend failed layer_norm: test failure",
            )),
        );

        let provider = registry
            .list_providers(&db)
            .into_iter()
            .find(|provider| provider.metadata.id == DISTIL_ID)
            .expect("distil provider");

        assert_eq!(provider.status, VoiceProviderStatus::EngineUnavailable);
        assert!(!provider.setup_required);
        assert!(
            provider
                .error
                .as_deref()
                .is_some_and(|error| error.contains("failed layer_norm"))
        );
    }

    #[test]
    fn distil_provider_skips_backend_probe_when_disabled() {
        let (_db_dir, db_path) = test_db_path();
        let model_dir = tempdir().expect("model dir");
        let db = open_test_db(&db_path);
        db.set_app_setting(&enabled_key(DISTIL_ID), "false")
            .expect("disable");
        let checker = Arc::new(CountingBackendChecker::new());
        let registry = VoiceProviderRegistry::with_runtime_and_backend(
            model_dir.path().to_path_buf(),
            Arc::new(FakeRecorder::new(vec![0.1])),
            Arc::new(FakeTranscriber::ok("ignored")),
            checker.clone(),
        );

        let provider = registry
            .list_providers(&db)
            .into_iter()
            .find(|p| p.metadata.id == DISTIL_ID)
            .expect("distil provider");

        assert_eq!(provider.status, VoiceProviderStatus::Unavailable);
        assert_eq!(
            checker.call_count(),
            0,
            "backend probe should not be called for disabled provider"
        );
        assert!(provider.metadata.accelerator_label.is_none());
    }

    #[test]
    #[ignore = "requires local Distil-Whisper cache and CLAUDETTE_VOICE_SAMPLE_WAV"]
    fn ignored_real_model_probe_transcribes_fixture_wav() {
        let cache_path = std::env::var_os("CLAUDETTE_VOICE_MODEL_CACHE")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from("/Users/jamesbrink/.claudette/models/voice/distil-whisper-large-v3")
            });
        let sample_path = std::env::var_os("CLAUDETTE_VOICE_SAMPLE_WAV")
            .map(PathBuf::from)
            .expect("set CLAUDETTE_VOICE_SAMPLE_WAV to a short speech WAV");
        let audio = read_wav_fixture(&sample_path).expect("read speech wav");

        let cancel = Arc::new(AtomicBool::new(false));
        let transcript =
            transcribe_distil_whisper(&cache_path, audio, &cancel).expect("transcribe fixture");

        assert!(!transcript.trim().is_empty());
    }

    struct FakeRecorder {
        starts: AtomicUsize,
        samples: Vec<f32>,
        sample_rate: u32,
        stream_error: Option<String>,
    }

    impl FakeRecorder {
        fn new(samples: Vec<f32>) -> Self {
            Self {
                starts: AtomicUsize::new(0),
                samples,
                sample_rate: TARGET_SAMPLE_RATE,
                stream_error: None,
            }
        }

        fn new_with_stream_error(samples: Vec<f32>, stream_error: impl Into<String>) -> Self {
            Self {
                starts: AtomicUsize::new(0),
                samples,
                sample_rate: TARGET_SAMPLE_RATE,
                stream_error: Some(stream_error.into()),
            }
        }
    }

    impl AudioRecorder for FakeRecorder {
        fn start(&self) -> Result<RecordingSession, String> {
            self.starts.fetch_add(1, Ordering::Relaxed);
            if let Some(stream_error) = &self.stream_error {
                return Ok(RecordingSession::from_samples_with_stream_error(
                    self.samples.clone(),
                    self.sample_rate,
                    stream_error.clone(),
                ));
            }
            Ok(RecordingSession::from_samples(
                self.samples.clone(),
                self.sample_rate,
            ))
        }
    }

    struct FakeTranscriber {
        calls: AtomicUsize,
        result: Mutex<Result<String, String>>,
        sleep_for: std::time::Duration,
    }

    impl FakeTranscriber {
        fn ok(text: &str) -> Self {
            Self {
                calls: AtomicUsize::new(0),
                result: Mutex::new(Ok(text.to_string())),
                sleep_for: std::time::Duration::ZERO,
            }
        }

        fn err(message: &str) -> Self {
            Self {
                calls: AtomicUsize::new(0),
                result: Mutex::new(Err(message.to_string())),
                sleep_for: std::time::Duration::ZERO,
            }
        }

        fn slow(text: &str, sleep_for: std::time::Duration) -> Self {
            Self {
                calls: AtomicUsize::new(0),
                result: Mutex::new(Ok(text.to_string())),
                sleep_for,
            }
        }
    }

    impl VoiceTranscriber for FakeTranscriber {
        fn transcribe(
            &self,
            _cache_path: &Path,
            _audio: CapturedAudio,
            cancel: &Arc<AtomicBool>,
        ) -> Result<String, String> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            // Poll the cancel flag at coarse intervals to mirror how the real
            // Whisper decoder checks between segments — lets tests exercise the
            // cancellation path without changing the production loop.
            let step = std::time::Duration::from_millis(10);
            let mut remaining = self.sleep_for;
            while remaining > std::time::Duration::ZERO {
                if cancel.load(Ordering::Relaxed) {
                    return Err("Transcription cancelled.".to_string());
                }
                let nap = std::cmp::min(step, remaining);
                std::thread::sleep(nap);
                remaining = remaining.saturating_sub(nap);
            }
            self.result.lock().clone()
        }
    }

    struct FakeBackendChecker {
        result: Result<CandleBackend, String>,
    }

    impl FakeBackendChecker {
        fn err(message: &str) -> Self {
            Self {
                result: Err(message.to_string()),
            }
        }
    }

    impl CandleBackendChecker for FakeBackendChecker {
        fn ready_backend(&self) -> Result<CandleBackend, String> {
            self.result.clone()
        }
    }

    struct CountingBackendChecker {
        calls: AtomicUsize,
    }

    impl CountingBackendChecker {
        fn new() -> Self {
            Self {
                calls: AtomicUsize::new(0),
            }
        }

        fn call_count(&self) -> usize {
            self.calls.load(Ordering::Relaxed)
        }
    }

    impl CandleBackendChecker for CountingBackendChecker {
        fn ready_backend(&self) -> Result<CandleBackend, String> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            #[cfg(target_os = "macos")]
            return Ok(CandleBackend::Metal);
            #[cfg(not(target_os = "macos"))]
            return Ok(CandleBackend::Cpu);
        }
    }

    #[cfg(target_os = "macos")]
    struct FakePlatformSpeechEngine {
        availability: PlatformSpeechAvailability,
        prepare_availability: PlatformSpeechAvailability,
        transcript: Mutex<Result<String, String>>,
        prepare_delay: Duration,
        prepare_calls: AtomicUsize,
        calls: AtomicUsize,
    }

    #[cfg(target_os = "macos")]
    impl FakePlatformSpeechEngine {
        fn ready(engine_label: &str) -> Self {
            let availability = PlatformSpeechAvailability::ready(engine_label);
            Self {
                availability: availability.clone(),
                prepare_availability: availability,
                transcript: Mutex::new(Ok("platform transcript".to_string())),
                prepare_delay: Duration::ZERO,
                prepare_calls: AtomicUsize::new(0),
                calls: AtomicUsize::new(0),
            }
        }

        fn needs_speech_permission() -> Self {
            let availability = PlatformSpeechAvailability::needs_speech_permission(
                "Needs Speech Recognition permission",
            );
            Self {
                availability: availability.clone(),
                prepare_availability: availability,
                transcript: Mutex::new(Ok("ignored".to_string())),
                prepare_delay: Duration::ZERO,
                prepare_calls: AtomicUsize::new(0),
                calls: AtomicUsize::new(0),
            }
        }

        fn needs_speech_permission_then_ready() -> Self {
            Self {
                availability: PlatformSpeechAvailability::needs_speech_permission(
                    "Needs Speech Recognition permission",
                ),
                prepare_availability: PlatformSpeechAvailability::ready("Apple Speech"),
                transcript: Mutex::new(Ok("ignored".to_string())),
                prepare_delay: Duration::ZERO,
                prepare_calls: AtomicUsize::new(0),
                calls: AtomicUsize::new(0),
            }
        }

        fn with_prepare_delay(mut self, delay: Duration) -> Self {
            self.prepare_delay = delay;
            self
        }
    }

    #[cfg(target_os = "macos")]
    impl PlatformSpeechEngine for FakePlatformSpeechEngine {
        fn availability(&self) -> PlatformSpeechAvailability {
            self.availability.clone()
        }

        fn prepare(&self) -> PlatformSpeechAvailability {
            self.prepare_calls.fetch_add(1, Ordering::Relaxed);
            std::thread::sleep(self.prepare_delay);
            self.prepare_availability.clone()
        }

        fn transcribe(&self, _audio: CapturedAudio) -> Result<String, String> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            self.transcript.lock().clone()
        }
    }

    #[test]
    fn distil_cache_path_uses_provider_specific_directory() {
        let root = PathBuf::from("/tmp/claudette-test-models");
        let registry = VoiceProviderRegistry::new(root.clone());

        assert_eq!(
            registry.distil_cache_path(),
            root.join("distil-whisper-large-v3")
        );
    }

    #[test]
    fn selected_provider_is_persisted_and_reflected_in_status() {
        let (_dir, db_path) = test_db_path();
        let db = open_test_db(&db_path);
        let registry = VoiceProviderRegistry::new(PathBuf::from("/tmp/models"));

        registry
            .set_selected_provider(&db, Some(DISTIL_ID))
            .expect("set selected provider");

        let providers = registry.list_providers(&db);
        assert!(
            providers
                .iter()
                .any(|provider| provider.metadata.id == DISTIL_ID && provider.selected)
        );
        assert!(
            providers
                .iter()
                .any(|provider| provider.metadata.id == PLATFORM_ID && !provider.selected)
        );
    }

    #[test]
    fn disabled_provider_reports_unavailable() {
        let (_dir, db_path) = test_db_path();
        let db = open_test_db(&db_path);
        let registry = VoiceProviderRegistry::new(PathBuf::from("/tmp/models"));

        registry
            .set_enabled(&db, PLATFORM_ID, false)
            .expect("disable platform provider");

        let provider = registry
            .list_providers(&db)
            .into_iter()
            .find(|provider| provider.metadata.id == PLATFORM_ID)
            .expect("platform provider");
        assert_eq!(provider.status, VoiceProviderStatus::Unavailable);
        assert!(!provider.enabled);
        assert!(!provider.setup_required);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn platform_provider_ready_when_native_engine_ready() {
        let (_dir, db_path) = test_db_path();
        let db = open_test_db(&db_path);
        let registry = VoiceProviderRegistry::with_platform_runtime(
            PathBuf::from("/tmp/models"),
            Arc::new(FakeRecorder::new(vec![0.1])),
            Arc::new(FakeTranscriber::ok("ignored")),
            Arc::new(FakePlatformSpeechEngine::ready("Apple SpeechAnalyzer")),
        );

        let provider = registry
            .list_providers(&db)
            .into_iter()
            .find(|provider| provider.metadata.id == PLATFORM_ID)
            .expect("platform provider");

        assert_eq!(provider.status, VoiceProviderStatus::Ready);
        assert!(provider.enabled);
        assert!(!provider.setup_required);
        assert_eq!(provider.metadata.recording_mode, VoiceRecordingMode::Native);
        assert!(provider.status_label.contains("Apple SpeechAnalyzer"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn platform_provider_reports_setup_required_for_speech_permission() {
        let (_dir, db_path) = test_db_path();
        let db = open_test_db(&db_path);
        let registry = VoiceProviderRegistry::with_platform_runtime(
            PathBuf::from("/tmp/models"),
            Arc::new(FakeRecorder::new(vec![0.1])),
            Arc::new(FakeTranscriber::ok("ignored")),
            Arc::new(FakePlatformSpeechEngine::needs_speech_permission()),
        );

        registry
            .set_selected_provider(&db, Some(PLATFORM_ID))
            .expect("select platform provider");

        let provider = registry
            .list_providers(&db)
            .into_iter()
            .find(|provider| provider.metadata.id == PLATFORM_ID)
            .expect("platform provider");

        assert_eq!(provider.status, VoiceProviderStatus::NeedsSetup);
        assert!(provider.enabled);
        assert!(provider.selected);
        assert!(provider.setup_required);
        assert!(
            provider
                .error
                .as_deref()
                .is_some_and(|error| error.contains("Speech Recognition"))
        );
    }

    #[test]
    fn missing_distil_model_requires_setup() {
        let (_db_dir, db_path) = test_db_path();
        let model_dir = tempdir().expect("model dir");
        let db = open_test_db(&db_path);
        let registry = VoiceProviderRegistry::new(model_dir.path().to_path_buf());

        let provider = registry
            .list_providers(&db)
            .into_iter()
            .find(|provider| provider.metadata.id == DISTIL_ID)
            .expect("distil provider");

        assert_eq!(provider.status, VoiceProviderStatus::NeedsSetup);
        assert!(provider.setup_required);
        assert!(!provider.can_remove_model);
    }

    #[test]
    fn complete_distil_model_reports_ready() {
        let (_db_dir, db_path) = test_db_path();
        let model_dir = tempdir().expect("model dir");
        let cache_path = model_dir.path().join(DISTIL_CACHE_DIR);
        write_complete_distil_model(&cache_path);

        let db = open_test_db(&db_path);
        let registry = VoiceProviderRegistry::new(model_dir.path().to_path_buf());
        let provider = registry
            .list_providers(&db)
            .into_iter()
            .find(|provider| provider.metadata.id == DISTIL_ID)
            .expect("distil provider");

        assert_eq!(provider.status, VoiceProviderStatus::Ready);
        assert!(!provider.setup_required);
        assert!(provider.can_remove_model);
        assert_eq!(provider.error, None);
    }

    #[test]
    fn incomplete_distil_manifest_requires_setup() {
        let (_db_dir, db_path) = test_db_path();
        let model_dir = tempdir().expect("model dir");
        let cache_path = model_dir.path().join(DISTIL_CACHE_DIR);
        std::fs::create_dir_all(&cache_path).expect("create model cache");
        std::fs::write(cache_path.join("tokenizer.json"), "{}").expect("write tokenizer");
        std::fs::write(cache_path.join("config.json"), "{}").expect("write config");
        let model_file =
            std::fs::File::create(cache_path.join("model.safetensors")).expect("create model");
        model_file.set_len(100_000_001).expect("size model");

        let db = open_test_db(&db_path);
        let registry = VoiceProviderRegistry::new(model_dir.path().to_path_buf());
        let provider = registry
            .list_providers(&db)
            .into_iter()
            .find(|provider| provider.metadata.id == DISTIL_ID)
            .expect("distil provider");

        assert_eq!(provider.status, VoiceProviderStatus::NeedsSetup);
        assert!(provider.setup_required);
        assert!(!provider.can_remove_model);
    }

    #[test]
    fn sample_conversion_handles_formats_and_channels() {
        assert_eq!(normalize_interleaved_f32(&[], 1), Vec::<f32>::new());
        assert_eq!(
            normalize_interleaved_f32(&[0.5, -0.25], 1),
            vec![0.5, -0.25]
        );
        assert_eq!(
            normalize_interleaved_i16(&[i16::MAX, i16::MIN], 2),
            vec![(-1.0 + 0.9999695) / 2.0]
        );
        assert_eq!(
            normalize_interleaved_u16(&[u16::MIN, u16::MAX], 2),
            vec![(-1.0 + 0.9999695) / 2.0]
        );
        assert_eq!(
            normalize_interleaved_i32(&[i32::MAX, i32::MIN], 2),
            vec![(1.0 + -1.0) / 2.0]
        );
        assert_eq!(
            normalize_interleaved_u8(&[u8::MIN, u8::MAX], 2),
            vec![(-1.0 + 0.9921875) / 2.0]
        );
        assert_eq!(normalize_interleaved_f64(&[1.5, -1.5], 2), vec![0.0]);
    }

    #[test]
    fn decoder_prompt_includes_language_token_when_available() {
        assert_eq!(decoder_prompt_tokens(1, Some(2), 3, 4), vec![1, 2, 3, 4]);
        assert_eq!(decoder_prompt_tokens(1, None, 3, 4), vec![1, 3, 4]);
    }

    #[test]
    fn resample_to_target_rate_keeps_target_rate_unchanged() {
        let samples = vec![0.0, 0.5, 1.0];
        assert_eq!(
            resample_to_target_rate(&samples, TARGET_SAMPLE_RATE),
            samples
        );
    }

    #[tokio::test]
    async fn start_distil_recording_rejects_disabled_provider() {
        let (_db_dir, db_path) = test_db_path();
        let model_dir = tempdir().expect("model dir");
        write_complete_distil_model(&model_dir.path().join(DISTIL_CACHE_DIR));
        let db = open_test_db(&db_path);
        db.set_app_setting(&enabled_key(DISTIL_ID), "false")
            .expect("disable provider");
        drop(db);

        let registry = VoiceProviderRegistry::with_runtime(
            model_dir.path().to_path_buf(),
            Arc::new(FakeRecorder::new(vec![0.1])),
            Arc::new(FakeTranscriber::ok("ignored")),
        );

        let err = registry
            .start_recording(&db_path, DISTIL_ID, None)
            .await
            .expect_err("disabled provider should not record");
        assert!(err.contains("disabled"));
    }

    #[tokio::test]
    async fn start_distil_recording_rejects_missing_model() {
        let (_db_dir, db_path) = test_db_path();
        let model_dir = tempdir().expect("model dir");
        let registry = VoiceProviderRegistry::with_runtime(
            model_dir.path().to_path_buf(),
            Arc::new(FakeRecorder::new(vec![0.1])),
            Arc::new(FakeTranscriber::ok("ignored")),
        );

        let err = registry
            .start_recording(&db_path, DISTIL_ID, None)
            .await
            .expect_err("missing model should not record");
        assert!(err.contains("Download"));
    }

    #[tokio::test]
    async fn start_distil_recording_rejects_already_active_recording() {
        let (_db_dir, db_path) = test_db_path();
        let model_dir = tempdir().expect("model dir");
        write_complete_distil_model(&model_dir.path().join(DISTIL_CACHE_DIR));
        let recorder = Arc::new(FakeRecorder::new(vec![0.1]));
        let registry = VoiceProviderRegistry::with_runtime(
            model_dir.path().to_path_buf(),
            recorder.clone(),
            Arc::new(FakeTranscriber::ok("ignored")),
        );

        registry
            .start_recording(&db_path, DISTIL_ID, None)
            .await
            .expect("first recording starts");
        let err = registry
            .start_recording(&db_path, DISTIL_ID, None)
            .await
            .expect_err("second recording should fail");

        assert!(err.contains("already active"));
        assert_eq!(recorder.starts.load(Ordering::Relaxed), 1);
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn start_platform_recording_prepares_permission_on_user_action() {
        let (_db_dir, db_path) = test_db_path();
        let platform_engine =
            Arc::new(FakePlatformSpeechEngine::needs_speech_permission_then_ready());
        let recorder = Arc::new(FakeRecorder::new(vec![0.1, 0.2, 0.3]));
        let registry = VoiceProviderRegistry::with_platform_runtime(
            PathBuf::from("/tmp/models"),
            recorder.clone(),
            Arc::new(FakeTranscriber::ok("ignored")),
            platform_engine.clone(),
        );

        let db = open_test_db(&db_path);
        let provider = registry
            .list_providers(&db)
            .into_iter()
            .find(|provider| provider.metadata.id == PLATFORM_ID)
            .expect("platform provider");
        assert_eq!(provider.status, VoiceProviderStatus::NeedsSetup);
        assert_eq!(platform_engine.prepare_calls.load(Ordering::Relaxed), 0);
        drop(db);

        registry
            .start_recording(&db_path, PLATFORM_ID, None)
            .await
            .expect("platform recording starts after prepare");

        assert_eq!(platform_engine.prepare_calls.load(Ordering::Relaxed), 1);
        assert_eq!(recorder.starts.load(Ordering::Relaxed), 1);
    }

    #[cfg(target_os = "macos")]
    #[tokio::test(flavor = "current_thread")]
    async fn start_platform_recording_prepares_permission_off_runtime_thread() {
        let (_db_dir, db_path) = test_db_path();
        let platform_engine = Arc::new(
            FakePlatformSpeechEngine::needs_speech_permission_then_ready()
                .with_prepare_delay(Duration::from_millis(200)),
        );
        let registry = Arc::new(VoiceProviderRegistry::with_platform_runtime(
            PathBuf::from("/tmp/models"),
            Arc::new(FakeRecorder::new(vec![0.1, 0.2, 0.3])),
            Arc::new(FakeTranscriber::ok("ignored")),
            platform_engine,
        ));

        let start = std::time::Instant::now();
        let start_registry = Arc::clone(&registry);
        let handle = tokio::spawn(async move {
            start_registry
                .start_recording(&db_path, PLATFORM_ID, None)
                .await
        });

        tokio::time::sleep(Duration::from_millis(25)).await;

        assert!(
            start.elapsed() < Duration::from_millis(150),
            "permission prepare must not block the async runtime thread"
        );
        handle
            .await
            .expect("recording task joined")
            .expect("platform recording starts after prepare");
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn start_then_stop_platform_recording_returns_transcript() {
        let (_db_dir, db_path) = test_db_path();
        let platform_engine = Arc::new(FakePlatformSpeechEngine::ready("Apple Speech"));
        *platform_engine.transcript.lock() = Ok("spoken platform words".to_string());
        let registry = VoiceProviderRegistry::with_platform_runtime(
            PathBuf::from("/tmp/models"),
            Arc::new(FakeRecorder::new(vec![0.1, 0.2, 0.3])),
            Arc::new(FakeTranscriber::ok("ignored")),
            platform_engine.clone(),
        );

        registry
            .start_recording(&db_path, PLATFORM_ID, None)
            .await
            .expect("platform recording starts");
        let transcript = registry
            .stop_and_transcribe(PLATFORM_ID)
            .await
            .expect("platform transcribes");

        assert_eq!(transcript, "spoken platform words");
        assert_eq!(platform_engine.calls.load(Ordering::Relaxed), 1);
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn cancel_drops_active_platform_recording() {
        let (_db_dir, db_path) = test_db_path();
        let platform_engine = Arc::new(FakePlatformSpeechEngine::ready("Apple Speech"));
        let registry = VoiceProviderRegistry::with_platform_runtime(
            PathBuf::from("/tmp/models"),
            Arc::new(FakeRecorder::new(vec![0.1, 0.2, 0.3])),
            Arc::new(FakeTranscriber::ok("ignored")),
            platform_engine.clone(),
        );

        registry
            .start_recording(&db_path, PLATFORM_ID, None)
            .await
            .expect("platform recording starts");
        registry
            .cancel_recording(PLATFORM_ID)
            .await
            .expect("cancel platform recording");

        let err = registry
            .stop_and_transcribe(PLATFORM_ID)
            .await
            .expect_err("cancelled platform recording should be gone");
        assert!(err.contains("No voice recording is active"));
        assert_eq!(platform_engine.calls.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn stop_without_recording_returns_clear_error() {
        let registry = VoiceProviderRegistry::with_runtime(
            PathBuf::from("/tmp/models"),
            Arc::new(FakeRecorder::new(vec![0.1])),
            Arc::new(FakeTranscriber::ok("ignored")),
        );

        let err = registry
            .stop_and_transcribe(DISTIL_ID)
            .await
            .expect_err("stop without recording should fail");
        assert!(err.contains("No voice recording is active"));
    }

    #[tokio::test]
    async fn cancel_drops_active_recording() {
        let (_db_dir, db_path) = test_db_path();
        let model_dir = tempdir().expect("model dir");
        write_complete_distil_model(&model_dir.path().join(DISTIL_CACHE_DIR));
        let transcriber = Arc::new(FakeTranscriber::ok("ignored"));
        let registry = VoiceProviderRegistry::with_runtime(
            model_dir.path().to_path_buf(),
            Arc::new(FakeRecorder::new(vec![0.1])),
            transcriber.clone(),
        );

        registry
            .start_recording(&db_path, DISTIL_ID, None)
            .await
            .expect("recording starts");
        registry
            .cancel_recording(DISTIL_ID)
            .await
            .expect("cancel recording");

        let err = registry
            .stop_and_transcribe(DISTIL_ID)
            .await
            .expect_err("cancelled recording should be gone");
        assert!(err.contains("No voice recording is active"));
        assert_eq!(transcriber.calls.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn cancel_during_distil_transcription_returns_early() {
        let (_db_dir, db_path) = test_db_path();
        let model_dir = tempdir().expect("model dir");
        write_complete_distil_model(&model_dir.path().join(DISTIL_CACHE_DIR));
        let transcriber = Arc::new(FakeTranscriber::slow(
            "would have transcribed",
            Duration::from_secs(5),
        ));
        let registry = Arc::new(VoiceProviderRegistry::with_runtime(
            model_dir.path().to_path_buf(),
            Arc::new(FakeRecorder::new(vec![0.1, 0.2, 0.3])),
            transcriber.clone(),
        ));

        registry
            .start_recording(&db_path, DISTIL_ID, None)
            .await
            .expect("recording starts");

        let stop_registry = Arc::clone(&registry);
        let stop_handle =
            tokio::spawn(async move { stop_registry.stop_and_transcribe(DISTIL_ID).await });

        // Give the spawn_blocking worker a moment to enter its sleep loop.
        tokio::time::sleep(Duration::from_millis(50)).await;

        let cancel_started = std::time::Instant::now();
        registry
            .cancel_recording(DISTIL_ID)
            .await
            .expect("cancel succeeds");

        let result = stop_handle.await.expect("stop task joined");
        let elapsed = cancel_started.elapsed();

        let err = result.expect_err("transcription should be cancelled");
        assert!(
            err.contains("cancelled"),
            "expected cancellation error, got: {err}"
        );
        assert!(
            elapsed < Duration::from_secs(2),
            "expected fast return after cancel, took {elapsed:?}"
        );
    }

    #[tokio::test]
    async fn start_then_stop_returns_fake_transcript() {
        let (_db_dir, db_path) = test_db_path();
        let model_dir = tempdir().expect("model dir");
        write_complete_distil_model(&model_dir.path().join(DISTIL_CACHE_DIR));
        let transcriber = Arc::new(FakeTranscriber::ok("hello from test"));
        let registry = VoiceProviderRegistry::with_runtime(
            model_dir.path().to_path_buf(),
            Arc::new(FakeRecorder::new(vec![0.1, 0.2, 0.3])),
            transcriber.clone(),
        );

        registry
            .start_recording(&db_path, DISTIL_ID, None)
            .await
            .expect("recording starts");
        let transcript = registry
            .stop_and_transcribe(DISTIL_ID)
            .await
            .expect("transcribes");

        assert_eq!(transcript, "hello from test");
        assert_eq!(transcriber.calls.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn recorder_stream_error_returns_clear_error_before_transcription() {
        let (_db_dir, db_path) = test_db_path();
        let model_dir = tempdir().expect("model dir");
        write_complete_distil_model(&model_dir.path().join(DISTIL_CACHE_DIR));
        let transcriber = Arc::new(FakeTranscriber::ok("ignored"));
        let registry = VoiceProviderRegistry::with_runtime(
            model_dir.path().to_path_buf(),
            Arc::new(FakeRecorder::new_with_stream_error(
                vec![0.1, 0.2, 0.3],
                "device disconnected",
            )),
            transcriber.clone(),
        );

        registry
            .start_recording(&db_path, DISTIL_ID, None)
            .await
            .expect("recording starts");
        let err = registry
            .stop_and_transcribe(DISTIL_ID)
            .await
            .expect_err("stream error should fail");

        assert!(err.contains("device disconnected"));
        assert_eq!(transcriber.calls.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn silent_recording_rejects_before_transcription() {
        let (_db_dir, db_path) = test_db_path();
        let model_dir = tempdir().expect("model dir");
        write_complete_distil_model(&model_dir.path().join(DISTIL_CACHE_DIR));
        let transcriber = Arc::new(FakeTranscriber::ok("ignored"));
        let registry = VoiceProviderRegistry::with_runtime(
            model_dir.path().to_path_buf(),
            Arc::new(FakeRecorder::new(vec![0.0; TARGET_SAMPLE_RATE as usize])),
            transcriber.clone(),
        );

        registry
            .start_recording(&db_path, DISTIL_ID, None)
            .await
            .expect("recording starts");
        let err = registry
            .stop_and_transcribe(DISTIL_ID)
            .await
            .expect_err("silent recording should fail");

        assert!(err.contains("No speech"));
        assert_eq!(transcriber.calls.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn empty_transcript_returns_clear_error() {
        let (_db_dir, db_path) = test_db_path();
        let model_dir = tempdir().expect("model dir");
        write_complete_distil_model(&model_dir.path().join(DISTIL_CACHE_DIR));
        let registry = VoiceProviderRegistry::with_runtime(
            model_dir.path().to_path_buf(),
            Arc::new(FakeRecorder::new(vec![0.1, 0.2, 0.3])),
            Arc::new(FakeTranscriber::ok("   ")),
        );

        registry
            .start_recording(&db_path, DISTIL_ID, None)
            .await
            .expect("recording starts");
        let err = registry
            .stop_and_transcribe(DISTIL_ID)
            .await
            .expect_err("empty transcript should fail");

        assert!(err.contains("No speech"));
    }

    #[tokio::test]
    async fn transcription_timeout_returns_clear_error() {
        let (_db_dir, db_path) = test_db_path();
        let model_dir = tempdir().expect("model dir");
        write_complete_distil_model(&model_dir.path().join(DISTIL_CACHE_DIR));
        let registry = VoiceProviderRegistry::with_runtime_and_timeout(
            model_dir.path().to_path_buf(),
            Arc::new(FakeRecorder::new(vec![0.1, 0.2, 0.3])),
            Arc::new(FakeTranscriber::slow(
                "late transcript",
                std::time::Duration::from_millis(50),
            )),
            std::time::Duration::from_millis(5),
        );

        registry
            .start_recording(&db_path, DISTIL_ID, None)
            .await
            .expect("recording starts");
        let err = registry
            .stop_and_transcribe(DISTIL_ID)
            .await
            .expect_err("slow transcription should time out");

        assert!(err.contains("timed out"));
    }

    #[tokio::test]
    async fn transcription_error_does_not_poison_later_recordings() {
        let (_db_dir, db_path) = test_db_path();
        let model_dir = tempdir().expect("model dir");
        write_complete_distil_model(&model_dir.path().join(DISTIL_CACHE_DIR));
        let transcriber = Arc::new(FakeTranscriber::err("boom"));
        let registry = VoiceProviderRegistry::with_runtime(
            model_dir.path().to_path_buf(),
            Arc::new(FakeRecorder::new(vec![0.1])),
            transcriber.clone(),
        );

        registry
            .start_recording(&db_path, DISTIL_ID, None)
            .await
            .expect("recording starts");
        let err = registry
            .stop_and_transcribe(DISTIL_ID)
            .await
            .expect_err("fake transcriber fails");
        assert_eq!(err, "boom");

        *transcriber.result.lock() = Ok("recovered".to_string());
        registry
            .start_recording(&db_path, DISTIL_ID, None)
            .await
            .expect("recording can start again");
        let transcript = registry
            .stop_and_transcribe(DISTIL_ID)
            .await
            .expect("later transcription succeeds");
        assert_eq!(transcript, "recovered");
    }

    #[tokio::test]
    async fn remove_distil_model_clears_cache_and_status() {
        let (_db_dir, db_path) = test_db_path();
        let model_dir = tempdir().expect("model dir");
        let cache_path = model_dir.path().join(DISTIL_CACHE_DIR);
        write_complete_distil_model(&cache_path);
        let db = open_test_db(&db_path);
        db.set_app_setting(&model_status_key(DISTIL_ID), "installed")
            .expect("set model status");
        drop(db);

        let registry = VoiceProviderRegistry::new(model_dir.path().to_path_buf());
        let provider = registry
            .remove_provider_model(&db_path, DISTIL_ID)
            .await
            .expect("remove model");

        assert!(!cache_path.exists());
        assert_eq!(provider.status, VoiceProviderStatus::NeedsSetup);
        let db = open_test_db(&db_path);
        assert_eq!(
            db.get_app_setting(&model_status_key(DISTIL_ID))
                .expect("get model status"),
            Some("not-installed".to_string())
        );
    }
}
