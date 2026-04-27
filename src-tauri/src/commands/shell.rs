use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ShellType {
    Bash,
    Zsh,
    Fish,
    Unknown,
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
