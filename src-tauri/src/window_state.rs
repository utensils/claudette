use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{
    Manager, Monitor, PhysicalPosition, PhysicalSize, Position, Size, WebviewWindow, Window,
};

use claudette::db::Database;

use crate::state::AppState;

const MAIN_WINDOW_STATE_KEY: &str = "window:main";
const DEFAULT_WIDTH: u32 = 1200;
const DEFAULT_HEIGHT: u32 = 800;
const MIN_WIDTH: u32 = 600;
const MIN_HEIGHT: u32 = 400;
const SAVE_DEBOUNCE_MS: u64 = 250;

static SAVE_GENERATION: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedWindowState {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub maximized: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl SavedWindowState {
    fn rect(self) -> Rect {
        Rect {
            x: self.x,
            y: self.y,
            width: self.width,
            height: self.height,
        }
    }
}

pub fn restore_main_window(app: &tauri::App) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    let state = app.state::<AppState>();
    let raw_saved = Database::open(&state.db_path)
        .ok()
        .and_then(|db| db.get_app_setting(MAIN_WINDOW_STATE_KEY).ok().flatten());
    let saved = raw_saved.as_deref().and_then(parse_saved_state);

    let monitors = window.available_monitors().unwrap_or_default();
    let restored = saved
        .filter(|state| state_is_restoreable(*state, &monitors))
        .is_some_and(|state| apply_saved_state(&window, state).is_ok());

    if !restored {
        let _ = apply_default_bounds(&window);
        if should_maximize_default(raw_saved.as_deref()) {
            let _ = window.maximize();
        }
    }

    let _ = window.show();
    let _ = window.set_focus();
}

pub fn schedule_main_window_save(window: Window) {
    if window.label() != "main" {
        return;
    }

    let generation = SAVE_GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(SAVE_DEBOUNCE_MS)).await;
        if SAVE_GENERATION.load(Ordering::Relaxed) != generation {
            return;
        }
        if let Err(err) = save_window_state(&window) {
            eprintln!("[window-state] failed to save main window state: {err}");
        }
    });
}

pub fn save_main_window_now(window: &Window) {
    if window.label() != "main" {
        return;
    }
    SAVE_GENERATION.fetch_add(1, Ordering::Relaxed);
    if let Err(err) = save_window_state(window) {
        eprintln!("[window-state] failed to save main window state: {err}");
    }
}

fn save_window_state(window: &Window) -> Result<(), String> {
    let app = window.app_handle();
    let app_state = app.state::<AppState>();
    let db = Database::open(&app_state.db_path).map_err(|e| e.to_string())?;
    let existing = db
        .get_app_setting(MAIN_WINDOW_STATE_KEY)
        .map_err(|e| e.to_string())?
        .and_then(|raw| parse_saved_state(&raw));

    let maximized = window.is_maximized().unwrap_or(false);
    let fullscreen = window.is_fullscreen().unwrap_or(false);
    let next = build_next_state(existing, read_current_state(window)?, maximized, fullscreen);
    let raw = serde_json::to_string(&next).map_err(|e| e.to_string())?;
    db.set_app_setting(MAIN_WINDOW_STATE_KEY, &raw)
        .map_err(|e| e.to_string())
}

fn read_current_state(window: &Window) -> Result<SavedWindowState, String> {
    let position = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    Ok(SavedWindowState {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        maximized: false,
    })
}

fn apply_saved_state(window: &WebviewWindow, state: SavedWindowState) -> tauri::Result<()> {
    window.set_size(Size::Physical(PhysicalSize {
        width: state.width,
        height: state.height,
    }))?;
    window.set_position(Position::Physical(PhysicalPosition {
        x: state.x,
        y: state.y,
    }))?;
    if state.maximized {
        window.maximize()?;
    }
    Ok(())
}

fn apply_default_bounds(window: &WebviewWindow) -> tauri::Result<()> {
    window.set_size(Size::Physical(PhysicalSize {
        width: DEFAULT_WIDTH,
        height: DEFAULT_HEIGHT,
    }))?;
    window.center()
}

fn should_maximize_default(raw_saved: Option<&str>) -> bool {
    raw_saved.is_none()
}

fn parse_saved_state(raw: &str) -> Option<SavedWindowState> {
    serde_json::from_str::<SavedWindowState>(raw)
        .ok()
        .and_then(sanitize_state)
}

fn sanitize_state(state: SavedWindowState) -> Option<SavedWindowState> {
    if state.width < MIN_WIDTH || state.height < MIN_HEIGHT {
        return None;
    }
    Some(state)
}

fn build_next_state(
    existing: Option<SavedWindowState>,
    current: SavedWindowState,
    maximized: bool,
    fullscreen: bool,
) -> SavedWindowState {
    if fullscreen || maximized {
        let mut base = existing.unwrap_or(current);
        base.maximized = maximized && !fullscreen;
        return base;
    }

    SavedWindowState {
        maximized: false,
        ..current
    }
}

fn state_is_restoreable(state: SavedWindowState, monitors: &[Monitor]) -> bool {
    let rect = state.rect();
    if monitors.is_empty() {
        return true;
    }

    monitors.iter().any(|monitor| {
        let pos = monitor.position();
        let size = monitor.size();
        rects_intersect(
            rect,
            Rect {
                x: pos.x,
                y: pos.y,
                width: size.width,
                height: size.height,
            },
        )
    })
}

fn rects_intersect(a: Rect, b: Rect) -> bool {
    let a_right = i64::from(a.x) + i64::from(a.width);
    let a_bottom = i64::from(a.y) + i64::from(a.height);
    let b_right = i64::from(b.x) + i64::from(b.width);
    let b_bottom = i64::from(b.y) + i64::from(b.height);

    i64::from(a.x) < b_right
        && a_right > i64::from(b.x)
        && i64::from(a.y) < b_bottom
        && a_bottom > i64::from(b.y)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(x: i32, y: i32, width: u32, height: u32, maximized: bool) -> SavedWindowState {
        SavedWindowState {
            x,
            y,
            width,
            height,
            maximized,
        }
    }

    #[test]
    fn parse_saved_state_rejects_corrupt_json() {
        assert_eq!(parse_saved_state("{not json"), None);
    }

    #[test]
    fn parse_saved_state_rejects_too_small_bounds() {
        let raw = serde_json::to_string(&state(10, 20, 200, 100, false)).unwrap();
        assert_eq!(parse_saved_state(&raw), None);
    }

    #[test]
    fn build_next_state_updates_normal_bounds_when_not_maximized() {
        let current = state(10, 20, 1300, 900, false);
        assert_eq!(
            build_next_state(Some(state(1, 2, 800, 600, true)), current, false, false),
            current
        );
    }

    #[test]
    fn build_next_state_preserves_normal_bounds_when_maximized() {
        let previous = state(10, 20, 1300, 900, false);
        let maximized_bounds = state(0, 0, 7680, 2159, false);
        assert_eq!(
            build_next_state(Some(previous), maximized_bounds, true, false),
            state(10, 20, 1300, 900, true)
        );
    }

    #[test]
    fn build_next_state_does_not_restore_fullscreen() {
        let previous = state(10, 20, 1300, 900, false);
        let fullscreen_bounds = state(0, 0, 7680, 2159, false);
        assert_eq!(
            build_next_state(Some(previous), fullscreen_bounds, false, true),
            state(10, 20, 1300, 900, false)
        );
    }

    #[test]
    fn default_restore_maximizes_only_when_no_prior_state_exists() {
        assert!(should_maximize_default(None));
        assert!(!should_maximize_default(Some("{not json")));
    }

    #[test]
    fn rect_intersection_detects_overlap() {
        assert!(rects_intersect(
            Rect {
                x: 100,
                y: 100,
                width: 500,
                height: 400,
            },
            Rect {
                x: 0,
                y: 0,
                width: 1200,
                height: 800,
            },
        ));
    }

    #[test]
    fn rect_intersection_rejects_offscreen_bounds() {
        assert!(!rects_intersect(
            Rect {
                x: 2000,
                y: 100,
                width: 500,
                height: 400,
            },
            Rect {
                x: 0,
                y: 0,
                width: 1200,
                height: 800,
            },
        ));
    }
}
