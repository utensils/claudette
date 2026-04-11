// Prevents additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod mdns;
mod osc133;
mod pty;
mod remote;
mod state;
mod transport;
mod tray;

use std::path::PathBuf;

use tauri::Manager;

use claudette::db::Database;

fn main() {
    // Determine database and worktree paths.
    let data_dir = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("claudette");
    let db_path = data_dir.join("claudette.db");

    // Ensure DB exists and migrations are applied.
    let _ = Database::open(&db_path);

    // Load worktree base dir from settings, or use default.
    let worktree_base_dir = {
        let default = dirs::home_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".claudette")
            .join("workspaces");
        if let Ok(db) = Database::open(&db_path) {
            db.get_app_setting("worktree_base_dir")
                .ok()
                .flatten()
                .map(PathBuf::from)
                .unwrap_or(default)
        } else {
            default
        }
    };

    // Load saved certificate fingerprints for mDNS pairing detection.
    let saved_fingerprints: Vec<String> = Database::open(&db_path)
        .ok()
        .and_then(|db| db.list_remote_connections().ok())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|c| c.cert_fingerprint)
        .collect();

    let app_state = state::AppState::new(db_path, worktree_base_dir);
    let remote_manager = remote::RemoteConnectionManager::new();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .manage(app_state)
        .manage(remote_manager)
        .setup(move |app| {
            // Start mDNS browser to discover nearby claudette-server instances.
            if let Err(e) = mdns::start_mdns_browser(app.handle(), saved_fingerprints) {
                eprintln!("[mdns] Failed to start browser: {e}");
            }

            // Set the notification app identity before any notifications are sent.
            // mac-notification-sys uses Once — first call wins. We call early so
            // both our direct calls and the tauri-plugin-notification share the
            // same identity.
            #[cfg(target_os = "macos")]
            {
                let bundle_id = app.config().identifier.clone();
                let identity = if cfg!(debug_assertions) {
                    "com.apple.Terminal".to_string()
                } else {
                    bundle_id
                };
                let _ = mac_notification_sys::set_application(&identity);
            }

            // Start debug eval TCP server (dev builds only).
            #[cfg(debug_assertions)]
            commands::debug::start_debug_server(app.handle().clone());

            // Set up the system tray icon (respects tray_enabled setting).
            if let Err(e) = tray::setup_tray(app.handle()) {
                eprintln!("[tray] Failed to setup tray: {e}");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Minimize to tray on close when the tray is active.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.app_handle().state::<state::AppState>();
                if let Ok(guard) = state.tray_handle.lock()
                    && guard.is_some()
                {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            // Data
            commands::data::load_initial_data,
            // Repository
            commands::repository::add_repository,
            commands::repository::update_repository_settings,
            commands::repository::relink_repository,
            commands::repository::remove_repository,
            commands::repository::get_repo_config,
            commands::repository::get_default_branch,
            commands::repository::reorder_repositories,
            // Workspace
            commands::workspace::create_workspace,
            commands::workspace::run_workspace_setup,
            commands::workspace::archive_workspace,
            commands::workspace::restore_workspace,
            commands::workspace::delete_workspace,
            commands::workspace::generate_workspace_name,
            commands::workspace::refresh_branches,
            commands::workspace::open_workspace_in_terminal,
            // Slash commands
            commands::slash_commands::list_slash_commands,
            commands::slash_commands::record_slash_command_usage,
            // Chat
            commands::chat::load_chat_history,
            commands::chat::send_chat_message,
            commands::chat::stop_agent,
            commands::chat::reset_agent_session,
            commands::chat::clear_attention,
            commands::chat::list_checkpoints,
            commands::chat::rollback_to_checkpoint,
            commands::chat::clear_conversation,
            commands::chat::save_turn_tool_activities,
            commands::chat::load_completed_turns,
            // Plan
            commands::plan::read_plan_file,
            // Diff
            commands::diff::load_diff_files,
            commands::diff::load_file_diff,
            commands::diff::revert_file,
            // Terminal
            commands::terminal::create_terminal_tab,
            commands::terminal::delete_terminal_tab,
            commands::terminal::list_terminal_tabs,
            // PTY
            pty::spawn_pty,
            pty::write_pty,
            pty::resize_pty,
            pty::close_pty,
            pty::detect_shell,
            // Settings
            commands::settings::get_app_setting,
            commands::settings::set_app_setting,
            commands::settings::list_user_themes,
            // Shell Integration
            commands::shell::setup_shell_integration,
            commands::shell::apply_shell_integration,
            commands::shell::open_in_editor,
            // Remote
            commands::remote::list_remote_connections,
            commands::remote::pair_with_server,
            commands::remote::connect_remote,
            commands::remote::disconnect_remote,
            commands::remote::remove_remote_connection,
            commands::remote::list_discovered_servers,
            commands::remote::add_remote_connection,
            commands::remote::send_remote_command,
            // Local server
            commands::remote::start_local_server,
            commands::remote::stop_local_server,
            commands::remote::get_local_server_status,
            // Debug (dev builds only — cfg-gated in commands/debug.rs)
            #[cfg(debug_assertions)]
            commands::debug::debug_eval_js,
            #[cfg(debug_assertions)]
            commands::debug::debug_eval_result,
        ]);

    builder
        .build(tauri::generate_context!())
        .expect("error while building Claudette")
        .run(|app, event| {
            // Show the window when the dock icon is clicked (macOS reopen).
            if let tauri::RunEvent::Reopen { .. } = event {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                // Navigate to session needing attention, if any.
                tray::navigate_to_attention(app);
            }
        });
}
