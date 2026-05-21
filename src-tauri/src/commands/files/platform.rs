use std::path::Path;

pub(super) fn reveal_path(path: &Path) -> Result<(), String> {
    reveal_path_impl(path)
}

#[cfg(target_os = "macos")]
fn reveal_path_impl(path: &Path) -> Result<(), String> {
    let output = claudette::process::std_command("open")
        .arg("-R")
        .arg(path)
        .output()
        .map_err(|e| format!("failed to run open: {e}"))?;
    if output.status.success() {
        return Ok(());
    }
    Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
}

#[cfg(target_os = "windows")]
fn reveal_path_impl(path: &Path) -> Result<(), String> {
    claudette::process::std_command("explorer")
        .arg(format!("/select,{}", path.to_string_lossy()))
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("failed to run explorer: {e}"))
}

#[cfg(any(
    target_os = "linux",
    not(any(target_os = "macos", target_os = "windows"))
))]
fn reveal_path_impl(path: &Path) -> Result<(), String> {
    let target = if path.is_dir() {
        path
    } else {
        path.parent().unwrap_or(path)
    };
    crate::commands::shell::opener::open(&target.to_string_lossy())
        .map_err(|e| format!("open failed: {e}"))
}
