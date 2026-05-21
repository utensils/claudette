//! One-time backfill of legacy `checkpoint_files.content` rows into the
//! content-addressed `checkpoint_blobs` table. Closes #940 / #942 for users
//! whose DB filled up before dedupe shipped.
//!
//! The backfill runs as a background tokio task after migrations complete —
//! it opens its own connection (not `Send`), batches work into small
//! transactions, and never holds the write lock long enough to starve the
//! foreground app. Progress is gated by `app_settings.checkpoint_blob_backfill_done`
//! so the task is a no-op on subsequent boots.
//!
//! Sizing: each batch loads at most `BATCH_ROW_COUNT` rows or
//! `BATCH_BYTE_BUDGET` of content bytes, whichever comes first. The byte
//! cap matters more than the row cap — a single 5 MB legacy row would
//! otherwise force loading hundreds of MB at once on a 39 GB install
//! (#942). Each batch is its own transaction so a long-running backfill
//! can't lose progress on shutdown.

use std::path::{Path, PathBuf};

use crate::db::Database;

const BATCH_ROW_COUNT: usize = 64;
const BATCH_BYTE_BUDGET: usize = 16 * 1024 * 1024;
const BACKFILL_DONE_KEY: &str = "checkpoint_blob_backfill_done";

/// Spawn a fire-and-forget tokio task that runs the backfill in the
/// background. Safe to call repeatedly: the task short-circuits if
/// `app_settings.checkpoint_blob_backfill_done = "true"` is already set.
pub fn spawn_backfill(db_path: PathBuf) {
    tokio::spawn(async move {
        if let Err(e) = run_backfill(&db_path).await {
            tracing::warn!(
                target: "claudette::db",
                error = %e,
                "checkpoint blob backfill failed; will retry on next launch"
            );
        }
    });
}

/// Drive the backfill loop to completion. Returns once every legacy row
/// has been migrated or there are no legacy rows to begin with.
pub async fn run_backfill(db_path: &Path) -> Result<(), rusqlite::Error> {
    // Skip if already complete — recorded after every successful pass so we
    // never repeat the full table scan on subsequent boots.
    if blocking_op(db_path, |db| {
        Ok(db
            .get_app_setting(BACKFILL_DONE_KEY)?
            .is_some_and(|v| v == "true"))
    })
    .await?
    {
        return Ok(());
    }

    let total_legacy = blocking_op(db_path, |db| db.count_legacy_checkpoint_file_rows()).await?;
    if total_legacy == 0 {
        blocking_op(db_path, |db| db.set_app_setting(BACKFILL_DONE_KEY, "true")).await?;
        return Ok(());
    }

    tracing::info!(
        target: "claudette::db",
        legacy_rows = total_legacy,
        "starting checkpoint blob backfill"
    );

    let mut migrated_total: usize = 0;
    loop {
        let migrated = blocking_op(db_path, |db| {
            db.migrate_legacy_checkpoint_file_batch(BATCH_ROW_COUNT, BATCH_BYTE_BUDGET)
        })
        .await?;
        if migrated == 0 {
            break;
        }
        migrated_total += migrated;
        // Yield between batches so foreground commands keep the write lock
        // for short periods. Cooperative scheduling rather than hard sleep.
        tokio::task::yield_now().await;
    }
    blocking_op(db_path, |db| db.set_app_setting(BACKFILL_DONE_KEY, "true")).await?;
    tracing::info!(
        target: "claudette::db",
        migrated_rows = migrated_total,
        "checkpoint blob backfill complete"
    );
    Ok(())
}

/// Run a blocking DB operation on a worker thread so the backfill never
/// holds a `Database` (non-`Send`) across `await` points and never blocks
/// the tokio reactor with synchronous SQLite calls.
async fn blocking_op<F, T>(db_path: &Path, op: F) -> Result<T, rusqlite::Error>
where
    F: FnOnce(&Database) -> Result<T, rusqlite::Error> + Send + 'static,
    T: Send + 'static,
{
    let path = db_path.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let db = Database::open(&path)?;
        op(&db)
    })
    .await
    .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::CheckpointFile;
    use tempfile::tempdir;

    const SEED_SQL: &str = "\
        INSERT INTO repositories (id, name, path) VALUES ('r1', 'r', '/tmp/r'); \
        INSERT INTO workspaces (id, repository_id, name, branch_name, status) \
        VALUES ('ws1', 'r1', 'w', 'main', 'active'); \
        INSERT INTO chat_sessions (id, workspace_id, name, sort_order, status) \
        VALUES ('s1', 'ws1', 'Main', 0, 'active'); \
        INSERT INTO conversation_checkpoints (id, workspace_id, chat_session_id, message_id, turn_index, message_count) \
        VALUES ('cp1', 'ws1', 's1', 'm1', 0, 0);";

    /// Seed two legacy rows with the same content (no dedupe done yet),
    /// run the backfill, and verify they collapse to one blob.
    #[tokio::test]
    async fn backfill_dedupes_identical_legacy_rows() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");

        // Seed legacy rows directly via raw INSERTs into checkpoint_files —
        // skipping the dedupe path so we end up with content-bearing,
        // blob_sha256=NULL rows that look like pre-fix data.
        {
            let db = Database::open(&db_path).unwrap();
            db.execute_batch(SEED_SQL).unwrap();
            db.execute_batch(
                "INSERT INTO checkpoint_files
                   (id, checkpoint_id, file_path, content, blob_sha256, file_mode)
                 VALUES
                   ('f1', 'cp1', 'a.txt', x'68656c6c6f', NULL, 33188),
                   ('f2', 'cp1', 'b.txt', x'68656c6c6f', NULL, 33188),
                   ('f3', 'cp1', 'c.bin', x'00010203', NULL, 33188);",
            )
            .unwrap();
        }

        run_backfill(&db_path).await.unwrap();

        let db = Database::open(&db_path).unwrap();
        // Two unique blobs: "hello" and 0x00010203.
        let blob_count: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM checkpoint_blobs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(blob_count, 2);
        // All legacy rows have been migrated to references.
        assert_eq!(db.count_legacy_checkpoint_file_rows().unwrap(), 0);
        // And the read path materializes the same bytes back.
        let files = db.get_checkpoint_files("cp1").unwrap();
        assert_eq!(files.len(), 3);
        for f in &files {
            assert!(f.blob_sha256.is_some());
            assert!(f.content.is_some());
        }
        // Backfill marker is set.
        let done = db.get_app_setting(BACKFILL_DONE_KEY).unwrap();
        assert_eq!(done.as_deref(), Some("true"));
    }

    /// Re-running the backfill on a clean DB is a cheap no-op (just reads
    /// the marker).
    #[tokio::test]
    async fn backfill_is_idempotent() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        {
            let db = Database::open(&db_path).unwrap();
            db.execute_batch(SEED_SQL).unwrap();
        }

        run_backfill(&db_path).await.unwrap();
        run_backfill(&db_path).await.unwrap();
    }

    /// Fresh writes via the dedupe path don't need backfilling at all —
    /// `content` is already NULL'd and `blob_sha256` is set. The backfill
    /// should ignore them and only touch true legacy rows.
    #[tokio::test]
    async fn backfill_ignores_already_deduped_rows() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");

        {
            let db = Database::open(&db_path).unwrap();
            db.execute_batch(SEED_SQL).unwrap();
            db.insert_checkpoint_files(&[CheckpointFile {
                id: "f1".into(),
                checkpoint_id: "cp1".into(),
                file_path: "a.txt".into(),
                content: Some(b"hello".to_vec()),
                blob_sha256: None,
                file_mode: 33188,
            }])
            .unwrap();
            assert_eq!(db.count_legacy_checkpoint_file_rows().unwrap(), 0);
        }

        run_backfill(&db_path).await.unwrap();
        let db = Database::open(&db_path).unwrap();
        let blob_count: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM checkpoint_blobs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(blob_count, 1);
    }
}
