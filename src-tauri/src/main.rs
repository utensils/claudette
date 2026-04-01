// Prevents additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod pty;
mod state;

use std::path::PathBuf;

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

    let app_state = state::AppState::new(db_path, worktree_base_dir);

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            // Data
            commands::data::load_initial_data,
            // Repository
            commands::repository::add_repository,
            commands::repository::update_repository_settings,
            commands::repository::relink_repository,
            commands::repository::remove_repository,
            commands::repository::get_repo_config,
            // Workspace
            commands::workspace::create_workspace,
            commands::workspace::archive_workspace,
            commands::workspace::restore_workspace,
            commands::workspace::delete_workspace,
            commands::workspace::generate_workspace_name,
            commands::workspace::refresh_branches,
            commands::workspace::open_workspace_in_terminal,
            // Chat
            commands::chat::load_chat_history,
            commands::chat::send_chat_message,
            commands::chat::stop_agent,
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
            // Settings
            commands::settings::get_app_setting,
            commands::settings::set_app_setting,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Claudette");
}
