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
mod usage;

use std::path::PathBuf;

#[cfg(target_os = "macos")]
use tauri::Emitter;
use tauri::Manager;

use claudette::db::Database;

fn main() {
    // Install the rustls crypto provider before any TLS usage. Both
    // aws-lc-rs and ring are active (tauri-plugin-updater pulls in ring),
    // so rustls cannot auto-detect — we must pick one explicitly.
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();

    // When spawned with `--server`, run the embedded claudette-server
    // instead of the GUI. This enables single-binary distribution while
    // keeping process isolation (server crash doesn't crash the app).
    #[cfg(feature = "server")]
    if std::env::args().any(|a| a == "--server") {
        let rt = tokio::runtime::Runtime::new().expect("Failed to create tokio runtime");
        rt.block_on(async {
            if let Err(e) = claudette_server::run(claudette_server::ServerOptions::default()).await
            {
                eprintln!("Server error: {e}");
                std::process::exit(1);
            }
        });
        return;
    }

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

    // Initialize plugin registry: seed bundled plugins, then discover.
    let plugin_dir = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".claudette")
        .join("plugins");
    let _ = std::fs::create_dir_all(&plugin_dir);
    let seed_warnings = claudette::scm_provider::seed::seed_bundled_plugins(&plugin_dir);
    for warning in &seed_warnings {
        eprintln!("[plugin] {warning}");
    }
    let plugins = claudette::scm_provider::PluginRegistry::discover(&plugin_dir);
    eprintln!(
        "[plugin] Discovered {} plugin(s): {}",
        plugins.plugins.len(),
        plugins
            .plugins
            .keys()
            .cloned()
            .collect::<Vec<_>>()
            .join(", ")
    );

    let app_state = state::AppState::new(db_path, worktree_base_dir, plugins);
    let remote_manager = remote::RemoteConnectionManager::new();
    let mcp_supervisor = std::sync::Arc::new(claudette::mcp_supervisor::McpSupervisor::new());

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .manage(app_state)
        .manage(remote_manager)
        .manage(mcp_supervisor);

    // Custom app menu (macOS only): replace the default Quit item (which
    // calls NSApp.terminate() immediately) with one we can intercept to
    // confirm quit when agents are running.
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .menu(|app| {
                use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
                let app_menu = Submenu::with_items(
                    app,
                    "Claudette",
                    true,
                    &[
                        &PredefinedMenuItem::about(app, None, None)?,
                        &PredefinedMenuItem::separator(app)?,
                        &MenuItem::with_id(
                            app,
                            "open-settings",
                            "Settings...",
                            true,
                            Some("CmdOrCtrl+,"),
                        )?,
                        &PredefinedMenuItem::separator(app)?,
                        &PredefinedMenuItem::services(app, None)?,
                        &PredefinedMenuItem::separator(app)?,
                        &PredefinedMenuItem::hide(app, None)?,
                        &PredefinedMenuItem::hide_others(app, None)?,
                        &PredefinedMenuItem::show_all(app, None)?,
                        &PredefinedMenuItem::separator(app)?,
                        &MenuItem::with_id(
                            app,
                            "quit-app",
                            "Quit Claudette",
                            true,
                            Some("CmdOrCtrl+Q"),
                        )?,
                    ],
                )?;
                let edit_menu = Submenu::with_items(
                    app,
                    "Edit",
                    true,
                    &[
                        &PredefinedMenuItem::undo(app, None)?,
                        &PredefinedMenuItem::redo(app, None)?,
                        &PredefinedMenuItem::separator(app)?,
                        &PredefinedMenuItem::cut(app, None)?,
                        &PredefinedMenuItem::copy(app, None)?,
                        &PredefinedMenuItem::paste(app, None)?,
                        &PredefinedMenuItem::select_all(app, None)?,
                    ],
                )?;
                let view_menu = Submenu::with_items(
                    app,
                    "View",
                    true,
                    &[
                        &MenuItem::with_id(
                            app,
                            "zoom-in",
                            "Zoom In",
                            true,
                            Some("CmdOrCtrl+Equal"),
                        )?,
                        &MenuItem::with_id(
                            app,
                            "zoom-out",
                            "Zoom Out",
                            true,
                            Some("CmdOrCtrl+Minus"),
                        )?,
                        &PredefinedMenuItem::separator(app)?,
                        &MenuItem::with_id(
                            app,
                            "reset-zoom",
                            "Actual Size",
                            true,
                            Some("CmdOrCtrl+Shift+0"),
                        )?,
                    ],
                )?;
                let window_menu = Submenu::with_items(
                    app,
                    "Window",
                    true,
                    &[
                        &PredefinedMenuItem::minimize(app, None)?,
                        &PredefinedMenuItem::maximize(app, None)?,
                        &PredefinedMenuItem::close_window(app, None)?,
                        &PredefinedMenuItem::separator(app)?,
                        &PredefinedMenuItem::fullscreen(app, None)?,
                    ],
                )?;
                Menu::with_items(app, &[&app_menu, &edit_menu, &view_menu, &window_menu])
            })
            .on_menu_event(|app, event| {
                if event.id().as_ref() == "zoom-in" {
                    let _ = app.emit("zoom-in", ());
                } else if event.id().as_ref() == "zoom-out" {
                    let _ = app.emit("zoom-out", ());
                } else if event.id().as_ref() == "reset-zoom" {
                    let _ = app.emit("reset-zoom", ());
                } else if event.id().as_ref() == "open-settings" {
                    tray::show_and_focus(app);
                    let _ = app.emit("open-settings", ());
                } else if event.id().as_ref() == "quit-app" {
                    let state = app.state::<state::AppState>();
                    let running = state
                        .agents
                        .try_read()
                        .map_or(true, |a| tray::has_running_agents(&a));
                    if running {
                        let handle = app.clone();
                        {
                            use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
                            handle
                                .dialog()
                                .message("Agents are still running. Quit anyway?")
                                .title("Quit Claudette")
                                .buttons(MessageDialogButtons::OkCancelCustom(
                                    "Quit".into(),
                                    "Cancel".into(),
                                ))
                                .show(move |confirmed| {
                                    if confirmed {
                                        handle.exit(0);
                                    }
                                });
                        }
                    } else {
                        app.exit(0);
                    }
                }
            });
    }

    let builder = builder
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

            // Pre-warm the Claude Code User-Agent cache on a std thread
            // (tokio runtime may not be available during setup).
            std::thread::spawn(usage::warm_user_agent_cache_sync);

            // Set up the system tray icon (respects tray_enabled setting).
            if let Err(e) = tray::setup_tray(app.handle()) {
                eprintln!("[tray] Failed to setup tray: {e}");
            }

            // Start background SCM polling for PR status and CI checks.
            commands::scm::start_scm_polling(app.handle().clone());

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // On macOS, Cmd+W always hides (standard behavior).
                #[cfg(target_os = "macos")]
                {
                    api.prevent_close();
                    let _ = window.hide();
                }
                // On Linux, hide to tray only when agents are running;
                // otherwise let the close proceed normally (quits the app).
                #[cfg(not(target_os = "macos"))]
                {
                    let state = window.app_handle().state::<state::AppState>();
                    let has_tray = state.tray_handle.lock().is_ok_and(|g| g.is_some());
                    // Fail closed: if the lock is contended, assume agents
                    // are running so we don't accidentally quit mid-task.
                    let running = state
                        .agents
                        .try_read()
                        .map_or(true, |a| tray::has_running_agents(&a));
                    if has_tray && running {
                        api.prevent_close();
                        let _ = window.hide();
                    }
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
            commands::repository::set_setup_script_auto_run,
            // Workspace
            commands::workspace::create_workspace,
            commands::workspace::fork_workspace_at_checkpoint,
            commands::workspace::run_workspace_setup,
            commands::workspace::archive_workspace,
            commands::workspace::restore_workspace,
            commands::workspace::delete_workspace,
            commands::workspace::generate_workspace_name,
            commands::workspace::refresh_branches,
            commands::workspace::discover_worktrees,
            commands::workspace::import_worktrees,
            commands::workspace::open_workspace_in_terminal,
            // Slash commands
            commands::slash_commands::list_slash_commands,
            commands::slash_commands::record_slash_command_usage,
            // Files
            commands::files::list_workspace_files,
            commands::files::read_workspace_file,
            // Chat
            commands::chat::load_chat_history,
            commands::chat::load_attachments_for_workspace,
            commands::chat::load_attachment_data,
            commands::chat::read_file_as_base64,
            commands::chat::send_chat_message,
            commands::chat::stop_agent,
            commands::chat::reset_agent_session,
            commands::chat::clear_attention,
            commands::chat::submit_agent_answer,
            commands::chat::submit_plan_approval,
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
            commands::settings::list_notification_sounds,
            commands::settings::list_system_fonts,
            commands::settings::play_notification_sound,
            commands::settings::run_notification_command,
            commands::settings::get_git_username,
            // Updater
            commands::updater::check_for_updates_with_channel,
            commands::updater::install_pending_update,
            // Plugins
            commands::plugin::list_plugins,
            commands::plugin::list_plugin_catalog,
            commands::plugin::list_plugin_marketplaces,
            commands::plugin::install_plugin,
            commands::plugin::uninstall_plugin,
            commands::plugin::enable_plugin,
            commands::plugin::disable_plugin,
            commands::plugin::update_plugin,
            commands::plugin::update_all_plugins,
            commands::plugin::add_plugin_marketplace,
            commands::plugin::remove_plugin_marketplace,
            commands::plugin::update_plugin_marketplace,
            commands::plugin::load_plugin_configuration,
            commands::plugin::save_plugin_top_level_configuration,
            commands::plugin::save_plugin_channel_configuration,
            // Shell Integration
            commands::shell::setup_shell_integration,
            commands::shell::apply_shell_integration,
            commands::shell::open_in_editor,
            commands::shell::open_url,
            // MCP
            commands::mcp::detect_mcp_servers,
            commands::mcp::save_repository_mcps,
            commands::mcp::load_repository_mcps,
            commands::mcp::delete_repository_mcp,
            commands::mcp::get_mcp_status,
            commands::mcp::ensure_and_validate_mcps,
            commands::mcp::reconnect_mcp_server,
            commands::mcp::set_mcp_server_enabled,
            // Apps
            commands::apps::detect_installed_apps,
            commands::apps::open_workspace_in_app,
            // Remote
            commands::remote::list_remote_connections,
            commands::remote::pair_with_server,
            commands::remote::connect_remote,
            commands::remote::disconnect_remote,
            commands::remote::remove_remote_connection,
            commands::remote::list_discovered_servers,
            commands::remote::add_remote_connection,
            commands::remote::send_remote_command,
            // Usage
            commands::usage::get_claude_code_usage,
            commands::usage::open_usage_settings,
            commands::usage::open_release_notes,
            // SCM Plugins
            commands::scm::list_scm_providers,
            commands::scm::get_scm_provider,
            commands::scm::set_scm_provider,
            commands::scm::load_scm_detail,
            commands::scm::scm_create_pr,
            commands::scm::scm_merge_pr,
            commands::scm::scm_refresh,
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
        .run(|_app, _event| {
            match _event {
                // Show the window when the dock icon is clicked (macOS reopen).
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { .. } => {
                    if let Some(window) = _app.get_webview_window("main") {
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                    // Navigate to session needing attention, if any.
                    tray::navigate_to_attention(_app);
                }
                // Kill the embedded server process (if we spawned one) before
                // the tokio runtime tears down. Using synchronous POSIX kill
                // ensures the child is dead before our process exits, preventing
                // the "Address already in use" error on next launch.
                tauri::RunEvent::Exit => {
                    let app_state = _app.state::<state::AppState>();
                    // try_write avoids blocking if another thread holds the lock
                    // during shutdown — in that case Drop will still fire.
                    // Dropping `srv` triggers LocalServerState::drop which
                    // calls kill_process_sync(pid). Taking it out of the
                    // Option ensures cleanup runs exactly once.
                    if let Ok(mut guard) = app_state.local_server.try_write()
                        && let Some(srv) = guard.take()
                    {
                        drop(srv);
                    }
                }
                _ => {}
            }
        });
}
