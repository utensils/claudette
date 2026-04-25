use std::path::Path;

use sha2::{Digest, Sha256};

/// Embedded plugin files. Each tuple is (name, plugin_json, init_lua).
const BUNDLED_PLUGINS: &[(&str, &str, &str)] = &[
    (
        "github",
        include_str!("../../plugins/scm-github/plugin.json"),
        include_str!("../../plugins/scm-github/init.lua"),
    ),
    (
        "gitlab",
        include_str!("../../plugins/scm-gitlab/plugin.json"),
        include_str!("../../plugins/scm-gitlab/init.lua"),
    ),
    (
        "env-direnv",
        include_str!("../../plugins/env-direnv/plugin.json"),
        include_str!("../../plugins/env-direnv/init.lua"),
    ),
    (
        "env-mise",
        include_str!("../../plugins/env-mise/plugin.json"),
        include_str!("../../plugins/env-mise/init.lua"),
    ),
    (
        "env-dotenv",
        include_str!("../../plugins/env-dotenv/plugin.json"),
        include_str!("../../plugins/env-dotenv/init.lua"),
    ),
    (
        "env-nix-devshell",
        include_str!("../../plugins/env-nix-devshell/plugin.json"),
        include_str!("../../plugins/env-nix-devshell/init.lua"),
    ),
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
/// 1. No `init.lua` on disk (fresh install) → write everything.
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

    for (name, plugin_json, init_lua) in BUNDLED_PLUGINS {
        let dir = plugin_dir.join(name);
        let version_file = dir.join(".version");
        let init_file = dir.join("init.lua");
        let manifest_file = dir.join("plugin.json");
        let hash_file = dir.join(".content_hash");

        if let Err(e) = std::fs::create_dir_all(&dir) {
            warnings.push(format!(
                "Failed to create plugin dir {}: {e}",
                dir.display()
            ));
            continue;
        }

        // First-run path: nothing to preserve, write it all.
        if !init_file.exists() {
            if let Err(e) = write_plugin_files(
                &manifest_file,
                plugin_json,
                &init_file,
                init_lua,
                &version_file,
            ) {
                warnings.push(format!("Failed to seed plugin '{name}': {e}"));
            }
            continue;
        }

        let on_disk = std::fs::read_to_string(&init_file).unwrap_or_default();
        let on_disk_hash = sha256_hex(&on_disk);
        let bundled_hash = sha256_hex(init_lua);

        // Init.lua matches bundle → no code change needed. But the
        // manifest (`plugin.json`) can drift independently of the
        // Lua body — new `operations`, an updated settings schema,
        // a renamed `display_name`. Refresh the manifest (and the
        // `.version` stamp) so `PluginRegistry::discover` always
        // sees current metadata even when the code body is stable.
        //
        // Also top up `.content_hash` for legacy installs that
        // predate hash stamping, so future drift detection works.
        if on_disk_hash == bundled_hash {
            if !hash_file.exists()
                && let Err(e) = std::fs::write(&hash_file, &bundled_hash)
            {
                warnings.push(format!(
                    "Plugin '{name}': failed to write content hash stamp: {e}"
                ));
            }
            if let Err(e) = refresh_manifest_if_changed(&manifest_file, plugin_json) {
                warnings.push(format!("Plugin '{name}': manifest refresh failed: {e}"));
            }
            let current_version = std::fs::read_to_string(&version_file)
                .unwrap_or_default()
                .trim()
                .to_string();
            if current_version != APP_VERSION
                && let Err(e) = std::fs::write(&version_file, APP_VERSION)
            {
                warnings.push(format!("Plugin '{name}': .version refresh failed: {e}"));
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
                "Plugin '{name}' has user modifications — skipping update. \
                 Use 'Reload bundled plugins' in Settings to force."
            ));
            continue;
        }

        if let Err(e) = write_plugin_files(
            &manifest_file,
            plugin_json,
            &init_file,
            init_lua,
            &version_file,
        ) {
            warnings.push(format!("Failed to update plugin '{name}': {e}"));
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
/// Preserves user-modified `init.lua` files by comparing SHA-256
/// hashes — if the on-disk content doesn't match *any* content the
/// bundled seed function has ever written, we skip that plugin and
/// return a warning so the user sees why it wasn't updated.
pub fn reseed_bundled_plugins_force(plugin_dir: &Path) -> Vec<String> {
    let mut warnings = Vec::new();

    for (name, plugin_json, init_lua) in BUNDLED_PLUGINS {
        let dir = plugin_dir.join(name);
        let init_file = dir.join("init.lua");
        let manifest_file = dir.join("plugin.json");
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
        // 1. No `.version` at all + `init.lua` exists → user created
        //    this plugin directory; never touch.
        // 2. `.content_hash` exists + matches the on-disk init.lua →
        //    this is the content we last wrote; safe to overwrite
        //    (the current embed may differ from the stored hash,
        //    which is exactly the stale-seeded case reseed is for).
        // 3. `.content_hash` exists + differs from the on-disk
        //    init.lua → user customized it after we seeded; preserve.
        // 4. `.content_hash` missing + `.version` present (legacy
        //    install predating hash-stamping): fall back to hashing
        //    against the current embed. This restores the pre-hash
        //    behavior for existing installs without clobbering
        //    customizations.
        let has_version_stamp = version_file.exists();
        if init_file.exists() && !has_version_stamp {
            warnings.push(format!(
                "Plugin '{name}': no .version file — directory appears user-created, skipping. \
                 Delete {} to force a reseed.",
                dir.display()
            ));
            continue;
        }

        if init_file.exists() {
            let on_disk = std::fs::read_to_string(&init_file).unwrap_or_default();
            let on_disk_hash = sha256_hex(&on_disk);
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
                sha256_hex(init_lua) != on_disk_hash && !on_disk.is_empty()
            };
            if preserved_as_user_edit {
                warnings.push(format!(
                    "Plugin '{name}': init.lua has user modifications — skipping update. \
                     Delete {} to force a reseed.",
                    dir.display()
                ));
                continue;
            }
        }

        if let Err(e) = write_plugin_files(
            &manifest_file,
            plugin_json,
            &init_file,
            init_lua,
            &version_file,
        ) {
            warnings.push(format!("Failed to reseed plugin '{name}': {e}"));
        }
    }

    warnings
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

fn write_plugin_files(
    manifest_path: &Path,
    manifest_content: &str,
    init_path: &Path,
    init_content: &str,
    version_path: &Path,
) -> std::io::Result<()> {
    std::fs::write(manifest_path, manifest_content)?;
    std::fs::write(init_path, init_content)?;
    std::fs::write(version_path, APP_VERSION)?;
    // Stamp the content hash alongside .version so reseed can later
    // detect whether the on-disk `init.lua` is still what we wrote
    // (regardless of which Claudette version wrote it). Mismatch
    // between this stamp and the on-disk hash means the user has
    // customized the file, so force-reseed preserves it.
    let hash_path = version_path.with_file_name(".content_hash");
    std::fs::write(hash_path, sha256_hex(init_content))?;
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
        let bundled_github_init = BUNDLED_PLUGINS
            .iter()
            .find(|(n, _, _)| *n == "github")
            .map(|(_, _, lua)| *lua)
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(&hash_path).unwrap().trim(),
            sha256_hex(bundled_github_init),
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
            .find(|(n, _, _)| *n == "github")
            .map(|(_, pjson, _)| *pjson)
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
        let bundled_github_init = BUNDLED_PLUGINS
            .iter()
            .find(|(n, _, _)| *n == "github")
            .map(|(_, _, lua)| *lua)
            .unwrap();
        std::fs::write(plugin_subdir.join(".version"), "0.0.1").unwrap();
        std::fs::write(plugin_subdir.join("init.lua"), bundled_github_init).unwrap();
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
        assert_eq!(stamped.trim(), sha256_hex(bundled_github_init));
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
}
