//! Cross-platform audio primitives used by the notification system.
//!
//! macOS and Linux already shell out to native players (`afplay`, `paplay`,
//! `ffplay`) inline at the call sites in `cesp.rs` and the `settings`
//! command module — adding a wrapper there would just duplicate trivial
//! `Command::new(...)` boilerplate.
//!
//! Windows is different: there is no equivalent shipped CLI player, so we
//! drive playback in-process via two complementary backends:
//!
//! 1. **`PlaySoundW`** (Win32) for system-sound aliases like `SystemDefault`
//!    and bare WAV files from `<windows-media-dir>()`. Zero decoder cost,
//!    plays at the user's system volume, and respects whatever sound the
//!    user has assigned to the *Default Beep* in Sound settings.
//!
//! 2. **`rodio`** (pure Rust on top of `cpal` + `symphonia`) for OpenPeon
//!    sound packs that ship MP3 / OGG. `PlaySoundW` only handles PCM WAV,
//!    so packs like Alan Rickman / Elise (which the registry promotes)
//!    need a real decoder. Rodio also gives us per-call volume control
//!    that matches `afplay -v` / `paplay --volume` on the other platforms.
//!
//! The two paths are kept independent so the rodio dep cost is paid only
//! when a user opts into a sound pack — system-sound playback stays
//! decoder-free.

#[cfg(windows)]
mod win {
    use std::os::windows::ffi::OsStrExt;
    use std::path::{Path, PathBuf};
    use windows_sys::Win32::Media::Audio::{
        PlaySoundW, SND_ALIAS, SND_ASYNC, SND_FILENAME, SND_NODEFAULT,
    };

    fn to_wide_nul(s: &std::ffi::OsStr) -> Vec<u16> {
        s.encode_wide().chain(std::iter::once(0)).collect()
    }

    /// Play a `.wav` file asynchronously via `PlaySoundW`. Returns `true`
    /// on success, `false` if the file is missing or `PlaySoundW`
    /// rejected the request.
    ///
    /// Uses `SND_FILENAME | SND_ASYNC | SND_NODEFAULT` — the call returns
    /// immediately, Windows owns playback, and on failure (codec
    /// mismatch, etc.) it stays silent rather than playing the system
    /// default beep. Because `SND_ASYNC` defers file resolution, missing
    /// files often *also* return success from `PlaySoundW`; we therefore
    /// pre-flight `path.exists()` so a missing file is a clean `false`
    /// for the caller (used by `play_notification_sound` to log a
    /// breadcrumb when a configured sound disappears).
    ///
    /// PlaySoundW always plays at the system volume; for per-call volume
    /// control on WAV / MP3 / OGG, use `play_audio_file_async` instead.
    pub fn play_wav_file_async(path: &Path) -> bool {
        if !path.exists() {
            return false;
        }
        let wide = to_wide_nul(path.as_os_str());
        // SAFETY: `wide` is a valid, NUL-terminated UTF-16 buffer that
        // outlives the `PlaySoundW` call. With `SND_ASYNC | SND_FILENAME`
        // Windows opens the file synchronously inside the call and starts
        // a background play — it does not retain the pointer past return.
        // The lpModule argument is null, which is required when SND_ALIAS
        // / SND_RESOURCE are not set.
        let ok = unsafe {
            PlaySoundW(
                wide.as_ptr(),
                std::ptr::null_mut(),
                SND_FILENAME | SND_ASYNC | SND_NODEFAULT,
            )
        };
        ok != 0
    }

    /// Play a Windows system-sound alias asynchronously (e.g. `"SystemAsterisk"`,
    /// `"SystemDefault"`, `"MailBeep"`). Returns `true` on success.
    pub fn play_alias_async(alias: &str) -> bool {
        let os: std::ffi::OsString = alias.into();
        let wide = to_wide_nul(os.as_os_str());
        // SAFETY: as above, with `SND_ALIAS` the lpszSound buffer must be
        // valid for the duration of the call only.
        let ok = unsafe {
            PlaySoundW(
                wide.as_ptr(),
                std::ptr::null_mut(),
                SND_ALIAS | SND_ASYNC | SND_NODEFAULT,
            )
        };
        ok != 0
    }

    /// Play any audio file rodio can decode (WAV / MP3 / OGG with our
    /// `symphonia-*` features) at the given attenuation. Returns `true`
    /// once playback has been *committed* (file opened and decoder
    /// built) and the worker thread spawned; the sound finishes in a
    /// detached thread that owns the `MixerDeviceSink`. Volume is
    /// clamped to `[0.0, 1.0]`.
    ///
    /// Returns `false` for failures we can detect synchronously — file
    /// missing, file unreadable, or the decoder rejecting the format.
    /// Audio-device errors (no default output, no audio service) are
    /// caught inside the worker thread and surface as a `tracing::warn`
    /// rather than a `false` return; the caller has already chosen to
    /// queue a sound at that point, so it makes more sense to log and
    /// move on than to lie to a fire-and-forget caller.
    pub fn play_audio_file_async(path: &Path, volume: f32) -> bool {
        // Pre-flight everything we can without booting an audio device,
        // so the boolean return value is meaningful for callers that
        // log on failure (`cesp::play_audio_file`, the settings preview).
        if !path.exists() {
            return false;
        }
        let file = match std::fs::File::open(path) {
            Ok(f) => f,
            Err(e) => {
                tracing::warn!(
                    target: "claudette::audio",
                    path = %path.display(),
                    error = %e,
                    "could not open sound file"
                );
                return false;
            }
        };
        let reader = std::io::BufReader::new(file);
        let decoder = match rodio::Decoder::new(reader) {
            Ok(d) => d,
            Err(e) => {
                tracing::warn!(
                    target: "claudette::audio",
                    path = %path.display(),
                    error = %e,
                    "could not decode sound file (unsupported format?)"
                );
                return false;
            }
        };
        let owned: PathBuf = path.to_path_buf();
        let vol = volume.clamp(0.0, 1.0);

        // rodio's `MixerDeviceSink` owns the cpal stream and is not safe
        // to move *while held*, so we open it inside the spawned thread.
        // Dropping it before playback finishes cuts the sound mid-play,
        // hence the explicit `sleep_until_end()` before the thread
        // returns. This mirrors the macOS/Linux pattern where the
        // spawned `afplay` / `paplay` child owns its own audio context
        // for the duration of one sound.
        std::thread::spawn(move || {
            let device_sink = match rodio::DeviceSinkBuilder::open_default_sink() {
                Ok(s) => s,
                Err(e) => {
                    tracing::warn!(
                        target: "claudette::audio",
                        path = %owned.display(),
                        error = %e,
                        "no default audio output device — skipping playback"
                    );
                    return;
                }
            };
            let player = rodio::Player::connect_new(device_sink.mixer());
            player.set_volume(vol);
            player.append(decoder);
            // Block this background thread until the sound finishes so
            // `device_sink` and `player` remain alive for the duration
            // of playback. Returning here drops both, ending the sound.
            player.sleep_until_end();
        });
        true
    }
}

#[cfg(windows)]
pub use win::{play_alias_async, play_audio_file_async, play_wav_file_async};

/// Directory holding Windows' built-in system sound files. Reads
/// `%WINDIR%` so non-default install drives (Windows on `D:`, Windows
/// PE, custom system roots) still find their sounds; falls back to
/// `C:\Windows\Media` only when `WINDIR` isn't set, which on a real
/// Windows install would mean something is very wrong.
#[cfg(windows)]
pub fn windows_media_dir() -> std::path::PathBuf {
    let windir = std::env::var_os("WINDIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from(r"C:\Windows"));
    windir.join("Media")
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    #[test]
    fn windows_media_dir_uses_windir() {
        // The function honours $WINDIR — guard the wiring so a refactor
        // can't silently re-hardcode `C:\Windows`.
        let prev = std::env::var_os("WINDIR");
        // SAFETY: `cargo test` runs a single test binary single-threaded
        // when `--test-threads=1` is set; the rest of the suite doesn't
        // mutate WINDIR, so a transient reset is safe in practice. (The
        // assertion below restores the original value on either branch.)
        unsafe { std::env::set_var("WINDIR", r"D:\WinPE") };
        let dir = super::windows_media_dir();
        match prev {
            Some(v) => unsafe { std::env::set_var("WINDIR", v) },
            None => unsafe { std::env::remove_var("WINDIR") },
        }
        assert_eq!(dir, std::path::PathBuf::from(r"D:\WinPE\Media"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_media_dir_falls_back_when_unset() {
        let prev = std::env::var_os("WINDIR");
        unsafe { std::env::remove_var("WINDIR") };
        let dir = super::windows_media_dir();
        if let Some(v) = prev {
            unsafe { std::env::set_var("WINDIR", v) };
        }
        assert_eq!(dir, std::path::PathBuf::from(r"C:\Windows\Media"));
    }

    #[cfg(windows)]
    #[test]
    fn play_missing_file_returns_false() {
        // With the path-exists pre-flight, missing files are a clean
        // `false` regardless of how `PlaySoundW` resolves SND_ASYNC
        // requests internally. Guards against a regression where the
        // pre-flight gets refactored away.
        let ok =
            super::play_wav_file_async(std::path::Path::new(r"C:\definitely\not\here\nope.wav"));
        assert!(!ok);
    }

    #[cfg(windows)]
    #[test]
    fn play_alias_does_not_panic() {
        // `SystemDefault` is a stock alias present on every Windows
        // install. We don't assert success — audio devices may not
        // exist in CI — only that the FFI path is sound.
        let _ = super::play_alias_async("SystemDefault");
    }

    #[cfg(windows)]
    #[test]
    fn rodio_play_missing_file_returns_false() {
        // `play_audio_file_async` short-circuits on a missing path
        // before touching rodio — so this test runs cleanly even on a
        // CI host with no audio device, and protects against a
        // regression where we accidentally start spawning threads for
        // paths that won't resolve.
        let ok = super::play_audio_file_async(
            std::path::Path::new(r"C:\definitely\not\here\nope.mp3"),
            0.5,
        );
        assert!(!ok);
    }

    #[cfg(windows)]
    #[test]
    fn rodio_play_undecodable_file_returns_false() {
        // Synchronous pre-flight catches decoder failures: writing a
        // small text file with `.mp3` extension makes the path exist
        // but the decoder reject it. The function should return
        // `false`, log a warning, and NOT spawn the worker thread.
        // Validates the contract documented on `play_audio_file_async`.
        let tmp = std::env::temp_dir().join("claudette-audio-bogus.mp3");
        std::fs::write(&tmp, b"not actually mp3").expect("write tmp");
        let ok = super::play_audio_file_async(&tmp, 0.5);
        std::fs::remove_file(&tmp).ok();
        assert!(!ok);
    }
}
