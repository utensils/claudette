//! Installer for community contributions.
//!
//! Takes a tarball (gzipped tar bytes) of `claudette-community` at
//! `source.sha`, extracts only the files under the contribution's
//! `path`, verifies the content hash against the registry's
//! `sha256`, writes an `.install_meta.json`, and atomically moves the
//! result into place under `~/.claudette/{plugins,themes}/<ident>/`.
//!
//! The fetch step is intentionally not in this module — `reqwest`
//! lives in `claudette-tauri` per the existing dep split. Callers
//! download the tarball bytes and pass them in.
//!
//! Cross-platform safety:
//!
//! - **Path traversal:** entries whose path contains `..` or starts
//!   with `/` are rejected. The `tar` crate doesn't strip these by
//!   default — the install would otherwise let a malicious tarball
//!   write outside the staging dir.
//! - **Symlinks:** rejected. Same rationale as in [`super::verify`].
//! - **Atomic move:** extraction happens in a sibling temp dir under
//!   the install root, then `rename`d into place. If extraction or
//!   verification fails, the partial dir is dropped and the previous
//!   install (if any) is untouched.

use std::collections::HashSet;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use flate2::read::GzDecoder;

use super::types::{ContributionKind, ContributionSource, InstallSource, InstalledMeta};
use super::verify::{self, VerifyError};

#[derive(Debug)]
pub enum InstallError {
    Io {
        path: String,
        source: std::io::Error,
    },
    BadTarball(String),
    Traversal(String),
    Symlink(String),
    PathNotInTarball {
        expected: String,
        prefix: String,
        found: usize,
    },
    /// A directory already exists at the target install path and was
    /// not installed by the community registry (no `.install_meta.json`
    /// with `source = "community"`). Refusing to overwrite avoids
    /// silently destroying a user's hand-installed plugin or a
    /// bundled-then-customized one.
    TargetExists {
        path: String,
    },
    Verify(VerifyError),
    MetaJson(serde_json::Error),
}

impl std::fmt::Display for InstallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io { path, source } => write!(f, "io error at {path}: {source}"),
            Self::BadTarball(msg) => write!(f, "malformed tarball: {msg}"),
            Self::Traversal(p) => write!(f, "path traversal in tarball entry: {p}"),
            Self::Symlink(p) => write!(f, "symlink in tarball entry: {p}"),
            Self::PathNotInTarball {
                expected,
                prefix,
                found,
            } => write!(
                f,
                "contribution path {expected} not found in tarball — found {found} entries with prefix {prefix}"
            ),
            Self::TargetExists { path } => write!(
                f,
                "{path} already exists and was not installed via the community registry — \
                 remove it manually first if you want to replace it"
            ),
            Self::Verify(e) => write!(f, "content verification failed: {e}"),
            Self::MetaJson(e) => write!(f, "could not serialize install metadata: {e}"),
        }
    }
}

impl std::error::Error for InstallError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            Self::Verify(e) => Some(e),
            Self::MetaJson(e) => Some(e),
            _ => None,
        }
    }
}

impl From<VerifyError> for InstallError {
    fn from(e: VerifyError) -> Self {
        Self::Verify(e)
    }
}

impl From<serde_json::Error> for InstallError {
    fn from(e: serde_json::Error) -> Self {
        Self::MetaJson(e)
    }
}

/// Plan describing where to install a contribution and what to verify.
#[derive(Debug, Clone)]
pub struct InstallPlan {
    pub kind: ContributionKind,
    /// Directory name on disk — theme `id` or plugin `name`.
    pub ident: String,
    pub source: ContributionSource,
    /// Manifest version at registry-snapshot time.
    pub version: String,
    /// `required_clis` snapshot for capability re-consent on update.
    pub granted_capabilities: Vec<String>,
    /// `Registry.source.sha` — recorded in metadata for the regen flow.
    pub registry_sha: String,
}

/// Where contributions live under `~/.claudette/`.
#[derive(Debug, Clone)]
pub struct InstallRoots {
    pub plugins_dir: PathBuf,
    pub themes_dir: PathBuf,
}

impl InstallRoots {
    /// Resolve the standard install roots (`~/.claudette/plugins/` and
    /// `~/.claudette/themes/`). Returns `None` if `dirs::home_dir()`
    /// fails (extremely rare; only on broken systems).
    pub fn from_home() -> Option<Self> {
        let home = dirs::home_dir()?;
        let base = home.join(".claudette");
        Some(Self {
            plugins_dir: base.join("plugins"),
            themes_dir: base.join("themes"),
        })
    }

    pub fn target_for(&self, plan: &InstallPlan) -> PathBuf {
        match plan.kind {
            ContributionKind::Theme => self.themes_dir.join(&plan.ident),
            ContributionKind::Plugin(_) => self.plugins_dir.join(&plan.ident),
        }
    }

    fn parent_for(&self, plan: &InstallPlan) -> &Path {
        match plan.kind {
            ContributionKind::Theme => &self.themes_dir,
            ContributionKind::Plugin(_) => &self.plugins_dir,
        }
    }
}

/// Install a contribution from gzipped tar bytes.
///
/// `tarball_gz` is the *full* `claudette-community` repo archive at
/// `source.sha` (i.e. the `codeload.github.com/.../tar.gz/<sha>` body).
/// The installer extracts only files under the contribution's path,
/// verifies the content hash, writes metadata, and atomically moves
/// into place under `roots`.
///
/// Returns the final install path on success.
pub fn install(
    plan: &InstallPlan,
    tarball_gz: &[u8],
    roots: &InstallRoots,
) -> Result<PathBuf, InstallError> {
    let target = roots.target_for(plan);
    let parent = roots.parent_for(plan);
    std::fs::create_dir_all(parent).map_err(|e| InstallError::Io {
        path: parent.display().to_string(),
        source: e,
    })?;

    // Stage in a sibling temp dir under the install root so the
    // atomic rename below stays on the same filesystem.
    let staging = tempfile::Builder::new()
        .prefix(&format!(".community-install-{}-", plan.ident))
        .tempdir_in(parent)
        .map_err(|e| InstallError::Io {
            path: parent.display().to_string(),
            source: e,
        })?;
    let staging_dir = staging.path().to_path_buf();

    let contribution_path = match &plan.source {
        ContributionSource::InTree { path, .. } => path.clone(),
        ContributionSource::External { .. } => String::new(), // mirror tarballs are pre-rooted
    };

    extract_subtree(tarball_gz, &contribution_path, &staging_dir)?;

    // Verify content hash before publishing.
    verify::verify(&staging_dir, plan.source.sha256())?;

    // Write the install metadata sidecar.
    write_install_meta(&staging_dir, plan)?;

    // If a previous install exists, only replace it when we know we
    // installed it ourselves. A user could have a hand-installed or
    // bundled plugin at the same path; silently removing it would be
    // destructive. The metadata sidecar is the marker — if it's
    // missing, or its source is anything other than Community, refuse.
    if target.exists() {
        let existing_meta = read_install_meta(&target).ok().flatten();
        let is_ours = matches!(existing_meta, Some(ref m) if m.source == InstallSource::Community);
        if !is_ours {
            return Err(InstallError::TargetExists {
                path: target.display().to_string(),
            });
        }
        std::fs::remove_dir_all(&target).map_err(|e| InstallError::Io {
            path: target.display().to_string(),
            source: e,
        })?;
    }

    // Atomic move — same filesystem because both staging and target
    // live under the same install root.
    std::fs::rename(&staging_dir, &target).map_err(|e| InstallError::Io {
        path: target.display().to_string(),
        source: e,
    })?;
    // We've moved staging out from under the TempDir guard; consume it
    // explicitly so the Drop-time cleanup doesn't try to remove a path
    // that's now elsewhere.
    let _ = staging.keep();

    Ok(target)
}

/// Remove a previously-installed contribution. No-op if not present.
pub fn uninstall(
    plan_kind: ContributionKind,
    ident: &str,
    roots: &InstallRoots,
) -> std::io::Result<()> {
    let target = match plan_kind {
        ContributionKind::Theme => roots.themes_dir.join(ident),
        ContributionKind::Plugin(_) => roots.plugins_dir.join(ident),
    };
    if !target.exists() {
        return Ok(());
    }
    std::fs::remove_dir_all(&target)
}

/// Read the `.install_meta.json` for an installed contribution, if
/// present. Returns `Ok(None)` if the file doesn't exist (the
/// contribution was hand-edited in or pre-dates the registry).
pub fn read_install_meta(install_dir: &Path) -> Result<Option<InstalledMeta>, InstallError> {
    let meta_path = install_dir.join(".install_meta.json");
    if !meta_path.exists() {
        return Ok(None);
    }
    let bytes = std::fs::read(&meta_path).map_err(|e| InstallError::Io {
        path: meta_path.display().to_string(),
        source: e,
    })?;
    let meta: InstalledMeta = serde_json::from_slice(&bytes)?;
    Ok(Some(meta))
}

fn write_install_meta(staging_dir: &Path, plan: &InstallPlan) -> Result<(), InstallError> {
    let meta = InstalledMeta {
        source: InstallSource::Community,
        kind: plan.kind.wire(),
        registry_sha: plan.registry_sha.clone(),
        contribution_sha: plan.source.sha().to_string(),
        sha256: plan.source.sha256().to_string(),
        installed_at: now_iso8601(),
        granted_capabilities: plan.granted_capabilities.clone(),
        version: plan.version.clone(),
    };
    let bytes = serde_json::to_vec_pretty(&meta)?;
    let path = staging_dir.join(".install_meta.json");
    std::fs::write(&path, bytes).map_err(|e| InstallError::Io {
        path: path.display().to_string(),
        source: e,
    })?;
    Ok(())
}

fn now_iso8601() -> String {
    // Avoid pulling in chrono; format SystemTime via a small helper.
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format_iso8601(secs)
}

fn format_iso8601(secs: u64) -> String {
    // Convert epoch seconds to ISO-8601 UTC. We only need a stable
    // representation; second precision is fine for install records.
    // Algorithm: civil-from-days (Howard Hinnant) — proleptic
    // Gregorian, no calendar quirks.
    let days = (secs / 86_400) as i64;
    let secs_of_day = (secs % 86_400) as u32;
    let (y, m, d) = civil_from_days(days);
    let h = secs_of_day / 3600;
    let mi = (secs_of_day % 3600) / 60;
    let s = secs_of_day % 60;
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 {
        z / 146_097
    } else {
        (z - 146_096) / 146_097
    };
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m as u32, d as u32)
}

fn extract_subtree(
    tarball_gz: &[u8],
    contribution_path: &str,
    out_dir: &Path,
) -> Result<(), InstallError> {
    let gz = GzDecoder::new(tarball_gz);
    let mut archive = tar::Archive::new(gz);
    archive.set_preserve_permissions(false);
    archive.set_preserve_mtime(false);

    // codeload.github.com tarballs nest everything under
    //   <repo>-<short-sha>/<original-paths>
    // We don't know the prefix ahead of time; sniff it from the
    // first non-pax-header entry.
    let mut prefix: Option<String> = None;
    // Set when any entry inside `contribution_path` is staged — file
    // OR directory. Distinct from "did we write file bytes?" because a
    // contribution may legitimately be a directory tree of all-empty
    // sub-directories or only contain files via nested dirs whose
    // first hit is the dir entry itself.
    let mut matched_any = false;
    let mut prefix_match_count = 0usize;

    let mut all_entries: Vec<(String, Vec<u8>, bool)> = Vec::new();
    for entry in archive
        .entries()
        .map_err(|e| InstallError::BadTarball(e.to_string()))?
    {
        let mut entry = entry.map_err(|e| InstallError::BadTarball(e.to_string()))?;
        let header_path = entry
            .path()
            .map_err(|e| InstallError::BadTarball(e.to_string()))?;
        let path_str = header_path.to_string_lossy().replace('\\', "/");
        if path_str.is_empty() || path_str == "pax_global_header" {
            continue;
        }

        // Reject traversal up-front. `Component::ParentDir` is the
        // fatal one; absolute paths just get stripped to relative.
        for c in header_path.components() {
            if matches!(c, Component::ParentDir) {
                return Err(InstallError::Traversal(path_str));
            }
        }

        let entry_type = entry.header().entry_type();

        // Sniff the codeload prefix from the first directory entry.
        if prefix.is_none()
            && let Some(first_segment) = path_str.split('/').next()
            && !first_segment.is_empty()
        {
            prefix = Some(format!("{first_segment}/"));
        }

        let inside_prefix = prefix.as_ref().is_some_and(|p| path_str.starts_with(p));
        if inside_prefix {
            prefix_match_count += 1;
        }

        // Trim the codeload prefix.
        let stripped = match prefix.as_ref() {
            Some(p) if path_str.starts_with(p) => &path_str[p.len()..],
            _ => path_str.as_str(),
        };

        // Path-filter to the requested subtree. Anything outside the
        // contribution's path (including symlinks at the repo root
        // like AGENTS.md → CLAUDE.md) is silently skipped — its
        // presence in the tarball is not our problem because we
        // never write it.
        if !contribution_path.is_empty() {
            let want = format!("{contribution_path}/");
            if !stripped.starts_with(&want) && stripped != contribution_path {
                continue;
            }
        }
        // Re-root onto the contribution's path so the staging dir
        // mirrors the contribution's own directory layout.
        let rel = if !contribution_path.is_empty() && stripped.starts_with(contribution_path) {
            let after = &stripped[contribution_path.len()..];
            after.trim_start_matches('/').to_string()
        } else {
            stripped.to_string()
        };
        if rel.is_empty() {
            // The contribution directory itself — nothing to write,
            // but the subtree exists so flag it for the
            // PathNotInTarball check below.
            matched_any = true;
            continue;
        }

        // Reject special entries that fall *inside* the subtree we're
        // about to extract. Symlinks and hardlinks could redirect to
        // arbitrary paths outside `out_dir` once Claudette later
        // reads the installed files; safer to refuse the install
        // than to follow. Symlinks elsewhere in the tarball are fine
        // because we already filtered them out above.
        if entry_type.is_symlink() || entry_type.is_hard_link() {
            return Err(InstallError::Symlink(stripped.into()));
        }

        // Defense in depth: rel must be relative + not contain `..`.
        let rel_path = Path::new(&rel);
        if rel_path.is_absolute()
            || rel_path
                .components()
                .any(|c| matches!(c, Component::ParentDir))
        {
            return Err(InstallError::Traversal(rel));
        }

        if entry_type.is_dir() {
            all_entries.push((rel, Vec::new(), true));
            matched_any = true;
            continue;
        }
        if !entry_type.is_file() {
            // Skip char/block devices, fifos, etc.
            continue;
        }

        let mut bytes = Vec::with_capacity(entry.header().size().unwrap_or(0) as usize);
        entry
            .read_to_end(&mut bytes)
            .map_err(|e| InstallError::BadTarball(e.to_string()))?;
        all_entries.push((rel, bytes, false));
        matched_any = true;
    }

    if !matched_any && !contribution_path.is_empty() {
        return Err(InstallError::PathNotInTarball {
            expected: contribution_path.into(),
            prefix: prefix.unwrap_or_default(),
            found: prefix_match_count,
        });
    }

    // Write to staging.
    let mut dirs_created: HashSet<PathBuf> = HashSet::new();
    for (rel, bytes, is_dir) in all_entries {
        let dst = out_dir.join(&rel);
        if is_dir {
            ensure_dir(&dst, &mut dirs_created)?;
            continue;
        }
        if let Some(parent) = dst.parent() {
            ensure_dir(parent, &mut dirs_created)?;
        }
        std::fs::write(&dst, &bytes).map_err(|e| InstallError::Io {
            path: dst.display().to_string(),
            source: e,
        })?;
    }
    Ok(())
}

fn ensure_dir(p: &Path, seen: &mut HashSet<PathBuf>) -> Result<(), InstallError> {
    if seen.contains(p) {
        return Ok(());
    }
    std::fs::create_dir_all(p).map_err(|e| InstallError::Io {
        path: p.display().to_string(),
        source: e,
    })?;
    seen.insert(p.to_path_buf());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::community::types::{ContributionKind, PluginKindWire};
    use flate2::Compression;
    use flate2::write::GzEncoder;
    use std::io::Write;
    use tempfile::tempdir;

    /// Build a minimal codeload-shaped gzipped tarball for testing.
    /// `prefix` is the codeload-style root dir (e.g. `claudette-community-abc123/`).
    /// `entries` is a slice of `(path, bytes)` pairs *relative* to
    /// the prefix.
    fn make_tarball(prefix: &str, entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut tar_bytes = Vec::new();
        {
            let gz = GzEncoder::new(&mut tar_bytes, Compression::fast());
            let mut builder = tar::Builder::new(gz);
            for (path, data) in entries {
                let mut header = tar::Header::new_gnu();
                header.set_size(data.len() as u64);
                header.set_mode(0o644);
                header.set_cksum();
                builder
                    .append_data(&mut header, format!("{prefix}{path}"), *data)
                    .unwrap();
            }
            builder.finish().unwrap();
            // Drop the builder + gz so they flush.
        }
        tar_bytes
    }

    fn make_plan(ident: &str, sha256: &str) -> InstallPlan {
        InstallPlan {
            kind: ContributionKind::Plugin(PluginKindWire::LanguageGrammar),
            ident: ident.into(),
            source: ContributionSource::InTree {
                path: format!("plugins/language-grammars/{ident}"),
                sha: "1111111111111111111111111111111111111111".into(),
                sha256: sha256.into(),
            },
            version: "1.0.0".into(),
            granted_capabilities: vec![],
            registry_sha: "2222222222222222222222222222222222222222".into(),
        }
    }

    fn make_roots() -> (tempfile::TempDir, InstallRoots) {
        let tmp = tempdir().unwrap();
        let roots = InstallRoots {
            plugins_dir: tmp.path().join("plugins"),
            themes_dir: tmp.path().join("themes"),
        };
        (tmp, roots)
    }

    #[test]
    fn extracts_subtree_and_strips_codeload_prefix() {
        let tarball = make_tarball(
            "claudette-community-abcdef/",
            &[
                (
                    "plugins/language-grammars/lang-foo/plugin.json",
                    b"{}" as &[u8],
                ),
                (
                    "plugins/language-grammars/lang-foo/grammars/foo.json",
                    b"[]",
                ),
                ("plugins/scm/other/plugin.json", b"{}"), // should be filtered
                ("README.md", b"# x"),                    // should be filtered
            ],
        );
        let tmp = tempdir().unwrap();
        extract_subtree(&tarball, "plugins/language-grammars/lang-foo", tmp.path()).unwrap();
        assert!(tmp.path().join("plugin.json").exists());
        assert!(tmp.path().join("grammars/foo.json").exists());
        assert!(!tmp.path().join("README.md").exists());
        assert!(!tmp.path().join("plugins").exists());
    }

    #[test]
    fn extract_accepts_directory_only_subtree() {
        // A contribution whose tarball entries are only directories
        // (no file bytes) is still a valid match — `matched_any`
        // tracks any in-subtree entry, not just files. Using only
        // file-presence would falsely report PathNotInTarball for an
        // empty-but-existing dir.
        let mut tar_bytes = Vec::new();
        {
            let gz = GzEncoder::new(&mut tar_bytes, Compression::fast());
            let mut builder = tar::Builder::new(gz);
            // Just a directory entry — no files.
            let mut header = tar::Header::new_gnu();
            header.set_size(0);
            header.set_mode(0o755);
            header.set_entry_type(tar::EntryType::Directory);
            header.set_cksum();
            builder
                .append_data(
                    &mut header,
                    "repo/plugins/language-grammars/lang-foo/",
                    &[][..],
                )
                .unwrap();
            builder.finish().unwrap();
        }
        let tmp = tempdir().unwrap();
        let result = extract_subtree(&tar_bytes, "plugins/language-grammars/lang-foo", tmp.path());
        assert!(
            result.is_ok(),
            "directory-only subtree must not error: {result:?}"
        );
    }

    #[test]
    fn install_writes_meta_and_verifies_hash() {
        let payload: &[(&str, &[u8])] = &[
            ("plugins/language-grammars/lang-foo/plugin.json", b"{}"),
            ("plugins/language-grammars/lang-foo/grammar.json", b"[]"),
        ];
        let tarball = make_tarball("repo-abc/", payload);

        // Compute the expected sha256 by extracting once into a
        // throwaway dir and hashing.
        let probe = tempdir().unwrap();
        extract_subtree(&tarball, "plugins/language-grammars/lang-foo", probe.path()).unwrap();
        let expected = verify::content_hash(probe.path()).unwrap();

        let plan = make_plan("lang-foo", &expected);
        let (_tmp_root, roots) = make_roots();
        let target = install(&plan, &tarball, &roots).unwrap();

        assert_eq!(target, roots.plugins_dir.join("lang-foo"));
        assert!(target.join("plugin.json").exists());
        assert!(target.join("grammar.json").exists());
        assert!(target.join(".install_meta.json").exists());

        let meta = read_install_meta(&target).unwrap().unwrap();
        assert_eq!(meta.source, InstallSource::Community);
        assert_eq!(meta.sha256, expected);
        assert_eq!(meta.version, "1.0.0");
        // Wire kind round-trips through .install_meta.json so
        // community_list_installed never has to fall back to the
        // manifest at read time.
        assert_eq!(meta.kind, "plugin:language-grammar");
    }

    #[test]
    fn install_rejects_hash_mismatch() {
        let payload: &[(&str, &[u8])] =
            &[("plugins/language-grammars/lang-foo/plugin.json", b"{}")];
        let tarball = make_tarball("repo-abc/", payload);

        let plan = make_plan("lang-foo", &"0".repeat(64));
        let (_tmp_root, roots) = make_roots();
        let err = install(&plan, &tarball, &roots).unwrap_err();
        assert!(matches!(
            err,
            InstallError::Verify(VerifyError::HashMismatch { .. })
        ));

        // Target should not exist after a failed install.
        assert!(!roots.plugins_dir.join("lang-foo").exists());
    }

    #[test]
    fn install_refuses_to_overwrite_non_community_target() {
        // Pre-existing hand-installed (or bundled-then-customized)
        // plugin with no .install_meta.json — community install must
        // refuse rather than silently destroy the user's work.
        let payload: &[(&str, &[u8])] =
            &[("plugins/language-grammars/lang-foo/plugin.json", b"{}")];
        let tarball = make_tarball("repo-x/", payload);
        let probe = tempdir().unwrap();
        extract_subtree(&tarball, "plugins/language-grammars/lang-foo", probe.path()).unwrap();
        let h = verify::content_hash(probe.path()).unwrap();

        let plan = make_plan("lang-foo", &h);
        let (_tmp_root, roots) = make_roots();

        // Place a pre-existing directory at the target — no install meta.
        std::fs::create_dir_all(roots.plugins_dir.join("lang-foo")).unwrap();
        std::fs::write(
            roots.plugins_dir.join("lang-foo/handcrafted.lua"),
            b"-- user's own plugin",
        )
        .unwrap();

        let err = install(&plan, &tarball, &roots).unwrap_err();
        assert!(
            matches!(err, InstallError::TargetExists { .. }),
            "expected TargetExists, got {err:?}"
        );

        // The user's file must be untouched.
        let preserved = std::fs::read(roots.plugins_dir.join("lang-foo/handcrafted.lua")).unwrap();
        assert_eq!(preserved, b"-- user's own plugin");
    }

    #[test]
    fn install_replaces_previous_community_install_atomically() {
        // The replace path still works when the existing install
        // *was* placed by the community registry — i.e. has a valid
        // .install_meta.json with source: community. (Renamed from
        // install_replaces_previous_atomically; the old name implied
        // we'd replace anything at the path which is no longer true.)
        // Install once, verify the file. Install again with different
        // content, verify the new file replaced it.
        let v1 = make_tarball(
            "repo-1/",
            &[("plugins/language-grammars/lang-foo/file.txt", b"v1")],
        );
        let v2 = make_tarball(
            "repo-2/",
            &[("plugins/language-grammars/lang-foo/file.txt", b"v2")],
        );

        let probe1 = tempdir().unwrap();
        extract_subtree(&v1, "plugins/language-grammars/lang-foo", probe1.path()).unwrap();
        let h1 = verify::content_hash(probe1.path()).unwrap();
        let probe2 = tempdir().unwrap();
        extract_subtree(&v2, "plugins/language-grammars/lang-foo", probe2.path()).unwrap();
        let h2 = verify::content_hash(probe2.path()).unwrap();
        assert_ne!(h1, h2);

        let (_tmp_root, roots) = make_roots();
        let p1 = make_plan("lang-foo", &h1);
        install(&p1, &v1, &roots).unwrap();
        assert_eq!(
            std::fs::read(roots.plugins_dir.join("lang-foo/file.txt")).unwrap(),
            b"v1"
        );
        let p2 = make_plan("lang-foo", &h2);
        install(&p2, &v2, &roots).unwrap();
        assert_eq!(
            std::fs::read(roots.plugins_dir.join("lang-foo/file.txt")).unwrap(),
            b"v2"
        );
    }

    #[test]
    fn extract_rejects_path_traversal() {
        // The tar crate's high-level Builder refuses to *write* a path
        // containing `..`, so we have to compose the header bytes
        // directly to exercise our defense-in-depth check on the read
        // path. Using the raw `Header::as_bytes` field setters skips
        // the writer-side guard.
        use tar::Header;
        let mut payload = Vec::<u8>::new();
        let mut header = Header::new_gnu();
        // Manually poke the name field; bypass set_path which validates.
        let name_bytes = b"repo/plugins/foo/../etc/passwd";
        header.as_old_mut().name[..name_bytes.len()].copy_from_slice(name_bytes);
        header.set_size(1);
        header.set_mode(0o644);
        header.set_cksum();
        payload.extend_from_slice(header.as_bytes());
        payload.extend_from_slice(b"x");
        // Pad the file content to a 512-byte block boundary.
        payload.extend_from_slice(&[0u8; 511]);
        // Two zero blocks signal end-of-archive.
        payload.extend_from_slice(&[0u8; 1024]);

        let mut gz_bytes = Vec::new();
        {
            let mut gz = GzEncoder::new(&mut gz_bytes, Compression::fast());
            gz.write_all(&payload).unwrap();
            gz.finish().unwrap();
        }

        let tmp = tempdir().unwrap();
        let err = extract_subtree(&gz_bytes, "plugins/foo", tmp.path()).unwrap_err();
        assert!(matches!(err, InstallError::Traversal(_)), "got {err:?}");
    }

    #[test]
    fn symlink_outside_subtree_is_skipped() {
        // The community repo has AGENTS.md → CLAUDE.md at the root.
        // Installing a contribution under plugins/foo/ must succeed;
        // root-level symlinks are not files we write.
        let payload: &[(&str, &[u8])] = &[
            ("plugins/language-grammars/lang-foo/plugin.json", b"{}"),
            ("plugins/language-grammars/lang-foo/grammars/x.json", b"[]"),
        ];
        let mut tar_bytes = Vec::new();
        {
            let gz = GzEncoder::new(&mut tar_bytes, Compression::fast());
            let mut builder = tar::Builder::new(gz);
            for (path, data) in payload {
                let mut header = tar::Header::new_gnu();
                header.set_size(data.len() as u64);
                header.set_mode(0o644);
                header.set_cksum();
                builder
                    .append_data(&mut header, format!("repo-x/{path}"), *data)
                    .unwrap();
            }
            // Root-level symlink: AGENTS.md -> CLAUDE.md
            let mut sym_header = tar::Header::new_gnu();
            sym_header.set_size(0);
            sym_header.set_mode(0o644);
            sym_header.set_entry_type(tar::EntryType::Symlink);
            sym_header.set_link_name("CLAUDE.md").unwrap();
            sym_header.set_cksum();
            builder
                .append_data(&mut sym_header, "repo-x/AGENTS.md", &[][..])
                .unwrap();
            builder.finish().unwrap();
        }

        let probe = tempdir().unwrap();
        extract_subtree(
            &tar_bytes,
            "plugins/language-grammars/lang-foo",
            probe.path(),
        )
        .unwrap();
        let h = verify::content_hash(probe.path()).unwrap();

        let plan = make_plan("lang-foo", &h);
        let (_tmp_root, roots) = make_roots();
        install(&plan, &tar_bytes, &roots).expect("symlink outside subtree must not block install");
        assert!(roots.plugins_dir.join("lang-foo").exists());
        assert!(!roots.plugins_dir.join("lang-foo/AGENTS.md").exists());
    }

    #[test]
    fn symlink_inside_subtree_is_rejected() {
        // A symlink within the contribution path stays a hard error
        // — once Claudette installs and reads from it, the link could
        // resolve outside the install root.
        let mut tar_bytes = Vec::new();
        {
            let gz = GzEncoder::new(&mut tar_bytes, Compression::fast());
            let mut builder = tar::Builder::new(gz);
            // One real file so the subtree exists.
            let mut header = tar::Header::new_gnu();
            let data: &[u8] = b"{}";
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder
                .append_data(
                    &mut header,
                    "repo-x/plugins/language-grammars/lang-foo/plugin.json",
                    data,
                )
                .unwrap();
            // Malicious symlink inside the subtree.
            let mut sym_header = tar::Header::new_gnu();
            sym_header.set_size(0);
            sym_header.set_mode(0o644);
            sym_header.set_entry_type(tar::EntryType::Symlink);
            sym_header.set_link_name("/etc/passwd").unwrap();
            sym_header.set_cksum();
            builder
                .append_data(
                    &mut sym_header,
                    "repo-x/plugins/language-grammars/lang-foo/sneaky",
                    &[][..],
                )
                .unwrap();
            builder.finish().unwrap();
        }
        let tmp = tempdir().unwrap();
        let err = extract_subtree(&tar_bytes, "plugins/language-grammars/lang-foo", tmp.path())
            .unwrap_err();
        assert!(matches!(err, InstallError::Symlink(_)), "got {err:?}");
    }

    #[test]
    fn missing_subtree_in_tarball_errors_clearly() {
        let tarball = make_tarball("repo-x/", &[("README.md", b"x")]);
        let tmp = tempdir().unwrap();
        let err = extract_subtree(&tarball, "plugins/missing", tmp.path()).unwrap_err();
        match err {
            InstallError::PathNotInTarball { expected, .. } => {
                assert_eq!(expected, "plugins/missing");
            }
            other => panic!("expected PathNotInTarball, got {other:?}"),
        }
    }

    #[test]
    fn uninstall_removes_the_directory() {
        let payload: &[(&str, &[u8])] = &[("plugins/language-grammars/lang-foo/x", b"y")];
        let tarball = make_tarball("r/", payload);
        let probe = tempdir().unwrap();
        extract_subtree(&tarball, "plugins/language-grammars/lang-foo", probe.path()).unwrap();
        let h = verify::content_hash(probe.path()).unwrap();

        let plan = make_plan("lang-foo", &h);
        let (_tmp_root, roots) = make_roots();
        install(&plan, &tarball, &roots).unwrap();
        assert!(roots.plugins_dir.join("lang-foo").exists());

        uninstall(plan.kind, "lang-foo", &roots).unwrap();
        assert!(!roots.plugins_dir.join("lang-foo").exists());

        // Idempotent.
        uninstall(plan.kind, "lang-foo", &roots).unwrap();
    }

    #[test]
    fn uninstall_is_noop_when_absent() {
        let (_tmp_root, roots) = make_roots();
        uninstall(
            ContributionKind::Plugin(PluginKindWire::Scm),
            "nope",
            &roots,
        )
        .unwrap();
    }

    #[test]
    fn iso8601_format_is_well_formed() {
        // 2026-05-02T06:00:00Z = 1777_950_000 (rough; we just check shape).
        let s = format_iso8601(1_777_950_000);
        assert_eq!(s.len(), 20);
        assert!(s.ends_with('Z'));
        assert_eq!(&s[10..11], "T");
    }
}
