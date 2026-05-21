use serde::Serialize;

use claudette::model::diff::{FileStatus, GitFileLayer};

#[derive(Clone, Serialize)]
pub struct FileEntry {
    pub path: String,
    pub is_directory: bool,
    pub git_status: Option<FileStatus>,
    pub git_layer: Option<GitFileLayer>,
}

#[derive(Clone, Serialize)]
pub struct FileContent {
    pub path: String,
    pub content: Option<String>,
    pub is_binary: bool,
    pub size_bytes: u64,
    pub truncated: bool,
    /// True when the workspace path is a symlink on disk. Used by the
    /// frontend to suppress noisy decorations whose semantics depend on
    /// comparing the loaded buffer to the git blob: a symlink's blob is
    /// the literal target string ("CLAUDE.md\n"), while the loaded
    /// buffer is the resolved file contents, so the gutter would mark
    /// every line as "modified". The viewer reads through the symlink
    /// intentionally — this flag just tells the UI to skip the diff.
    pub is_symlink: bool,
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

#[derive(Clone, Serialize)]
pub struct WorkspacePathMoveResult {
    pub old_path: String,
    pub new_path: String,
    pub is_directory: bool,
}

#[derive(Clone, Serialize)]
pub struct WorkspacePathTrashResult {
    pub old_path: String,
    pub is_directory: bool,
    pub undo_token: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct WorkspacePathCreateResult {
    pub path: String,
}

#[derive(Clone, Serialize)]
pub struct WorkspacePathRestoreResult {
    pub restored_path: String,
    pub is_directory: bool,
}
