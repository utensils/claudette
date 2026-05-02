//! Tauri commands for the Community Registry — discovery, install,
//! uninstall, and listing of community-contributed themes / plugins /
//! grammars from `utensils/claudette-community`.
//!
//! This file holds the **network + orchestration** layer; pure logic
//! (parse, verify, extract) lives in `claudette::community` (see lib
//! crate) per the dep split convention (no `reqwest` in the lib).
//!
//! Per TDD #567 PR #2: themes are out of scope for now (PR #3 adds
//! runtime theme loading). Theme installs into `~/.claudette/themes/`
//! still work, but Claudette won't render them yet.
//!
//! Live registry reload after install: we follow the
//! `reseed_bundled_plugins` pattern — discover + restore disabled +
//! settings overrides — so the just-installed plugin appears in the
//! Plugins panel without an app restart. Grammar plugins also need a
//! frontend-side refresh (see #570) — emitted as a Tauri event after
//! install completes.

use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use claudette::community::{
    self, ContributionKind, ContributionSource, InstallPlan, InstallRoots, PluginKindWire, Registry,
};
use claudette::db::Database;

use crate::state::AppState;

/// Default registry source. Hard-coded in PR #2; PR #4 adds a
/// `customRegistryUrls` setting for org/private registries.
const REGISTRY_URL: &str =
    "https://raw.githubusercontent.com/utensils/claudette-community/main/registry.json";

/// Detached minisign signature for [`REGISTRY_URL`]. Fetched in
/// parallel with the registry; verified against an embedded public
/// key (see `claudette::community::signature`) before the JSON is
/// parsed. The .sig URL is also on mutable `main`, but its bytes
/// only verify against an *immutable* embedded pubkey — an attacker
/// who swaps it can DoS but not forge.
const REGISTRY_SIG_URL: &str =
    "https://raw.githubusercontent.com/utensils/claudette-community/main/registry.json.sig";

/// `codeload.github.com/<repo>/tar.gz/<sha>` template. The `<repo>`
/// is intentionally pinned — installing from arbitrary repos is the
/// "direct install" path (PR #4), not this command.
fn codeload_url(repo: &str, sha: &str) -> String {
    format!("https://codeload.github.com/{repo}/tar.gz/{sha}")
}

/// Pinned URL for an `External` mirror tarball. Uses the registry's
/// `source.sha` rather than the mutable `main` ref so the bytes we
/// fetch are bound to a specific commit reviewable in git history.
fn mirror_url(repo: &str, sha: &str, mirror_path: &str) -> String {
    format!("https://raw.githubusercontent.com/{repo}/{sha}/{mirror_path}")
}

const HTTP_TIMEOUT: Duration = Duration::from_secs(60);

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .user_agent(format!("claudette/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("http client: {e}"))
}

/// Fetch and parse the community registry.
///
/// Trust path:
///   1. Fetch `registry.json` and `registry.json.sig` in parallel.
///   2. Verify the signature against the pubkey embedded in the
///      Claudette binary (`claudette::community::verify_registry_signature`).
///   3. Only after the sig verifies, parse the JSON.
///
/// Any of the three steps failing produces a distinct, user-visible
/// error so the UI can distinguish "missing signature" (publication
/// failure) from "invalid signature" (tamper / wrong key) from
/// "parse error" (signed but malformed JSON).
#[tauri::command]
pub async fn community_registry_fetch(_force: bool) -> Result<Registry, String> {
    let client = http_client()?;
    let (json_bytes, sig_bytes) = tokio::try_join!(
        fetch_url_bytes(&client, REGISTRY_URL, "registry"),
        fetch_url_bytes(&client, REGISTRY_SIG_URL, "registry signature"),
    )?;
    claudette::community::verify_registry_signature(&json_bytes, &sig_bytes)
        .map_err(|e| format!("registry signature: {e}"))?;
    serde_json::from_slice(&json_bytes).map_err(|e| format!("registry parse: {e}"))
}

async fn fetch_url_bytes(
    client: &reqwest::Client,
    url: &str,
    label: &str,
) -> Result<Vec<u8>, String> {
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("{label} fetch: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("{label} fetch returned {}: {url}", resp.status()));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("{label} body: {e}"))?;
    Ok(bytes.to_vec())
}

/// Frontend-facing summary of an installed contribution. Sent to the
/// UI to render the Installed list and result toasts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledContribution {
    /// Wire form: `theme` | `plugin:scm` | `plugin:env-provider` | `plugin:language-grammar`.
    pub kind: String,
    /// Theme `id` or plugin `name` — also the directory under
    /// `~/.claudette/{plugins,themes}/`.
    pub ident: String,
    /// Display name from the manifest.
    pub display_name: String,
    pub version: String,
    pub author: String,
    pub license: String,
    /// `Registry.source.sha` recorded at install time.
    pub registry_sha: String,
    /// Per-contribution source SHA at install time.
    pub contribution_sha: String,
    /// Verified content hash.
    pub sha256: String,
    pub installed_at: String,
}

/// Install a contribution by `(kind, ident)`. Looks up the entry in
/// the live registry, downloads the codeload tarball at the entry's
/// SHA, verifies the content hash, writes to disk, and reloads the
/// plugin runtime so the new plugin is usable without an app restart.
///
/// Emits the `community-installed` Tauri event on success — frontend
/// hot-reload paths (notably grammar plugins, see #570) listen for
/// this to refresh their on-screen registries.
#[tauri::command]
pub async fn community_install(
    kind: String,
    ident: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<InstalledContribution, String> {
    let kind_enum = ContributionKind::from_wire(&kind)
        .ok_or_else(|| format!("unknown contribution kind: {kind}"))?;

    let registry = community_registry_fetch(false).await?;
    let entry = registry
        .lookup(kind_enum, &ident)
        .ok_or_else(|| format!("{kind} {ident} not found in registry"))?;

    let plan = InstallPlan {
        kind: kind_enum,
        ident: entry.ident().to_string(),
        source: entry.source().clone(),
        version: entry.version().to_string(),
        granted_capabilities: entry.capabilities(),
        registry_sha: registry.source.sha.clone(),
    };
    // Commit-pin the download URL to registry.source.sha — the SHA
    // that the just-verified signature attests to. Per-entry sha is
    // still recorded in .install_meta.json for diagnostics, but the
    // bytes we fetch come from one reviewable commit, not N.
    let registry_source_sha = registry.source.sha.clone();
    let display_name = match &entry {
        community::ContributionRef::Theme(t) => t.name.clone(),
        community::ContributionRef::Plugin(p) => p.display_name.clone(),
    };
    let author = match &entry {
        community::ContributionRef::Theme(t) => t.author.clone(),
        community::ContributionRef::Plugin(p) => p.author.clone(),
    };
    let license = match &entry {
        community::ContributionRef::Theme(t) => t.license.clone(),
        community::ContributionRef::Plugin(p) => p.license.clone(),
    };

    let tarball = fetch_tarball(&plan, &registry_source_sha).await?;
    let roots = resolve_install_roots(&state).await?;
    tokio::fs::create_dir_all(&roots.plugins_dir)
        .await
        .map_err(|e| format!("create plugins dir: {e}"))?;
    tokio::fs::create_dir_all(&roots.themes_dir)
        .await
        .map_err(|e| format!("create themes dir: {e}"))?;

    // The installer is sync (filesystem ops + sha2), so run it on a
    // blocking task to avoid stalling the runtime.
    let plan_clone = plan.clone();
    let roots_clone = roots.clone();
    let install_path = tokio::task::spawn_blocking(move || {
        community::install(&plan_clone, &tarball, &roots_clone)
    })
    .await
    .map_err(|e| format!("install task: {e}"))?
    .map_err(|e| format!("install: {e}"))?;

    let meta = community::read_install_meta(&install_path)
        .map_err(|e| format!("read meta: {e}"))?
        .ok_or_else(|| "install metadata missing after install".to_string())?;

    // Reload the plugin registry so the just-installed plugin shows
    // up in the Plugins panel without restart. Themes (PR #3) get
    // their own reload path — for now installing a theme just leaves
    // the files on disk.
    if matches!(kind_enum, ContributionKind::Plugin(_)) {
        rehydrate_plugin_registry(&state).await?;
    }

    // Notify the frontend so any kind-specific hot-reload paths can
    // refresh (e.g. grammar registries — see #570).
    let _ = app.emit(
        "community-installed",
        serde_json::json!({
            "kind": kind,
            "ident": plan.ident,
        }),
    );

    Ok(InstalledContribution {
        kind: kind_enum.wire(),
        ident: plan.ident,
        display_name,
        version: meta.version,
        author,
        license,
        registry_sha: meta.registry_sha,
        contribution_sha: meta.contribution_sha,
        sha256: meta.sha256,
        installed_at: meta.installed_at,
    })
}

/// Remove a community-installed contribution from disk and clear any
/// associated `app_settings` rows. Reloads the plugin registry so the
/// removal takes effect without restart.
#[tauri::command]
pub async fn community_uninstall(
    kind: String,
    ident: String,
    state: State<'_, AppState>,
    app: AppHandle,
) -> Result<(), String> {
    let kind_enum = ContributionKind::from_wire(&kind)
        .ok_or_else(|| format!("unknown contribution kind: {kind}"))?;

    let roots = resolve_install_roots(&state).await?;
    community::uninstall(kind_enum, &ident, &roots).map_err(|e| format!("uninstall: {e}"))?;

    // Drop persisted plugin settings so re-installing later starts
    // from manifest defaults rather than carrying stale overrides.
    if matches!(kind_enum, ContributionKind::Plugin(_)) {
        let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
        let prefix = format!("plugin:{ident}:");
        if let Ok(entries) = db.list_app_settings_with_prefix(&prefix) {
            for (key, _) in entries {
                let _ = db.delete_app_setting(&key);
            }
        }
        rehydrate_plugin_registry(&state).await?;
    }

    let _ = app.emit(
        "community-uninstalled",
        serde_json::json!({
            "kind": kind,
            "ident": ident,
        }),
    );

    Ok(())
}

/// Walk both install roots and return summaries for any directory
/// that carries a `.install_meta.json` written by us (i.e. installed
/// via the registry, not hand-edited in by the user).
#[tauri::command]
pub async fn community_list_installed(
    state: State<'_, AppState>,
) -> Result<Vec<InstalledContribution>, String> {
    let roots = resolve_install_roots(&state).await?;
    let mut out = Vec::new();

    // Plugins. The wire `kind` lives in `.install_meta.json` so the
    // listing always returns a valid wire form (theme | plugin:scm |
    // plugin:env-provider | plugin:language-grammar) even when the
    // on-disk plugin.json is missing or unparseable. Display fields
    // (name/author/license) still come from the manifest when readable
    // and fall back to the directory name otherwise.
    if roots.plugins_dir.exists() {
        let entries =
            std::fs::read_dir(&roots.plugins_dir).map_err(|e| format!("read plugins dir: {e}"))?;
        for ent in entries.flatten() {
            let path = ent.path();
            if !path.is_dir() {
                continue;
            }
            if let Ok(Some(meta)) = community::read_install_meta(&path) {
                let ident = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("?")
                    .to_string();
                let manifest = read_plugin_manifest(&path).ok();
                let display_name = manifest
                    .as_ref()
                    .map(|m| m.display_name.clone())
                    .unwrap_or_else(|| ident.clone());
                let author = manifest
                    .as_ref()
                    .map(|m| m.author.clone())
                    .unwrap_or_default();
                let license = manifest
                    .as_ref()
                    .map(|m| m.license.clone())
                    .unwrap_or_default();
                // Trust the kind we recorded at install time; fall
                // back to the manifest only if `meta.kind` was missing
                // (only possible for installs that predate the field
                // — none in the wild today, but the default is safe).
                let kind_wire = if !meta.kind.is_empty() {
                    meta.kind.clone()
                } else if let Some(m) = manifest.as_ref() {
                    ContributionKind::Plugin(plugin_kind_to_wire(m.kind)).wire()
                } else {
                    ContributionKind::Plugin(PluginKindWire::Scm).wire()
                };

                out.push(InstalledContribution {
                    kind: kind_wire,
                    ident,
                    display_name,
                    version: meta.version,
                    author,
                    license,
                    registry_sha: meta.registry_sha,
                    contribution_sha: meta.contribution_sha,
                    sha256: meta.sha256,
                    installed_at: meta.installed_at,
                });
            }
        }
    }

    // Themes — PR #3 will fully wire these up; for now we still list
    // anything that's been installed so the Installed UI shows them.
    if roots.themes_dir.exists() {
        let entries =
            std::fs::read_dir(&roots.themes_dir).map_err(|e| format!("read themes dir: {e}"))?;
        for ent in entries.flatten() {
            let path = ent.path();
            if !path.is_dir() {
                continue;
            }
            if let Ok(Some(meta)) = community::read_install_meta(&path) {
                let manifest = read_theme_manifest(&path).ok();
                let display_name = manifest
                    .as_ref()
                    .map(|m| m.name.clone())
                    .unwrap_or_else(|| {
                        path.file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or("?")
                            .to_string()
                    });
                let author = manifest
                    .as_ref()
                    .map(|m| m.author.clone())
                    .unwrap_or_default();
                let license = manifest
                    .as_ref()
                    .map(|m| m.license.clone())
                    .unwrap_or_default();
                let ident = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("?")
                    .to_string();

                let kind_wire = if !meta.kind.is_empty() {
                    meta.kind.clone()
                } else {
                    ContributionKind::Theme.wire()
                };

                out.push(InstalledContribution {
                    kind: kind_wire,
                    ident,
                    display_name,
                    version: meta.version,
                    author,
                    license,
                    registry_sha: meta.registry_sha,
                    contribution_sha: meta.contribution_sha,
                    sha256: meta.sha256,
                    installed_at: meta.installed_at,
                });
            }
        }
    }

    out.sort_by(|a, b| {
        (a.kind.as_str(), a.ident.as_str()).cmp(&(b.kind.as_str(), b.ident.as_str()))
    });
    Ok(out)
}

/// Capability re-consent request surfaced to the UI. Built from the
/// diff of `manifest.required_clis` (live) vs `granted_capabilities`
/// (recorded in `.install_meta.json` at install time).
///
/// Any plugin with non-empty `missing` cannot run — `call_operation`
/// returns `PluginError::NeedsReconsent` until the user approves
/// (which calls `community_grant_capabilities`).
#[derive(Debug, Clone, Serialize)]
pub struct PendingReconsent {
    pub kind: String,
    pub ident: String,
    pub display_name: String,
    /// Currently granted capability list (`granted_capabilities`).
    pub granted: Vec<String>,
    /// Capabilities the new manifest declares but the user hasn't
    /// approved. `granted ∪ missing` is what would be granted on
    /// approval.
    pub missing: Vec<String>,
}

/// Walk every community-installed plugin and surface those whose live
/// `required_clis` exceeds stored grants. Empty result = nothing to
/// re-consent. Used by the Community settings UI to render a banner
/// per affected plugin.
#[tauri::command]
pub async fn community_pending_reconsent(
    state: State<'_, AppState>,
) -> Result<Vec<PendingReconsent>, String> {
    let registry = state.plugins.read().await;
    let mut out = Vec::new();
    for (name, plugin) in registry.plugins.iter() {
        if let claudette::plugin_runtime::PluginTrust::Community { granted } = &plugin.trust {
            let missing: Vec<String> = plugin
                .manifest
                .required_clis
                .iter()
                .filter(|c| !granted.iter().any(|g| g == *c))
                .cloned()
                .collect();
            if missing.is_empty() {
                continue;
            }
            // Derive kind from the manifest. The `.install_meta.json`
            // also carries this — but the manifest is what discovery
            // already parsed, so use it.
            let kind_wire = ContributionKind::Plugin(plugin_kind_to_wire(plugin.manifest.kind));
            out.push(PendingReconsent {
                kind: kind_wire.wire(),
                ident: name.clone(),
                display_name: plugin.manifest.display_name.clone(),
                granted: granted.clone(),
                missing,
            });
        }
    }
    out.sort_by(|a, b| a.ident.cmp(&b.ident));
    Ok(out)
}

/// Approve the live manifest's `required_clis` as the new grant set
/// for a community-installed plugin. Rewrites `.install_meta.json`
/// in place (preserving every other field) and rehydrates the
/// runtime so the next `call_operation` sees the new trust.
///
/// Errors on:
///   - unknown plugin name
///   - non-community plugin (bundled / unknown — shouldn't reach this
///     path; UI only offers re-consent when `pending_reconsent`
///     surfaces the plugin)
#[tauri::command]
pub async fn community_grant_capabilities(
    ident: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let install_dir = {
        let registry = state.plugins.read().await;
        let plugin = registry
            .plugins
            .get(&ident)
            .ok_or_else(|| format!("unknown plugin: {ident}"))?;
        if !matches!(
            plugin.trust,
            claudette::plugin_runtime::PluginTrust::Community { .. }
        ) {
            return Err(format!(
                "plugin '{ident}' is not a community install — refusing to mutate grants"
            ));
        }
        plugin.dir.clone()
    };

    // Read manifest off disk through the existing parser so we get the
    // same `required_clis` view that discovery + call_operation see.
    let manifest_path = install_dir.join("plugin.json");
    let manifest = claudette::plugin_runtime::manifest::parse_manifest(&manifest_path)
        .map_err(|e| format!("read plugin.json: {e}"))?;

    community::update_granted_capabilities(&install_dir, &manifest.required_clis)
        .map_err(|e| format!("write grants: {e}"))?;

    rehydrate_plugin_registry(&state).await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async fn fetch_tarball(plan: &InstallPlan, registry_source_sha: &str) -> Result<Vec<u8>, String> {
    // Both URL forms commit-pin to `registry_source_sha` — the commit
    // SHA that the just-verified signature attests to. The per-entry
    // `source.sha` is the commit that last touched the contribution
    // dir, which equals registry.source.sha for any freshly-regenerated
    // registry (regen.yml runs on every push to main); using
    // registry.source.sha consistently here makes the URL bind to one
    // reviewable commit even in the rare drift case.
    let url = match &plan.source {
        ContributionSource::InTree { .. } => {
            // PR #2 only handles in-tree contributions — the registry
            // schema rejects external themes outright, and we have no
            // external plugins yet. Direct-install (PR #4) handles
            // arbitrary repos.
            codeload_url("utensils/claudette-community", registry_source_sha)
        }
        ContributionSource::External { mirror_path, .. } => mirror_url(
            "utensils/claudette-community",
            registry_source_sha,
            mirror_path,
        ),
    };

    let client = http_client()?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("tarball fetch: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("tarball fetch returned {}: {url}", resp.status()));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("tarball body: {e}"))?;
    Ok(bytes.to_vec())
}

async fn resolve_install_roots(state: &State<'_, AppState>) -> Result<InstallRoots, String> {
    // Plugins live where the runtime already discovers them; themes
    // are a sibling directory under the same Claudette base.
    let registry = state.plugins.read().await;
    let plugins_dir = registry.plugin_dir.clone();
    drop(registry);
    let base = plugins_dir
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));
    let themes_dir = base.join("themes");
    Ok(InstallRoots {
        plugins_dir,
        themes_dir,
    })
}

async fn rehydrate_plugin_registry(state: &State<'_, AppState>) -> Result<(), String> {
    let plugin_dir = {
        let r = state.plugins.read().await;
        r.plugin_dir.clone()
    };
    let new_registry = claudette::plugin_runtime::PluginRegistry::discover(&plugin_dir);

    // Restore disabled state + setting overrides — same shape as
    // reseed_bundled_plugins. This is the documented hydration
    // pattern; if we add another reload site we should factor it
    // into a helper on PluginRegistry.
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    if let Ok(entries) = db.list_app_settings_with_prefix("plugin:") {
        for (key, value) in entries {
            let rest = &key["plugin:".len()..];
            if let Some((plugin_name, tail)) = rest.split_once(':') {
                if tail == "enabled" && value == "false" {
                    new_registry.set_disabled(plugin_name, true);
                } else if let Some(setting_key) = tail.strip_prefix("setting:")
                    && let Ok(v) = serde_json::from_str::<serde_json::Value>(&value)
                {
                    new_registry.set_setting(plugin_name, setting_key, Some(v));
                }
            }
        }
    }
    *state.plugins.write().await = new_registry;
    Ok(())
}

#[derive(Deserialize)]
struct PluginManifestLite {
    display_name: String,
    #[serde(default)]
    author: String,
    #[serde(default)]
    license: String,
    #[serde(default = "default_kind")]
    kind: claudette::plugin_runtime::manifest::PluginKind,
}

fn default_kind() -> claudette::plugin_runtime::manifest::PluginKind {
    claudette::plugin_runtime::manifest::PluginKind::Scm
}

fn plugin_kind_to_wire(k: claudette::plugin_runtime::manifest::PluginKind) -> PluginKindWire {
    use claudette::plugin_runtime::manifest::PluginKind;
    match k {
        PluginKind::Scm => PluginKindWire::Scm,
        PluginKind::EnvProvider => PluginKindWire::EnvProvider,
        PluginKind::LanguageGrammar => PluginKindWire::LanguageGrammar,
    }
}

#[derive(Deserialize)]
struct ThemeManifestLite {
    name: String,
    #[serde(default)]
    author: String,
    #[serde(default)]
    license: String,
}

fn read_plugin_manifest(dir: &std::path::Path) -> Result<PluginManifestLite, String> {
    let path = dir.join("plugin.json");
    let bytes = std::fs::read(&path).map_err(|e| format!("read plugin.json: {e}"))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("parse plugin.json: {e}"))
}

fn read_theme_manifest(dir: &std::path::Path) -> Result<ThemeManifestLite, String> {
    let path = dir.join("theme.json");
    let bytes = std::fs::read(&path).map_err(|e| format!("read theme.json: {e}"))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("parse theme.json: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// codeload URL is built from the repo + a single commit SHA;
    /// constructing the URL is a pure function and the only place we
    /// can test commit-pinning without spinning up an HTTP server.
    /// The behavioral guarantee: nothing about the URL ever encodes
    /// `main` or any other mutable ref.
    #[test]
    fn codeload_url_uses_immutable_commit_sha() {
        let url = codeload_url(
            "utensils/claudette-community",
            "382298b4206010cea7865ae811c39e2a90d5c7fa",
        );
        assert_eq!(
            url,
            "https://codeload.github.com/utensils/claudette-community/tar.gz/382298b4206010cea7865ae811c39e2a90d5c7fa"
        );
        assert!(!url.contains("/main"));
        assert!(!url.contains("HEAD"));
    }

    /// External (mirror) URL must also commit-pin to registry.source.sha.
    /// Pre-PR, this URL was constructed against `main` — the bug being
    /// fixed in this PR. Lock the commit-pinned shape in.
    #[test]
    fn mirror_url_pins_to_registry_source_sha_not_main() {
        let url = mirror_url(
            "utensils/claudette-community",
            "382298b4206010cea7865ae811c39e2a90d5c7fa",
            "mirrors/foo-bar-1234.tar.gz",
        );
        assert_eq!(
            url,
            "https://raw.githubusercontent.com/utensils/claudette-community/382298b4206010cea7865ae811c39e2a90d5c7fa/mirrors/foo-bar-1234.tar.gz"
        );
        assert!(!url.contains("/main/"));
    }

    /// Sanity: REGISTRY_SIG_URL must sit next to REGISTRY_URL on the
    /// same path so swapping one without the other is server-visible.
    /// (Anyone with write to the community repo can update both files
    /// at once anyway — the signature check is what stops a forgery,
    /// not URL co-location — but this catches accidental drift in the
    /// constants.)
    #[test]
    fn registry_sig_url_is_sibling_of_registry_url() {
        assert_eq!(
            REGISTRY_SIG_URL,
            format!("{REGISTRY_URL}.sig"),
            "registry sig URL should be `{{registry url}}.sig`",
        );
    }
}
