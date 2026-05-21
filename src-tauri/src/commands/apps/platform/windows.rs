use std::path::{Path, PathBuf};

use crate::commands::apps::AppEntry;

const ICON_EXTRACT_PS1: &str = include_str!("windows_icon_extract.ps1");

pub(super) fn jetbrains_toolbox_script_dirs(_home: Option<&Path>) -> Vec<PathBuf> {
    dirs::data_local_dir()
        .map(|dir| dir.join("JetBrains").join("Toolbox").join("scripts"))
        .into_iter()
        .collect()
}

/// Walk up from `detected_path` looking for any of the manifest's
/// `windows_exe_names`. Used to recover the real `.exe` (which carries
/// the embedded icon resource) from PATH-resolved shims like
/// `bin/code.cmd` (one level up) or `resources/app/bin/cursor.cmd`
/// (three levels up). Falls back to `detected_path` so apps without
/// a manifest entry still get whatever icon ExtractAssociatedIcon can
/// produce.
pub(super) fn resolve_windows_icon_source(entry: &AppEntry, detected_path: &Path) -> PathBuf {
    if entry.windows_exe_names.is_empty() {
        return detected_path.to_path_buf();
    }
    // Five levels covers every layout we ship in default-apps.json
    // (Cursor's three-deep shim is the deepest case) without risking
    // a runaway directory walk on weird filesystems.
    let mut dir = detected_path.parent();
    for _ in 0..5 {
        let Some(d) = dir else { break };
        for exe in &entry.windows_exe_names {
            let candidate = d.join(exe);
            if candidate.is_file() {
                return candidate;
            }
        }
        dir = d.parent();
    }
    detected_path.to_path_buf()
}

/// Where the icon disk cache lives. Routed through
/// [`claudette::path::claudette_home`] so it follows the same
/// `$CLAUDETTE_HOME` override that `apps_config_path` and the rest
/// of the on-disk state honor — important for `dev --new` and
/// `dev --clone`, which point `CLAUDETTE_HOME` at a per-PID tmp
/// sandbox: cache entries land under the sandbox and get cleaned
/// up when it tears down, instead of leaking into the real
/// `~/.claudette/icon-cache/` and surviving across sessions.
///
/// Returns `Option` purely for symmetry with the old shape (callers
/// already handle `None`); `claudette_home` itself falls back to
/// `./.claudette` rather than failing, so this is effectively
/// infallible today.
pub(super) fn icon_cache_dir() -> Option<PathBuf> {
    Some(claudette::path::claudette_home().join("icon-cache"))
}

/// Build a stable cache key for a Windows icon source.
///
/// For .exe paths we mix the resolved source path, file size, and
/// modification time so an in-place upgrade (e.g. VS Code auto-updating
/// `Code.exe`) invalidates the cache automatically — the cache filename
/// changes, the new run misses, and the new icon is extracted and stored
/// under a new key.
///
/// For UWP packages the .exe is the alias so the path is identical
/// across versions; we use just the package-name field. AppxPackage
/// upgrades therefore won't auto-refresh — but Windows Terminal's
/// logo hasn't changed in years and the cost of a stale icon is
/// purely cosmetic. If a user wants a refresh they can clear
/// `~/.claudette/icon-cache/`.
///
/// `windows_appx_package` takes precedence to ensure we cache the
/// UWP-resolved icon (which the .exe path can't produce) under a
/// key that doesn't collide with the .exe-derived key.
pub(super) fn icon_cache_key(appx_package: &str, icon_source: &Path) -> Option<String> {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    if !appx_package.is_empty() {
        "appx".hash(&mut hasher);
        appx_package.hash(&mut hasher);
    } else {
        "exe".hash(&mut hasher);
        icon_source.hash(&mut hasher);
        if let Ok(meta) = std::fs::metadata(icon_source) {
            meta.len().hash(&mut hasher);
            if let Ok(mtime) = meta.modified()
                && let Ok(dur) = mtime.duration_since(std::time::UNIX_EPOCH)
            {
                dur.as_secs().hash(&mut hasher);
            }
        } else {
            // Missing source — refuse to cache so the next attempt
            // re-runs extraction once the file appears.
            return None;
        }
    }
    Some(format!("{:016x}", hasher.finish()))
}

pub(super) fn read_icon_cache(key: &str) -> Option<String> {
    let path = icon_cache_dir()?.join(format!("{key}.b64"));
    let data = std::fs::read_to_string(&path).ok()?;
    let trimmed = data.trim();
    (!trimmed.is_empty() && trimmed.starts_with("data:image/")).then(|| trimmed.to_owned())
}

pub(super) fn write_icon_cache(key: &str, data_url: &str) {
    let Some(dir) = icon_cache_dir() else { return };
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(dir.join(format!("{key}.b64")), data_url);
}

pub(super) fn app_icon_data_url(entry: &AppEntry, detected_path: &Path) -> Option<String> {
    let icon_source = resolve_windows_icon_source(entry, detected_path);

    // Cache hit: the only case where extraction is *truly* free —
    // no PowerShell startup, no Add-Type compile, no COM call. This
    // is what makes "open the dropdown" feel instant on every launch
    // after the first.
    let cache_key = icon_cache_key(&entry.windows_appx_package, &icon_source);
    if let Some(key) = cache_key.as_deref()
        && let Some(cached) = read_icon_cache(key)
    {
        return Some(cached);
    }

    let data_url = extract_windows_icon_data_url(&entry.windows_appx_package, &icon_source)?;

    if let Some(key) = cache_key.as_deref() {
        write_icon_cache(key, &data_url);
    }
    Some(data_url)
}

/// Spawn a `powershell.exe` child, feed the AppxPackage name + target
/// path on stdin (two newline-separated lines), and parse the base64
/// PNG it prints. Lifted out of `app_icon_data_url` so the regression
/// tests can exercise the extractor directly without manufacturing an
/// `AppEntry` + invoking the cache.
pub(super) fn extract_windows_icon_data_url(
    appx_package: &str,
    icon_source: &Path,
) -> Option<String> {
    use std::io::Write;
    use std::process::Stdio;

    let mut child = claudette::process::std_command("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            ICON_EXTRACT_PS1,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    {
        let stdin = child.stdin.as_mut()?;
        // Two lines: AppxPackage name (or empty) then path. Empty
        // lines are deliberate — PowerShell's
        // `[Console]::In.ReadLine()` returns `""` for them, which
        // the script normalizes via `IsNullOrEmpty`.
        let _ = writeln!(stdin, "{appx_package}");
        let _ = writeln!(stdin, "{}", icon_source.display());
    }
    let output = child.wait_with_output().ok()?;
    if !output.status.success() {
        return None;
    }

    let encoded = String::from_utf8(output.stdout).ok()?;
    let encoded = encoded.trim();
    (!encoded.is_empty()).then(|| format!("data:image/png;base64,{encoded}"))
}
