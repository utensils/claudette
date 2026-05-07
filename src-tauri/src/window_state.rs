use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, Monitor, PhysicalPosition, PhysicalSize,
    Position, Size, WebviewWindow, Window,
};

use claudette::db::Database;

use crate::state::AppState;

const MAIN_WINDOW_STATE_KEY: &str = "window:main";
const DEFAULT_WIDTH: u32 = 1200;
const DEFAULT_HEIGHT: u32 = 800;
const MIN_WIDTH: u32 = 600;
const MIN_HEIGHT: u32 = 400;
const SAVE_DEBOUNCE_MS: u64 = 250;
const RESTORE_SAVE_SUPPRESSION_MS: u64 = 1_500;
const RESTORE_SETTLE_SAVE_MS: u64 = 900;

static SAVE_GENERATION: AtomicU64 = AtomicU64::new(0);
static SUPPRESS_SAVE_UNTIL_MS: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SavedWindowState {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub maximized: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logical_x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logical_y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logical_width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logical_height: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale_factor: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub monitor_x: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub monitor_y: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub monitor_width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub monitor_height: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct MonitorSnapshot {
    rect: Rect,
    scale_factor: f64,
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

    suppress_saves_for(Duration::from_millis(RESTORE_SAVE_SUPPRESSION_MS));

    let state = app.state::<AppState>();
    let db = Database::open(&state.db_path).ok();
    let raw_saved = db
        .as_ref()
        .and_then(|db| db.get_app_setting(MAIN_WINDOW_STATE_KEY).ok().flatten());
    let saved = raw_saved.as_deref().and_then(parse_saved_state);

    let monitors = window.available_monitors().unwrap_or_default();
    let restored = saved
        .map(|state| restoreable_state(state, &monitors))
        .is_some_and(|state| apply_saved_state(&window, state).is_ok());

    if !restored {
        let _ = apply_default_bounds(&window);
        if should_maximize_default(raw_saved.as_deref()) {
            if let Some(db) = db.as_ref()
                && let Err(err) = seed_default_maximized_state(db, &window)
            {
                eprintln!("[window-state] failed to seed default window state: {err}");
            }
            let _ = window.maximize();
        }
    }

    let _ = window.show();
    let _ = window.set_focus();
    save_after_restore_settles(window);
}

pub fn schedule_main_window_save(window: Window) {
    if window.label() != "main" {
        return;
    }
    if saves_are_suppressed() {
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
    if saves_are_suppressed() {
        return;
    }
    SAVE_GENERATION.fetch_add(1, Ordering::Relaxed);
    if let Err(err) = save_window_state(window) {
        eprintln!("[window-state] failed to save main window state: {err}");
    }
}

fn save_after_restore_settles(window: WebviewWindow) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(RESTORE_SETTLE_SAVE_MS)).await;
        SAVE_GENERATION.fetch_add(1, Ordering::Relaxed);
        if let Err(err) = save_window_state(&window) {
            eprintln!("[window-state] failed to save settled main window state: {err}");
        }
    });
}

fn suppress_saves_for(duration: Duration) {
    let until = unix_time_millis().saturating_add(duration.as_millis() as u64);
    SUPPRESS_SAVE_UNTIL_MS.store(until, Ordering::Relaxed);
}

fn saves_are_suppressed() -> bool {
    unix_time_millis() < SUPPRESS_SAVE_UNTIL_MS.load(Ordering::Relaxed)
}

fn unix_time_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

trait WindowStateSource {
    fn app_handle(&self) -> &AppHandle;
    fn outer_position(&self) -> tauri::Result<PhysicalPosition<i32>>;
    fn inner_size(&self) -> tauri::Result<PhysicalSize<u32>>;
    fn current_monitor(&self) -> tauri::Result<Option<Monitor>>;
    fn scale_factor(&self) -> tauri::Result<f64>;
    fn is_maximized(&self) -> tauri::Result<bool>;
    fn is_fullscreen(&self) -> tauri::Result<bool>;
}

impl WindowStateSource for Window {
    fn app_handle(&self) -> &AppHandle {
        tauri::Manager::app_handle(self)
    }

    fn outer_position(&self) -> tauri::Result<PhysicalPosition<i32>> {
        self.outer_position()
    }

    fn inner_size(&self) -> tauri::Result<PhysicalSize<u32>> {
        self.inner_size()
    }

    fn current_monitor(&self) -> tauri::Result<Option<Monitor>> {
        self.current_monitor()
    }

    fn scale_factor(&self) -> tauri::Result<f64> {
        self.scale_factor()
    }

    fn is_maximized(&self) -> tauri::Result<bool> {
        self.is_maximized()
    }

    fn is_fullscreen(&self) -> tauri::Result<bool> {
        self.is_fullscreen()
    }
}

impl WindowStateSource for WebviewWindow {
    fn app_handle(&self) -> &AppHandle {
        tauri::Manager::app_handle(self)
    }

    fn outer_position(&self) -> tauri::Result<PhysicalPosition<i32>> {
        self.outer_position()
    }

    fn inner_size(&self) -> tauri::Result<PhysicalSize<u32>> {
        self.inner_size()
    }

    fn current_monitor(&self) -> tauri::Result<Option<Monitor>> {
        self.current_monitor()
    }

    fn scale_factor(&self) -> tauri::Result<f64> {
        self.scale_factor()
    }

    fn is_maximized(&self) -> tauri::Result<bool> {
        self.is_maximized()
    }

    fn is_fullscreen(&self) -> tauri::Result<bool> {
        self.is_fullscreen()
    }
}

fn save_window_state(window: &impl WindowStateSource) -> Result<(), String> {
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

fn read_current_state(window: &impl WindowStateSource) -> Result<SavedWindowState, String> {
    let position = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let monitor = window.current_monitor().map_err(|e| e.to_string())?;
    let scale_factor = monitor
        .as_ref()
        .map(Monitor::scale_factor)
        .or_else(|| window.scale_factor().ok())
        .filter(|scale| scale.is_finite() && *scale > 0.0);
    let monitor_rect = monitor.as_ref().map(monitor_to_rect);
    Ok(SavedWindowState {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        maximized: false,
        logical_x: scale_factor.map(|scale| f64::from(position.x) / scale),
        logical_y: scale_factor.map(|scale| f64::from(position.y) / scale),
        logical_width: scale_factor.map(|scale| f64::from(size.width) / scale),
        logical_height: scale_factor.map(|scale| f64::from(size.height) / scale),
        scale_factor,
        monitor_x: monitor_rect.map(|rect| rect.x),
        monitor_y: monitor_rect.map(|rect| rect.y),
        monitor_width: monitor_rect.map(|rect| rect.width),
        monitor_height: monitor_rect.map(|rect| rect.height),
    })
}

fn apply_saved_state(window: &WebviewWindow, state: SavedWindowState) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    {
        if apply_saved_state_macos(window, state).is_ok() {
            if state.maximized {
                window.maximize()?;
            }
            return Ok(());
        }
    }

    if let (Some(width), Some(height)) = (state.logical_width, state.logical_height) {
        window.set_size(Size::Logical(LogicalSize { width, height }))?;
    } else {
        window.set_size(Size::Physical(PhysicalSize {
            width: state.width,
            height: state.height,
        }))?;
    }
    if let (Some(x), Some(y)) = (state.logical_x, state.logical_y) {
        window.set_position(Position::Logical(LogicalPosition { x, y }))?;
    } else {
        window.set_position(Position::Physical(PhysicalPosition {
            x: state.x,
            y: state.y,
        }))?;
    }
    if state.maximized {
        window.maximize()?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn apply_saved_state_macos(window: &WebviewWindow, state: SavedWindowState) -> Result<(), String> {
    macos_window_restore::apply(window, state).map_err(|err| err.to_string())
}

fn apply_default_bounds(window: &WebviewWindow) -> tauri::Result<()> {
    window.set_size(Size::Physical(PhysicalSize {
        width: DEFAULT_WIDTH,
        height: DEFAULT_HEIGHT,
    }))?;
    window.center()
}

fn seed_default_maximized_state(db: &Database, window: &WebviewWindow) -> Result<(), String> {
    let position = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let monitor = window.current_monitor().map_err(|e| e.to_string())?;
    let scale_factor = monitor
        .as_ref()
        .map(Monitor::scale_factor)
        .or_else(|| window.scale_factor().ok())
        .filter(|scale| scale.is_finite() && *scale > 0.0);
    let monitor_rect = monitor.as_ref().map(monitor_to_rect);
    let raw = serde_json::to_string(&SavedWindowState {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
        maximized: true,
        logical_x: scale_factor.map(|scale| f64::from(position.x) / scale),
        logical_y: scale_factor.map(|scale| f64::from(position.y) / scale),
        logical_width: scale_factor.map(|scale| f64::from(size.width) / scale),
        logical_height: scale_factor.map(|scale| f64::from(size.height) / scale),
        scale_factor,
        monitor_x: monitor_rect.map(|rect| rect.x),
        monitor_y: monitor_rect.map(|rect| rect.y),
        monitor_width: monitor_rect.map(|rect| rect.width),
        monitor_height: monitor_rect.map(|rect| rect.height),
    })
    .map_err(|e| e.to_string())?;
    db.set_app_setting(MAIN_WINDOW_STATE_KEY, &raw)
        .map_err(|e| e.to_string())
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
        let mut base = existing.unwrap_or_else(|| default_normal_state(current));
        base.maximized = maximized && !fullscreen;
        return base;
    }

    SavedWindowState {
        maximized: false,
        ..current
    }
}

fn default_normal_state(current: SavedWindowState) -> SavedWindowState {
    let scale_factor = current
        .scale_factor
        .filter(|scale| scale.is_finite() && *scale > 0.0);
    SavedWindowState {
        width: DEFAULT_WIDTH,
        height: DEFAULT_HEIGHT,
        logical_width: scale_factor.map(|scale| f64::from(DEFAULT_WIDTH) / scale),
        logical_height: scale_factor.map(|scale| f64::from(DEFAULT_HEIGHT) / scale),
        maximized: false,
        ..current
    }
}

fn restoreable_state(state: SavedWindowState, monitors: &[Monitor]) -> SavedWindowState {
    restoreable_state_for_monitors(state, &monitor_snapshots(monitors))
}

fn monitor_snapshots(monitors: &[Monitor]) -> Vec<MonitorSnapshot> {
    monitors
        .iter()
        .map(|monitor| {
            let scale_factor = monitor.scale_factor();
            MonitorSnapshot {
                rect: monitor_to_rect(monitor),
                scale_factor: if scale_factor.is_finite() && scale_factor > 0.0 {
                    scale_factor
                } else {
                    1.0
                },
            }
        })
        .collect()
}

fn monitor_to_rect(monitor: &Monitor) -> Rect {
    let pos = monitor.position();
    let size = monitor.size();
    Rect {
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
    }
}

#[cfg(test)]
fn restoreable_state_for_rects(
    state: SavedWindowState,
    monitor_rects: &[Rect],
) -> SavedWindowState {
    let monitors = monitor_rects
        .iter()
        .copied()
        .map(|rect| MonitorSnapshot {
            rect,
            scale_factor: 1.0,
        })
        .collect::<Vec<_>>();
    restoreable_state_for_monitors(state, &monitors)
}

fn restoreable_state_for_monitors(
    state: SavedWindowState,
    monitors: &[MonitorSnapshot],
) -> SavedWindowState {
    if monitors.is_empty() {
        return state;
    }

    let rect = state.rect();
    let target_monitor = saved_monitor_rect(state)
        .and_then(|saved_monitor| matching_monitor(saved_monitor, monitors))
        .or_else(|| {
            monitors
                .iter()
                .copied()
                .find(|monitor| rects_intersect(rect, monitor.rect))
        })
        .unwrap_or_else(|| nearest_monitor(state, monitors));
    let target_rect = scaled_rect_for_target_monitor(state, target_monitor);
    let clamped = clamp_rect_to_monitor(target_rect, target_monitor.rect);

    SavedWindowState {
        x: clamped.x,
        y: clamped.y,
        width: clamped.width,
        height: clamped.height,
        maximized: state.maximized,
        logical_x: Some(f64::from(clamped.x) / target_monitor.scale_factor),
        logical_y: Some(f64::from(clamped.y) / target_monitor.scale_factor),
        logical_width: Some(f64::from(clamped.width) / target_monitor.scale_factor),
        logical_height: Some(f64::from(clamped.height) / target_monitor.scale_factor),
        scale_factor: Some(target_monitor.scale_factor),
        monitor_x: Some(target_monitor.rect.x),
        monitor_y: Some(target_monitor.rect.y),
        monitor_width: Some(target_monitor.rect.width),
        monitor_height: Some(target_monitor.rect.height),
    }
}

fn nearest_monitor(state: SavedWindowState, candidates: &[MonitorSnapshot]) -> MonitorSnapshot {
    let rect = saved_monitor_rect(state).unwrap_or_else(|| state.rect());
    candidates
        .iter()
        .copied()
        .min_by_key(|candidate| squared_distance_between_centers(rect, candidate.rect))
        .unwrap_or(MonitorSnapshot {
            rect: state.rect(),
            scale_factor: state.scale_factor.unwrap_or(1.0),
        })
}

fn matching_monitor(
    saved_monitor: Rect,
    candidates: &[MonitorSnapshot],
) -> Option<MonitorSnapshot> {
    candidates
        .iter()
        .copied()
        .filter(|candidate| {
            candidate.rect.width == saved_monitor.width
                && candidate.rect.height == saved_monitor.height
        })
        .min_by_key(|candidate| squared_distance_between_centers(saved_monitor, candidate.rect))
}

fn scaled_rect_for_target_monitor(state: SavedWindowState, target: MonitorSnapshot) -> Rect {
    let saved_monitor = saved_monitor_rect(state);
    let saved_scale_factor = state
        .scale_factor
        .filter(|scale| scale.is_finite() && *scale > 0.0)
        .unwrap_or(target.scale_factor);
    let mut width = state
        .logical_width
        .filter(|width| width.is_finite() && *width > 0.0)
        .map(|width| logical_to_physical(width, target.scale_factor))
        .unwrap_or_else(|| {
            scale_physical_between_monitors(state.width, saved_scale_factor, target.scale_factor)
        });
    let mut height = state
        .logical_height
        .filter(|height| height.is_finite() && *height > 0.0)
        .map(|height| logical_to_physical(height, target.scale_factor))
        .unwrap_or_else(|| {
            scale_physical_between_monitors(state.height, saved_scale_factor, target.scale_factor)
        });
    if state.logical_width.is_none()
        && state.logical_height.is_none()
        && state.scale_factor.is_none()
        && let Some((legacy_width, legacy_height)) =
            infer_legacy_scaled_size(width, height, target.rect)
    {
        width = legacy_width;
        height = legacy_height;
    }

    let (x, y) = if let Some(saved_monitor) = saved_monitor {
        let relative_x =
            (f64::from(state.x - saved_monitor.x) / saved_scale_factor) * target.scale_factor;
        let relative_y =
            (f64::from(state.y - saved_monitor.y) / saved_scale_factor) * target.scale_factor;
        (
            f64_to_i32(f64::from(target.rect.x) + relative_x),
            f64_to_i32(f64::from(target.rect.y) + relative_y),
        )
    } else {
        (state.x, state.y)
    };

    Rect {
        x,
        y,
        width,
        height,
    }
}

fn saved_monitor_rect(state: SavedWindowState) -> Option<Rect> {
    Some(Rect {
        x: state.monitor_x?,
        y: state.monitor_y?,
        width: state.monitor_width?,
        height: state.monitor_height?,
    })
}

fn logical_to_physical(value: f64, scale_factor: f64) -> u32 {
    f64_to_u32(value * scale_factor)
}

fn scale_physical_between_monitors(
    value: u32,
    saved_scale_factor: f64,
    target_scale_factor: f64,
) -> u32 {
    let logical = f64::from(value) / saved_scale_factor;
    logical_to_physical(logical, target_scale_factor)
}

fn infer_legacy_scaled_size(width: u32, height: u32, target: Rect) -> Option<(u32, u32)> {
    if width <= target.width && height <= target.height {
        return None;
    }

    [2.0, 1.75, 1.5, 1.25].into_iter().find_map(|scale| {
        let scaled_width = f64_to_u32(f64::from(width) / scale);
        let scaled_height = f64_to_u32(f64::from(height) / scale);
        (scaled_width >= MIN_WIDTH
            && scaled_height >= MIN_HEIGHT
            && scaled_width <= target.width
            && scaled_height <= target.height)
            .then_some((scaled_width, scaled_height))
    })
}

fn f64_to_u32(value: f64) -> u32 {
    value.round().clamp(1.0, f64::from(u32::MAX)) as u32
}

fn f64_to_i32(value: f64) -> i32 {
    value
        .round()
        .clamp(f64::from(i32::MIN), f64::from(i32::MAX)) as i32
}

fn clamp_rect_to_monitor(rect: Rect, monitor: Rect) -> Rect {
    let width = rect.width.min(monitor.width.max(MIN_WIDTH));
    let height = rect.height.min(monitor.height.max(MIN_HEIGHT));
    Rect {
        x: clamp_axis(rect.x, width, monitor.x, monitor.width),
        y: clamp_axis(rect.y, height, monitor.y, monitor.height),
        width,
        height,
    }
}

fn clamp_axis(value: i32, size: u32, monitor_start: i32, monitor_size: u32) -> i32 {
    let min = i64::from(monitor_start);
    let max = i64::from(monitor_start) + i64::from(monitor_size.saturating_sub(size));
    i64::from(value).clamp(min, max) as i32
}

fn squared_distance_between_centers(a: Rect, b: Rect) -> i64 {
    let ax = i64::from(a.x) * 2 + i64::from(a.width);
    let ay = i64::from(a.y) * 2 + i64::from(a.height);
    let bx = i64::from(b.x) * 2 + i64::from(b.width);
    let by = i64::from(b.y) * 2 + i64::from(b.height);
    (ax - bx).pow(2) + (ay - by).pow(2)
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

#[cfg(target_os = "macos")]
#[allow(unexpected_cfgs)]
mod macos_window_restore {
    use objc::{msg_send, sel, sel_impl};
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    use super::{SavedWindowState, WebviewWindow};

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct NSPoint {
        x: f64,
        y: f64,
    }

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct NSSize {
        width: f64,
        height: f64,
    }

    pub fn apply(window: &WebviewWindow, state: SavedWindowState) -> Result<(), String> {
        let ns_window = ns_window_ptr(window)?;
        let width = state.logical_width.unwrap_or(f64::from(state.width));
        let height = state.logical_height.unwrap_or(f64::from(state.height));
        let x = state.logical_x.unwrap_or(f64::from(state.x));
        let y = state.logical_y.unwrap_or(f64::from(state.y));
        let main_display_height = main_display_height()?;

        unsafe {
            let _: () = msg_send![ns_window, setContentSize: NSSize { width, height }];
            let point = NSPoint {
                x,
                y: main_display_height - y,
            };
            let _: () = msg_send![ns_window, setFrameTopLeftPoint: point];
        }

        Ok(())
    }

    fn ns_window_ptr(window: &WebviewWindow) -> Result<*mut objc::runtime::Object, String> {
        let handle = window
            .window_handle()
            .map_err(|err| format!("window handle unavailable: {err}"))?;
        let RawWindowHandle::AppKit(appkit) = handle.as_raw() else {
            return Err("not an AppKit window".to_string());
        };
        let ns_view = appkit.ns_view.as_ptr() as *mut objc::runtime::Object;
        if ns_view.is_null() {
            return Err("AppKit NSView pointer was null".to_string());
        }
        let ns_window = unsafe {
            let window: *mut objc::runtime::Object = msg_send![ns_view, window];
            window
        };
        if ns_window.is_null() {
            return Err("AppKit NSWindow pointer was null".to_string());
        }
        Ok(ns_window)
    }

    fn main_display_height() -> Result<f64, String> {
        #[link(name = "CoreGraphics", kind = "framework")]
        unsafe extern "C" {
            fn CGMainDisplayID() -> u32;
            fn CGDisplayPixelsHigh(display: u32) -> usize;
        }

        let display = unsafe { CGMainDisplayID() };
        let height = unsafe { CGDisplayPixelsHigh(display) } as f64;
        if height > 0.0 {
            Ok(height)
        } else {
            Err("main display height unavailable".to_string())
        }
    }
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
            logical_x: None,
            logical_y: None,
            logical_width: None,
            logical_height: None,
            scale_factor: None,
            monitor_x: None,
            monitor_y: None,
            monitor_width: None,
            monitor_height: None,
        }
    }

    fn state_with_monitor(
        x: i32,
        y: i32,
        width: u32,
        height: u32,
        scale_factor: f64,
        monitor: Rect,
    ) -> SavedWindowState {
        SavedWindowState {
            x,
            y,
            width,
            height,
            maximized: false,
            logical_x: Some(f64::from(x) / scale_factor),
            logical_y: Some(f64::from(y) / scale_factor),
            logical_width: Some(f64::from(width) / scale_factor),
            logical_height: Some(f64::from(height) / scale_factor),
            scale_factor: Some(scale_factor),
            monitor_x: Some(monitor.x),
            monitor_y: Some(monitor.y),
            monitor_width: Some(monitor.width),
            monitor_height: Some(monitor.height),
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
    fn build_next_state_uses_default_normal_bounds_when_first_seen_maximized() {
        let maximized_bounds = SavedWindowState {
            scale_factor: Some(2.0),
            logical_width: Some(3840.0),
            logical_height: Some(1080.0),
            ..state(0, 0, 7680, 2160, false)
        };

        assert_eq!(
            build_next_state(None, maximized_bounds, true, false),
            SavedWindowState {
                width: DEFAULT_WIDTH,
                height: DEFAULT_HEIGHT,
                maximized: true,
                logical_width: Some(f64::from(DEFAULT_WIDTH) / 2.0),
                logical_height: Some(f64::from(DEFAULT_HEIGHT) / 2.0),
                ..maximized_bounds
            }
        );
    }

    #[test]
    fn build_next_state_uses_default_normal_bounds_when_first_seen_fullscreen() {
        let fullscreen_bounds = state(0, 0, 7680, 2160, false);

        assert_eq!(
            build_next_state(None, fullscreen_bounds, false, true),
            state(0, 0, DEFAULT_WIDTH, DEFAULT_HEIGHT, false)
        );
    }

    #[test]
    fn default_restore_maximizes_only_when_no_prior_state_exists() {
        assert!(should_maximize_default(None));
        assert!(!should_maximize_default(Some("{not json")));
    }

    #[test]
    fn restoreable_state_preserves_size_when_saved_rect_intersects_monitor() {
        let saved = state(-1790, 70, 1716, 944, false);
        let restored = restoreable_state_for_rects(
            saved,
            &[
                Rect {
                    x: -1920,
                    y: 0,
                    width: 1920,
                    height: 1080,
                },
                Rect {
                    x: 0,
                    y: 0,
                    width: 2560,
                    height: 1440,
                },
            ],
        );
        assert_eq!(restored.x, saved.x);
        assert_eq!(restored.y, saved.y);
        assert_eq!(restored.width, saved.width);
        assert_eq!(restored.height, saved.height);
    }

    #[test]
    fn restoreable_state_clamps_offscreen_position_without_using_default_size() {
        let restored = restoreable_state_for_rects(
            state(5000, 200, 1716, 944, false),
            &[Rect {
                x: 0,
                y: 0,
                width: 2560,
                height: 1440,
            }],
        );
        assert_eq!(restored.width, 1716);
        assert_eq!(restored.height, 944);
        assert_eq!(restored.x, 844);
        assert_eq!(restored.y, 200);
    }

    #[test]
    fn restoreable_state_shrinks_only_when_saved_size_exceeds_monitor() {
        let restored = restoreable_state_for_rects(
            state(0, 0, 7680, 2159, false),
            &[Rect {
                x: 0,
                y: 0,
                width: 2560,
                height: 1440,
            }],
        );
        assert_eq!(restored.width, 2560);
        assert_eq!(restored.height, 1440);
    }

    #[test]
    fn restoreable_state_uses_logical_size_on_different_scale_monitor() {
        let saved_monitor = Rect {
            x: -3000,
            y: 0,
            width: 3000,
            height: 2000,
        };
        let saved = state_with_monitor(-2800, 200, 2400, 1600, 2.0, saved_monitor);
        let restored = restoreable_state_for_monitors(
            saved,
            &[MonitorSnapshot {
                rect: Rect {
                    x: 0,
                    y: 0,
                    width: 1920,
                    height: 1080,
                },
                scale_factor: 1.0,
            }],
        );
        assert_eq!(restored.width, 1200);
        assert_eq!(restored.height, 800);
        assert_eq!(restored.logical_x, Some(100.0));
        assert_eq!(restored.logical_y, Some(100.0));
        assert_eq!(restored.logical_width, Some(1200.0));
        assert_eq!(restored.logical_height, Some(800.0));
        assert_eq!(restored.x, 100);
        assert_eq!(restored.y, 100);
    }

    #[test]
    fn restoreable_state_scales_logical_size_up_for_high_dpi_target() {
        let saved_monitor = Rect {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        };
        let saved = state_with_monitor(100, 100, 1200, 800, 1.0, saved_monitor);
        let restored = restoreable_state_for_monitors(
            saved,
            &[MonitorSnapshot {
                rect: Rect {
                    x: -3000,
                    y: 0,
                    width: 3000,
                    height: 2000,
                },
                scale_factor: 2.0,
            }],
        );
        assert_eq!(restored.width, 2400);
        assert_eq!(restored.height, 1600);
        assert_eq!(restored.logical_x, Some(-1400.0));
        assert_eq!(restored.logical_y, Some(100.0));
        assert_eq!(restored.logical_width, Some(1200.0));
        assert_eq!(restored.logical_height, Some(800.0));
        assert_eq!(restored.x, -2800);
        assert_eq!(restored.y, 200);
    }

    #[test]
    fn restoreable_state_infers_legacy_high_dpi_size_before_clamping() {
        let restored = restoreable_state_for_monitors(
            state(5000, 100, 2400, 1600, false),
            &[MonitorSnapshot {
                rect: Rect {
                    x: 0,
                    y: 0,
                    width: 1920,
                    height: 1080,
                },
                scale_factor: 1.0,
            }],
        );
        assert_eq!(restored.width, 1200);
        assert_eq!(restored.height, 800);
        assert_eq!(restored.logical_x, Some(720.0));
        assert_eq!(restored.logical_y, Some(100.0));
        assert_eq!(restored.logical_width, Some(1200.0));
        assert_eq!(restored.logical_height, Some(800.0));
        assert_eq!(restored.x, 720);
        assert_eq!(restored.y, 100);
    }

    #[test]
    fn restoreable_state_prefers_saved_monitor_when_bounds_overlap_retina_main() {
        let saved_monitor = Rect {
            x: 2056,
            y: -26,
            width: 3440,
            height: 1440,
        };
        let saved = state_with_monitor(2550, 95, 1650, 900, 1.0, saved_monitor);
        let restored = restoreable_state_for_monitors(
            saved,
            &[
                MonitorSnapshot {
                    rect: Rect {
                        x: 0,
                        y: 0,
                        width: 4112,
                        height: 2658,
                    },
                    scale_factor: 2.0,
                },
                MonitorSnapshot {
                    rect: Rect {
                        x: -5120,
                        y: 0,
                        width: 5120,
                        height: 1440,
                    },
                    scale_factor: 1.0,
                },
                MonitorSnapshot {
                    rect: saved_monitor,
                    scale_factor: 1.0,
                },
            ],
        );
        assert_eq!(restored.x, 2550);
        assert_eq!(restored.y, 95);
        assert_eq!(restored.width, 1650);
        assert_eq!(restored.height, 900);
        assert_eq!(restored.monitor_x, Some(2056));
        assert_eq!(restored.monitor_width, Some(3440));
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
