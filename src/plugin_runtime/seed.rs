use std::path::Path;

use sha2::{Digest, Sha256};

/// Embedded plugin definition. Operation-driven plugins (`scm`,
/// `env-provider`) ship `plugin.json` + `init.lua`; declarative plugins
/// (`language-grammar`) ship `plugin.json` + arbitrary `extra_files`
/// and have no `init.lua`. The shape is the same on either side of the
/// install boundary so the seeding logic can handle both uniformly.
pub struct BundledPlugin {
    pub name: &'static str,
    pub plugin_json: &'static str,
    pub init_lua: Option<&'static str>,
    /// Additional files written under the plugin directory. Each tuple
    /// is `(plugin-relative-path, contents)`. Paths must be relative
    /// (no leading `/` or `..`) and use forward slashes — they are
    /// joined onto the plugin directory at write time.
    pub extra_files: &'static [(&'static str, &'static str)],
}

const BUNDLED_PLUGINS: &[BundledPlugin] = &[
    BundledPlugin {
        name: "github",
        plugin_json: include_str!("../../plugins/scm-github/plugin.json"),
        init_lua: Some(include_str!("../../plugins/scm-github/init.lua")),
        extra_files: &[],
    },
    BundledPlugin {
        name: "gitlab",
        plugin_json: include_str!("../../plugins/scm-gitlab/plugin.json"),
        init_lua: Some(include_str!("../../plugins/scm-gitlab/init.lua")),
        extra_files: &[],
    },
    BundledPlugin {
        name: "env-direnv",
        plugin_json: include_str!("../../plugins/env-direnv/plugin.json"),
        init_lua: Some(include_str!("../../plugins/env-direnv/init.lua")),
        extra_files: &[],
    },
    BundledPlugin {
        name: "env-mise",
        plugin_json: include_str!("../../plugins/env-mise/plugin.json"),
        init_lua: Some(include_str!("../../plugins/env-mise/init.lua")),
        extra_files: &[],
    },
    BundledPlugin {
        name: "env-dotenv",
        plugin_json: include_str!("../../plugins/env-dotenv/plugin.json"),
        init_lua: Some(include_str!("../../plugins/env-dotenv/init.lua")),
        extra_files: &[],
    },
    BundledPlugin {
        name: "env-nix-devshell",
        plugin_json: include_str!("../../plugins/env-nix-devshell/plugin.json"),
        init_lua: Some(include_str!("../../plugins/env-nix-devshell/init.lua")),
        extra_files: &[],
    },
    BundledPlugin {
        name: "lang-nix",
        plugin_json: include_str!("../../plugins/lang-nix/plugin.json"),
        init_lua: None,
        extra_files: &[(
            "grammars/nix.tmLanguage.json",
            include_str!("../../plugins/lang-nix/grammars/nix.tmLanguage.json"),
        )],
    },
];

/// The current app version, used for the .version sentinel file.
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Seed bundled plugins into the plugin directory on app startup.
///
/// Content-hash driven: the `.version` file used to gate this path,
/// but that only fires when `APP_VERSION` bumps. Plugin content often
/// changes between releases too — a plugin `init.lua` edit merged
/// mid-cycle wouldn't reach users until the next version bump. That
/// left real users stuck with stale plugins (seen concretely when
/// PR #415 added `host.direnv_decode_watches` under the same app
/// version — seed skipped, the new Lua code never reached disk).
///
/// The decision tree is now content-based:
///
/// 1. No primary artifact on disk (fresh install) → write everything.
/// 2. On-disk hash == bundled hash → nothing to do.
/// 3. On-disk hash != bundled hash AND `.content_hash` stamp matches
///    the on-disk content → we own this file, the bundle moved;
///    overwrite.
/// 4. On-disk hash != bundled hash AND the stamp is missing or
///    disagrees with on-disk content → the user modified it after
///    our last write; preserve with a warning so they know why an
///    update didn't land. The "Reload bundled plugins" button
///    (`reseed_bundled_plugins_force`) lets them force it.
///
/// `APP_VERSION` is still stamped into `.version` for diagnostics
/// (it answers "which Claudette last touched this?") but is no
/// longer load-bearing for the update decision.
pub fn seed_bundled_plugins(plugin_dir: &Path) -> Vec<String> {
    let mut warnings = Vec::new();

    for plugin in BUNDLED_PLUGINS {
        let dir = plugin_dir.join(plugin.name);
        let version_file = dir.join(".version");
        let manifest_file = dir.join("plugin.json");
        let hash_file = dir.join(".content_hash");

        if let Err(e) = std::fs::create_dir_all(&dir) {
            warnings.push(format!(
                "Failed to create plugin dir {}: {e}",
                dir.display()
            ));
            continue;
        }

        // First-run path: nothing to preserve, write it all. The
        // primary artifact is `init.lua` for operation-driven kinds;
        // for declarative-only kinds, presence of `plugin.json` (or
        // any owned extra file) signals we've seeded before.
        if is_first_run(plugin, &dir) {
            if let Err(e) = write_plugin_files(&dir, plugin, &version_file) {
                warnings.push(format!("Failed to seed plugin '{}': {e}", plugin.name));
            }
            continue;
        }

        let on_disk_hash = match on_disk_content_hash(plugin, &dir) {
            Some(h) => h,
            None => {
                // One of our owned files vanished after a prior seed;
                // treat as drift and rewrite. This matches the
                // existing first-run path's net effect for plugins
                // that lost a file post-seed (e.g. a partial cleanup).
                if let Err(e) = write_plugin_files(&dir, plugin, &version_file) {
                    warnings.push(format!("Failed to repair plugin '{}': {e}", plugin.name));
                }
                continue;
            }
        };
        let bundled_hash = bundled_content_hash(plugin);

        // Content matches bundle → no body change needed. But the
        // manifest (`plugin.json`) can drift independently — new
        // `operations`, an updated settings schema, a renamed
        // `display_name`. Refresh the manifest (and the `.version`
        // stamp) so `PluginRegistry::discover` always sees current
        // metadata even when the body is stable.
        //
        // Also top up `.content_hash` for legacy installs that
        // predate hash stamping, so future drift detection works.
        if on_disk_hash == bundled_hash {
            if !hash_file.exists()
                && let Err(e) = std::fs::write(&hash_file, &bundled_hash)
            {
                warnings.push(format!(
                    "Plugin '{}': failed to write content hash stamp: {e}",
                    plugin.name
                ));
            }
            if let Err(e) = refresh_manifest_if_changed(&manifest_file, plugin.plugin_json) {
                warnings.push(format!(
                    "Plugin '{}': manifest refresh failed: {e}",
                    plugin.name
                ));
            }
            let current_version = std::fs::read_to_string(&version_file)
                .unwrap_or_default()
                .trim()
                .to_string();
            if current_version != APP_VERSION
                && let Err(e) = std::fs::write(&version_file, APP_VERSION)
            {
                warnings.push(format!(
                    "Plugin '{}': .version refresh failed: {e}",
                    plugin.name
                ));
            }
            continue;
        }

        // Differs from the bundle — is this our prior write or a
        // user customization?
        let stamped = std::fs::read_to_string(&hash_file)
            .ok()
            .map(|s| s.trim().to_string());
        let user_modified = match stamped {
            // We stamped this, and the content still matches our
            // stamp → the bundle moved while the user's copy
            // stayed put; safe to overwrite.
            Some(h) if h == on_disk_hash => false,
            // Stamp disagrees with on-disk content → user edited
            // after we wrote. Preserve.
            Some(_) => true,
            // Legacy install from before `.content_hash` existed.
            // We can't tell for sure; err on the side of
            // preserving. User can hit "Reload bundled plugins"
            // in the UI (or delete the dir) if they want the
            // bundled version.
            None => true,
        };

        if user_modified {
            warnings.push(format!(
                "Plugin '{}' has user modifications — skipping update. \
                 Use 'Reload bundled plugins' in Settings to force.",
                plugin.name
            ));
            continue;
        }

        if let Err(e) = write_plugin_files(&dir, plugin, &version_file) {
            warnings.push(format!("Failed to update plugin '{}': {e}", plugin.name));
        }
    }

    warnings
}

/// Reseed all bundled plugins regardless of the current `.version`
/// stamp. Used by the "Reload bundled plugins" button to pick up
/// in-tree plugin changes between Claudette releases (since the
/// version-gated path in [`seed_bundled_plugins`] only runs on
/// APP_VERSION bumps).
///
/// Preserves user-modified files by comparing SHA-256 hashes — if the
/// on-disk content doesn't match *any* content the bundled seed
/// function has ever written, we skip that plugin and return a
/// warning so the user sees why it wasn't updated.
pub fn reseed_bundled_plugins_force(plugin_dir: &Path) -> Vec<String> {
    let mut warnings = Vec::new();

    for plugin in BUNDLED_PLUGINS {
        let dir = plugin_dir.join(plugin.name);
        let version_file = dir.join(".version");
        let content_hash_file = dir.join(".content_hash");

        if let Err(e) = std::fs::create_dir_all(&dir) {
            warnings.push(format!(
                "Failed to create plugin dir {}: {e}",
                dir.display()
            ));
            continue;
        }

        // Layered ownership check:
        //
        // 1. No `.version` at all + any owned content already on
        //    disk → user created this plugin directory; never touch.
        // 2. `.content_hash` exists + matches the on-disk content →
        //    this is the content we last wrote; safe to overwrite
        //    (the current embed may differ from the stored hash,
        //    which is exactly the stale-seeded case reseed is for).
        // 3. `.content_hash` exists + differs from the on-disk
        //    content → user customized it after we seeded; preserve.
        // 4. `.content_hash` missing + `.version` present (legacy
        //    install predating hash-stamping): fall back to hashing
        //    against the current embed. This restores the pre-hash
        //    behavior for existing installs without clobbering
        //    customizations.
        let has_version_stamp = version_file.exists();
        let has_owned_content = on_disk_content_hash(plugin, &dir).is_some();
        if has_owned_content && !has_version_stamp {
            warnings.push(format!(
                "Plugin '{}': no .version file — directory appears user-created, skipping. \
                 Delete {} to force a reseed.",
                plugin.name,
                dir.display()
            ));
            continue;
        }

        if has_owned_content {
            let on_disk_hash = match on_disk_content_hash(plugin, &dir) {
                Some(h) => h,
                None => continue,
            };
            let preserved_as_user_edit = if content_hash_file.exists() {
                let stamped = std::fs::read_to_string(&content_hash_file)
                    .unwrap_or_default()
                    .trim()
                    .to_string();
                stamped != on_disk_hash
            } else {
                // Legacy install without a content hash. Only preserve
                // if the on-disk content clearly diverges from what we
                // would write now — this retains customizations made
                // before this code existed. Stale-seeded-but-unmodified
                // copies (identical to the current embed) pass through
                // and get restamped with a proper hash below.
                bundled_content_hash(plugin) != on_disk_hash
            };
            if preserved_as_user_edit {
                warnings.push(format!(
                    "Plugin '{}': content has user modifications — skipping update. \
                     Delete {} to force a reseed.",
                    plugin.name,
                    dir.display()
                ));
                continue;
            }
        }

        if let Err(e) = write_plugin_files(&dir, plugin, &version_file) {
            warnings.push(format!("Failed to reseed plugin '{}': {e}", plugin.name));
        }
    }

    warnings
}

/// `true` when no owned content from `plugin` exists on disk yet —
/// either a fresh install or a previously-uninstalled plugin coming
/// back. For operation-driven plugins this is "init.lua missing"; for
/// declarative plugins it is "no extra files and no manifest yet".
fn is_first_run(plugin: &BundledPlugin, dir: &Path) -> bool {
    if plugin.init_lua.is_some() {
        return !dir.join("init.lua").exists();
    }
    // Declarative plugin: any owned file present means we (or a user)
    // already wrote something here. Use that as the inverse signal.
    let any_extra_present = plugin
        .extra_files
        .iter()
        .any(|(rel, _)| dir.join(rel).exists());
    !any_extra_present && !dir.join("plugin.json").exists()
}

/// Combined SHA-256 hash of the plugin's owned content as bundled in
/// the binary. Used to compare against the on-disk hash to detect
/// drift.
///
/// Backwards-compat: when a plugin ships only `init.lua` (no
/// `extra_files`), the hash is exactly `sha256(init_lua)` — matching
/// the format pre-multi-file installs stamped, so existing
/// `.content_hash` files continue to verify without migration.
fn bundled_content_hash(plugin: &BundledPlugin) -> String {
    if plugin.extra_files.is_empty()
        && let Some(init) = plugin.init_lua
    {
        return sha256_hex(init);
    }
    let mut hasher = Sha256::new();
    if let Some(init) = plugin.init_lua {
        hasher.update(b"init.lua\0");
        hasher.update(init.as_bytes());
        hasher.update(b"\n");
    }
    let mut sorted: Vec<_> = plugin.extra_files.iter().collect();
    sorted.sort_by_key(|(path, _)| *path);
    for (path, content) in sorted {
        hasher.update(path.as_bytes());
        hasher.update(b"\0");
        hasher.update(content.as_bytes());
        hasher.update(b"\n");
    }
    format!("{:x}", hasher.finalize())
}

/// Combined SHA-256 hash of the plugin's owned content currently on
/// disk. Returns `None` when any expected file is missing — a partial
/// install that the seeding logic should treat as drift and rewrite.
fn on_disk_content_hash(plugin: &BundledPlugin, dir: &Path) -> Option<String> {
    if plugin.extra_files.is_empty() && plugin.init_lua.is_some() {
        return std::fs::read_to_string(dir.join("init.lua"))
            .ok()
            .map(|s| sha256_hex(&s));
    }
    let mut hasher = Sha256::new();
    if plugin.init_lua.is_some() {
        let content = std::fs::read_to_string(dir.join("init.lua")).ok()?;
        hasher.update(b"init.lua\0");
        hasher.update(content.as_bytes());
        hasher.update(b"\n");
    }
    let mut sorted: Vec<_> = plugin.extra_files.iter().collect();
    sorted.sort_by_key(|(path, _)| *path);
    for (path, _) in sorted {
        let content = std::fs::read_to_string(dir.join(path)).ok()?;
        hasher.update(path.as_bytes());
        hasher.update(b"\0");
        hasher.update(content.as_bytes());
        hasher.update(b"\n");
    }
    Some(format!("{:x}", hasher.finalize()))
}

/// Rewrite `manifest_path` only when its on-disk bytes don't already
/// match `bundled_content`. Avoids pointless mtime bumps for the
/// common case where the manifest is already current, and keeps the
/// "only update if we need to" contract for the case-2 refresh path
/// (init.lua unchanged, manifest may have drifted).
fn refresh_manifest_if_changed(manifest_path: &Path, bundled_content: &str) -> std::io::Result<()> {
    let on_disk = std::fs::read_to_string(manifest_path).unwrap_or_default();
    if on_disk == bundled_content {
        return Ok(());
    }
    std::fs::write(manifest_path, bundled_content)
}

/// Write all owned files for a plugin (manifest, optional init.lua,
/// extra files) and refresh the version + content-hash stamps.
///
/// Ensures `dir` exists before any writes so callers can rely on this
/// function as a self-contained "materialize this plugin to disk"
/// primitive without pre-creating the directory tree.
fn write_plugin_files(
    dir: &Path,
    plugin: &BundledPlugin,
    version_path: &Path,
) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    std::fs::write(dir.join("plugin.json"), plugin.plugin_json)?;
    if let Some(init) = plugin.init_lua {
        std::fs::write(dir.join("init.lua"), init)?;
    }
    for (rel, content) in plugin.extra_files {
        let target = dir.join(rel);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(target, content)?;
    }
    std::fs::write(version_path, APP_VERSION)?;
    let hash_path = dir.join(".content_hash");
    std::fs::write(hash_path, bundled_content_hash(plugin))?;
    Ok(())
}

fn sha256_hex(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sha256_hex() {
        let hash1 = sha256_hex("hello");
        let hash2 = sha256_hex("hello");
        let hash3 = sha256_hex("world");
        assert_eq!(hash1, hash2);
        assert_ne!(hash1, hash3);
        assert_eq!(hash1.len(), 64); // SHA-256 hex is 64 chars
    }

    #[test]
    fn test_seed_creates_plugins_on_first_run() {
        let dir = tempfile::tempdir().unwrap();
        let plugin_dir = dir.path();

        let warnings = seed_bundled_plugins(plugin_dir);
        assert!(warnings.is_empty(), "Unexpected warnings: {warnings:?}");

        // GitHub plugin should exist
        assert!(plugin_dir.join("github/plugin.json").exists());
        assert!(plugin_dir.join("github/init.lua").exists());
        assert!(plugin_dir.join("github/.version").exists());

        // GitLab plugin should exist
        assert!(plugin_dir.join("gitlab/plugin.json").exists());
        assert!(plugin_dir.join("gitlab/init.lua").exists());
        assert!(plugin_dir.join("gitlab/.version").exists());

        // Version file should contain the app version
        let version = std::fs::read_to_string(plugin_dir.join("github/.version")).unwrap();
        assert_eq!(version, APP_VERSION);

        // Every fresh seed must stamp `.content_hash` — without it,
        // future drift detection in `seed_bundled_plugins` couldn't
        // distinguish "we wrote this" from "user customized".
        let hash_path = plugin_dir.join("github/.content_hash");
        assert!(hash_path.exists(), "first-run must stamp content hash");
        let bundled_github = BUNDLED_PLUGINS.iter().find(|p| p.name == "github").unwrap();
        assert_eq!(
            std::fs::read_to_string(&hash_path).unwrap().trim(),
            bundled_content_hash(bundled_github),
            "content hash stamp must match bundled content"
        );
    }

    #[test]
    fn seed_is_noop_when_content_matches_bundle() {
        // After a successful first-run seed, running seed again on
        // an unchanged tree should do nothing — no warnings, no
        // writes.
        let dir = tempfile::tempdir().unwrap();
        seed_bundled_plugins(dir.path());

        // Capture the initial mtime of github/init.lua so a
        // redundant overwrite would be observable.
        let init_path = dir.path().join("github/init.lua");
        let mtime_before = std::fs::metadata(&init_path).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));

        let warnings = seed_bundled_plugins(dir.path());
        assert!(warnings.is_empty(), "unexpected warnings: {warnings:?}");
        let mtime_after = std::fs::metadata(&init_path).unwrap().modified().unwrap();
        assert_eq!(
            mtime_before, mtime_after,
            "matching content must not trigger a rewrite"
        );
    }

    #[test]
    fn seed_refreshes_manifest_when_init_lua_unchanged() {
        // Regression for a Codex finding: the "init.lua matches
        // bundle → no-op" path used to skip plugin.json refresh too.
        // If a release bumps manifest metadata (new operations, new
        // settings schema) without changing the Lua body, users
        // would keep seeing stale manifests until they forced a
        // reseed. Exercise: on-disk init.lua matches bundle; on-disk
        // manifest is stale. Expect the manifest to get rewritten.
        let dir = tempfile::tempdir().unwrap();
        seed_bundled_plugins(dir.path());

        let manifest_path = dir.path().join("github/plugin.json");
        let stale_manifest = r#"{"name":"github","version":"0.0.0","stale":true}"#;
        std::fs::write(&manifest_path, stale_manifest).unwrap();

        let warnings = seed_bundled_plugins(dir.path());
        let github_warnings: Vec<_> = warnings.iter().filter(|w| w.contains("github")).collect();
        assert!(
            github_warnings.is_empty(),
            "manifest refresh must not warn: {github_warnings:?}"
        );

        let on_disk = std::fs::read_to_string(&manifest_path).unwrap();
        assert_ne!(on_disk, stale_manifest, "stale manifest must be replaced");
        // Should match the bundled manifest content.
        let bundled = BUNDLED_PLUGINS
            .iter()
            .find(|p| p.name == "github")
            .map(|p| p.plugin_json)
            .unwrap();
        assert_eq!(on_disk, bundled);
    }

    #[test]
    fn seed_auto_updates_when_bundle_content_changes() {
        // The regression this fix exists to prevent: a stale seed
        // lingers on disk after a bundled plugin update because the
        // version-gated path skipped (APP_VERSION didn't bump).
        //
        // Simulate: Claudette previously seeded an older init.lua
        // with the SAME app version, then a new release ships new
        // plugin content under the SAME app version number.
        let dir = tempfile::tempdir().unwrap();
        let init_path = dir.path().join("github/init.lua");
        let hash_path = dir.path().join("github/.content_hash");
        let version_path = dir.path().join("github/.version");
        std::fs::create_dir_all(init_path.parent().unwrap()).unwrap();

        // Prior Claudette (same version) seeded stale content and
        // stamped the hash to match.
        let stale = "-- old plugin body from a prior seed\nreturn {}";
        std::fs::write(&init_path, stale).unwrap();
        std::fs::write(&hash_path, sha256_hex(stale)).unwrap();
        std::fs::write(&version_path, APP_VERSION).unwrap();
        std::fs::write(dir.path().join("github/plugin.json"), "{}").unwrap();

        // Seed should notice bundled_hash != on_disk_hash, stamp
        // still matches on disk → overwrite, no warning.
        let warnings = seed_bundled_plugins(dir.path());
        let github_warnings: Vec<_> = warnings.iter().filter(|w| w.contains("github")).collect();
        assert!(
            github_warnings.is_empty(),
            "stale-but-owned seed must auto-update: {github_warnings:?}"
        );
        let after = std::fs::read_to_string(&init_path).unwrap();
        assert!(
            !after.contains("old plugin body"),
            "stale content must be replaced"
        );
    }

    #[test]
    fn seed_preserves_user_modifications() {
        // User edits a plugin's init.lua (hash no longer matches
        // the stamped content). Seed must leave it alone and warn.
        let dir = tempfile::tempdir().unwrap();
        seed_bundled_plugins(dir.path());

        let init_path = dir.path().join("github/init.lua");
        let user = "-- hand-rolled tweak\nlocal M = {}\nreturn M";
        std::fs::write(&init_path, user).unwrap();

        let warnings = seed_bundled_plugins(dir.path());
        let github_warnings: Vec<_> = warnings.iter().filter(|w| w.contains("github")).collect();
        assert!(
            !github_warnings.is_empty(),
            "expected warning for user-modified plugin: {warnings:?}"
        );
        assert!(github_warnings[0].contains("user modifications"));

        let after = std::fs::read_to_string(&init_path).unwrap();
        assert_eq!(after, user, "user edits must be preserved");
    }

    #[test]
    fn seed_preserves_legacy_install_without_content_hash() {
        // Installs predating `.content_hash` stamping look like
        // "unknown ownership" — we can't tell whether the user
        // customized. Err on the side of preserving. User can hit
        // "Reload bundled plugins" to force.
        let dir = tempfile::tempdir().unwrap();
        let plugin_subdir = dir.path().join("github");
        std::fs::create_dir_all(&plugin_subdir).unwrap();
        // Legacy: has .version, has init.lua, NO .content_hash.
        std::fs::write(plugin_subdir.join(".version"), "0.0.1").unwrap();
        std::fs::write(plugin_subdir.join("init.lua"), "-- legacy content\n").unwrap();
        std::fs::write(plugin_subdir.join("plugin.json"), "{}").unwrap();

        let warnings = seed_bundled_plugins(dir.path());
        let github_warnings: Vec<_> = warnings.iter().filter(|w| w.contains("github")).collect();
        assert!(
            !github_warnings.is_empty(),
            "legacy install without stamp must be preserved (even if stale)"
        );

        let after = std::fs::read_to_string(plugin_subdir.join("init.lua")).unwrap();
        assert!(
            after.contains("legacy content"),
            "legacy content must not be clobbered"
        );
    }

    #[test]
    fn seed_stamps_hash_on_legacy_install_that_matches_bundle() {
        // Legacy install whose on-disk content happens to match the
        // current bundle: healing path — stamp the hash so future
        // drift detection works, but make no content change.
        let dir = tempfile::tempdir().unwrap();
        let plugin_subdir = dir.path().join("github");
        std::fs::create_dir_all(&plugin_subdir).unwrap();
        let bundled_github = BUNDLED_PLUGINS.iter().find(|p| p.name == "github").unwrap();
        let bundled_init = bundled_github.init_lua.unwrap();
        std::fs::write(plugin_subdir.join(".version"), "0.0.1").unwrap();
        std::fs::write(plugin_subdir.join("init.lua"), bundled_init).unwrap();
        std::fs::write(plugin_subdir.join("plugin.json"), "{}").unwrap();

        let warnings = seed_bundled_plugins(dir.path());
        let github_warnings: Vec<_> = warnings.iter().filter(|w| w.contains("github")).collect();
        assert!(
            github_warnings.is_empty(),
            "legacy install matching bundle should heal silently: {github_warnings:?}"
        );

        let hash_path = plugin_subdir.join(".content_hash");
        assert!(hash_path.exists(), "content hash stamp must be written");
        let stamped = std::fs::read_to_string(&hash_path).unwrap();
        assert_eq!(stamped.trim(), bundled_content_hash(bundled_github));
    }

    #[test]
    fn force_reseed_rewrites_stale_version_content() {
        // Stale-seeded scenario: plugin was seeded by an older
        // Claudette build, its on-disk init.lua no longer matches
        // the current embed, but the `.content_hash` stamp still
        // matches the on-disk content (we own it, user didn't
        // modify). The Reload button must overwrite.
        let dir = tempfile::tempdir().unwrap();
        seed_bundled_plugins(dir.path());

        let init_path = dir.path().join("github/init.lua");
        let hash_path = dir.path().join("github/.content_hash");
        let stale = "-- stale content from older version";
        std::fs::write(&init_path, stale).unwrap();
        // Restamp the hash to match the stale content — this is
        // what a prior reseed from that older version would have
        // written.
        std::fs::write(&hash_path, sha256_hex(stale)).unwrap();

        let warnings = reseed_bundled_plugins_force(dir.path());
        let github_warnings: Vec<_> = warnings.iter().filter(|w| w.contains("github")).collect();
        assert!(
            github_warnings.is_empty(),
            "stale seeded copy must be overwritten without warning: {github_warnings:?}"
        );
        let after = std::fs::read_to_string(&init_path).unwrap();
        assert!(
            !after.contains("stale content"),
            "stale content must be replaced with embedded plugin"
        );
    }

    #[test]
    fn force_reseed_preserves_user_edits_via_hash_stamp() {
        // Regression guard for the Codex re-review finding: when
        // `.content_hash` exists but differs from the on-disk
        // init.lua hash, the user has customized a seeded plugin.
        // Force-reseed must preserve those edits.
        let dir = tempfile::tempdir().unwrap();
        seed_bundled_plugins(dir.path());

        let init_path = dir.path().join("github/init.lua");
        // Simulate a user edit — change content WITHOUT updating
        // `.content_hash`, which is exactly what happens when a
        // user edits the file directly.
        let user_content = "-- user customization\nlocal M = {}\nreturn M";
        std::fs::write(&init_path, user_content).unwrap();

        let warnings = reseed_bundled_plugins_force(dir.path());
        let github_warnings: Vec<_> = warnings.iter().filter(|w| w.contains("github")).collect();
        assert!(
            !github_warnings.is_empty(),
            "user edit must be preserved with a warning: {warnings:?}"
        );
        let after = std::fs::read_to_string(&init_path).unwrap();
        assert!(
            after.contains("user customization"),
            "user edits must survive reseed"
        );
    }

    #[test]
    fn force_reseed_skips_user_created_plugin_dir() {
        // A user-created plugin directory has no `.version` stamp.
        // The reseed must refuse to clobber it.
        let dir = tempfile::tempdir().unwrap();
        let user_dir = dir.path().join("github");
        std::fs::create_dir_all(&user_dir).unwrap();
        std::fs::write(
            user_dir.join("init.lua"),
            "-- user-authored plugin (never seeded)",
        )
        .unwrap();
        std::fs::write(user_dir.join("plugin.json"), "{}").unwrap();
        // NO .version file — this is the user-ownership signal.

        let warnings = reseed_bundled_plugins_force(dir.path());
        assert!(
            warnings.iter().any(|w| w.contains("github")),
            "user-created plugin dir must be preserved with a warning: {warnings:?}"
        );
        let preserved = std::fs::read_to_string(user_dir.join("init.lua")).unwrap();
        assert!(preserved.contains("user-authored"));
    }

    #[test]
    fn force_reseed_rewrites_unmodified_plugin() {
        let dir = tempfile::tempdir().unwrap();
        seed_bundled_plugins(dir.path());

        // Delete init.lua so force-reseed has to restore it.
        let init_path = dir.path().join("github/init.lua");
        std::fs::remove_file(&init_path).unwrap();

        let warnings = reseed_bundled_plugins_force(dir.path());
        assert!(
            warnings.is_empty(),
            "unmodified reseed should have no warnings: {warnings:?}"
        );
        assert!(init_path.exists(), "init.lua must be restored");
    }

    /// Build a synthetic multi-file plugin and exercise it through
    /// the public seeding API. Static lifetimes make this slightly
    /// awkward — we lean on `Box::leak` so the test harness can
    /// embed runtime values into the `&'static` slots
    /// `BundledPlugin` uses.
    fn synth_grammar_plugin(name: &str, manifest: &str, grammar: &str) -> &'static BundledPlugin {
        let extras: &'static [(&'static str, &'static str)] = Box::leak(Box::new([(
            "grammars/test.tmLanguage.json",
            Box::leak(grammar.to_string().into_boxed_str()) as &'static str,
        )]));
        let plugin = BundledPlugin {
            name: Box::leak(name.to_string().into_boxed_str()),
            plugin_json: Box::leak(manifest.to_string().into_boxed_str()),
            init_lua: None,
            extra_files: extras,
        };
        Box::leak(Box::new(plugin))
    }

    #[test]
    fn multi_file_first_run_writes_all_files_and_stamps_hash() {
        let dir = tempfile::tempdir().unwrap();
        let plugin = synth_grammar_plugin(
            "lang-test-write",
            r#"{"name":"lang-test-write","display_name":"Test","version":"1.0.0","description":"d","kind":"language-grammar","operations":[]}"#,
            r#"{"scopeName":"source.test","patterns":[]}"#,
        );

        let plugin_dir = dir.path().join(plugin.name);
        write_plugin_files(&plugin_dir, plugin, &plugin_dir.join(".version")).unwrap();

        assert!(plugin_dir.join("plugin.json").exists());
        assert!(!plugin_dir.join("init.lua").exists());
        assert!(plugin_dir.join("grammars/test.tmLanguage.json").exists());
        assert!(plugin_dir.join(".version").exists());
        assert!(plugin_dir.join(".content_hash").exists());

        let stamped = std::fs::read_to_string(plugin_dir.join(".content_hash"))
            .unwrap()
            .trim()
            .to_string();
        assert_eq!(stamped, bundled_content_hash(plugin));
    }

    #[test]
    fn multi_file_drift_in_extra_file_detected() {
        // Drift detection must include extra files, not just init.lua.
        let dir = tempfile::tempdir().unwrap();
        let plugin = synth_grammar_plugin(
            "lang-test-drift",
            r#"{"name":"lang-test-drift","display_name":"Test","version":"1.0.0","description":"d","kind":"language-grammar","operations":[]}"#,
            r#"{"scopeName":"source.test","patterns":[]}"#,
        );

        let plugin_dir = dir.path().join(plugin.name);
        write_plugin_files(&plugin_dir, plugin, &plugin_dir.join(".version")).unwrap();

        let bundled = bundled_content_hash(plugin);
        let on_disk = on_disk_content_hash(plugin, &plugin_dir).unwrap();
        assert_eq!(bundled, on_disk, "fresh write must match");

        // Tweak the grammar — drift in any owned file must change
        // the combined hash.
        std::fs::write(
            plugin_dir.join("grammars/test.tmLanguage.json"),
            r##"{"scopeName":"source.test","patterns":[{"name":"comment","match":"#"}]}"##,
        )
        .unwrap();
        let after = on_disk_content_hash(plugin, &plugin_dir).unwrap();
        assert_ne!(after, bundled, "edited grammar must change combined hash");
    }

    #[test]
    fn multi_file_partial_install_treated_as_first_run() {
        // If one of our extra files vanishes between seedings, the
        // hash function returns None and the seed re-emits the
        // missing file rather than warning about drift.
        let dir = tempfile::tempdir().unwrap();
        let plugin = synth_grammar_plugin(
            "lang-test-partial",
            r#"{"name":"lang-test-partial","display_name":"Test","version":"1.0.0","description":"d","kind":"language-grammar","operations":[]}"#,
            r#"{"scopeName":"source.test","patterns":[]}"#,
        );

        let plugin_dir = dir.path().join(plugin.name);
        write_plugin_files(&plugin_dir, plugin, &plugin_dir.join(".version")).unwrap();
        std::fs::remove_file(plugin_dir.join("grammars/test.tmLanguage.json")).unwrap();

        assert!(on_disk_content_hash(plugin, &plugin_dir).is_none());
    }

    #[test]
    fn first_run_detection_for_declarative_plugin() {
        // is_first_run for declarative plugins should be true when
        // none of the owned extras exist and false once any do.
        let dir = tempfile::tempdir().unwrap();
        let plugin = synth_grammar_plugin(
            "lang-test-fresh",
            r#"{"name":"lang-test-fresh","display_name":"Test","version":"1.0.0","description":"d","kind":"language-grammar","operations":[]}"#,
            r#"{"scopeName":"source.test","patterns":[]}"#,
        );

        let plugin_dir = dir.path().join(plugin.name);
        std::fs::create_dir_all(&plugin_dir).unwrap();
        assert!(is_first_run(plugin, &plugin_dir));

        // Once a grammar file exists on disk, it's no longer a
        // first run.
        std::fs::create_dir_all(plugin_dir.join("grammars")).unwrap();
        std::fs::write(plugin_dir.join("grammars/test.tmLanguage.json"), "{}").unwrap();
        assert!(!is_first_run(plugin, &plugin_dir));
    }

    #[test]
    fn bundled_lang_nix_seeds_grammar_file() {
        // Regression guard for the bundled language-grammar plugin.
        // The seeding path must materialize both `plugin.json` and
        // the grammar file, with the content hash covering all of
        // it so future drift detection works.
        let dir = tempfile::tempdir().unwrap();
        let warnings = seed_bundled_plugins(dir.path());
        let lang_warnings: Vec<_> = warnings.iter().filter(|w| w.contains("lang-nix")).collect();
        assert!(
            lang_warnings.is_empty(),
            "lang-nix must seed cleanly: {lang_warnings:?}"
        );

        let plugin_dir = dir.path().join("lang-nix");
        assert!(plugin_dir.join("plugin.json").exists());
        assert!(plugin_dir.join("grammars/nix.tmLanguage.json").exists());
        assert!(
            !plugin_dir.join("init.lua").exists(),
            "grammar plugins must not write init.lua"
        );
        assert!(plugin_dir.join(".content_hash").exists());

        let bundled = BUNDLED_PLUGINS
            .iter()
            .find(|p| p.name == "lang-nix")
            .unwrap();
        let stamped = std::fs::read_to_string(plugin_dir.join(".content_hash"))
            .unwrap()
            .trim()
            .to_string();
        assert_eq!(stamped, bundled_content_hash(bundled));
    }

    #[test]
    fn single_file_plugin_hash_equals_legacy_format() {
        // Backwards-compatibility guarantee: single-init.lua
        // plugins MUST produce a hash matching the pre-multi-file
        // format (sha256 of init.lua bytes). Otherwise existing
        // installs would all show as "drifted" on first run.
        let plugin = BUNDLED_PLUGINS.iter().find(|p| p.name == "github").unwrap();
        let init = plugin.init_lua.unwrap();
        assert_eq!(bundled_content_hash(plugin), sha256_hex(init));
    }
}
