use std::path::{Path, PathBuf};

/// Default per-read byte cap used by callers that don't specify their own
/// (chat @-mentions, diff copy-to-clipboard). Sized to bound memory
/// pressure on those paths; the file viewer/editor opts into a larger cap.
pub const DEFAULT_MAX_FILE_SIZE: usize = 100 * 1024; // 100 KB

fn escape_xml_attr(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Result of reading a file from a worktree with safety checks applied.
pub struct SafeFileRead {
    pub content: Option<String>,
    pub is_binary: bool,
    pub size_bytes: u64,
    pub truncated: bool,
}

/// Result of a raw-bytes read used when the caller needs the original file
/// contents (e.g. rendering an image), not a UTF-8-lossy text view.
pub struct RawFileRead {
    pub bytes: Vec<u8>,
    pub size_bytes: u64,
    pub truncated: bool,
}

/// Read a file from a worktree with path-traversal protection, binary
/// detection, and `DEFAULT_MAX_FILE_SIZE` truncation.
///
/// Returns `None` if the file is missing, the path escapes the worktree, or
/// the worktree path itself cannot be resolved.
pub async fn read_worktree_file(worktree_path: &Path, relative_path: &str) -> Option<SafeFileRead> {
    read_worktree_file_with_limit(worktree_path, relative_path, DEFAULT_MAX_FILE_SIZE).await
}

/// Same as [`read_worktree_file`] but with a caller-specified truncation
/// cap. Used by the file viewer/editor, which needs to open files larger
/// than the default 100 KB.
pub async fn read_worktree_file_with_limit(
    worktree_path: &Path,
    relative_path: &str,
    max_bytes: usize,
) -> Option<SafeFileRead> {
    let worktree_canonical = tokio::fs::canonicalize(worktree_path).await.ok()?;
    resolve_and_read(&worktree_canonical, worktree_path, relative_path, max_bytes).await
}

/// Read raw bytes from a file in a worktree. Used for image rendering and
/// other binary previews where UTF-8 lossy conversion is not appropriate.
/// Path-traversal protection still applies; the read is capped at
/// `max_bytes` to bound memory pressure.
pub async fn read_worktree_file_bytes(
    worktree_path: &Path,
    relative_path: &str,
    max_bytes: usize,
) -> Option<RawFileRead> {
    let worktree_canonical = tokio::fs::canonicalize(worktree_path).await.ok()?;
    let joined = worktree_path.join(relative_path);
    let file_canonical = tokio::fs::canonicalize(&joined).await.ok()?;
    if !file_canonical.starts_with(&worktree_canonical) {
        return None;
    }
    let metadata = tokio::fs::metadata(&file_canonical).await.ok()?;
    let size_bytes = metadata.len();

    use tokio::io::AsyncReadExt;
    let file = tokio::fs::File::open(&file_canonical).await.ok()?;
    let read_limit = (max_bytes as u64).saturating_add(1);
    let mut raw = Vec::with_capacity(read_limit.min(size_bytes + 1) as usize);
    file.take(read_limit).read_to_end(&mut raw).await.ok()?;
    let truncated = raw.len() > max_bytes;
    if truncated {
        raw.truncate(max_bytes);
    }
    Some(RawFileRead {
        bytes: raw,
        size_bytes,
        truncated,
    })
}

/// Write UTF-8 text to a file in a worktree with path-traversal protection.
///
/// Resolves the parent directory's canonical path and verifies it's still
/// inside the worktree before writing. Refuses to follow symlinks that
/// point outside the worktree. Creates the file if it doesn't yet exist;
/// truncates if it does.
///
/// Returns `Err` with a human-readable reason on failure (path escapes,
/// IO error, etc.).
pub async fn write_worktree_file(
    worktree_path: &Path,
    relative_path: &str,
    content: &str,
) -> Result<(), String> {
    let worktree_canonical = tokio::fs::canonicalize(worktree_path)
        .await
        .map_err(|e| format!("canonicalize worktree: {e}"))?;
    let joined = worktree_path.join(relative_path);

    // Canonicalize the parent — the file may not exist yet, so we can't
    // canonicalize the file itself. The parent must exist and must resolve
    // to a path inside the worktree.
    let parent = joined
        .parent()
        .ok_or_else(|| "no parent directory".to_string())?;
    let parent_canonical = tokio::fs::canonicalize(parent)
        .await
        .map_err(|e| format!("canonicalize parent: {e}"))?;
    if !parent_canonical.starts_with(&worktree_canonical) {
        return Err("path escapes worktree".to_string());
    }

    // Reject the file path itself if it's a symlink pointing outside the
    // worktree (canonicalize follows links). When the file already exists,
    // verify its canonical path is still inside the worktree.
    if let Ok(file_canonical) = tokio::fs::canonicalize(&joined).await
        && !file_canonical.starts_with(&worktree_canonical)
    {
        return Err("path escapes worktree".to_string());
    }

    let final_path = parent_canonical.join(
        joined
            .file_name()
            .ok_or_else(|| "no file name".to_string())?,
    );
    tokio::fs::write(&final_path, content)
        .await
        .map_err(|e| format!("write: {e}"))
}

/// Inner helper: resolve a relative path against the worktree, validate
/// containment, read with binary/truncation checks.
async fn resolve_and_read(
    worktree_canonical: &Path,
    worktree_path: &Path,
    relative_path: &str,
    max_bytes: usize,
) -> Option<SafeFileRead> {
    let joined = worktree_path.join(relative_path);
    let file_canonical = tokio::fs::canonicalize(&joined).await.ok()?;

    if !file_canonical.starts_with(worktree_canonical) {
        return None;
    }

    read_checked(&file_canonical, max_bytes).await
}

/// Read a canonical path with binary detection and size truncation.
async fn read_checked(path: &PathBuf, max_bytes: usize) -> Option<SafeFileRead> {
    let metadata = tokio::fs::metadata(path).await.ok()?;
    let size_bytes = metadata.len();

    // Read at most max_bytes + 1 bytes to detect truncation without
    // buffering the entire file for large inputs.
    use tokio::io::AsyncReadExt;
    let file = tokio::fs::File::open(path).await.ok()?;
    let read_limit = (max_bytes as u64).saturating_add(1);
    let mut raw = Vec::with_capacity(read_limit.min(size_bytes + 1) as usize);
    file.take(read_limit).read_to_end(&mut raw).await.ok()?;

    // Binary detection: check first 8 KB for null bytes.
    let check_len = raw.len().min(8192);
    if raw[..check_len].contains(&0) {
        return Some(SafeFileRead {
            content: None,
            is_binary: true,
            size_bytes,
            truncated: false,
        });
    }

    let truncated = raw.len() > max_bytes;
    let usable = if truncated {
        &raw[..max_bytes]
    } else {
        &raw[..]
    };
    let text = String::from_utf8_lossy(usable).into_owned();

    Some(SafeFileRead {
        content: Some(text),
        is_binary: false,
        size_bytes,
        truncated,
    })
}

/// Expand @-file mentions into `<referenced-file>` XML blocks prepended to the
/// prompt.
///
/// For each relative path in `mentioned_files`, reads the file from
/// `worktree_path` with path-traversal protection, binary detection, and 100 KB
/// truncation. Unreadable, binary, or missing files are silently skipped.
pub async fn expand_file_mentions(
    worktree_path: &Path,
    content: &str,
    mentioned_files: &[String],
) -> String {
    if mentioned_files.is_empty() {
        return content.to_string();
    }

    let worktree_canonical = match tokio::fs::canonicalize(worktree_path).await {
        Ok(p) => p,
        Err(_) => return content.to_string(),
    };

    let mut blocks = Vec::new();

    for relative_path in mentioned_files {
        let read = match resolve_and_read(
            &worktree_canonical,
            worktree_path,
            relative_path,
            DEFAULT_MAX_FILE_SIZE,
        )
        .await
        {
            Some(r) => r,
            None => continue,
        };

        let text = match read.content {
            Some(t) => t,
            None => continue, // binary
        };

        let escaped_path = escape_xml_attr(relative_path);
        let mut block =
            format!("<referenced-file path=\"{escaped_path}\">\n{text}\n</referenced-file>");
        if read.truncated {
            block.push_str(&format!(
                "\n(Note: file truncated at 100KB, total size {} bytes)",
                read.size_bytes
            ));
        }
        blocks.push(block);
    }

    if blocks.is_empty() {
        return content.to_string();
    }

    format!("{}\n\n{content}", blocks.join("\n\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[tokio::test]
    async fn test_read_worktree_file_success() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("hello.txt"), "world").unwrap();

        let result = read_worktree_file(dir.path(), "hello.txt").await.unwrap();
        assert_eq!(result.content.unwrap(), "world");
        assert!(!result.is_binary);
        assert!(!result.truncated);
    }

    #[tokio::test]
    async fn test_read_worktree_file_missing() {
        let dir = TempDir::new().unwrap();
        assert!(read_worktree_file(dir.path(), "nope.txt").await.is_none());
    }

    #[tokio::test]
    async fn test_read_worktree_file_traversal() {
        let dir = TempDir::new().unwrap();
        assert!(
            read_worktree_file(dir.path(), "../../etc/passwd")
                .await
                .is_none()
        );
    }

    #[tokio::test]
    async fn test_read_worktree_file_binary() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("bin"), b"\x00\x01\x02").unwrap();

        let result = read_worktree_file(dir.path(), "bin").await.unwrap();
        assert!(result.is_binary);
        assert!(result.content.is_none());
    }

    #[tokio::test]
    async fn test_expand_empty_mentions() {
        let dir = TempDir::new().unwrap();
        let result = expand_file_mentions(dir.path(), "hello", &[]).await;
        assert_eq!(result, "hello");
    }

    #[tokio::test]
    async fn test_expand_single_file() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("foo.txt"), "file content").unwrap();

        let result = expand_file_mentions(dir.path(), "fix this", &["foo.txt".to_string()]).await;

        assert!(result.contains("<referenced-file path=\"foo.txt\">"));
        assert!(result.contains("file content"));
        assert!(result.ends_with("fix this"));
    }

    #[tokio::test]
    async fn test_expand_missing_file_skipped() {
        let dir = TempDir::new().unwrap();

        let result =
            expand_file_mentions(dir.path(), "hello", &["nonexistent.txt".to_string()]).await;

        assert_eq!(result, "hello");
    }

    #[tokio::test]
    async fn test_expand_path_traversal_blocked() {
        let dir = TempDir::new().unwrap();

        let result =
            expand_file_mentions(dir.path(), "hello", &["../../etc/passwd".to_string()]).await;

        assert_eq!(result, "hello");
    }

    #[tokio::test]
    async fn test_expand_binary_file_skipped() {
        let dir = TempDir::new().unwrap();
        let mut data = vec![0u8; 100];
        data[50] = 0; // null byte
        fs::write(dir.path().join("binary.bin"), &data).unwrap();

        let result = expand_file_mentions(dir.path(), "hello", &["binary.bin".to_string()]).await;

        assert_eq!(result, "hello");
    }

    #[tokio::test]
    async fn test_expand_multiple_files() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("a.txt"), "aaa").unwrap();
        fs::write(dir.path().join("b.txt"), "bbb").unwrap();

        let result = expand_file_mentions(
            dir.path(),
            "fix both",
            &["a.txt".to_string(), "b.txt".to_string()],
        )
        .await;

        assert!(result.contains("<referenced-file path=\"a.txt\">"));
        assert!(result.contains("<referenced-file path=\"b.txt\">"));
        assert!(result.ends_with("fix both"));
    }

    #[tokio::test]
    async fn test_expand_truncates_large_file() {
        let dir = TempDir::new().unwrap();
        let data = "x".repeat(200 * 1024); // 200KB
        fs::write(dir.path().join("big.txt"), &data).unwrap();

        let result = expand_file_mentions(dir.path(), "check", &["big.txt".to_string()]).await;

        assert!(result.contains("(Note: file truncated at 100KB"));
        assert!(result.contains("total size 204800 bytes"));
    }

    #[tokio::test]
    async fn test_read_with_custom_limit_returns_full_content_when_under_cap() {
        let dir = TempDir::new().unwrap();
        let data = "x".repeat(150 * 1024); // 150 KB — over default cap.
        fs::write(dir.path().join("file.txt"), &data).unwrap();

        let r = read_worktree_file_with_limit(dir.path(), "file.txt", 1024 * 1024)
            .await
            .unwrap();
        assert!(!r.truncated);
        assert_eq!(r.content.unwrap().len(), 150 * 1024);
    }

    #[tokio::test]
    async fn test_read_with_custom_limit_truncates_above_cap() {
        let dir = TempDir::new().unwrap();
        let data = "x".repeat(150 * 1024);
        fs::write(dir.path().join("file.txt"), &data).unwrap();

        let r = read_worktree_file_with_limit(dir.path(), "file.txt", 50 * 1024)
            .await
            .unwrap();
        assert!(r.truncated);
        assert_eq!(r.content.unwrap().len(), 50 * 1024);
        assert_eq!(r.size_bytes, 150 * 1024);
    }

    #[tokio::test]
    async fn test_read_bytes_returns_raw() {
        let dir = TempDir::new().unwrap();
        let data: Vec<u8> = (0u8..=200u8).collect();
        fs::write(dir.path().join("blob.bin"), &data).unwrap();

        let r = read_worktree_file_bytes(dir.path(), "blob.bin", 1024)
            .await
            .unwrap();
        assert_eq!(r.bytes, data);
        assert!(!r.truncated);
    }

    #[tokio::test]
    async fn test_read_bytes_truncates() {
        let dir = TempDir::new().unwrap();
        let data: Vec<u8> = vec![0xFFu8; 300];
        fs::write(dir.path().join("blob.bin"), &data).unwrap();

        let r = read_worktree_file_bytes(dir.path(), "blob.bin", 100)
            .await
            .unwrap();
        assert_eq!(r.bytes.len(), 100);
        assert_eq!(r.size_bytes, 300);
        assert!(r.truncated);
    }

    #[tokio::test]
    async fn test_read_bytes_blocks_traversal() {
        let dir = TempDir::new().unwrap();
        assert!(
            read_worktree_file_bytes(dir.path(), "../../etc/passwd", 1024)
                .await
                .is_none()
        );
    }

    #[tokio::test]
    async fn test_write_creates_file() {
        let dir = TempDir::new().unwrap();
        write_worktree_file(dir.path(), "out.txt", "hello\n")
            .await
            .unwrap();
        assert_eq!(
            fs::read_to_string(dir.path().join("out.txt")).unwrap(),
            "hello\n"
        );
    }

    #[tokio::test]
    async fn test_write_overwrites_existing() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("existing.txt"), "old").unwrap();
        write_worktree_file(dir.path(), "existing.txt", "new")
            .await
            .unwrap();
        assert_eq!(
            fs::read_to_string(dir.path().join("existing.txt")).unwrap(),
            "new"
        );
    }

    #[tokio::test]
    async fn test_write_blocks_traversal() {
        let dir = TempDir::new().unwrap();
        // Parent canonicalizes outside the worktree, so this should fail.
        let err = write_worktree_file(dir.path(), "../escape.txt", "x")
            .await
            .unwrap_err();
        assert!(err.contains("escapes worktree"), "got: {err}");
    }

    #[tokio::test]
    async fn test_write_into_existing_subdirectory() {
        let dir = TempDir::new().unwrap();
        fs::create_dir(dir.path().join("sub")).unwrap();
        write_worktree_file(dir.path(), "sub/file.txt", "ok")
            .await
            .unwrap();
        assert_eq!(
            fs::read_to_string(dir.path().join("sub").join("file.txt")).unwrap(),
            "ok"
        );
    }
}
