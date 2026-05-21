use std::path::{Path, PathBuf};

use super::model::AppEntry;

#[cfg(any(target_os = "macos", target_os = "linux"))]
mod image;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos as imp;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
use linux as imp;

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
use windows as imp;

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
mod other;
#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
use other as imp;

pub(super) fn jetbrains_toolbox_script_dirs(home: Option<&Path>) -> Vec<PathBuf> {
    imp::jetbrains_toolbox_script_dirs(home)
}

pub(super) fn app_icon_data_url(entry: &AppEntry, detected_path: &Path) -> Option<String> {
    imp::app_icon_data_url(entry, detected_path)
}

#[cfg(target_os = "macos")]
pub(super) fn find_mac_app(app_name: &str) -> Option<PathBuf> {
    macos::find_mac_app(app_name)
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
pub(super) fn data_url_from_bytes(media_type: &str, bytes: &[u8]) -> String {
    image::data_url_from_bytes(media_type, bytes)
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
pub(super) fn image_data_url_from_file(path: &Path) -> Option<String> {
    image::image_data_url_from_file(path)
}

#[cfg(target_os = "linux")]
pub(super) fn find_icon_file_recursive(
    root: &Path,
    icon_name: &str,
    max_depth: usize,
) -> Option<PathBuf> {
    linux::find_icon_file_recursive(root, icon_name, max_depth)
}

#[cfg(target_os = "windows")]
pub(super) fn resolve_windows_icon_source(entry: &AppEntry, detected_path: &Path) -> PathBuf {
    windows::resolve_windows_icon_source(entry, detected_path)
}

#[cfg(target_os = "windows")]
pub(super) fn icon_cache_dir() -> Option<PathBuf> {
    windows::icon_cache_dir()
}

#[cfg(target_os = "windows")]
pub(super) fn icon_cache_key(appx_package: &str, icon_source: &Path) -> Option<String> {
    windows::icon_cache_key(appx_package, icon_source)
}

#[cfg(target_os = "windows")]
pub(super) fn read_icon_cache(key: &str) -> Option<String> {
    windows::read_icon_cache(key)
}

#[cfg(target_os = "windows")]
pub(super) fn write_icon_cache(key: &str, data_url: &str) {
    windows::write_icon_cache(key, data_url);
}

#[cfg(target_os = "windows")]
pub(super) fn extract_windows_icon_data_url(
    appx_package: &str,
    icon_source: &Path,
) -> Option<String> {
    windows::extract_windows_icon_data_url(appx_package, icon_source)
}
