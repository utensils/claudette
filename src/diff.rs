use std::fmt;
use std::path::Path;

use tokio::process::Command;
use crate::process::CommandWindowExt as _;

use crate::model::diff::{
    DiffFile, DiffHunk, DiffLine, DiffLineType, FileDiff, FileStatus, StagedDiffFiles,
};

#[derive(Debug, Clone)]
pub enum DiffError {
    CommandFailed(String),
}

impl fmt::Display for DiffError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::CommandFailed(msg) => write!(f, "Diff operation failed: {msg}"),
        }
    }
}

impl std::error::Error for DiffError {}

/// Validate that a file path is safe for diff operations: no path traversal,
/// no absolute paths, and no null bytes.
fn validate_file_path(file_path: &str) -> Result<(), DiffError> {
    if file_path.contains('\0') {
        return Err(DiffError::CommandFailed(
            "Invalid file path: contains null byte".into(),
        ));
    }
    if Path::new(file_path).is_absolute() {
        return Err(DiffError::CommandFailed(
            "Invalid file path: absolute paths are not allowed".into(),
        ));
    }
    if file_path.split(['/', '\\']).any(|c| c == "..") {
        return Err(DiffError::CommandFailed(
            "Invalid file path: path traversal is not allowed".into(),
        ));
    }
    Ok(())
}

async fn run_git(path: &str, args: &[&str]) -> Result<String, DiffError> {
    let output = Command::new("git").no_console_window()
        .args(["-C", path])
        .args(args)
        .output()
        .await
        .map_err(|e| DiffError::CommandFailed(e.to_string()))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(DiffError::CommandFailed(stderr))
    }
}

/// Get the merge base between two refs.
pub async fn merge_base(repo_path: &str, branch: &str, base: &str) -> Result<String, DiffError> {
    run_git(repo_path, &["merge-base", "--", base, branch]).await
}

/// List all changed files between merge base and current working tree.
pub async fn changed_files(
    worktree_path: &str,
    merge_base: &str,
) -> Result<Vec<DiffFile>, DiffError> {
    let mut files =
        parse_name_status(&run_git(worktree_path, &["diff", "--name-status", merge_base]).await?);

    // Untracked files
    let untracked = parse_untracked(
        &run_git(
            worktree_path,
            &["ls-files", "--others", "--exclude-standard"],
        )
        .await?,
    );
    files.extend(untracked);

    apply_numstat(
        &mut files,
        &run_git(worktree_path, &["diff", "--numstat", merge_base]).await?,
    );
    sort_diff_files(&mut files);

    Ok(files)
}

/// List changed files grouped by git stage (committed, staged, unstaged, untracked).
pub async fn staged_changed_files(
    worktree_path: &str,
    merge_base: &str,
) -> Result<StagedDiffFiles, DiffError> {
    let range = format!("{merge_base}..HEAD");

    // Build arg arrays before the join so borrows live long enough
    let committed_ns_args = ["diff", "--name-status", &range];
    let committed_num_args = ["diff", "--numstat", &range];

    // Run all git commands concurrently
    let (
        committed_ns,
        committed_num,
        staged_ns,
        staged_num,
        unstaged_ns,
        unstaged_num,
        untracked_out,
    ) = tokio::join!(
        run_git(worktree_path, &committed_ns_args),
        run_git(worktree_path, &committed_num_args),
        run_git(worktree_path, &["diff", "--cached", "--name-status"]),
        run_git(worktree_path, &["diff", "--cached", "--numstat"]),
        run_git(worktree_path, &["diff", "--name-status"]),
        run_git(worktree_path, &["diff", "--numstat"]),
        run_git(
            worktree_path,
            &["ls-files", "--others", "--exclude-standard"],
        ),
    );

    let committed_ns = committed_ns?;
    let committed_num = committed_num?;
    let staged_ns = staged_ns?;
    let staged_num = staged_num?;
    let unstaged_ns = unstaged_ns?;
    let unstaged_num = unstaged_num?;
    let untracked_out = untracked_out?;

    let mut committed = parse_name_status(&committed_ns);
    apply_numstat(&mut committed, &committed_num);
    sort_diff_files(&mut committed);

    let mut staged = parse_name_status(&staged_ns);
    apply_numstat(&mut staged, &staged_num);
    sort_diff_files(&mut staged);

    let mut unstaged = parse_name_status(&unstaged_ns);
    apply_numstat(&mut unstaged, &unstaged_num);
    sort_diff_files(&mut unstaged);

    let mut untracked = parse_untracked(&untracked_out);
    sort_diff_files(&mut untracked);

    Ok(StagedDiffFiles {
        committed,
        staged,
        unstaged,
        untracked,
    })
}

/// Parse `--name-status` output into a list of DiffFiles.
fn parse_name_status(output: &str) -> Vec<DiffFile> {
    output.lines().filter_map(parse_name_status_line).collect()
}

/// Parse `ls-files --others` output into untracked DiffFiles.
fn parse_untracked(output: &str) -> Vec<DiffFile> {
    output
        .lines()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(|path| DiffFile {
            path: path.to_string(),
            status: FileStatus::Added,
            additions: None,
            deletions: None,
        })
        .collect()
}

/// Apply `--numstat` output to enrich DiffFiles with addition/deletion counts.
fn apply_numstat(files: &mut [DiffFile], numstat_output: &str) {
    let stats: std::collections::HashMap<String, (u32, u32)> = numstat_output
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 3 {
                let adds = parts[0].parse::<u32>().ok()?;
                let dels = parts[1].parse::<u32>().ok()?;
                let path = parts[2..].join(" ");
                Some((path, (adds, dels)))
            } else {
                None
            }
        })
        .collect();

    for file in files.iter_mut() {
        if let Some((adds, dels)) = stats.get(&file.path) {
            file.additions = Some(*adds);
            file.deletions = Some(*dels);
        }
    }
}

/// Sort files: modified first, then added, renamed, deleted.
fn sort_diff_files(files: &mut [DiffFile]) {
    files.sort_by_key(|f| match &f.status {
        FileStatus::Modified => 0,
        FileStatus::Added => 1,
        FileStatus::Renamed { .. } => 2,
        FileStatus::Deleted => 3,
    });
}

fn parse_name_status_line(line: &str) -> Option<DiffFile> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }

    let mut parts = line.split('\t');
    let status_str = parts.next()?;
    let path = parts.next()?.to_string();

    let status = match status_str.chars().next()? {
        'A' => FileStatus::Added,
        'M' => FileStatus::Modified,
        'D' => FileStatus::Deleted,
        'R' => {
            let new_path = parts.next()?.to_string();
            // For renames, the format is "R###\told_path\tnew_path"
            // We want the DiffFile to represent the new path
            return Some(DiffFile {
                status: FileStatus::Renamed { from: path },
                path: new_path,
                additions: None,
                deletions: None,
            });
        }
        _ => return None,
    };

    Some(DiffFile {
        path,
        status,
        additions: None,
        deletions: None,
    })
}

/// Get the unified diff for a specific file.
pub async fn file_diff(
    worktree_path: &str,
    merge_base: &str,
    file_path: &str,
) -> Result<String, DiffError> {
    validate_file_path(file_path)?;

    // Check if the file is untracked
    let ls_output = run_git(
        worktree_path,
        &[
            "ls-files",
            "--others",
            "--exclude-standard",
            "--",
            file_path,
        ],
    )
    .await?;

    if !ls_output.trim().is_empty() {
        // Untracked file — diff against /dev/null
        let full_path = Path::new(worktree_path).join(file_path);
        let output = Command::new("git").no_console_window()
            .args(["-C", worktree_path])
            .args([
                "diff",
                "--no-index",
                "--",
                "/dev/null",
                full_path.to_str().unwrap_or(file_path),
            ])
            .output()
            .await
            .map_err(|e| DiffError::CommandFailed(e.to_string()))?;

        // git diff --no-index exits with 1 when files differ, which is expected
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        if stdout.trim().is_empty() && !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(DiffError::CommandFailed(stderr));
        }
        return Ok(stdout);
    }

    // Tracked file — diff against merge base
    run_git(worktree_path, &["diff", merge_base, "--", file_path]).await
}

/// Get the unified diff for a specific file within a particular git layer.
///
/// The layer determines which git diff variant is used:
/// - `"committed"` — diff between merge-base and HEAD (what's on the branch)
/// - `"staged"` — diff between HEAD and index (what's staged)
/// - `"unstaged"` — diff between index and working tree (what's modified)
/// - `"untracked"` — diff against /dev/null (new file)
/// - `None` — default behavior: diff between merge-base and working tree
pub async fn file_diff_for_layer(
    worktree_path: &str,
    merge_base: &str,
    file_path: &str,
    layer: Option<&str>,
) -> Result<String, DiffError> {
    validate_file_path(file_path)?;

    match layer {
        Some("committed") => {
            let range = format!("{merge_base}..HEAD");
            run_git(worktree_path, &["diff", &range, "--", file_path]).await
        }
        Some("staged") => run_git(worktree_path, &["diff", "--cached", "--", file_path]).await,
        Some("unstaged") => run_git(worktree_path, &["diff", "--", file_path]).await,
        Some("untracked") => {
            // Diff against /dev/null for untracked files
            let full_path = Path::new(worktree_path).join(file_path);
            let output = Command::new("git").no_console_window()
                .args(["-C", worktree_path])
                .args([
                    "diff",
                    "--no-index",
                    "--",
                    "/dev/null",
                    full_path.to_str().unwrap_or(file_path),
                ])
                .output()
                .await
                .map_err(|e| DiffError::CommandFailed(e.to_string()))?;

            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            if stdout.trim().is_empty() && !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                return Err(DiffError::CommandFailed(stderr));
            }
            Ok(stdout)
        }
        _ => {
            // Default: full diff from merge-base to working tree (existing behavior)
            file_diff(worktree_path, merge_base, file_path).await
        }
    }
}

/// Revert a file to its merge-base version.
pub async fn revert_file(
    worktree_path: &str,
    merge_base: &str,
    file_path: &str,
    status: &FileStatus,
) -> Result<(), DiffError> {
    validate_file_path(file_path)?;

    match status {
        FileStatus::Added => {
            // Delete the file
            let full_path = Path::new(worktree_path).join(file_path);
            tokio::fs::remove_file(&full_path)
                .await
                .map_err(|e| DiffError::CommandFailed(e.to_string()))?;
        }
        FileStatus::Modified | FileStatus::Deleted | FileStatus::Renamed { .. } => {
            // Restore from merge base
            run_git(worktree_path, &["checkout", merge_base, "--", file_path]).await?;
        }
    }
    Ok(())
}

/// Parse unified diff output into structured data.
pub fn parse_unified_diff(raw: &str, path: &str) -> FileDiff {
    if raw.contains("Binary files") && raw.contains("differ") {
        return FileDiff {
            path: path.to_string(),
            hunks: Vec::new(),
            is_binary: true,
        };
    }

    let mut hunks = Vec::new();
    let mut current_hunk: Option<HunkBuilder> = None;

    for line in raw.lines() {
        // Skip diff headers
        if line.starts_with("diff --git")
            || line.starts_with("index ")
            || line.starts_with("---")
            || line.starts_with("+++")
            || line.starts_with("new file mode")
            || line.starts_with("deleted file mode")
            || line.starts_with("old mode")
            || line.starts_with("new mode")
            || line.starts_with("similarity index")
            || line.starts_with("rename from")
            || line.starts_with("rename to")
        {
            continue;
        }

        // Hunk header
        if line.starts_with("@@") {
            if let Some(builder) = current_hunk.take() {
                hunks.push(builder.build());
            }
            if let Some(builder) = parse_hunk_header(line) {
                current_hunk = Some(builder);
            }
            continue;
        }

        // No-newline marker
        if line.starts_with("\\ No newline at end of file") {
            continue;
        }

        // Diff content lines
        if let Some(ref mut builder) = current_hunk
            && let Some(ch) = line.chars().next()
        {
            match ch {
                '+' => {
                    builder.lines.push(DiffLine {
                        line_type: DiffLineType::Added,
                        content: line[1..].to_string(),
                        old_line_number: None,
                        new_line_number: Some(builder.new_line),
                    });
                    builder.new_line += 1;
                }
                '-' => {
                    builder.lines.push(DiffLine {
                        line_type: DiffLineType::Removed,
                        content: line[1..].to_string(),
                        old_line_number: Some(builder.old_line),
                        new_line_number: None,
                    });
                    builder.old_line += 1;
                }
                ' ' => {
                    builder.lines.push(DiffLine {
                        line_type: DiffLineType::Context,
                        content: line[1..].to_string(),
                        old_line_number: Some(builder.old_line),
                        new_line_number: Some(builder.new_line),
                    });
                    builder.old_line += 1;
                    builder.new_line += 1;
                }
                _ => {}
            }
        }
    }

    // Flush last hunk
    if let Some(builder) = current_hunk {
        hunks.push(builder.build());
    }

    FileDiff {
        path: path.to_string(),
        hunks,
        is_binary: false,
    }
}

struct HunkBuilder {
    old_start: u32,
    new_start: u32,
    header: String,
    old_line: u32,
    new_line: u32,
    lines: Vec<DiffLine>,
}

impl HunkBuilder {
    fn build(self) -> DiffHunk {
        DiffHunk {
            old_start: self.old_start,
            new_start: self.new_start,
            header: self.header,
            lines: self.lines,
        }
    }
}

fn parse_hunk_header(line: &str) -> Option<HunkBuilder> {
    // Format: @@ -old_start,old_count +new_start,new_count @@ optional context
    let after_at = line.strip_prefix("@@ ")?;
    let end = after_at.find(" @@")?;
    let range_part = &after_at[..end];
    let _header_context = after_at[end + 3..].trim();

    let mut parts = range_part.split(' ');

    let old_range = parts.next()?.strip_prefix('-')?;
    let old_start: u32 = old_range.split(',').next()?.parse().ok()?;

    let new_range = parts.next()?.strip_prefix('+')?;
    let new_start: u32 = new_range.split(',').next()?.parse().ok()?;

    Some(HunkBuilder {
        old_start,
        new_start,
        header: line.to_string(),
        old_line: old_start,
        new_line: new_start,
        lines: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_file_path_rejects_traversal() {
        assert!(validate_file_path("../etc/passwd").is_err());
        assert!(validate_file_path("src/../../etc/passwd").is_err());
        assert!(validate_file_path("..").is_err());
        assert!(validate_file_path("foo/..").is_err());
        // Windows-style separators
        assert!(validate_file_path("src\\..\\..\\etc\\passwd").is_err());
    }

    #[test]
    fn test_validate_file_path_rejects_absolute() {
        assert!(validate_file_path("/etc/passwd").is_err());
    }

    #[test]
    fn test_validate_file_path_rejects_null_byte() {
        assert!(validate_file_path("src/foo\0bar").is_err());
    }

    #[test]
    fn test_validate_file_path_accepts_valid() {
        assert!(validate_file_path("src/app.rs").is_ok());
        assert!(validate_file_path("deeply/nested/path/file.txt").is_ok());
        assert!(validate_file_path("file.rs").is_ok());
        // ".." as part of a filename (not a component) is fine
        assert!(validate_file_path("src/foo..bar").is_ok());
    }

    #[test]
    fn test_parse_name_status_modified() {
        let file = parse_name_status_line("M\tsrc/app.rs").unwrap();
        assert_eq!(file.path, "src/app.rs");
        assert_eq!(file.status, FileStatus::Modified);
    }

    #[test]
    fn test_parse_name_status_added() {
        let file = parse_name_status_line("A\tsrc/new_file.rs").unwrap();
        assert_eq!(file.path, "src/new_file.rs");
        assert_eq!(file.status, FileStatus::Added);
    }

    #[test]
    fn test_parse_name_status_deleted() {
        let file = parse_name_status_line("D\tsrc/old_file.rs").unwrap();
        assert_eq!(file.path, "src/old_file.rs");
        assert_eq!(file.status, FileStatus::Deleted);
    }

    #[test]
    fn test_parse_name_status_renamed() {
        let file = parse_name_status_line("R100\tsrc/old.rs\tsrc/new.rs").unwrap();
        assert_eq!(file.path, "src/new.rs");
        assert_eq!(
            file.status,
            FileStatus::Renamed {
                from: "src/old.rs".to_string()
            }
        );
    }

    #[test]
    fn test_parse_name_status_empty() {
        assert!(parse_name_status_line("").is_none());
        assert!(parse_name_status_line("   ").is_none());
    }

    #[test]
    fn test_parse_simple_modification() {
        let diff = "\
diff --git a/src/app.rs b/src/app.rs
index abc123..def456 100644
--- a/src/app.rs
+++ b/src/app.rs
@@ -10,7 +10,8 @@ fn some_function() {
     context line 1
     context line 2
-    old line
+    new line
+    extra line
     context line 3
";
        let result = parse_unified_diff(diff, "src/app.rs");
        assert_eq!(result.path, "src/app.rs");
        assert!(!result.is_binary);
        assert_eq!(result.hunks.len(), 1);

        let hunk = &result.hunks[0];
        assert_eq!(hunk.old_start, 10);
        assert_eq!(hunk.new_start, 10);
        assert_eq!(hunk.lines.len(), 6);

        assert_eq!(hunk.lines[0].line_type, DiffLineType::Context);
        assert_eq!(hunk.lines[0].content, "    context line 1");
        assert_eq!(hunk.lines[0].old_line_number, Some(10));
        assert_eq!(hunk.lines[0].new_line_number, Some(10));

        assert_eq!(hunk.lines[1].line_type, DiffLineType::Context);
        assert_eq!(hunk.lines[1].old_line_number, Some(11));
        assert_eq!(hunk.lines[1].new_line_number, Some(11));

        assert_eq!(hunk.lines[2].line_type, DiffLineType::Removed);
        assert_eq!(hunk.lines[2].content, "    old line");
        assert_eq!(hunk.lines[2].old_line_number, Some(12));
        assert_eq!(hunk.lines[2].new_line_number, None);

        assert_eq!(hunk.lines[3].line_type, DiffLineType::Added);
        assert_eq!(hunk.lines[3].content, "    new line");
        assert_eq!(hunk.lines[3].old_line_number, None);
        assert_eq!(hunk.lines[3].new_line_number, Some(12));

        assert_eq!(hunk.lines[4].line_type, DiffLineType::Added);
        assert_eq!(hunk.lines[4].content, "    extra line");
        assert_eq!(hunk.lines[4].new_line_number, Some(13));

        assert_eq!(hunk.lines[5].line_type, DiffLineType::Context);
        assert_eq!(hunk.lines[5].content, "    context line 3");
        assert_eq!(hunk.lines[5].old_line_number, Some(13));
        assert_eq!(hunk.lines[5].new_line_number, Some(14));
    }

    #[test]
    fn test_parse_multi_hunk() {
        let diff = "\
diff --git a/src/lib.rs b/src/lib.rs
index 111..222 100644
--- a/src/lib.rs
+++ b/src/lib.rs
@@ -1,3 +1,4 @@
 line 1
+inserted
 line 2
 line 3
@@ -20,3 +21,3 @@ fn other() {
     keep
-    remove
+    replace
     keep
";
        let result = parse_unified_diff(diff, "src/lib.rs");
        assert_eq!(result.hunks.len(), 2);

        assert_eq!(result.hunks[0].old_start, 1);
        assert_eq!(result.hunks[0].new_start, 1);
        assert_eq!(result.hunks[0].lines.len(), 4);

        assert_eq!(result.hunks[1].old_start, 20);
        assert_eq!(result.hunks[1].new_start, 21);
        assert_eq!(result.hunks[1].lines.len(), 4);
    }

    #[test]
    fn test_parse_pure_addition() {
        let diff = "\
diff --git a/new_file.rs b/new_file.rs
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/new_file.rs
@@ -0,0 +1,3 @@
+line 1
+line 2
+line 3
";
        let result = parse_unified_diff(diff, "new_file.rs");
        assert!(!result.is_binary);
        assert_eq!(result.hunks.len(), 1);
        assert_eq!(result.hunks[0].lines.len(), 3);
        assert!(
            result.hunks[0]
                .lines
                .iter()
                .all(|l| l.line_type == DiffLineType::Added)
        );
        assert_eq!(result.hunks[0].lines[0].new_line_number, Some(1));
        assert_eq!(result.hunks[0].lines[2].new_line_number, Some(3));
    }

    #[test]
    fn test_parse_pure_deletion() {
        let diff = "\
diff --git a/old_file.rs b/old_file.rs
deleted file mode 100644
index abc1234..0000000
--- a/old_file.rs
+++ /dev/null
@@ -1,3 +0,0 @@
-line 1
-line 2
-line 3
";
        let result = parse_unified_diff(diff, "old_file.rs");
        assert!(!result.is_binary);
        assert_eq!(result.hunks.len(), 1);
        assert_eq!(result.hunks[0].lines.len(), 3);
        assert!(
            result.hunks[0]
                .lines
                .iter()
                .all(|l| l.line_type == DiffLineType::Removed)
        );
        assert_eq!(result.hunks[0].lines[0].old_line_number, Some(1));
    }

    #[test]
    fn test_parse_binary_file() {
        let diff = "\
diff --git a/image.png b/image.png
Binary files a/image.png and b/image.png differ
";
        let result = parse_unified_diff(diff, "image.png");
        assert!(result.is_binary);
        assert!(result.hunks.is_empty());
    }

    #[test]
    fn test_parse_no_newline_at_eof() {
        let diff = "\
diff --git a/file.txt b/file.txt
index abc..def 100644
--- a/file.txt
+++ b/file.txt
@@ -1,2 +1,2 @@
 line 1
-old last line
\\ No newline at end of file
+new last line
\\ No newline at end of file
";
        let result = parse_unified_diff(diff, "file.txt");
        assert_eq!(result.hunks.len(), 1);
        // The no-newline markers should be skipped
        assert_eq!(result.hunks[0].lines.len(), 3);
        assert_eq!(result.hunks[0].lines[0].line_type, DiffLineType::Context);
        assert_eq!(result.hunks[0].lines[1].line_type, DiffLineType::Removed);
        assert_eq!(result.hunks[0].lines[2].line_type, DiffLineType::Added);
    }

    #[test]
    fn test_parse_rename() {
        let diff = "\
diff --git a/old_name.rs b/new_name.rs
similarity index 95%
rename from old_name.rs
rename to new_name.rs
index abc..def 100644
--- a/old_name.rs
+++ b/new_name.rs
@@ -1,3 +1,3 @@
 keep
-old
+new
 keep
";
        let result = parse_unified_diff(diff, "new_name.rs");
        assert!(!result.is_binary);
        assert_eq!(result.hunks.len(), 1);
        assert_eq!(result.hunks[0].lines.len(), 4);
    }

    #[test]
    fn test_parse_empty_diff() {
        let result = parse_unified_diff("", "empty.rs");
        assert!(!result.is_binary);
        assert!(result.hunks.is_empty());
    }

    #[test]
    fn test_parse_context_line_numbers() {
        let diff = "\
diff --git a/f.rs b/f.rs
index a..b 100644
--- a/f.rs
+++ b/f.rs
@@ -5,4 +5,5 @@
 ctx1
 ctx2
+added
 ctx3
 ctx4
";
        let result = parse_unified_diff(diff, "f.rs");
        let lines = &result.hunks[0].lines;

        // ctx1: old=5, new=5
        assert_eq!(lines[0].old_line_number, Some(5));
        assert_eq!(lines[0].new_line_number, Some(5));

        // ctx2: old=6, new=6
        assert_eq!(lines[1].old_line_number, Some(6));
        assert_eq!(lines[1].new_line_number, Some(6));

        // added: old=None, new=7
        assert_eq!(lines[2].old_line_number, None);
        assert_eq!(lines[2].new_line_number, Some(7));

        // ctx3: old=7, new=8
        assert_eq!(lines[3].old_line_number, Some(7));
        assert_eq!(lines[3].new_line_number, Some(8));

        // ctx4: old=8, new=9
        assert_eq!(lines[4].old_line_number, Some(8));
        assert_eq!(lines[4].new_line_number, Some(9));
    }
}

#[cfg(test)]
mod integration_tests {
    use super::*;
    use std::process::Command as StdCommand;

    fn git_cmd(dir: &Path, args: &[&str]) -> String {
        let output = StdCommand::new("git").no_console_window()
            .args(["-C", dir.to_str().unwrap()])
            .args(args)
            .output()
            .expect("failed to run git");
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn setup_test_repo(dir: &Path) {
        git_cmd(dir, &["init", "-b", "main"]);
        git_cmd(dir, &["config", "user.email", "test@test.com"]);
        git_cmd(dir, &["config", "user.name", "Test"]);

        // Create initial file and commit on main
        std::fs::write(dir.join("file.txt"), "line 1\nline 2\nline 3\n").unwrap();
        std::fs::write(dir.join("keep.txt"), "keep\n").unwrap();
        git_cmd(dir, &["add", "."]);
        git_cmd(dir, &["commit", "-m", "initial"]);

        // Create a feature branch
        git_cmd(dir, &["checkout", "-b", "feature"]);

        // Make changes on the feature branch
        std::fs::write(dir.join("file.txt"), "line 1\nmodified line 2\nline 3\n").unwrap();
        std::fs::write(dir.join("new_file.txt"), "new content\n").unwrap();
        std::fs::remove_file(dir.join("keep.txt")).unwrap();
        git_cmd(dir, &["add", "."]);
        git_cmd(dir, &["commit", "-m", "feature changes"]);
    }

    #[tokio::test]
    async fn test_merge_base() {
        let tmp = tempfile::tempdir().unwrap();
        setup_test_repo(tmp.path());

        let base = merge_base(tmp.path().to_str().unwrap(), "feature", "main")
            .await
            .unwrap();

        // Merge base should be the initial commit (main HEAD)
        let main_head = git_cmd(tmp.path(), &["rev-parse", "main"]);
        assert_eq!(base, main_head);
    }

    #[tokio::test]
    async fn test_changed_files_lists_all_changes() {
        let tmp = tempfile::tempdir().unwrap();
        setup_test_repo(tmp.path());

        let base = merge_base(tmp.path().to_str().unwrap(), "feature", "main")
            .await
            .unwrap();
        let files = changed_files(tmp.path().to_str().unwrap(), &base)
            .await
            .unwrap();

        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"file.txt"), "should contain modified file");
        assert!(paths.contains(&"new_file.txt"), "should contain added file");
        assert!(paths.contains(&"keep.txt"), "should contain deleted file");

        let file_txt = files.iter().find(|f| f.path == "file.txt").unwrap();
        assert_eq!(file_txt.status, FileStatus::Modified);

        let new_file = files.iter().find(|f| f.path == "new_file.txt").unwrap();
        assert_eq!(new_file.status, FileStatus::Added);

        let keep = files.iter().find(|f| f.path == "keep.txt").unwrap();
        assert_eq!(keep.status, FileStatus::Deleted);
    }

    #[tokio::test]
    async fn test_changed_files_includes_untracked() {
        let tmp = tempfile::tempdir().unwrap();
        setup_test_repo(tmp.path());

        let base = merge_base(tmp.path().to_str().unwrap(), "feature", "main")
            .await
            .unwrap();

        // Add an untracked file
        std::fs::write(tmp.path().join("untracked.txt"), "hello\n").unwrap();

        let files = changed_files(tmp.path().to_str().unwrap(), &base)
            .await
            .unwrap();

        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        assert!(
            paths.contains(&"untracked.txt"),
            "should contain untracked file"
        );

        let untracked = files.iter().find(|f| f.path == "untracked.txt").unwrap();
        assert_eq!(untracked.status, FileStatus::Added);
    }

    #[tokio::test]
    async fn test_file_diff_returns_parseable_output() {
        let tmp = tempfile::tempdir().unwrap();
        setup_test_repo(tmp.path());

        let base = merge_base(tmp.path().to_str().unwrap(), "feature", "main")
            .await
            .unwrap();

        let raw = file_diff(tmp.path().to_str().unwrap(), &base, "file.txt")
            .await
            .unwrap();

        let parsed = parse_unified_diff(&raw, "file.txt");
        assert!(!parsed.is_binary);
        assert!(!parsed.hunks.is_empty());

        // Should have removed "line 2" and added "modified line 2"
        let all_lines: Vec<_> = parsed.hunks.iter().flat_map(|h| &h.lines).collect();
        assert!(
            all_lines
                .iter()
                .any(|l| l.line_type == DiffLineType::Removed && l.content.contains("line 2"))
        );
        assert!(
            all_lines.iter().any(
                |l| l.line_type == DiffLineType::Added && l.content.contains("modified line 2")
            )
        );
    }

    #[tokio::test]
    async fn test_file_diff_deleted_file() {
        let tmp = tempfile::tempdir().unwrap();
        setup_test_repo(tmp.path());

        let base = merge_base(tmp.path().to_str().unwrap(), "feature", "main")
            .await
            .unwrap();

        let raw = file_diff(tmp.path().to_str().unwrap(), &base, "keep.txt")
            .await
            .unwrap();

        let parsed = parse_unified_diff(&raw, "keep.txt");
        assert!(!parsed.hunks.is_empty());
        // All lines should be removals
        assert!(
            parsed.hunks[0]
                .lines
                .iter()
                .all(|l| l.line_type == DiffLineType::Removed)
        );
    }

    #[tokio::test]
    async fn test_file_diff_added_file() {
        let tmp = tempfile::tempdir().unwrap();
        setup_test_repo(tmp.path());

        let base = merge_base(tmp.path().to_str().unwrap(), "feature", "main")
            .await
            .unwrap();

        let raw = file_diff(tmp.path().to_str().unwrap(), &base, "new_file.txt")
            .await
            .unwrap();

        let parsed = parse_unified_diff(&raw, "new_file.txt");
        assert!(!parsed.hunks.is_empty());
        // All lines should be additions
        assert!(
            parsed.hunks[0]
                .lines
                .iter()
                .all(|l| l.line_type == DiffLineType::Added)
        );
    }

    #[tokio::test]
    async fn test_revert_modified_file() {
        let tmp = tempfile::tempdir().unwrap();
        setup_test_repo(tmp.path());

        let base = merge_base(tmp.path().to_str().unwrap(), "feature", "main")
            .await
            .unwrap();

        revert_file(
            tmp.path().to_str().unwrap(),
            &base,
            "file.txt",
            &FileStatus::Modified,
        )
        .await
        .unwrap();

        let content = std::fs::read_to_string(tmp.path().join("file.txt")).unwrap();
        assert_eq!(content, "line 1\nline 2\nline 3\n");
    }

    #[tokio::test]
    async fn test_revert_added_file() {
        let tmp = tempfile::tempdir().unwrap();
        setup_test_repo(tmp.path());

        let base = merge_base(tmp.path().to_str().unwrap(), "feature", "main")
            .await
            .unwrap();

        revert_file(
            tmp.path().to_str().unwrap(),
            &base,
            "new_file.txt",
            &FileStatus::Added,
        )
        .await
        .unwrap();

        assert!(!tmp.path().join("new_file.txt").exists());
    }

    #[tokio::test]
    async fn test_revert_deleted_file() {
        let tmp = tempfile::tempdir().unwrap();
        setup_test_repo(tmp.path());

        let base = merge_base(tmp.path().to_str().unwrap(), "feature", "main")
            .await
            .unwrap();

        revert_file(
            tmp.path().to_str().unwrap(),
            &base,
            "keep.txt",
            &FileStatus::Deleted,
        )
        .await
        .unwrap();

        let content = std::fs::read_to_string(tmp.path().join("keep.txt")).unwrap();
        assert_eq!(content, "keep\n");
    }

    #[tokio::test]
    async fn test_no_changes_returns_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();

        git_cmd(dir, &["init", "-b", "main"]);
        git_cmd(dir, &["config", "user.email", "test@test.com"]);
        git_cmd(dir, &["config", "user.name", "Test"]);
        std::fs::write(dir.join("file.txt"), "content\n").unwrap();
        git_cmd(dir, &["add", "."]);
        git_cmd(dir, &["commit", "-m", "initial"]);

        let head = git_cmd(dir, &["rev-parse", "HEAD"]);
        let files = changed_files(dir.to_str().unwrap(), &head).await.unwrap();
        assert!(files.is_empty());
    }

    #[tokio::test]
    async fn test_staged_changed_files_categorizes_correctly() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();

        // Set up repo with initial commit on main
        git_cmd(dir, &["init", "-b", "main"]);
        git_cmd(dir, &["config", "user.email", "test@test.com"]);
        git_cmd(dir, &["config", "user.name", "Test"]);
        std::fs::write(dir.join("base.txt"), "base content\n").unwrap();
        std::fs::write(dir.join("will-modify.txt"), "original\n").unwrap();
        git_cmd(dir, &["add", "."]);
        git_cmd(dir, &["commit", "-m", "initial"]);

        // Create feature branch
        git_cmd(dir, &["checkout", "-b", "feature"]);

        // 1. Committed change: modify and commit a file
        std::fs::write(dir.join("will-modify.txt"), "committed change\n").unwrap();
        std::fs::write(dir.join("committed-new.txt"), "new file\n").unwrap();
        git_cmd(dir, &["add", "."]);
        git_cmd(dir, &["commit", "-m", "committed changes"]);

        // 2. Staged change: modify and stage (but don't commit)
        std::fs::write(dir.join("staged-new.txt"), "staged content\n").unwrap();
        git_cmd(dir, &["add", "staged-new.txt"]);

        // 3. Unstaged change: modify a committed file without staging
        std::fs::write(
            dir.join("will-modify.txt"),
            "committed change\nunstaged edit\n",
        )
        .unwrap();

        // 4. Untracked file
        std::fs::write(dir.join("untracked.txt"), "not tracked\n").unwrap();

        let base = merge_base(dir.to_str().unwrap(), "feature", "main")
            .await
            .unwrap();
        let staged = staged_changed_files(dir.to_str().unwrap(), &base)
            .await
            .unwrap();

        // Committed: will-modify.txt + committed-new.txt
        let committed_paths: Vec<&str> = staged.committed.iter().map(|f| f.path.as_str()).collect();
        assert!(
            committed_paths.contains(&"will-modify.txt"),
            "committed should contain will-modify.txt, got: {committed_paths:?}"
        );
        assert!(
            committed_paths.contains(&"committed-new.txt"),
            "committed should contain committed-new.txt, got: {committed_paths:?}"
        );

        // Staged: staged-new.txt
        let staged_paths: Vec<&str> = staged.staged.iter().map(|f| f.path.as_str()).collect();
        assert!(
            staged_paths.contains(&"staged-new.txt"),
            "staged should contain staged-new.txt, got: {staged_paths:?}"
        );

        // Unstaged: will-modify.txt (has uncommitted modifications)
        let unstaged_paths: Vec<&str> = staged.unstaged.iter().map(|f| f.path.as_str()).collect();
        assert!(
            unstaged_paths.contains(&"will-modify.txt"),
            "unstaged should contain will-modify.txt, got: {unstaged_paths:?}"
        );

        // Untracked: untracked.txt
        let untracked_paths: Vec<&str> = staged.untracked.iter().map(|f| f.path.as_str()).collect();
        assert!(
            untracked_paths.contains(&"untracked.txt"),
            "untracked should contain untracked.txt, got: {untracked_paths:?}"
        );

        // will-modify.txt appears in BOTH committed AND unstaged
        assert!(committed_paths.contains(&"will-modify.txt"));
        assert!(unstaged_paths.contains(&"will-modify.txt"));
    }

    #[tokio::test]
    async fn test_file_diff_for_layer_committed() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        setup_test_repo(dir);

        let base = merge_base(dir.to_str().unwrap(), "feature", "main")
            .await
            .unwrap();

        let raw = file_diff_for_layer(dir.to_str().unwrap(), &base, "file.txt", Some("committed"))
            .await
            .unwrap();
        let parsed = parse_unified_diff(&raw, "file.txt");
        assert!(!parsed.hunks.is_empty(), "committed layer should have diff");
    }

    #[tokio::test]
    async fn test_file_diff_for_layer_staged() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        setup_test_repo(dir);

        // Stage a change without committing
        std::fs::write(dir.join("file.txt"), "staged change\n").unwrap();
        git_cmd(dir, &["add", "file.txt"]);

        let raw = file_diff_for_layer(dir.to_str().unwrap(), "HEAD", "file.txt", Some("staged"))
            .await
            .unwrap();
        let parsed = parse_unified_diff(&raw, "file.txt");
        assert!(!parsed.hunks.is_empty(), "staged layer should have diff");
    }

    #[tokio::test]
    async fn test_file_diff_for_layer_unstaged() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        setup_test_repo(dir);

        // Modify without staging
        std::fs::write(dir.join("file.txt"), "unstaged edit\n").unwrap();

        let raw = file_diff_for_layer(dir.to_str().unwrap(), "HEAD", "file.txt", Some("unstaged"))
            .await
            .unwrap();
        let parsed = parse_unified_diff(&raw, "file.txt");
        assert!(!parsed.hunks.is_empty(), "unstaged layer should have diff");
    }

    #[tokio::test]
    async fn test_file_diff_for_layer_untracked() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        setup_test_repo(dir);

        std::fs::write(dir.join("brand-new.txt"), "hello\n").unwrap();

        let raw = file_diff_for_layer(
            dir.to_str().unwrap(),
            "HEAD",
            "brand-new.txt",
            Some("untracked"),
        )
        .await
        .unwrap();
        let parsed = parse_unified_diff(&raw, "brand-new.txt");
        assert!(!parsed.hunks.is_empty(), "untracked layer should have diff");
        assert!(
            parsed.hunks[0]
                .lines
                .iter()
                .all(|l| l.line_type == DiffLineType::Added)
        );
    }

    #[tokio::test]
    async fn test_file_diff_for_layer_default() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        setup_test_repo(dir);

        let base = merge_base(dir.to_str().unwrap(), "feature", "main")
            .await
            .unwrap();

        // None layer = default behavior (merge-base to working tree)
        let raw = file_diff_for_layer(dir.to_str().unwrap(), &base, "file.txt", None)
            .await
            .unwrap();
        let parsed = parse_unified_diff(&raw, "file.txt");
        assert!(!parsed.hunks.is_empty(), "default layer should have diff");
    }
}
