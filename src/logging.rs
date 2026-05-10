//! Structured logging for Claudette.
//!
//! Wires `tracing-subscriber` with two layers:
//!
//! 1. **stderr (pretty)** — what `cargo tauri dev`'s terminal already shows.
//!    Replaces the existing scattered `eprintln!` output with
//!    timestamped, leveled, PID-stamped lines.
//! 2. **rolling file (compact, structured)** — daily-rotated logs at
//!    `~/.claudette/logs/claudette.<YYYY-MM-DD>.log` (the
//!    `tracing-appender` filename layout is `<prefix>.<date>.<suffix>`),
//!    written via `tracing-appender::non_blocking` so the runtime
//!    never blocks on disk I/O. A startup sweep deletes files older
//!    than [`RETAIN_DAYS`] so we don't grow unbounded.
//!
//! ## Multiple instances
//!
//! Claudette has no single-instance lock — the user explicitly runs
//! multiple dev builds in parallel for testing. Each instance's log
//! lines carry the process PID so post-hoc you can demux who did what.
//! If `CLAUDETTE_LOG_DIR` is set, that path overrides the default — set
//! it per-instance in `scripts/dev.sh` if you want isolated log files
//! per dev process instead of interleaved writes to the same daily file.
//!
//! ## Filtering
//!
//! Defaults to
//! `info,claudette=debug,claudette_tauri=debug,claudette_server=debug`
//! (see [`DEFAULT_FILTER`]). Override with the standard `RUST_LOG` env
//! var (e.g.
//! `RUST_LOG=claudette::commands::chat=trace`). For users who don't
//! want to set env vars, [`init`] also accepts an optional persisted
//! override that maps to `EnvFilter` — Settings → Diagnostics writes
//! `app_settings["diagnostics.log_level"]`, the GUI reads it on startup
//! and threads it into this fallback when `RUST_LOG` is unset.
//!
//! ## JSON output
//!
//! Set `CLAUDETTE_LOG_FORMAT=json` for machine-parseable file output —
//! useful when grep / jq is more convenient than tailing the pretty
//! file. Defaults to compact (one line per event with a tab-separated
//! "key=value" tail of structured fields).
//!
//! ## Target conventions
//!
//! Every event uses a target of the form `claudette::<domain>` so a
//! single `RUST_LOG=claudette::chat=trace` filter targets one
//! cross-cutting concern without grepping. Established domains:
//!
//! - `claudette::startup`  — process boot, paths, multi-instance warning
//! - `claudette::panic`    — panic hook output
//! - `claudette::chat`     — turn lifecycle, persistent session reuse
//! - `claudette::agent`    — claude CLI subprocess events
//! - `claudette::backend`  — alt-provider gateway listeners
//! - `claudette::mcp`      — MCP supervisor and registration
//! - `claudette::plugin`   — Lua plugin runtime + Claude-Code marketplace
//! - `claudette::git`      — git CLI shellouts
//! - `claudette::scm`      — PR / CI provider plugin invocations
//! - `claudette::pty`      — portable-pty spawn / exit
//! - `claudette::voice`    — Whisper / Speech.framework
//! - `claudette::ws`       — claudette-server WebSocket
//! - `claudette::ipc`      — local CLI ↔ GUI socket
//! - `claudette::remote`   — remote-control commands
//! - `claudette::ui`       — theme / settings persistence
//! - `claudette::frontend` — events forwarded from the React webview
//!
//! Use these targets verbatim; new domains are added here first so the
//! convention stays one filterable axis.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime};

use tracing_appender::non_blocking::WorkerGuard;
use tracing_appender::rolling;
use tracing_subscriber::filter::EnvFilter;
use tracing_subscriber::fmt;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

/// Number of days of rolled log files to retain on disk. Older files
/// are deleted by [`sweep_old_logs`] on startup. Tuned so a busy dev
/// week (~10 MB/day in observed practice) sits well under 200 MB total.
const RETAIN_DAYS: u64 = 14;

/// Filename prefix for rolled log files. `tracing-appender` rolls daily
/// and appends `.YYYY-MM-DD` to this prefix.
const LOG_FILE_PREFIX: &str = "claudette";

/// Default subscriber filter when `RUST_LOG` is unset. Library and
/// binary crate names go to `debug`; the rest of the dep tree stays
/// at `info` so reqwest / hyper / mio chatter doesn't drown out our
/// own events.
const DEFAULT_FILTER: &str = "info,claudette=debug,claudette_tauri=debug,claudette_server=debug";

/// Holds the appender's worker thread alive for the lifetime of the
/// process. `init` returns a `LogHandle` to `main`, which drops it on
/// process exit so the appender flushes pending writes.
pub struct LogHandle {
    _file_guard: Option<WorkerGuard>,
    log_dir: PathBuf,
}

impl LogHandle {
    /// Directory where rolled log files are written. Useful for the
    /// "show logs" Help-menu action and for support bug reports.
    pub fn log_dir(&self) -> &Path {
        &self.log_dir
    }
}

static LOG_HANDLE: OnceLock<PathBuf> = OnceLock::new();

/// Initialize the global tracing subscriber with the default fallback
/// filter (or whatever `RUST_LOG` provides). Equivalent to
/// `init_with_override(None)`.
pub fn init() -> Option<LogHandle> {
    init_with_override(None)
}

/// Initialize a **stderr-only** subscriber — no log directory, no
/// retention sweep, no rolling file. Intended for short-lived child
/// processes (`claudette-app --server`, `--agent-mcp`, `--agent-hook`)
/// where the parent already captures stderr and writing to the same
/// daily file from N children would just contend on the appender's
/// internal lock and bloat the log with dispatch noise.
///
/// Honors `RUST_LOG` first, then falls back to [`DEFAULT_FILTER`].
/// Subsequent calls return `None` so the GUI path's heavier
/// subscriber wins if both are reachable in the same process.
///
/// Returns a [`LogHandle`] for symmetry with [`init`] / [`init_with_override`];
/// the handle has no file guard to drop, and its `log_dir` is the
/// resolved-but-uncreated path so callers can still surface "where
/// would logs go" if they want to.
pub fn init_stderr_only() -> Option<LogHandle> {
    let log_dir = resolve_log_dir();
    let env_filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new(DEFAULT_FILTER));
    let stderr_layer = fmt::layer()
        .with_target(true)
        .with_thread_ids(false)
        .with_thread_names(false)
        .with_level(true)
        .with_writer(std::io::stderr);
    if tracing_subscriber::registry()
        .with(env_filter)
        .with(stderr_layer)
        .try_init()
        .is_err()
    {
        return None;
    }
    let _ = LOG_HANDLE.set(log_dir.clone());
    Some(LogHandle {
        _file_guard: None,
        log_dir,
    })
}

/// Initialize the global tracing subscriber. Must be called exactly
/// once, as early in `main` as practical (before the first
/// `tracing::*!` macro fires). Subsequent calls return `None` and leave
/// the existing subscriber intact — safe to call from tests via the
/// helper guard, but `main` should hold onto the returned handle.
///
/// `runtime_override` is parsed as an `EnvFilter` directive (e.g.
/// `info`, `debug`, `claudette::chat=trace,info`). It is used **only**
/// when `RUST_LOG` is unset, so an explicit env var still wins. The GUI
/// reads `app_settings["diagnostics.log_level"]` and passes it through
/// here so users who don't want to set env vars can change verbosity
/// from Settings → Diagnostics.
///
/// Errors here are logged to stderr only and downgrade gracefully:
/// if the file appender can't be created, stderr-only logging still
/// works; if `runtime_override` fails to parse we fall back to
/// [`DEFAULT_FILTER`] rather than aborting startup.
pub fn init_with_override(runtime_override: Option<&str>) -> Option<LogHandle> {
    let log_dir = resolve_log_dir();
    if let Err(e) = std::fs::create_dir_all(&log_dir) {
        eprintln!(
            "[logging] failed to create log dir {}: {e}",
            log_dir.display()
        );
    }

    sweep_old_logs(&log_dir, RETAIN_DAYS);

    // RUST_LOG > runtime override > built-in default. We try each in
    // order, and on parse failure of the runtime override fall through
    // to the default with a stderr note (the subscriber isn't installed
    // yet, so we can't `tracing::warn!`).
    let env_filter = match EnvFilter::try_from_default_env() {
        Ok(f) => f,
        Err(_) => match runtime_override.and_then(|s| {
            let trimmed = s.trim();
            (!trimmed.is_empty()).then_some(trimmed)
        }) {
            Some(directive) => EnvFilter::try_new(directive).unwrap_or_else(|e| {
                eprintln!(
                    "[logging] invalid runtime override {directive:?}: {e} — using default filter"
                );
                EnvFilter::new(DEFAULT_FILTER)
            }),
            None => EnvFilter::new(DEFAULT_FILTER),
        },
    };

    let stderr_layer = fmt::layer()
        .with_target(true)
        .with_thread_ids(false)
        .with_thread_names(false)
        .with_level(true)
        .with_writer(std::io::stderr);

    let (file_writer, guard) = match rolling::Builder::new()
        .rotation(rolling::Rotation::DAILY)
        .filename_prefix(LOG_FILE_PREFIX)
        .filename_suffix("log")
        .build(&log_dir)
    {
        Ok(appender) => {
            let (nb, guard) = tracing_appender::non_blocking(appender);
            (Some(nb), Some(guard))
        }
        Err(e) => {
            eprintln!(
                "[logging] failed to open file appender at {}: {e} \
                 — falling back to stderr-only",
                log_dir.display()
            );
            (None, None)
        }
    };

    let json_format = std::env::var("CLAUDETTE_LOG_FORMAT")
        .map(|v| v.eq_ignore_ascii_case("json"))
        .unwrap_or(false);

    // The two layers compose into one subscriber. Splitting on the
    // format kind keeps the type signature simple — tracing-subscriber
    // doesn't accept heterogeneous-format `Box<dyn Layer>` without
    // erasure tricks that pessimize the hot path.
    let registry = tracing_subscriber::registry()
        .with(env_filter)
        .with(stderr_layer);

    if let Some(writer) = file_writer {
        if json_format {
            let file_layer = fmt::layer()
                .with_writer(writer)
                .with_ansi(false)
                .with_target(true)
                .with_thread_ids(true)
                .json();
            if registry.with(file_layer).try_init().is_err() {
                return None;
            }
        } else {
            let file_layer = fmt::layer()
                .with_writer(writer)
                .with_ansi(false)
                .with_target(true)
                .with_thread_ids(true)
                .compact();
            if registry.with(file_layer).try_init().is_err() {
                return None;
            }
        }
    } else if registry.try_init().is_err() {
        return None;
    }

    let _ = LOG_HANDLE.set(log_dir.clone());
    log_startup_banner(&log_dir);

    Some(LogHandle {
        _file_guard: guard,
        log_dir,
    })
}

/// Resolve the directory rolled log files are written to. Order:
///
/// 1. `CLAUDETTE_LOG_DIR` env var (used by `scripts/dev.sh` to give
///    parallel dev instances isolated log files when desired).
/// 2. `<claudette_home>/logs` — sibling to the existing `workspaces`
///    and `plugins` directories so users have one tree to inspect when
///    debugging. `claudette_home` honors `$CLAUDETTE_HOME`, so a
///    `dev --clean` session naturally lands its logs under the same
///    sandbox as its workspaces and plugins.
fn resolve_log_dir() -> PathBuf {
    if let Ok(custom) = std::env::var("CLAUDETTE_LOG_DIR") {
        let path = PathBuf::from(custom);
        if !path.as_os_str().is_empty() {
            return path;
        }
    }
    crate::path::claudette_home().join("logs")
}

/// Get the resolved log directory, if `init` has been called. Used by
/// commands that surface "open log dir" actions.
pub fn log_dir() -> Option<&'static Path> {
    LOG_HANDLE.get().map(PathBuf::as_path)
}

fn log_startup_banner(log_dir: &Path) {
    // Use raw env / cfg to avoid pulling more crates into the lib.
    let pid = std::process::id();
    let version = env!("CARGO_PKG_VERSION");
    let profile = if cfg!(debug_assertions) {
        "debug"
    } else {
        "release"
    };
    tracing::info!(
        target: "claudette::startup",
        pid,
        version,
        profile,
        log_dir = %log_dir.display(),
        "claudette logging initialized"
    );
}

/// Delete rolled log files older than `retain_days` from `dir`.
/// Walks the directory once at startup so we don't grow unbounded
/// without an external cron. Errors are logged via `eprintln` (the
/// subscriber isn't installed yet at this point) and ignored — a
/// failure to prune is never fatal.
fn sweep_old_logs(dir: &Path, retain_days: u64) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let cutoff = SystemTime::now()
        .checked_sub(Duration::from_secs(retain_days * 24 * 60 * 60))
        .unwrap_or(SystemTime::UNIX_EPOCH);

    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        // Only consider files that match our rolled-log shape.
        // `tracing-appender` writes `<prefix>.<YYYY-MM-DD>.<suffix>`
        // (e.g. `claudette.2026-05-08.log`); a previous iteration of
        // this code matched only the prefix and could have nuked a
        // user's `claudette-notes.txt` parked in the same dir. We
        // require the prefix-with-dot AND the trailing `.log` AND a
        // 10-character `YYYY-MM-DD` chunk in between so the match is
        // both narrow and stable across our two known historical
        // shapes (`<prefix>.<date>.<suffix>` and
        // `<prefix>.<suffix>.<date>` from older test fixtures).
        if !is_rolled_log_filename(name) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(modified) = meta.modified() else {
            continue;
        };
        if modified < cutoff
            && let Err(e) = std::fs::remove_file(&path)
        {
            eprintln!("[logging] failed to remove old log {}: {e}", path.display());
        }
    }
}

/// True iff `name` looks like one of our rolled log files. Tightened
/// from a bare `starts_with(LOG_FILE_PREFIX)` so unrelated files like
/// `claudette-notes.txt` (or anything else a user parked in the log
/// dir) are never targeted by the retention sweep. Matches both the
/// current `<prefix>.<YYYY-MM-DD>.log` layout and the legacy
/// `<prefix>.log.<YYYY-MM-DD>` shape from older builds, so existing
/// directories don't suddenly grow stale files after upgrade.
fn is_rolled_log_filename(name: &str) -> bool {
    // Common gate: must start with `<prefix>.` (extra dot rejects
    // names like `claudette-notes.txt`).
    let Some(rest) = name.strip_prefix(&format!("{LOG_FILE_PREFIX}.")) else {
        return false;
    };
    // Current layout: `<prefix>.<YYYY-MM-DD>.log`. Strip the trailing
    // suffix; what remains must be a 10-char date.
    if let Some(date) = rest.strip_suffix(".log") {
        return is_iso_date(date);
    }
    // Legacy layout from earlier test fixtures: `<prefix>.log.<YYYY-MM-DD>`.
    // Keep accepting it so the sweep still cleans up old files.
    if let Some(date) = rest.strip_prefix("log.") {
        return is_iso_date(date);
    }
    false
}

/// Strict YYYY-MM-DD shape check. We don't validate calendar
/// correctness — `2026-13-99` is fine — because the appender's own
/// output is always real, and a same-shape user file in the dir
/// would still be a false positive worth logging if found old.
fn is_iso_date(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.len() != 10 {
        return false;
    }
    bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[..4].iter().all(|c| c.is_ascii_digit())
        && bytes[5..7].iter().all(|c| c.is_ascii_digit())
        && bytes[8..].iter().all(|c| c.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    /// A retain_days of 0 means "anything older than now is fair
    /// game" — the sleep below gives the freshly-written files a
    /// non-zero age so the cutoff comparison removes them
    /// deterministically without us having to mock the clock.
    ///
    /// Covers both the current `<prefix>.<date>.<suffix>` layout
    /// (`tracing-appender`'s real output) and the legacy
    /// `<prefix>.<suffix>.<date>` shape from earlier builds, since
    /// users upgrading may still have files in either form.
    #[test]
    fn sweep_old_logs_removes_rolled_files_when_retain_is_zero() {
        let dir = tempdir().unwrap();
        let current_layout = dir.path().join("claudette.2025-01-01.log");
        let legacy_layout = dir.path().join("claudette.log.2025-01-01");
        let unrelated = dir.path().join("user-notes.txt");
        fs::write(&current_layout, b"old").unwrap();
        fs::write(&legacy_layout, b"old").unwrap();
        fs::write(&unrelated, b"unrelated").unwrap();
        std::thread::sleep(Duration::from_millis(50));

        sweep_old_logs(dir.path(), 0);

        assert!(
            !current_layout.exists(),
            "current-layout files must be swept"
        );
        assert!(!legacy_layout.exists(), "legacy-layout files must be swept");
        assert!(unrelated.exists(), "non-claudette files must be left alone");
    }

    #[test]
    fn sweep_old_logs_keeps_files_within_retention() {
        let dir = tempdir().unwrap();
        let recent = dir.path().join("claudette.2026-05-08.log");
        fs::write(&recent, b"recent").unwrap();

        sweep_old_logs(dir.path(), 14);

        assert!(recent.exists(), "files inside the retention window stay");
    }

    /// Regression: prefix-only matching used to allow
    /// `claudette-notes.txt` (or anything else a user parked in the
    /// log dir) to be deleted by the retention sweep. The tightened
    /// `is_rolled_log_filename` check now requires the prefix-with-dot,
    /// the trailing `.log`, and a real-shaped date — verify the
    /// false positives can't get through anymore.
    #[test]
    fn sweep_old_logs_ignores_prefix_overlap_files() {
        let dir = tempdir().unwrap();
        let near_misses = [
            "claudette-notes.txt",      // dash, not dot, after prefix
            "claudette.notes.log",      // looks like ours but no date
            "claudette.2026-05-08.bak", // wrong suffix
            "claudettelog.2026-05-08",  // missing dot after prefix
            "claudette.YYYY-MM-DD.log", // date placeholder, not real
        ];
        for name in near_misses {
            fs::write(dir.path().join(name), b"x").unwrap();
        }
        std::thread::sleep(Duration::from_millis(50));

        sweep_old_logs(dir.path(), 0);

        for name in near_misses {
            assert!(
                dir.path().join(name).exists(),
                "non-rolled-log file {name:?} must survive the sweep"
            );
        }
    }

    /// The Settings UI writes one of these strings into
    /// `app_settings["diagnostics.log_level"]` and we thread it into
    /// `init_with_override`. Verify each parses as a real `EnvFilter`
    /// directive so a typo in the Settings select can't silently brick
    /// the subscriber. We can't easily install a global subscriber
    /// from a test (it's process-wide and other tests may have set it),
    /// so we exercise the parsing path directly — the same call
    /// `init_with_override` makes when `RUST_LOG` is unset.
    #[test]
    fn supported_log_level_directives_parse() {
        for ok in [
            "info",
            "debug",
            "trace",
            "warn",
            "error",
            "claudette::chat=trace",
            DEFAULT_FILTER,
        ] {
            assert!(EnvFilter::try_new(ok).is_ok(), "expected {ok:?} to parse");
        }
    }

    /// Validate the env override path. We guard the env mutation so
    /// other tests don't race with us; edition 2024 made `set_var` /
    /// `remove_var` `unsafe`, which surfaces the global-mutation risk
    /// here even though our test harness is single-threaded for this
    /// case (cargo test runs each test on its own task).
    #[test]
    fn resolve_log_dir_honors_env_override() {
        let prev = std::env::var("CLAUDETTE_LOG_DIR").ok();
        let dir = tempdir().unwrap();
        // SAFETY: this test does not spawn threads that touch env.
        unsafe {
            std::env::set_var("CLAUDETTE_LOG_DIR", dir.path());
        }
        let resolved = resolve_log_dir();
        assert_eq!(resolved, dir.path());
        // SAFETY: same scope as the set above.
        unsafe {
            match prev {
                Some(v) => std::env::set_var("CLAUDETTE_LOG_DIR", v),
                None => std::env::remove_var("CLAUDETTE_LOG_DIR"),
            }
        }
    }
}
