use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ShellType {
    Bash,
    Zsh,
    Fish,
    Unknown,
}

#[derive(Serialize)]
pub struct SetupResult {
    script_path: String,
    rc_path: String,
    loader_code: String,
    already_integrated: bool,
}

pub fn detect_user_shell() -> (String, ShellType) {
    // Try $SHELL environment variable first
    if let Ok(shell) = std::env::var("SHELL") {
        let shell_type = match shell.as_str() {
            s if s.contains("bash") => ShellType::Bash,
            s if s.contains("zsh") => ShellType::Zsh,
            s if s.contains("fish") => ShellType::Fish,
            _ => ShellType::Unknown,
        };
        return (shell, shell_type);
    }

    // Fallback: use system default
    #[cfg(target_os = "macos")]
    let default = ("/bin/zsh".to_string(), ShellType::Zsh);

    #[cfg(target_os = "linux")]
    let default = ("/bin/bash".to_string(), ShellType::Bash);

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let default = ("/bin/sh".to_string(), ShellType::Unknown);

    default
}

fn generate_loader_code(shell_type: ShellType, script_path: &Path) -> String {
    let script_str = script_path.to_string_lossy();
    let date = chrono::Local::now().format("%Y-%m-%d");

    match shell_type {
        ShellType::Bash | ShellType::Zsh => format!(
            "# Claudette shell integration\n\
             # Auto-generated on {date}\n\
             # To disable, comment out or remove these lines\n\
             if [[ -n \"$CLAUDETTE_PTY\" ]]; then\n    \
                 source \"{script_str}\"\n\
             fi"
        ),
        ShellType::Fish => format!(
            "# Claudette shell integration\n\
             # Auto-generated on {date}\n\
             # To disable, comment out or remove these lines\n\
             if test -n \"$CLAUDETTE_PTY\"\n    \
                 source \"{script_str}\"\n\
             end"
        ),
        ShellType::Unknown => String::new(),
    }
}

#[tauri::command]
pub async fn setup_shell_integration() -> Result<SetupResult, String> {
    let (_, shell_type) = detect_user_shell();

    if shell_type == ShellType::Unknown {
        return Err("Unsupported shell".to_string());
    }

    let config_dir = dirs::config_dir()
        .ok_or("Could not find config directory")?
        .join("claudette");

    std::fs::create_dir_all(&config_dir)
        .map_err(|e| format!("Failed to create config dir: {e}"))?;

    // Write shell integration script
    let script_content = match shell_type {
        ShellType::Bash => include_str!("../../shell-integration.bash"),
        ShellType::Zsh => include_str!("../../shell-integration.zsh"),
        ShellType::Fish => include_str!("../../shell-integration.fish"),
        ShellType::Unknown => return Err("Unsupported shell".to_string()),
    };

    let script_filename = match shell_type {
        ShellType::Bash => "shell-integration.bash",
        ShellType::Zsh => "shell-integration.zsh",
        ShellType::Fish => "shell-integration.fish",
        ShellType::Unknown => return Err("Unsupported shell".to_string()),
    };

    let script_path = config_dir.join(script_filename);

    std::fs::write(&script_path, script_content)
        .map_err(|e| format!("Failed to write integration script: {e}"))?;

    // Determine RC file path
    let rc_path = match shell_type {
        ShellType::Bash => dirs::home_dir()
            .ok_or("Could not find home directory")?
            .join(".bashrc"),
        ShellType::Zsh => dirs::home_dir()
            .ok_or("Could not find home directory")?
            .join(".zshrc"),
        ShellType::Fish => dirs::config_dir()
            .ok_or("Could not find config directory")?
            .join("fish")
            .join("config.fish"),
        ShellType::Unknown => return Err("Unsupported shell".to_string()),
    };

    // Generate integration loader code
    let loader_code = generate_loader_code(shell_type, &script_path);

    // Check if already integrated
    let existing_content = std::fs::read_to_string(&rc_path).unwrap_or_default();
    let already_integrated = existing_content.contains("Claudette shell integration");

    Ok(SetupResult {
        script_path: script_path.to_string_lossy().to_string(),
        rc_path: rc_path.to_string_lossy().to_string(),
        loader_code,
        already_integrated,
    })
}

#[tauri::command]
pub async fn apply_shell_integration(rc_path: String, loader_code: String) -> Result<(), String> {
    let path = PathBuf::from(&rc_path);

    // Security: validate that the path is within home/config directory
    let home_dir = dirs::home_dir().ok_or("Could not find home directory")?;
    let config_dir = dirs::config_dir().ok_or("Could not find config directory")?;

    let canonical_path = path.canonicalize().unwrap_or_else(|_| {
        // If file doesn't exist yet, canonicalize the parent and append filename
        path.parent()
            .and_then(|p| p.canonicalize().ok())
            .map(|p| p.join(path.file_name().unwrap_or_default()))
            .unwrap_or_else(|| path.clone())
    });

    // Only allow writing to files under home or config directories
    if !canonical_path.starts_with(&home_dir) && !canonical_path.starts_with(&config_dir) {
        return Err(format!(
            "Invalid RC path: must be within home ({}) or config ({}) directory",
            home_dir.display(),
            config_dir.display()
        ));
    }

    // Ensure parent directory exists (for fish config)
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent directory: {e}"))?;
    }

    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(&path)
        .map_err(|e| format!("Failed to open RC file: {e}"))?;

    use std::io::Write;
    writeln!(file, "\n{loader_code}").map_err(|e| format!("Failed to write to RC file: {e}"))?;

    Ok(())
}

#[tauri::command]
pub async fn open_in_editor(path: String) -> Result<(), String> {
    // Open file in default editor using tauri-plugin-dialog
    tauri::async_runtime::spawn(async move {
        if let Err(e) = opener::open(&path) {
            eprintln!("Failed to open file in editor: {e}");
        }
    });
    Ok(())
}

/// Returns true if the URL uses a scheme safe for opening in the system browser.
fn is_safe_url_scheme(url: &str) -> bool {
    url.starts_with("http://") || url.starts_with("https://") || url.starts_with("mailto:")
}

#[tauri::command]
pub async fn open_url(url: String) -> Result<(), String> {
    if !is_safe_url_scheme(&url) {
        return Err(format!("Blocked URL with unsupported scheme: {url}"));
    }
    tauri::async_runtime::spawn(async move {
        if let Err(e) = opener::open(&url) {
            eprintln!("Failed to open URL in system browser: {e}");
        }
    });
    Ok(())
}

pub(crate) mod opener {
    use claudette::process::CommandWindowExt as _;
    use std::process::Command;

    pub fn open(path: &str) -> std::io::Result<()> {
        #[cfg(target_os = "macos")]
        let cmd = Command::new("open").no_console_window().arg(path).spawn();

        #[cfg(target_os = "linux")]
        let cmd = Command::new("xdg-open")
            .no_console_window()
            .arg(path)
            .spawn();

        #[cfg(target_os = "windows")]
        let cmd = Command::new("cmd")
            .no_console_window()
            .args(["/C", "start", "", path])
            .spawn();

        #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
        let cmd = Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "Unsupported platform",
        ));

        cmd.map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_safe_url_scheme_allows_http() {
        assert!(is_safe_url_scheme("http://example.com"));
    }

    #[test]
    fn is_safe_url_scheme_allows_https() {
        assert!(is_safe_url_scheme("https://github.com/utensils/claudette"));
    }

    #[test]
    fn is_safe_url_scheme_allows_mailto() {
        assert!(is_safe_url_scheme("mailto:user@example.com"));
    }

    #[test]
    fn is_safe_url_scheme_blocks_file() {
        assert!(!is_safe_url_scheme("file:///etc/passwd"));
    }

    #[test]
    fn is_safe_url_scheme_blocks_javascript() {
        assert!(!is_safe_url_scheme("javascript:alert(1)"));
    }

    #[test]
    fn is_safe_url_scheme_blocks_data() {
        assert!(!is_safe_url_scheme("data:text/html,<h1>hi</h1>"));
    }

    #[test]
    fn is_safe_url_scheme_blocks_empty() {
        assert!(!is_safe_url_scheme(""));
    }

    #[test]
    fn is_safe_url_scheme_blocks_relative_path() {
        assert!(!is_safe_url_scheme("/some/path"));
    }

    #[test]
    fn is_safe_url_scheme_blocks_fragment() {
        assert!(!is_safe_url_scheme("#section"));
    }
}
