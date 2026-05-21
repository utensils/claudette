use std::path::Path;
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use claudette::file_watcher::FileWatcher;

use crate::state::AppState;

use super::workspace_ops::{normalize_relative_path, resolve_worktree_path};

/// Payload for the `workspace-file-changed` Tauri event. The frontend
/// hook subscribes once at app start and routes every event by
/// `(workspace_id, path)` against its open file tabs.
#[derive(Clone, Serialize)]
pub struct WorkspaceFileChangedPayload {
    pub workspace_id: String,
    /// Path the frontend originally registered (worktree-relative). The
    /// watcher round-trips it through the callback so the frontend
    /// doesn't have to re-derive worktree-relative form from absolute
    /// event paths reported by the OS.
    pub path: String,
}

/// Build the file-viewer fs watcher and stash it on `AppState`.
///
/// Mirrors `setup_env_watcher`: we wait until the `AppHandle` is
/// available (the Tauri setup hook is the earliest moment), wire the
/// change callback to emit `workspace-file-changed`, and swap the
/// resulting `Arc<FileWatcher>` into `state.file_watcher` for the
/// `watch_workspace_files` command to use.
///
/// Construction failure (Linux inotify cap exhausted at startup,
/// headless CI without a kernel that supports the recommended backend)
/// is logged and swallowed: the file viewer continues to work, it just
/// doesn't reflect external changes in realtime — same fallback shape
/// as the env watcher.
pub fn setup_file_watcher(app: AppHandle) {
    let app_for_cb = app.clone();
    let watcher = match FileWatcher::new(Arc::new(move |workspace_id, path| {
        let _ = app_for_cb.emit(
            "workspace-file-changed",
            WorkspaceFileChangedPayload {
                workspace_id: workspace_id.to_string(),
                path: path.to_string(),
            },
        );
    })) {
        Ok(w) => Arc::new(w),
        Err(err) => {
            tracing::warn!(
                target: "claudette::file-watcher",
                error = %err,
                "failed to start — realtime buffer refresh disabled"
            );
            return;
        }
    };
    let app_for_store = app.clone();
    tauri::async_runtime::block_on(async move {
        let state = app_for_store.state::<AppState>();
        *state.file_watcher.write().await = Some(watcher);
    });
}

/// Replace the watch set for `workspace_id` with `paths`. Idempotent —
/// the frontend re-asserts the full open-file-tab list on every open
/// or close so this is the only mutation API needed. Worktree-relative
/// paths are resolved against the workspace's worktree.
///
/// Silently no-ops if the watcher failed to construct at startup or if
/// the workspace has no worktree (it's a remote workspace, or its
/// worktree was deleted out from under us).
///
/// `paths` is filtered server-side: any entry that's absolute, contains
/// `..`, or otherwise escapes the worktree is dropped before reaching
/// the watcher. Reads (`read_workspace_file_for_viewer`) already enforce
/// this on their side, but the watcher does its own `canonicalize` +
/// `notify::Watcher::watch` and could otherwise burn OS watch quota on
/// paths the frontend has no business asking us to monitor — even if a
/// rogue payload couldn't read them back through the matching read
/// command. The filter mirrors `normalize_relative_path` so the same
/// rules govern reads and watches.
#[tauri::command]
pub async fn watch_workspace_files(
    workspace_id: String,
    paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let worktree_path = match resolve_worktree_path(&workspace_id, &state) {
        Ok(p) => p,
        // Remote workspaces have no local worktree to watch — skip
        // silently. The frontend will still display files (loaded over
        // the remote transport) but realtime updates aren't expected
        // for those today.
        Err(_) => return Ok(()),
    };
    let safe_paths: Vec<String> = paths
        .into_iter()
        .filter(|p| normalize_relative_path(p).is_ok())
        .collect();
    let watcher_guard = state.file_watcher.read().await;
    let Some(watcher) = watcher_guard.as_ref() else {
        return Ok(());
    };
    watcher.register(&workspace_id, Path::new(&worktree_path), &safe_paths);
    Ok(())
}

/// Drop every file watch belonging to `workspace_id`. Called when the
/// frontend tears down a workspace (delete, archive) or when the user
/// switches away — the new workspace's `watch_workspace_files` call
/// re-establishes only the relevant subset.
#[tauri::command]
pub async fn unwatch_workspace_files(
    workspace_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let watcher_guard = state.file_watcher.read().await;
    let Some(watcher) = watcher_guard.as_ref() else {
        return Ok(());
    };
    watcher.unregister_workspace(&workspace_id);
    Ok(())
}
