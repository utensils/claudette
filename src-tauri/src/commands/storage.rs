//! Storage-related Tauri commands: per-repo disk usage stats and an
//! orphaned-worktree scanner that surfaces worktree directories sitting
//! under the configured workspace base dir but not tracked by any DB
//! workspace row (e.g. survived a `~/.claudette/data.db` reset or a
//! dev-build crash).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use claudette::db::Database;
use claudette::model::WorkspaceStatus;
use serde::Serialize;
use tauri::State;

use crate::commands::path_util::{canon_or_raw, canon_with_parent_fallback};
use crate::commands::workspace::directory_size_bytes;
use crate::state::AppState;

#[derive(Serialize, Debug, Clone)]
pub struct WorkspaceStorageEntry {
    pub id: String,
    pub name: String,
    pub status: WorkspaceStatus,
    pub worktree_path: Option<String>,
    /// For active workspaces with a worktree dir on disk: the size of
    /// that dir. For workspaces whose worktree has been removed
    /// (archived, or setup-failed), the bytes the checkpoint store
    /// would reclaim if the workspace were deleted — sole-owned
    /// content-addressed blobs plus inline legacy file content.
    /// `None` is reserved for the rare case where the DB query itself
    /// fails; callers can treat that as "unknown" and skip the row.
    pub size_bytes: Option<u64>,
}

#[derive(Serialize, Debug, Clone)]
pub struct RepoStorageStats {
    pub repository_id: String,
    pub active_bytes: u64,
    pub archived_bytes: u64,
    pub total_bytes: u64,
    pub workspaces: Vec<WorkspaceStorageEntry>,
}

#[derive(Serialize, Debug, Clone)]
pub struct OrphanedWorktree {
    pub path: String,
    pub size_bytes: u64,
    /// The path-slug component of `<base>/<slug>/<wt_name>` — i.e. the
    /// parent directory name. Matches `Repository.path_slug` for repos
    /// the DB still knows about.
    pub inferred_repo_slug: String,
    /// Repository display name resolved by slug match; `None` when the
    /// slug doesn't correspond to any DB repo (the canonical "DB was
    /// nuked" case).
    pub inferred_repo_name: Option<String>,
}

/// Compute per-repo storage statistics. For each workspace: walk its
/// worktree directory when one exists on disk, otherwise (the archived
/// case, or a setup-failed row) sum the bytes the workspace would
/// reclaim from the checkpoint store on delete. Per-workspace work
/// happens on the blocking pool so neither a large worktree tree nor a
/// large checkpoint history serializes the whole computation.
#[tauri::command]
pub async fn compute_storage_stats(
    state: State<'_, AppState>,
) -> Result<Vec<RepoStorageStats>, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let workspaces = db.list_workspaces().map_err(|e| e.to_string())?;
    // Drop workspaces whose repository_id no longer resolves to a real
    // row — those would still spawn a blocking size walk (wasted work)
    // and produce a `RepoStorageStats` entry that the frontend silently
    // drops via `statsById.get(repo.id)`, making the bytes invisible to
    // the user. Better to skip the walk entirely and let the orphan
    // scanner surface those dirs as "Unknown repository" cards.
    let known_repo_ids: std::collections::HashSet<String> = db
        .list_repositories()
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|r| r.id)
        .collect();

    // Spawn one blocking task per workspace. When a worktree dir
    // exists, walk it for the on-disk size. When it doesn't (the
    // archived case, or a setup-failed row), open a fresh Database
    // connection inside the task and sum the checkpoint bytes the
    // workspace would reclaim on delete — that's the only meaningful
    // size signal once the worktree is gone.
    struct Pending {
        id: String,
        name: String,
        status: WorkspaceStatus,
        repository_id: String,
        worktree_path: Option<String>,
        size_handle: tokio::task::JoinHandle<u64>,
    }

    let mut pending: Vec<Pending> = Vec::with_capacity(workspaces.len());
    for ws in workspaces {
        if !known_repo_ids.contains(&ws.repository_id) {
            continue;
        }
        let workspace_id = ws.id.clone();
        let worktree_path_opt = ws.worktree_path.clone();
        let db_path = state.db_path.clone();
        let size_handle = tokio::task::spawn_blocking(move || -> u64 {
            if let Some(p) = worktree_path_opt.as_deref()
                && Path::new(p).is_dir()
            {
                return directory_size_bytes(Path::new(p));
            }
            // No worktree to walk — fall back to reclaimable checkpoint
            // storage. A DB error here is best-effort: treat as 0 so the
            // row still renders (with a possibly low size) rather than
            // failing the whole stats call.
            match Database::open(&db_path) {
                Ok(db) => db
                    .reclaimable_checkpoint_bytes(&workspace_id)
                    .unwrap_or(0),
                Err(_) => 0,
            }
        });
        pending.push(Pending {
            id: ws.id,
            name: ws.name,
            status: ws.status,
            repository_id: ws.repository_id,
            worktree_path: ws.worktree_path,
            size_handle,
        });
    }

    // Aggregate by repository_id, preserving workspace insertion order
    // within each repo. Use a `Vec` for the stable returned ordering
    // (matches sidebar/Settings expectations) plus an auxiliary
    // `HashMap<repo_id, Vec index>` so the per-row slot lookup is O(1)
    // instead of the previous O(N) `iter_mut().find(...)`. Matters when
    // both `StorageSettings` and `BulkCleanupArchivedModal` mount the
    // scan back-to-back on every archived-id change.
    let mut by_repo: Vec<RepoStorageStats> = Vec::new();
    let mut by_repo_index: HashMap<String, usize> = HashMap::new();
    for p in pending {
        let size_bytes = p.size_handle.await.ok();
        let entry = WorkspaceStorageEntry {
            id: p.id,
            name: p.name,
            status: p.status.clone(),
            worktree_path: p.worktree_path,
            size_bytes,
        };
        let bytes = size_bytes.unwrap_or(0);

        let slot_idx = match by_repo_index.get(&p.repository_id) {
            Some(idx) => *idx,
            None => {
                let idx = by_repo.len();
                by_repo.push(RepoStorageStats {
                    repository_id: p.repository_id.clone(),
                    active_bytes: 0,
                    archived_bytes: 0,
                    total_bytes: 0,
                    workspaces: Vec::new(),
                });
                by_repo_index.insert(p.repository_id.clone(), idx);
                idx
            }
        };
        let slot = &mut by_repo[slot_idx];
        match entry.status {
            WorkspaceStatus::Active => slot.active_bytes = slot.active_bytes.saturating_add(bytes),
            WorkspaceStatus::Archived => {
                slot.archived_bytes = slot.archived_bytes.saturating_add(bytes)
            }
        }
        slot.total_bytes = slot.total_bytes.saturating_add(bytes);
        slot.workspaces.push(entry);
    }

    Ok(by_repo)
}

/// Walk `<base>/<slug>/<wt_name>/` two levels deep and return every
/// leaf-dir-path-plus-slug pair whose canonical path is not in
/// `tracked_paths`. Pure (no DB / state access) so it can be unit-tested
/// with a tempdir.
fn detect_orphaned_dirs(
    base: &Path,
    tracked_paths: &std::collections::HashSet<String>,
) -> Vec<(String, String)> {
    let mut found: Vec<(String, String)> = Vec::new();
    let slug_entries = match std::fs::read_dir(base) {
        Ok(e) => e,
        Err(_) => return found,
    };
    for slug_entry in slug_entries.flatten() {
        let slug_path = slug_entry.path();
        let Ok(meta) = slug_entry.metadata() else {
            continue;
        };
        if !meta.is_dir() {
            continue;
        }
        let slug_name = match slug_path.file_name() {
            Some(n) => n.to_string_lossy().to_string(),
            None => continue,
        };
        let wt_entries = match std::fs::read_dir(&slug_path) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for wt_entry in wt_entries.flatten() {
            let wt_path = wt_entry.path();
            let Ok(wt_meta) = wt_entry.metadata() else {
                continue;
            };
            if !wt_meta.is_dir() {
                continue;
            }
            let wt_str = wt_path.to_string_lossy().to_string();
            let canon = std::fs::canonicalize(&wt_path)
                .map(|c| c.to_string_lossy().to_string())
                .unwrap_or_else(|_| wt_str.clone());
            if tracked_paths.contains(&canon) || tracked_paths.contains(&wt_str) {
                continue;
            }
            found.push((wt_str, slug_name.clone()));
        }
    }
    found
}

/// Pure validation logic for `purge_orphaned_worktree`. The Tauri command
/// resolves `base` + workspace claims and delegates the safety checks
/// to this function so they can be unit-tested.
fn validate_orphaned_purge_target(
    target_path: &str,
    base: &Path,
    workspace_paths: &[String],
) -> Result<(), String> {
    let base_canon = canon_or_raw(base.to_string_lossy().as_ref());

    // Fail fast on unresolvable / relative target paths. The scan
    // command only ever returns canonical absolute paths, so the only
    // way to get here with a relative or non-existent path is a buggy
    // or malicious caller. Returning a clear "could not resolve" beats
    // the misleading "outside base" message the `starts_with` check
    // below would produce for relative input.
    let target_canon = match std::fs::canonicalize(target_path) {
        Ok(c) => c.to_string_lossy().to_string(),
        Err(_) if Path::new(target_path).is_absolute() => target_path.to_string(),
        Err(e) => {
            return Err(format!("Could not resolve path '{target_path}': {e}"));
        }
    };
    let target_raw = target_path.to_string();

    // Hard guard: target must be a strict descendant of base.
    if target_canon == base_canon || !Path::new(&target_canon).starts_with(&base_canon) {
        return Err(format!(
            "Refusing to delete '{target_path}' — outside the workspace base directory"
        ));
    }

    // Refuse if any active or archived workspace still claims this path.
    // 4-way pair compare mirrors validate_purge_target in workspace.rs —
    // every combination of {canonical, raw} on each side, so a stored
    // path whose dir was deleted (canonicalize falls back to raw on the
    // workspace side) still matches against a canonicalized target.
    let claimed = workspace_paths.iter().any(|p| {
        let p_canon = canon_or_raw(p);
        p_canon == target_canon
            || p_canon == target_raw
            || p.as_str() == target_canon.as_str()
            || p.as_str() == target_raw.as_str()
    });
    if claimed {
        return Err(
            "Path is tracked as a Claudette workspace — use the workspace's archive flow instead"
                .into(),
        );
    }

    Ok(())
}

/// Scan the configured workspace base dir for orphan worktree dirs.
///
/// Looks at `<base>/<slug>/<wt_name>/` two levels deep. Any leaf dir
/// whose canonical path doesn't match a tracked workspace's
/// `worktree_path` is reported. The slug is whatever was at the first
/// level — when it matches a DB repo's `path_slug`, the orphan is
/// "inferred" to belong to that repo; otherwise the slug stands alone
/// (the user nuked the DB but kept the worktrees, or imported from
/// another machine).
///
/// Does not modify anything. Callers pair this with
/// `purge_orphaned_worktree` to delete.
#[tauri::command]
pub async fn scan_orphaned_worktrees(
    state: State<'_, AppState>,
) -> Result<Vec<OrphanedWorktree>, String> {
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let workspaces = db.list_workspaces().map_err(|e| e.to_string())?;
    let repos = db.list_repositories().map_err(|e| e.to_string())?;
    let base = state.worktree_base_dir.read().await.clone();

    // Canonicalize every tracked workspace path so the comparison
    // doesn't repeatedly hit the filesystem. `canon_with_parent_fallback`
    // handles the case where the leaf dir was deleted but the parent
    // still exists — without it, a stale row pointing at a no-longer-
    // existing path would only mask a same-raw-string orphan dir, and
    // any `/tmp` vs `/private/tmp` canonical-form difference would
    // surface the same dir as both tracked AND orphan.
    let tracked_paths: std::collections::HashSet<String> = workspaces
        .iter()
        .filter_map(|w| w.worktree_path.as_deref())
        .flat_map(|p| {
            [
                p.to_string(),
                canon_or_raw(p),
                canon_with_parent_fallback(p),
            ]
        })
        .collect();

    // Map slug -> display name so we can label orphans by their owning
    // repo. Slug duplicates shouldn't happen (DB enforces unique
    // path_slug), but if they did, last-write-wins is fine.
    let slug_to_repo_name: std::collections::HashMap<String, String> = repos
        .iter()
        .map(|r| (r.path_slug.clone(), r.name.clone()))
        .collect();

    let base_for_log = base.display().to_string();
    let tracked_count = tracked_paths.len();
    let orphaned = tokio::task::spawn_blocking(move || detect_orphaned_dirs(&base, &tracked_paths))
        .await
        .map_err(|e| format!("orphaned scan join error: {e}"))?;
    tracing::info!(
        target: "claudette::storage",
        base = %base_for_log,
        tracked_path_keys = tracked_count,
        orphan_count = orphaned.len(),
        "scan_orphaned_worktrees complete"
    );

    // Second pass: compute sizes (also on blocking pool) and look up
    // inferred repo names. Sizes run concurrently.
    let mut size_handles: Vec<(String, String, tokio::task::JoinHandle<u64>)> = Vec::new();
    for (path, slug) in orphaned {
        let p = PathBuf::from(&path);
        let handle = tokio::task::spawn_blocking(move || directory_size_bytes(&p));
        size_handles.push((path, slug, handle));
    }

    let mut results = Vec::with_capacity(size_handles.len());
    for (path, slug, handle) in size_handles {
        let size = handle.await.unwrap_or(0);
        let inferred_repo_name = slug_to_repo_name.get(&slug).cloned();
        results.push(OrphanedWorktree {
            path,
            size_bytes: size,
            inferred_repo_slug: slug,
            inferred_repo_name,
        });
    }

    Ok(results)
}

/// Delete an orphaned worktree dir. Refuses anything not under the
/// configured worktree base — a caller cannot use this command to
/// remove arbitrary filesystem paths even via prompt injection.
#[tauri::command]
pub async fn purge_orphaned_worktree(
    path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let base = state.worktree_base_dir.read().await.clone();
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let workspaces = db.list_workspaces().map_err(|e| e.to_string())?;
    let workspace_paths: Vec<String> = workspaces
        .iter()
        .filter_map(|w| w.worktree_path.clone())
        .collect();

    validate_orphaned_purge_target(&path, &base, &workspace_paths)?;

    let target = path.clone();
    tokio::task::spawn_blocking(move || std::fs::remove_dir_all(&target))
        .await
        .map_err(|e| format!("fs cleanup join error: {e}"))?
        .map_err(|e| format!("fs cleanup failed: {e}"))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{detect_orphaned_dirs, validate_orphaned_purge_target};
    use std::collections::HashSet;

    /// Build the standard `<base>/<slug>/<wt_name>/` two-level tree
    /// shape that Claudette puts worktrees in, populate it, and return
    /// the tempdir + paths the test can reference.
    struct Tree {
        _dir: tempfile::TempDir,
        base: std::path::PathBuf,
    }
    fn make_tree(slugs_and_wts: &[(&str, &[&str])]) -> Tree {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().to_path_buf();
        for (slug, wts) in slugs_and_wts {
            for wt in *wts {
                std::fs::create_dir_all(base.join(slug).join(wt)).unwrap();
            }
        }
        Tree { _dir: dir, base }
    }

    #[test]
    fn detect_orphaned_returns_empty_when_every_dir_is_tracked() {
        let tree = make_tree(&[("my-repo", &["alpha", "beta"])]);
        let tracked: HashSet<String> = [
            tree.base
                .join("my-repo/alpha")
                .to_string_lossy()
                .to_string(),
            tree.base.join("my-repo/beta").to_string_lossy().to_string(),
        ]
        .into_iter()
        .collect();
        // Also include canonical forms so /tmp vs /private/tmp doesn't
        // confuse the test on macOS.
        let mut tracked_full = tracked.clone();
        for p in &tracked {
            if let Ok(c) = std::fs::canonicalize(p) {
                tracked_full.insert(c.to_string_lossy().to_string());
            }
        }
        let orphaned = detect_orphaned_dirs(&tree.base, &tracked_full);
        assert!(
            orphaned.is_empty(),
            "expected no orphaned dirs, got {orphaned:?}"
        );
    }

    #[test]
    fn detect_orphaned_finds_untracked_leaf_dirs() {
        let tree = make_tree(&[
            ("my-repo", &["tracked", "orphan-a"]),
            ("dead-slug", &["orphan-b"]),
        ]);
        let tracked: HashSet<String> = [tree
            .base
            .join("my-repo/tracked")
            .to_string_lossy()
            .to_string()]
        .into_iter()
        .collect();
        let mut tracked_full = tracked.clone();
        for p in &tracked {
            if let Ok(c) = std::fs::canonicalize(p) {
                tracked_full.insert(c.to_string_lossy().to_string());
            }
        }
        let orphaned = detect_orphaned_dirs(&tree.base, &tracked_full);
        assert_eq!(
            orphaned.len(),
            2,
            "expected 2 orphaned dirs, got {orphaned:?}"
        );
        let slugs: HashSet<&str> = orphaned.iter().map(|(_, s)| s.as_str()).collect();
        assert!(slugs.contains("my-repo"));
        assert!(slugs.contains("dead-slug"));
    }

    #[test]
    fn detect_orphaned_ignores_files_at_either_level() {
        let tree = make_tree(&[("my-repo", &["wt-a"])]);
        // Drop a stray file at base level — should not be reported.
        std::fs::write(tree.base.join("loose-file"), "x").unwrap();
        // Drop a file inside the slug dir — also should not be reported.
        std::fs::write(tree.base.join("my-repo/README.md"), "x").unwrap();
        let orphaned = detect_orphaned_dirs(&tree.base, &HashSet::new());
        assert_eq!(
            orphaned.len(),
            1,
            "expected only the wt-a dir, got {orphaned:?}"
        );
        assert_eq!(orphaned[0].1, "my-repo");
    }

    #[test]
    fn detect_orphaned_returns_empty_for_missing_base() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("does-not-exist");
        let orphaned = detect_orphaned_dirs(&missing, &HashSet::new());
        assert!(orphaned.is_empty());
    }

    #[test]
    fn validate_orphaned_purge_rejects_path_outside_base() {
        let tree = make_tree(&[("my-repo", &["wt-a"])]);
        let other = tempfile::tempdir().unwrap();
        let outside = other.path().join("not-in-base");
        std::fs::create_dir_all(&outside).unwrap();
        let result = validate_orphaned_purge_target(outside.to_str().unwrap(), &tree.base, &[]);
        assert!(result.is_err(), "expected rejection, got {result:?}");
        assert!(
            result.unwrap_err().contains("outside the workspace base"),
            "wrong rejection reason"
        );
    }

    #[test]
    fn validate_orphaned_purge_rejects_base_itself() {
        let tree = make_tree(&[("my-repo", &["wt-a"])]);
        let result = validate_orphaned_purge_target(tree.base.to_str().unwrap(), &tree.base, &[]);
        assert!(
            result.is_err(),
            "expected base-path rejection, got {result:?}"
        );
    }

    #[test]
    fn validate_orphaned_purge_rejects_path_claimed_by_workspace() {
        let tree = make_tree(&[("my-repo", &["wt-a"])]);
        let wt = tree.base.join("my-repo/wt-a");
        let wt_str = wt.to_str().unwrap().to_string();
        // Workspace row still claims this path → must reject.
        let result = validate_orphaned_purge_target(&wt_str, &tree.base, &[wt_str.clone()]);
        assert!(
            result.is_err(),
            "expected workspace-claim rejection, got {result:?}"
        );
        assert!(
            result
                .unwrap_err()
                .contains("tracked as a Claudette workspace"),
            "wrong rejection reason"
        );
    }

    #[test]
    fn validate_orphaned_purge_accepts_dir_under_base_with_no_claim() {
        let tree = make_tree(&[("my-repo", &["orphan-wt"])]);
        let wt = tree.base.join("my-repo/orphan-wt");
        let result = validate_orphaned_purge_target(wt.to_str().unwrap(), &tree.base, &[]);
        assert!(result.is_ok(), "expected accept, got {result:?}");
    }

    #[test]
    fn validate_orphaned_purge_rejects_relative_unresolvable_path_with_clear_error() {
        let tree = make_tree(&[("my-repo", &["orphan-wt"])]);
        // A relative path that doesn't exist — canonicalize fails AND
        // it isn't absolute, so the early-return clear-error branch
        // should fire instead of the misleading "outside base" message.
        let result = validate_orphaned_purge_target("./does-not-exist", &tree.base, &[]);
        assert!(result.is_err(), "expected rejection, got {result:?}");
        let err = result.unwrap_err();
        assert!(
            err.contains("Could not resolve path"),
            "expected resolve-failure message, got: {err}"
        );
    }
}
