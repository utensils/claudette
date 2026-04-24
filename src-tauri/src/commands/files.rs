use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;
use tokio::process::Command;

use claudette::db::Database;
use claudette::file_expand;

use crate::state::AppState;
use claudette::process::CommandWindowExt as _;

const MAX_FILES: usize = 10_000;

#[derive(Clone, Serialize)]
pub struct FileEntry {
    pub path: String,
    pub is_directory: bool,
}

#[derive(Clone, Serialize)]
pub struct FileContent {
    pub path: String,
    pub content: Option<String>,
    pub is_binary: bool,
    pub size_bytes: u64,
    pub truncated: bool,
}

/// List files in a workspace's worktree using `git ls-files`.
///
/// Returns tracked files plus untracked-but-not-ignored files, capped at 10,000
/// entries. Paths are relative to the worktree root.
#[tauri::command]
pub async fn list_workspace_files(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<FileEntry>, String> {
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

    let output = Command::new(&claudette::git::resolve_git_path_blocking())
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

    // Collect file entries and extract unique directory paths.
    let mut dirs = std::collections::BTreeSet::new();
    let mut entries: Vec<FileEntry> = stdout
        .lines()
        .filter(|line| !line.is_empty())
        .take(MAX_FILES)
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

    // Prepend directory entries (sorted alphabetically by BTreeSet).
    let dir_entries: Vec<FileEntry> = dirs
        .into_iter()
        .map(|path| FileEntry {
            path,
            is_directory: true,
        })
        .collect();
    entries.splice(0..0, dir_entries);

    Ok(entries)
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

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

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
}
