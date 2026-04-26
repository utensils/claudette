use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};

use claudette::db::Database;
use claudette::model::WorkspaceStatus;

use crate::state::{AppState, AttentionKind};

/// Notification event types for per-event sound selection.
pub enum NotificationEvent {
    Ask,
    Plan,
    Finished,
    Error,
    SessionStart,
}

impl NotificationEvent {
    fn setting_key(&self) -> &'static str {
        match self {
            Self::Ask => "notification_sound_ask",
            Self::Plan => "notification_sound_plan",
            Self::Finished => "notification_sound_finished",
            Self::Error => "notification_sound_error",
            Self::SessionStart => "notification_sound_session_start",
        }
    }

    fn cesp_event_name(&self) -> &'static str {
        match self {
            Self::Ask => "ask",
            Self::Plan => "plan",
            Self::Finished => "finished",
            Self::Error => "error",
            Self::SessionStart => "session_start",
        }
    }
}

impl From<AttentionKind> for NotificationEvent {
    fn from(kind: AttentionKind) -> Self {
        match kind {
            AttentionKind::Ask => Self::Ask,
            AttentionKind::Plan => Self::Plan,
        }
    }
}

fn resolve_notification_sound_with<F>(mut get_setting: F, event: NotificationEvent) -> String
where
    F: FnMut(&str) -> Option<String>,
{
    get_setting(event.setting_key())
        .or_else(|| get_setting("notification_sound"))
        .or_else(|| match get_setting("audio_notifications") {
            Some(v) if v == "false" => Some("None".to_string()),
            _ => None,
        })
        .unwrap_or_else(|| "Default".to_string())
}

/// Resolve the notification sound for a given event.
///
/// Fallback: per-event key -> global `notification_sound` -> legacy `audio_notifications` -> "Default"
pub fn resolve_notification_sound(db: &Database, event: NotificationEvent) -> String {
    resolve_notification_sound_with(|key| db.get_app_setting(key).ok().flatten(), event)
}

pub struct ResolvedSound {
    pub sound: String,
    pub volume: f64,
}

/// Read muted/volume/source settings from the DB, play a CESP sound if that
/// source is active (via the shared playback state), or return the system
/// sound name. Callers only need to handle the system-sound path.
pub fn resolve_notification(
    db: &Database,
    cesp_playback: &std::sync::Mutex<claudette::cesp::SoundPlaybackState>,
    event: NotificationEvent,
) -> ResolvedSound {
    let db_get = |key: &str| db.get_app_setting(key).ok().flatten();

    let muted = db_get("cesp_muted").is_some_and(|v| v == "true");
    let volume: f64 = db_get("cesp_volume")
        .and_then(|v| v.parse().ok())
        .filter(|v: &f64| v.is_finite())
        .unwrap_or(1.0)
        .clamp(0.0, 1.0);

    let sound = if muted || volume <= 0.0 {
        "None".to_string()
    } else if db_get("sound_source").as_deref() == Some("openpeon") {
        if let Ok(mut playback) = cesp_playback.lock() {
            claudette::cesp::play_cesp_sound_for_event_with_state(
                event.cesp_event_name(),
                &mut playback,
                &db_get,
            );
        }
        "None".to_string()
    } else {
        resolve_notification_sound(db, event)
    };

    ResolvedSound { sound, volume }
}

// Baseline tray icons (the ones shipped for the Auto style).
//
// - `idle` is a black-on-transparent critter silhouette.
// - `active` layers a green accent badge over a subtle translucent-white
//   glow of the critter shape.
// - `attention` uses the same layout with an orange accent and an
//   alpha-distinct alert dot below the badge; the alpha difference is
//   what lets macOS template rendering distinguish Running from
//   NeedsAttention (template mode collapses color to white but honors
//   alpha).
//
// On macOS the builder passes these with `is_template=true` so the OS
// tints to the menu-bar color. Linux and Windows render them as-is.
static ICON_IDLE: &[u8] = include_bytes!("../../assets/tray-idle.png");
static ICON_ACTIVE: &[u8] = include_bytes!("../../assets/tray-active.png");
static ICON_ATTENTION: &[u8] = include_bytes!("../../assets/tray-attention.png");

// Explicit light / dark / color variants (three states each). These are
// recolored from the baseline shapes with alpha preserved.
static ICON_IDLE_LIGHT: &[u8] = include_bytes!("../../assets/tray-idle-light.png");
static ICON_ACTIVE_LIGHT: &[u8] = include_bytes!("../../assets/tray-active-light.png");
static ICON_ATTENTION_LIGHT: &[u8] = include_bytes!("../../assets/tray-attention-light.png");
static ICON_IDLE_DARK: &[u8] = include_bytes!("../../assets/tray-idle-dark.png");
static ICON_ACTIVE_DARK: &[u8] = include_bytes!("../../assets/tray-active-dark.png");
static ICON_ATTENTION_DARK: &[u8] = include_bytes!("../../assets/tray-attention-dark.png");
static ICON_IDLE_COLOR: &[u8] = include_bytes!("../../assets/tray-idle-color.png");
static ICON_ACTIVE_COLOR: &[u8] = include_bytes!("../../assets/tray-active-color.png");
static ICON_ATTENTION_COLOR: &[u8] = include_bytes!("../../assets/tray-attention-color.png");

/// Tray icon state — determines which icon variant and tooltip to show.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TrayState {
    Idle,
    Running(usize),
    NeedsAttention(usize),
}

/// User-selectable tray icon style. Controls both the icon bytes shown
/// and whether `is_template` is set for macOS tinting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TrayIconStyle {
    /// Platform-sensible default. macOS uses the template icon (the OS
    /// tints it black/white to match the menu bar). Linux defaults to
    /// the color variant because the baseline black shape is nearly
    /// invisible on dark GNOME/KDE panels. Windows uses the baseline
    /// black shape. Users can always override this with Light, Dark, or
    /// Color below.
    Auto,
    /// Always render as a white shape; macOS does not tint it.
    Light,
    /// Always render as a black shape; macOS does not tint it.
    Dark,
    /// Render in the logo's brand coral (#e07850).
    Color,
}

impl TrayIconStyle {
    /// Parse the DB string value into a style, falling back to Auto.
    fn from_setting(v: Option<&str>) -> Self {
        match v {
            Some("light") => Self::Light,
            Some("dark") => Self::Dark,
            Some("color") => Self::Color,
            _ => Self::Auto,
        }
    }

    /// Return (icon_bytes, is_template) for a given state. `is_template`
    /// is only true for Auto on macOS — for the explicit variants the
    /// user has picked a concrete color and macOS must NOT tint it.
    fn icon_for(self, state: TrayState) -> (&'static [u8], bool) {
        match self {
            Self::Auto => {
                // Linux's baseline black shape is unreadable on dark panels,
                // so Auto on Linux delegates to the color variant. macOS
                // and Windows keep the original black-on-transparent shape;
                // macOS additionally flags it as a template for OS tinting.
                if cfg!(target_os = "linux") {
                    return Self::Color.icon_for(state);
                }
                let bytes = match state {
                    TrayState::Idle => ICON_IDLE,
                    TrayState::Running(_) => ICON_ACTIVE,
                    TrayState::NeedsAttention(_) => ICON_ATTENTION,
                };
                (bytes, cfg!(target_os = "macos"))
            }
            Self::Light => {
                let bytes = match state {
                    TrayState::Idle => ICON_IDLE_LIGHT,
                    TrayState::Running(_) => ICON_ACTIVE_LIGHT,
                    TrayState::NeedsAttention(_) => ICON_ATTENTION_LIGHT,
                };
                (bytes, false)
            }
            Self::Dark => {
                let bytes = match state {
                    TrayState::Idle => ICON_IDLE_DARK,
                    TrayState::Running(_) => ICON_ACTIVE_DARK,
                    TrayState::NeedsAttention(_) => ICON_ATTENTION_DARK,
                };
                (bytes, false)
            }
            Self::Color => {
                let bytes = match state {
                    TrayState::Idle => ICON_IDLE_COLOR,
                    TrayState::Running(_) => ICON_ACTIVE_COLOR,
                    TrayState::NeedsAttention(_) => ICON_ATTENTION_COLOR,
                };
                (bytes, false)
            }
        }
    }
}

/// Read the current user-selected tray icon style from an already-open DB.
/// `rebuild_tray` runs on every agent state change, so threading the DB
/// handle through (instead of re-opening the SQLite file per call) matters
/// in aggregate.
fn icon_style_from_db(db: &Database) -> TrayIconStyle {
    TrayIconStyle::from_setting(
        db.get_app_setting("tray_icon_style")
            .ok()
            .flatten()
            .as_deref(),
    )
}

/// Mint a fresh tray id. Each invocation yields a distinct string so
/// re-registration after a disable/enable cycle doesn't collide with the
/// previous tray's DBus path on Linux (see the setup_tray comment).
fn mint_tray_id(state: &AppState) -> String {
    let seq = state
        .next_tray_seq
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("claudette-tray-{seq}")
}

/// Create and register the system tray icon.
/// Returns early (no-op) if the `tray_enabled` setting is `"false"`.
pub fn setup_tray(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();

    // Open the app_settings DB once and reuse it for every read below.
    // On a fresh install the file might not exist yet, in which case the
    // default behavior (tray enabled, Auto style) applies — just like
    // before this refactor.
    let db = Database::open(&state.db_path).ok();

    // Check tray_enabled setting — default to enabled.
    if let Some(ref db) = db
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

    let menu = match &db {
        Some(db) => build_tray_menu_with_db(app, db)?,
        None => build_tray_menu(app)?,
    };
    // Use the user's selected style for the initial icon. rebuild_tray will
    // re-read it on every state change so runtime preference changes take
    // effect without a restart.
    let style = match &db {
        Some(db) => icon_style_from_db(db),
        None => TrayIconStyle::Auto,
    };
    let (icon_bytes, is_template) = style.icon_for(TrayState::Idle);
    let icon = Image::from_bytes(icon_bytes).map_err(|e| e.to_string())?;

    // Each tray instance gets a unique id. On Linux, libayatana-appindicator
    // exports DBus objects derived from the id, and the previous tray's
    // DBus path releases asynchronously on the GLib main loop. Reusing a
    // fixed id like "claudette-tray" collides on toggle off->on so the
    // new tray fails to register and silently vanishes. A monotonic
    // suffix sidesteps the collision entirely.
    let tray_id = mint_tray_id(&state);

    let tray = TrayIconBuilder::with_id(&tray_id)
        .icon(icon)
        .icon_as_template(is_template)
        .tooltip("Claudette")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if let Some(ws_id) = id.strip_prefix("ws:") {
                // Bring window to front and select the workspace.
                show_and_focus(app);
                let _ = app.emit("tray-select-workspace", ws_id.to_string());
            } else if id == "open-settings" {
                show_and_focus(app);
                let _ = app.emit("open-settings", ());
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

    // Open the settings DB once per rebuild and pass it through to the
    // menu builder and the style lookup. `rebuild_tray` is called on every
    // agent state change, so an extra DB open per call adds up. If the
    // open fails, fall back to the DB-less path (menu won't reflect
    // current repos/workspaces, but the rest continues to work).
    let db = Database::open(&state.db_path).ok();

    let menu = match &db {
        Some(db) => build_tray_menu_with_db(app, db),
        None => build_tray_menu(app),
    };
    let Ok(menu) = menu else {
        return;
    };
    let _ = tray.set_menu(Some(menu));

    let tray_state = compute_tray_state(state.inner());
    // Re-read the user's icon-style preference each rebuild so runtime
    // changes (via the settings panel) propagate without an app restart.
    let style = match &db {
        Some(db) => icon_style_from_db(db),
        None => TrayIconStyle::Auto,
    };
    let (icon_bytes, is_template) = style.icon_for(tray_state);
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
pub fn notify_attention(app: &AppHandle, workspace_id: &str, kind: AttentionKind) {
    rebuild_tray(app);

    let state = app.state::<AppState>();
    let db = match Database::open(&state.db_path) {
        Ok(db) => db,
        Err(_) => return,
    };

    // Look up workspace for notification body and env vars.
    let ws = db
        .list_workspaces()
        .ok()
        .and_then(|wss| wss.into_iter().find(|w| w.id == workspace_id));
    let ws_name = ws
        .as_ref()
        .map(|w| w.name.clone())
        .unwrap_or_else(|| "An agent".to_string());

    let app_state = app.state::<AppState>();
    let resolved =
        resolve_notification(&db, &app_state.cesp_playback, NotificationEvent::from(kind));

    let title = "Claudette — Input Required";
    let body = format!("{ws_name} is waiting for your response");

    send_notification(
        app,
        workspace_id,
        title,
        &body,
        &resolved.sound,
        resolved.volume,
    );

    // Run user-configured notification command (if set).
    // Build a best-effort WorkspaceEnv even when the workspace lookup fails
    // so notification commands still fire (with partial context).
    if let Ok(Some(cmd)) = db.get_app_setting("notification_command")
        && !cmd.is_empty()
    {
        let ws_env = if let Some(ref ws) = ws {
            let repo = db
                .list_repositories()
                .ok()
                .and_then(|rs| rs.into_iter().find(|r| r.id == ws.repository_id));
            let repo_path = repo.as_ref().map(|r| r.path.as_str()).unwrap_or("");
            let default_branch = repo
                .as_ref()
                .and_then(|r| r.base_branch.clone())
                .unwrap_or_else(|| "main".into());
            claudette::env::WorkspaceEnv::from_workspace(ws, repo_path, default_branch)
        } else {
            claudette::env::WorkspaceEnv {
                workspace_name: ws_name.clone(),
                workspace_id: workspace_id.to_string(),
                workspace_path: String::new(),
                root_path: String::new(),
                default_branch: "main".into(),
                branch_name: String::new(),
            }
        };
        if let Some(mut command) =
            crate::commands::settings::build_notification_command(&cmd, &ws_env)
            && let Ok(child) = command.spawn()
        {
            crate::commands::settings::spawn_and_reap(child);
        }
    }
}

/// Remove the tray icon (called when user disables the setting).
/// Must dispatch to the main thread — macOS requires NSStatusItem
/// removal on the main run loop.
pub fn destroy_tray(app: &AppHandle) {
    let state = app.state::<AppState>();
    // Read the id off the current handle before dropping it so the
    // subsequent remove_tray_by_id call matches the actual registered
    // tray. IDs are now unique per creation (see setup_tray).
    let tray_id: Option<String> = state
        .tray_handle
        .lock()
        .ok()
        .and_then(|mut g| g.take().map(|t| t.id().as_ref().to_string()));

    if let Some(id) = tray_id {
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || {
            let _ = handle.remove_tray_by_id(&id);
        });
    }
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

/// Build a menu listing workspaces grouped by repository. Opens its own
/// DB connection — prefer `build_tray_menu_with_db` when the caller
/// already has a `Database` open so we don't pay the file-open twice.
fn build_tray_menu(app: &AppHandle) -> Result<Menu<tauri::Wry>, String> {
    let state = app.state::<AppState>();
    let db = Database::open(&state.db_path).map_err(|e| e.to_string())?;
    build_tray_menu_with_db(app, &db)
}

/// Build the tray menu using an already-open DB. This is the hot path —
/// `rebuild_tray` runs on every agent state change, so avoid re-opening
/// the SQLite file per call.
fn build_tray_menu_with_db(app: &AppHandle, db: &Database) -> Result<Menu<tauri::Wry>, String> {
    let state = app.state::<AppState>();
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
            // Aggregate across all sessions in this workspace.
            let ws_sessions: Vec<_> = agents
                .values()
                .filter(|s| s.workspace_id == ws.id)
                .collect();
            let is_running = ws_sessions.iter().any(|s| s.active_pid.is_some());
            let needs_input = ws_sessions.iter().any(|s| s.needs_attention);
            let attention_kind = ws_sessions
                .iter()
                .find(|s| s.needs_attention)
                .and_then(|s| s.attention_kind);
            let status = if needs_input {
                match attention_kind {
                    Some(crate::state::AttentionKind::Plan) => "ℹ️ Needs Input",
                    _ => "❓ Needs Input",
                }
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

    let settings = MenuItem::with_id(app, "open-settings", "Settings", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    items.push(Box::new(settings));

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

pub(crate) fn send_notification(
    app: &AppHandle,
    workspace_id: &str,
    title: &str,
    body: &str,
    sound: &str,
    #[cfg_attr(target_os = "macos", allow(unused))] volume: f64,
) {
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
                if !ws_id.is_empty() {
                    let _ = app_clone.emit("tray-select-workspace", ws_id);
                }
            }
        });
    }

    // On non-macOS, fall back to tauri-plugin-notification (fire-and-forget)
    // and play the configured sound via play_notification_sound.
    #[cfg(not(target_os = "macos"))]
    {
        let _ = workspace_id;
        use tauri_plugin_notification::NotificationExt;
        let _ = app.notification().builder().title(title).body(body).show();
        if sound != "None" {
            crate::commands::settings::play_notification_sound(sound.to_string(), Some(volume));
        }
    }
}

pub(crate) fn show_and_focus(app: &AppHandle) {
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
        && let Some(session) = agents.values().find(|s| s.needs_attention)
    {
        let _ = app.emit("tray-select-workspace", session.workspace_id.clone());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AgentSessionState;
    use std::collections::HashMap;

    fn session(pid: Option<u32>, attention: bool) -> AgentSessionState {
        AgentSessionState {
            workspace_id: "ws1".to_string(),
            claude_session_id: "test".to_string(),
            turn_count: 1,
            active_pid: pid,
            custom_instructions: None,
            needs_attention: attention,
            attention_kind: if attention {
                Some(crate::state::AttentionKind::Ask)
            } else {
                None
            },
            attention_notification_sent: false,
            persistent_session: None,
            mcp_config_dirty: false,
            session_plan_mode: false,
            session_allowed_tools: Vec::new(),
            session_disable_1m_context: false,
            pending_permissions: HashMap::new(),
            session_exited_plan: false,
            session_resolved_env: Default::default(),
            mcp_bridge: None,
            last_user_msg_id: None,
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

    // --- TrayIconStyle tests ---

    #[test]
    fn style_from_setting_parses_known_values() {
        assert_eq!(
            TrayIconStyle::from_setting(Some("light")),
            TrayIconStyle::Light
        );
        assert_eq!(
            TrayIconStyle::from_setting(Some("dark")),
            TrayIconStyle::Dark
        );
        assert_eq!(
            TrayIconStyle::from_setting(Some("color")),
            TrayIconStyle::Color
        );
        assert_eq!(
            TrayIconStyle::from_setting(Some("auto")),
            TrayIconStyle::Auto
        );
    }

    #[test]
    fn style_from_setting_defaults_to_auto_for_missing_or_unknown() {
        assert_eq!(TrayIconStyle::from_setting(None), TrayIconStyle::Auto);
        assert_eq!(TrayIconStyle::from_setting(Some("")), TrayIconStyle::Auto);
        assert_eq!(
            TrayIconStyle::from_setting(Some("rainbow")),
            TrayIconStyle::Auto
        );
    }

    #[test]
    fn auto_uses_template_on_macos_only() {
        // The (bytes, is_template) contract: Auto style is the only one that
        // sets is_template=true, and only when compiled for macOS. Linux and
        // Windows are never template — Linux because Auto delegates to Color
        // there, Windows because it keeps the plain black shape with no
        // tinting.
        let (_, tpl) = TrayIconStyle::Auto.icon_for(TrayState::Idle);
        assert_eq!(tpl, cfg!(target_os = "macos"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn auto_delegates_to_color_on_linux() {
        // On Linux, the baseline black shape is invisible on dark panels.
        // Auto must route to the Color variant so unconfigured users get a
        // visible icon out of the box.
        for state in [
            TrayState::Idle,
            TrayState::Running(1),
            TrayState::NeedsAttention(1),
        ] {
            let (auto_bytes, auto_tpl) = TrayIconStyle::Auto.icon_for(state);
            let (color_bytes, color_tpl) = TrayIconStyle::Color.icon_for(state);
            assert_eq!(
                auto_bytes.as_ptr(),
                color_bytes.as_ptr(),
                "Auto on Linux must use the same PNG payload as Color for {state:?}"
            );
            assert_eq!(auto_tpl, color_tpl);
            assert!(!auto_tpl, "Auto on Linux must not be a template");
        }
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn auto_uses_baseline_shape_off_linux() {
        // On macOS and Windows, Auto uses the baseline black-on-transparent
        // shape (the ones loaded from the unsuffixed filenames). macOS
        // additionally sets is_template=true; Windows does not.
        let (auto_bytes, _) = TrayIconStyle::Auto.icon_for(TrayState::Idle);
        assert_eq!(
            auto_bytes.as_ptr(),
            ICON_IDLE.as_ptr(),
            "Auto off-Linux must point at the baseline ICON_IDLE payload"
        );
    }

    #[test]
    fn explicit_styles_never_set_template() {
        // Light/Dark/Color encode a concrete color chosen by the user —
        // macOS must NOT tint them, regardless of platform.
        for style in [
            TrayIconStyle::Light,
            TrayIconStyle::Dark,
            TrayIconStyle::Color,
        ] {
            for state in [
                TrayState::Idle,
                TrayState::Running(1),
                TrayState::NeedsAttention(1),
            ] {
                let (_, tpl) = style.icon_for(state);
                assert!(
                    !tpl,
                    "style {style:?} + state {state:?} should not be template"
                );
            }
        }
    }

    // --- Tray ID minting ---
    // These guard the fix for the Linux DBus re-registration bug: each
    // setup_tray must produce a fresh id so libayatana-appindicator's
    // asynchronous DBus unregistration of the previous tray can't block
    // the new tray from claiming its path.

    fn fresh_state() -> AppState {
        // Lightweight AppState for unit tests — the db path and worktree
        // dir aren't exercised here, only next_tray_seq.
        let plugins = claudette::plugin_runtime::PluginRegistry::discover(std::path::Path::new(
            "/nonexistent",
        ));
        AppState::new(
            std::path::PathBuf::from(":memory:"),
            std::path::PathBuf::from("/tmp"),
            plugins,
        )
    }

    #[test]
    fn mint_tray_id_produces_unique_sequential_ids() {
        let state = fresh_state();
        let a = mint_tray_id(&state);
        let b = mint_tray_id(&state);
        let c = mint_tray_id(&state);
        assert_ne!(
            a, b,
            "successive ids must differ (Linux DBus path collision)"
        );
        assert_ne!(b, c);
        assert_ne!(a, c);
    }

    #[test]
    fn mint_tray_id_uses_claudette_tray_prefix() {
        // The id appears in DBus paths and user-facing logs. Keeping the
        // recognizable `claudette-tray` prefix makes it easy to grep for
        // while still varying the suffix.
        let state = fresh_state();
        let id = mint_tray_id(&state);
        assert!(
            id.starts_with("claudette-tray-"),
            "expected claudette-tray-* prefix, got {id:?}"
        );
        // The suffix must be parseable as a u64 so it can't accidentally
        // become something that breaks DBus name rules.
        let suffix = id.trim_start_matches("claudette-tray-");
        suffix
            .parse::<u64>()
            .unwrap_or_else(|_| panic!("tray id suffix must be numeric: {id:?}"));
    }

    #[test]
    fn mint_tray_id_starts_from_one_on_fresh_state() {
        // Matches the AppState::new initialization. A zero starting value
        // would be surprising in logs; keep the baseline at 1.
        let state = fresh_state();
        assert_eq!(mint_tray_id(&state), "claudette-tray-1");
    }

    #[test]
    fn active_and_attention_bytes_differ_within_each_style() {
        // Regression guard: the `Running` and `NeedsAttention` tray states
        // must resolve to PNGs with different content, otherwise the tray
        // stops being an at-a-glance signal that user input is required.
        // Earlier versions of this patch color-flattened the baseline's
        // green/orange accents and collapsed the two states into identical
        // artwork on Light/Dark/Color — and the baseline itself had the
        // same problem for macOS template rendering. We now ship an
        // alpha-distinct alert dot on attention; this test ensures it
        // survives.
        for style in [
            TrayIconStyle::Auto,
            TrayIconStyle::Light,
            TrayIconStyle::Dark,
            TrayIconStyle::Color,
        ] {
            let (active, _) = style.icon_for(TrayState::Running(1));
            let (attention, _) = style.icon_for(TrayState::NeedsAttention(1));
            assert_ne!(
                active, attention,
                "style {style:?}: Running and NeedsAttention PNGs must have distinct content"
            );
        }
    }

    #[test]
    fn dark_variant_is_actually_dark() {
        // Regression guard for a pre-ship bug where tray-active-dark.png and
        // tray-attention-dark.png were byte-copies of the baseline colored
        // (green/orange) PNGs. A user picking "Dark" explicitly expects a
        // black monochrome tray, not a colored one — otherwise the setting
        // is a lie. The fix regenerates all Dark variants via `-colorize
        // black`, so they must differ from the baseline PNGs.
        for state in [
            TrayState::Idle,
            TrayState::Running(1),
            TrayState::NeedsAttention(1),
        ] {
            let (dark, _) = TrayIconStyle::Dark.icon_for(state);
            let (auto, _) = TrayIconStyle::Auto.icon_for(state);
            // On Linux, Auto delegates to Color — still different from Dark.
            assert_ne!(
                dark, auto,
                "Dark {state:?} must not be byte-identical to the baseline/Auto payload"
            );
        }
    }

    #[test]
    fn each_style_state_combo_returns_distinct_bytes() {
        // Ping that the include_bytes! asset map isn't collapsed — every
        // style+state combination should resolve to a non-empty payload,
        // and the Light vs Color variants at the same state should be
        // visibly distinct PNGs. (Dark is also distinct from Auto/Color
        // per the dedicated `dark_variant_is_actually_dark` test.)
        let mut seen: Vec<(TrayIconStyle, TrayState, &'static [u8])> = Vec::new();
        for style in [
            TrayIconStyle::Auto,
            TrayIconStyle::Light,
            TrayIconStyle::Dark,
            TrayIconStyle::Color,
        ] {
            for state in [
                TrayState::Idle,
                TrayState::Running(1),
                TrayState::NeedsAttention(1),
            ] {
                let (bytes, _) = style.icon_for(state);
                // Non-empty payload is a smoke check against include_bytes! failure.
                assert!(!bytes.is_empty(), "{style:?}/{state:?} has empty bytes");
                seen.push((style, state, bytes));
            }
        }
        // Any two entries for the same `state` but different non-Auto/non-Dark
        // styles should refer to visibly different payloads.
        let idle: Vec<_> = seen
            .iter()
            .filter(|(_, s, _)| matches!(s, TrayState::Idle))
            .collect();
        let light_bytes = idle
            .iter()
            .find(|(s, _, _)| *s == TrayIconStyle::Light)
            .unwrap()
            .2;
        let color_bytes = idle
            .iter()
            .find(|(s, _, _)| *s == TrayIconStyle::Color)
            .unwrap()
            .2;
        assert_ne!(
            light_bytes.as_ptr(),
            color_bytes.as_ptr(),
            "light and color idle icons must be distinct PNGs"
        );
    }

    #[test]
    fn resolve_sound_uses_per_event_override() {
        let settings = HashMap::from([
            ("notification_sound_ask".to_string(), "Bell".to_string()),
            ("notification_sound".to_string(), "Chime".to_string()),
            ("audio_notifications".to_string(), "false".to_string()),
        ]);
        let resolved = resolve_notification_sound_with(
            |key| settings.get(key).cloned(),
            NotificationEvent::Ask,
        );
        assert_eq!(resolved, "Bell");
    }

    #[test]
    fn resolve_sound_falls_back_to_global() {
        let settings = HashMap::from([("notification_sound".to_string(), "Chime".to_string())]);
        let resolved = resolve_notification_sound_with(
            |key| settings.get(key).cloned(),
            NotificationEvent::Plan,
        );
        assert_eq!(resolved, "Chime");
    }

    #[test]
    fn resolve_sound_legacy_audio_false_means_none() {
        let settings = HashMap::from([("audio_notifications".to_string(), "false".to_string())]);
        let resolved = resolve_notification_sound_with(
            |key| settings.get(key).cloned(),
            NotificationEvent::Finished,
        );
        assert_eq!(resolved, "None");
    }

    #[test]
    fn resolve_sound_defaults_when_no_settings() {
        let settings = HashMap::<String, String>::new();
        let resolved = resolve_notification_sound_with(
            |key| settings.get(key).cloned(),
            NotificationEvent::Finished,
        );
        assert_eq!(resolved, "Default");
    }
}
