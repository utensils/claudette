// The platform speech bridge gives the cross-platform `voice.rs` a single
// trait it can lean on regardless of whether the host OS exposes a native
// recognizer (macOS Apple Speech, Windows System.Speech), or only a stub
// fallback (Linux for now). Each `#[cfg(...)]` impl block below shares the
// trait definition so callers in voice.rs do not need any per-OS branching
// once they hold a `&dyn PlatformSpeechEngine`.
//
// The macOS path links to a small Swift static library (see build.rs) that
// drives `SFSpeechRecognizer` / `SpeechAnalyzer`. The Windows path shells
// out to PowerShell + System.Speech.Recognition, which is bundled with
// every Windows install via the .NET Framework — no extra runtime, no
// download, no cloud round-trip. Both feed the same captured-audio buffer
// captured by `CpalAudioRecorder`, written to a temporary 16-bit PCM WAV
// before the engine reads it back.

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

    // Both helpers are Windows-only today — the Windows speech bridge is
    // the sole non-test caller. Keep the cfg tight so the symbols don't
    // become a dead-code lint on macOS / Linux.
    #[cfg(windows)]
    fn ready_now(engine_label: &str, message: impl Into<String>) -> Self {
        Self {
            status: PlatformSpeechAvailabilityStatus::Ready,
            engine_label: Some(engine_label.to_string()),
            message: message.into(),
        }
    }

    #[cfg(windows)]
    fn engine_unavailable(message: impl Into<String>) -> Self {
        Self {
            status: PlatformSpeechAvailabilityStatus::EngineUnavailable,
            engine_label: None,
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
        // through Settings → Privacy → Microphone, and System.Speech sees
        // the WAV file directly without re-asking. Returning the static
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

// Windows speech recognition bridge — implemented via PowerShell +
// System.Speech.Recognition (part of .NET Framework, bundled in every
// Windows install since 7). We write the captured audio to a temp WAV,
// hand it off to a one-shot PowerShell script that drives a
// `SpeechRecognitionEngine.SetInputToWaveFile()` loop, and parse a JSON
// envelope back. Unlike Windows.Media.SpeechRecognition (WinRT) which
// only listens to the live mic, the legacy System.Speech path accepts
// arbitrary WAV files — the same shape as the macOS file-based bridge.
#[cfg(windows)]
mod windows_speech {
    use std::os::windows::process::CommandExt;
    use std::path::Path;
    use std::process::Command;

    use super::PlatformSpeechAvailability;

    // CREATE_NO_WINDOW (0x0800_0000) suppresses the brief PowerShell console
    // flash that would otherwise pop up on every transcription. The flag is
    // only available on Windows so it lives behind the same cfg as the rest
    // of this module.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    // Ceiling for the PowerShell side. The Rust caller wraps us in its own
    // `transcription_timeout` (90 s by default), so this only protects against
    // a stuck PS process that hasn't returned yet — generous on purpose.
    const POWERSHELL_TIMEOUT_SECS: u64 = 120;

    pub(super) fn availability() -> PlatformSpeechAvailability {
        // The user-visible label is intentionally identical between the
        // assumed-ready and degraded states; the message string is what
        // surfaces when something is wrong. We don't probe System.Speech up
        // front because that would cost a ~300 ms PowerShell spawn on every
        // app launch — the trait contract for macOS is also "report what
        // looks ready and let `transcribe()` surface real errors."
        if find_powershell().is_some() {
            PlatformSpeechAvailability::ready_now(
                "Windows System.Speech",
                "Ready via Windows System.Speech (no setup required)",
            )
        } else {
            PlatformSpeechAvailability::engine_unavailable(
                "Windows PowerShell was not found on PATH; system dictation cannot start. Install Windows PowerShell or use the offline Distil-Whisper provider.",
            )
        }
    }

    pub(super) fn transcribe_wav_path(wav_path: &Path) -> Result<String, String> {
        let powershell = find_powershell().ok_or_else(|| {
            "Windows PowerShell was not found on PATH; cannot run system dictation.".to_string()
        })?;

        // Single-quoted PowerShell strings are fully literal — only `'` needs
        // escaping (doubled). UUID-based filenames don't contain `'`, but the
        // user's temp-dir path could (e.g. via OneDrive folder names with
        // apostrophes). Be defensive.
        let path_literal = wav_path.display().to_string().replace('\'', "''");
        let script = build_recognition_script(&path_literal);

        let output = Command::new(&powershell)
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-OutputFormat",
                "Text",
                "-Command",
                &script,
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("Failed to spawn PowerShell for system dictation: {e}"))?;

        // PowerShell's stdout in OutputFormat=Text is the user's `Write-Output`
        // text. We emit a single JSON line in the script for easy parsing.
        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();

        // Whether the PowerShell process succeeded or our envelope parser
        // accepted the output, we want the *raw* stdout/stderr stamped into
        // the daily log on every failure. tracing's `error!`/`warn!` ships
        // it through the same `claudette::logging` pipeline that powers
        // Settings → Diagnostics → Open log directory. No parallel debug
        // file written by us — one canonical place to look.
        if !output.status.success() {
            tracing::error!(
                target: "claudette::voice::platform_speech::windows",
                exit = output.status.code().unwrap_or(-1),
                wav = %wav_path.display(),
                stderr = %stderr,
                stdout = %stdout,
                "PowerShell system dictation script exited non-zero",
            );
            return Err(format_failure(
                &format!(
                    "System dictation script failed (exit {})",
                    output.status.code().unwrap_or(-1),
                ),
                trim_for_user(&stderr).as_deref(),
            ));
        }

        match parse_transcription_envelope(&stdout) {
            Ok(text) => Ok(text),
            Err(reason) => {
                let mapped = map_recognized_error(&reason);
                // Stamp the raw .NET exception chain into the daily log so
                // a future bug report has the underlying cause even when
                // the user-visible message has been mapped to a friendly
                // hint. Same `target` as the caller in voice.rs uses for
                // its own warns — a single `RUST_LOG=claudette::voice=debug`
                // filter sees the whole pipeline.
                tracing::error!(
                    target: "claudette::voice::platform_speech::windows",
                    wav = %wav_path.display(),
                    raw_error = %reason,
                    mapped = %mapped,
                    stdout = %stdout,
                    stderr = %stderr,
                    "System.Speech transcription failed",
                );
                Err(format_failure(&mapped, None))
            }
        }
    }

    fn map_recognized_error(reason: &str) -> String {
        // Map common .NET Framework error fragments to actionable hints.
        // These strings are what System.Speech surfaces when the OS does
        // not have the expected speech recognizer / language pack
        // installed.
        match reason {
            text if text.contains("No recognizer of the required ID found") => {
                "Windows System.Speech recognizer is not installed. Install \"English (United States) Speech Recognizer\" via Settings → Time & language → Speech, then try again.".to_string()
            }
            text if text.contains("Could not load file or assembly") => {
                "System.Speech is unavailable on this Windows install. Use the offline Distil-Whisper provider in Plugins settings.".to_string()
            }
            text if text.contains("AudioFormatNotSupported")
                || text.contains("Stream is not in the correct format") =>
            {
                "Windows System.Speech rejected the captured audio format. Try a different microphone or restart Claudette; if it persists, switch to the offline Distil-Whisper provider in Plugins settings.".to_string()
            }
            other => other.to_string(),
        }
    }

    fn format_failure(message: &str, stderr_hint: Option<&str>) -> String {
        let mut out = message.to_string();
        if let Some(hint) = stderr_hint
            && !out.contains(hint)
        {
            out.push_str(": ");
            out.push_str(hint);
        }
        // Single-source the troubleshooting pointer so users always know
        // where to find the structured details we just logged. The Settings
        // panel uses `claudette::logging::log_dir()`; the toolbar pointer
        // names the route, not the path, so the message survives moves
        // (e.g. CLAUDETTE_LOG_DIR overrides).
        out.push_str(" — full details in Settings → Diagnostics → Open log directory.");
        out
    }

    // pub(super) so the cross-module test in `windows_tests` below can pin
    // the script's escaping rules without us having to spawn PowerShell in
    // unit tests. Production callers go through `transcribe_wav_path`.
    pub(super) fn build_recognition_script(path_literal: &str) -> String {
        // The script:
        //   1. Loads System.Speech (always present on .NET Framework Windows).
        //   2. Sets the WAV file as input — supports any 16-bit PCM mono/stereo
        //      file at common sample rates; we generate 16 kHz mono.
        //   3. Loops `Recognize()` so we capture every phrase, not just the
        //      first one. The 5 s pause between phrases is a System.Speech
        //      default that resets each phrase; once the WAV is exhausted,
        //      `Recognize()` returns $null and we break out.
        //   4. On error, walks the .NET InnerException chain. Without this
        //      we'd surface PowerShell's "Exception calling 'Recognize' with
        //      '1' argument(s): <real cause>" wrapper, which then gets
        //      truncated in the toolbar pill — the user sees an opaque
        //      "Exception calling..." message and has nothing to act on.
        //      Stripping the leading `Exception calling ... :` wrapper and
        //      joining the inner messages surfaces the actual cause
        //      ("Audio device error", "No recognizer ...", etc.).
        //   5. Emits a single-line JSON envelope so the Rust parser doesn't
        //      have to deal with PowerShell's localized error formatting.
        format!(
            r#"$ErrorActionPreference='Stop'
try {{
    Add-Type -AssemblyName System.Speech -ErrorAction Stop
    $r = New-Object System.Speech.Recognition.SpeechRecognitionEngine
    try {{
        $r.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
        $r.SetInputToWaveFile('{path}')
        $phrases = New-Object System.Collections.Generic.List[string]
        while ($true) {{
            $result = $r.Recognize([TimeSpan]::FromSeconds(5))
            if ($null -eq $result) {{ break }}
            if ($result.Text) {{ $phrases.Add($result.Text) }}
        }}
        $payload = [pscustomobject]@{{ ok = $true; text = ($phrases -join ' ') }}
    }} finally {{
        $r.Dispose()
    }}
}} catch {{
    $messages = New-Object System.Collections.Generic.List[string]
    $exception = $_.Exception
    while ($null -ne $exception) {{
        $msg = $exception.Message
        # Strip the "Exception calling \"X\" with \"N\" argument(s):" wrapper
        # PowerShell adds when a method invocation throws — the wrapper is
        # never actionable on its own; the real cause is the next link.
        $msg = [regex]::Replace($msg, '^Exception calling "[^"]+" with "[0-9]+" argument\(s\):\s*"?', '')
        $msg = $msg.TrimEnd('"').Trim()
        if ($msg) {{ $messages.Add(('{{0}}: {{1}}' -f $exception.GetType().Name, $msg)) }}
        $exception = $exception.InnerException
    }}
    if ($messages.Count -eq 0) {{ $messages.Add($_.Exception.GetType().Name + ': (no message)') }}
    $payload = [pscustomobject]@{{
        ok = $false
        error = ($messages -join ' :: ')
        stack = $_.ScriptStackTrace
    }}
}}
$payload | ConvertTo-Json -Compress"#,
            path = path_literal,
        )
    }

    pub(super) fn parse_transcription_envelope(stdout: &str) -> Result<String, String> {
        // ConvertTo-Json -Compress emits a single JSON object on its own line.
        // PowerShell may also emit warnings or other text before/after; pick
        // the last non-empty line that looks like JSON.
        let line = stdout
            .lines()
            .map(str::trim)
            .filter(|line| line.starts_with('{') && line.ends_with('}'))
            .next_back()
            .ok_or_else(|| {
                format!(
                    "System dictation produced no recognizable output. Raw output: {}",
                    trim_for_user(stdout).unwrap_or_else(|| "(empty)".to_string()),
                )
            })?;

        let envelope: serde_json::Value = serde_json::from_str(line).map_err(|e| {
            format!(
                "System dictation returned malformed output ({e}). Raw output: {}",
                trim_for_user(line).unwrap_or_else(|| "(empty)".to_string()),
            )
        })?;

        let ok = envelope
            .get("ok")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        if ok {
            Ok(envelope
                .get("text")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string())
        } else {
            Err(envelope
                .get("error")
                .and_then(|value| value.as_str())
                .unwrap_or("System dictation reported an unspecified failure.")
                .to_string())
        }
    }

    /// Locate a PowerShell binary. Prefer `pwsh.exe` (PowerShell 7+) when
    /// available, but fall back to the always-present `powershell.exe`
    /// (PowerShell 5, ships with Windows). Both bind System.Speech via
    /// .NET Framework / .NET, so either works.
    fn find_powershell() -> Option<std::path::PathBuf> {
        for name in ["pwsh.exe", "powershell.exe"] {
            if let Some(path) = which_on_path(name) {
                return Some(path);
            }
        }
        // Last resort: the absolute path that ships with every Windows
        // install. If it's missing here, dictation simply isn't going to
        // work — the user has a deeply non-standard environment.
        let fallback =
            std::path::PathBuf::from(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe");
        if fallback.exists() {
            Some(fallback)
        } else {
            None
        }
    }

    fn which_on_path(name: &str) -> Option<std::path::PathBuf> {
        let path_var = std::env::var_os("PATH")?;
        for dir in std::env::split_paths(&path_var) {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        None
    }

    fn trim_for_user(text: &str) -> Option<String> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return None;
        }
        // Cap so we don't dump multi-page stack traces into a toolbar tooltip.
        const MAX: usize = 400;
        if trimmed.len() <= MAX {
            Some(trimmed.to_string())
        } else {
            Some(format!("{}…", &trimmed[..MAX]))
        }
    }

    // The timeout is referenced only in the comment above; reading it here
    // keeps the const "live" if a future caller wants to wire it through to
    // a kill-after-N-seconds path. Removing it (and the comment) is fine
    // when we wire that up.
    #[allow(dead_code)]
    const _TIMEOUT_DOC: u64 = POWERSHELL_TIMEOUT_SECS;
}

// On Windows, voice.rs reaches for `cancel_active_transcription` from the
// shared platform-speech surface. The Windows path has no cooperative-cancel
// hook (PowerShell is a fire-and-forget child process for ~1 s), so this is
// a no-op — the timeout in voice.rs::stop_platform_recording covers the
// runaway-process case.
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
    fn windows_availability_reports_ready_when_powershell_present() {
        // PowerShell ships with every Windows install; the test environment
        // we run CI in is no exception. If this asserts otherwise the
        // environment is so non-standard that the user-facing fallback
        // message kicks in correctly.
        let availability = DefaultPlatformSpeechEngine::new().availability();

        assert_eq!(
            availability.status,
            PlatformSpeechAvailabilityStatus::Ready,
            "expected Ready on Windows when PowerShell is on PATH (got {availability:?})",
        );
        assert_eq!(
            availability.engine_label.as_deref(),
            Some("Windows System.Speech"),
        );
    }

    #[test]
    fn windows_envelope_parser_accepts_ok_payload() {
        let stdout = r#"{"ok":true,"text":"hello world"}"#;
        let parsed = windows_speech::parse_transcription_envelope(stdout).expect("ok payload");
        assert_eq!(parsed, "hello world");
    }

    #[test]
    fn windows_envelope_parser_surfaces_missing_recognizer_hint() {
        // Walked-InnerException form — what the real script now emits.
        let stdout = r#"{"ok":false,"error":"InvalidOperationException: No recognizer of the required ID found","stack":"at <ScriptBlock>"}"#;
        let err = windows_speech::parse_transcription_envelope(stdout)
            .expect_err("missing recognizer should error");
        // The parser hands back the raw string; `transcribe_wav_path`'s
        // mapping table is what rewrites it into the friendly hint.
        assert!(err.contains("No recognizer of the required ID found"));
    }

    #[test]
    fn windows_recognition_script_walks_inner_exceptions() {
        // Pin the catch block we depend on for surfacing the real .NET
        // exception. Without this, PowerShell would return its own
        // "Exception calling 'Recognize' with '1' argument(s):" wrapper —
        // visible to the user as an opaque truncated pill.
        let script = windows_speech::build_recognition_script("C:\\foo.wav");
        assert!(script.contains("$exception = $_.Exception"));
        assert!(script.contains("$exception.InnerException"));
        // The wrapper-strip regex must stay — empirically the bare wrapper
        // text is what shows up in the toolbar and the inner is what's
        // useful.
        assert!(script.contains("Exception calling"));
        // We always emit the type name so log readers know which .NET
        // exception class triggered (InvalidOperationException vs.
        // ArgumentException vs. AudioFormatNotSupportedException, etc.).
        assert!(script.contains("$exception.GetType().Name"));
    }

    #[test]
    fn windows_envelope_parser_rejects_garbage_output() {
        let err = windows_speech::parse_transcription_envelope("Some banner\nnot json")
            .expect_err("non-JSON output should error");
        assert!(err.contains("no recognizable output"));
    }

    #[test]
    fn windows_recognition_script_quotes_apostrophes_in_path() {
        let script = windows_speech::build_recognition_script("C:\\Users\\O''Connor\\foo.wav");
        // The path must end up inside single-quoted PowerShell with the
        // apostrophe doubled — anything else means we'd hit a parse error
        // at runtime when the user has an apostrophe in their profile path.
        assert!(script.contains("'C:\\Users\\O''Connor\\foo.wav'"));
        assert!(script.contains("SetInputToWaveFile"));
        assert!(script.contains("DictationGrammar"));
    }
}
