//! Env-provider dispatcher.
//!
//! Glues the plugin runtime's `kind = "env-provider"` plugins together
//! into a single merged env that the agent, setup script, PTY, and any
//! other subprocess spawned in a workspace can inherit.
//!
//! Flow per resolve:
//! 1. Ask the backend which plugins are env-providers.
//! 2. For each, check the mtime-keyed cache. Fresh hit → use cached env.
//! 3. Cache miss → call `detect`. False → skip + invalidate any stale cache.
//! 4. `detect` true → call `export` → store in cache.
//! 5. Merge all plugin results in precedence order (highest wins on key
//!    collisions). `None`-valued entries unset the key from the merge.
//!
//! Errors from any single provider are captured in [`ResolvedSource`]
//! but do not fail the whole resolve — the agent still spawns with
//! whatever other providers contributed.

pub mod backend;
pub mod cache;
#[cfg(test)]
mod plugin_tests;
pub mod types;

use std::path::Path;
use std::time::SystemTime;

use serde::Serialize;

use crate::plugin_runtime::host_api::WorkspaceInfo;

use backend::EnvProviderBackend;
pub use backend::PluginRegistryBackend;
pub use cache::EnvCache;
use types::EnvMap;

/// Convenience helper that wires the standard [`PluginRegistryBackend`]
/// into [`resolve_for_workspace`] with minimal boilerplate at the call
/// site. The tauri layer uses this from spawn command handlers.
pub async fn resolve_with_registry(
    registry: &crate::plugin_runtime::PluginRegistry,
    cache: &EnvCache,
    worktree: &Path,
    ws_info: &WorkspaceInfo,
    disabled: &std::collections::HashSet<String>,
) -> ResolvedEnv {
    let backend = PluginRegistryBackend::new(registry);
    resolve_for_workspace(&backend, cache, worktree, ws_info, disabled).await
}

/// The merged env contributed by all detected env-provider plugins.
#[derive(Debug, Default, Clone)]
pub struct ResolvedEnv {
    /// Final merged env. `None`-valued entries should be unset from the
    /// spawned command via `Command::env_remove`.
    pub vars: EnvMap,
    /// Per-plugin audit trail — surfaced in the settings UI and useful
    /// for debugging "why isn't FOO set?" questions.
    pub sources: Vec<ResolvedSource>,
}

/// Result of asking one plugin to contribute env.
#[derive(Debug, Clone, Serialize)]
pub struct ResolvedSource {
    pub plugin_name: String,
    pub detected: bool,
    pub vars_contributed: usize,
    pub cached: bool,
    pub evaluated_at: SystemTime,
    /// Present when the plugin errored or was skipped with a reason.
    pub error: Option<String>,
}

impl ResolvedEnv {
    /// Apply the merged env to a `tokio::process::Command`. `None`
    /// values trigger `env_remove` so providers can model "direnv
    /// unexported this var" correctly.
    pub fn apply(&self, cmd: &mut tokio::process::Command) {
        for (k, v) in &self.vars {
            match v {
                Some(val) => {
                    cmd.env(k, val);
                }
                None => {
                    cmd.env_remove(k);
                }
            }
        }
    }

    /// Sibling to [`apply`] for `std::process::Command` (setup script
    /// spawn, non-async code paths).
    pub fn apply_std(&self, cmd: &mut std::process::Command) {
        for (k, v) in &self.vars {
            match v {
                Some(val) => {
                    cmd.env(k, val);
                }
                None => {
                    cmd.env_remove(k);
                }
            }
        }
    }

    /// Apply to a `HashMap` env (used by the PTY code path, which
    /// builds its env map separately before handing to `portable-pty`).
    pub fn apply_to_map(&self, map: &mut std::collections::HashMap<String, String>) {
        for (k, v) in &self.vars {
            match v {
                Some(val) => {
                    map.insert(k.clone(), val.clone());
                }
                None => {
                    map.remove(k);
                }
            }
        }
    }
}

/// Hardcoded precedence for v1. Higher value = wins on key collision.
/// Unknown plugin names get a low default so user-added providers are
/// merged last (overridden by any of the built-ins that also detected).
///
/// See the plan for rationale — direnv wraps most other tools
/// (`use flake`, `use mise`, `use devbox`), so when both a direnv and
/// a raw provider (mise, nix-devshell) both detect, the direnv export
/// already includes the underlying tool's env, and its values win.
pub fn precedence_of(name: &str) -> i32 {
    match name {
        "env-direnv" => 100,
        "env-mise" => 80,
        "env-shadowenv" => 60,
        "env-nix-devshell" => 40,
        "env-dotenv" => 20,
        _ => 10,
    }
}

/// Resolve the full env a workspace should spawn with.
///
/// Iterates in ascending precedence order; later (higher) providers
/// overwrite earlier (lower) ones on key collision. `None` values unset
/// the key from the merged map.
///
/// When a plugin name appears in `disabled`, it's skipped entirely —
/// `detect` is not called, the cache is not consulted, and the source
/// entry records `detected=false` with an `"disabled"` error string so
/// the UI can distinguish user-disabled from not-applicable.
pub async fn resolve_for_workspace(
    backend: &impl EnvProviderBackend,
    cache: &EnvCache,
    worktree: &Path,
    ws_info: &WorkspaceInfo,
    disabled: &std::collections::HashSet<String>,
) -> ResolvedEnv {
    let mut names = backend.env_provider_names();
    // Sort: primary by precedence (ascending, so higher overwrites on
    // merge); secondary by name so unknown providers with tied
    // precedence collide deterministically instead of by HashMap
    // iteration order.
    names.sort_by(|a, b| {
        precedence_of(a)
            .cmp(&precedence_of(b))
            .then_with(|| a.cmp(b))
    });

    let mut merged = EnvMap::new();
    let mut sources = Vec::with_capacity(names.len());

    for name in names {
        if disabled.contains(&name) {
            // User explicitly turned this provider off — drop any cached
            // result so re-enabling it forces a fresh evaluation.
            cache.invalidate(worktree, Some(&name));
            sources.push(ResolvedSource {
                plugin_name: name,
                detected: false,
                vars_contributed: 0,
                cached: false,
                evaluated_at: SystemTime::now(),
                error: Some("disabled".to_string()),
            });
            continue;
        }
        let source = resolve_one(backend, cache, &name, worktree, ws_info, &mut merged).await;
        sources.push(source);
    }

    ResolvedEnv {
        vars: merged,
        sources,
    }
}

async fn resolve_one(
    backend: &impl EnvProviderBackend,
    cache: &EnvCache,
    name: &str,
    worktree: &Path,
    ws_info: &WorkspaceInfo,
    merged: &mut EnvMap,
) -> ResolvedSource {
    // 1. Fast path: cache hit → skip detect AND export.
    if let Some(entry) = cache.get_fresh(worktree, name) {
        let contributed = entry.env.len();
        merge_into(merged, &entry.env);
        return ResolvedSource {
            plugin_name: name.to_string(),
            detected: true,
            vars_contributed: contributed,
            cached: true,
            evaluated_at: entry.evaluated_at,
            error: None,
        };
    }

    // 2. Slow path: run detect.
    let detected = match backend.detect(name, worktree, ws_info).await {
        Ok(v) => v,
        Err(e) => {
            return ResolvedSource {
                plugin_name: name.to_string(),
                detected: false,
                vars_contributed: 0,
                cached: false,
                evaluated_at: SystemTime::now(),
                error: Some(format!("detect: {e}")),
            };
        }
    };

    if !detected {
        // Drop any stale cache for this (worktree, plugin) — plugin no
        // longer applies (e.g. user deleted `.envrc`).
        cache.invalidate(worktree, Some(name));
        return ResolvedSource {
            plugin_name: name.to_string(),
            detected: false,
            vars_contributed: 0,
            cached: false,
            evaluated_at: SystemTime::now(),
            error: None,
        };
    }

    // 3. Run export, store result in cache.
    match backend.export(name, worktree, ws_info).await {
        Ok(export) => {
            let contributed = export.env.len();
            cache.put(worktree, name, &export);
            merge_into(merged, &export.env);
            ResolvedSource {
                plugin_name: name.to_string(),
                detected: true,
                vars_contributed: contributed,
                cached: false,
                evaluated_at: SystemTime::now(),
                error: None,
            }
        }
        Err(e) => ResolvedSource {
            plugin_name: name.to_string(),
            detected: true,
            vars_contributed: 0,
            cached: false,
            evaluated_at: SystemTime::now(),
            error: Some(format!("export: {e}")),
        },
    }
}

/// Merge `incoming` into `merged`. `None` entries *unset* the key; the
/// last writer wins on collisions (callers iterate in ascending
/// precedence order so this naturally implements "highest wins").
fn merge_into(merged: &mut EnvMap, incoming: &EnvMap) {
    for (k, v) in incoming {
        merged.insert(k.clone(), v.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use backend::mock::MockBackend;
    use types::ProviderExport;

    fn ws_info() -> WorkspaceInfo {
        WorkspaceInfo {
            id: "ws-1".into(),
            name: "test".into(),
            branch: "main".into(),
            worktree_path: "/tmp".into(),
            repo_path: "/tmp".into(),
        }
    }

    fn export_of(
        pairs: &[(&str, Option<&str>)],
        watched: Vec<std::path::PathBuf>,
    ) -> ProviderExport {
        let env = pairs
            .iter()
            .map(|(k, v)| ((*k).into(), v.map(|s| s.into())))
            .collect();
        ProviderExport { env, watched }
    }

    #[tokio::test]
    async fn resolve_empty_no_plugins() {
        let backend = MockBackend::new();
        let cache = EnvCache::new();
        let resolved = resolve_for_workspace(
            &backend,
            &cache,
            std::path::Path::new("/tmp"),
            &ws_info(),
            &Default::default(),
        )
        .await;
        assert!(resolved.vars.is_empty());
        assert!(resolved.sources.is_empty());
    }

    #[tokio::test]
    async fn resolve_single_plugin_detects_and_exports() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join(".envrc"), "x").unwrap();

        let backend = MockBackend::new()
            .with_plugin("env-direnv")
            .detects("env-direnv", true)
            .exports(
                "env-direnv",
                export_of(&[("FOO", Some("bar"))], vec![tmp.path().join(".envrc")]),
            );
        let cache = EnvCache::new();
        let resolved = resolve_for_workspace(
            &backend,
            &cache,
            tmp.path(),
            &ws_info(),
            &Default::default(),
        )
        .await;

        assert_eq!(resolved.vars.get("FOO").unwrap().as_deref(), Some("bar"));
        assert_eq!(resolved.sources.len(), 1);
        assert_eq!(resolved.sources[0].plugin_name, "env-direnv");
        assert!(resolved.sources[0].detected);
        assert_eq!(resolved.sources[0].vars_contributed, 1);
        assert!(!resolved.sources[0].cached);
    }

    #[tokio::test]
    async fn resolve_plugin_detects_false_skips_export() {
        let backend = MockBackend::new()
            .with_plugin("env-direnv")
            .detects("env-direnv", false);
        let cache = EnvCache::new();
        let resolved = resolve_for_workspace(
            &backend,
            &cache,
            std::path::Path::new("/tmp"),
            &ws_info(),
            &Default::default(),
        )
        .await;

        assert!(resolved.vars.is_empty());
        let (detects, exports) = backend.call_counts("env-direnv");
        assert_eq!(detects, 1);
        assert_eq!(exports, 0, "export must not run when detect=false");
    }

    #[tokio::test]
    async fn precedence_direnv_overrides_mise() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join(".envrc"), "x").unwrap();
        std::fs::write(tmp.path().join("mise.toml"), "x").unwrap();

        let backend = MockBackend::new()
            .with_plugin("env-direnv")
            .with_plugin("env-mise")
            .detects("env-direnv", true)
            .detects("env-mise", true)
            .exports(
                "env-direnv",
                export_of(
                    &[("KEY", Some("from-direnv"))],
                    vec![tmp.path().join(".envrc")],
                ),
            )
            .exports(
                "env-mise",
                export_of(
                    &[("KEY", Some("from-mise"))],
                    vec![tmp.path().join("mise.toml")],
                ),
            );
        let cache = EnvCache::new();
        let resolved = resolve_for_workspace(
            &backend,
            &cache,
            tmp.path(),
            &ws_info(),
            &Default::default(),
        )
        .await;

        assert_eq!(
            resolved.vars.get("KEY").unwrap().as_deref(),
            Some("from-direnv"),
            "direnv precedence should override mise"
        );
    }

    #[tokio::test]
    async fn null_value_unsets_key() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("mise.toml"), "x").unwrap();
        std::fs::write(tmp.path().join(".envrc"), "x").unwrap();

        let backend = MockBackend::new()
            .with_plugin("env-mise")
            .with_plugin("env-direnv")
            .detects("env-mise", true)
            .detects("env-direnv", true)
            .exports(
                "env-mise",
                export_of(
                    &[("UNWANTED", Some("x"))],
                    vec![tmp.path().join("mise.toml")],
                ),
            )
            .exports(
                "env-direnv",
                // direnv (higher precedence) emits null → unsets the key
                export_of(&[("UNWANTED", None)], vec![tmp.path().join(".envrc")]),
            );
        let cache = EnvCache::new();
        let resolved = resolve_for_workspace(
            &backend,
            &cache,
            tmp.path(),
            &ws_info(),
            &Default::default(),
        )
        .await;

        // The merged map DOES contain the key, but its value is None —
        // which tells apply() to env_remove it from the spawned process.
        assert_eq!(resolved.vars.get("UNWANTED"), Some(&None));
    }

    #[tokio::test]
    async fn cache_hit_skips_detect_and_export() {
        let tmp = tempfile::tempdir().unwrap();
        let envrc = tmp.path().join(".envrc");
        std::fs::write(&envrc, "x").unwrap();

        let backend = MockBackend::new()
            .with_plugin("env-direnv")
            .detects("env-direnv", true)
            .exports(
                "env-direnv",
                export_of(&[("FOO", Some("bar"))], vec![envrc.clone()]),
            );
        let cache = EnvCache::new();

        // First resolve: cold cache.
        let _ = resolve_for_workspace(
            &backend,
            &cache,
            tmp.path(),
            &ws_info(),
            &Default::default(),
        )
        .await;
        // Second resolve: should be a cache hit.
        let resolved = resolve_for_workspace(
            &backend,
            &cache,
            tmp.path(),
            &ws_info(),
            &Default::default(),
        )
        .await;

        assert!(
            resolved.sources[0].cached,
            "second resolve should hit cache"
        );
        let (detects, exports) = backend.call_counts("env-direnv");
        assert_eq!(detects, 1, "cache hit must skip detect");
        assert_eq!(exports, 1, "cache hit must skip export");
    }

    #[tokio::test]
    async fn cache_miss_on_mtime_change() {
        let tmp = tempfile::tempdir().unwrap();
        let envrc = tmp.path().join(".envrc");
        std::fs::write(&envrc, "x").unwrap();

        let backend = MockBackend::new()
            .with_plugin("env-direnv")
            .detects("env-direnv", true)
            .exports(
                "env-direnv",
                export_of(&[("FOO", Some("bar"))], vec![envrc.clone()]),
            );
        let cache = EnvCache::new();
        let _ = resolve_for_workspace(
            &backend,
            &cache,
            tmp.path(),
            &ws_info(),
            &Default::default(),
        )
        .await;

        // Touch the watched file — forces a distinguishable mtime.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        std::fs::write(&envrc, "y").unwrap();

        let _ = resolve_for_workspace(
            &backend,
            &cache,
            tmp.path(),
            &ws_info(),
            &Default::default(),
        )
        .await;

        let (_, exports) = backend.call_counts("env-direnv");
        assert_eq!(exports, 2, "mtime change must re-export");
    }

    #[tokio::test]
    async fn detect_error_captured_in_source() {
        let backend = MockBackend::new().with_plugin("env-direnv");
        // detect_results has no entry → backend returns Ok(false) by
        // default. We want to cover the Err branch.
        let mut b = backend;
        b.detect_results
            .insert("env-direnv".into(), Err("direnv not allowed".into()));
        let cache = EnvCache::new();
        let resolved = resolve_for_workspace(
            &b,
            &cache,
            std::path::Path::new("/tmp"),
            &ws_info(),
            &Default::default(),
        )
        .await;
        assert_eq!(resolved.sources.len(), 1);
        assert!(resolved.sources[0].error.is_some());
        assert!(resolved.vars.is_empty());
    }

    #[tokio::test]
    async fn export_error_does_not_fail_resolve() {
        let backend = MockBackend::new()
            .with_plugin("env-direnv")
            .detects("env-direnv", true)
            .export_fails("env-direnv", "something broke");
        let cache = EnvCache::new();
        let resolved = resolve_for_workspace(
            &backend,
            &cache,
            std::path::Path::new("/tmp"),
            &ws_info(),
            &Default::default(),
        )
        .await;

        assert!(resolved.sources[0].detected);
        assert!(resolved.sources[0].error.is_some());
        assert_eq!(resolved.sources[0].vars_contributed, 0);
        assert!(resolved.vars.is_empty());
    }

    #[tokio::test]
    async fn apply_sets_and_unsets_vars_on_command() {
        // We can't easily inspect tokio Command's env after the fact, so
        // we use a std Command (same semantics) and run a shell that
        // prints its env to stdout. This exercises the full apply path.
        // Skipped on Windows — `sh` isn't present, and the semantics we
        // care about (env_remove) are shared across platforms anyway.
        #[cfg(unix)]
        {
            let mut env = EnvMap::new();
            env.insert("CLAUDETTE_TEST_SET".into(), Some("yes".into()));
            env.insert("CLAUDETTE_TEST_UNSET".into(), None);
            let resolved = ResolvedEnv {
                vars: env,
                sources: vec![],
            };

            let mut cmd = std::process::Command::new("sh");
            cmd.arg("-c")
                .arg("echo set=$CLAUDETTE_TEST_SET; echo unset=${CLAUDETTE_TEST_UNSET:-MISSING}");
            // Pre-set the unset var in the parent env so we can observe
            // env_remove actually taking effect.
            unsafe {
                std::env::set_var("CLAUDETTE_TEST_UNSET", "from-parent");
            }
            resolved.apply_std(&mut cmd);

            let output = cmd.output().unwrap();
            let stdout = String::from_utf8(output.stdout).unwrap();
            assert!(stdout.contains("set=yes"), "stdout was: {stdout}");
            assert!(
                stdout.contains("unset=MISSING"),
                "env_remove failed; stdout was: {stdout}"
            );
        }
    }

    #[tokio::test]
    async fn disabled_provider_is_skipped_and_cache_invalidated() {
        let tmp = tempfile::tempdir().unwrap();
        let envrc = tmp.path().join(".envrc");
        std::fs::write(&envrc, "x").unwrap();

        // Seed a cache entry as if direnv previously detected + exported.
        let cache = EnvCache::new();
        cache.put(
            tmp.path(),
            "env-direnv",
            &export_of(&[("FOO", Some("bar"))], vec![envrc.clone()]),
        );
        assert!(cache.get_fresh(tmp.path(), "env-direnv").is_some());

        // Now the user disables it. Expect:
        // - detect is NOT called
        // - export is NOT called
        // - cache entry is dropped so re-enabling re-runs the plugin
        // - source records a "disabled" reason
        let backend = MockBackend::new().with_plugin("env-direnv");
        let mut disabled = std::collections::HashSet::new();
        disabled.insert("env-direnv".to_string());
        let resolved =
            resolve_for_workspace(&backend, &cache, tmp.path(), &ws_info(), &disabled).await;

        let (detects, exports) = backend.call_counts("env-direnv");
        assert_eq!(detects, 0, "disabled provider must not be detected");
        assert_eq!(exports, 0, "disabled provider must not be exported");
        assert!(resolved.vars.is_empty());
        assert_eq!(resolved.sources.len(), 1);
        assert_eq!(resolved.sources[0].error.as_deref(), Some("disabled"));
        assert!(
            cache.get_fresh(tmp.path(), "env-direnv").is_none(),
            "disabling must evict cached env so re-enable re-runs fresh"
        );
    }

    #[tokio::test]
    async fn precedence_tie_break_is_deterministic_by_name() {
        // Two unknown providers share precedence 10. Without a secondary
        // sort key the merge order would follow HashMap iteration, so
        // which "FOO" wins depends on hash state. With the name tiebreak,
        // "aaa" sorts before "bbb" in ascending order — so "bbb" merges
        // last and wins on key collision.
        let backend = MockBackend::new()
            .with_plugin("aaa")
            .with_plugin("bbb")
            .detects("aaa", true)
            .detects("bbb", true)
            .exports("aaa", export_of(&[("FOO", Some("from-aaa"))], vec![]))
            .exports("bbb", export_of(&[("FOO", Some("from-bbb"))], vec![]));
        let cache = EnvCache::new();
        let resolved = resolve_for_workspace(
            &backend,
            &cache,
            std::path::Path::new("/tmp"),
            &ws_info(),
            &Default::default(),
        )
        .await;

        assert_eq!(
            resolved.vars.get("FOO").and_then(|v| v.as_deref()),
            Some("from-bbb"),
            "tied-precedence plugins must resolve by ascending name — bbb sorts later, wins merge"
        );
    }

    #[tokio::test]
    async fn detect_false_invalidates_stale_cache() {
        let tmp = tempfile::tempdir().unwrap();
        let envrc = tmp.path().join(".envrc");
        std::fs::write(&envrc, "x").unwrap();

        // Seed the cache as if direnv previously detected + exported.
        let cache = EnvCache::new();
        cache.put(
            tmp.path(),
            "env-direnv",
            &export_of(&[("STALE", Some("yes"))], vec![envrc.clone()]),
        );
        assert!(cache.get_fresh(tmp.path(), "env-direnv").is_some());

        // Now simulate the user deleting .envrc — detect returns false.
        std::fs::remove_file(&envrc).unwrap();
        let backend = MockBackend::new()
            .with_plugin("env-direnv")
            .detects("env-direnv", false);
        let _ = resolve_for_workspace(
            &backend,
            &cache,
            tmp.path(),
            &ws_info(),
            &Default::default(),
        )
        .await;

        assert!(
            cache.get_fresh(tmp.path(), "env-direnv").is_none(),
            "detect=false must evict the stale cache entry"
        );
    }
}
