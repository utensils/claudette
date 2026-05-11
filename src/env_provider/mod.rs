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
pub mod watcher;

use std::path::Path;
use std::time::SystemTime;

use serde::Serialize;

use crate::plugin_runtime::host_api::WorkspaceInfo;

use backend::EnvProviderBackend;
pub use backend::PluginRegistryBackend;
pub use cache::EnvCache;
use types::EnvMap;
pub use watcher::EnvWatcher;

/// Convenience helper that wires the standard [`PluginRegistryBackend`]
/// into [`resolve_for_workspace`] with minimal boilerplate at the call
/// site. The tauri layer uses this from spawn command handlers.
///
/// The dispatcher consults the backend directly for global-disable
/// state (via [`EnvProviderBackend::is_plugin_disabled`]), so callers
/// only need to pass their per-repo disabled set here.
pub async fn resolve_with_registry(
    registry: &crate::plugin_runtime::PluginRegistry,
    cache: &EnvCache,
    worktree: &Path,
    ws_info: &WorkspaceInfo,
    disabled: &std::collections::HashSet<String>,
) -> ResolvedEnv {
    resolve_with_registry_and_progress(registry, cache, worktree, ws_info, disabled, None).await
}

/// Variant of [`resolve_with_registry`] that surfaces per-plugin
/// progress to a sink. Used by Tauri command handlers to broadcast a
/// `workspace_env_progress` event so all UI surfaces (sidebar row,
/// chat composer, terminal overlay) can show "loading env-direnv (Ns)…"
/// regardless of which workspace the user is viewing. `None` for the
/// `progress` argument is equivalent to [`resolve_with_registry`] —
/// the cache-hit fast path still skips the sink entirely.
pub async fn resolve_with_registry_and_progress(
    registry: &crate::plugin_runtime::PluginRegistry,
    cache: &EnvCache,
    worktree: &Path,
    ws_info: &WorkspaceInfo,
    disabled: &std::collections::HashSet<String>,
    progress: Option<&dyn EnvProgressSink>,
) -> ResolvedEnv {
    let backend = PluginRegistryBackend::new(registry);
    resolve_for_workspace_with_progress(&backend, cache, worktree, ws_info, disabled, progress)
        .await
}

/// Receiver for env-provider progress events. Implementors broadcast
/// "started" / "finished" notifications so UI surfaces can render a
/// loading state for each plugin invocation. The dispatcher only
/// fires on cache *misses* — cache hits skip the sink so the sidebar
/// doesn't flash a spinner for instant resolutions.
pub trait EnvProgressSink: Send + Sync {
    /// A plugin's `detect`/`export` is about to run. Receivers
    /// typically map this to a "preparing" status entry in the UI
    /// store keyed by `(workspace_id, plugin_name)`.
    fn started(&self, plugin: &str);
    /// The plugin's invocation finished. `ok = true` when the
    /// dispatcher merged at least some env (or determined the plugin
    /// doesn't apply); `false` reflects a hard error string. `elapsed`
    /// matches what the spinner UI shows so receivers don't have to
    /// re-time on their side.
    fn finished(&self, plugin: &str, ok: bool, elapsed: std::time::Duration);
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

    /// Sources whose error string indicates the user needs to take a
    /// one-time priming action (run `direnv allow`, `mise trust`, etc.)
    /// before this provider can contribute env. Heuristic match on the
    /// stderr text the plugin propagated up — keeps generic export
    /// failures (malformed TOML, missing CLI) out of the trust-warning
    /// surface so we don't tell the user to "run `mise trust`" when
    /// `mise` isn't even installed.
    pub fn trust_errors(&self) -> Vec<&ResolvedSource> {
        self.sources
            .iter()
            .filter(|s| s.error.as_deref().is_some_and(is_trust_error))
            .collect()
    }

    /// Render a markdown system message describing every trust error,
    /// or `None` when there are none. Each block names the provider, a
    /// fenced-code-block excerpt of the stderr the plugin captured, and
    /// a one-line remediation hint pointing at the action the user can
    /// take.
    pub fn format_trust_message(&self) -> Option<String> {
        let errors = self.trust_errors();
        if errors.is_empty() {
            return None;
        }
        let mut body = String::from(
            "**Environment setup needed.** One or more env-provider plugins reported a trust/priming error. Until this is resolved, the agent will spawn without the tools and variables this provider would normally contribute, which can cause prompts to fail.\n",
        );
        for src in errors {
            let display = display_name_for(&src.plugin_name);
            let hint = remediation_hint(&src.plugin_name);
            let excerpt = excerpt_error(src.error.as_deref().unwrap_or(""));
            // Fenced block keeps multi-line stderr (and any leading
            // whitespace direnv/mise emit) from collapsing the list
            // layout; the indent under the bullet keeps the code block
            // visually associated with the parent list item.
            body.push_str(&format!(
                "\n- **{display}**\n\n    ```\n{excerpt}\n    ```\n\n    {hint}\n"
            ));
        }
        body.push_str(
            "\nYou can also configure a setup script in **Repo Settings → Setup Script** so future workspaces auto-prime this environment.",
        );
        Some(body)
    }
}

/// Truncate and re-indent an error string for embedding inside a
/// markdown fenced code block under a list item. Caps the excerpt at
/// `MAX_EXCERPT_BYTES` so a runaway stderr (mise/direnv occasionally
/// dump multi-screen diagnostics) doesn't blow out the chat surface,
/// and prefixes every line with four spaces so the block stays inside
/// the parent bullet's indent context.
fn excerpt_error(error: &str) -> String {
    const MAX_EXCERPT_BYTES: usize = 800;
    let trimmed = error.trim_end();
    let truncated = if trimmed.len() > MAX_EXCERPT_BYTES {
        // Cut at a UTF-8 char boundary to avoid panicking on non-ASCII.
        let mut cut = MAX_EXCERPT_BYTES;
        while cut > 0 && !trimmed.is_char_boundary(cut) {
            cut -= 1;
        }
        format!("{}…", &trimmed[..cut])
    } else {
        trimmed.to_string()
    };
    truncated
        .lines()
        .map(|l| format!("    {l}"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Trust-error heuristic. Matches the stderr substrings that mise and
/// direnv emit when their config hasn't been allowed yet. Generic
/// `export:` / `detect:` errors that don't contain any of these
/// markers fall through and are not surfaced as trust warnings —
/// notably "permission denied" is intentionally NOT matched, since it
/// is too broad and would catch unrelated filesystem failures (e.g.
/// the plugin couldn't read its own config because of POSIX perms).
pub fn is_trust_error_str(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    ["not trusted", "is blocked", "is not allowed", "untrusted"]
        .iter()
        .any(|needle| lower.contains(needle))
}

/// Thin wrapper kept for symmetry with the other internal classifiers
/// in this module. Prefer [`is_trust_error_str`] from external crates.
fn is_trust_error(error: &str) -> bool {
    is_trust_error_str(error)
}

fn display_name_for(plugin_name: &str) -> &str {
    match plugin_name {
        "env-mise" => "mise",
        "env-direnv" => "direnv",
        "env-nix-devshell" => "nix",
        "env-dotenv" => "dotenv",
        _ => plugin_name,
    }
}

fn remediation_hint(plugin_name: &str) -> &'static str {
    match plugin_name {
        "env-mise" => {
            "Run `mise trust` in the worktree, or open the Environment panel and click **Trust**."
        }
        "env-direnv" => {
            "Run `direnv allow` in the worktree, or open the Environment panel and click **Allow**."
        }
        _ => "Open the Environment panel for this workspace to inspect and prime this provider.",
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
    resolve_for_workspace_with_progress(backend, cache, worktree, ws_info, disabled, None).await
}

/// Variant of [`resolve_for_workspace`] that emits per-plugin
/// progress events to the supplied sink. See [`EnvProgressSink`].
pub async fn resolve_for_workspace_with_progress(
    backend: &impl EnvProviderBackend,
    cache: &EnvCache,
    worktree: &Path,
    ws_info: &WorkspaceInfo,
    disabled: &std::collections::HashSet<String>,
    progress: Option<&dyn EnvProgressSink>,
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
        // "Disabled" means either:
        //   - the user toggled it off per-repo (Environment panel), or
        //   - the plugin is globally disabled in the Plugins settings
        //     section (via `backend.is_plugin_disabled`).
        // Both surface the same way to the UI (`error: "disabled"`)
        // and drop any stale cache entry so re-enabling forces a
        // fresh evaluation on the next resolve.
        if disabled.contains(&name) || backend.is_plugin_disabled(&name) {
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
        // "Unavailable" means the plugin's required CLI (e.g. `nix`,
        // `mise`, `direnv`) is not on PATH. Bundled env-providers ship
        // for every user — most won't have all three CLIs installed —
        // so this is the canonical "doesn't apply, skip silently"
        // signal, NOT a hard error. We treat it like `disabled`
        // (drop cache, record reason, no toast) but use a distinct
        // marker so the EnvPanel can render "not installed" instead
        // of "disabled". See issue #718.
        if backend.is_plugin_unavailable(&name) {
            cache.invalidate(worktree, Some(&name));
            sources.push(ResolvedSource {
                plugin_name: name,
                detected: false,
                vars_contributed: 0,
                cached: false,
                evaluated_at: SystemTime::now(),
                error: Some("unavailable".to_string()),
            });
            continue;
        }
        let source = resolve_one(
            backend,
            cache,
            &name,
            worktree,
            ws_info,
            &mut merged,
            progress,
        )
        .await;
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
    progress: Option<&dyn EnvProgressSink>,
) -> ResolvedSource {
    // 1. Fast path: cache hit → skip detect AND export. Notably also
    //    skip the progress sink — a cache hit is instantaneous and
    //    flashing the UI loading state for it would be more confusing
    //    than helpful.
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

    // From here on we know the plugin will actually run — emit
    // "started" so the UI can render a per-plugin spinner. The
    // "finished" call is paired in every return arm below.
    let started = std::time::Instant::now();
    if let Some(sink) = progress {
        sink.started(name);
    }
    let emit_finished = |ok: bool| {
        if let Some(sink) = progress {
            sink.finished(name, ok, started.elapsed());
        }
    };

    // 2. Slow path: run detect.
    let detected = match backend.detect(name, worktree, ws_info).await {
        Ok(v) => v,
        Err(e) => {
            emit_finished(false);
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
        emit_finished(true);
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
            emit_finished(true);
            ResolvedSource {
                plugin_name: name.to_string(),
                detected: true,
                vars_contributed: contributed,
                cached: false,
                evaluated_at: SystemTime::now(),
                error: None,
            }
        }
        Err(e) => {
            emit_finished(false);
            ResolvedSource {
                plugin_name: name.to_string(),
                detected: true,
                vars_contributed: 0,
                cached: false,
                evaluated_at: SystemTime::now(),
                error: Some(format!("export: {e}")),
            }
        }
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
            ..Default::default()
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

    #[tokio::test]
    async fn globally_disabled_skips_even_with_warm_cache() {
        // Regression for the Codex finding: even when a plugin had a
        // previously-cached export, flipping it off globally must stop
        // its vars from reaching the merged env on the next resolve.
        let tmp = tempfile::tempdir().unwrap();
        let cache = EnvCache::new();

        // Seed a warm cache entry for env-direnv pointing at a real
        // file so the mtime check would otherwise keep it fresh.
        let watched = tmp.path().join(".envrc");
        std::fs::write(&watched, "x").unwrap();
        let export = ProviderExport {
            env: {
                let mut m = EnvMap::new();
                m.insert("SHOULD_NOT_SHOW".into(), Some("leaked".into()));
                m
            },
            watched: vec![watched.clone()],
        };
        cache.put(tmp.path(), "env-direnv", &export);
        assert!(cache.get_fresh(tmp.path(), "env-direnv").is_some());

        let backend = MockBackend::new()
            .with_plugin("env-direnv")
            .with_globally_disabled("env-direnv")
            .detects("env-direnv", true)
            .exports("env-direnv", export.clone());

        let resolved = resolve_for_workspace(
            &backend,
            &cache,
            tmp.path(),
            &ws_info(),
            &Default::default(),
        )
        .await;

        assert!(
            !resolved.vars.contains_key("SHOULD_NOT_SHOW"),
            "globally-disabled plugin must not contribute vars (warm cache leak)"
        );
        let source = resolved
            .sources
            .iter()
            .find(|s| s.plugin_name == "env-direnv")
            .expect("plugin must appear in sources");
        assert_eq!(source.error.as_deref(), Some("disabled"));
        assert!(
            cache.get_fresh(tmp.path(), "env-direnv").is_none(),
            "disable must invalidate the cache entry"
        );
    }

    fn make_source(name: &str, error: Option<&str>) -> ResolvedSource {
        ResolvedSource {
            plugin_name: name.into(),
            detected: error.is_none(),
            vars_contributed: 0,
            cached: false,
            evaluated_at: SystemTime::now(),
            error: error.map(|s| s.into()),
        }
    }

    #[test]
    fn trust_errors_match_mise_not_trusted() {
        let env = ResolvedEnv {
            vars: Default::default(),
            sources: vec![make_source(
                "env-mise",
                Some("export: mise env failed: mise.toml is not trusted"),
            )],
        };
        let errors = env.trust_errors();
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].plugin_name, "env-mise");
    }

    #[test]
    fn trust_errors_match_direnv_blocked() {
        let env = ResolvedEnv {
            vars: Default::default(),
            sources: vec![make_source(
                "env-direnv",
                Some("export: direnv export failed: .envrc is blocked"),
            )],
        };
        assert_eq!(env.trust_errors().len(), 1);
    }

    #[test]
    fn trust_errors_skip_generic_export_failures() {
        // A malformed mise.toml or missing CLI is a different problem
        // class — `mise trust` won't fix it, so it must NOT surface as a
        // trust warning.
        let env = ResolvedEnv {
            vars: Default::default(),
            sources: vec![make_source(
                "env-mise",
                Some("export: mise env failed: failed to parse mise.toml"),
            )],
        };
        assert!(env.trust_errors().is_empty());
    }

    #[test]
    fn trust_errors_empty_when_no_errors() {
        let env = ResolvedEnv {
            vars: Default::default(),
            sources: vec![make_source("env-mise", None)],
        };
        assert!(env.trust_errors().is_empty());
        assert!(env.format_trust_message().is_none());
    }

    #[test]
    fn format_trust_message_lists_each_failing_provider() {
        let env = ResolvedEnv {
            vars: Default::default(),
            sources: vec![
                make_source("env-mise", Some("export: mise env failed: not trusted")),
                make_source(
                    "env-direnv",
                    Some("export: direnv export failed: is blocked"),
                ),
            ],
        };
        let body = env
            .format_trust_message()
            .expect("trust errors should produce a message");
        // Names + remediation hints both surface so the user knows what
        // to run for each failing provider.
        assert!(body.contains("**mise**"));
        assert!(body.contains("**direnv**"));
        assert!(body.contains("`mise trust`"));
        assert!(body.contains("`direnv allow`"));
        // Stderr renders inside a fenced code block so multi-line
        // output can't break the surrounding markdown list.
        assert!(body.contains("```"));
        assert!(body.contains("    export: mise env failed: not trusted"));
        // The closing pointer to repo settings is the durable fix.
        assert!(body.contains("Repo Settings"));
    }

    #[test]
    fn excerpt_error_preserves_short_single_line() {
        let s = excerpt_error("mise.toml is not trusted");
        assert_eq!(s, "    mise.toml is not trusted");
    }

    #[test]
    fn excerpt_error_indents_each_line_for_list_block() {
        let s = excerpt_error("first\nsecond\nthird");
        assert_eq!(s, "    first\n    second\n    third");
    }

    #[test]
    fn excerpt_error_truncates_runaway_stderr_at_char_boundary() {
        // 1500 ASCII bytes of stderr — past the 800-byte cap.
        let huge = "x".repeat(1500);
        let s = excerpt_error(&huge);
        // Truncated and ellipsis-suffixed so the chat surface doesn't
        // explode if a plugin dumps multi-screen diagnostics.
        assert!(s.ends_with('…'));
        assert!(s.len() < 1500);
    }

    #[test]
    fn excerpt_error_handles_multibyte_chars_at_truncation_boundary() {
        // 4-byte UTF-8 characters padded past the 800-byte cap. The
        // boundary scan must back up rather than panicking. Each "🚀"
        // is 4 bytes, so 250 of them = 1000 bytes.
        let s = excerpt_error(&"🚀".repeat(250));
        assert!(s.ends_with('…'));
        // Sanity: still valid UTF-8 (push to String would have panicked
        // if the cut landed mid-char).
        assert!(s.is_char_boundary(s.len()));
    }

    #[tokio::test]
    async fn unavailable_provider_is_skipped_silently() {
        // Regression for issue #718: an env-provider whose required CLI
        // is not on PATH must skip with `error: "unavailable"` rather
        // than letting `CliNotFound` bubble up as a noisy toast.
        let tmp = tempfile::tempdir().unwrap();
        let backend = MockBackend::new()
            .with_plugin("env-nix-devshell")
            .with_unavailable("env-nix-devshell")
            // Even if detect were Ok(true), it must not run for an
            // unavailable plugin — assert call counts below.
            .detects("env-nix-devshell", true);
        let cache = EnvCache::new();
        let resolved = resolve_for_workspace(
            &backend,
            &cache,
            tmp.path(),
            &ws_info(),
            &Default::default(),
        )
        .await;

        let (detects, exports) = backend.call_counts("env-nix-devshell");
        assert_eq!(detects, 0, "unavailable provider must not run detect");
        assert_eq!(exports, 0, "unavailable provider must not run export");
        assert_eq!(resolved.sources.len(), 1);
        assert_eq!(resolved.sources[0].error.as_deref(), Some("unavailable"));
        assert!(!resolved.sources[0].detected);
    }

    #[tokio::test]
    async fn unavailable_provider_evicts_stale_cache() {
        // If the user had the CLI installed last session and we cached
        // an export, then uninstalled it, the next resolve must drop
        // that cache entry instead of leaking stale env vars.
        let tmp = tempfile::tempdir().unwrap();
        let envrc = tmp.path().join(".envrc");
        std::fs::write(&envrc, "x").unwrap();
        let cache = EnvCache::new();
        cache.put(
            tmp.path(),
            "env-direnv",
            &export_of(&[("STALE", Some("yes"))], vec![envrc.clone()]),
        );
        assert!(cache.get_fresh(tmp.path(), "env-direnv").is_some());

        let backend = MockBackend::new()
            .with_plugin("env-direnv")
            .with_unavailable("env-direnv");
        let resolved = resolve_for_workspace(
            &backend,
            &cache,
            tmp.path(),
            &ws_info(),
            &Default::default(),
        )
        .await;

        assert!(resolved.vars.is_empty());
        assert_eq!(resolved.sources[0].error.as_deref(), Some("unavailable"));
        assert!(
            cache.get_fresh(tmp.path(), "env-direnv").is_none(),
            "unavailable must invalidate any cached export"
        );
    }

    #[tokio::test]
    async fn resolve_with_registry_treats_missing_cli_as_unavailable() {
        // End-to-end through the real PluginRegistry: a manifest that
        // requires a CLI which is guaranteed-not-on-PATH should resolve
        // to `error: "unavailable"`, not `error: "detect: CLI tool ...
        // is not installed"`. Without this, every workspace switch
        // toasts for users without nix/mise/direnv installed.
        let tmp = tempfile::tempdir().unwrap();
        let plugin_dir = tempfile::tempdir().unwrap();
        let pdir = plugin_dir.path().join("env-fakecli");
        std::fs::create_dir_all(&pdir).unwrap();
        // Generate a UUID-suffixed CLI name so the test stays
        // deterministic even on (admittedly unlikely) machines where
        // a binary with our hardcoded sentinel name happens to exist.
        // No image we ship to / build on uses uuid-suffixed names, so
        // collision is mathematically impossible here.
        let fake_cli = format!("claudette-test-{}", uuid::Uuid::new_v4());
        let manifest = serde_json::json!({
            "name": "env-fakecli",
            "display_name": "Fake CLI",
            "version": "1.0.0",
            "description": "test",
            "kind": "env-provider",
            "operations": ["detect", "export"],
            "required_clis": [fake_cli],
        });
        std::fs::write(pdir.join("plugin.json"), manifest.to_string()).unwrap();
        std::fs::write(
            pdir.join("init.lua"),
            r#"
            local M = {}
            function M.detect() return true end
            function M.export() return { env = {}, watched = {} } end
            return M
            "#,
        )
        .unwrap();

        let registry = crate::plugin_runtime::PluginRegistry::discover(plugin_dir.path());
        // Sanity: the plugin loaded, but its CLI was not found.
        assert!(registry.plugins.contains_key("env-fakecli"));
        assert!(!registry.is_cli_available("env-fakecli"));

        let cache = EnvCache::new();
        let resolved = resolve_with_registry(
            &registry,
            &cache,
            tmp.path(),
            &ws_info(),
            &Default::default(),
        )
        .await;

        let source = resolved
            .sources
            .iter()
            .find(|s| s.plugin_name == "env-fakecli")
            .expect("plugin must appear in sources");
        assert_eq!(source.error.as_deref(), Some("unavailable"));
        assert!(!source.detected);
    }

    #[tokio::test]
    async fn unavailable_does_not_swallow_pending_reconsent() {
        // Codex peer review: a community env-provider whose live
        // manifest grew an unapproved CLI requirement which is ALSO
        // not on PATH must still surface re-consent, not silently
        // disappear as "not installed". The dispatcher should fall
        // through to call_operation, which returns NeedsReconsent and
        // bubbles up as an error in the resolved source.
        let tmp = tempfile::tempdir().unwrap();
        let plugin_dir = tempfile::tempdir().unwrap();
        let pdir = plugin_dir.path().join("env-community");
        std::fs::create_dir_all(&pdir).unwrap();
        // Discovery sees an empty required_clis (so cli_available =
        // true) and a community .install_meta.json. We then mutate
        // the manifest in-place to simulate post-install drift that
        // grew a CLI requirement, mirroring the existing reconsent
        // tests in plugin_runtime::mod.rs.
        std::fs::write(
            pdir.join("plugin.json"),
            r#"{
                "name": "env-community",
                "display_name": "Community env",
                "version": "1.0.0",
                "description": "test",
                "kind": "env-provider",
                "operations": ["detect", "export"]
            }"#,
        )
        .unwrap();
        std::fs::write(
            pdir.join("init.lua"),
            r#"
            local M = {}
            function M.detect() return true end
            function M.export() return { env = {}, watched = {} } end
            return M
            "#,
        )
        .unwrap();
        let empty_grants: Vec<String> = Vec::new();
        let meta = serde_json::json!({
            "source": "community",
            "kind": "plugin:env-provider",
            "registry_sha": "0".repeat(40),
            "contribution_sha": "1".repeat(40),
            "sha256": "2".repeat(64),
            "installed_at": "2026-05-02T00:00:00Z",
            "granted_capabilities": empty_grants,
            "version": "1.0.0",
        });
        std::fs::write(
            pdir.join(".install_meta.json"),
            serde_json::to_string_pretty(&meta).unwrap(),
        )
        .unwrap();

        let mut registry = crate::plugin_runtime::PluginRegistry::discover(plugin_dir.path());
        // Drift: manifest now requires a CLI the user never granted,
        // and that same CLI is not on PATH. Without the reconsent
        // guard this would resolve as "unavailable" and hide the
        // capability-grant prompt entirely.
        let plugin = registry.plugins.get_mut("env-community").unwrap();
        plugin.manifest.required_clis = vec!["claudette-test-not-on-path".to_string()];
        plugin.cli_available = false;

        assert!(registry.needs_reconsent("env-community"));
        assert!(!registry.is_cli_available("env-community"));

        let cache = EnvCache::new();
        let resolved = resolve_with_registry(
            &registry,
            &cache,
            tmp.path(),
            &ws_info(),
            &Default::default(),
        )
        .await;
        let source = resolved
            .sources
            .iter()
            .find(|s| s.plugin_name == "env-community")
            .expect("plugin must appear in sources");
        // Must NOT be the silent "unavailable" skip — the runtime's
        // re-consent error must propagate so the user sees it.
        assert_ne!(source.error.as_deref(), Some("unavailable"));
        let err = source.error.as_deref().expect("must surface an error");
        assert!(
            err.contains("re-consent") || err.contains("Reconsent") || err.contains("reconsent"),
            "expected reconsent error, got: {err}"
        );
    }

    #[tokio::test]
    async fn resolve_with_registry_treats_globally_disabled_as_disabled() {
        // Regression guard for the UAT finding: globally-disabled plugins
        // used to surface as `detect` errors with "Plugin '...' is
        // disabled" in the UI. Now they merge into the dispatcher's
        // `disabled` set so the source shows error="disabled" cleanly.
        let tmp = tempfile::tempdir().unwrap();
        let plugin_dir = tempfile::tempdir().unwrap();
        // Seed a minimal env-provider plugin so the registry discovers it.
        let pdir = plugin_dir.path().join("env-testprov");
        std::fs::create_dir_all(&pdir).unwrap();
        std::fs::write(
            pdir.join("plugin.json"),
            r#"{
                "name": "env-testprov",
                "display_name": "TestProv",
                "version": "1.0.0",
                "description": "test",
                "kind": "env-provider",
                "operations": ["detect", "export"]
            }"#,
        )
        .unwrap();
        std::fs::write(
            pdir.join("init.lua"),
            r#"
            local M = {}
            function M.detect() return true end
            function M.export() return { env = {}, watched = {} } end
            return M
            "#,
        )
        .unwrap();

        let registry = crate::plugin_runtime::PluginRegistry::discover(plugin_dir.path());
        registry.set_disabled("env-testprov", true);
        let cache = EnvCache::new();

        let resolved = resolve_with_registry(
            &registry,
            &cache,
            tmp.path(),
            &ws_info(),
            &Default::default(),
        )
        .await;

        let source = resolved
            .sources
            .iter()
            .find(|s| s.plugin_name == "env-testprov")
            .expect("plugin must appear in sources");
        assert_eq!(source.error.as_deref(), Some("disabled"));
        assert!(!source.detected);
    }

    /// Capture every `started`/`finished` call so the test can assert
    /// the dispatcher fires exactly once per non-cache-hit invocation
    /// and skips the sink for cache hits.
    #[derive(Default)]
    struct RecordingSink {
        events: std::sync::Mutex<Vec<(&'static str, String, Option<bool>)>>,
    }

    impl EnvProgressSink for RecordingSink {
        fn started(&self, plugin: &str) {
            self.events
                .lock()
                .unwrap()
                .push(("started", plugin.to_string(), None));
        }
        fn finished(&self, plugin: &str, ok: bool, _elapsed: std::time::Duration) {
            self.events
                .lock()
                .unwrap()
                .push(("finished", plugin.to_string(), Some(ok)));
        }
    }

    #[tokio::test]
    async fn progress_sink_fires_for_each_invoked_plugin() {
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
        let sink = RecordingSink::default();
        let _ = resolve_for_workspace_with_progress(
            &backend,
            &cache,
            tmp.path(),
            &ws_info(),
            &Default::default(),
            Some(&sink),
        )
        .await;

        let events = sink.events.lock().unwrap();
        assert_eq!(
            events.len(),
            2,
            "expect a started+finished pair, got {events:?}"
        );
        assert_eq!(events[0].0, "started");
        assert_eq!(events[0].1, "env-direnv");
        assert_eq!(events[1].0, "finished");
        assert_eq!(events[1].1, "env-direnv");
        assert_eq!(events[1].2, Some(true));
    }

    #[tokio::test]
    async fn progress_sink_skipped_on_cache_hit() {
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

        // Prime the cache with one resolve (no sink), then re-run with
        // a recording sink. The cache hit should bypass the sink.
        let _ = resolve_for_workspace(
            &backend,
            &cache,
            tmp.path(),
            &ws_info(),
            &Default::default(),
        )
        .await;

        let sink = RecordingSink::default();
        let resolved = resolve_for_workspace_with_progress(
            &backend,
            &cache,
            tmp.path(),
            &ws_info(),
            &Default::default(),
            Some(&sink),
        )
        .await;

        assert!(resolved.sources.iter().any(|s| s.cached));
        assert!(
            sink.events.lock().unwrap().is_empty(),
            "cache hits must not flash the loading UI"
        );
    }

    #[tokio::test]
    async fn progress_sink_reports_error_when_export_fails() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join(".envrc"), "x").unwrap();

        // detect=true + export error → finished should fire with ok=false.
        let backend = MockBackend::new()
            .with_plugin("env-direnv")
            .detects("env-direnv", true)
            .export_fails("env-direnv", "boom");
        let cache = EnvCache::new();
        let sink = RecordingSink::default();
        let _ = resolve_for_workspace_with_progress(
            &backend,
            &cache,
            tmp.path(),
            &ws_info(),
            &Default::default(),
            Some(&sink),
        )
        .await;

        let events = sink.events.lock().unwrap();
        let finished = events
            .iter()
            .find(|(kind, _, _)| *kind == "finished")
            .expect("finished event missing");
        assert_eq!(finished.2, Some(false));
    }
}
