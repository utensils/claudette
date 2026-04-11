use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};

use claudette::db::Database;
use claudette::model::WorkspaceStatus;

use crate::state::AppState;

static ICON_IDLE: &[u8] = include_bytes!("../../assets/tray-idle.png");
static ICON_ACTIVE: &[u8] = include_bytes!("../../assets/tray-active.png");
static ICON_ATTENTION: &[u8] = include_bytes!("../../assets/tray-attention.png");

/// Tray icon state — determines which icon variant and tooltip to show.
enum TrayState {
    Idle,
    Running(usize),
    NeedsAttention(usize),
}

/// Create and register the system tray icon.
/// Returns early (no-op) if the `tray_enabled` setting is `"false"`.
pub fn setup_tray(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();

    // Check setting — default to enabled.
    if let Ok(db) = Database::open(&state.db_path)
        && let Ok(Some(val)) = db.get_app_setting("tray_enabled")
        && val == "false"
    {
        return Ok(());
    }

    // Don't create a second tray if one already exists.
    if let Ok(guard) = state.tray_handle.lock()
        && guard.is_some()
    {
        return Ok(());
    }

    let menu = build_tray_menu(app)?;
    let icon = Image::from_bytes(ICON_IDLE).map_err(|e| e.to_string())?;

    let tray = TrayIconBuilder::with_id("claudette-tray")
        .icon(icon)
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip("Claudette")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if let Some(ws_id) = id.strip_prefix("ws:") {
                // Bring window to front and select the workspace.
                show_and_focus(app);
                let _ = app.emit("tray-select-workspace", ws_id.to_string());
            } else if id == "show" {
                show_and_focus(app);
                navigate_to_attention(app);
            } else if id == "quit" {
                let state = app.state::<AppState>();
                let running = state
                    .agents
                    .try_read()
                    .map_or(true, |a| has_running_agents(&a));
                if running {
                    let handle = app.clone();
                    tauri::async_runtime::spawn(async move {
                        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
                        let confirmed = handle
                            .dialog()
                            .message("Agents are still running. Quit anyway?")
                            .title("Quit Claudette")
                            .buttons(MessageDialogButtons::OkCancelCustom(
                                "Quit".into(),
                                "Cancel".into(),
                            ))
                            .blocking_show();
                        if confirmed {
                            handle.exit(0);
                        }
                    });
                } else {
                    app.exit(0);
                }
            }
        })
        .build(app)
        .map_err(|e| e.to_string())?;

    if let Ok(mut guard) = state.tray_handle.lock() {
        *guard = Some(tray);
    }

    Ok(())
}

/// Rebuild the tray menu and update the icon to reflect current state.
/// No-op if the tray is not active.
pub fn rebuild_tray(app: &AppHandle) {
    let state = app.state::<AppState>();
    let tray = {
        let Ok(guard) = state.tray_handle.lock() else {
            return;
        };
        match guard.as_ref() {
            Some(t) => t.clone(),
            None => return,
        }
    };

    let Ok(menu) = build_tray_menu(app) else {
        return;
    };
    let _ = tray.set_menu(Some(menu));

    let tray_state = compute_tray_state(state.inner());
    let (icon_bytes, is_template) = match &tray_state {
        TrayState::Idle => (ICON_IDLE, true),
        TrayState::Running(_) => (ICON_ACTIVE, false),
        TrayState::NeedsAttention(_) => (ICON_ATTENTION, false),
    };
    if let Ok(icon) = Image::from_bytes(icon_bytes) {
        let _ = tray.set_icon(Some(icon));
        let _ = tray.set_icon_as_template(is_template);
    }

    let tooltip = match &tray_state {
        TrayState::Idle => "Claudette — All idle".to_string(),
        TrayState::Running(n) => format!(
            "Claudette — {n} agent{} running",
            if *n == 1 { "" } else { "s" }
        ),
        TrayState::NeedsAttention(n) => format!(
            "Claudette — {n} agent{} need{} input",
            if *n == 1 { "" } else { "s" },
            if *n == 1 { "s" } else { "" },
        ),
    };
    let _ = tray.set_tooltip(Some(&tooltip));
}

/// Called when an agent starts waiting for user input.
/// Updates the tray icon and sends a native notification.
pub fn notify_attention(app: &AppHandle, workspace_id: &str) {
    rebuild_tray(app);

    let state = app.state::<AppState>();
    let db = match Database::open(&state.db_path) {
        Ok(db) => db,
        Err(_) => return,
    };

    // Look up workspace name for the notification body.
    let ws_name = db
        .list_workspaces()
        .ok()
        .and_then(|wss| {
            wss.into_iter()
                .find(|w| w.id == workspace_id)
                .map(|w| w.name)
        })
        .unwrap_or_else(|| "An agent".to_string());

    // Read notification sound preference (default: "Default").
    let sound = db
        .get_app_setting("notification_sound")
        .ok()
        .flatten()
        .unwrap_or_else(|| "Default".to_string());

    let title = "Claudette — Input Required";
    let body = format!("{ws_name} is waiting for your response");

    send_notification(app, workspace_id, title, &body, &sound);

    // Run user-configured notification command (if set).
    if let Ok(Some(cmd)) = db.get_app_setting("notification_command")
        && !cmd.is_empty()
        && let Some(mut command) = crate::commands::settings::build_notification_command(
            &cmd,
            title,
            &body,
            workspace_id,
            &ws_name,
        )
    {
        std::thread::spawn(move || {
            if let Ok(mut child) = command.spawn() {
                let _ = child.wait();
            }
        });
    }
}

/// Remove the tray icon (called when user disables the setting).
/// Must dispatch to the main thread — macOS requires NSStatusItem
/// removal on the main run loop.
pub fn destroy_tray(app: &AppHandle) {
    let state = app.state::<AppState>();
    if let Ok(mut guard) = state.tray_handle.lock() {
        guard.take(); // clear our handle
    }
    // Dispatch removal to the main thread to satisfy macOS requirements.
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let _ = handle.remove_tray_by_id("claudette-tray");
    });
}

/// Determine the overall tray state from all agent sessions.
fn compute_tray_state(state: &AppState) -> TrayState {
    let agents = match state.agents.try_read() {
        Ok(guard) => guard,
        Err(_) => return TrayState::Idle,
    };
    compute_tray_state_from_agents(&agents)
}

/// Check whether any agent is actively running (has a PID).
/// Used by the quit confirmation guard — testable without AppState.
pub fn has_running_agents(
    agents: &std::collections::HashMap<String, crate::state::AgentSessionState>,
) -> bool {
    agents.values().any(|s| s.active_pid.is_some())
}

/// Pure logic for tray state — testable without AppState.
fn compute_tray_state_from_agents(
    agents: &std::collections::HashMap<String, crate::state::AgentSessionState>,
) -> TrayState {
    // Count sessions needing attention regardless of active_pid — the CLI
    // exits immediately after emitting AskUserQuestion/ExitPlanMode, so
    // the process is already gone while the user still needs to respond.
    let attention_count = agents.values().filter(|s| s.needs_attention).count();
    if attention_count > 0 {
        return TrayState::NeedsAttention(attention_count);
    }

    let running_count = agents.values().filter(|s| s.active_pid.is_some()).count();
    if running_count > 0 {
        return TrayState::Running(running_count);
    }

    TrayState::Idle
}

/// Build a menu listing workspaces grouped by repository.
fn build_tray_menu(app: &AppHandle) -> Result<Menu<tauri::Wry>, String> {
    let state = app.state::<AppState>();
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    let repos = db.list_repositories().map_err(|e| e.to_string())?;
    let workspaces = db.list_workspaces().map_err(|e| e.to_string())?;

    // Use try_read() to avoid panicking inside the tokio runtime.
    // If the lock is contended, all agents show as idle (harmless — next rebuild corrects it).
    let empty = std::collections::HashMap::new();
    let agents_guard = state.agents.try_read();
    let agents = match &agents_guard {
        Ok(guard) => &**guard,
        Err(_) => &empty,
    };

    // Group active workspaces by repo, preserving the user's repo sort order.
    // Iterate repos first (sorted by sort_order, name from DB), then attach
    // matching workspaces — this guarantees the tray matches the sidebar.
    let mut by_repo: Vec<(String, String, Vec<_>)> = Vec::new();
    for repo in &repos {
        let repo_ws: Vec<_> = workspaces
            .iter()
            .filter(|ws| ws.repository_id == repo.id && ws.status == WorkspaceStatus::Active)
            .collect();
        if !repo_ws.is_empty() {
            by_repo.push((repo.name.clone(), repo.id.clone(), repo_ws));
        }
    }

    // Build menu items.
    let mut items: Vec<Box<dyn tauri::menu::IsMenuItem<tauri::Wry>>> = Vec::new();

    for (repo_name, repo_id, ws_list) in &by_repo {
        // Repo name as a disabled header.
        let header = MenuItem::with_id(
            app,
            format!("repo:{repo_id}"),
            repo_name,
            false,
            None::<&str>,
        )
        .map_err(|e| e.to_string())?;
        items.push(Box::new(header));

        for ws in ws_list {
            let session = agents.get(&ws.id);
            let is_running = session.is_some_and(|s| s.active_pid.is_some());
            let needs_input = session.is_some_and(|s| s.needs_attention);
            let status = if needs_input {
                "⚠ Needs Input"
            } else if is_running {
                "● Running"
            } else {
                "○ Idle"
            };
            let label = format!("  {}  {}", ws.name, status);
            let item = MenuItem::with_id(app, format!("ws:{}", ws.id), &label, true, None::<&str>)
                .map_err(|e| e.to_string())?;
            items.push(Box::new(item));
        }
    }

    // Separator + Show + Quit.
    let sep = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
    items.push(Box::new(sep));

    let show = MenuItem::with_id(app, "show", "Show Claudette", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    items.push(Box::new(show));

    let sep2 = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
    items.push(Box::new(sep2));

    let quit =
        MenuItem::with_id(app, "quit", "Quit", true, None::<&str>).map_err(|e| e.to_string())?;
    items.push(Box::new(quit));

    // Convert to references for Menu::with_items.
    let item_refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> =
        items.iter().map(|b| b.as_ref()).collect();

    Menu::with_items(app, &item_refs).map_err(|e| e.to_string())
}

fn send_notification(app: &AppHandle, workspace_id: &str, title: &str, body: &str, sound: &str) {
    // On macOS, use mac-notification-sys directly so we can block for the
    // click response. When the user clicks the notification, show the window
    // and navigate to the session — even if the window was hidden (close-to-tray).
    #[cfg(target_os = "macos")]
    {
        let app_clone = app.clone();
        let ws_id = workspace_id.to_string();
        let title = title.to_string();
        let body = body.to_string();
        let sound = sound.to_string();

        std::thread::spawn(move || {
            let mut n = mac_notification_sys::Notification::new();
            n.title(&title).message(&body).wait_for_click(true);
            match sound.as_str() {
                "None" => {}
                "Default" => {
                    n.default_sound();
                }
                custom => {
                    n.sound(custom);
                }
            }

            if let Ok(response) = n.send()
                && matches!(
                    response,
                    mac_notification_sys::NotificationResponse::Click
                        | mac_notification_sys::NotificationResponse::ActionButton(_)
                )
            {
                show_and_focus(&app_clone);
                let _ = app_clone.emit("tray-select-workspace", ws_id);
            }
        });
    }

    // On non-macOS, fall back to tauri-plugin-notification (fire-and-forget).
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (workspace_id, sound);
        use tauri_plugin_notification::NotificationExt;
        let _ = app.notification().builder().title(title).body(body).show();
    }
}

fn show_and_focus(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Emit a workspace selection event for the first session needing attention.
pub fn navigate_to_attention(app: &AppHandle) {
    let state = app.state::<AppState>();
    if let Ok(agents) = state.agents.try_read()
        && let Some((ws_id, _)) = agents.iter().find(|(_, s)| s.needs_attention)
    {
        let _ = app.emit("tray-select-workspace", ws_id.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AgentSessionState;
    use std::collections::HashMap;

    fn session(pid: Option<u32>, attention: bool) -> AgentSessionState {
        AgentSessionState {
            session_id: "test".to_string(),
            turn_count: 1,
            active_pid: pid,
            custom_instructions: None,
            needs_attention: attention,
        }
    }

    #[test]
    fn test_tray_state_idle_when_no_agents() {
        let agents = HashMap::new();
        assert!(matches!(
            compute_tray_state_from_agents(&agents),
            TrayState::Idle
        ));
    }

    #[test]
    fn test_tray_state_idle_when_all_stopped() {
        let mut agents = HashMap::new();
        agents.insert("ws1".to_string(), session(None, false));
        agents.insert("ws2".to_string(), session(None, false));
        assert!(matches!(
            compute_tray_state_from_agents(&agents),
            TrayState::Idle
        ));
    }

    #[test]
    fn test_tray_state_running_when_agent_has_pid() {
        let mut agents = HashMap::new();
        agents.insert("ws1".to_string(), session(Some(1234), false));
        agents.insert("ws2".to_string(), session(None, false));
        assert!(matches!(
            compute_tray_state_from_agents(&agents),
            TrayState::Running(1)
        ));
    }

    #[test]
    fn test_tray_state_running_counts_multiple() {
        let mut agents = HashMap::new();
        agents.insert("ws1".to_string(), session(Some(1234), false));
        agents.insert("ws2".to_string(), session(Some(5678), false));
        assert!(matches!(
            compute_tray_state_from_agents(&agents),
            TrayState::Running(2)
        ));
    }

    #[test]
    fn test_tray_state_attention_takes_priority_over_running() {
        let mut agents = HashMap::new();
        agents.insert("ws1".to_string(), session(Some(1234), true)); // running + attention
        agents.insert("ws2".to_string(), session(Some(5678), false)); // running only
        assert!(matches!(
            compute_tray_state_from_agents(&agents),
            TrayState::NeedsAttention(1)
        ));
    }

    #[test]
    fn test_tray_state_attention_persists_after_process_exit() {
        let mut agents = HashMap::new();
        // CLI exits immediately after AskUserQuestion — needs_attention stays true
        // even with no active_pid. Tray should still show attention state.
        agents.insert("ws1".to_string(), session(None, true));
        assert!(matches!(
            compute_tray_state_from_agents(&agents),
            TrayState::NeedsAttention(1)
        ));
    }

    #[test]
    fn test_tray_state_attention_counts_all_needing_input() {
        let mut agents = HashMap::new();
        agents.insert("ws1".to_string(), session(Some(1234), true)); // running + attention
        agents.insert("ws2".to_string(), session(Some(5678), true)); // running + attention
        agents.insert("ws3".to_string(), session(None, true)); // exited but still waiting
        assert!(matches!(
            compute_tray_state_from_agents(&agents),
            TrayState::NeedsAttention(3)
        ));
    }

    // --- Quit guard tests (has_running_agents) ---
    // These validate the logic used by both the macOS Cmd+Q custom menu
    // handler and the tray "Quit" menu item on all platforms.

    #[test]
    fn test_has_running_agents_empty() {
        let agents = HashMap::new();
        assert!(!has_running_agents(&agents));
    }

    #[test]
    fn test_has_running_agents_all_idle() {
        let mut agents = HashMap::new();
        agents.insert("ws1".to_string(), session(None, false));
        agents.insert("ws2".to_string(), session(None, true)); // attention but no pid
        assert!(!has_running_agents(&agents));
    }

    #[test]
    fn test_has_running_agents_one_running() {
        let mut agents = HashMap::new();
        agents.insert("ws1".to_string(), session(Some(1234), false));
        agents.insert("ws2".to_string(), session(None, false));
        assert!(has_running_agents(&agents));
    }

    #[test]
    fn test_has_running_agents_multiple_running() {
        let mut agents = HashMap::new();
        agents.insert("ws1".to_string(), session(Some(1234), false));
        agents.insert("ws2".to_string(), session(Some(5678), true));
        assert!(has_running_agents(&agents));
    }
}
