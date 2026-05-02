use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;
use tokio::process::Command;

use claudette::db::Database;
use claudette::file_expand;

use crate::state::AppState;
use claudette::process::CommandWindowExt as _;

/// Hard cap on the number of *files* returned by
/// [`list_workspace_files`]. Ancestor directory entries are derived from
/// whichever files survive the cap, so the merged listing is bounded by
/// roughly `2 × MAX_ENTRIES` in the worst case (every file in its own
/// unique subtree). Bounds IPC payload size and gives the Files browser
/// a known upper bound. When hit, the frontend surfaces a "results
/// truncated" banner so the user knows some files are not listed.
const MAX_ENTRIES: usize = 10_000;

#[derive(Clone, Serialize)]
pub struct FileEntry {
    pub path: String,
    pub is_directory: bool,
}

#[derive(Clone, Serialize)]
pub struct FileListing {
    pub entries: Vec<FileEntry>,
    /// True when the worktree contained more files than `MAX_ENTRIES`
    /// and the file list was truncated. Drives the truncation banner in
    /// the Files browser.
    pub truncated: bool,
}

#[derive(Clone, Serialize)]
pub struct FileContent {
    pub path: String,
    pub content: Option<String>,
    pub is_binary: bool,
    pub size_bytes: u64,
    pub truncated: bool,
}

#[derive(Clone, Serialize)]
pub struct FileBytesContent {
    pub path: String,
    /// Base64-encoded bytes. Used for image rendering in the file viewer
    /// where we want to embed the bytes as a data URL on the frontend.
    pub bytes_b64: String,
    pub size_bytes: u64,
    pub truncated: bool,
}

/// Hard cap for raw-bytes reads (e.g. image previews). Larger than the
/// editor cap because image files frequently exceed 5 MB but we still
/// want to bound memory pressure on a single open.
const MAX_VIEWER_BYTES_READ: usize = 25 * 1024 * 1024;

/// Hard cap for the file viewer's text reads. Beyond this we refuse to
/// open the file for editing — the user would have to use a different
/// editor for files this size, and Monaco/CodeMirror struggle past this
/// point too.
const MAX_VIEWER_FILE_SIZE: usize = 10 * 1024 * 1024;

/// List files in a workspace's worktree using `git ls-files`.
///
/// Returns tracked files plus untracked-but-not-ignored files, capped at 10,000
/// entries. Paths are relative to the worktree root.
#[tauri::command]
pub async fn list_workspace_files(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<FileListing, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let workspaces = db.list_workspaces().map_err(|e| e.to_string())?;
    let ws = workspaces
        .iter()
        .find(|w| w.id == workspace_id)
        .ok_or("Workspace not found")?;
    let worktree_path = ws
        .worktree_path
        .as_ref()
        .ok_or("Workspace has no worktree")?;

    let output = Command::new(claudette::git::resolve_git_path_blocking())
        .no_console_window()
        .args(["-C", worktree_path])
        .args(["ls-files", "--cached", "--others", "--exclude-standard"])
        .output()
        .await
        .map_err(|e| format!("Failed to run git ls-files: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git ls-files failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(cap_merged_entries(&stdout, MAX_ENTRIES))
}

/// Build a [`FileListing`] from the raw stdout of `git ls-files`.
///
/// Each non-empty line is a tracked-or-untracked file path. Files are
/// capped at `max`; ancestor directories are derived from whichever files
/// survive the cap (git doesn't track empty directories anyway). The
/// returned listing has directories first (alphabetical) followed by
/// files (in git's order). `truncated` is true when stdout had more
/// non-empty lines than `max`.
///
/// Bug history: the pre-#583 implementation applied the cap to files
/// inside a `.map().take(MAX)` chain, then prepended *all* derived
/// directory entries afterwards — so the returned vector exceeded the
/// cap by the number of dirs, and the caller had no way to know
/// truncation happened. This helper centralizes the order (cap files,
/// derive dirs from capped files, surface a truncated flag) so the
/// invariant is enforced in one place and unit-testable.
///
/// Why we cap files (not the merged total): on a deeply-nested monorepo
/// the directory enumeration alone can exceed 10k, so a "merged" cap
/// would prefer dirs over files and yield an empty tree. With the file
/// cap, the user always sees real files; derived dirs come along
/// bounded by the file count and remain useful for navigation.
fn cap_merged_entries(stdout: &str, max: usize) -> FileListing {
    // Count non-empty lines once so we can set `truncated` honestly even
    // after we short-circuit the file iteration with `.take(max)`.
    let total_files = stdout.lines().filter(|line| !line.is_empty()).count();
    let truncated = total_files > max;

    let mut dirs = std::collections::BTreeSet::new();
    let file_entries: Vec<FileEntry> = stdout
        .lines()
        .filter(|line| !line.is_empty())
        .take(max)
        .map(|line| {
            // Extract all parent directories from the file path.
            let mut pos = 0;
            while let Some(slash) = line[pos..].find('/') {
                let dir_end = pos + slash;
                dirs.insert(line[..=dir_end].to_string());
                pos = dir_end + 1;
            }
            FileEntry {
                path: line.to_string(),
                is_directory: false,
            }
        })
        .collect();

    let dir_entries: Vec<FileEntry> = dirs
        .into_iter()
        .map(|path| FileEntry {
            path,
            is_directory: true,
        })
        .collect();

    let mut entries: Vec<FileEntry> = Vec::with_capacity(dir_entries.len() + file_entries.len());
    entries.extend(dir_entries);
    entries.extend(file_entries);

    FileListing { entries, truncated }
}

/// Read a file from a workspace's worktree.
///
/// Delegates to the shared `read_worktree_file` helper for path-traversal
/// protection, binary detection, and 100 KB truncation.
#[tauri::command]
pub async fn read_workspace_file(
    workspace_id: String,
    relative_path: String,
    state: State<'_, AppState>,
) -> Result<FileContent, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let workspaces = db.list_workspaces().map_err(|e| e.to_string())?;
    let ws = workspaces
        .iter()
        .find(|w| w.id == workspace_id)
        .ok_or("Workspace not found")?;
    let worktree_path = ws
        .worktree_path
        .as_ref()
        .ok_or("Workspace has no worktree")?;

    let read = file_expand::read_worktree_file(std::path::Path::new(worktree_path), &relative_path)
        .await
        .ok_or("File not found or path escapes worktree")?;

    Ok(FileContent {
        path: relative_path,
        content: read.content,
        is_binary: read.is_binary,
        size_bytes: read.size_bytes,
        truncated: read.truncated,
    })
}

/// Read a file from a workspace's worktree with the file-viewer/editor
/// truncation cap (10 MB) instead of the default 100 KB. Used by the
/// All-Files file viewer where the user has explicitly asked to open the
/// file. Binary detection still applies — binaries return
/// `content: None, is_binary: true`.
#[tauri::command]
pub async fn read_workspace_file_for_viewer(
    workspace_id: String,
    relative_path: String,
    state: State<'_, AppState>,
) -> Result<FileContent, String> {
    let worktree_path = resolve_worktree_path(&workspace_id, &state)?;

    let read = file_expand::read_worktree_file_with_limit(
        std::path::Path::new(&worktree_path),
        &relative_path,
        MAX_VIEWER_FILE_SIZE,
    )
    .await
    .ok_or("File not found or path escapes worktree")?;

    Ok(FileContent {
        path: relative_path,
        content: read.content,
        is_binary: read.is_binary,
        size_bytes: read.size_bytes,
        truncated: read.truncated,
    })
}

/// Read raw bytes from a file in a workspace's worktree, base64-encoded
/// for transport. Used by the file viewer to render image previews via a
/// data URL. The read is capped at `MAX_VIEWER_BYTES_READ` (25 MB) to
/// bound memory pressure.
#[tauri::command]
pub async fn read_workspace_file_bytes(
    workspace_id: String,
    relative_path: String,
    state: State<'_, AppState>,
) -> Result<FileBytesContent, String> {
    use base64::Engine as _;

    let worktree_path = resolve_worktree_path(&workspace_id, &state)?;

    let read = file_expand::read_worktree_file_bytes(
        std::path::Path::new(&worktree_path),
        &relative_path,
        MAX_VIEWER_BYTES_READ,
    )
    .await
    .ok_or("File not found or path escapes worktree")?;

    let bytes_b64 = base64::engine::general_purpose::STANDARD.encode(&read.bytes);
    Ok(FileBytesContent {
        path: relative_path,
        bytes_b64,
        size_bytes: read.size_bytes,
        truncated: read.truncated,
    })
}

/// Write UTF-8 text to a file in a workspace's worktree. Path-traversal
/// protected. Creates the file if missing; truncates if it exists.
///
/// Returns an error string on failure (path escapes, IO error). The
/// frontend surfaces these via the toast notification system.
#[tauri::command]
pub async fn write_workspace_file(
    workspace_id: String,
    relative_path: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let worktree_path = resolve_worktree_path(&workspace_id, &state)?;

    file_expand::write_worktree_file(
        std::path::Path::new(&worktree_path),
        &relative_path,
        &content,
    )
    .await
}

/// Resolve `workspace_id` to its worktree path, returning a string error
/// if the workspace is missing or has no worktree configured.
fn resolve_worktree_path(
    workspace_id: &str,
    state: &State<'_, AppState>,
) -> Result<String, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let workspaces = db.list_workspaces().map_err(|e| e.to_string())?;
    let ws = workspaces
        .iter()
        .find(|w| w.id == workspace_id)
        .ok_or("Workspace not found")?;
    ws.worktree_path
        .clone()
        .ok_or_else(|| "Workspace has no worktree".to_string())
}

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

fn sanitize_stem(s: &str) -> String {
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

fn html_escape(s: &str) -> String {
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
fn extension_for_media_type(media_type: &str) -> std::borrow::Cow<'static, str> {
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
fn write_owner_only(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
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
/// (`0o700`) so other accounts can't list or read the staged files. If
/// the path already exists we verify it's a real directory (not a file
/// or symlink that could redirect writes elsewhere) and re-tighten the
/// permissions on Unix in case a previous run created it with a wider
/// umask.
fn create_staging_dir(dir: &Path) -> std::io::Result<()> {
    if dir.exists() {
        // `symlink_metadata` doesn't follow symlinks — it tells us
        // whether the *path entry* is a directory, so a malicious link
        // to /etc can't satisfy the check.
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
        return Ok(());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt as _;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(dir)
    }
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
fn cleanup_stale_attachments_at(
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

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn cap_merged_entries_under_cap_is_not_truncated() {
        let stdout = "src/lib.rs\nsrc/main.rs\nREADME.md\n";
        let listing = cap_merged_entries(stdout, 100);
        assert!(!listing.truncated);
        // 1 dir ("src/") + 3 files = 4 entries.
        assert_eq!(listing.entries.len(), 4);
        // Dirs first, then files in stdout order.
        assert!(listing.entries[0].is_directory);
        assert_eq!(listing.entries[0].path, "src/");
        assert!(!listing.entries[1].is_directory);
        assert_eq!(listing.entries[1].path, "src/lib.rs");
    }

    #[test]
    fn cap_merged_entries_caps_files_then_derives_dirs() {
        // 16 files in 16 distinct dirs. Cap = 10. We expect the cap to
        // apply to *files* (10 kept), and dirs come along as ancestors of
        // those 10 files (10 dirs kept). Total entries = 20, but
        // truncated must still be true because we dropped 6 input files.
        let mut buf = String::new();
        for i in 0..16 {
            buf.push_str(&format!("d{i}/file{i}.txt\n"));
        }
        let listing = cap_merged_entries(&buf, 10);
        assert!(listing.truncated, "10 of 16 input files were dropped");
        let files_kept = listing.entries.iter().filter(|e| !e.is_directory).count();
        assert_eq!(files_kept, 10, "file count must be capped at 10");
        // Dirs are ancestors of the 10 surviving files — should not
        // exceed the file count for this fixture.
        let dirs_kept = listing.entries.iter().filter(|e| e.is_directory).count();
        assert_eq!(dirs_kept, 10);
    }

    #[test]
    fn cap_merged_entries_preserves_files_for_dir_heavy_repos() {
        // Regression for the nixpkgs UAT: a deeply-nested repo can have
        // a directory enumeration that, by itself, exceeds the cap. A
        // naive "merged total" cap would prefer dirs over files
        // (alphabetical order puts dirs first) and yield zero files —
        // an unusable Files panel. Verify files always survive the cap.
        let mut buf = String::new();
        for i in 0..3 {
            for j in 0..3 {
                for k in 0..3 {
                    // Each file at depth 3 contributes 3 ancestor dirs.
                    buf.push_str(&format!("a{i}/b{j}/c{k}/file.txt\n"));
                }
            }
        }
        // 27 files + 39 derived dirs = 66 total entries. Cap files at 5.
        let listing = cap_merged_entries(&buf, 5);
        assert!(listing.truncated);
        let files_kept = listing.entries.iter().filter(|e| !e.is_directory).count();
        assert_eq!(
            files_kept, 5,
            "files must always be present in the listing, not crowded out by dirs"
        );
    }

    #[test]
    fn cap_merged_entries_at_exact_cap_is_not_truncated() {
        let stdout = "src/a.rs\nsrc/b.rs\n";
        let listing = cap_merged_entries(stdout, 2);
        assert!(!listing.truncated);
        // 1 derived dir ("src/") + 2 files = 3 entries.
        assert_eq!(listing.entries.len(), 3);
    }

    #[test]
    fn cap_merged_entries_skips_blank_lines() {
        let listing = cap_merged_entries("\n\nfile.rs\n\n", 100);
        assert_eq!(listing.entries.len(), 1);
        assert!(!listing.entries[0].is_directory);
    }

    #[test]
    fn cap_merged_entries_extracts_all_parent_dirs() {
        let listing = cap_merged_entries("a/b/c/file.rs\n", 100);
        // 3 dirs (a/, a/b/, a/b/c/) + 1 file = 4 entries.
        let dirs: Vec<_> = listing
            .entries
            .iter()
            .filter(|e| e.is_directory)
            .map(|e| e.path.as_str())
            .collect();
        assert_eq!(dirs, vec!["a/", "a/b/", "a/b/c/"]);
    }

    #[test]
    fn write_bytes_to_absolute_path_creates_parent_dirs() {
        let dir = tempdir().unwrap();
        let nested = dir.path().join("sub").join("dir").join("out.bin");
        write_bytes_to_absolute_path(&nested, b"hello").unwrap();
        assert_eq!(std::fs::read(&nested).unwrap(), b"hello");
    }

    #[test]
    fn write_bytes_to_absolute_path_rejects_relative() {
        let err = write_bytes_to_absolute_path(Path::new("relative.bin"), b"x").unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput);
    }

    #[test]
    fn write_bytes_to_absolute_path_overwrites_existing() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("file.bin");
        write_bytes_to_absolute_path(&p, b"first").unwrap();
        write_bytes_to_absolute_path(&p, b"second").unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"second");
    }

    #[test]
    fn write_image_as_html_embeds_data_url() {
        let dir = tempdir().unwrap();
        let path =
            write_image_as_html(dir.path(), "cat photo.png", "image/png", b"\x89PNG").unwrap();
        assert_eq!(path.extension().unwrap(), "html");
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(
            content.contains("data:image/png;base64,iVBORw==")
                || content.contains("data:image/png;base64,")
        );
        assert!(content.contains("<title>cat photo.png</title>"));
    }

    #[test]
    fn write_image_as_html_escapes_hostile_media_type() {
        let dir = tempdir().unwrap();
        let path =
            write_image_as_html(dir.path(), "x", "image/png\" onload=\"alert(1)", b"\x89PNG")
                .unwrap();
        let content = std::fs::read_to_string(&path).unwrap();
        assert!(!content.contains("onload=\"alert(1)"));
        assert!(content.contains("&quot;"));
    }

    #[test]
    fn write_image_as_html_uses_unique_suffix() {
        let dir = tempdir().unwrap();
        let p1 = write_image_as_html(dir.path(), "x", "image/png", b"a").unwrap();
        std::thread::sleep(std::time::Duration::from_nanos(1));
        let p2 = write_image_as_html(dir.path(), "x", "image/png", b"b").unwrap();
        assert_ne!(p1, p2);
    }

    #[test]
    fn sanitize_stem_replaces_unsafe_chars() {
        assert_eq!(sanitize_stem("hello world.png"), "hello_world_png");
        assert_eq!(sanitize_stem("../../etc/passwd"), "______etc_passwd");
        assert_eq!(sanitize_stem(""), "attachment");
    }

    #[test]
    fn html_escape_handles_special_chars() {
        assert_eq!(html_escape(r#"a<b>&"c"#), "a&lt;b&gt;&amp;&quot;c");
    }

    #[test]
    fn extension_for_media_type_picks_pdf_for_pdf_type() {
        assert_eq!(extension_for_media_type("application/pdf"), "pdf");
    }

    #[test]
    fn extension_for_media_type_uses_real_extensions_not_subtypes() {
        // text/plain → txt (not "plain"); subtypes that aren't valid file
        // extensions get a sensible mapping so the OS routes to the right
        // viewer/editor.
        assert_eq!(extension_for_media_type("text/plain"), "txt");
        assert_eq!(extension_for_media_type("application/json"), "json");
        assert_eq!(extension_for_media_type("application/ld+json"), "json");
        assert_eq!(extension_for_media_type("text/html"), "html");
    }

    #[test]
    fn extension_for_media_type_strips_xml_suffix() {
        assert_eq!(extension_for_media_type("image/svg+xml"), "svg");
    }

    #[test]
    fn extension_for_media_type_falls_back_to_bin_for_opaque_types() {
        assert_eq!(
            extension_for_media_type("application/x-something weird"),
            "bin"
        );
    }

    #[test]
    fn write_attachment_to_temp_file_uses_natural_extension() {
        let dir = tempdir().unwrap();
        let path = write_attachment_to_temp_file(
            dir.path(),
            "claude-system-card.pdf",
            "application/pdf",
            b"%PDF-1.4 fake",
        )
        .unwrap();
        assert_eq!(path.extension().unwrap(), "pdf");
        assert_eq!(std::fs::read(&path).unwrap(), b"%PDF-1.4 fake");
    }

    #[test]
    fn write_attachment_to_temp_file_sanitizes_filename() {
        let dir = tempdir().unwrap();
        let path = write_attachment_to_temp_file(
            dir.path(),
            "hello world.pdf",
            "application/pdf",
            b"%PDF",
        )
        .unwrap();
        let stem = path.file_stem().unwrap().to_str().unwrap();
        assert!(!stem.contains(' '));
        assert!(stem.starts_with("hello_world"));
    }

    #[test]
    fn write_attachment_to_temp_file_uses_unique_suffix() {
        let dir = tempdir().unwrap();
        let p1 =
            write_attachment_to_temp_file(dir.path(), "doc.pdf", "application/pdf", b"a").unwrap();
        std::thread::sleep(std::time::Duration::from_nanos(1));
        let p2 =
            write_attachment_to_temp_file(dir.path(), "doc.pdf", "application/pdf", b"b").unwrap();
        assert_ne!(p1, p2);
    }

    #[cfg(unix)]
    #[test]
    fn write_attachment_to_temp_file_uses_owner_only_perms() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = tempdir().unwrap();
        let path =
            write_attachment_to_temp_file(dir.path(), "secret.pdf", "application/pdf", b"%PDF")
                .unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        // Only the owner should be able to read the staged file — these
        // can contain user data that other local accounts shouldn't see.
        assert_eq!(mode, 0o600, "expected 0o600, got {mode:o}");
    }

    #[test]
    fn cleanup_stale_attachments_removes_old_files() {
        use std::time::Duration;
        let dir = tempdir().unwrap();
        let old_path = dir.path().join("old.pdf");
        let fresh_path = dir.path().join("fresh.pdf");
        std::fs::write(&old_path, b"old").unwrap();
        // Sleep so the fresh file has a strictly newer mtime than the old
        // one (file system mtime resolution is ~1 ms on most platforms).
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(&fresh_path, b"fresh").unwrap();

        // Pretend "now" is far in the future, just past the fresh file's
        // mtime — the old file lands beyond the cleanup threshold while
        // the fresh one is still inside it.
        let fresh_mtime = std::fs::metadata(&fresh_path).unwrap().modified().unwrap();
        let now = fresh_mtime + Duration::from_millis(5);
        cleanup_stale_attachments_at(dir.path(), Duration::from_millis(15), now);

        assert!(!old_path.exists(), "old file should be removed");
        assert!(fresh_path.exists(), "fresh file should be kept");
    }

    #[test]
    fn cleanup_stale_attachments_is_noop_when_dir_missing() {
        // Must not panic / error when the staging directory hasn't been
        // created yet (first ever open after install).
        let dir = tempdir().unwrap();
        let missing = dir.path().join("does-not-exist");
        cleanup_stale_attachments_at(
            &missing,
            std::time::Duration::from_secs(0),
            std::time::SystemTime::now(),
        );
    }

    #[test]
    fn create_staging_dir_creates_when_missing() {
        let parent = tempdir().unwrap();
        let target = parent.path().join("claudette-staging");
        assert!(!target.exists());
        create_staging_dir(&target).unwrap();
        assert!(target.is_dir());
    }

    #[test]
    fn create_staging_dir_rejects_a_regular_file_at_the_path() {
        let parent = tempdir().unwrap();
        let target = parent.path().join("not-a-dir");
        std::fs::write(&target, b"oops").unwrap();
        let err = create_staging_dir(&target).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);
    }

    #[cfg(unix)]
    #[test]
    fn create_staging_dir_tightens_permissions_on_existing_dir() {
        use std::os::unix::fs::PermissionsExt as _;
        let parent = tempdir().unwrap();
        let target = parent.path().join("loose-dir");
        // Pre-create with a wider mode (e.g. a previous run with a
        // permissive umask).
        std::fs::create_dir(&target).unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).unwrap();
        create_staging_dir(&target).unwrap();
        let mode = std::fs::metadata(&target).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700, "expected 0o700, got {mode:o}");
    }
}
