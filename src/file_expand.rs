use std::path::Path;

const MAX_FILE_SIZE: usize = 100 * 1024; // 100 KB

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
        let joined = worktree_path.join(relative_path);

        // Path traversal protection.
        let file_canonical = match tokio::fs::canonicalize(&joined).await {
            Ok(p) => p,
            Err(_) => continue,
        };
        if !file_canonical.starts_with(&worktree_canonical) {
            continue;
        }

        // Read file bytes.
        let raw = match tokio::fs::read(&file_canonical).await {
            Ok(bytes) => bytes,
            Err(_) => continue,
        };

        // Binary detection: check first 8 KB for null bytes.
        let check_len = raw.len().min(8192);
        if raw[..check_len].contains(&0) {
            continue;
        }

        let truncated = raw.len() > MAX_FILE_SIZE;
        let usable = if truncated {
            &raw[..MAX_FILE_SIZE]
        } else {
            &raw[..]
        };
        let text = String::from_utf8_lossy(usable);

        let mut block =
            format!("<referenced-file path=\"{relative_path}\">\n{text}\n</referenced-file>");
        if truncated {
            block.push_str(&format!(
                "\n(Note: file truncated at 100KB, total size {} bytes)",
                raw.len()
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
}
