use std::collections::HashSet;
use std::fmt;
use std::path::Path;

use crate::model::CheckpointFile;

/// Maximum file size to include in a snapshot (10 MB).
const MAX_SNAPSHOT_FILE_SIZE: u64 = 10 * 1024 * 1024;

/// Default per-workspace cap on the number of recent checkpoints that retain
/// restorable file snapshots. Older checkpoints keep their conversation rows
/// (chat history, tool activities) but their `checkpoint_files` rows are
/// pruned and `has_file_state` flips to false — restore on those becomes a
/// safe no-op (`src-tauri/src/commands/chat/checkpoint.rs` already guards on
/// the flag). Settable via the `checkpoint_retention_count` app_setting.
///
/// Default and bounds match #582 — the rationale is documented in
/// `site/src/content/docs/features/settings.mdx`.
pub const DEFAULT_CHECKPOINT_RETENTION_COUNT: usize = 50;
pub const MIN_CHECKPOINT_RETENTION_COUNT: usize = 1;
pub const MAX_CHECKPOINT_RETENTION_COUNT: usize = 1000;

#[derive(Debug)]
pub enum SnapshotError {
    Io(String),
    Db(String),
    Git(String),
}

impl fmt::Display for SnapshotError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(msg) => write!(f, "Snapshot IO error: {msg}"),
            Self::Db(msg) => write!(f, "Snapshot DB error: {msg}"),
            Self::Git(msg) => write!(f, "Snapshot git error: {msg}"),
        }
    }
}

impl std::error::Error for SnapshotError {}

impl From<rusqlite::Error> for SnapshotError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Db(e.to_string())
    }
}

impl From<std::io::Error> for SnapshotError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e.to_string())
    }
}

/// Enumerate all files in a worktree that git tracks or would track
/// (respects .gitignore). Returns NUL-separated paths.
async fn list_worktree_files(worktree_path: &str) -> Result<Vec<String>, SnapshotError> {
    let output = crate::process::command(crate::git::resolve_git_path_blocking())
        .args(["-C", worktree_path])
        .args([
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ])
        .output()
        .await
        .map_err(|e| SnapshotError::Git(e.to_string()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(SnapshotError::Git(stderr));
    }

    let paths: Vec<String> = output
        .stdout
        .split(|&b| b == 0)
        .filter(|s| !s.is_empty())
        .map(|s| String::from_utf8_lossy(s).into_owned())
        .collect();

    Ok(paths)
}

/// Collect all files from a worktree for snapshotting.
/// Skips symlinks, files larger than `MAX_SNAPSHOT_FILE_SIZE`, and
/// anything that isn't a regular file. Uses `symlink_metadata` to
/// avoid following symlinks.
pub async fn collect_worktree_files(
    worktree_path: &str,
) -> Result<Vec<(String, Vec<u8>, u32)>, SnapshotError> {
    let paths = list_worktree_files(worktree_path).await?;
    let base = Path::new(worktree_path);
    let mut files = Vec::with_capacity(paths.len());

    for rel_path in paths {
        let full_path = base.join(&rel_path);

        // Use symlink_metadata to avoid following symlinks — we skip
        // symlinks entirely rather than snapshotting their targets.
        let metadata = match tokio::fs::symlink_metadata(&full_path).await {
            Ok(m) => m,
            Err(_) => continue, // file may have been deleted between ls-files and read
        };

        if !metadata.is_file() {
            continue; // skip symlinks, directories, and other non-regular files
        }

        if metadata.len() > MAX_SNAPSHOT_FILE_SIZE {
            continue;
        }

        let content = match tokio::fs::read(&full_path).await {
            Ok(c) => c,
            Err(_) => continue,
        };

        #[cfg(unix)]
        let mode = {
            use std::os::unix::fs::PermissionsExt;
            metadata.permissions().mode()
        };
        #[cfg(not(unix))]
        let mode = 33188u32; // 0o100644

        files.push((rel_path, content, mode));
    }

    Ok(files)
}

/// Snapshot all worktree files into the `checkpoint_files` table. Returns
/// the **post-prune** value of `has_file_state` — i.e. whether the checkpoint
/// still has restorable file rows after the retention cap runs. Callers
/// can write this directly to a `ConversationCheckpoint.has_file_state`
/// payload without worrying about a stale snapshot count diverging from
/// the DB-derived `EXISTS` lookup. Opens its own DB connection so it can
/// be called from async contexts without holding a non-Send `Database`
/// across await points.
///
/// Bytes are deduplicated into `checkpoint_blobs` keyed by sha256 — repeated
/// checkpoints of the same file pay only the reference-row cost, not the
/// full bytes. `retention_count` caps how many recent checkpoints in
/// `workspace_id` retain file restore data; older `checkpoint_files` rows
/// (and any blobs they exclusively referenced) are pruned in the same
/// transaction. If the just-inserted checkpoint is *itself* outside the
/// retention window — e.g. a tiny cap, or a late snapshot completing
/// after a newer turn already wrote one — the returned bool is `false`
/// because the rows we just inserted got pruned away, which matches what
/// the `has_checkpoint_files` read will see.
pub async fn save_snapshot(
    db_path: &Path,
    workspace_id: &str,
    checkpoint_id: &str,
    worktree_path: &str,
    retention_count: usize,
) -> Result<bool, SnapshotError> {
    let collected = collect_worktree_files(worktree_path).await?;

    // Pre-hash on the calling thread BEFORE opening the write transaction.
    // Holding the SQLite write lock while sha256-ing megabytes of content
    // would starve foreground commands (sidebar refresh, chat sends, etc.)
    // on long snapshots. The hashes feed the dedupe upsert directly, so
    // doing them up front trades nothing.
    let files: Vec<CheckpointFile> = collected
        .into_iter()
        .map(|(path, content, mode)| {
            let sha = crate::db::sha256_hex(&content);
            CheckpointFile {
                id: uuid::Uuid::new_v4().to_string(),
                checkpoint_id: checkpoint_id.to_string(),
                file_path: path,
                content: Some(content),
                blob_sha256: Some(sha),
                file_mode: mode,
            }
        })
        .collect();

    let db = crate::db::Database::open(db_path).map_err(|e| SnapshotError::Db(e.to_string()))?;
    db.insert_checkpoint_files_and_prune(workspace_id, &files, retention_count)?;
    // Query the EXISTS-derived flag *after* the prune so callers can't
    // emit `has_file_state=true` for a checkpoint whose own rows the
    // retention sweep just removed.
    Ok(db.has_checkpoint_files(checkpoint_id)?)
}

/// Restore a worktree to the exact state captured in a checkpoint snapshot.
/// Opens its own DB connection for the same Send-safety reason as `save_snapshot`.
pub async fn restore_snapshot(
    db_path: &Path,
    checkpoint_id: &str,
    worktree_path: &str,
) -> Result<(), SnapshotError> {
    let db = crate::db::Database::open(db_path).map_err(|e| SnapshotError::Db(e.to_string()))?;
    let snapshot_files = db.get_checkpoint_files(checkpoint_id)?;
    drop(db); // Release connection before async I/O.
    let base = Path::new(worktree_path);

    // Build set of snapshot paths for deletion pass.
    let snapshot_paths: HashSet<&str> = snapshot_files
        .iter()
        .map(|f| f.file_path.as_str())
        .collect();

    // Write snapshot files to disk.
    for f in &snapshot_files {
        // Guard against path traversal from corrupted DB rows.
        if f.file_path.contains("..") || Path::new(&f.file_path).is_absolute() {
            continue;
        }
        let full_path = base.join(&f.file_path);

        // If the target path currently exists as a symlink or directory,
        // remove it first. A symlink would cause writes to follow it
        // (potentially outside the worktree), and a directory would cause
        // tokio::fs::write to fail with "is a directory".
        if let Ok(meta) = tokio::fs::symlink_metadata(&full_path).await {
            if meta.is_symlink() {
                let _ = tokio::fs::remove_file(&full_path).await;
            } else if meta.is_dir() {
                let _ = tokio::fs::remove_dir_all(&full_path).await;
            }
        }

        match &f.content {
            Some(content) => {
                if let Some(parent) = full_path.parent() {
                    tokio::fs::create_dir_all(parent).await?;
                }
                tokio::fs::write(&full_path, content).await?;

                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let perms = std::fs::Permissions::from_mode(f.file_mode);
                    tokio::fs::set_permissions(&full_path, perms).await?;
                }
            }
            None => {
                // Tombstone: delete the file if it exists.
                let _ = tokio::fs::remove_file(&full_path).await;
            }
        }
    }

    // Delete files on disk that aren't in the snapshot — but preserve
    // files that were skipped during save (large files, symlinks) so
    // restore doesn't cause data loss for content we never captured.
    let current_files = list_worktree_files(worktree_path).await?;
    for rel_path in &current_files {
        if snapshot_paths.contains(rel_path.as_str()) {
            continue;
        }
        let full_path = base.join(rel_path);
        // Preserve files that would have been skipped during save
        // (symlinks and large files) so restore doesn't cause data loss.
        if let Ok(meta) = tokio::fs::symlink_metadata(&full_path).await
            && (!meta.is_file() || meta.len() > MAX_SNAPSHOT_FILE_SIZE)
        {
            continue;
        }
        let _ = tokio::fs::remove_file(&full_path).await;
    }

    // Clean up empty directories (best-effort, bottom-up).
    // Re-list to find dirs that may now be empty.
    clean_empty_dirs(base).await;

    Ok(())
}

/// Recursively remove empty directories under `root`, bottom-up.
async fn clean_empty_dirs(root: &Path) {
    let Ok(mut entries) = tokio::fs::read_dir(root).await else {
        return;
    };

    let mut subdirs = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let path = entry.path();
        // Use symlink_metadata to avoid following symlinks into
        // directories outside the worktree.
        let is_real_dir = tokio::fs::symlink_metadata(&path)
            .await
            .is_ok_and(|m| m.is_dir());
        if is_real_dir {
            // Skip .git directory
            if path.file_name().is_some_and(|n| n == ".git") {
                continue;
            }
            subdirs.push(path);
        }
    }

    for dir in subdirs {
        // Recurse first so leaf dirs are cleaned first.
        Box::pin(clean_empty_dirs(&dir)).await;
        // Try to remove — succeeds only if empty.
        let _ = tokio::fs::remove_dir(&dir).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    async fn setup_test_repo() -> TempDir {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_str().unwrap();
        crate::process::command(crate::git::resolve_git_path_blocking())
            .args(["init", path])
            .output()
            .await
            .unwrap();
        crate::process::command(crate::git::resolve_git_path_blocking())
            .args(["-C", path, "config", "user.email", "test@test.com"])
            .output()
            .await
            .unwrap();
        crate::process::command(crate::git::resolve_git_path_blocking())
            .args(["-C", path, "config", "user.name", "Test"])
            .output()
            .await
            .unwrap();
        dir
    }

    /// Return a fresh SQLite DB in a sibling tempdir to the worktree,
    /// matching production layout (the app's DB lives under
    /// `~/.claudette/`, never inside a managed worktree). Putting the
    /// test DB *inside* `setup_test_repo`'s worktree would make
    /// `restore_snapshot` — which lists and deletes every non-snapshot
    /// file under the worktree — try to delete `test.db` while the test
    /// still holds an open rusqlite connection to it. On Windows that
    /// triggers `ERROR_USER_MAPPED_FILE` (1224) because SQLite
    /// memory-maps part of the DB; on Unix the unlink silently
    /// succeeds and masks the fact that the test was doing something
    /// unrealistic. Either way, the DB doesn't belong in the worktree.
    fn make_db_outside_worktree() -> (TempDir, std::path::PathBuf) {
        let db_dir = tempfile::tempdir().unwrap();
        let db_path = db_dir.path().join("test.db");
        (db_dir, db_path)
    }

    #[tokio::test]
    async fn test_collect_worktree_files() {
        let dir = setup_test_repo().await;
        let dir_str = dir.path().to_str().unwrap();

        // Create tracked file
        tokio::fs::write(dir.path().join("hello.txt"), b"hello")
            .await
            .unwrap();
        crate::process::command(crate::git::resolve_git_path_blocking())
            .args(["-C", dir_str, "add", "hello.txt"])
            .output()
            .await
            .unwrap();

        // Create untracked (but not ignored) file
        tokio::fs::write(dir.path().join("world.txt"), b"world")
            .await
            .unwrap();

        // Create gitignored file
        tokio::fs::write(dir.path().join(".gitignore"), "ignored.txt\n")
            .await
            .unwrap();
        tokio::fs::write(dir.path().join("ignored.txt"), b"secret")
            .await
            .unwrap();

        let files = collect_worktree_files(dir_str).await.unwrap();
        let paths: Vec<&str> = files.iter().map(|(p, _, _)| p.as_str()).collect();

        assert!(paths.contains(&"hello.txt"));
        assert!(paths.contains(&"world.txt"));
        assert!(paths.contains(&".gitignore"));
        assert!(!paths.contains(&"ignored.txt"));
    }

    #[tokio::test]
    async fn test_collect_skips_large_files() {
        let dir = setup_test_repo().await;
        let dir_str = dir.path().to_str().unwrap();

        // Create a small file
        tokio::fs::write(dir.path().join("small.txt"), b"small")
            .await
            .unwrap();

        // Create a file larger than MAX_SNAPSHOT_FILE_SIZE
        let large = vec![0u8; (MAX_SNAPSHOT_FILE_SIZE + 1) as usize];
        tokio::fs::write(dir.path().join("large.bin"), &large)
            .await
            .unwrap();

        let files = collect_worktree_files(dir_str).await.unwrap();
        let paths: Vec<&str> = files.iter().map(|(p, _, _)| p.as_str()).collect();

        assert!(paths.contains(&"small.txt"));
        assert!(!paths.contains(&"large.bin"));
    }

    const TEST_SEED_SQL: &str = "\
        INSERT INTO repositories (id, name, path) VALUES ('r1', 'test-repo', '/tmp/test'); \
        INSERT INTO workspaces (id, repository_id, name, branch_name, status) \
        VALUES ('ws1', 'r1', 'test', 'main', 'active'); \
        INSERT INTO chat_sessions (id, workspace_id, name, sort_order, status) \
        VALUES ('s1', 'ws1', 'Main', 0, 'active'); \
        INSERT INTO conversation_checkpoints (id, workspace_id, chat_session_id, message_id, turn_index, message_count) \
        VALUES ('cp1', 'ws1', 's1', 'm1', 0, 0);";

    #[tokio::test]
    async fn test_save_and_restore_roundtrip() {
        let dir = setup_test_repo().await;
        let dir_str = dir.path().to_str().unwrap();

        // Create initial files
        tokio::fs::write(dir.path().join("a.txt"), b"content-a")
            .await
            .unwrap();
        tokio::fs::create_dir_all(dir.path().join("sub"))
            .await
            .unwrap();
        tokio::fs::write(dir.path().join("sub/b.txt"), b"content-b")
            .await
            .unwrap();

        // Save snapshot to DB
        let (_db_dir, db_path) = make_db_outside_worktree();
        let db = crate::db::Database::open(&db_path).unwrap();
        db.execute_batch(TEST_SEED_SQL).unwrap();

        save_snapshot(
            &db_path,
            "ws1",
            "cp1",
            dir_str,
            DEFAULT_CHECKPOINT_RETENTION_COUNT,
        )
        .await
        .unwrap();

        // Verify files were saved
        assert!(db.has_checkpoint_files("cp1").unwrap());

        // Modify worktree: change a file, add a new one, delete one
        tokio::fs::write(dir.path().join("a.txt"), b"modified")
            .await
            .unwrap();
        tokio::fs::write(dir.path().join("new.txt"), b"new-file")
            .await
            .unwrap();
        tokio::fs::remove_file(dir.path().join("sub/b.txt"))
            .await
            .unwrap();

        // Restore snapshot
        restore_snapshot(&db_path, "cp1", dir_str).await.unwrap();

        // Verify original state is restored
        let a_content = tokio::fs::read_to_string(dir.path().join("a.txt"))
            .await
            .unwrap();
        assert_eq!(a_content, "content-a");

        let b_content = tokio::fs::read_to_string(dir.path().join("sub/b.txt"))
            .await
            .unwrap();
        assert_eq!(b_content, "content-b");

        // new.txt should be deleted
        assert!(!dir.path().join("new.txt").exists());
    }

    #[tokio::test]
    async fn test_restore_deletes_extra_files() {
        let dir = setup_test_repo().await;
        let dir_str = dir.path().to_str().unwrap();

        // Create one file and snapshot
        tokio::fs::write(dir.path().join("keep.txt"), b"keep")
            .await
            .unwrap();

        let (_db_dir, db_path) = make_db_outside_worktree();
        let db = crate::db::Database::open(&db_path).unwrap();
        db.execute_batch(TEST_SEED_SQL).unwrap();

        save_snapshot(
            &db_path,
            "ws1",
            "cp1",
            dir_str,
            DEFAULT_CHECKPOINT_RETENTION_COUNT,
        )
        .await
        .unwrap();

        // Add extra file after snapshot
        tokio::fs::write(dir.path().join("extra.txt"), b"extra")
            .await
            .unwrap();
        assert!(dir.path().join("extra.txt").exists());

        // Restore should remove extra.txt
        restore_snapshot(&db_path, "cp1", dir_str).await.unwrap();
        assert!(!dir.path().join("extra.txt").exists());
        assert!(dir.path().join("keep.txt").exists());
    }

    #[tokio::test]
    async fn test_restore_empty_snapshot_deletes_all_files() {
        let dir = setup_test_repo().await;
        let dir_str = dir.path().to_str().unwrap();

        // Create a file before snapshotting
        tokio::fs::write(dir.path().join("exists.txt"), b"hello")
            .await
            .unwrap();

        let (_db_dir, db_path) = make_db_outside_worktree();
        let db = crate::db::Database::open(&db_path).unwrap();
        db.execute_batch(TEST_SEED_SQL).unwrap();

        // Insert checkpoint with no files (empty snapshot).
        // save_snapshot is NOT called — cp1 has zero checkpoint_files rows.

        // Add a second file after the "snapshot" point
        tokio::fs::write(dir.path().join("also.txt"), b"world")
            .await
            .unwrap();

        // Restoring an empty snapshot should delete all tracked files.
        restore_snapshot(&db_path, "cp1", dir_str).await.unwrap();
        assert!(!dir.path().join("exists.txt").exists());
        assert!(!dir.path().join("also.txt").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_restore_preserves_file_mode() {
        use std::os::unix::fs::PermissionsExt;

        let dir = setup_test_repo().await;
        let dir_str = dir.path().to_str().unwrap();

        // Create an executable file
        tokio::fs::write(dir.path().join("script.sh"), b"#!/bin/sh\necho hi")
            .await
            .unwrap();
        let perms = std::fs::Permissions::from_mode(0o100755);
        tokio::fs::set_permissions(dir.path().join("script.sh"), perms)
            .await
            .unwrap();

        let (_db_dir, db_path) = make_db_outside_worktree();
        let db = crate::db::Database::open(&db_path).unwrap();
        db.execute_batch(TEST_SEED_SQL).unwrap();

        save_snapshot(
            &db_path,
            "ws1",
            "cp1",
            dir_str,
            DEFAULT_CHECKPOINT_RETENTION_COUNT,
        )
        .await
        .unwrap();

        // Overwrite with non-executable
        tokio::fs::write(dir.path().join("script.sh"), b"changed")
            .await
            .unwrap();

        // Restore should bring back executable permission
        restore_snapshot(&db_path, "cp1", dir_str).await.unwrap();

        let metadata = tokio::fs::metadata(dir.path().join("script.sh"))
            .await
            .unwrap();
        let mode = metadata.permissions().mode();
        assert_eq!(mode & 0o111, 0o111, "executable bits should be preserved");
    }

    /// Codex peer-review pin: `save_snapshot` must report the post-prune
    /// `has_file_state` flag, not the pre-prune file count. If the
    /// retention cap is tight enough that the freshly-inserted rows are
    /// themselves pruned (e.g. a newer checkpoint already filled the
    /// kept-set), the returned bool must be `false` to match what the DB-
    /// derived `EXISTS` will see — otherwise the UI shows a "restore
    /// files" affordance that backend-side restore won't honor.
    #[tokio::test]
    async fn test_save_snapshot_reports_false_when_own_rows_pruned() {
        let dir = setup_test_repo().await;
        let dir_str = dir.path().to_str().unwrap();

        tokio::fs::write(dir.path().join("a.txt"), b"a")
            .await
            .unwrap();

        let (_db_dir, db_path) = make_db_outside_worktree();
        let db = crate::db::Database::open(&db_path).unwrap();
        db.execute_batch(
            "INSERT INTO repositories (id, name, path) VALUES ('r1', 'test-repo', '/tmp/test'); \
             INSERT INTO workspaces (id, repository_id, name, branch_name, status) \
             VALUES ('ws1', 'r1', 'test', 'main', 'active'); \
             INSERT INTO chat_sessions (id, workspace_id, name, sort_order, status) \
             VALUES ('s1', 'ws1', 'Main', 0, 'active'); \
             INSERT INTO conversation_checkpoints (id, workspace_id, chat_session_id, message_id, turn_index, message_count, created_at) \
             VALUES ('cp-newer', 'ws1', 's1', 'm1', 1, 0, '2099-01-01 00:00:00'), \
                    ('cp-older', 'ws1', 's1', 'm2', 0, 0, '2000-01-01 00:00:00'); \
             INSERT INTO checkpoint_blobs (sha256, bytes, byte_size) \
             VALUES ('deadbeef', x'00', 1); \
             INSERT INTO checkpoint_files (id, checkpoint_id, file_path, blob_sha256, file_mode) \
             VALUES ('f-newer', 'cp-newer', 'a.txt', 'deadbeef', 33188);",
        )
        .unwrap();
        drop(db);

        // Pre-state: cp-newer already has a file row (so it's in the
        // retention kept-set). With retention=1, snapshotting into the
        // older checkpoint inserts new rows that the same transaction's
        // prune sweep immediately removes — so the return flag must be
        // `false`, matching what `has_checkpoint_files` will see.
        let flag = save_snapshot(&db_path, "ws1", "cp-older", dir_str, 1)
            .await
            .unwrap();
        assert!(
            !flag,
            "post-prune has_file_state must be false when own rows were pruned"
        );
        let db = crate::db::Database::open(&db_path).unwrap();
        assert!(!db.has_checkpoint_files("cp-older").unwrap());
        // cp-newer's own file row survives — the test repros codex's
        // scenario without affecting the kept-set occupant.
        assert!(db.has_checkpoint_files("cp-newer").unwrap());
    }

    /// Sibling pin to the test above: the normal case — a fresh
    /// checkpoint comfortably inside the retention window — must report
    /// `true` when files were actually saved.
    #[tokio::test]
    async fn test_save_snapshot_reports_true_when_files_retained() {
        let dir = setup_test_repo().await;
        let dir_str = dir.path().to_str().unwrap();
        tokio::fs::write(dir.path().join("a.txt"), b"a")
            .await
            .unwrap();

        let (_db_dir, db_path) = make_db_outside_worktree();
        let db = crate::db::Database::open(&db_path).unwrap();
        db.execute_batch(TEST_SEED_SQL).unwrap();
        drop(db);

        let flag = save_snapshot(
            &db_path,
            "ws1",
            "cp1",
            dir_str,
            DEFAULT_CHECKPOINT_RETENTION_COUNT,
        )
        .await
        .unwrap();
        assert!(flag);
    }
}
