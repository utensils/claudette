#[derive(Debug, Clone, PartialEq)]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed { from: String },
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct DiffFile {
    pub path: String,
    pub status: FileStatus,
}

#[derive(Debug, Clone, Copy, PartialEq)]
#[allow(dead_code)]
pub enum DiffViewMode {
    Unified,
    SideBySide,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct FileDiff {
    pub path: String,
    pub hunks: Vec<DiffHunk>,
    pub is_binary: bool,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct DiffHunk {
    pub old_start: u32,
    pub new_start: u32,
    pub header: String,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, PartialEq)]
#[allow(dead_code)]
pub enum DiffLineType {
    Context,
    Added,
    Removed,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct DiffLine {
    pub line_type: DiffLineType,
    pub content: String,
    pub old_line_number: Option<u32>,
    pub new_line_number: Option<u32>,
}
