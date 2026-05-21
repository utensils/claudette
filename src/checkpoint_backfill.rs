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

use std::fmt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::db::{Database, SQLITE_AUTO_VACUUM_FULL, SQLITE_AUTO_VACUUM_INCREMENTAL};

const BATCH_ROW_COUNT: usize = 64;
const BATCH_BYTE_BUDGET: usize = 16 * 1024 * 1024;
const BACKFILL_DONE_KEY: &str = "checkpoint_blob_backfill_done";
const SPACE_RECLAIM_DONE_KEY: &str = "checkpoint_blob_space_reclaim_done";
const SPACE_RECLAIM_CHUNK_PAGES: i64 = 16 * 1024;
const SPACE_RECLAIM_PAUSE: Duration = Duration::from_millis(10);

/// Failure modes for the backfill task. Kept distinct from `rusqlite::Error`
/// so a `JoinError` from a panicked / cancelled worker doesn't masquerade
/// as a SQL conversion failure in logs and telemetry.
#[derive(Debug)]
pub enum BackfillError {
    /// A SQL operation against `checkpoint_files` / `checkpoint_blobs` /
    /// `app_settings` failed.
    Sql(rusqlite::Error),
    /// The `spawn_blocking` worker panicked or was cancelled before
    /// returning. Almost always indicates a bug or a process shutdown.
    JoinFailed(tokio::task::JoinError),
}

impl fmt::Display for BackfillError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Sql(e) => write!(f, "checkpoint backfill SQL error: {e}"),
            Self::JoinFailed(e) => write!(f, "checkpoint backfill worker failed: {e}"),
        }
    }
}

impl std::error::Error for BackfillError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Sql(e) => Some(e),
            Self::JoinFailed(e) => Some(e),
        }
    }
}

impl From<rusqlite::Error> for BackfillError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Sql(e)
    }
}

impl From<tokio::task::JoinError> for BackfillError {
    fn from(e: tokio::task::JoinError) -> Self {
        Self::JoinFailed(e)
    }
}

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
///
/// The entire loop runs inside a single `spawn_blocking` worker that owns
/// one `Database` connection — opening a fresh DB per batch (as an
/// earlier version did) cost a migration scan, pragma reapply, and
/// busy-timeout setup tens of thousands of times on a multi-GB legacy
/// install. Each batch is still its own transaction, so the SQLite write
/// lock is only held for the duration of a single batch's writes —
/// foreground commands queued on `busy_timeout` get to interleave between
/// our commits.
pub async fn run_backfill(db_path: &Path) -> Result<(), BackfillError> {
    let path = db_path.to_path_buf();
    tokio::task::spawn_blocking(move || run_backfill_blocking(&path))
        .await
        .map_err(BackfillError::JoinFailed)?
}

/// Reclaim the SQLite freelist left behind by the #940 legacy checkpoint
/// backfill after the frontend has acknowledged a healthy boot.
///
/// This intentionally stays separate from [`run_backfill`]. The backfill
/// itself is many tiny transactions; reclaiming gigabytes of free pages can
/// block SQLite writers long enough to trip the updater's boot probation if
/// it starts before `boot_ok`. The Tauri shell owns that lifecycle signal and
/// calls this only after boot is acknowledged.
pub async fn run_post_backfill_space_reclaim(db_path: &Path) -> Result<(), BackfillError> {
    let path = db_path.to_path_buf();
    tokio::task::spawn_blocking(move || run_post_backfill_space_reclaim_blocking(&path))
        .await
        .map_err(BackfillError::JoinFailed)?
}

fn run_backfill_blocking(db_path: &Path) -> Result<(), BackfillError> {
    let db = Database::open(db_path)?;

    // Skip if already complete — recorded after every successful pass so we
    // never repeat the full table scan on subsequent boots.
    if db
        .get_app_setting(BACKFILL_DONE_KEY)?
        .is_some_and(|v| v == "true")
    {
        return Ok(());
    }

    let total_legacy = db.count_legacy_checkpoint_file_rows()?;
    if total_legacy == 0 {
        db.set_app_setting(BACKFILL_DONE_KEY, "true")?;
        return Ok(());
    }

    tracing::info!(
        target: "claudette::db",
        legacy_rows = total_legacy,
        "starting checkpoint blob backfill"
    );

    let mut migrated_total: usize = 0;
    loop {
        let migrated =
            db.migrate_legacy_checkpoint_file_batch(BATCH_ROW_COUNT, BATCH_BYTE_BUDGET)?;
        if migrated == 0 {
            break;
        }
        migrated_total += migrated;
    }
    db.set_app_setting(BACKFILL_DONE_KEY, "true")?;
    tracing::info!(
        target: "claudette::db",
        migrated_rows = migrated_total,
        "checkpoint blob backfill complete"
    );
    Ok(())
}

fn run_post_backfill_space_reclaim_blocking(db_path: &Path) -> Result<(), BackfillError> {
    let db = Database::open(db_path)?;

    if db
        .get_app_setting(SPACE_RECLAIM_DONE_KEY)?
        .is_some_and(|v| v == "true")
    {
        return Ok(());
    }

    if db
        .get_app_setting(BACKFILL_DONE_KEY)?
        .is_none_or(|v| v != "true")
    {
        return Ok(());
    }

    let initial_freelist = db.freelist_page_count()?;
    let mode = db.auto_vacuum_mode()?;
    if initial_freelist <= 0 {
        db.set_app_setting(SPACE_RECLAIM_DONE_KEY, "true")?;
        return Ok(());
    }

    tracing::info!(
        target: "claudette::db",
        issue = 940,
        auto_vacuum = mode,
        freelist_pages = initial_freelist,
        "starting post-backfill checkpoint space reclaim"
    );

    if mode == SQLITE_AUTO_VACUUM_FULL {
        db.set_app_setting(SPACE_RECLAIM_DONE_KEY, "true")?;
        tracing::info!(
            target: "claudette::db",
            issue = 940,
            freelist_pages = initial_freelist,
            "checkpoint space reclaim skipped because FULL auto-vacuum is already active"
        );
        return Ok(());
    }

    if mode != SQLITE_AUTO_VACUUM_INCREMENTAL {
        // Legacy DBs that predate auto-vacuum support need one full VACUUM
        // to rewrite the file with pointer-map pages. Do this only after
        // `boot_ok`; running it from Database::open can trip the 20s upgrade
        // guard on the exact multi-GB #940 databases this feature repairs.
        let converted = db.ensure_incremental_auto_vacuum()?;
        db.set_app_setting(SPACE_RECLAIM_DONE_KEY, "true")?;
        tracing::info!(
            target: "claudette::db",
            issue = 940,
            converted,
            "checkpoint space reclaim complete after auto-vacuum conversion"
        );
        return Ok(());
    }

    let mut chunks = 0usize;
    let mut reclaimed_pages = 0i64;
    loop {
        let before = db.freelist_page_count()?;
        if before <= 0 {
            db.set_app_setting(SPACE_RECLAIM_DONE_KEY, "true")?;
            tracing::info!(
                target: "claudette::db",
                issue = 940,
                chunks,
                reclaimed_pages,
                "checkpoint space reclaim complete"
            );
            return Ok(());
        }

        let reclaimed = db.incremental_vacuum_pages(SPACE_RECLAIM_CHUNK_PAGES)?;
        chunks += 1;
        reclaimed_pages += reclaimed;

        if chunks == 1 || chunks.is_multiple_of(32) {
            tracing::info!(
                target: "claudette::db",
                issue = 940,
                chunks,
                reclaimed_pages,
                remaining_pages = db.freelist_page_count()?,
                "checkpoint space reclaim progress"
            );
        }

        if reclaimed <= 0 {
            tracing::warn!(
                target: "claudette::db",
                issue = 940,
                chunks,
                remaining_pages = before,
                "checkpoint space reclaim made no progress; will retry on next launch"
            );
            return Ok(());
        }

        std::thread::sleep(SPACE_RECLAIM_PAUSE);
    }
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

    #[tokio::test]
    async fn post_backfill_space_reclaim_waits_for_backfill_done_marker() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        {
            let db = Database::open(&db_path).unwrap();
            db.execute_batch(
                "CREATE TABLE reclaim_probe (id INTEGER PRIMARY KEY, payload BLOB);
                 INSERT INTO reclaim_probe (payload) VALUES (zeroblob(1048576));
                 DELETE FROM reclaim_probe;",
            )
            .unwrap();
            assert!(db.freelist_page_count().unwrap() > 0);
        }

        run_post_backfill_space_reclaim(&db_path).await.unwrap();

        let db = Database::open(&db_path).unwrap();
        assert!(
            db.get_app_setting(SPACE_RECLAIM_DONE_KEY)
                .unwrap()
                .is_none(),
            "space reclaim must not mark done before the #940 backfill marker exists"
        );
        assert!(
            db.freelist_page_count().unwrap() > 0,
            "space reclaim should not run before backfill completion"
        );
    }

    #[tokio::test]
    async fn post_backfill_space_reclaim_drains_incremental_freelist() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        {
            let db = Database::open(&db_path).unwrap();
            db.execute_batch(
                "CREATE TABLE reclaim_probe (id INTEGER PRIMARY KEY, payload BLOB);
                 INSERT INTO reclaim_probe (payload) VALUES (zeroblob(1048576));
                 DELETE FROM reclaim_probe;",
            )
            .unwrap();
            assert!(db.freelist_page_count().unwrap() > 0);
            db.set_app_setting(BACKFILL_DONE_KEY, "true").unwrap();
        }

        run_post_backfill_space_reclaim(&db_path).await.unwrap();

        let db = Database::open(&db_path).unwrap();
        assert_eq!(db.freelist_page_count().unwrap(), 0);
        assert_eq!(
            db.get_app_setting(SPACE_RECLAIM_DONE_KEY)
                .unwrap()
                .as_deref(),
            Some("true")
        );
    }

    #[tokio::test]
    async fn post_backfill_space_reclaim_converts_legacy_none_auto_vacuum_db() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("legacy.db");
        {
            let conn = rusqlite::Connection::open(&db_path).unwrap();
            conn.execute_batch(
                "PRAGMA auto_vacuum=NONE;
                 CREATE TABLE preexisting_table (id INTEGER PRIMARY KEY, payload BLOB);
                 INSERT INTO preexisting_table (payload) VALUES (zeroblob(1048576));
                 DELETE FROM preexisting_table;",
            )
            .unwrap();
        }
        {
            let db = Database::open(&db_path).unwrap();
            assert_ne!(
                db.auto_vacuum_mode().unwrap(),
                SQLITE_AUTO_VACUUM_INCREMENTAL
            );
            db.set_app_setting(BACKFILL_DONE_KEY, "true").unwrap();
        }

        run_post_backfill_space_reclaim(&db_path).await.unwrap();

        let db = Database::open(&db_path).unwrap();
        assert_eq!(
            db.auto_vacuum_mode().unwrap(),
            SQLITE_AUTO_VACUUM_INCREMENTAL
        );
        assert_eq!(
            db.get_app_setting(SPACE_RECLAIM_DONE_KEY)
                .unwrap()
                .as_deref(),
            Some("true")
        );
    }
}
