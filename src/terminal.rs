use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use iced_term::settings::{BackendSettings, FontSettings, Settings, ThemeSettings};
use iced_term::{ColorPalette, Terminal};

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// Seed the ID counter so it starts above any existing DB IDs.
/// Call once at startup with the max terminal_tab id from the database.
pub fn seed_next_id(max_existing: u64) {
    NEXT_ID.store(max_existing + 1, Ordering::Relaxed);
}

/// Generate a unique terminal ID (monotonically increasing).
pub fn next_terminal_id() -> u64 {
    NEXT_ID.fetch_add(1, Ordering::Relaxed)
}

/// Create an interactive shell terminal in the given working directory.
pub fn create_terminal(id: u64, working_dir: &Path) -> std::io::Result<Terminal> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
    let settings = Settings {
        font: FontSettings::default(),
        theme: terminal_theme(),
        backend: BackendSettings {
            program: shell,
            args: vec![],
            env: Default::default(),
            working_directory: Some(working_dir.to_path_buf()),
        },
    };
    Terminal::new(id, settings)
}

/// Create a terminal that runs a specific command (for script output tabs).
pub fn create_script_terminal(
    id: u64,
    working_dir: &Path,
    command: &str,
) -> std::io::Result<Terminal> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
    let settings = Settings {
        font: FontSettings::default(),
        theme: terminal_theme(),
        backend: BackendSettings {
            program: shell,
            args: vec!["-c".to_string(), command.to_string()],
            env: Default::default(),
            working_directory: Some(working_dir.to_path_buf()),
        },
    };
    Terminal::new(id, settings)
}

fn terminal_theme() -> ThemeSettings {
    ThemeSettings::new(Box::new(ColorPalette {
        foreground: "#e6e6ea".to_string(),
        background: "#14141a".to_string(),
        black: "#14141a".to_string(),
        red: "#e64d4d".to_string(),
        green: "#33cc4d".to_string(),
        yellow: "#e6b333".to_string(),
        blue: "#6b9fb5".to_string(),
        magenta: "#aa759f".to_string(),
        cyan: "#75b5aa".to_string(),
        white: "#e6e6ea".to_string(),
        bright_black: "#6b6b6b".to_string(),
        bright_red: "#ff6666".to_string(),
        bright_green: "#66ff80".to_string(),
        bright_yellow: "#ffcc66".to_string(),
        bright_blue: "#82b8c8".to_string(),
        bright_magenta: "#c28cb8".to_string(),
        bright_cyan: "#93d3c3".to_string(),
        bright_white: "#f8f8f8".to_string(),
        bright_foreground: None,
        dim_foreground: "#828482".to_string(),
        dim_black: "#0f0f0f".to_string(),
        dim_red: "#712b2b".to_string(),
        dim_green: "#5f6f3a".to_string(),
        dim_yellow: "#a17e4d".to_string(),
        dim_blue: "#456877".to_string(),
        dim_magenta: "#704d68".to_string(),
        dim_cyan: "#4d7770".to_string(),
        dim_white: "#8e8e8e".to_string(),
    }))
}
