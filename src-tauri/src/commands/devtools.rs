/// Opens the webview inspector on the calling window. Triggered from
/// the Help → Open dev tools menu item.
///
/// `WebviewWindow::open_devtools()` is gated by Tauri behind
/// `#[cfg(any(debug_assertions, feature = "devtools"))]`. We enable the
/// `devtools` Cargo feature in the default set (see `Cargo.toml`) so this
/// works in release builds, not just dev — otherwise users would have
/// to do a custom build to inspect the webview.
#[tauri::command]
pub fn open_devtools(window: tauri::WebviewWindow) {
    window.open_devtools();
}
