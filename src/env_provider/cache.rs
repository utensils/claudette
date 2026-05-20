//! In-memory cache for env-provider exports, keyed by `(worktree, plugin_name)`.
//!
//! The cache stores each plugin's last [`ProviderExport`] alongside an
//! mtime + content-hash fingerprint of every file it reported as
//! `watched`. On lookup we re-check those files with a two-tier test:
//!
//! 1. **mtime compare** (cheap, no file reads). If every watched
//!    file's mtime is unchanged, the entry is fresh — return it and
//!    skip the plugin's `export` (no Lua VM spin-up, no subprocess).
//! 2. **content hash** (slow path, only on an mtime mismatch). A bare
//!    mtime bump is not proof of a content change — `git checkout`,
//!    `touch`, save-on-noop editors, and nix-direnv re-evaluation all
//!    move mtimes forward without changing bytes. When mtime moved we
//!    hash the file: identical bytes → still fresh (and we heal the
//!    stored mtime so the next lookup takes the cheap path again);
//!    changed bytes → stale → re-export.
//!
//! This two-tier check is what keeps the cache warm on a workspace
//! whose `.envrc` / `flake.nix` / `flake.lock` content never changed
//! even as agents, terminals, and git operations churn file mtimes.
//!
//! Scope of invalidation:
//! - `.envrc` / `mise.toml` / `.env` / `flake.lock` content edits →
//!   hash mismatch → cache miss → re-export.
//! - File deletion → stat fails → treated as "changed" → miss.
//!
//! Not covered:
//! - A plugin starts watching a *new* file on a later call (e.g. user
//!   adds `.envrc.local`). We only know what the previous export told
//!   us to watch. Acceptable because direnv's `DIRENV_WATCHES` updates
//!   inside `.envrc` — the `.envrc` content changing forces a re-eval.
//! - User runs `direnv deny` without editing `.envrc` → cache stays
//!   fresh until next `.envrc` content change. Workaround: UI "Reload".

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::time::SystemTime;

use super::types::{EnvMap, ProviderExport};

/// Invalidation fingerprint for a single watched file, captured at
/// store time.
#[derive(Debug, Clone, PartialEq)]
struct WatchedFile {
    /// Absolute path of the file.
    path: PathBuf,
    /// Modification time at store time. `None` when the file was
    /// missing/unreadable — a later `Some` means it appeared.
    mtime: Option<SystemTime>,
    /// Content hash at store time, mirroring `mtime`'s `None` for a
    /// missing/unreadable file. This is what lets a forward mtime bump
    /// with byte-identical content stay a cache *hit* instead of
    /// thrashing a re-export.
    hash: Option<u64>,
}

/// Cache entry for a single `(worktree, plugin)` pair.
#[derive(Debug, Clone)]
pub struct CacheEntry {
    /// Exported env. Kept separate from `ProviderExport` so we can
    /// clone cheaply without re-walking the watched list.
    pub env: EnvMap,
    /// Files we watch for invalidation, paired with the mtime +
    /// content hash captured at the last successful export.
    watched: Vec<WatchedFile>,
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

    /// Return the cached entry if its watched files are still fresh.
    ///
    /// "Fresh" is decided by the two-tier check in [`check_freshness`]:
    /// an unchanged mtime is an instant hit; an mtime that moved
    /// forward but left content byte-identical is *also* a hit (and we
    /// heal the stored mtime so the next call is cheap again); a real
    /// content change — or a watched file appearing/disappearing —
    /// returns `None`.
    pub fn get_fresh(&self, worktree: &Path, plugin: &str) -> Option<CacheEntry> {
        let key = (worktree.to_path_buf(), plugin.to_string());
        let guard = self.entries.read().unwrap();
        let mut entry = guard.get(&key)?.clone();
        drop(guard);

        match check_freshness(&entry.watched) {
            Freshness::Fresh => Some(entry),
            Freshness::Rehashed(refreshed) => {
                entry.watched = refreshed;
                // Heal the stored entry so a future lookup hits the
                // cheap mtime path instead of re-hashing. Best-effort:
                // only write back if the entry wasn't replaced or
                // evicted in the meantime (same `evaluated_at`).
                if let Ok(mut guard) = self.entries.write()
                    && let Some(stored) = guard.get_mut(&key)
                    && stored.evaluated_at == entry.evaluated_at
                {
                    stored.watched = entry.watched.clone();
                }
                Some(entry)
            }
            Freshness::Stale => None,
        }
    }

    /// Store (or overwrite) the cache entry for `(worktree, plugin)`.
    ///
    /// Returns `Some(evaluated_at)` if the entry was stored, or `None`
    /// if it was dropped because a watched file changed between the
    /// two fingerprint snapshots we take (before-store and
    /// after-store). The race we're guarding:
    ///
    ///   t0: plugin's `export()` captures env based on on-disk content
    ///   t1: we snapshot mtime+hash ("first")
    ///   t2: we snapshot mtime+hash again ("second")
    ///   t3: caller stores the entry
    ///
    /// If a file changes during [t1, t2] we see it here and refuse to
    /// cache — the next resolve re-runs `export()` and picks up the
    /// fresh state. A change during [t0, t1] still slips through (we
    /// cache stale env under the post-change fingerprint), but the
    /// window is microseconds — small enough that not-caching-at-all
    /// would be more wasteful than the occasional stale turn.
    pub fn put(
        &self,
        worktree: &Path,
        plugin: &str,
        export: &ProviderExport,
    ) -> Option<SystemTime> {
        let first: Vec<WatchedFile> = export.watched.iter().map(|p| snapshot(p)).collect();
        let second: Vec<WatchedFile> = export.watched.iter().map(|p| snapshot(p)).collect();
        if first != second {
            return None;
        }

        let key = (worktree.to_path_buf(), plugin.to_string());
        let evaluated_at = SystemTime::now();
        let entry = CacheEntry {
            env: export.env.clone(),
            watched: first,
            evaluated_at,
        };
        self.entries.write().unwrap().insert(key, entry);
        Some(evaluated_at)
    }

    /// Return the paths this `(worktree, plugin)` entry is watching,
    /// or an empty vec if no entry exists. Used by the fs watcher to
    /// learn which paths to subscribe to after a fresh export —
    /// callers shouldn't have to re-derive the list from the plugin's
    /// return value because it may have been normalized by `put`.
    pub fn watched_paths(&self, worktree: &Path, plugin: &str) -> Vec<PathBuf> {
        let key = (worktree.to_path_buf(), plugin.to_string());
        self.entries
            .read()
            .unwrap()
            .get(&key)
            .map(|entry| entry.watched.iter().map(|wf| wf.path.clone()).collect())
            .unwrap_or_default()
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

    /// Re-check a single `(worktree, plugin)` entry against the
    /// filesystem and evict it **only if a watched file's content
    /// actually changed**. Returns `true` if the entry was evicted.
    ///
    /// This is the content-aware counterpart to [`invalidate`], meant
    /// for the fs-watcher callback. A watcher event means *some*
    /// watched path was touched — but `touch`, `git checkout`,
    /// save-on-noop editors, and nix-direnv re-evaluation all fire
    /// events without changing bytes. Evicting unconditionally on
    /// every event is exactly the cache thrash issue #888 is about:
    /// the reactive watcher would otherwise drop the entry before
    /// [`get_fresh`]'s own two-tier check ever gets to run.
    ///
    /// So this applies the same [`check_freshness`] test the lazy
    /// path uses: unchanged content keeps the entry (and heals its
    /// stored mtimes so the next `get_fresh` is cheap); genuinely
    /// changed content removes it and returns `true` so the caller
    /// can notify the UI. A missing entry returns `false` — nothing
    /// to evict, nothing to notify.
    pub fn invalidate_if_stale(&self, worktree: &Path, plugin: &str) -> bool {
        let key = (worktree.to_path_buf(), plugin.to_string());
        let mut guard = self.entries.write().unwrap();
        let Some(entry) = guard.get_mut(&key) else {
            return false;
        };
        match check_freshness(&entry.watched) {
            Freshness::Fresh => false,
            Freshness::Rehashed(refreshed) => {
                entry.watched = refreshed;
                false
            }
            Freshness::Stale => {
                guard.remove(&key);
                true
            }
        }
    }

    /// Forget every cache entry for a given plugin, across all
    /// worktrees. Called when a plugin's global enable state or
    /// settings change — any cached export is potentially stale.
    pub fn invalidate_plugin_everywhere(&self, plugin: &str) {
        let mut guard = self.entries.write().unwrap();
        guard.retain(|(_, p), _| p != plugin);
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

/// Outcome of re-checking a cache entry's watched files against the
/// current filesystem state.
enum Freshness {
    /// Every watched file matched on mtime alone — the cheap path,
    /// no file reads.
    Fresh,
    /// One or more files' mtimes moved but their content hashes still
    /// match. The entry is still valid; the vec carries the watched
    /// list with refreshed mtimes so the caller can write it back and
    /// let the next check take the cheap mtime path.
    Rehashed(Vec<WatchedFile>),
    /// A watched file's content actually changed, or it appeared /
    /// disappeared — the entry must be re-exported.
    Stale,
}

/// Two-tier freshness check: mtime first (cheap), content hash only on
/// an mtime mismatch (slow path). See the module doc for the rationale
/// — a bare mtime bump is not proof a file's bytes changed.
fn check_freshness(watched: &[WatchedFile]) -> Freshness {
    let mut refreshed: Option<Vec<WatchedFile>> = None;
    for (i, wf) in watched.iter().enumerate() {
        let current_mtime = mtime(&wf.path);
        if current_mtime == wf.mtime {
            continue;
        }
        // mtime moved — fall back to a content hash before declaring
        // the entry stale. `git checkout`, `touch`, nix-direnv
        // re-evaluation, and save-on-noop editors all bump mtime
        // forward without changing a byte; those must NOT invalidate.
        if content_hash(&wf.path) != wf.hash {
            return Freshness::Stale;
        }
        // Same bytes, new mtime: heal the stored mtime so the next
        // check is a cheap compare again instead of another hash.
        refreshed.get_or_insert_with(|| watched.to_vec())[i].mtime = current_mtime;
    }
    match refreshed {
        Some(list) => Freshness::Rehashed(list),
        None => Freshness::Fresh,
    }
}

/// Capture a watched file's invalidation fingerprint (mtime + content
/// hash) at store time.
fn snapshot(path: &Path) -> WatchedFile {
    WatchedFile {
        path: path.to_path_buf(),
        mtime: mtime(path),
        hash: content_hash(path),
    }
}

/// Read a file's mtime, returning `None` if the file is missing or
/// unreadable. A missing file on lookup counts as "changed" vs. its
/// previous `Some(_)` — it will not match, so the cache misses.
fn mtime(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).ok()?.modified().ok()
}

/// Hash a file's full contents, returning `None` for a missing or
/// unreadable file (mirroring [`mtime`]). Only called on the slow path
/// — an mtime mismatch — so the read cost is paid once per benign
/// mtime bump, not on every cache lookup.
///
/// `DefaultHasher` (SipHash) is fine here: the digest only ever lives
/// in-memory and is compared within a single process run, so the
/// "not stable across Rust versions" caveat doesn't apply, and a
/// 64-bit collision on a handful of small config files is negligible.
fn content_hash(path: &Path) -> Option<u64> {
    let bytes = std::fs::read(path).ok()?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    Some(hasher.finish())
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
        assert!(cache.put(tmp.path(), "env-direnv", &export).is_some());

        let entry = cache.get_fresh(tmp.path(), "env-direnv").unwrap();
        assert_eq!(entry.env.get("FOO").unwrap().as_deref(), Some("bar"));
    }

    #[test]
    fn get_fresh_returns_none_when_mtime_changes() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join(".envrc");
        std::fs::write(&file, "use flake").unwrap();

        let cache = EnvCache::new();
        assert!(
            cache
                .put(tmp.path(), "env-direnv", &export_with_watched(&file))
                .is_some()
        );
        assert!(cache.get_fresh(tmp.path(), "env-direnv").is_some());

        // Force a distinguishable mtime. Sleep is unavoidable on
        // filesystems with second-level mtime resolution (most of ext4,
        // HFS+). 1100ms is enough to cross the boundary reliably.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        std::fs::write(&file, "export FOO=baz").unwrap();

        assert!(
            cache.get_fresh(tmp.path(), "env-direnv").is_none(),
            "mtime change with new content must invalidate"
        );
    }

    #[test]
    fn get_fresh_survives_mtime_bump_with_identical_content() {
        // The core regression for issue #888: `git checkout`, `touch`,
        // nix-direnv re-evaluation, and save-on-noop editors all move a
        // watched file's mtime forward without changing its bytes. The
        // content-hash fallback must keep the entry a cache *hit*.
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("flake.lock");
        let content = r#"{ "nodes": {}, "version": 7 }"#;
        std::fs::write(&file, content).unwrap();

        let cache = EnvCache::new();
        assert!(
            cache
                .put(tmp.path(), "env-direnv", &export_with_watched(&file))
                .is_some()
        );
        assert!(cache.get_fresh(tmp.path(), "env-direnv").is_some());

        // Bump mtime forward, byte-for-byte identical content.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        std::fs::write(&file, content).unwrap();

        assert!(
            cache.get_fresh(tmp.path(), "env-direnv").is_some(),
            "identical content must stay a cache hit despite the mtime bump"
        );

        // The heal step should have rewritten the stored mtime, so a
        // second lookup is fresh too (and takes the cheap path).
        assert!(
            cache.get_fresh(tmp.path(), "env-direnv").is_some(),
            "healed entry must remain a cache hit on the next lookup"
        );

        // A real content change still invalidates.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        std::fs::write(&file, r#"{ "nodes": { "x": 1 }, "version": 7 }"#).unwrap();
        assert!(
            cache.get_fresh(tmp.path(), "env-direnv").is_none(),
            "an actual content change must still invalidate"
        );
    }

    #[test]
    fn get_fresh_returns_none_when_watched_file_is_deleted() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join(".envrc");
        std::fs::write(&file, "use flake").unwrap();

        let cache = EnvCache::new();
        assert!(
            cache
                .put(tmp.path(), "env-direnv", &export_with_watched(&file))
                .is_some()
        );
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
        assert!(
            cache
                .put(tmp.path(), "env-direnv", &export_with_watched(&file))
                .is_some()
        );
        assert!(
            cache
                .put(tmp.path(), "env-mise", &export_with_watched(&file))
                .is_some()
        );
        assert_eq!(cache.len(), 2);

        cache.invalidate(tmp.path(), Some("env-direnv"));
        assert_eq!(cache.len(), 1);
        assert!(cache.get_fresh(tmp.path(), "env-direnv").is_none());
        assert!(cache.get_fresh(tmp.path(), "env-mise").is_some());
    }

    #[test]
    fn invalidate_if_stale_keeps_entry_on_byte_identical_change() {
        // The reactive-watcher counterpart to
        // `get_fresh_survives_mtime_bump_with_identical_content`: a
        // watcher event fired by a `touch` / checkout / save-on-noop
        // must NOT evict when the bytes are unchanged (issue #888).
        // Without this, the watcher drops the entry before
        // `get_fresh`'s own two-tier check can run.
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("flake.lock");
        let content = r#"{ "nodes": {}, "version": 7 }"#;
        std::fs::write(&file, content).unwrap();

        let cache = EnvCache::new();
        assert!(
            cache
                .put(tmp.path(), "env-direnv", &export_with_watched(&file))
                .is_some()
        );

        // mtime bump, identical content → watcher event, but no evict.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        std::fs::write(&file, content).unwrap();
        assert!(
            !cache.invalidate_if_stale(tmp.path(), "env-direnv"),
            "a byte-identical change must not evict"
        );
        assert!(
            cache.get_fresh(tmp.path(), "env-direnv").is_some(),
            "entry must survive a byte-identical watcher event"
        );

        // A real content change → eviction, returns true.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        std::fs::write(&file, r#"{ "nodes": { "x": 1 }, "version": 7 }"#).unwrap();
        assert!(
            cache.invalidate_if_stale(tmp.path(), "env-direnv"),
            "a real content change must evict"
        );
        assert!(cache.get_fresh(tmp.path(), "env-direnv").is_none());
    }

    #[test]
    fn invalidate_if_stale_on_missing_entry_is_a_noop() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = EnvCache::new();
        assert!(!cache.invalidate_if_stale(tmp.path(), "env-direnv"));
    }

    #[test]
    fn invalidate_plugin_everywhere_drops_all_worktrees_for_plugin() {
        let tmp_a = tempfile::tempdir().unwrap();
        let tmp_b = tempfile::tempdir().unwrap();
        let file_a = tmp_a.path().join(".envrc");
        let file_b = tmp_b.path().join(".envrc");
        std::fs::write(&file_a, "x").unwrap();
        std::fs::write(&file_b, "x").unwrap();

        let cache = EnvCache::new();
        assert!(
            cache
                .put(tmp_a.path(), "env-direnv", &export_with_watched(&file_a))
                .is_some()
        );
        assert!(
            cache
                .put(tmp_a.path(), "env-mise", &export_with_watched(&file_a))
                .is_some()
        );
        assert!(
            cache
                .put(tmp_b.path(), "env-direnv", &export_with_watched(&file_b))
                .is_some()
        );
        assert_eq!(cache.len(), 3);

        cache.invalidate_plugin_everywhere("env-direnv");

        assert_eq!(cache.len(), 1);
        assert!(cache.get_fresh(tmp_a.path(), "env-direnv").is_none());
        assert!(cache.get_fresh(tmp_b.path(), "env-direnv").is_none());
        assert!(cache.get_fresh(tmp_a.path(), "env-mise").is_some());
    }

    #[test]
    fn invalidate_entire_worktree() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join(".envrc");
        std::fs::write(&file, "x").unwrap();
        let cache = EnvCache::new();
        assert!(
            cache
                .put(tmp.path(), "env-direnv", &export_with_watched(&file))
                .is_some()
        );
        assert!(
            cache
                .put(tmp.path(), "env-mise", &export_with_watched(&file))
                .is_some()
        );

        cache.invalidate(tmp.path(), None);
        assert_eq!(cache.len(), 0);
    }
}
