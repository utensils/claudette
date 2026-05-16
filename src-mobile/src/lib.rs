//! Claudette mobile binary — Tauri 2 iOS / Android client.
//!
//! This binary is a **thin remote-control client**: it doesn't run `claude`
//! subprocesses, doesn't touch git, doesn't open SQLite. Its only job is
//! to open an authenticated WSS connection to a paired Claudette server
//! (desktop GUI or headless `claudette-server`), pipe RPC calls + events
//! between the webview and that server, and keep the session token in
//! the OS keychain.
//!
//! The full feature set is built up across Phases 5–8 of the mobile
//! foundation work; this scaffold ships just enough to compile and boot
//! an empty webview so `cargo tauri ios dev` produces a runnable app
//! before any screens exist.

pub mod commands;
pub mod state;
pub mod storage;

/// Tauri entry point. The `mobile_entry_point` attribute exposes a
/// FFI-friendly `start_app` symbol when building for iOS / Android so
/// the platform-specific shells (Swift wrapper, JNI bridge) can launch
/// the runtime. For the desktop fallback build, `main.rs` calls into
/// this same function.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_target(true)
        .init();

    let connections = state::ConnectionManager::default();

    // The barcode-scanner plugin is `#![cfg(mobile)]` upstream — it only
    // exists on iOS / Android targets. Branch the builder so the desktop
    // fallback build (`cargo tauri dev --bin claudette-mobile`) keeps
    // working for fast UI iteration without dragging the mobile plugin
    // into desktop linkage. Each branch produces the same `Builder<…>`
    // type and runs through the same invoke-handler / run path below.
    #[cfg(mobile)]
    let builder = tauri::Builder::default()
        .manage(connections)
        .plugin(tauri_plugin_barcode_scanner::init());
    #[cfg(not(mobile))]
    let builder = tauri::Builder::default().manage(connections);

    builder
        .invoke_handler(tauri::generate_handler![
            commands::version,
            commands::pair_with_connection_string,
            commands::list_saved_connections,
            commands::connect_saved,
            commands::forget_connection,
            commands::send_rpc,
        ])
        .run(tauri::generate_context!())
        .expect("error while running claudette mobile app");
}
