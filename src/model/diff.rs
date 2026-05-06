use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed { from: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GitFileLayer {
    Staged,
    Unstaged,
    Untracked,
    Mixed,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GitStatusEntry {
    pub status: FileStatus,
    pub layer: GitFileLayer,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiffFile {
    pub path: String,
    pub status: FileStatus,
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
}

/// Changed files grouped by git stage, mirroring `git status` output.
#[derive(Debug, Clone, Serialize, Default)]
pub struct StagedDiffFiles {
    /// Changes on this branch vs the merge-base (already committed).
    pub committed: Vec<DiffFile>,
    /// Changes in the index, ready to commit.
    pub staged: Vec<DiffFile>,
    /// Changes in the working tree, not yet staged.
    pub unstaged: Vec<DiffFile>,
    /// New files not tracked by git.
    pub untracked: Vec<DiffFile>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub enum DiffViewMode {
    Unified,
    SideBySide,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileDiff {
    #[allow(dead_code)]
    pub path: String,
    pub hunks: Vec<DiffHunk>,
    pub is_binary: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiffHunk {
    #[allow(dead_code)]
    pub old_start: u32,
    #[allow(dead_code)]
    pub new_start: u32,
    pub header: String,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub enum DiffLineType {
    Context,
    Added,
    Removed,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiffLine {
    pub line_type: DiffLineType,
    pub content: String,
    pub old_line_number: Option<u32>,
    pub new_line_number: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CommitEntry {
    pub hash: String,
    pub short_hash: String,
    pub subject: String,
    pub author: String,
    pub date: String,
    pub files: Vec<DiffFile>,
}
