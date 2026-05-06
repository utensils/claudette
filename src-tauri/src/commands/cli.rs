//! CLI install/uninstall/status commands for the Settings → CLI panel.
//!
//! The `claudette` CLI binary ships inside every release artifact
//! (configured via `tauri.conf.json`'s `bundle.externalBin`). Tauri's
//! bundler stages it next to the GUI binary in the resulting bundle:
//! `Claudette.app/Contents/MacOS/claudette` on macOS, `/usr/bin/
//! claudette` in the .deb, alongside `claudette-app` for AppImage and
//! the Windows install dir.
//!
//! These commands locate that bundled binary at runtime and create a
//! symlink (Unix) or copy (Windows) into a user-writable bin directory
//! so `claudette` is on `PATH` for the user's shell. No network, no
//! version drift — the installed CLI is always the one that shipped
//! with this GUI build.
//!
//! Target dirs:
//! - macOS / Linux: `~/.local/bin/claudette` (created if missing)
//! - Windows: `%LOCALAPPDATA%\Programs\Claudette\bin\claudette.exe`,
//!   plus a `HKCU\Environment\Path` append + `WM_SETTINGCHANGE`
//!   broadcast so new shells pick the entry up.

use std::env;
use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    /// Where the bundled CLI sits inside the app artifact (resolved
    /// from `current_exe`). `None` if we couldn't locate it — typically
    /// in a dev build where `tauri dev` runs the bare binary without
    /// the sidecar staged.
    pub bundled_path: Option<PathBuf>,
    /// Where the install action would (or did) place the shim.
    pub target_path: PathBuf,
    /// True if `target_path` exists and resolves to `bundled_path`.
    pub installed_current: bool,
    /// True if `target_path` exists but points elsewhere — the user has
    /// an older Claudette's CLI on PATH and "Update" should be offered.
    pub installed_stale: bool,
    /// True if the directory containing `target_path` is on the user's
    /// `$PATH` / `%PATH%`. Used to render a shell-snippet hint in the UI.
    pub target_dir_on_path: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub target_path: PathBuf,
    pub target_dir_on_path: bool,
    /// Free-form hint to render when the target dir isn't yet effective
    /// on the user's PATH. On macOS/Linux this is a copy-pasteable
    /// shell snippet to append `~/.local/bin` to PATH. On Windows the
    /// registry write already updated `HKCU\Environment\Path`, but new
    /// shells need a respawn — the hint reminds the user to restart
    /// their terminal. `None` when the target dir is already on PATH.
    pub path_hint: Option<String>,
}

/// Resolve the bundled CLI binary path next to the running GUI binary.
///
/// `current_exe` is the GUI binary; the CLI sidecar lives in the same
/// directory under the externalBin name (`claudette` / `claudette.exe`).
fn bundled_cli_path() -> Option<PathBuf> {
    let exe = env::current_exe().ok()?;
    let dir = exe.parent()?;
    let candidate = if cfg!(windows) {
        dir.join("claudette.exe")
    } else {
        dir.join("claudette")
    };
    if candidate.exists() {
        Some(candidate)
    } else {
        None
    }
}

/// User-writable bin directory the install action targets.
fn target_dir() -> Result<PathBuf, String> {
    if cfg!(windows) {
        let local_app = env::var_os("LOCALAPPDATA")
            .ok_or_else(|| "LOCALAPPDATA env var not set".to_string())?;
        Ok(PathBuf::from(local_app)
            .join("Programs")
            .join("Claudette")
            .join("bin"))
    } else {
        let home =
            dirs::home_dir().ok_or_else(|| "could not resolve home directory".to_string())?;
        Ok(home.join(".local").join("bin"))
    }
}

fn target_path() -> Result<PathBuf, String> {
    let dir = target_dir()?;
    let name = if cfg!(windows) {
        "claudette.exe"
    } else {
        "claudette"
    };
    Ok(dir.join(name))
}

/// Returns true if `dir` appears as an entry in the current process's
/// PATH (for status display) — note we don't see the user's *shell*
/// PATH, only the env Tauri inherited at launch. Good enough for the
/// hint on macOS/Linux (Launch Services + login shell init usually
/// agree); on Windows the registry update is what matters anyway.
fn dir_on_path(dir: &Path) -> bool {
    let Some(path_var) = env::var_os("PATH") else {
        return false;
    };
    env::split_paths(&path_var).any(|p| p == dir)
}

#[tauri::command]
pub async fn cli_status() -> Result<CliStatus, String> {
    let bundled = bundled_cli_path();
    let target = target_path()?;
    let target_dir_on_path = dir_on_path(target.parent().unwrap_or_else(|| Path::new("/")));

    // On Unix the install is a symlink, so canonicalize() resolves both
    // sides to the same bundled path and equality is the right check.
    // On Windows we *copy* the binary (symlinks need admin / Developer
    // Mode), so the canonicalized paths intentionally differ — fall
    // back to a content compare via SHA-256.
    let target_exists = std::fs::symlink_metadata(&target).is_ok();
    let installed_current = if !target_exists {
        false
    } else if let Some(b) = &bundled {
        match (std::fs::canonicalize(&target), std::fs::canonicalize(b)) {
            (Ok(rt), Ok(rb)) if rt == rb => true,
            _ => files_equal_by_hash(&target, b).unwrap_or(false),
        }
    } else {
        false
    };
    let installed_stale = target_exists && !installed_current;

    Ok(CliStatus {
        bundled_path: bundled,
        target_path: target,
        installed_current,
        installed_stale,
        target_dir_on_path,
    })
}

/// Return `Some(true)` if both files exist with the same SHA-256
/// digest. Any IO error returns `None` so the caller can fall through
/// to a "not current" interpretation rather than masking real errors.
fn files_equal_by_hash(a: &Path, b: &Path) -> Option<bool> {
    use sha2::{Digest, Sha256};
    use std::fs::File;
    use std::io::{BufReader, Read};

    fn hash(p: &Path) -> std::io::Result<[u8; 32]> {
        let mut hasher = Sha256::new();
        let mut reader = BufReader::new(File::open(p)?);
        let mut buf = [0u8; 64 * 1024];
        loop {
            let n = reader.read(&mut buf)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        Ok(hasher.finalize().into())
    }

    let ah = hash(a).ok()?;
    let bh = hash(b).ok()?;
    Some(ah == bh)
}

#[tauri::command]
pub async fn install_cli_on_path() -> Result<InstallResult, String> {
    let bundled = bundled_cli_path()
        .ok_or_else(|| "Bundled `claudette` CLI not found next to the GUI binary. This usually means you're running a dev build — run a `cargo tauri build` release first.".to_string())?;
    let target = target_path()?;
    let dir = target
        .parent()
        .ok_or_else(|| "target path has no parent".to_string())?;

    std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;

    install_to_target(&bundled, &target)?;

    let on_path = dir_on_path(dir);
    let path_hint = if on_path {
        None
    } else if cfg!(windows) {
        // We already updated HKCU\Environment\Path below, but new
        // shells need a respawn to pick it up. Tell the user.
        Some(format!(
            "Restart your terminal or sign out/in for the new PATH entry ({}) to take effect.",
            dir.display()
        ))
    } else {
        Some(format!(
            r#"Add {} to your shell PATH:
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc   # zsh
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc  # bash
Then restart the shell."#,
            dir.display()
        ))
    };

    Ok(InstallResult {
        target_path: target,
        target_dir_on_path: on_path,
        path_hint,
    })
}

#[tauri::command]
pub async fn uninstall_cli_from_path() -> Result<(), String> {
    let target = target_path()?;
    if !target.exists() && std::fs::symlink_metadata(&target).is_err() {
        // Nothing there — treat as success (idempotent).
        return Ok(());
    }
    std::fs::remove_file(&target)
        .map_err(|e| format!("could not remove {}: {e}", target.display()))?;
    Ok(())
}

// --------------------------- platform install ---------------------------

#[cfg(unix)]
fn install_to_target(bundled: &Path, target: &Path) -> Result<(), String> {
    use std::os::unix::fs::symlink;

    // If a previous install (or another file) is at the target, remove
    // it first. We only nuke regular files / symlinks, not directories.
    if let Ok(meta) = std::fs::symlink_metadata(target) {
        if meta.file_type().is_symlink() || meta.is_file() {
            std::fs::remove_file(target)
                .map_err(|e| format!("could not replace existing {}: {e}", target.display()))?;
        } else {
            return Err(format!(
                "{} exists and is not a regular file or symlink — refusing to overwrite",
                target.display()
            ));
        }
    }

    symlink(bundled, target).map_err(|e| {
        format!(
            "could not symlink {} -> {}: {e}",
            target.display(),
            bundled.display()
        )
    })?;
    Ok(())
}

#[cfg(windows)]
fn install_to_target(bundled: &Path, target: &Path) -> Result<(), String> {
    // Windows symlinks need either admin or Developer Mode. Copy the
    // binary instead — same on-disk story for the user, and it survives
    // the bundled CLI being upgraded out from under them (until they
    // re-run "Install on PATH").
    if target.exists() {
        std::fs::remove_file(target)
            .map_err(|e| format!("could not replace existing {}: {e}", target.display()))?;
    }
    std::fs::copy(bundled, target).map_err(|e| {
        format!(
            "could not copy {} -> {}: {e}",
            bundled.display(),
            target.display()
        )
    })?;

    // Ensure the bin dir is on the user's PATH. Per-user (HKCU), so no
    // admin needed. After writing, broadcast WM_SETTINGCHANGE so newly
    // spawned processes pick it up without a logout.
    let bin_dir = target
        .parent()
        .ok_or_else(|| "target path has no parent".to_string())?;
    ensure_user_path_contains(bin_dir)?;
    broadcast_setting_change();

    Ok(())
}

#[cfg(windows)]
fn ensure_user_path_contains(dir: &Path) -> Result<(), String> {
    use winreg::RegKey;
    use winreg::enums::*;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let env = hkcu
        .open_subkey_with_flags("Environment", KEY_READ | KEY_WRITE)
        .map_err(|e| format!("could not open HKCU\\Environment: {e}"))?;

    let current: String = env.get_value("Path").unwrap_or_default();
    let dir_str = dir.to_string_lossy().to_string();
    let already = current.split(';').any(|p| p.eq_ignore_ascii_case(&dir_str));
    if already {
        return Ok(());
    }

    let updated = if current.is_empty() {
        dir_str
    } else if current.ends_with(';') {
        format!("{current}{dir_str}")
    } else {
        format!("{current};{dir_str}")
    };
    env.set_value("Path", &updated)
        .map_err(|e| format!("could not write HKCU\\Environment\\Path: {e}"))?;
    Ok(())
}

#[cfg(windows)]
fn broadcast_setting_change() {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        HWND_BROADCAST, SMTO_ABORTIFHUNG, SendMessageTimeoutW, WM_SETTINGCHANGE,
    };

    let env: Vec<u16> = OsStr::new("Environment")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut result: usize = 0;
    unsafe {
        SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SETTINGCHANGE,
            0,
            env.as_ptr() as isize,
            SMTO_ABORTIFHUNG,
            5000,
            &mut result as *mut usize,
        );
    }
}
