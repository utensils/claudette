/// Opens the webview inspector on the calling window. Triggered from
/// the Help → Open dev tools menu item.
///
/// `WebviewWindow::open_devtools()` is gated by Tauri behind
/// `#[cfg(any(debug_assertions, feature = "devtools"))]`. We enable the
/// `devtools` Cargo feature in the default set (see `Cargo.toml`) so
/// release builds work, not just dev. The inner `cfg` guard is defensive
/// against `--no-default-features` builds — the command stays registered
/// (so the JS-side `invoke("open_devtools")` resolves cleanly) but
/// becomes a no-op when the feature isn't compiled.
#[tauri::command]
pub fn open_devtools(window: tauri::WebviewWindow) {
    #[cfg(any(debug_assertions, feature = "devtools"))]
    window.open_devtools();
    #[cfg(not(any(debug_assertions, feature = "devtools")))]
    let _ = window;
}
