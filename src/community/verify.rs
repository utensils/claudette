//! Content-addressed verification for community contributions.
//!
//! The trust anchor for a contribution is its `sha256` — a hash
//! computed from the *content of the directory*, independent of any
//! tarball framing. Both `claudette-community/scripts/generate-registry.ts`
//! and Claudette compute the same value, so the registry's published
//! `sha256` can be checked against bytes Claudette has on disk after
//! extraction.
//!
//! ## Hash format
//!
//! ```text
//! sha256(
//!   JSON.stringify(
//!     [{ path: "<rel-path>", sha256: "<hex sha256 of file bytes>" }, ...]
//!     .sort_by(path)
//!   )
//! )
//! ```
//!
//! - `path` uses forward slashes regardless of platform.
//! - The array is sorted lexicographically by `path`.
//! - JSON serialization uses `serde_json` defaults (no whitespace,
//!   keys in insertion order — but we control the keys' order via the
//!   struct).
//! - The empty directory hashes to `sha256("[]")`.
//!
//! See TDD #567 for why we chose this over a deterministic-tarball hash.

use std::path::Path;

use serde::Serialize;
use sha2::{Digest, Sha256};

#[derive(Debug)]
pub enum VerifyError {
    Io {
        path: String,
        source: std::io::Error,
    },
    Traversal(String),
    Symlink(String),
    NonUtf8Path(String),
    HashMismatch {
        expected: String,
        actual: String,
    },
}

impl std::fmt::Display for VerifyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io { path, source } => write!(f, "io error reading {path}: {source}"),
            Self::Traversal(p) => write!(f, "path traversal: {p}"),
            Self::Symlink(p) => write!(f, "symlink rejected: {p}"),
            Self::NonUtf8Path(p) => write!(f, "non-utf8 path: {p}"),
            Self::HashMismatch { expected, actual } => {
                write!(
                    f,
                    "content hash mismatch: expected {expected}, got {actual}"
                )
            }
        }
    }
}

impl std::error::Error for VerifyError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            _ => None,
        }
    }
}

#[derive(Serialize)]
struct Entry {
    path: String,
    sha256: String,
}

/// Compute the content hash of a directory tree using the canonical
/// scheme above. Walks `dir` recursively, hashes each file's bytes,
/// emits a sorted array, and sha256s the JSON.
///
/// Rejects symlinks (defense in depth — the install path validates
/// the tarball before extraction, but if an extracted file is later
/// replaced by a symlink we want this hash to fail noisily).
pub fn content_hash(dir: &Path) -> Result<String, VerifyError> {
    let mut entries: Vec<Entry> = Vec::new();
    walk_into(dir, dir, &mut entries)?;
    entries.sort_by(|a, b| a.path.cmp(&b.path));

    let json = serde_json::to_string(&entries).expect("entries serialize");
    let mut hasher = Sha256::new();
    hasher.update(json.as_bytes());
    Ok(hex(&hasher.finalize()))
}

/// Verify that `dir` matches the expected `sha256`. Returns `Ok(())`
/// on match, [`VerifyError::HashMismatch`] otherwise.
pub fn verify(dir: &Path, expected: &str) -> Result<(), VerifyError> {
    let actual = content_hash(dir)?;
    if !constant_time_eq(actual.as_bytes(), expected.as_bytes()) {
        return Err(VerifyError::HashMismatch {
            expected: expected.into(),
            actual,
        });
    }
    Ok(())
}

fn walk_into(root: &Path, dir: &Path, entries: &mut Vec<Entry>) -> Result<(), VerifyError> {
    let read_dir = std::fs::read_dir(dir).map_err(|e| VerifyError::Io {
        path: dir.display().to_string(),
        source: e,
    })?;
    for ent in read_dir {
        let ent = ent.map_err(|e| VerifyError::Io {
            path: dir.display().to_string(),
            source: e,
        })?;
        let path = ent.path();

        // Reject symlinks unconditionally — content hashing must
        // reflect the bytes that will be loaded by the runtime, and
        // following a symlink could read content outside `root`.
        // We use `DirEntry::file_type` rather than `metadata` — both
        // use `lstat` on Unix (per stdlib docs, `DirEntry::metadata`
        // is also non-traversing), but `file_type` is more direct and
        // saves a syscall when we only care about the kind.
        let ft = ent.file_type().map_err(|e| VerifyError::Io {
            path: path.display().to_string(),
            source: e,
        })?;
        if ft.is_symlink() {
            return Err(VerifyError::Symlink(path.display().to_string()));
        }
        if ft.is_dir() {
            // Skip well-known noise that the generator skips too.
            if let Some(name) = path.file_name().and_then(|n| n.to_str())
                && name == ".git"
            {
                continue;
            }
            walk_into(root, &path, entries)?;
            continue;
        }
        if !ft.is_file() {
            continue;
        }
        // Skip the generator's noise list.
        if let Some(name) = path.file_name().and_then(|n| n.to_str())
            && name == ".DS_Store"
        {
            continue;
        }

        let rel = path.strip_prefix(root).map_err(|_| {
            VerifyError::Traversal(format!(
                "path {} outside root {}",
                path.display(),
                root.display()
            ))
        })?;
        let rel_str = rel
            .to_str()
            .ok_or_else(|| VerifyError::NonUtf8Path(rel.display().to_string()))?
            .replace('\\', "/");

        let bytes = std::fs::read(&path).map_err(|e| VerifyError::Io {
            path: path.display().to_string(),
            source: e,
        })?;
        let mut h = Sha256::new();
        h.update(&bytes);
        entries.push(Entry {
            path: rel_str,
            sha256: hex(&h.finalize()),
        });
    }
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        use std::fmt::Write as _;
        let _ = write!(&mut s, "{b:02x}");
    }
    s
}

/// Constant-time byte equality. Fall back to short-circuit for
/// length mismatch — secret comparison only happens once length checks
/// out, which is the case the timing attack matters for.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn empty_dir_hashes_to_sha256_of_empty_array() {
        let tmp = tempdir().unwrap();
        let h = content_hash(tmp.path()).unwrap();
        let mut hasher = Sha256::new();
        hasher.update(b"[]");
        let expected = hex(&hasher.finalize());
        assert_eq!(h, expected);
    }

    #[test]
    fn single_file_hash_is_stable() {
        let tmp = tempdir().unwrap();
        fs::write(tmp.path().join("a.txt"), b"hello").unwrap();
        let a = content_hash(tmp.path()).unwrap();
        let b = content_hash(tmp.path()).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn rename_changes_hash() {
        let tmp = tempdir().unwrap();
        fs::write(tmp.path().join("a.txt"), b"hello").unwrap();
        let h1 = content_hash(tmp.path()).unwrap();
        fs::rename(tmp.path().join("a.txt"), tmp.path().join("b.txt")).unwrap();
        let h2 = content_hash(tmp.path()).unwrap();
        assert_ne!(h1, h2);
    }

    #[test]
    fn content_change_changes_hash() {
        let tmp = tempdir().unwrap();
        fs::write(tmp.path().join("a.txt"), b"hello").unwrap();
        let h1 = content_hash(tmp.path()).unwrap();
        fs::write(tmp.path().join("a.txt"), b"world").unwrap();
        let h2 = content_hash(tmp.path()).unwrap();
        assert_ne!(h1, h2);
    }

    #[test]
    fn nested_directories_are_walked() {
        let tmp = tempdir().unwrap();
        fs::create_dir_all(tmp.path().join("nested/deep")).unwrap();
        fs::write(tmp.path().join("nested/deep/file"), b"x").unwrap();
        fs::write(tmp.path().join("top"), b"y").unwrap();
        let h = content_hash(tmp.path()).unwrap();
        assert_eq!(h.len(), 64);
    }

    #[test]
    fn ds_store_is_skipped() {
        let tmp = tempdir().unwrap();
        fs::write(tmp.path().join("a.txt"), b"hello").unwrap();
        let h_before = content_hash(tmp.path()).unwrap();
        fs::write(tmp.path().join(".DS_Store"), b"junk").unwrap();
        let h_after = content_hash(tmp.path()).unwrap();
        assert_eq!(h_before, h_after, ".DS_Store should not affect hash");
    }

    #[cfg(unix)]
    #[test]
    fn symlink_is_rejected() {
        use std::os::unix::fs::symlink;
        let tmp = tempdir().unwrap();
        fs::write(tmp.path().join("a.txt"), b"hello").unwrap();
        symlink("/etc/passwd", tmp.path().join("link")).unwrap();
        let err = content_hash(tmp.path()).unwrap_err();
        assert!(matches!(err, VerifyError::Symlink(_)), "got {err:?}");
    }

    /// Regression: ent.metadata() follows symlinks, so a symlink to a
    /// real file inside the install dir would have hashed as a normal
    /// file under the broken implementation. Switching to
    /// ent.file_type() rejects the link before we ever read it.
    #[cfg(unix)]
    #[test]
    fn symlink_to_real_file_is_rejected_not_followed() {
        use std::os::unix::fs::symlink;
        let tmp = tempdir().unwrap();
        fs::write(tmp.path().join("real.txt"), b"contents-of-real").unwrap();
        symlink("real.txt", tmp.path().join("alias.txt")).unwrap();
        let err = content_hash(tmp.path()).unwrap_err();
        assert!(
            matches!(err, VerifyError::Symlink(_)),
            "expected Symlink error, got {err:?}"
        );
    }

    #[test]
    fn verify_passes_for_correct_hash() {
        let tmp = tempdir().unwrap();
        fs::write(tmp.path().join("a.txt"), b"hello").unwrap();
        let h = content_hash(tmp.path()).unwrap();
        verify(tmp.path(), &h).unwrap();
    }

    #[test]
    fn verify_fails_for_wrong_hash() {
        let tmp = tempdir().unwrap();
        fs::write(tmp.path().join("a.txt"), b"hello").unwrap();
        let bogus = "0".repeat(64);
        let err = verify(tmp.path(), &bogus).unwrap_err();
        assert!(matches!(err, VerifyError::HashMismatch { .. }));
    }

    #[test]
    fn content_hash_is_64_char_lowercase_hex() {
        // Sanity-check the output shape. Cross-implementation
        // determinism (Bun's TS generator producing the same digest
        // as our Rust verifier for a given directory) is exercised
        // by claudette-community's CI rather than this in-tree unit
        // test — the end-to-end install path round-trips a real
        // contribution through both sides during integration.
        let tmp = tempdir().unwrap();
        fs::write(tmp.path().join("plugin.json"), br#"{"name":"x"}"#).unwrap();
        fs::create_dir(tmp.path().join("grammars")).unwrap();
        fs::write(tmp.path().join("grammars/x.json"), b"{}").unwrap();
        let h = content_hash(tmp.path()).unwrap();
        assert_eq!(h.len(), 64);
        assert!(
            h.chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        );
    }
}
