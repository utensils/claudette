//! Tauri command for reading agent-managed files (plans, memory, …).
//!
//! Thin wrapper over the [`claudette::agent_files`] allow-list. The heavy
//! lifting — canonicalization, component-wise root matching, symlink-escape
//! rejection — lives in the library crate; this command just bridges it to
//! the frontend file viewer.

use std::path::Path;

use claudette::agent_files::classify_agent_file;
use claudette::file_expand;

use super::files::FileContent;

/// Viewer truncation cap for agent-managed files. Matches the worktree
/// file viewer's cap so the frontend's edit-size affordances behave
/// identically across both routes.
const MAX_AGENT_FILE_SIZE: usize = 10 * 1024 * 1024;

/// Read an agent-managed file (plan, memory note, …) for display in the
/// read-only Monaco viewer.
///
/// `path` must resolve, after canonicalization, to a file under one of the
/// allow-listed agent directories (see [`claudette::agent_files`]). Any
/// other absolute path is rejected — this is a narrow, separately
/// allow-listed route and does **not** relax the worktree file-read
/// boundary enforced by `normalize_relative_path`.
#[tauri::command]
pub async fn read_agent_managed_file(path: String) -> Result<FileContent, String> {
    let canonical = tauri::async_runtime::spawn_blocking(move || {
        classify_agent_file(Path::new(&path)).map(|(canonical, _kind)| canonical)
    })
    .await
    .map_err(|e| format!("agent file classification failed: {e}"))??;

    let read = file_expand::read_authorized_file(&canonical, MAX_AGENT_FILE_SIZE)
        .await
        .ok_or_else(|| "Failed to read agent file".to_string())?;

    Ok(FileContent {
        path: canonical.to_string_lossy().into_owned(),
        content: read.content,
        is_binary: read.is_binary,
        size_bytes: read.size_bytes,
        truncated: read.truncated,
        // Agent files are read through to their canonical location and
        // rendered read-only; the git-gutter symlink concern doesn't apply.
        is_symlink: false,
    })
}
