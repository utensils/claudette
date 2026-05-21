#[cfg(target_os = "windows")]
use claudette::process::CommandWindowExt as _;
#[cfg(target_os = "macos")]
use std::process::Stdio;

use crate::state::AppState;

use super::config::load_apps_config;
use super::model::{AppCategory, AppEntry, DetectedApp};

/// Launch an app using macOS `open -a` command.
#[cfg(target_os = "macos")]
async fn open_macos_app(app_name: &str, target_path: &str) -> Result<(), String> {
    claudette::process::command("open")
        .args(["-a", app_name, target_path])
        .spawn()
        .map(crate::commands::settings::spawn_tokio_and_reap)
        .map_err(|e| format!("Failed to launch {app_name}: {e}"))?;
    Ok(())
}

/// Launch a terminal app via AppleScript (iTerm2, Terminal.app).
/// Uses `on run argv` + `quoted form of` to pass the path as an argument,
/// avoiding string interpolation and AppleScript injection risks.
#[cfg(target_os = "macos")]
async fn open_applescript(app_id: &str, worktree_path: &str) -> Result<(), String> {
    let script = match app_id {
        "iterm2" => {
            r#"on run argv
    set p to item 1 of argv
    set cmd to "cd " & quoted form of p & " && exec $SHELL"
    tell application "iTerm"
        activate
        if (count of windows) = 0 then
            create window with default profile command cmd
        else
            tell current window
                set newTab to (create tab with default profile)
                tell current session of newTab
                    write text cmd
                end tell
            end tell
        end if
    end tell
end run"#
        }
        "macos-terminal" => {
            r#"on run argv
    set p to item 1 of argv
    set cmd to "cd " & quoted form of p
    tell application "Terminal"
        activate
        do script cmd
    end tell
end run"#
        }
        other => return Err(format!("No AppleScript handler for app '{other}'")),
    };

    claudette::process::command("osascript")
        .arg("-e")
        .arg(script)
        .arg("--")
        .arg(worktree_path)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(crate::commands::settings::spawn_tokio_and_reap)
        .map_err(|e| format!("Failed to run AppleScript for {app_id}: {e}"))?;
    Ok(())
}

/// Determine the exec-separator args for launching an editor inside a given terminal.
fn terminal_exec_args(terminal_id: &str) -> &'static [&'static str] {
    match terminal_id {
        "alacritty" | "konsole" | "xfce4-terminal" => &["-e"],
        "gnome-terminal" => &["--"],
        // kitty, foot, wezterm, ghostty: just append the command directly.
        _ => &[],
    }
}

/// Shell-quote a string using single quotes (POSIX-safe).
/// e.g. `hello world` → `'hello world'`, `it's` → `'it'\''s'`
#[cfg(target_os = "macos")]
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Launch a TUI editor via AppleScript when only .app-bundle terminals are available (macOS).
/// Builds a fully shell-quoted command in Rust and passes it as a single argument
/// to avoid injection risks from paths or args with special characters.
#[cfg(target_os = "macos")]
async fn open_tui_via_applescript(
    editor_entry: &AppEntry,
    editor_detected: &DetectedApp,
    worktree_path: &str,
    terminal: &DetectedApp,
) -> Result<(), String> {
    // Build a properly shell-quoted command: cd '<path>' && '<editor>' '<arg1>' '<arg2>' ...
    let mut editor_parts = vec![shell_quote(&editor_detected.detected_path)];
    for arg in &editor_entry.open_args {
        editor_parts.push(shell_quote(&arg.replace("{}", ".")));
    }
    let full_cmd = format!(
        "cd {} && {}",
        shell_quote(worktree_path),
        editor_parts.join(" ")
    );

    let (app_name, script) = if terminal.id == "iterm2" {
        (
            "iTerm",
            r#"on run argv
    set cmd to item 1 of argv
    tell application "iTerm"
        activate
        if (count of windows) = 0 then
            create window with default profile command cmd
        else
            tell current window
                set newTab to (create tab with default profile)
                tell current session of newTab
                    write text cmd
                end tell
            end tell
        end if
    end tell
end run"#,
        )
    } else {
        (
            "Terminal",
            r#"on run argv
    set cmd to item 1 of argv
    tell application "Terminal"
        activate
        do script cmd
    end tell
end run"#,
        )
    };

    claudette::process::command("osascript")
        .arg("-e")
        .arg(script)
        .arg("--")
        .arg(&full_cmd)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(crate::commands::settings::spawn_tokio_and_reap)
        .map_err(|e| {
            format!(
                "Failed to launch {} in {app_name} via AppleScript: {e}",
                editor_entry.name
            )
        })?;
    Ok(())
}

/// Launch a TUI editor (needs_terminal=true) inside the best detected terminal.
/// Prefers terminals detected via binary path; falls back to AppleScript on macOS
/// when only .app-bundle terminals are available.
async fn open_in_terminal(
    editor_entry: &AppEntry,
    editor_detected: &DetectedApp,
    worktree_path: &str,
    state: &AppState,
) -> Result<(), String> {
    let config = load_apps_config();

    let detected_apps = state.detected_apps.read().await;

    // Prefer a terminal detected via a real binary (not a .app bundle),
    // because .app paths can't be passed to Command::new directly.
    let terminal = detected_apps
        .iter()
        .filter(|a| a.category == AppCategory::Terminal)
        .find(|a| !a.detected_path.ends_with(".app"))
        .or_else(|| {
            detected_apps
                .iter()
                .find(|a| a.category == AppCategory::Terminal)
        })
        .ok_or("No terminal emulator detected — cannot launch TUI editor")?
        .clone();
    drop(detected_apps);

    // If the terminal was detected via .app bundle, use AppleScript on macOS.
    #[cfg(target_os = "macos")]
    if terminal.detected_path.ends_with(".app") {
        return open_tui_via_applescript(editor_entry, editor_detected, worktree_path, &terminal)
            .await;
    }

    let terminal_entry = config
        .apps
        .iter()
        .find(|a| a.id == terminal.id)
        .ok_or_else(|| format!("Terminal '{}' not found in config", terminal.id))?;

    // Build: terminal_binary [terminal_open_args with {} -> path] [exec_separator] editor_binary [editor_open_args]
    let mut cmd = claudette::process::command(&terminal.detected_path);
    #[cfg(target_os = "windows")]
    cmd.new_console_window();

    for arg in &terminal_entry.open_args {
        cmd.arg(arg.replace("{}", worktree_path));
    }

    for arg in terminal_exec_args(&terminal.id) {
        cmd.arg(arg);
    }

    cmd.arg(&editor_detected.detected_path);
    for arg in &editor_entry.open_args {
        cmd.arg(arg.replace("{}", "."));
    }

    cmd.spawn()
        .map(crate::commands::settings::spawn_tokio_and_reap)
        .map_err(|e| {
            format!(
                "Failed to launch {} in {}: {e}",
                editor_entry.name, terminal.name
            )
        })?;
    Ok(())
}

pub(crate) async fn open_workspace_in_app_inner(
    app_id: &str,
    worktree_path: &str,
    state: &AppState,
) -> Result<(), String> {
    // Reload config each time so edits to open_args, needs_terminal, etc. take
    // effect without restart.  Note: the *detected apps list* (which apps appear
    // in the menu) is cached from startup; adding a new app requires restart.
    let config = load_apps_config();
    let entry = config
        .apps
        .iter()
        .find(|a| a.id == app_id)
        .ok_or_else(|| format!("App '{app_id}' not found in apps.json"))?
        .clone();

    // Handle AppleScript sentinel (iTerm2, Terminal.app).
    #[cfg(target_os = "macos")]
    if entry
        .open_args
        .first()
        .is_some_and(|a| a == "__applescript__")
    {
        return open_applescript(app_id, worktree_path).await;
    }

    #[cfg(target_os = "macos")]
    if entry.open_args.first().is_some_and(|a| a == "__open__") {
        claudette::process::command("open")
            .arg(worktree_path)
            .spawn()
            .map(crate::commands::settings::spawn_tokio_and_reap)
            .map_err(|e| format!("Failed to open workspace: {e}"))?;
        return Ok(());
    }

    // Handle __open_a__ sentinel (Xcode) — look up detected_path to get the .app bundle.
    #[cfg(target_os = "macos")]
    if entry.open_args.first().is_some_and(|a| a == "__open_a__") {
        let detected_apps = state.detected_apps.read().await;
        let detected = detected_apps
            .iter()
            .find(|a| a.id == app_id)
            .ok_or_else(|| format!("App '{app_id}' not detected on this system"))?;
        let app_path = detected.detected_path.clone();
        drop(detected_apps);
        return open_macos_app(&app_path, worktree_path).await;
    }

    // Look up the detected path for this app.
    let detected_apps = state.detected_apps.read().await;
    let detected = detected_apps
        .iter()
        .find(|a| a.id == app_id)
        .ok_or_else(|| format!("App '{app_id}' not detected on this system"))?
        .clone();
    drop(detected_apps);

    // Handle TUI editors that need a terminal host.
    if entry.needs_terminal {
        return open_in_terminal(&entry, &detected, worktree_path, state).await;
    }

    // Handle .app-only detection on macOS (CLI not in PATH).
    #[cfg(target_os = "macos")]
    if detected.detected_path.ends_with(".app") {
        return open_macos_app(&detected.detected_path, worktree_path).await;
    }

    // Normal binary launch: substitute {} in open_args with the worktree path.
    let args: Vec<String> = entry
        .open_args
        .iter()
        .map(|a| a.replace("{}", worktree_path))
        .collect();

    let mut cmd = claudette::process::command(&detected.detected_path);
    // Windows console terminals (cmd.exe, powershell.exe, pwsh.exe)
    // need a fresh, visible console of their own. The process helper
    // suppresses console allocation by default for everything else.
    // `wt.exe` ignores this flag because it activates the Windows Terminal
    // app via a separate process, so applying it to the Terminal category
    // is harmless there.
    #[cfg(target_os = "windows")]
    if entry.category == AppCategory::Terminal {
        cmd.new_console_window();
    }

    cmd.args(&args)
        .spawn()
        .map(crate::commands::settings::spawn_tokio_and_reap)
        .map_err(|e| format!("Failed to launch {}: {e}", entry.name))?;

    Ok(())
}
