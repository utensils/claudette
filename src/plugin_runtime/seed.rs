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

/// Seed bundled plugins into the plugin directory.
///
/// For each built-in plugin:
/// - If not present: write all files + `.version`
/// - If present but outdated: overwrite only if user hasn't modified `init.lua`
/// - If present and current: do nothing
pub fn seed_bundled_plugins(plugin_dir: &Path) -> Vec<String> {
    let mut warnings = Vec::new();

    for (name, plugin_json, init_lua) in BUNDLED_PLUGINS {
        let dir = plugin_dir.join(name);
        let version_file = dir.join(".version");
        let init_file = dir.join("init.lua");
        let manifest_file = dir.join("plugin.json");

        if !version_file.exists() {
            // First run: seed everything
            if let Err(e) = std::fs::create_dir_all(&dir) {
                warnings.push(format!(
                    "Failed to create plugin dir {}: {e}",
                    dir.display()
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
                warnings.push(format!("Failed to seed plugin '{name}': {e}"));
            }
            continue;
        }

        // Check if the plugin needs updating
        let existing_version = std::fs::read_to_string(&version_file).unwrap_or_default();
        let existing_version = existing_version.trim();

        if !version_is_older(existing_version, APP_VERSION) {
            // Plugin is current or newer — skip
            continue;
        }

        // Version is older — check if user has modified init.lua
        if init_file.exists() {
            let on_disk = std::fs::read_to_string(&init_file).unwrap_or_default();
            let embedded_hash = sha256_hex(init_lua);
            let disk_hash = sha256_hex(&on_disk);

            if embedded_hash != disk_hash {
                warnings.push(format!(
                    "Plugin '{name}' has user modifications — skipping update. \
                     Delete {} to force update.",
                    version_file.display()
                ));
                continue;
            }
        }

        // Unmodified — safe to overwrite
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

/// Simple semver comparison: returns true if `existing` < `target`.
/// Only compares major.minor.patch numeric components.
fn version_is_older(existing: &str, target: &str) -> bool {
    let parse = |v: &str| -> (u32, u32, u32) {
        let parts: Vec<&str> = v.split('.').collect();
        let major = parts.first().and_then(|s| s.parse().ok()).unwrap_or(0);
        let minor = parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);
        let patch = parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
        (major, minor, patch)
    };
    parse(existing) < parse(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_version_comparison() {
        assert!(version_is_older("0.8.0", "0.9.0"));
        assert!(version_is_older("0.9.0", "0.10.0"));
        assert!(version_is_older("0.9.0", "1.0.0"));
        assert!(!version_is_older("0.9.0", "0.9.0"));
        assert!(!version_is_older("1.0.0", "0.9.0"));
        assert!(!version_is_older("0.10.0", "0.9.0"));
    }

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
    }

    #[test]
    fn test_seed_skips_current_version() {
        let dir = tempfile::tempdir().unwrap();
        let plugin_dir = dir.path();

        // Seed once
        seed_bundled_plugins(plugin_dir);

        // Modify init.lua
        let init_path = plugin_dir.join("github/init.lua");
        std::fs::write(&init_path, "-- user modified").unwrap();

        // Seed again — should skip because version matches
        let warnings = seed_bundled_plugins(plugin_dir);
        assert!(warnings.is_empty());

        // User modifications should be preserved
        let content = std::fs::read_to_string(&init_path).unwrap();
        assert_eq!(content, "-- user modified");
    }

    #[test]
    fn test_seed_preserves_user_modifications_on_upgrade() {
        let dir = tempfile::tempdir().unwrap();
        let plugin_dir = dir.path();

        // Seed once
        seed_bundled_plugins(plugin_dir);

        // Simulate an older version and user modification
        std::fs::write(plugin_dir.join("github/.version"), "0.0.1").unwrap();
        std::fs::write(plugin_dir.join("github/init.lua"), "-- user modified").unwrap();

        // Seed again — should warn about user modifications
        let warnings = seed_bundled_plugins(plugin_dir);
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("user modifications"));

        // User modifications should be preserved
        let content = std::fs::read_to_string(plugin_dir.join("github/init.lua")).unwrap();
        assert_eq!(content, "-- user modified");
    }

    #[test]
    fn test_seed_overwrites_unmodified_on_upgrade() {
        let dir = tempfile::tempdir().unwrap();
        let plugin_dir = dir.path();

        // Seed once
        seed_bundled_plugins(plugin_dir);

        // Simulate an older version but keep init.lua unmodified
        std::fs::write(plugin_dir.join("github/.version"), "0.0.1").unwrap();

        // Seed again — should update silently
        let warnings = seed_bundled_plugins(plugin_dir);
        // Only GitLab might warn if it's also modified, but github should update fine
        let github_warnings: Vec<_> = warnings.iter().filter(|w| w.contains("github")).collect();
        assert!(github_warnings.is_empty());

        // Version should be updated
        let version = std::fs::read_to_string(plugin_dir.join("github/.version")).unwrap();
        assert_eq!(version, APP_VERSION);
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
