//! In-memory cache for env-provider exports, keyed by `(worktree, plugin_name)`.
//!
//! The cache stores each plugin's last [`ProviderExport`] alongside the
//! mtimes of the files it reported as `watched`. On lookup, we re-stat
//! those files; if all mtimes are unchanged, the cached entry is
//! returned and the plugin's `export` operation is skipped (no Lua VM
//! spin-up, no subprocess).
//!
//! Scope of invalidation covered by v1:
//! - `.envrc` / `mise.toml` / `.env` / `flake.lock` edits → mtime
//!   changes → cache miss → re-export.
//! - File deletion → stat fails → treated as "mtime changed" → miss.
//!
//! Not covered (v2+ work):
//! - A plugin starts watching a *new* file on a later call (e.g. user
//!   adds `.envrc.local`). We only know what the previous export told
//!   us to watch. Acceptable because direnv's `DIRENV_WATCHES` updates
//!   inside `.envrc` — the `.envrc` mtime changing forces a re-eval.
//! - User runs `direnv deny` without editing `.envrc` → cache stays
//!   fresh until next `.envrc` mtime change. Workaround: UI "Reload".

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::SystemTime;

use super::types::{EnvMap, ProviderExport};

/// Cache entry for a single `(worktree, plugin)` pair.
#[derive(Debug, Clone)]
pub struct CacheEntry {
    /// Exported env. Kept separate from `ProviderExport` so we can
    /// clone cheaply without re-walking the watched list.
    pub env: EnvMap,
    /// Files we watch for invalidation, paired with their mtime at the
    /// time of the last successful export.
    pub watched: Vec<(PathBuf, Option<SystemTime>)>,
    /// When this entry was written.
    pub evaluated_at: SystemTime,
}

type Key = (PathBuf, String);

#[derive(Default, Debug)]
pub struct EnvCache {
    entries: RwLock<HashMap<Key, CacheEntry>>,
}

impl EnvCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Return the cached entry if all watched files' current mtimes
    /// match the stored values. Any change → stale → returns `None`.
    pub fn get_fresh(&self, worktree: &Path, plugin: &str) -> Option<CacheEntry> {
        let key = (worktree.to_path_buf(), plugin.to_string());
        let guard = self.entries.read().unwrap();
        let entry = guard.get(&key)?.clone();
        drop(guard);

        if all_mtimes_match(&entry.watched) {
            Some(entry)
        } else {
            None
        }
    }

    /// Store (or overwrite) the cache entry for `(worktree, plugin)`.
    ///
    /// Returns `true` if the entry was stored, `false` if it was dropped
    /// because a watched file's mtime changed between the two snapshots
    /// we take (before-store and after-store). The race we're guarding:
    ///
    ///   t0: plugin's `export()` captures env based on on-disk content
    ///   t1: we snapshot mtimes ("first")
    ///   t2: we snapshot mtimes again ("second")
    ///   t3: caller stores the entry
    ///
    /// If a file changes during [t1, t2] we see it here and refuse to
    /// cache — the next resolve will re-run `export()` and pick up the
    /// fresh state. A change during [t0, t1] still slips through (we
    /// cache stale env under the post-change mtime), but the window is
    /// microseconds and — being bounded above by the slowest syscall —
    /// small enough that not-caching-at-all would be more wasteful than
    /// the occasional stale turn. File-content hashing would fully close
    /// this and is v2 work.
    pub fn put(&self, worktree: &Path, plugin: &str, export: &ProviderExport) -> bool {
        let first: Vec<(PathBuf, Option<SystemTime>)> = export
            .watched
            .iter()
            .map(|p| (p.clone(), mtime(p)))
            .collect();
        let second: Vec<Option<SystemTime>> = export.watched.iter().map(|p| mtime(p)).collect();
        if first.iter().zip(second.iter()).any(|((_, a), b)| a != b) {
            return false;
        }

        let key = (worktree.to_path_buf(), plugin.to_string());
        let entry = CacheEntry {
            env: export.env.clone(),
            watched: first,
            evaluated_at: SystemTime::now(),
        };
        self.entries.write().unwrap().insert(key, entry);
        true
    }

    /// Forget the cache for `(worktree, plugin)`. If `plugin` is `None`,
    /// forget all plugins for the worktree. Used by the "Reload env" UI
    /// action and by detect=false (plugin no longer applies).
    pub fn invalidate(&self, worktree: &Path, plugin: Option<&str>) {
        let mut guard = self.entries.write().unwrap();
        match plugin {
            Some(p) => {
                guard.remove(&(worktree.to_path_buf(), p.to_string()));
            }
            None => {
                guard.retain(|(wt, _), _| wt != worktree);
            }
        }
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.entries.read().unwrap().len()
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.entries.read().unwrap().is_empty()
    }
}

/// Read a file's mtime, returning `None` if the file is missing or
/// unreadable. A missing file on lookup counts as "mtime changed" vs.
/// its previous `Some(_)` — it will not match, so the cache misses.
fn mtime(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).ok()?.modified().ok()
}

fn all_mtimes_match(watched: &[(PathBuf, Option<SystemTime>)]) -> bool {
    watched.iter().all(|(p, stored)| mtime(p) == *stored)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn export_with_watched(path: &Path) -> ProviderExport {
        let mut env = EnvMap::new();
        env.insert("FOO".into(), Some("bar".into()));
        ProviderExport {
            env,
            watched: vec![path.to_path_buf()],
        }
    }

    #[test]
    fn put_then_get_returns_fresh_entry() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join(".envrc");
        std::fs::write(&file, "use flake").unwrap();

        let cache = EnvCache::new();
        let export = export_with_watched(&file);
        cache.put(tmp.path(), "env-direnv", &export);

        let entry = cache.get_fresh(tmp.path(), "env-direnv").unwrap();
        assert_eq!(entry.env.get("FOO").unwrap().as_deref(), Some("bar"));
    }

    #[test]
    fn get_fresh_returns_none_when_mtime_changes() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join(".envrc");
        std::fs::write(&file, "use flake").unwrap();

        let cache = EnvCache::new();
        cache.put(tmp.path(), "env-direnv", &export_with_watched(&file));
        assert!(cache.get_fresh(tmp.path(), "env-direnv").is_some());

        // Force a distinguishable mtime. Sleep is unavoidable on
        // filesystems with second-level mtime resolution (most of ext4,
        // HFS+). 1100ms is enough to cross the boundary reliably.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        std::fs::write(&file, "export FOO=baz").unwrap();

        assert!(
            cache.get_fresh(tmp.path(), "env-direnv").is_none(),
            "mtime change must invalidate"
        );
    }

    #[test]
    fn get_fresh_returns_none_when_watched_file_is_deleted() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join(".envrc");
        std::fs::write(&file, "use flake").unwrap();

        let cache = EnvCache::new();
        cache.put(tmp.path(), "env-direnv", &export_with_watched(&file));
        std::fs::remove_file(&file).unwrap();

        assert!(cache.get_fresh(tmp.path(), "env-direnv").is_none());
    }

    #[test]
    fn get_fresh_returns_none_when_no_entry() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = EnvCache::new();
        assert!(cache.get_fresh(tmp.path(), "env-direnv").is_none());
    }

    #[test]
    fn invalidate_single_plugin() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join(".envrc");
        std::fs::write(&file, "x").unwrap();
        let cache = EnvCache::new();
        cache.put(tmp.path(), "env-direnv", &export_with_watched(&file));
        cache.put(tmp.path(), "env-mise", &export_with_watched(&file));
        assert_eq!(cache.len(), 2);

        cache.invalidate(tmp.path(), Some("env-direnv"));
        assert_eq!(cache.len(), 1);
        assert!(cache.get_fresh(tmp.path(), "env-direnv").is_none());
        assert!(cache.get_fresh(tmp.path(), "env-mise").is_some());
    }

    #[test]
    fn invalidate_entire_worktree() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join(".envrc");
        std::fs::write(&file, "x").unwrap();
        let cache = EnvCache::new();
        cache.put(tmp.path(), "env-direnv", &export_with_watched(&file));
        cache.put(tmp.path(), "env-mise", &export_with_watched(&file));

        cache.invalidate(tmp.path(), None);
        assert_eq!(cache.len(), 0);
    }
}
