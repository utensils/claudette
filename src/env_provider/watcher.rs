//! Cross-platform filesystem watcher for env-provider reactive
//! invalidation.
//!
//! The dispatcher's lazy mtime-keyed cache catches up to the filesystem
//! *whenever someone calls `resolve_*`* — but between those calls a user
//! might edit `.envrc`, run `direnv allow`, or change `flake.lock`, and
//! nothing notices until the next spawn. [`EnvWatcher`] closes that gap.
//!
//! # How it's used
//!
//! 1. Callers build an `EnvWatcher` once at app startup, passing a
//!    [`OnChange`] callback that owns the logic for invalidating the
//!    cache and notifying the UI (typically: call
//!    `EnvCache::invalidate` and emit a Tauri event).
//! 2. After every successful resolve, the Tauri layer hands the fresh
//!    watched-path list to [`EnvWatcher::register`] keyed on
//!    `(worktree, plugin)`.
//! 3. When any watched file changes, the `notify` backend pushes an
//!    event onto our internal channel; a background tokio task drains
//!    it, looks up every `(worktree, plugin)` that was subscribed to
//!    that path, and invokes the callback once per subscriber.
//!
//! # Platform notes
//!
//! `notify::RecommendedWatcher` picks FSEvents (macOS), inotify
//! (Linux), or ReadDirectoryChangesW (Windows) at build time — the
//! same code compiles on all three without conditional logic here.
//!
//! - On macOS, FSEvents is directory-granular under the hood; `notify`
//!   handles file-path watches by watching the parent directory and
//!   filtering events. We benefit from that transparently.
//! - On Linux, inotify has a per-user watch cap
//!   (`fs.inotify.max_user_watches`, default 8192 on most distros).
//!   We dedupe registrations by absolute path so many cache entries
//!   watching the same `.envrc` cost one inotify watch, not N.
//! - On Windows, `ReadDirectoryChangesW` opens a handle on the parent
//!   directory; our per-file dedupe keeps handle counts low.
//!
//! # Failure modes
//!
//! If the OS returns an error creating or adding a watch (permission
//! denied, too many watches, file gone between export and register),
//! we log and swallow — the fallback is the existing mtime check on
//! the next resolve, so invalidation is at worst lazy, never wrong.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use notify::event::{EventKind, ModifyKind, RemoveKind};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};

/// Identifier of a single cache entry: `(worktree_path, plugin_name)`.
/// Mirrors `EnvCache`'s internal key but owned by the watcher side.
type Key = (PathBuf, String);

/// Callback invoked on every filesystem change that touches a watched
/// path. Receives the matching `(worktree, plugin)` key so the caller
/// can invalidate the cache entry and notify the frontend.
///
/// Must be `Send + Sync` since events fire from the watcher's
/// background task; must be `'static` because the watcher holds it
/// for its entire lifetime.
pub type OnChange = Arc<dyn Fn(&Path, &str) + Send + Sync + 'static>;

/// Filesystem watcher for env-provider cache invalidation.
///
/// Cloning via `Arc` is the intended shared-ownership pattern — each
/// Tauri command that wants to (de)register paths holds an
/// `Arc<EnvWatcher>`.
pub struct EnvWatcher {
    /// Routing state shared with the background notify task.
    ///
    /// Guarded by a plain `Mutex` (not tokio's) because notify fires
    /// events on its own OS thread, not an async context.
    state: Arc<Mutex<WatcherState>>,
    /// Owned `RecommendedWatcher`. Kept alive for the lifetime of the
    /// `EnvWatcher`; dropping it stops the backend thread.
    ///
    /// Wrapped in `Mutex` because `add`/`remove` take `&mut self` and
    /// we may touch the watcher from multiple threads.
    watcher: Mutex<RecommendedWatcher>,
}

/// Internal routing state. Separate struct so the notify event handler
/// closure can `Arc<Mutex<WatcherState>>` it without also needing the
/// `Watcher` itself.
struct WatcherState {
    /// path → set of `(worktree, plugin)` keys that care about it.
    /// When an event fires on `path`, we dispatch the callback once
    /// per key in the set.
    subscribers: HashMap<PathBuf, HashSet<Key>>,
    /// Reverse index: `(worktree, plugin)` → paths it currently
    /// subscribes to. Lets unregister run in O(paths-per-key) instead
    /// of O(total-paths).
    key_paths: HashMap<Key, HashSet<PathBuf>>,
    /// Callback fired for every `(worktree, plugin)` whose watch list
    /// intersects a changed path. Stored here so the drain task can
    /// dispatch without needing a separate channel-bound closure.
    on_change: OnChange,
}

impl EnvWatcher {
    /// Build a watcher. The callback fires on every detected change
    /// to any registered path, once per `(worktree, plugin)` key that
    /// was subscribed to it. Typical implementation:
    ///
    /// ```ignore
    /// EnvWatcher::new(Arc::new(move |worktree, plugin| {
    ///     cache.invalidate(worktree, Some(plugin));
    ///     let _ = app_handle.emit("env-cache-invalidated",
    ///         EnvCacheInvalidatedPayload {
    ///             worktree_path: worktree.to_string_lossy().into(),
    ///             plugin_name: plugin.to_string(),
    ///         });
    /// }))
    /// ```
    pub fn new(on_change: OnChange) -> notify::Result<Self> {
        let state = Arc::new(Mutex::new(WatcherState {
            subscribers: HashMap::new(),
            key_paths: HashMap::new(),
            on_change,
        }));

        let state_for_handler = Arc::clone(&state);
        let handler = move |res: notify::Result<notify::Event>| {
            let Ok(event) = res else {
                // Don't crash on transient errors (e.g. macOS FSEvents
                // buffer overflow) — the next resolve will re-stat
                // anyway. Log at debug level; silence is fine here.
                return;
            };
            if !is_interesting(&event.kind) {
                return;
            }
            let state = state_for_handler.lock().unwrap();
            let mut fired: HashSet<Key> = HashSet::new();
            for path in &event.paths {
                // Backends may report canonical paths (FSEvents) or
                // the path we registered (inotify, ReadDirectoryChangesW).
                // Try both forms so platform differences don't leak
                // into subscriber lookup.
                if let Some(keys) = state.subscribers.get(path) {
                    for key in keys {
                        fired.insert(key.clone());
                    }
                }
                let canon = canonicalize_or_keep(path);
                if canon != *path
                    && let Some(keys) = state.subscribers.get(&canon)
                {
                    for key in keys {
                        fired.insert(key.clone());
                    }
                }
            }
            if fired.is_empty() {
                return;
            }
            let cb = Arc::clone(&state.on_change);
            // Drop the lock before invoking user code so the callback
            // is free to take state of its own (e.g. invalidate the
            // cache, which may synchronously trigger unregister and
            // re-acquire the lock).
            drop(state);
            for (worktree, plugin) in fired {
                cb(&worktree, &plugin);
            }
        };

        // `notify` 7 lets you pass a plain `EventFn`. The 300ms delay
        // is a belt-and-suspenders debounce for backends that fire
        // multiple events per save (vim swap-file dance, editors that
        // rename-over). `Config::default().with_poll_interval(_)` only
        // affects the polling fallback; RecommendedWatcher on our
        // target platforms uses native APIs.
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

    /// Subscribe a `(worktree, plugin)` cache key to a list of paths.
    ///
    /// Idempotent — repeated calls with the same key replace the prior
    /// path set. Previously-registered paths that are no longer in
    /// `paths` are unwatched (if no other subscriber needs them).
    ///
    /// Missing files are skipped (`notify::watch` returns an error,
    /// which we log-and-swallow). Most common on the freshly-added
    /// repo flow where a plugin reports a `.envrc` that the user
    /// deleted between export and register.
    ///
    /// Paths are canonicalized so events from backends that report
    /// canonical forms (FSEvents on macOS resolves
    /// `/var/folders/...` → `/private/var/folders/...`) match the
    /// subscriber lookup. A canonicalization failure (file doesn't
    /// exist, broken symlink) falls back to the original path — the
    /// next resolve will re-stat via mtime and notice the change.
    pub fn register(&self, worktree: &Path, plugin: &str, paths: &[PathBuf]) {
        let key: Key = (worktree.to_path_buf(), plugin.to_string());
        let new_set: HashSet<PathBuf> = paths.iter().map(|p| canonicalize_or_keep(p)).collect();

        // Compute diff under lock so we know what to add vs remove.
        let (to_add, to_remove) = {
            let mut state = self.state.lock().unwrap();
            let old_paths = state.key_paths.remove(&key).unwrap_or_default();
            let to_add: Vec<PathBuf> = new_set.difference(&old_paths).cloned().collect();
            let to_remove: Vec<PathBuf> = old_paths.difference(&new_set).cloned().collect();

            // Update indices. `subscribers` gains `key` for every
            // new-set path and loses `key` for every removed path.
            for path in &to_remove {
                if let Some(subs) = state.subscribers.get_mut(path) {
                    subs.remove(&key);
                    if subs.is_empty() {
                        state.subscribers.remove(path);
                    }
                }
            }
            for path in &new_set {
                state
                    .subscribers
                    .entry(path.clone())
                    .or_default()
                    .insert(key.clone());
            }
            state.key_paths.insert(key.clone(), new_set.clone());
            (to_add, to_remove)
        };

        // Wrangle the OS watches outside the state lock so a slow
        // syscall doesn't block unrelated register/unregister calls.
        let mut watcher = self.watcher.lock().unwrap();
        for path in &to_remove {
            // Only unwatch if no other subscriber still needs the
            // path. The state lock above already removed our entry;
            // re-check under a brief lock to avoid TOCTOU where a
            // concurrent register added a new subscriber.
            let still_needed = self.state.lock().unwrap().subscribers.contains_key(path);
            if !still_needed {
                let _ = watcher.unwatch(path);
            }
        }
        for path in &to_add {
            // Individual files are supported on all three backends
            // (notify handles macOS by watching the parent dir).
            if let Err(err) = watcher.watch(path, RecursiveMode::NonRecursive) {
                // Log and move on — the next resolve will re-stat the
                // path's mtime, so invalidation still happens, just
                // lazily. Common errors: file gone between export and
                // register; inotify watch limit exceeded.
                eprintln!("[env-watcher] failed to watch {}: {err}", path.display());
            }
        }
    }

    /// Stop tracking a cache key. Called from `EnvCache::invalidate`
    /// hooks and on workspace deletion. Paths become un-watched only
    /// when no other key still subscribes.
    pub fn unregister(&self, worktree: &Path, plugin: Option<&str>) {
        let prefix: &Path = worktree;
        let keys_to_drop: Vec<Key> = {
            let state = self.state.lock().unwrap();
            state
                .key_paths
                .keys()
                .filter(|(wt, p)| wt == prefix && plugin.map(|want| p == want).unwrap_or(true))
                .cloned()
                .collect()
        };

        for key in keys_to_drop {
            let removed_paths = {
                let mut state = self.state.lock().unwrap();
                let paths = state.key_paths.remove(&key).unwrap_or_default();
                for path in &paths {
                    if let Some(subs) = state.subscribers.get_mut(path) {
                        subs.remove(&key);
                        if subs.is_empty() {
                            state.subscribers.remove(path);
                        }
                    }
                }
                paths
            };
            let mut watcher = self.watcher.lock().unwrap();
            for path in &removed_paths {
                let still_needed = self.state.lock().unwrap().subscribers.contains_key(path);
                if !still_needed {
                    let _ = watcher.unwatch(path);
                }
            }
        }
    }

    /// Test-only introspection: number of unique paths currently
    /// watched across all keys.
    #[cfg(test)]
    pub fn watched_path_count(&self) -> usize {
        self.state.lock().unwrap().subscribers.len()
    }

    /// Test-only introspection: number of registered cache keys.
    #[cfg(test)]
    pub fn registered_key_count(&self) -> usize {
        self.state.lock().unwrap().key_paths.len()
    }
}

/// Resolve symlinks so registration and event paths line up. Returns
/// the original path on failure (broken symlink, file gone) — that
/// way tests that register a not-yet-created file still record the
/// key, and the per-resolve mtime check will catch the change when
/// the file later appears.
fn canonicalize_or_keep(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// True when the event kind should propagate to the callback. We
/// ignore pure-access events (reads, opens, metadata-only changes
/// that don't alter content) to cut callback noise — the dispatcher
/// re-stats mtimes on resolve, so access events would trigger a
/// useless invalidation.
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

    /// Poll `predicate` up to `timeout`, returning whether it became
    /// true. Filesystem events are inherently async; tests need to
    /// wait a bounded time rather than racing the backend thread.
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
        let file = tmp.path().join(".envrc");
        std::fs::write(&file, "use flake").unwrap();

        let hits: Arc<Mutex<Vec<(PathBuf, String)>>> = Arc::new(Mutex::new(Vec::new()));
        let hits_cb = Arc::clone(&hits);
        let watcher = EnvWatcher::new(Arc::new(move |wt, p| {
            hits_cb
                .lock()
                .unwrap()
                .push((wt.to_path_buf(), p.to_string()));
        }))
        .unwrap();

        watcher.register(tmp.path(), "env-direnv", std::slice::from_ref(&file));

        // Force a distinguishable mtime — some filesystems otherwise
        // coalesce the write and the event fires inconsistently.
        std::thread::sleep(Duration::from_millis(50));
        std::fs::write(&file, "use flake\nexport FOO=bar").unwrap();

        assert!(
            wait_for(Duration::from_secs(3), || !hits.lock().unwrap().is_empty()),
            "callback did not fire within 3s"
        );
        let observed = hits.lock().unwrap().clone();
        assert!(
            observed
                .iter()
                .any(|(wt, p)| wt == tmp.path() && p == "env-direnv"),
            "expected (worktree, env-direnv) hit in {observed:?}"
        );
    }

    #[test]
    fn multiple_keys_on_same_path_both_fire() {
        // Two plugins (direnv + another) watching the same .envrc
        // should both get notified on a single write.
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join(".envrc");
        std::fs::write(&file, "x").unwrap();

        let hits: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
        let hits_cb = Arc::clone(&hits);
        let watcher = EnvWatcher::new(Arc::new(move |_wt, p| {
            hits_cb.lock().unwrap().insert(p.to_string());
        }))
        .unwrap();

        watcher.register(tmp.path(), "env-direnv", std::slice::from_ref(&file));
        watcher.register(tmp.path(), "env-mise", std::slice::from_ref(&file));
        // Dedupe check: same path → one OS watch.
        assert_eq!(watcher.watched_path_count(), 1);
        assert_eq!(watcher.registered_key_count(), 2);

        std::thread::sleep(Duration::from_millis(50));
        std::fs::write(&file, "y").unwrap();

        assert!(wait_for(Duration::from_secs(3), || {
            let h = hits.lock().unwrap();
            h.contains("env-direnv") && h.contains("env-mise")
        }));
    }

    #[test]
    fn unregister_stops_callback() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join(".envrc");
        std::fs::write(&file, "x").unwrap();

        let hits = Arc::new(AtomicUsize::new(0));
        let hits_cb = Arc::clone(&hits);
        let watcher = EnvWatcher::new(Arc::new(move |_wt, _p| {
            hits_cb.fetch_add(1, Ordering::SeqCst);
        }))
        .unwrap();

        watcher.register(tmp.path(), "env-direnv", std::slice::from_ref(&file));
        watcher.unregister(tmp.path(), Some("env-direnv"));

        assert_eq!(watcher.watched_path_count(), 0);
        assert_eq!(watcher.registered_key_count(), 0);

        std::fs::write(&file, "y").unwrap();

        // Give the backend time to maybe fire (it shouldn't). 500ms is
        // enough to flush buffered events on all three platforms.
        std::thread::sleep(Duration::from_millis(500));
        assert_eq!(hits.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn re_register_replaces_path_set() {
        // Plugin's second export watches a different file (user
        // deleted .envrc, added .env instead). Old path should drop.
        let tmp = tempfile::tempdir().unwrap();
        let envrc = tmp.path().join(".envrc");
        let dotenv = tmp.path().join(".env");
        std::fs::write(&envrc, "x").unwrap();
        std::fs::write(&dotenv, "y").unwrap();

        let watcher = EnvWatcher::new(Arc::new(|_, _| {})).unwrap();
        watcher.register(tmp.path(), "env-direnv", std::slice::from_ref(&envrc));
        assert_eq!(watcher.watched_path_count(), 1);

        watcher.register(tmp.path(), "env-direnv", std::slice::from_ref(&dotenv));
        // Old path dropped, new path added.
        assert_eq!(watcher.watched_path_count(), 1);
        assert_eq!(watcher.registered_key_count(), 1);
    }

    #[test]
    fn unregister_all_plugins_for_worktree() {
        let tmp = tempfile::tempdir().unwrap();
        let f1 = tmp.path().join(".envrc");
        let f2 = tmp.path().join("mise.toml");
        std::fs::write(&f1, "x").unwrap();
        std::fs::write(&f2, "x").unwrap();

        let watcher = EnvWatcher::new(Arc::new(|_, _| {})).unwrap();
        watcher.register(tmp.path(), "env-direnv", std::slice::from_ref(&f1));
        watcher.register(tmp.path(), "env-mise", std::slice::from_ref(&f2));
        assert_eq!(watcher.registered_key_count(), 2);

        watcher.unregister(tmp.path(), None);
        assert_eq!(watcher.registered_key_count(), 0);
        assert_eq!(watcher.watched_path_count(), 0);
    }

    #[test]
    fn missing_path_does_not_crash_register() {
        let tmp = tempfile::tempdir().unwrap();
        let never_created = tmp.path().join("no-such-file");

        // Must not panic even though the file doesn't exist.
        let watcher = EnvWatcher::new(Arc::new(|_, _| {})).unwrap();
        watcher.register(tmp.path(), "env-direnv", &[never_created]);
        // The key is still tracked — we just logged the watch failure.
        // That way a later register with an existing path still works.
        assert_eq!(watcher.registered_key_count(), 1);
    }
}
