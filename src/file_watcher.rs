//! Cross-platform filesystem watcher for the file viewer's open buffers.
//!
//! When the user opens a file in the in-app editor we want the buffer to
//! follow disk: an agent edit, an external `git checkout`, or a manual
//! save in another editor should appear in Monaco automatically. The
//! [`FileWatcher`] is the transport layer for that — the frontend
//! subscribes the workspace's open file paths, this watcher fires a
//! callback per change, and the Tauri layer turns the callback into a
//! `workspace-file-changed` event the React side listens for.
//!
//! Modeled directly on [`crate::env_provider::EnvWatcher`] — same
//! `notify::RecommendedWatcher` (FSEvents on macOS, inotify on Linux,
//! ReadDirectoryChangesW on Windows), same per-path dedupe via a
//! `subscribers` index, same retry-on-next-register strategy for paths
//! that weren't watchable at first registration. Keeping the two close
//! in shape means future improvements (e.g. debounce, glob patterns)
//! land in both places easily.
//!
//! # Lifetime model
//!
//! The watcher is keyed by `(workspace_id, path)`. The frontend re-asserts
//! the full path set for the active workspace whenever the user opens or
//! closes a file tab, so the watcher is fundamentally idempotent: the
//! caller passes a desired set, and we install / uninstall OS watches to
//! converge. Closing the last subscriber to a path drops the OS watch.
//!
//! # Deliberate non-features
//!
//! - **No event payload semantics.** We treat any kind we consider
//!   "interesting" as a hint that the file may have changed; the caller
//!   re-reads the file and decides via content equality whether anything
//!   actually moved. This avoids leaning on backend-specific event-kind
//!   guarantees that differ across FSEvents / inotify / RDCW.
//! - **No debounce.** Editors commonly do save-swap-rename dances that
//!   produce 2–3 events per save; the frontend re-reads the file
//!   on each event and bails out if the content matches the current
//!   baseline. The redundant reads are cheap and cleaner than a debounce
//!   that risks dropping a real change behind a quick second one.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::event::{EventKind, ModifyKind, RemoveKind};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};

/// Identifier of a single subscriber: `(workspace_id, relative_path)`. The
/// callback receives both so the Tauri layer can route the event back to
/// the right webview state without an extra lookup.
type Key = (String, String);

/// Callback fired per `(workspace_id, path)` subscriber whose watch path
/// matches a filesystem event. Must be `Send + Sync + 'static` because
/// events arrive on `notify`'s background thread.
pub type OnChange = Arc<dyn Fn(&str, &str) + Send + Sync + 'static>;

/// Cross-platform filesystem watcher for open file-viewer buffers.
///
/// Cloning via `Arc` is the intended shared-ownership pattern, mirroring
/// [`crate::env_provider::EnvWatcher`].
pub struct FileWatcher {
    /// Routing state shared with the background notify task. Plain
    /// `Mutex` (not tokio's) because notify fires events off an OS
    /// thread, not an async context.
    state: Arc<Mutex<WatcherState>>,
    /// Owned `RecommendedWatcher`. Dropping it stops the backend thread.
    /// Held under a `Mutex` because `watch`/`unwatch` take `&mut self`
    /// and we may call them from any tauri command thread.
    watcher: Mutex<RecommendedWatcher>,
}

/// Internal routing state. Separated from [`FileWatcher`] so the notify
/// event handler closure can hold an `Arc<Mutex<WatcherState>>` without
/// also pinning the `Watcher` (whose `&mut self` API would conflict).
struct WatcherState {
    /// Absolute path → set of `(workspace_id, relative_path)` subscribers
    /// that care about it.
    subscribers: HashMap<PathBuf, HashSet<Key>>,
    /// Reverse index: `(workspace_id, relative_path)` → absolute path it
    /// subscribes to. Lets unregister run in O(1) instead of O(total).
    /// Each subscriber maps to exactly one absolute path because file
    /// tabs are per-file — no need for the env-watcher's set-valued
    /// reverse map.
    key_paths: HashMap<Key, PathBuf>,
    /// Per-workspace ids for fast workspace-wide unsubscribe (closing a
    /// workspace, switching to a different one, etc.).
    workspace_keys: HashMap<String, HashSet<Key>>,
    /// Set of paths we have a live OS watch on. Distinct from
    /// `subscribers` because a path may be subscribed-but-not-OS-watched
    /// when `notify::watch` returns an error (file missing, OS limits).
    /// `register` retries any subscribed path that isn't here, so a file
    /// that gets created later starts participating without a restart.
    os_watched: HashSet<PathBuf>,
    on_change: OnChange,
}

impl FileWatcher {
    /// Build a watcher. The callback fires per `(workspace_id,
    /// relative_path)` subscriber whose registered path is touched.
    /// Typical implementation: emit a Tauri event for the frontend to
    /// pick up.
    ///
    /// ```ignore
    /// FileWatcher::new(Arc::new(move |workspace_id, path| {
    ///     let _ = app_handle.emit(
    ///         "workspace-file-changed",
    ///         WorkspaceFileChangedPayload {
    ///             workspace_id: workspace_id.to_string(),
    ///             path: path.to_string(),
    ///         },
    ///     );
    /// }))
    /// ```
    pub fn new(on_change: OnChange) -> notify::Result<Self> {
        let state = Arc::new(Mutex::new(WatcherState {
            subscribers: HashMap::new(),
            key_paths: HashMap::new(),
            workspace_keys: HashMap::new(),
            os_watched: HashSet::new(),
            on_change,
        }));

        let state_for_handler = Arc::clone(&state);
        let handler = move |res: notify::Result<notify::Event>| {
            let Ok(event) = res else {
                // Transient backend errors (FSEvents buffer overflow,
                // inotify queue overflow) — don't log spam, the next
                // event will catch us up.
                return;
            };
            if !is_interesting(&event.kind) {
                return;
            }
            // Backends report paths in their canonical form (FSEvents
            // resolves /var → /private/var on macOS) but inotify and
            // RDCW report whatever was registered. Look up both.
            let mut lookup_paths: Vec<PathBuf> = Vec::with_capacity(event.paths.len() * 2);
            for path in &event.paths {
                lookup_paths.push(path.clone());
                let canon = canonicalize_or_keep(path);
                if canon != *path {
                    lookup_paths.push(canon);
                }
            }

            let state = state_for_handler.lock().unwrap();
            let mut fired: HashSet<Key> = HashSet::new();
            for path in &lookup_paths {
                if let Some(keys) = state.subscribers.get(path) {
                    for key in keys {
                        fired.insert(key.clone());
                    }
                }
            }
            if fired.is_empty() {
                return;
            }
            let cb = Arc::clone(&state.on_change);
            // Drop the lock before invoking user code — the callback
            // may synchronously call back into Tauri (emit) and we
            // don't want to hold the routing lock across that.
            drop(state);
            for (workspace_id, path) in fired {
                cb(&workspace_id, &path);
            }
        };

        // The poll-interval only applies to the polling-fallback
        // watcher; on macOS / Linux / Windows, RecommendedWatcher uses
        // FSEvents / inotify / RDCW respectively and ignores it. Keep
        // it set to a reasonable default for hosts where the fallback
        // does activate (rare — usually exotic filesystems).
        let config = notify::Config::default().with_poll_interval(Duration::from_millis(300));
        let watcher = notify::recommended_watcher(handler).and_then(|mut w| {
            w.configure(config)?;
            Ok(w)
        })?;

        Ok(Self {
            state,
            watcher: Mutex::new(watcher),
        })
    }

    /// Replace the watch set for `workspace_id` with the given relative
    /// paths, resolved against `worktree_root`. Idempotent — callers can
    /// re-assert the full set on every tab open/close.
    ///
    /// Paths are canonicalized so events from FSEvents (which reports
    /// canonical forms) match the subscriber lookup. A canonicalize
    /// failure (broken symlink, file gone) falls back to the original
    /// path — the subscriber is still tracked, and a future register
    /// pass retries the OS watch install.
    pub fn register(&self, workspace_id: &str, worktree_root: &Path, relative_paths: &[String]) {
        // Build the desired key→path map for this workspace, capturing
        // both the canonical absolute path (for OS watch + event lookup)
        // and the relative path (for callback round-trip to the
        // frontend, which doesn't know our worktree layout).
        let desired: HashMap<Key, PathBuf> = relative_paths
            .iter()
            .map(|rel| {
                let abs = worktree_root.join(rel);
                let canon = canonicalize_or_keep(&abs);
                ((workspace_id.to_string(), rel.clone()), canon)
            })
            .collect();

        let (to_try_watch, to_remove): (Vec<PathBuf>, Vec<PathBuf>) = {
            let mut state = self.state.lock().unwrap();

            // Compute prior keys for this workspace and figure out
            // which subscribers are gone after this register call.
            let prior_keys = state
                .workspace_keys
                .remove(workspace_id)
                .unwrap_or_default();
            let desired_keys: HashSet<Key> = desired.keys().cloned().collect();
            let stale_keys = prior_keys
                .difference(&desired_keys)
                .cloned()
                .collect::<Vec<_>>();

            // Drop stale subscriber entries.
            let mut paths_freed: Vec<PathBuf> = Vec::new();
            for key in stale_keys {
                if let Some(path) = state.key_paths.remove(&key)
                    && let Some(subs) = state.subscribers.get_mut(&path)
                {
                    subs.remove(&key);
                    if subs.is_empty() {
                        state.subscribers.remove(&path);
                        paths_freed.push(path);
                    }
                }
            }

            // Add new subscribers; record the workspace's full set. If
            // a key was already registered against a *different*
            // canonical path (e.g. canonicalize fell back to the raw
            // path on the first register because the file didn't exist,
            // and now resolves to its real location through a symlink),
            // we have to drop the key from the old path's subscriber
            // set first — otherwise that entry leaks: subsequent
            // events on the old path still fire the callback, and
            // `unregister_workspace` walks `key_paths` (which only
            // holds the new path) so it can't reach the orphan.
            for (key, path) in &desired {
                if let Some(prior_path) = state.key_paths.get(key).cloned()
                    && prior_path != *path
                    && let Some(subs) = state.subscribers.get_mut(&prior_path)
                {
                    subs.remove(key);
                    if subs.is_empty() {
                        state.subscribers.remove(&prior_path);
                        paths_freed.push(prior_path);
                    }
                }
                state
                    .subscribers
                    .entry(path.clone())
                    .or_default()
                    .insert(key.clone());
                state.key_paths.insert(key.clone(), path.clone());
            }
            state
                .workspace_keys
                .insert(workspace_id.to_string(), desired_keys);

            // Paths to try installing an OS watch on: those subscribed
            // but not yet OS-watched. Preserves the env-watcher
            // retry-on-next-register guarantee for files that didn't
            // exist at first registration.
            let to_try_watch: Vec<PathBuf> = desired
                .values()
                .filter(|p| !state.os_watched.contains(*p))
                .cloned()
                .collect();
            // Paths fully released: the prior workspace had them and
            // nobody else cares. Caller will unwatch them.
            let to_remove: Vec<PathBuf> = paths_freed
                .into_iter()
                .filter(|p| !state.subscribers.contains_key(p))
                .collect();
            (to_try_watch, to_remove)
        };

        let mut watcher = self.watcher.lock().unwrap();
        for path in &to_remove {
            // Re-check that nobody else picked the path up between the
            // state-lock release and now. `watch_workspace_files` is
            // fire-and-forget from the frontend, so a second `register`
            // call could land on a tauri worker thread and add a
            // subscriber for the same path while we're holding only
            // the watcher lock. If we unconditionally `unwatch` here,
            // that concurrent registration ends up with a subscriber
            // recorded but no live OS watch, missing events until the
            // *next* register pass retries via the os_watched diff.
            // Mirrors the same defense in `unregister_workspace`.
            let still_needed = self.state.lock().unwrap().subscribers.contains_key(path);
            if !still_needed {
                let _ = watcher.unwatch(path);
                self.state.lock().unwrap().os_watched.remove(path);
            }
        }
        for path in &to_try_watch {
            match watcher.watch(path, RecursiveMode::NonRecursive) {
                Ok(()) => {
                    self.state.lock().unwrap().os_watched.insert(path.clone());
                }
                Err(err) => {
                    // Same calculus as EnvWatcher: silently skip
                    // "file not found" — common when a tab is opened
                    // for a not-yet-created file (e.g. agent staged a
                    // create that hasn't landed yet). Other errors
                    // (permission denied, OS watch limit) are louder.
                    if !is_path_not_found(&err) {
                        tracing::warn!(
                            target: "claudette::file-watcher",
                            path = %path.display(),
                            error = %err,
                            "failed to watch path"
                        );
                    }
                }
            }
        }
    }

    /// Drop every watch belonging to `workspace_id`. Called on
    /// workspace deletion or when the user navigates away from an
    /// active workspace whose file-viewer tabs we no longer need to
    /// follow.
    pub fn unregister_workspace(&self, workspace_id: &str) {
        let removed_paths: Vec<PathBuf> = {
            let mut state = self.state.lock().unwrap();
            let keys = state
                .workspace_keys
                .remove(workspace_id)
                .unwrap_or_default();
            let mut freed: Vec<PathBuf> = Vec::new();
            for key in keys {
                if let Some(path) = state.key_paths.remove(&key)
                    && let Some(subs) = state.subscribers.get_mut(&path)
                {
                    subs.remove(&key);
                    if subs.is_empty() {
                        state.subscribers.remove(&path);
                        freed.push(path);
                    }
                }
            }
            freed
        };

        let mut watcher = self.watcher.lock().unwrap();
        for path in &removed_paths {
            // Re-check that nobody else picked the path up between the
            // state-lock release and now. The intervening Mutex drop
            // means another `register` call could have re-subscribed
            // the same path; if so, leave the OS watch in place.
            let still_needed = self.state.lock().unwrap().subscribers.contains_key(path);
            if !still_needed {
                let _ = watcher.unwatch(path);
                self.state.lock().unwrap().os_watched.remove(path);
            }
        }
    }

    #[cfg(test)]
    pub fn watched_path_count(&self) -> usize {
        self.state.lock().unwrap().subscribers.len()
    }

    #[cfg(test)]
    pub fn registered_key_count(&self) -> usize {
        self.state.lock().unwrap().key_paths.len()
    }
}

fn is_path_not_found(err: &notify::Error) -> bool {
    use notify::ErrorKind;
    match &err.kind {
        ErrorKind::PathNotFound => true,
        ErrorKind::Io(io) => io.kind() == std::io::ErrorKind::NotFound,
        _ => false,
    }
}

fn canonicalize_or_keep(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// True for event kinds that imply file content may have changed.
/// Filters out access-only events (reads, opens, attribute changes
/// without data) — those would force redundant reads. The set mirrors
/// [`crate::env_provider::watcher`]'s filter to keep behavior
/// consistent across the two watchers.
fn is_interesting(kind: &EventKind) -> bool {
    matches!(
        kind,
        EventKind::Create(_)
            | EventKind::Modify(ModifyKind::Data(_))
            | EventKind::Modify(ModifyKind::Name(_))
            | EventKind::Modify(ModifyKind::Any)
            | EventKind::Remove(RemoveKind::File)
            | EventKind::Remove(RemoveKind::Folder)
            | EventKind::Remove(RemoveKind::Any)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Instant;

    fn wait_for(timeout: Duration, predicate: impl Fn() -> bool) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if predicate() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        predicate()
    }

    #[test]
    fn register_then_modify_fires_callback() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("foo.ts");
        std::fs::write(&file, "old").unwrap();

        let hits: Arc<Mutex<Vec<(String, String)>>> = Arc::new(Mutex::new(Vec::new()));
        let hits_cb = Arc::clone(&hits);
        let watcher = FileWatcher::new(Arc::new(move |ws, p| {
            hits_cb
                .lock()
                .unwrap()
                .push((ws.to_string(), p.to_string()));
        }))
        .unwrap();

        watcher.register("ws-1", tmp.path(), &["foo.ts".to_string()]);

        std::thread::sleep(Duration::from_millis(50));
        std::fs::write(&file, "new").unwrap();

        assert!(
            wait_for(Duration::from_secs(3), || !hits.lock().unwrap().is_empty()),
            "callback did not fire within 3s"
        );
        let observed = hits.lock().unwrap().clone();
        assert!(
            observed.iter().any(|(ws, p)| ws == "ws-1" && p == "foo.ts"),
            "expected (ws-1, foo.ts) hit in {observed:?}"
        );
    }

    #[test]
    fn re_register_drops_stale_paths() {
        // The frontend re-asserts the full open-tab list on every
        // open/close. Closing one tab should stop firing for that
        // path even though the workspace still has other tabs open.
        let tmp = tempfile::tempdir().unwrap();
        let kept = tmp.path().join("kept.ts");
        let dropped = tmp.path().join("dropped.ts");
        std::fs::write(&kept, "x").unwrap();
        std::fs::write(&dropped, "x").unwrap();

        let hits: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
        let hits_cb = Arc::clone(&hits);
        let watcher = FileWatcher::new(Arc::new(move |_, p| {
            hits_cb.lock().unwrap().insert(p.to_string());
        }))
        .unwrap();

        watcher.register(
            "ws-1",
            tmp.path(),
            &["kept.ts".to_string(), "dropped.ts".to_string()],
        );
        assert_eq!(watcher.watched_path_count(), 2);

        // User closes the dropped.ts tab → frontend re-registers with
        // just kept.ts. The watcher should release dropped.ts.
        watcher.register("ws-1", tmp.path(), &["kept.ts".to_string()]);
        assert_eq!(watcher.watched_path_count(), 1);
        assert_eq!(watcher.registered_key_count(), 1);

        std::thread::sleep(Duration::from_millis(50));
        std::fs::write(&dropped, "should-not-fire").unwrap();
        std::fs::write(&kept, "should-fire").unwrap();

        assert!(wait_for(Duration::from_secs(3), || hits
            .lock()
            .unwrap()
            .contains("kept.ts")));
        assert!(
            !hits.lock().unwrap().contains("dropped.ts"),
            "dropped path should not have fired"
        );
    }

    #[test]
    fn two_workspaces_share_path_dedupe() {
        // Two workspaces in the same git checkout layout (worktrees
        // pointing to overlapping files) should each get notified on a
        // single write and share the underlying OS watch.
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("shared.ts");
        std::fs::write(&file, "x").unwrap();

        let hits: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
        let hits_cb = Arc::clone(&hits);
        let watcher = FileWatcher::new(Arc::new(move |ws, _| {
            hits_cb.lock().unwrap().insert(ws.to_string());
        }))
        .unwrap();

        watcher.register("ws-1", tmp.path(), &["shared.ts".to_string()]);
        watcher.register("ws-2", tmp.path(), &["shared.ts".to_string()]);

        // One OS-level watch, two subscribers.
        assert_eq!(watcher.watched_path_count(), 1);
        assert_eq!(watcher.registered_key_count(), 2);

        std::thread::sleep(Duration::from_millis(50));
        std::fs::write(&file, "y").unwrap();

        assert!(wait_for(Duration::from_secs(3), || {
            let h = hits.lock().unwrap();
            h.contains("ws-1") && h.contains("ws-2")
        }));
    }

    #[test]
    fn unregister_workspace_stops_callbacks() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("foo.ts");
        std::fs::write(&file, "x").unwrap();

        let hits = Arc::new(AtomicUsize::new(0));
        let hits_cb = Arc::clone(&hits);
        let watcher = FileWatcher::new(Arc::new(move |_, _| {
            hits_cb.fetch_add(1, Ordering::SeqCst);
        }))
        .unwrap();

        watcher.register("ws-1", tmp.path(), &["foo.ts".to_string()]);
        watcher.unregister_workspace("ws-1");

        assert_eq!(watcher.watched_path_count(), 0);
        assert_eq!(watcher.registered_key_count(), 0);

        std::fs::write(&file, "y").unwrap();
        // Generous slack — must NOT fire after unregister.
        std::thread::sleep(Duration::from_millis(500));
        assert_eq!(hits.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn missing_path_does_not_crash_register() {
        let tmp = tempfile::tempdir().unwrap();
        let watcher = FileWatcher::new(Arc::new(|_, _| {})).unwrap();

        // Path doesn't exist on disk yet; register must not panic and
        // should still record the subscriber so a later create+register
        // can install the watch.
        watcher.register("ws-1", tmp.path(), &["never-created.ts".to_string()]);
        assert_eq!(watcher.registered_key_count(), 1);
    }

    #[test]
    fn re_register_after_canonical_path_shifts_drops_old_subscriber() {
        // Regression for the Copilot finding on `register`: when the
        // first registration happens before the file exists, the
        // canonical fallback is the raw worktree-relative path.
        // Creating the file later (via a real or simulated symlink
        // shift) causes `canonicalize` to resolve to a different
        // absolute path on re-register. Without the prior-path cleanup,
        // the old fallback path stays in `subscribers` and the
        // workspace-wide `unregister_workspace` walk can't find it.
        let tmp = tempfile::tempdir().unwrap();
        let real_dir = tmp.path().join("real");
        std::fs::create_dir(&real_dir).unwrap();
        let real_file = real_dir.join("foo.ts");
        std::fs::write(&real_file, "x").unwrap();

        // Register against a relative path that doesn't exist yet —
        // canonicalize_or_keep falls back to the raw worktree-join.
        let watcher = FileWatcher::new(Arc::new(|_, _| {})).unwrap();
        watcher.register("ws-1", tmp.path(), &["foo.ts".to_string()]);
        assert_eq!(watcher.watched_path_count(), 1);

        // Now make the relative path resolve to a different canonical
        // path: place a symlink at `tmp/foo.ts` → `real/foo.ts`. On
        // re-register, the canonical path shifts. The old path entry
        // must be released so unregister can see it.
        #[cfg(unix)]
        {
            let symlink = tmp.path().join("foo.ts");
            std::os::unix::fs::symlink(&real_file, &symlink).unwrap();
            watcher.register("ws-1", tmp.path(), &["foo.ts".to_string()]);

            // Still exactly one subscriber path — the old fallback
            // entry was released, the new canonical entry took its
            // place. Without the fix this would be 2.
            assert_eq!(
                watcher.watched_path_count(),
                1,
                "expected the prior canonical path to be released",
            );

            // unregister_workspace must clear the live subscriber. If
            // the leak were present, the orphan would survive.
            watcher.unregister_workspace("ws-1");
            assert_eq!(watcher.watched_path_count(), 0);
            assert_eq!(watcher.registered_key_count(), 0);
        }
    }
}
