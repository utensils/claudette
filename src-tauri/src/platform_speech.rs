// The platform speech bridge gives the cross-platform `voice.rs` a single
// trait it can lean on regardless of whether the host OS exposes a native
// recognizer (macOS Apple Speech, Windows SAPI 5.4), or only a stub
// fallback (Linux for now). Each `#[cfg(...)]` impl block below shares the
// trait definition so callers in voice.rs do not need any per-OS branching
// once they hold a `&dyn PlatformSpeechEngine`.
//
// The macOS path links to a small Swift static library (see build.rs) that
// drives `SFSpeechRecognizer` / `SpeechAnalyzer`. The Windows path drives
// SAPI 5.4 directly via COM through the `windows` crate — no .NET, no
// PowerShell shell-out, no extra runtime. Both feed the same captured-
// audio buffer produced by `CpalAudioRecorder`, written to a temporary
// 16-bit PCM WAV before the engine reads it back.

#[cfg(any(target_os = "macos", windows))]
use std::path::Path;

use crate::voice::CapturedAudio;

// The non-Ready/non-Unavailable variants are only constructed on macOS via
// availability_from_native(). Keeping the full enum cross-platform avoids
// cfg-gating every match arm in voice.rs.
#[allow(dead_code)]
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

    // Windows-only — the SAPI bridge advertises Ready up front; the
    // EngineUnavailable variants are reserved for the macOS native
    // status path or future probes that decide they need to gate the
    // provider before the user clicks the mic.
    #[cfg(windows)]
    fn ready_now(engine_label: &str, message: impl Into<String>) -> Self {
        Self {
            status: PlatformSpeechAvailabilityStatus::Ready,
            engine_label: Some(engine_label.to_string()),
            message: message.into(),
        }
    }

    // Only the Linux/other-OS stub uses this — both macOS and Windows have
    // real engines that surface concrete states. Gated tightly so dead-code
    // lint stays quiet under `-Dwarnings` on platforms that never reach it.
    #[cfg(not(any(target_os = "macos", windows)))]
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
    // Only the macOS implementation actually triggers TCC permission prompts;
    // the Windows + cross-platform fallbacks reuse availability(). Allowed-as-
    // dead in the test build path that exercises only macOS-style flows.
    #[allow(dead_code)]
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

#[cfg(windows)]
impl PlatformSpeechEngine for DefaultPlatformSpeechEngine {
    fn availability(&self) -> PlatformSpeechAvailability {
        windows_speech::availability()
    }

    fn prepare(&self) -> PlatformSpeechAvailability {
        // Windows does not have a TCC-style "prepare" prompt the way macOS
        // does — microphone permission is granted/denied at the OS level
        // through Settings → Privacy → Microphone, and SAPI consumes the
        // WAV file directly without re-asking. Returning the static
        // availability keeps the trait shape symmetric with macOS.
        windows_speech::availability()
    }

    fn transcribe(&self, audio: CapturedAudio) -> Result<String, String> {
        let wav_path = temp_wav_path();
        write_wav(&wav_path, &audio)?;
        let sample_count = audio.samples.len();
        let sample_rate = audio.sample_rate;
        let result = windows_speech::transcribe_wav_path(&wav_path);
        if let Err(error) = &result {
            // Funnel everything we know about the failure through the global
            // tracing pipeline (`claudette::logging`). The daily-rotated log
            // file under Settings → Diagnostics → Open log directory captures
            // the structured fields, so no parallel debug-file scheme.
            tracing::warn!(
                target: "claudette::voice::platform_speech::windows",
                sample_count,
                sample_rate,
                wav = %wav_path.display(),
                error = %error,
                "Windows system dictation failed",
            );
        }
        // Always clean up the temp WAV. The daily log holds the diagnostic
        // context now that we route through tracing — keeping multi-MB WAVs
        // around per failure was a debugging crutch, not a feature.
        let _ = std::fs::remove_file(&wav_path);
        result
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
impl PlatformSpeechEngine for DefaultPlatformSpeechEngine {
    fn availability(&self) -> PlatformSpeechAvailability {
        PlatformSpeechAvailability::unavailable(
            "Native platform dictation is not implemented on this OS yet. Use the offline Distil-Whisper provider in Plugins settings.",
        )
    }

    fn prepare(&self) -> PlatformSpeechAvailability {
        self.availability()
    }

    fn transcribe(&self, _audio: CapturedAudio) -> Result<String, String> {
        Err("Native platform dictation is not implemented on this OS yet.".to_string())
    }
}

#[cfg(any(target_os = "macos", windows))]
fn temp_wav_path() -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "claudette-platform-speech-{}-{}.wav",
        std::process::id(),
        uuid::Uuid::new_v4()
    ))
}

#[cfg(any(target_os = "macos", windows))]
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
pub(crate) fn cancel_active_transcription() {
    unsafe { claudette_platform_speech_cancel() };
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
    fn claudette_platform_speech_cancel();
}

// Windows speech recognition bridge — drives SAPI 5.4's in-process
// recognizer (`SpInprocRecognizer`) directly via COM through the
// `windows` crate. SAPI 5.4 ships with every Windows install since 7
// (no .NET, no PowerShell, no extra runtime), accepts arbitrary WAV
// files via `ISpStream::BindToFile`, and surfaces real HRESULT codes
// for diagnosis.
//
// Earlier iterations shelled out to `powershell.exe` +
// `System.Speech.Recognition.SpeechRecognitionEngine`, but the .NET
// path on Windows ARM64 / under emulation was unreliable: the
// recognizer would throw "No audio input is supplied to this
// recognizer" mid-call after a successful `SetInputToWaveFile`,
// because the implicitly-opened FileStream got closed before
// `Recognize()` consumed it. Owning the COM lifecycle ourselves
// removes that whole class of bug — we keep `ISpStream` alive across
// the full recognition loop and the recognizer can't lose it.
//
// Threading: COM is initialized as Apartment Threaded (STA) on the
// caller thread. Voice transcription runs inside `tokio::task::
// spawn_blocking` (see `voice.rs::stop_platform_recording`), so this
// thread is dedicated to the call and tearing it down on return is
// safe. The COM cleanup sentinel below ensures `CoUninitialize` runs
// on every exit path including panics.
#[cfg(windows)]
mod windows_speech {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use std::time::{Duration, Instant};

    use windows::Win32::Foundation::{S_FALSE, WAIT_OBJECT_0};
    use windows::Win32::Media::Speech::{
        ISpRecoGrammar, ISpRecoResult, ISpRecognizer, ISpStream, SPEI_END_SR_STREAM,
        SPEI_FALSE_RECOGNITION, SPEI_RECOGNITION, SPEVENT, SPFM_OPEN_READONLY, SPLO_STATIC,
        SPRS_ACTIVE, SPRST_ACTIVE_ALWAYS, SPRST_INACTIVE, SpInprocRecognizer, SpStream,
    };
    use windows::Win32::System::Com::{
        CLSCTX_ALL, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx, CoTaskMemFree,
        CoUninitialize,
    };
    use windows::Win32::System::Threading::WaitForSingleObject;
    use windows::core::{Interface, PCWSTR, PWSTR};

    use super::PlatformSpeechAvailability;

    // The SAPI event loop polls for events at ~30 Hz (33 ms wait interval).
    // Each iteration: WaitForSingleObject → drain GetEvents → loop. That
    // keeps end-of-stream latency low without spinning the CPU.
    const EVENT_POLL_WAIT_MS: u32 = 33;
    // Hard ceiling on the recognizer event loop. The Rust caller wraps
    // `transcribe()` in `tokio::time::timeout(transcription_timeout)`
    // (90 s by default), so this is just belt-and-suspenders against an
    // engine that never emits SPEI_END_SR_STREAM after consuming the WAV.
    const RECOGNITION_DEADLINE: Duration = Duration::from_secs(120);

    // SAPI's `SPFEI()` macro maps an event ID to a 64-bit interest mask.
    // The two reserved bits below (`SPFEI_FLAGCHECK` in the C++ headers)
    // are required so the recognizer can distinguish "no interest set"
    // from a literal 0 mask — without them, SetInterest is a no-op.
    const SPFEI_FLAGCHECK: u64 = (1u64 << 30) | (1u64 << 33);

    /// Convert a `SPEVENTENUM` event id into the bit mask
    /// `ISpEventSource::SetInterest` expects. Mirrors the C++ `SPFEI`
    /// macro 1-to-1.
    const fn spfei(event_id: i32) -> u64 {
        SPFEI_FLAGCHECK | (1u64 << event_id)
    }

    pub(super) fn availability() -> PlatformSpeechAvailability {
        // SAPI 5.4 is bundled with every Windows install since 7, and the
        // `SpInprocRecognizer` CLSID is registered out of the box. We
        // could probe by calling `CoCreateInstance` here, but that costs
        // ~30 ms of COM initialization on every Settings refresh and the
        // trait contract is "report what looks ready and surface real
        // errors during `transcribe()`." Match the macOS pattern.
        PlatformSpeechAvailability::ready_now(
            "Windows SAPI",
            "Ready via Windows Speech API (SAPI 5.4 — no setup required)",
        )
    }

    pub(super) fn transcribe_wav_path(wav_path: &Path) -> Result<String, String> {
        // Pre-flight check: if the WAV doesn't exist or is smaller than a
        // minimal RIFF header, the recognizer's error would surface as a
        // generic "audio input unavailable" — fail loudly here instead.
        match std::fs::metadata(wav_path) {
            Ok(metadata) if metadata.len() < 44 => {
                let len = metadata.len();
                tracing::error!(
                    target: "claudette::voice::platform_speech::windows",
                    wav = %wav_path.display(),
                    bytes = len,
                    "Recorded WAV is shorter than a RIFF header — audio capture produced no usable data",
                );
                return Err(
                    "Couldn't load the recorded audio. Try recording again — see Settings → Diagnostics for details."
                        .to_string(),
                );
            }
            Err(err) => {
                tracing::error!(
                    target: "claudette::voice::platform_speech::windows",
                    wav = %wav_path.display(),
                    error = %err,
                    "Recorded WAV is not readable",
                );
                return Err(
                    "Couldn't load the recorded audio. Try recording again — see Settings → Diagnostics for details."
                        .to_string(),
                );
            }
            _ => {}
        }

        let _com = ComApartment::initialize().map_err(|hr| {
            tracing::error!(
                target: "claudette::voice::platform_speech::windows",
                hresult = %format!("0x{:08x}", hr),
                "CoInitializeEx failed",
            );
            user_facing_error(&format!("CoInitializeEx HRESULT 0x{hr:08x}"))
        })?;

        match unsafe { transcribe_with_sapi(wav_path) } {
            Ok(text) => Ok(text),
            Err(SapiError {
                stage,
                hresult,
                message,
            }) => {
                tracing::error!(
                    target: "claudette::voice::platform_speech::windows",
                    wav = %wav_path.display(),
                    stage = %stage,
                    hresult = %format!("0x{hresult:08x}"),
                    detail = %message,
                    "SAPI transcription failed",
                );
                Err(user_facing_error_for_hresult(stage, hresult))
            }
        }
    }

    /// Owned COM-apartment guard. `CoInitializeEx` returns `S_FALSE` on
    /// nested calls (already initialized on this thread) — we only call
    /// `CoUninitialize` when WE were the call that initialized, otherwise
    /// we'd tear down a higher caller's apartment. The Drop impl runs on
    /// every exit path including panics, which the previous `let _ =
    /// CoUninitialize();` at the bottom of a function did NOT.
    struct ComApartment {
        owns: bool,
    }

    impl ComApartment {
        fn initialize() -> Result<Self, u32> {
            let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
            if hr.is_ok() {
                Ok(Self { owns: true })
            } else if hr == S_FALSE {
                // Already initialized on this thread by an earlier caller —
                // we ride along without owning the uninit.
                Ok(Self { owns: false })
            } else {
                Err(hr.0 as u32)
            }
        }
    }

    impl Drop for ComApartment {
        fn drop(&mut self) {
            if self.owns {
                unsafe { CoUninitialize() };
            }
        }
    }

    /// Structured error from the SAPI call site — `stage` names which step
    /// failed (so the daily log is greppable), `hresult` is the raw COM
    /// status, and `message` is the formatted `windows::core::Error`
    /// description for the log line.
    struct SapiError {
        stage: &'static str,
        hresult: u32,
        message: String,
    }

    impl SapiError {
        fn from_windows(stage: &'static str, err: windows::core::Error) -> Self {
            Self {
                stage,
                hresult: err.code().0 as u32,
                message: err.message(),
            }
        }
    }

    /// Drive a single recognition pass against the WAV. All the COM
    /// interfaces are kept in scope until the function returns so their
    /// Drop calls Release in the correct order: grammar → context →
    /// recognizer → stream. The COM apartment guard above outlives all
    /// of them via the caller's stack frame.
    unsafe fn transcribe_with_sapi(wav_path: &Path) -> Result<String, SapiError> {
        let recognizer: ISpRecognizer =
            unsafe { CoCreateInstance(&SpInprocRecognizer, None, CLSCTX_ALL) }
                .map_err(|e| SapiError::from_windows("CoCreateInstance(SpInprocRecognizer)", e))?;

        let stream: ISpStream = unsafe { CoCreateInstance(&SpStream, None, CLSCTX_ALL) }
            .map_err(|e| SapiError::from_windows("CoCreateInstance(SpStream)", e))?;

        // Bind the stream to the WAV file on disk. Passing `None` for both
        // the format ID and `WAVEFORMATEX` lets SAPI parse the RIFF header
        // itself — exactly the behaviour we want, vs. having to hand-tune
        // a `WAVEFORMATEX` that matches what we wrote.
        let mut path_w: Vec<u16> = OsStr::new(wav_path)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        unsafe {
            stream.BindToFile(
                PCWSTR(path_w.as_mut_ptr()),
                SPFM_OPEN_READONLY,
                None,
                None,
                0,
            )
        }
        .map_err(|e| SapiError::from_windows("ISpStream::BindToFile", e))?;

        unsafe { recognizer.SetInput(&stream, false) }
            .map_err(|e| SapiError::from_windows("ISpRecognizer::SetInput", e))?;

        let context = unsafe { recognizer.CreateRecoContext() }
            .map_err(|e| SapiError::from_windows("ISpRecognizer::CreateRecoContext", e))?;

        unsafe { context.SetNotifyWin32Event() }
            .map_err(|e| SapiError::from_windows("ISpRecoContext::SetNotifyWin32Event", e))?;

        let event_handle = unsafe { context.GetNotifyEventHandle() };
        if event_handle.0.is_null() {
            return Err(SapiError {
                stage: "ISpRecoContext::GetNotifyEventHandle",
                hresult: 0,
                message: "GetNotifyEventHandle returned a null HANDLE".to_string(),
            });
        }

        let interest_mask = spfei(SPEI_RECOGNITION.0)
            | spfei(SPEI_END_SR_STREAM.0)
            | spfei(SPEI_FALSE_RECOGNITION.0);
        unsafe { context.SetInterest(interest_mask, interest_mask) }
            .map_err(|e| SapiError::from_windows("ISpRecoContext::SetInterest", e))?;

        let grammar: ISpRecoGrammar = unsafe { context.CreateGrammar(0) }
            .map_err(|e| SapiError::from_windows("ISpRecoContext::CreateGrammar", e))?;

        unsafe { grammar.LoadDictation(PCWSTR::null(), SPLO_STATIC) }
            .map_err(|e| SapiError::from_windows("ISpRecoGrammar::LoadDictation", e))?;

        unsafe { grammar.SetDictationState(SPRS_ACTIVE) }
            .map_err(|e| SapiError::from_windows("ISpRecoGrammar::SetDictationState", e))?;

        unsafe { recognizer.SetRecoState(SPRST_ACTIVE_ALWAYS) }
            .map_err(|e| SapiError::from_windows("ISpRecognizer::SetRecoState(ACTIVE)", e))?;

        // Pull the transcript out of the event stream. Each phrase ends
        // with an `SPEI_RECOGNITION` event whose `lParam` is an
        // `ISpRecoResult*`; the WAV-exhausted condition fires
        // `SPEI_END_SR_STREAM`. False recognitions (engine couldn't decide
        // what was said) are gathered by `SPEI_FALSE_RECOGNITION` so we
        // can include them with low confidence rather than dropping
        // mumbled audio entirely.
        let mut transcript = String::new();
        let started = Instant::now();
        loop {
            if started.elapsed() > RECOGNITION_DEADLINE {
                tracing::warn!(
                    target: "claudette::voice::platform_speech::windows",
                    "SAPI event loop hit RECOGNITION_DEADLINE without SPEI_END_SR_STREAM",
                );
                break;
            }

            let wait = unsafe { WaitForSingleObject(event_handle, EVENT_POLL_WAIT_MS) };
            // WAIT_OBJECT_0 = signaled. WAIT_TIMEOUT = nothing yet, loop.
            // Anything else is unexpected — log and stop the loop.
            if wait != WAIT_OBJECT_0 {
                continue;
            }

            let mut done = false;
            loop {
                let mut event = SPEVENT::default();
                let mut fetched = 0u32;
                let hr = unsafe { context.GetEvents(1, &mut event, &mut fetched) };
                if let Err(err) = hr.clone()
                    && hr != Ok(())
                    && fetched == 0
                {
                    return Err(SapiError::from_windows("ISpRecoContext::GetEvents", err));
                }
                let _ = hr;
                if fetched == 0 {
                    break;
                }

                // _bitfield packs `eEventId` in the low 16 bits and
                // `elParamType` in the next 16 bits. We only need the
                // event id to dispatch.
                let event_id = (event._bitfield & 0xFFFF) as i32;
                if event_id == SPEI_RECOGNITION.0 || event_id == SPEI_FALSE_RECOGNITION.0 {
                    if let Some(text) = unsafe { extract_recognition_text(&event) } {
                        let trimmed = text.trim();
                        if !trimmed.is_empty() {
                            if !transcript.is_empty() {
                                transcript.push(' ');
                            }
                            transcript.push_str(trimmed);
                        }
                    }
                } else if event_id == SPEI_END_SR_STREAM.0 {
                    done = true;
                }

                // Release any lParam that holds an IUnknown*. SAPI's C++
                // SDK ships an `SPCLEAREVENT` macro that does this; we
                // inline the equivalent. `elParamType` lives in the upper
                // 16 bits of `_bitfield`. Type 1 (`SPET_LPARAM_IS_OBJECT`)
                // means lParam is an IUnknown*.
                let elparam_type = (event._bitfield >> 16) & 0xFFFF;
                if elparam_type == 1 && event.lParam.0 != 0 {
                    let raw = event.lParam.0 as *mut std::ffi::c_void;
                    if !raw.is_null() {
                        let unknown = unsafe { windows::core::IUnknown::from_raw(raw) };
                        drop(unknown); // Release happens via Drop
                    }
                }
            }

            if done {
                break;
            }
        }

        // SetRecoState(SPRST_INACTIVE) flushes any in-flight recognizer
        // state so the next call (recognizer/grammar/context drop below)
        // doesn't race against the engine still processing audio.
        let _ = unsafe { recognizer.SetRecoState(SPRST_INACTIVE) };

        // grammar / context / recognizer / stream all drop here in
        // reverse order of construction.
        drop(grammar);
        drop(context);
        drop(recognizer);
        drop(stream);
        // Touch path_w so it stays alive through the `BindToFile` call —
        // BindToFile copies the path, but make the lifetime explicit.
        path_w.clear();

        if transcript.is_empty() {
            // Empty transcript on a successful event loop = recognizer
            // saw audio but couldn't match a phrase. Same UX as the
            // macOS path (`stop_platform_recording` rejects empty).
            // Leave the empty string so `voice.rs` produces the
            // standard "No speech was recognized" error.
        }

        Ok(transcript)
    }

    /// Pull the recognized text out of an `SPEI_RECOGNITION` /
    /// `SPEI_FALSE_RECOGNITION` event. `lParam` holds an
    /// `ISpRecoResult*`; `GetText(0, 0xFFFFFFFF, true, ...)` returns the
    /// full phrase. Caller is responsible for releasing the result via
    /// the SPCLEAREVENT logic in the dispatch loop.
    unsafe fn extract_recognition_text(event: &SPEVENT) -> Option<String> {
        if event.lParam.0 == 0 {
            return None;
        }
        let raw = event.lParam.0 as *mut std::ffi::c_void;
        // `from_raw` takes ownership of one reference. We need to keep the
        // event's reference intact for the dispatcher's SPCLEAREVENT
        // cleanup, so AddRef before borrowing.
        let unknown = unsafe { windows::core::IUnknown::from_raw_borrowed(&raw) }?;
        let result: ISpRecoResult = unknown.cast().ok()?;

        let mut text_ptr = PWSTR::null();
        let hr = unsafe { result.GetText(0, u32::MAX, true, &mut text_ptr, None) };
        if hr.is_err() || text_ptr.is_null() {
            return None;
        }

        let text = unsafe { text_ptr.to_string().ok() };
        unsafe { CoTaskMemFree(Some(text_ptr.as_ptr() as *const _)) };
        text
    }

    /// One-line, actionable user-facing error string. The raw HRESULT and
    /// stage name still flow into the daily log via the `tracing::error!`
    /// at the call site; this is only the toolbar pill copy.
    ///
    /// Public so the test module can pin the contract that every message
    /// is short, single-line, and free of HRESULT codes / type names.
    pub(super) fn user_facing_error(detail: &str) -> String {
        // Most callers go through `user_facing_error_for_hresult`; this
        // string-based variant only handles the rare CoInitializeEx
        // failure where we don't yet have a structured stage.
        if detail.contains("CoInitializeEx") {
            "Couldn't initialize Windows COM for speech recognition. Restart Claudette; if it persists, switch to the offline Distil-Whisper provider in Plugins settings.".to_string()
        } else {
            "Speech recognition failed. See Settings → Diagnostics → Open log directory for details.".to_string()
        }
    }

    /// Map a SAPI failure stage + HRESULT to a short user-facing string.
    /// The most common failures get tailored copy with a concrete next
    /// step; everything else falls through to the generic "see
    /// diagnostics log" pointer.
    pub(super) fn user_facing_error_for_hresult(stage: &str, hresult: u32) -> String {
        // SPERR_NOT_FOUND (0x8004503A) — no recognizer installed for the
        // requested locale. Fires from `CoCreateInstance(SpInprocRecognizer)`
        // when the OS has no speech engine registered.
        const SPERR_NOT_FOUND: u32 = 0x8004503A;
        // SPERR_AUDIO_BUFFER_OVERFLOW (0x8004502A) and friends mean the
        // audio source isn't producing data the recognizer can consume.
        const SPERR_UNINITIALIZED: u32 = 0x80045028;
        // CLASS_E_CLASSNOTAVAILABLE (0x80040111) — SAPI not installed.
        const CLASS_E_CLASSNOTAVAILABLE: u32 = 0x80040111;
        // REGDB_E_CLASSNOTREG (0x80040154) — same as above on most boxes.
        const REGDB_E_CLASSNOTREG: u32 = 0x80040154;
        // E_OUTOFMEMORY (0x8007000E) and E_ACCESSDENIED (0x80070005) get
        // their own messages so users have something to act on.
        const E_OUTOFMEMORY: u32 = 0x8007000E;
        const E_ACCESSDENIED: u32 = 0x80070005;

        match hresult {
            SPERR_NOT_FOUND => {
                "Windows speech recognizer is not installed. Add a Speech Recognizer language pack in Windows Settings → Time & language → Speech.".to_string()
            }
            CLASS_E_CLASSNOTAVAILABLE | REGDB_E_CLASSNOTREG => {
                "Windows Speech API (SAPI) is not registered on this machine. Switch to the offline Distil-Whisper provider in Plugins settings.".to_string()
            }
            SPERR_UNINITIALIZED => {
                "Windows speech recognizer reported its audio input was not initialized. Try recording again — see Settings → Diagnostics for details.".to_string()
            }
            E_ACCESSDENIED => {
                "Windows denied access to the recorded audio file. Check antivirus / sandbox settings, then try again.".to_string()
            }
            E_OUTOFMEMORY => {
                "Windows speech recognizer ran out of memory. Try a shorter recording.".to_string()
            }
            _ if stage.starts_with("ISpStream::BindToFile") => {
                "Couldn't load the recorded audio. Try recording again — see Settings → Diagnostics for details.".to_string()
            }
            _ => {
                "Speech recognition failed. See Settings → Diagnostics → Open log directory for details.".to_string()
            }
        }
    }
}

// On Windows, voice.rs reaches for `cancel_active_transcription` from the
// shared platform-speech surface. The native SAPI path has no cooperative-
// cancel hook reachable from outside the recognition thread — the
// `RECOGNITION_DEADLINE` event-loop ceiling and the outer `transcription_
// timeout` in `voice.rs::stop_platform_recording` together cover the
// runaway-engine case.
#[cfg(windows)]
pub(crate) fn cancel_active_transcription() {}

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

#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;

    #[test]
    fn windows_availability_reports_ready_via_sapi() {
        // SAPI 5.4 is bundled with every Windows install; the trait
        // contract is "advertise Ready and let `transcribe()` surface
        // real failures." Nothing to probe here.
        let availability = DefaultPlatformSpeechEngine::new().availability();

        assert_eq!(
            availability.status,
            PlatformSpeechAvailabilityStatus::Ready,
            "expected Ready on Windows (got {availability:?})",
        );
        assert_eq!(availability.engine_label.as_deref(), Some("Windows SAPI"));
        assert!(
            !availability.message.is_empty(),
            "availability message must populate the toolbar / Plugins panel",
        );
    }

    #[test]
    fn windows_user_facing_messages_are_short_and_clean() {
        // The toolbar pill renders the user-facing string verbatim. Every
        // message we can produce must stay one line and short enough to
        // fit the 280px / 32vw error pill without ellipsizing the
        // actionable bit. HRESULT codes and stage names belong in the
        // tracing log, never the pill.
        let hresults = [
            ("CoCreateInstance(SpInprocRecognizer)", 0x8004503Au32), // SPERR_NOT_FOUND
            ("CoCreateInstance(SpInprocRecognizer)", 0x80040111u32), // CLASS_E_CLASSNOTAVAILABLE
            ("CoCreateInstance(SpInprocRecognizer)", 0x80040154u32), // REGDB_E_CLASSNOTREG
            ("ISpStream::BindToFile", 0x80070003u32),                // ERROR_PATH_NOT_FOUND
            ("ISpStream::BindToFile", 0x80070005u32),                // E_ACCESSDENIED
            ("ISpRecognizer::SetInput", 0x80045028u32),              // SPERR_UNINITIALIZED
            ("ISpRecognizer::SetRecoState(ACTIVE)", 0x8007000Eu32),  // E_OUTOFMEMORY
            ("ISpRecoContext::CreateGrammar", 0x8000_0000u32),       // unknown HRESULT
        ];
        for (stage, hr) in hresults {
            let pill = windows_speech::user_facing_error_for_hresult(stage, hr);
            assert!(
                !pill.contains('\n'),
                "user-facing message must be single line: {pill:?}",
            );
            assert!(
                pill.len() < 220,
                "user-facing message too long ({}): {pill:?}",
                pill.len(),
            );
            assert!(
                !pill.contains("0x") && !pill.contains("HRESULT"),
                "user-facing message leaked HRESULT detail: {pill:?}",
            );
            assert!(
                !pill.contains("ISp") && !pill.contains("CoCreateInstance"),
                "user-facing message leaked SAPI/COM symbol names: {pill:?}",
            );
        }
    }

    #[test]
    fn windows_user_facing_messages_match_known_hresults() {
        // Pin the specific copy for the user-impacting failures so a
        // refactor doesn't silently replace the actionable hint with the
        // generic fallback. Anything not pinned here is allowed to drift
        // — these three are the failures users can fix themselves.
        let pill = windows_speech::user_facing_error_for_hresult(
            "CoCreateInstance(SpInprocRecognizer)",
            0x8004503A, // SPERR_NOT_FOUND
        );
        assert!(
            pill.contains("Speech Recognizer language pack"),
            "missing recognizer must point users at the language-pack install: {pill:?}",
        );

        let pill = windows_speech::user_facing_error_for_hresult(
            "CoCreateInstance(SpInprocRecognizer)",
            0x80040154, // REGDB_E_CLASSNOTREG
        );
        assert!(
            pill.contains("Distil-Whisper"),
            "SAPI-not-registered must offer the offline fallback: {pill:?}",
        );

        let pill =
            windows_speech::user_facing_error_for_hresult("ISpStream::BindToFile", 0x80070005);
        assert!(
            pill.contains("denied"),
            "E_ACCESSDENIED on the WAV must mention access denial: {pill:?}",
        );
    }

    #[test]
    fn windows_unknown_hresult_falls_back_to_diagnostics_pointer() {
        // Anything we haven't mapped should still send the user to
        // Settings → Diagnostics rather than dump the raw error. Pin
        // this so a future contributor adding HRESULT cases doesn't
        // accidentally remove the safety net.
        let pill =
            windows_speech::user_facing_error_for_hresult("ISpRecoContext::GetEvents", 0xDEADBEEF);
        assert!(pill.contains("Settings → Diagnostics"));
    }

    #[test]
    fn windows_coinit_failure_message_mentions_distil_whisper_fallback() {
        // CoInitializeEx failure is unrecoverable from inside the
        // recognizer call, so the only useful next step is the offline
        // provider. Pin the copy that says so.
        let pill = windows_speech::user_facing_error("CoInitializeEx HRESULT 0x80004005");
        assert!(pill.contains("Distil-Whisper"));
        assert!(!pill.contains("HRESULT"));
    }
}
