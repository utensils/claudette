use std::path::{Path, PathBuf};

use super::clipboard::{copy_file_path_to_clipboard, copy_image_bytes_to_clipboard};

/// Write raw bytes to a filesystem path chosen by the user via a save dialog.
///
/// The frontend opens the OS save dialog itself (via `@tauri-apps/plugin-dialog`)
/// and passes the resulting absolute path plus the attachment bytes here. We
/// reject relative paths defensively — the dialog only ever yields absolute
/// paths, but accepting relatives would let callers write into the CWD of the
/// running app, which is rarely what the user expects.
pub fn write_bytes_to_absolute_path(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if !path.is_absolute() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "path must be absolute",
        ));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, bytes)
}

#[tauri::command]
pub async fn save_attachment_bytes(path: String, bytes: Vec<u8>) -> Result<(), String> {
    let target = PathBuf::from(&path);
    tokio::task::spawn_blocking(move || write_bytes_to_absolute_path(&target, &bytes))
        .await
        .map_err(|e| format!("join error: {e}"))?
        .map_err(|e| format!("failed to save to {path}: {e}"))
}

/// Write attachment bytes to a temp HTML wrapper and open it with the system
/// default handler (typically the user's browser).
///
/// Wrapping in HTML is deliberate: `open path.png` routes to the default image
/// viewer (e.g. Preview on macOS), but `open path.html` routes to the browser
/// on every platform we support. That matches the user's expectation of
/// "Open in New Window" — a web page containing the image.
pub fn write_image_as_html(
    dir: &Path,
    filename_stem: &str,
    media_type: &str,
    bytes: &[u8],
) -> std::io::Result<PathBuf> {
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    let safe_stem = sanitize_stem(filename_stem);
    let title = html_escape(filename_stem);
    let safe_media = html_escape(media_type);
    // Include a unique suffix so opening the same attachment twice (or two
    // differently-chatted files that share a filename stem) doesn't clobber
    // the previous wrapper while it's still open in the user's browser.
    let unique: u128 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let html = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>{title}</title>\
         <style>body{{margin:0;background:#111;display:flex;align-items:center;justify-content:center;min-height:100vh}}\
         img{{max-width:100vw;max-height:100vh}}</style>\
         <img src=\"data:{safe_media};base64,{b64}\" alt=\"{title}\">"
    );
    let path = dir.join(format!("{safe_stem}-{unique}.html"));
    std::fs::write(&path, html)?;
    Ok(path)
}

pub(super) fn sanitize_stem(s: &str) -> String {
    let stem: String = s
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if stem.is_empty() {
        "attachment".to_string()
    } else {
        stem
    }
}

pub(super) fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

#[tauri::command]
pub async fn open_attachment_in_browser(
    bytes: Vec<u8>,
    filename: String,
    media_type: String,
) -> Result<(), String> {
    let dir = std::env::temp_dir().join("claudette-attachments");
    tokio::task::spawn_blocking(move || -> Result<PathBuf, String> {
        std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir temp dir: {e}"))?;
        let stem = Path::new(&filename)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("attachment");
        write_image_as_html(&dir, stem, &media_type, &bytes).map_err(|e| format!("write html: {e}"))
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
    .and_then(|path| {
        crate::commands::shell::opener::open(&path.to_string_lossy())
            .map_err(|e| format!("open failed: {e}"))
    })
}

/// Pick a sensible file extension for a media type. Used when staging an
/// attachment to a temp file so the OS routes the open-with handler to the
/// right app (e.g. `.pdf` → Preview / Adobe / etc).
///
/// Common types that have a canonical extension different from their MIME
/// subtype (`text/plain` → `txt`, `image/jpeg` → `jpg`, `+json` types → `json`)
/// get an explicit mapping. Everything else falls back to the subtype with
/// any `+xml` / `+json` suffix stripped.
///
/// Returns a `Cow<'static, str>` so the explicit-map cases (the common
/// path) cost nothing, while the catch-all case yields an owned `String`
/// without leaking memory across sessions.
pub(super) fn extension_for_media_type(media_type: &str) -> std::borrow::Cow<'static, str> {
    use std::borrow::Cow;
    match media_type {
        "text/plain" => return Cow::Borrowed("txt"),
        "text/html" => return Cow::Borrowed("html"),
        "text/css" => return Cow::Borrowed("css"),
        "text/javascript" | "application/javascript" => return Cow::Borrowed("js"),
        "image/jpeg" => return Cow::Borrowed("jpg"),
        "image/svg+xml" => return Cow::Borrowed("svg"),
        "application/pdf" => return Cow::Borrowed("pdf"),
        "application/json" => return Cow::Borrowed("json"),
        "application/zip" => return Cow::Borrowed("zip"),
        _ => {}
    }
    // `+json` suffixed types (application/ld+json, application/vnd.api+json…)
    // route to the json viewer naturally.
    if media_type.ends_with("+json") {
        return Cow::Borrowed("json");
    }
    if media_type.ends_with("+xml") {
        return Cow::Borrowed("xml");
    }
    // Last-resort fallback: trust the subtype iff it looks safe.
    let after_slash = media_type.rsplit_once('/').map(|p| p.1).unwrap_or("");
    if !after_slash.is_empty()
        && after_slash
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
    {
        Cow::Owned(after_slash.to_string())
    } else {
        Cow::Borrowed("bin")
    }
}

/// Write attachment bytes to a temp file using the natural file extension
/// for the media type. Unlike [`write_image_as_html`], this writes the raw
/// bytes (no wrapper) so `open` routes to the system default handler for
/// the format — Preview / Adobe Reader for PDFs, etc.
///
/// On Unix the file is created with `0o600` (owner read/write only) so
/// other local accounts can't peek at potentially sensitive content
/// stashed under the shared temp dir.
pub fn write_attachment_to_temp_file(
    dir: &Path,
    filename: &str,
    media_type: &str,
    bytes: &[u8],
) -> std::io::Result<PathBuf> {
    let stem = Path::new(filename)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("attachment");
    let safe_stem = sanitize_stem(stem);
    let ext = extension_for_media_type(media_type);
    // Unique nanosecond suffix so re-opening the same attachment twice
    // doesn't overwrite a staged file that the system viewer may still
    // be holding open.
    let unique: u128 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path = dir.join(format!("{safe_stem}-{unique}.{ext}"));
    write_owner_only(&path, bytes)?;
    Ok(path)
}

/// Write `bytes` to `path`, creating the file with restrictive permissions
/// on Unix (`0o600`). On Windows ACLs handle this differently — a regular
/// `fs::write` is fine.
pub(super) fn write_owner_only(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write as _;
        use std::os::unix::fs::OpenOptionsExt as _;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        f.write_all(bytes)?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, bytes)
    }
}

/// Create the staging directory with restrictive permissions on Unix
/// (`0o700`) so other accounts can't list or read the staged files.
///
/// Uses a try-then-verify approach instead of `exists()` + `create()` to
/// avoid a TOCTOU window where a concurrent caller or attacker could
/// replace the directory between the check and the create.
pub(super) fn create_staging_dir(dir: &Path) -> std::io::Result<()> {
    let create_result = {
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt as _;
            std::fs::DirBuilder::new().mode(0o700).create(dir)
        }
        #[cfg(not(unix))]
        {
            std::fs::create_dir(dir)
        }
    };
    match create_result {
        Ok(()) => return Ok(()),
        Err(e) if e.kind() != std::io::ErrorKind::AlreadyExists => return Err(e),
        Err(_) => {}
    }
    // Directory already existed — verify it is a real directory (not a
    // file or symlink that could redirect writes elsewhere) and re-tighten
    // the permissions on Unix in case a previous run used a wider umask.
    // `symlink_metadata` does not follow symlinks, so a malicious symlink
    // to /etc cannot satisfy the is_dir() check.
    let meta = std::fs::symlink_metadata(dir)?;
    if !meta.file_type().is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            format!(
                "staging path {} exists and is not a directory",
                dir.display()
            ),
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = meta.permissions().mode() & 0o777;
        if mode != 0o700 {
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        }
    }
    Ok(())
}

/// Remove staged attachments older than `max_age` from `dir`. Used to keep
/// the temp staging directory from growing unboundedly across sessions —
/// PDFs in particular can be 10+ MB each. Errors during cleanup are
/// swallowed: a stale file that we couldn't delete this run will be tried
/// again on the next open.
pub fn cleanup_stale_attachments(dir: &Path, max_age: std::time::Duration) {
    cleanup_stale_attachments_at(dir, max_age, std::time::SystemTime::now());
}

/// Testable variant of [`cleanup_stale_attachments`] — `now` is injected
/// so the test doesn't need to manipulate file mtimes.
pub(super) fn cleanup_stale_attachments_at(
    dir: &Path,
    max_age: std::time::Duration,
    now: std::time::SystemTime,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let Ok(modified) = meta.modified() else {
            continue;
        };
        let Ok(age) = now.duration_since(modified) else {
            continue;
        };
        if age >= max_age {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Open an attachment with the system's default handler for its media
/// type (e.g. PDF → Preview on macOS, the user's PDF reader on Linux /
/// Windows). Bytes are staged to a temp file under the OS temp dir with
/// owner-only permissions; stale stages older than 24 h are reaped on
/// each open so the directory doesn't grow without bound.
#[tauri::command]
pub async fn open_attachment_with_default_app(
    bytes: Vec<u8>,
    filename: String,
    media_type: String,
) -> Result<(), String> {
    let dir = std::env::temp_dir().join("claudette-attachments");
    tokio::task::spawn_blocking(move || -> Result<PathBuf, String> {
        create_staging_dir(&dir).map_err(|e| format!("mkdir temp dir: {e}"))?;
        // Reap files older than a day — keeps the directory bounded
        // without yanking the rug out from under an app the user may
        // still have open. Cleanup errors are non-fatal.
        cleanup_stale_attachments(&dir, std::time::Duration::from_secs(24 * 60 * 60));
        write_attachment_to_temp_file(&dir, &filename, &media_type, &bytes)
            .map_err(|e| format!("write attachment: {e}"))
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
    .and_then(|path| {
        crate::commands::shell::opener::open(&path.to_string_lossy())
            .map_err(|e| format!("open failed: {e}"))
    })
}

/// Stage an attachment to a temp file and put that file on the system
/// clipboard. Used for document-like attachments such as PDFs where the
/// browser ClipboardItem API either rejects the MIME type or reports success
/// without producing a useful paste target.
#[tauri::command]
pub async fn copy_attachment_file_to_clipboard(
    bytes: Vec<u8>,
    filename: String,
    media_type: String,
) -> Result<(), String> {
    let dir = std::env::temp_dir().join("claudette-attachments");
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        create_staging_dir(&dir).map_err(|e| format!("mkdir temp dir: {e}"))?;
        cleanup_stale_attachments(&dir, std::time::Duration::from_secs(24 * 60 * 60));
        let path = write_attachment_to_temp_file(&dir, &filename, &media_type, &bytes)
            .map_err(|e| format!("write attachment: {e}"))?;
        copy_file_path_to_clipboard(&path)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}

/// Copy raster image bytes to the system clipboard as image data. Bypasses
/// the W3C ClipboardItem API, which WKWebView rejects after async IPC
/// boundaries invalidate the user-activation gate.
#[tauri::command]
pub async fn copy_image_to_clipboard(
    bytes: Vec<u8>,
    filename: String,
    media_type: String,
) -> Result<(), String> {
    if !media_type.starts_with("image/") || media_type == "image/svg+xml" {
        return Err(format!(
            "copy_image_to_clipboard: expected a raster image media type, got {media_type:?}"
        ));
    }
    let dir = std::env::temp_dir().join("claudette-attachments");
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        create_staging_dir(&dir).map_err(|e| format!("mkdir temp dir: {e}"))?;
        cleanup_stale_attachments(&dir, std::time::Duration::from_secs(24 * 60 * 60));
        copy_image_bytes_to_clipboard(&dir, &bytes, &filename, &media_type)
    })
    .await
    .map_err(|e| format!("join error: {e}"))?
}
