use std::path::Path;

use tauri::State;

use claudette::db::Database;
use claudette::diff;
use claudette::model::diff::{CommitEntry, DiffFile, FileDiff, StagedDiffFiles};

use crate::state::{AppState, MERGE_BASE_CACHE_TTL, MergeBaseCache, MergeBaseCacheEntry};

/// Cache-aware wrapper around `diff::resolve_workspace_merge_base`.
///
/// On a fresh cache hit (entry younger than `MERGE_BASE_CACHE_TTL`), returns
/// the stored `(sha, worktree_path)` without touching the database or git.
/// On miss or expiry, runs the full resolution and stores the result.
///
/// `merge-base` against a divergent fork can take 4–6 seconds; the polling
/// callers in the right sidebar (`load_diff_files`) and the file viewer
/// gutter (`compute_workspace_merge_base`) both consult this so a steady
/// stream of polls only hits `git` once per TTL window per workspace.
///
/// Takes `&MergeBaseCache` and `db_path: &Path` directly rather than
/// `&AppState` so unit tests can exercise the cache against a temp
/// `Database` without standing up a full `AppState`.
async fn cached_resolve_workspace_merge_base(
    cache: &MergeBaseCache,
    db_path: &Path,
    workspace_id: &str,
) -> Result<(String, String), String> {
    // Cache lookup first — held only across the read guard, so the slow git
    // path on miss is never serialized by the lock.
    {
        let entries = cache.entries.read().await;
        if let Some(entry) = entries.get(workspace_id) {
            if entry.fetched_at.elapsed() < MERGE_BASE_CACHE_TTL {
                return Ok((entry.sha.clone(), entry.worktree_path.clone()));
            }
        }
    }

    // Miss or expired — resolve the slow way and populate.
    let db = Database::open(db_path).map_err(|e| e.to_string())?;
    let (sha, worktree_path) = diff::resolve_workspace_merge_base(&db, workspace_id).await?;

    let mut entries = cache.entries.write().await;
    entries.insert(
        workspace_id.to_string(),
        MergeBaseCacheEntry {
            sha: sha.clone(),
            worktree_path: worktree_path.clone(),
            fetched_at: std::time::Instant::now(),
        },
    );

    Ok((sha, worktree_path))
}

#[derive(serde::Serialize)]
pub struct DiffFilesResult {
    pub files: Vec<DiffFile>,
    pub merge_base: String,
    pub staged_files: Option<StagedDiffFiles>,
    pub commits: Vec<CommitEntry>,
}

#[tauri::command]
pub async fn load_diff_files(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<DiffFilesResult, String> {
    let (merge_base, worktree_path) =
        cached_resolve_workspace_merge_base(&state.merge_base_cache, &state.db_path, &workspace_id)
            .await?;
    let worktree_path = &worktree_path;

    // Get both the flat file list (backward compat) and staged groups
    let (files, staged_files, commits) = tokio::join!(
        diff::changed_files(worktree_path, &merge_base),
        diff::staged_changed_files(worktree_path, &merge_base),
        diff::commits_in_range(worktree_path, &merge_base),
    );

    let files = files.map_err(|e| e.to_string())?;
    let staged_files = staged_files.ok();
    let commits = commits.unwrap_or_default();

    Ok(DiffFilesResult {
        files,
        merge_base,
        staged_files,
        commits,
    })
}

/// Lightweight sibling of `load_diff_files` that returns only the workspace's
/// merge-base SHA. Used by the file viewer's git gutter when the user has
/// selected the "Workspace branch base" comparison and the SHA isn't already
/// cached in the diff slice (e.g. they opened a file before the Changes
/// panel ever ran).
#[tauri::command]
pub async fn compute_workspace_merge_base(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    cached_resolve_workspace_merge_base(&state.merge_base_cache, &state.db_path, &workspace_id)
        .await
        .map(|(sha, _)| sha)
}

#[tauri::command]
pub async fn load_file_diff(
    worktree_path: String,
    merge_base: String,
    file_path: String,
    diff_layer: Option<String>,
) -> Result<FileDiff, String> {
    let raw = diff::file_diff_for_layer(
        &worktree_path,
        &merge_base,
        &file_path,
        diff_layer.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())?;

    Ok(diff::parse_unified_diff(&raw, &file_path))
}

#[tauri::command]
pub async fn revert_file(
    worktree_path: String,
    merge_base: String,
    file_path: String,
    status: String,
) -> Result<(), String> {
    let file_status = match status.as_str() {
        "Added" => claudette::model::diff::FileStatus::Added,
        "Deleted" => claudette::model::diff::FileStatus::Deleted,
        _ => claudette::model::diff::FileStatus::Modified,
    };

    diff::revert_file(&worktree_path, &merge_base, &file_path, &file_status)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn stage_file(worktree_path: String, file_path: String) -> Result<(), String> {
    diff::stage_file(&worktree_path, &file_path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn unstage_file(worktree_path: String, file_path: String) -> Result<(), String> {
    diff::unstage_file(&worktree_path, &file_path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn stage_files(worktree_path: String, file_paths: Vec<String>) -> Result<(), String> {
    diff::stage_files(&worktree_path, &file_paths)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn unstage_files(worktree_path: String, file_paths: Vec<String>) -> Result<(), String> {
    diff::unstage_files(&worktree_path, &file_paths)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn discard_files(
    worktree_path: String,
    tracked: Vec<String>,
    untracked: Vec<String>,
) -> Result<(), String> {
    diff::discard_files(&worktree_path, &tracked, &untracked)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn discard_file(
    worktree_path: String,
    file_path: String,
    is_untracked: bool,
) -> Result<(), String> {
    diff::discard_file(&worktree_path, &file_path, is_untracked)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn load_commit_file_diff(
    worktree_path: String,
    commit_hash: String,
    file_path: String,
) -> Result<FileDiff, String> {
    let raw = diff::commit_file_diff(&worktree_path, &commit_hash, &file_path)
        .await
        .map_err(|e| e.to_string())?;
    Ok(diff::parse_unified_diff(&raw, &file_path))
}

#[cfg(test)]
mod tests {
    //! Regression tests for `cached_resolve_workspace_merge_base`.
    //!
    //! Pins the contract that motivated the cache: a TTL-fresh repeat call
    //! for the same workspace must serve from cache without touching the
    //! database or git. Without this guarantee the polling callers
    //! (right-sidebar Changes tab, file-viewer git gutter) re-pay the full
    //! `git merge-base` cost every tick, which on a divergent fork is
    //! 4–6 seconds each — the exact root cause that produced ~195 stuck
    //! `git` processes from a single workspace before the fix landed.
    //!
    //! The "did the cache really hit?" assertion uses a delete-the-DB
    //! trick: after the first call populates the cache, we remove the
    //! SQLite file. A second call within the TTL must succeed anyway —
    //! proving the path through `Database::open()` was not taken — and
    //! must return the same SHA it stored on the first miss.
    use super::*;
    use claudette::db::Database;
    use claudette::model::{AgentStatus, Repository, Workspace, WorkspaceStatus};
    use std::path::PathBuf;
    use std::process::Command;

    fn git(dir: &std::path::Path, args: &[&str]) {
        let out = Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git command failed to spawn");
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn make_repo_row(id: &str, path: &str) -> Repository {
        Repository {
            id: id.into(),
            path: path.into(),
            name: "test-repo".into(),
            path_slug: "test-repo".into(),
            icon: None,
            created_at: String::new(),
            setup_script: None,
            custom_instructions: None,
            sort_order: 0,
            branch_rename_preferences: None,
            setup_script_auto_run: false,
            archive_script: None,
            archive_script_auto_run: false,
            base_branch: Some("main".into()),
            default_remote: None,
            required_inputs: None,
            path_valid: true,
        }
    }

    fn make_workspace_row(id: &str, repo_id: &str, worktree: &str) -> Workspace {
        Workspace {
            // Mirror id into the human-visible name so two workspaces in the
            // same repo don't collide on the `(repository_id, name)` UNIQUE
            // constraint.
            id: id.into(),
            repository_id: repo_id.into(),
            name: format!("ws-{id}"),
            branch_name: format!("branch-{id}"),
            worktree_path: Some(worktree.into()),
            status: WorkspaceStatus::Active,
            agent_status: AgentStatus::Idle,
            status_line: String::new(),
            created_at: String::new(),
            sort_order: 0,
            input_values: None,
        }
    }

    /// Build a tempdir with a divergent main/feature repo + a file-backed
    /// SQLite db pre-seeded with one repository row and one workspace row
    /// pointing at the worktree. Returns `(tempdir guard, db_path)`. The
    /// tempdir owns both the repo and the db file so dropping it cleans
    /// everything up.
    fn setup_repo_and_db() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let repo_dir = tmp.path().join("repo");
        std::fs::create_dir(&repo_dir).unwrap();

        git(&repo_dir, &["init", "-b", "main"]);
        git(&repo_dir, &["config", "user.email", "test@test.com"]);
        git(&repo_dir, &["config", "user.name", "Test"]);
        git(&repo_dir, &["config", "core.autocrlf", "false"]);
        std::fs::write(repo_dir.join("a.txt"), "initial\n").unwrap();
        git(&repo_dir, &["add", "."]);
        git(&repo_dir, &["commit", "-m", "initial"]);
        git(&repo_dir, &["checkout", "-b", "feature"]);
        std::fs::write(repo_dir.join("a.txt"), "feature change\n").unwrap();
        git(&repo_dir, &["add", "."]);
        git(&repo_dir, &["commit", "-m", "feature"]);

        let db_path = tmp.path().join("test.sqlite");
        let db = Database::open(&db_path).expect("open test db");
        db.insert_repository(&make_repo_row("r1", repo_dir.to_str().unwrap()))
            .expect("insert repo");
        db.insert_workspace(&make_workspace_row("w1", "r1", repo_dir.to_str().unwrap()))
            .expect("insert workspace");
        // Drop the DB connection so the file is not held open when we
        // delete it later in the test.
        drop(db);

        (tmp, db_path)
    }

    /// Within the TTL window, a repeat call must serve the stored answer
    /// without re-opening the database. We delete the DB file between calls
    /// so a recompute would fail loudly — if the test passes, the cache
    /// truly skipped both DB and git.
    #[tokio::test]
    async fn cache_hit_within_ttl_skips_db_and_git() {
        let (_tmp, db_path) = setup_repo_and_db();
        let cache = MergeBaseCache::new();

        // First call: miss → resolves and populates.
        let (sha_first, worktree_first) =
            cached_resolve_workspace_merge_base(&cache, &db_path, "w1")
                .await
                .expect("first call should resolve");
        assert!(!sha_first.is_empty(), "first SHA must be populated");

        let fetched_at_first = {
            let entries = cache.entries.read().await;
            entries
                .get("w1")
                .expect("entry must exist after miss")
                .fetched_at
        };

        // Make a recompute impossible. If the cache is broken and the next
        // call falls through to `Database::open(...)`, it will fail.
        std::fs::remove_file(&db_path).expect("delete db file");

        // Second call within the TTL window must hit cache.
        let (sha_second, worktree_second) =
            cached_resolve_workspace_merge_base(&cache, &db_path, "w1")
                .await
                .expect("cached hit must succeed even with the database removed");

        assert_eq!(
            sha_first, sha_second,
            "cache must return the same SHA on hit"
        );
        assert_eq!(
            worktree_first, worktree_second,
            "cache must return the same worktree path on hit"
        );

        let fetched_at_second = {
            let entries = cache.entries.read().await;
            entries
                .get("w1")
                .expect("entry must still exist on hit")
                .fetched_at
        };
        assert_eq!(
            fetched_at_first, fetched_at_second,
            "cache hit must not refresh the entry's fetched_at — that would imply a recompute"
        );
    }

    /// A different `workspace_id` must not be served by another workspace's
    /// cache entry. Pins the cache key contract (workspace_id, not repo_id
    /// or worktree path).
    #[tokio::test]
    async fn cache_does_not_cross_workspaces() {
        let (tmp, db_path) = setup_repo_and_db();

        // Add a second workspace pointing at the same worktree (a real DB
        // would have a separate worktree per workspace, but the cache logic
        // doesn't care — we only need a distinct workspace_id that the DB
        // can resolve).
        let db = Database::open(&db_path).expect("reopen db");
        db.insert_workspace(&make_workspace_row(
            "w2",
            "r1",
            tmp.path().join("repo").to_str().unwrap(),
        ))
        .expect("insert second workspace");
        drop(db);

        let cache = MergeBaseCache::new();

        // Populate w1.
        let _ = cached_resolve_workspace_merge_base(&cache, &db_path, "w1")
            .await
            .expect("populate w1");

        // w2 must miss — its entry doesn't exist yet.
        {
            let entries = cache.entries.read().await;
            assert!(entries.contains_key("w1"));
            assert!(!entries.contains_key("w2"));
        }

        let _ = cached_resolve_workspace_merge_base(&cache, &db_path, "w2")
            .await
            .expect("populate w2");

        // Both must now be cached as distinct entries.
        let entries = cache.entries.read().await;
        assert!(entries.contains_key("w1"));
        assert!(entries.contains_key("w2"));
    }
}
