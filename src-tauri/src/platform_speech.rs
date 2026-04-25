#[cfg(target_os = "macos")]
use std::path::Path;

use crate::voice::CapturedAudio;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PlatformSpeechAvailabilityStatus {
    Ready,
    NeedsMicrophonePermission,
    NeedsSpeechPermission,
    NeedsAssets,
    EngineUnavailable,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PlatformSpeechAvailability {
    pub status: PlatformSpeechAvailabilityStatus,
    pub engine_label: Option<String>,
    pub message: String,
}

impl PlatformSpeechAvailability {
    #[cfg(test)]
    pub(crate) fn ready(engine_label: &str) -> Self {
        Self {
            status: PlatformSpeechAvailabilityStatus::Ready,
            engine_label: Some(engine_label.to_string()),
            message: format!("Ready via {engine_label}"),
        }
    }

    #[cfg(test)]
    pub(crate) fn needs_speech_permission(message: &str) -> Self {
        Self {
            status: PlatformSpeechAvailabilityStatus::NeedsSpeechPermission,
            engine_label: None,
            message: message.to_string(),
        }
    }

    #[cfg(not(target_os = "macos"))]
    fn unavailable(message: impl Into<String>) -> Self {
        Self {
            status: PlatformSpeechAvailabilityStatus::Unavailable,
            engine_label: None,
            message: message.into(),
        }
    }
}

pub(crate) trait PlatformSpeechEngine: Send + Sync {
    fn availability(&self) -> PlatformSpeechAvailability;
    fn prepare(&self) -> PlatformSpeechAvailability;
    fn transcribe(&self, audio: CapturedAudio) -> Result<String, String>;
}

#[derive(Debug, Default)]
pub(crate) struct DefaultPlatformSpeechEngine;

impl DefaultPlatformSpeechEngine {
    pub(crate) fn new() -> Self {
        Self
    }
}

#[cfg(target_os = "macos")]
impl PlatformSpeechEngine for DefaultPlatformSpeechEngine {
    fn availability(&self) -> PlatformSpeechAvailability {
        native_status(false)
    }

    fn prepare(&self) -> PlatformSpeechAvailability {
        native_status(true)
    }

    fn transcribe(&self, audio: CapturedAudio) -> Result<String, String> {
        let wav_path = temp_wav_path();
        write_wav(&wav_path, &audio)?;
        let result = transcribe_wav_path(&wav_path);
        let _ = std::fs::remove_file(&wav_path);
        result
    }
}

#[cfg(not(target_os = "macos"))]
impl PlatformSpeechEngine for DefaultPlatformSpeechEngine {
    fn availability(&self) -> PlatformSpeechAvailability {
        PlatformSpeechAvailability::unavailable(
            "Native platform dictation is only implemented on macOS.",
        )
    }

    fn prepare(&self) -> PlatformSpeechAvailability {
        self.availability()
    }

    fn transcribe(&self, _audio: CapturedAudio) -> Result<String, String> {
        Err("Native platform dictation is only implemented on macOS.".to_string())
    }
}

#[cfg(target_os = "macos")]
fn temp_wav_path() -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "claudette-platform-speech-{}-{}.wav",
        std::process::id(),
        uuid::Uuid::new_v4()
    ))
}

#[cfg(target_os = "macos")]
fn write_wav(path: &Path, audio: &CapturedAudio) -> Result<(), String> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: audio.sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(path, spec)
        .map_err(|e| format!("Failed to create platform speech audio file: {e}"))?;
    for sample in &audio.samples {
        let sample = sample.clamp(-1.0, 1.0);
        let pcm = (sample * i16::MAX as f32).round() as i16;
        writer
            .write_sample(pcm)
            .map_err(|e| format!("Failed to write platform speech audio: {e}"))?;
    }
    writer
        .finalize()
        .map_err(|e| format!("Failed to finalize platform speech audio: {e}"))
}

#[cfg(target_os = "macos")]
fn native_status(prepare: bool) -> PlatformSpeechAvailability {
    let mut code = 4_i32;
    let mut engine = 0_i32;
    let mut message = std::ptr::null_mut();
    if prepare {
        unsafe { claudette_platform_speech_prepare(&mut code, &mut engine, &mut message) };
    } else {
        unsafe { claudette_platform_speech_status(&mut code, &mut engine, &mut message) };
    }
    let message = unsafe { take_c_string(message) }
        .unwrap_or_else(|| "Apple speech status unavailable".to_string());
    availability_from_native(code, engine, message)
}

#[cfg(target_os = "macos")]
fn transcribe_wav_path(path: &Path) -> Result<String, String> {
    use std::ffi::CString;

    let path = CString::new(path.display().to_string())
        .map_err(|_| "Platform speech audio path contains an interior nul byte".to_string())?;
    let mut code = 4_i32;
    let mut engine = 0_i32;
    let mut text_ptr = std::ptr::null_mut();
    let mut message_ptr = std::ptr::null_mut();
    unsafe {
        claudette_platform_speech_transcribe_file(
            path.as_ptr(),
            &mut code,
            &mut engine,
            &mut text_ptr,
            &mut message_ptr,
        )
    };
    let text = unsafe { take_c_string(text_ptr) }.unwrap_or_default();
    let message =
        unsafe { take_c_string(message_ptr) }.unwrap_or_else(|| engine_label(engine).to_string());

    if code == 0 { Ok(text) } else { Err(message) }
}

#[cfg(target_os = "macos")]
fn availability_from_native(code: i32, engine: i32, message: String) -> PlatformSpeechAvailability {
    let status = match code {
        0 => PlatformSpeechAvailabilityStatus::Ready,
        1 => PlatformSpeechAvailabilityStatus::NeedsMicrophonePermission,
        2 => PlatformSpeechAvailabilityStatus::NeedsSpeechPermission,
        5 => PlatformSpeechAvailabilityStatus::NeedsAssets,
        3 => PlatformSpeechAvailabilityStatus::EngineUnavailable,
        _ => PlatformSpeechAvailabilityStatus::Unavailable,
    };
    PlatformSpeechAvailability {
        status,
        engine_label: match engine {
            1 | 2 => Some(engine_label(engine).to_string()),
            _ => None,
        },
        message,
    }
}

#[cfg(target_os = "macos")]
fn engine_label(engine: i32) -> &'static str {
    match engine {
        1 => "Apple SpeechAnalyzer",
        2 => "Apple Speech",
        _ => "Apple Speech",
    }
}

#[cfg(target_os = "macos")]
unsafe fn take_c_string(pointer: *mut std::ffi::c_char) -> Option<String> {
    if pointer.is_null() {
        return None;
    }
    let value = unsafe { std::ffi::CStr::from_ptr(pointer) }
        .to_string_lossy()
        .into_owned();
    unsafe { claudette_platform_speech_free_string(pointer) };
    Some(value)
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn claudette_platform_speech_status(
        code: *mut i32,
        engine: *mut i32,
        message: *mut *mut std::ffi::c_char,
    );
    fn claudette_platform_speech_prepare(
        code: *mut i32,
        engine: *mut i32,
        message: *mut *mut std::ffi::c_char,
    );
    fn claudette_platform_speech_transcribe_file(
        path: *const std::ffi::c_char,
        code: *mut i32,
        engine: *mut i32,
        text: *mut *mut std::ffi::c_char,
        message: *mut *mut std::ffi::c_char,
    );
    fn claudette_platform_speech_free_string(pointer: *mut std::ffi::c_char);
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn platform_speech_bridge_reports_status_without_prompt() {
        let availability = DefaultPlatformSpeechEngine::new().availability();

        assert!(!availability.message.trim().is_empty());
    }

    #[test]
    fn platform_speech_bridge_refuses_unbundled_permission_prompts() {
        let availability = DefaultPlatformSpeechEngine::new().prepare();

        assert_eq!(
            availability.status,
            PlatformSpeechAvailabilityStatus::EngineUnavailable
        );
        assert!(availability.message.contains(".app bundle"));
    }

    #[test]
    #[ignore = "requires CLAUDETTE_PLATFORM_SPEECH_SAMPLE_WAV and macOS speech permissions"]
    fn ignored_platform_speech_transcribes_fixture_wav() {
        let sample_path = std::env::var_os("CLAUDETTE_PLATFORM_SPEECH_SAMPLE_WAV")
            .map(std::path::PathBuf::from)
            .expect("set CLAUDETTE_PLATFORM_SPEECH_SAMPLE_WAV to a short speech WAV");

        let transcript = transcribe_wav_path(&sample_path).expect("transcribe fixture");

        assert!(!transcript.trim().is_empty());
    }
}
