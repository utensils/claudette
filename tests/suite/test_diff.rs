use claudette::diff::parse_unified_diff;
use claudette::model::diff::*;

// ─── Empty / minimal input ──────────────────────────────────────────

/// An empty string is technically valid input. The parser should return
/// an empty FileDiff with no hunks and not panic.
#[test]
fn test_diff_parse_empty_input() {
    let result = parse_unified_diff("", "some/file.rs");
    assert!(result.hunks.is_empty());
    assert_eq!(result.path, "some/file.rs");
    assert!(!result.is_binary);
}

/// A single newline -- no actual diff content.
#[test]
fn test_diff_parse_single_newline() {
    let result = parse_unified_diff("\n", "file.rs");
    assert!(result.hunks.is_empty());
}

/// Only whitespace, no diff markers.
#[test]
fn test_diff_parse_only_whitespace() {
    let result = parse_unified_diff("   \t  \n  \n", "file.rs");
    assert!(result.hunks.is_empty());
}

/// Path is an empty string -- should still work.
#[test]
fn test_diff_parse_empty_path() {
    let result = parse_unified_diff("", "");
    assert_eq!(result.path, "");
    assert!(result.hunks.is_empty());
}

// ─── Valid unified diff parsing ─────────────────────────────────────

/// A minimal valid unified diff with one hunk adding a single line.
#[test]
fn test_diff_parse_single_add_line() {
    let diff = "@@ -0,0 +1 @@\n+hello world\n";
    let result = parse_unified_diff(diff, "hello.txt");
    assert_eq!(result.hunks.len(), 1);
    assert!(!result.hunks[0].lines.is_empty());
    // The added line should have type Added
    let added_lines: Vec<_> = result.hunks[0]
        .lines
        .iter()
        .filter(|l| l.line_type == DiffLineType::Added)
        .collect();
    assert!(!added_lines.is_empty());
}

/// A minimal diff with one removed line.
#[test]
fn test_diff_parse_single_remove_line() {
    let diff = "@@ -1 +0,0 @@\n-goodbye world\n";
    let result = parse_unified_diff(diff, "bye.txt");
    assert_eq!(result.hunks.len(), 1);
    let removed: Vec<_> = result.hunks[0]
        .lines
        .iter()
        .filter(|l| l.line_type == DiffLineType::Removed)
        .collect();
    assert!(!removed.is_empty());
}

/// A diff with context, additions, and removals.
#[test]
fn test_diff_parse_mixed_changes() {
    let diff = "\
@@ -1,3 +1,3 @@
 context line
-old line
+new line
 more context
";
    let result = parse_unified_diff(diff, "mixed.rs");
    assert_eq!(result.hunks.len(), 1);
    let hunk = &result.hunks[0];

    let context_count = hunk
        .lines
        .iter()
        .filter(|l| l.line_type == DiffLineType::Context)
        .count();
    let added_count = hunk
        .lines
        .iter()
        .filter(|l| l.line_type == DiffLineType::Added)
        .count();
    let removed_count = hunk
        .lines
        .iter()
        .filter(|l| l.line_type == DiffLineType::Removed)
        .count();

    assert!(context_count >= 2);
    assert_eq!(added_count, 1);
    assert_eq!(removed_count, 1);
}

/// Multiple hunks in a single diff.
#[test]
fn test_diff_parse_multiple_hunks() {
    let diff = "\
@@ -1,2 +1,2 @@
-old1
+new1
 same
@@ -10,2 +10,2 @@
-old2
+new2
 same2
";
    let result = parse_unified_diff(diff, "multi.rs");
    assert_eq!(result.hunks.len(), 2);
}

// ─── Malformed hunk headers ─────────────────────────────────────────

/// Hunk header with missing numbers -- should not panic.
#[test]
fn test_diff_parse_malformed_hunk_header_no_numbers() {
    let diff = "@@ -,, +,, @@\n+line\n";
    let result = parse_unified_diff(diff, "bad.rs");
    // Should either skip the malformed header or produce an empty/partial result
    // Main assertion: no panic
    let _ = result;
}

/// Hunk header with negative line numbers.
#[test]
fn test_diff_parse_negative_line_numbers() {
    let diff = "@@ --1,1 +-1,1 @@\n+line\n";
    let result = parse_unified_diff(diff, "neg.rs");
    // Should not panic
    let _ = result;
}

/// Hunk header with extremely large line numbers.
#[test]
fn test_diff_parse_huge_line_numbers() {
    let diff = "@@ -999999999,1 +999999999,1 @@\n+big line\n";
    let result = parse_unified_diff(diff, "huge.rs");
    assert!(!result.hunks.is_empty());
}

/// Hunk header with zero as start line.
#[test]
fn test_diff_parse_zero_start_line() {
    let diff = "@@ -0,0 +0,0 @@\n";
    let result = parse_unified_diff(diff, "zero.rs");
    // Should handle gracefully
    let _ = result;
}

/// Hunk header with count of 0 (empty range).
#[test]
fn test_diff_parse_zero_count_range() {
    let diff = "@@ -1,0 +1,1 @@\n+new line\n";
    let result = parse_unified_diff(diff, "zerocount.rs");
    assert!(!result.hunks.is_empty());
}

// ─── CRLF vs LF ────────────────────────────────────────────────────

/// Windows-style CRLF line endings in diff output.
#[test]
fn test_diff_parse_crlf_line_endings() {
    let diff = "@@ -1,2 +1,2 @@\r\n-old\r\n+new\r\n same\r\n";
    let result = parse_unified_diff(diff, "crlf.rs");
    // Should parse without panicking; ideally handles CRLF correctly
    assert!(!result.hunks.is_empty());
}

/// Mixed CRLF and LF.
#[test]
fn test_diff_parse_mixed_line_endings() {
    let diff = "@@ -1,2 +1,2 @@\n-old\r\n+new\n same\r\n";
    let result = parse_unified_diff(diff, "mixed_eol.rs");
    assert!(!result.hunks.is_empty());
}

// ─── Binary file detection ──────────────────────────────────────────

/// Binary file indicator in diff output.
#[test]
fn test_diff_parse_binary_file() {
    let diff = "Binary files a/image.png and b/image.png differ\n";
    let result = parse_unified_diff(diff, "image.png");
    assert!(result.is_binary, "Should detect binary file marker");
    assert!(result.hunks.is_empty());
}

/// Binary files with empty path.
#[test]
fn test_diff_parse_binary_empty_path() {
    let diff = "Binary files a/ and b/ differ\n";
    let result = parse_unified_diff(diff, "");
    assert!(result.is_binary);
}

// ─── Unicode and special characters ─────────────────────────────────

/// Diff containing Unicode (CJK, emoji) in content lines.
#[test]
fn test_diff_parse_unicode_content() {
    let diff = "@@ -1,1 +1,1 @@\n-旧行\n+新行 🎉\n";
    let result = parse_unified_diff(diff, "unicode.txt");
    assert_eq!(result.hunks.len(), 1);
}

/// Diff with null bytes in content -- adversarial binary-as-text.
#[test]
fn test_diff_parse_null_bytes_in_content() {
    let diff = "@@ -1,1 +1,1 @@\n-old\0line\n+new\0line\n";
    let result = parse_unified_diff(diff, "null.bin");
    // Should not panic
    let _ = result;
}

/// RTL override characters in diff lines.
#[test]
fn test_diff_parse_rtl_override() {
    let diff = "@@ -1,1 +1,1 @@\n-normal\n+\u{202E}desrever\n";
    let result = parse_unified_diff(diff, "rtl.txt");
    assert!(!result.hunks.is_empty());
}

// ─── Edge-case diff formats ────────────────────────────────────────

/// Diff with "\ No newline at end of file" marker.
#[test]
fn test_diff_parse_no_newline_at_eof() {
    let diff = "\
@@ -1,1 +1,1 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file
";
    let result = parse_unified_diff(diff, "noeof.rs");
    assert!(!result.hunks.is_empty());
}

/// Diff with only header lines (--- and +++) but no hunks.
#[test]
fn test_diff_parse_headers_only() {
    let diff = "--- a/file.rs\n+++ b/file.rs\n";
    let result = parse_unified_diff(diff, "file.rs");
    assert!(result.hunks.is_empty());
}

/// A very large diff (many hunks) -- performance test / no panic.
#[test]
fn test_diff_parse_many_hunks() {
    let mut diff = String::new();
    for i in 0..1000 {
        diff.push_str(&format!("@@ -{i},1 +{i},1 @@\n-old{i}\n+new{i}\n"));
    }
    let result = parse_unified_diff(&diff, "big.rs");
    assert_eq!(result.hunks.len(), 1000);
}

/// Diff with lines that look like hunk headers but are actually content.
#[test]
fn test_diff_parse_fake_hunk_header_in_content() {
    let diff = "\
@@ -1,3 +1,3 @@
 normal line
-@@ -1,1 +1,1 @@
+@@ -2,2 +2,2 @@
";
    let result = parse_unified_diff(diff, "fake.rs");
    // Should treat the inner @@ lines as content, not new hunks
    // The behavior depends on the parser -- just verify no panic
    let _ = result;
}

/// Completely garbage input that looks nothing like a diff.
#[test]
fn test_diff_parse_garbage_input() {
    let result = parse_unified_diff("this is not a diff at all\nrandom text\n42\n", "garbage.rs");
    // Non-diff content should not produce any hunks.
    assert!(result.hunks.is_empty());
    assert_eq!(result.path, "garbage.rs");
    assert!(!result.is_binary);
}

/// Line numbers in parsed diff lines should be consistent.
#[test]
fn test_diff_parse_line_numbers_consistent() {
    let diff = "\
@@ -1,3 +1,4 @@
 ctx1
-removed
+added1
+added2
 ctx2
";
    let result = parse_unified_diff(diff, "lnums.rs");
    assert_eq!(result.hunks.len(), 1);
    let hunk = &result.hunks[0];

    // Check that old_line_number is set for Context and Removed lines
    for line in &hunk.lines {
        match line.line_type {
            DiffLineType::Context => {
                assert!(line.old_line_number.is_some());
                assert!(line.new_line_number.is_some());
            }
            DiffLineType::Removed => {
                assert!(line.old_line_number.is_some());
            }
            DiffLineType::Added => {
                assert!(line.new_line_number.is_some());
            }
        }
    }
}

/// Hunk header start values should be parsed into the struct.
#[test]
fn test_diff_parse_hunk_start_values() {
    let diff = "@@ -10,3 +20,4 @@ fn example()\n ctx\n-old\n+new1\n+new2\n ctx\n";
    let result = parse_unified_diff(diff, "starts.rs");
    assert_eq!(result.hunks.len(), 1);
    assert_eq!(result.hunks[0].old_start, 10);
    assert_eq!(result.hunks[0].new_start, 20);
}

/// Hunk header with function context (text after @@).
#[test]
fn test_diff_parse_hunk_header_with_context() {
    let diff = "@@ -5,3 +5,3 @@ fn my_function() {\n ctx\n-old\n+new\n";
    let result = parse_unified_diff(diff, "ctx.rs");
    assert_eq!(result.hunks.len(), 1);
    // The header should include the function context
    assert!(result.hunks[0].header.contains("@@"));
}

/// Diff with only additions (new file).
#[test]
fn test_diff_parse_new_file() {
    let diff = "\
@@ -0,0 +1,3 @@
+line1
+line2
+line3
";
    let result = parse_unified_diff(diff, "new_file.rs");
    assert_eq!(result.hunks.len(), 1);
    assert_eq!(
        result.hunks[0]
            .lines
            .iter()
            .filter(|l| l.line_type == DiffLineType::Added)
            .count(),
        3
    );
}

/// Diff with only deletions (deleted file).
#[test]
fn test_diff_parse_deleted_file() {
    let diff = "\
@@ -1,3 +0,0 @@
-line1
-line2
-line3
";
    let result = parse_unified_diff(diff, "deleted.rs");
    assert_eq!(result.hunks.len(), 1);
    assert_eq!(
        result.hunks[0]
            .lines
            .iter()
            .filter(|l| l.line_type == DiffLineType::Removed)
            .count(),
        3
    );
}
