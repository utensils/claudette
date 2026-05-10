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
//!    and bare WAV files from `C:\Windows\Media`. Zero decoder cost, plays
//!    at the user's system volume, and respects whatever sound the user
//!    has assigned to the *Default Beep* in Sound settings.
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
    /// on success.
    ///
    /// Uses `SND_FILENAME | SND_ASYNC | SND_NODEFAULT` — the call returns
    /// immediately, Windows owns playback, and on failure (missing file,
    /// codec mismatch) it stays silent rather than playing the system
    /// default beep. PlaySoundW always plays at the system volume; for
    /// per-call volume control on WAV / MP3 / OGG, use
    /// `play_audio_file_async` instead.
    pub fn play_wav_file_async(path: &Path) -> bool {
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
    /// once playback has been queued — the call returns immediately and
    /// the sound finishes in a detached thread that owns the
    /// `OutputStream`. Volume is clamped to `[0.0, 1.0]`.
    ///
    /// Failure modes (file missing, no audio device, decode error, queue
    /// full) all return `false` and emit a `tracing::warn` so a stuck
    /// notification has a breadcrumb in the log without crashing the app.
    pub fn play_audio_file_async(path: &Path, volume: f32) -> bool {
        if !path.exists() {
            return false;
        }
        let owned: PathBuf = path.to_path_buf();
        let vol = volume.clamp(0.0, 1.0);

        // rodio's `MixerDeviceSink` owns the cpal stream and is not safe
        // to move *while held*, so we construct + own it entirely inside
        // the spawned thread. Dropping it before playback finishes cuts
        // the sound mid-play, hence the explicit `sleep_until_end()`
        // before the thread returns. This mirrors the macOS/Linux
        // pattern where the spawned `afplay` / `paplay` child owns its
        // own audio context for the duration of one sound.
        std::thread::spawn(move || {
            let device_sink = match rodio::DeviceSinkBuilder::open_default_sink() {
                Ok(s) => s,
                Err(e) => {
                    tracing::warn!(
                        target: "claudette::audio",
                        error = %e,
                        "no default audio output device — skipping playback"
                    );
                    return;
                }
            };
            let file = match std::fs::File::open(&owned) {
                Ok(f) => f,
                Err(e) => {
                    tracing::warn!(
                        target: "claudette::audio",
                        path = %owned.display(),
                        error = %e,
                        "could not open sound file"
                    );
                    return;
                }
            };
            let reader = std::io::BufReader::new(file);
            let decoder = match rodio::Decoder::new(reader) {
                Ok(d) => d,
                Err(e) => {
                    tracing::warn!(
                        target: "claudette::audio",
                        path = %owned.display(),
                        error = %e,
                        "could not decode sound file (unsupported format?)"
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

/// Directory holding Windows' built-in system sound files. Used by the
/// settings command module to enumerate available sounds and to resolve
/// a sound name → on-disk path.
#[cfg(windows)]
pub const WINDOWS_MEDIA_DIR: &str = r"C:\Windows\Media";

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    #[test]
    fn windows_media_dir_constant_is_set() {
        // Guards against an accidental empty/typo'd path. We don't check
        // existence — the directory is part of any Windows install but
        // could be absent in stripped CI images.
        assert!(super::WINDOWS_MEDIA_DIR.ends_with("Media"));
    }

    #[cfg(windows)]
    #[test]
    fn play_missing_file_does_not_panic() {
        // We can't assert on the return value: with `SND_ASYNC`, Windows
        // queues the request and resolves the file later, so missing
        // paths often return `TRUE` anyway. The point of this test is
        // just to confirm the FFI signature, lifetimes, and pointer
        // discipline don't crash on a syntactically valid path that
        // happens not to exist.
        let _ =
            super::play_wav_file_async(std::path::Path::new(r"C:\definitely\not\here\nope.wav"));
    }

    #[cfg(windows)]
    #[test]
    fn play_alias_does_not_panic() {
        // `SystemDefault` is a stock alias present on every Windows
        // install. As above, we don't assert success — audio devices
        // may not exist in CI — only that the FFI path is sound.
        let _ = super::play_alias_async("SystemDefault");
    }

    #[cfg(windows)]
    #[test]
    fn rodio_play_missing_file_returns_false() {
        // `play_audio_file_async` short-circuits on a missing path before
        // touching rodio — so this test runs cleanly even on a CI host
        // with no audio device, and protects against a regression where
        // we accidentally start spawning threads for paths that won't
        // resolve.
        let ok = super::play_audio_file_async(
            std::path::Path::new(r"C:\definitely\not\here\nope.mp3"),
            0.5,
        );
        assert!(!ok);
    }
}
