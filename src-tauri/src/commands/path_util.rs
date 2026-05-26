//! Path-comparison helpers shared across destructive Tauri commands.
//!
//! These exist because the obvious `Path::canonicalize` + string
//! comparison subtly fails in two cases that matter for our purge
//! flows:
//!
//! 1. macOS `/tmp` ↔ `/private/tmp` symlink: a DB row stored as
//!    `/tmp/claudette/foo/bar` will canonicalize to
//!    `/private/tmp/claudette/foo/bar` if you have an absolute path
//!    *and* canonicalize succeeds. Comparing canonical vs raw across
//!    the boundary silently mismatches.
//! 2. The stored path's directory no longer exists on disk. In that
//!    case `canonicalize` returns `Err` and you have to fall back to
//!    the raw string — but the *other* side of the comparison may
//!    still have canonicalized successfully, leaving an asymmetric
//!    compare that lets the guard slip past.
//!
//! Use `canon_or_raw` for any path comparison where either side may
//! have been canonicalized or may have failed canonicalization. Use
//! `canon_with_parent_fallback` when the leaf may have been deleted
//! but the parent still exists — useful for tracked-path sets where
//! a deleted-on-disk DB row should still produce a canonical
//! comparison key.

use std::path::Path;

/// Best-effort canonicalize: returns the canonical path string when
/// canonicalize succeeds, otherwise the raw string unchanged. Falls
/// back on *any* error (NotFound, permission denied, broken symlink,
/// ENAMETOOLONG, etc.) — the returned path is NOT validated to exist.
pub(crate) fn canon_or_raw(p: &str) -> String {
    std::fs::canonicalize(p)
        .map(|c| c.to_string_lossy().to_string())
        .unwrap_or_else(|_| p.to_string())
}

/// Best-effort canonicalize with a parent fallback. If the full path
/// canonicalizes, returns that. Otherwise tries to canonicalize the
/// parent and re-join the file_name component, so a path whose leaf
/// was deleted (but whose parent still exists) still produces a
/// canonical-prefixed comparison key. Falls back to the raw string
/// only when even the parent can't be resolved.
pub(crate) fn canon_with_parent_fallback(p: &str) -> String {
    if let Ok(c) = std::fs::canonicalize(p) {
        return c.to_string_lossy().to_string();
    }
    let path = Path::new(p);
    if let (Some(parent), Some(name)) = (path.parent(), path.file_name())
        && let Ok(parent_canon) = std::fs::canonicalize(parent)
    {
        return parent_canon.join(name).to_string_lossy().to_string();
    }
    p.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canon_or_raw_returns_raw_for_nonexistent_path() {
        let result = canon_or_raw("/does/not/exist/at/all");
        assert_eq!(result, "/does/not/exist/at/all");
    }

    #[test]
    fn canon_or_raw_canonicalizes_existing_path() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().to_str().unwrap();
        let result = canon_or_raw(p);
        // canonicalize succeeded, so result equals the canonical form.
        let expected = std::fs::canonicalize(p)
            .unwrap()
            .to_string_lossy()
            .to_string();
        assert_eq!(result, expected);
    }

    #[test]
    fn canon_with_parent_fallback_resolves_via_parent_when_leaf_missing() {
        let dir = tempfile::tempdir().unwrap();
        let missing_leaf = dir.path().join("does-not-exist");
        let result = canon_with_parent_fallback(missing_leaf.to_str().unwrap());
        // Parent existed, so result should be parent_canon + leaf name.
        let expected = std::fs::canonicalize(dir.path())
            .unwrap()
            .join("does-not-exist")
            .to_string_lossy()
            .to_string();
        assert_eq!(result, expected);
    }

    #[test]
    fn canon_with_parent_fallback_returns_raw_when_neither_resolves() {
        let result = canon_with_parent_fallback("/totally/fake/path");
        assert_eq!(result, "/totally/fake/path");
    }
}
