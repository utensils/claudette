// Prevents additional console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent_mcp_sink;
mod app_info;
mod commands;
mod ipc;
mod mdns;
mod missing_cli;
mod ops_hooks;
#[cfg(feature = "voice")]
mod platform_speech;
mod pty;
mod pty_tracker;
mod remote;
mod state;
mod subprocess_cleanup;
mod transport;
mod tray;
mod usage;
#[cfg(feature = "voice")]
mod voice;
mod webview2_check;
mod window_state;

use std::path::{Path, PathBuf};

/// RAII holder for the running IPC server + its discovery file. Tauri's
/// managed-state container drops both on shutdown, ensuring the socket
/// file is unlinked and `app.json` is removed.
struct IpcGuard {
    _server: ipc::IpcServer,
    _file: app_info::AppInfoFile,
}

/// RFC 3339 / ISO 8601 timestamp builder for the discovery file's
/// `started_at`. `chrono` is already a workspace dep (used elsewhere
/// in this file), so we just delegate.
fn chrono_iso_now() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Best-effort warning when another live Claudette dev instance is
/// likely running against the same database. We do **not** block the
/// second launch — multi-instance dev is a supported workflow — but
/// two processes against the same SQLite file is the most plausible
/// origin of cross-session message bleed-through (insert paths race
/// on `chat_messages.chat_session_id`, transcript JSONLs in
/// `~/.claude/projects/<encoded-cwd>/<sid>.jsonl` interleave). Surfacing
/// the collision in the log lets postmortems start with "two PIDs were
/// alive at the same time" rather than guessing.
///
/// `scripts/dev.sh` drops `${TMPDIR}/claudette-dev/<pid>.json` when it
/// launches; we scan that directory, cross-reference with the live
/// process table, and emit a `tracing::warn!` if any other live PID is
/// found. Stale files from crashed dev runs are ignored (PID not
/// alive). Release builds without `dev.sh` simply find an empty
/// directory and log nothing.
fn warn_if_concurrent_dev_instance(db_path: &Path) {
    use std::fs;

    let dir = std::env::temp_dir().join("claudette-dev");
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };
    let our_pid = std::process::id();
    let mut peers: Vec<(u32, String)> = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        let Some(pid) = parsed.get("pid").and_then(|v| v.as_u64()) else {
            continue;
        };
        let pid = pid as u32;
        if pid == our_pid {
            continue;
        }
        if !is_pid_alive(pid) {
            continue;
        }
        let cwd = parsed
            .get("cwd")
            .and_then(|v| v.as_str())
            .unwrap_or("(unknown)")
            .to_string();
        peers.push((pid, cwd));
    }

    for (pid, cwd) in &peers {
        // We can only confirm the peer is a live Claudette dev process
        // (matched by discovery file + alive PID) — the discovery JSON
        // doesn't currently include a DB path, so whether it's the
        // *same* DB as ours is inferred, not verified. By default both
        // launches resolve `dirs::data_dir()/claudette/claudette.db`,
        // so the inference is right in the common case; the wording
        // hedges so the warning stays accurate if a future dev launch
        // ever isolates `CLAUDETTE_DATA_DIR` per-instance.
        tracing::warn!(
            target: "claudette::startup",
            our_pid,
            peer_pid = pid,
            peer_cwd = %cwd,
            our_db_path = %db_path.display(),
            "another Claudette dev instance is alive — if it's running \
             against the same DB (the default unless CLAUDETTE_DATA_DIR \
             is overridden), concurrent SQLite writers can cross-pollute \
             chat_messages rows and corrupt resumed Claude CLI transcripts; \
             consider setting a per-instance data dir before continuing"
        );
    }
}

#[cfg(unix)]
fn is_pid_alive(pid: u32) -> bool {
    // `kill(pid, 0)` is the standard "is this PID alive?" probe — it
    // performs the permission check without sending a signal. EPERM
    // means the process exists but we're not allowed to signal it
    // (still alive); only ESRCH means it's gone.
    let r = unsafe { libc::kill(pid as libc::pid_t, 0) };
    if r == 0 {
        return true;
    }
    // Read errno via `std::io::Error::last_os_error` rather than
    // platform-specific `__error` / `__errno_location` symbols — keeps
    // the helper portable across macOS and Linux without a second
    // cfg-split.
    std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

#[cfg(not(unix))]
fn is_pid_alive(_pid: u32) -> bool {
    // Windows has its own ergonomics for liveness probing
    // (`OpenProcess` + `GetExitCodeProcess`). The dev-launcher
    // discovery file is currently only written on macOS/Linux by
    // `scripts/dev.sh`, so until the launcher gains a Windows
    // analog populated discovery files won't appear here. Return
    // `false` so any stray stale file (e.g. from a copied home
    // directory) doesn't trigger a "another dev instance is alive"
    // warning for a PID that isn't actually running. A real
    // Windows probe can replace this when the launcher does.
    false
}

/// Install a panic hook that emits the panic through `tracing` (so it
/// lands in the daily log file) and then delegates to the previously
/// registered hook (the default `Backtrace::capture` + stderr banner).
/// One hook covers every `tokio::spawn` and `std::thread::spawn` task —
/// `set_hook` is process-global.
///
/// Captured fields:
/// - `panic`     — the panic payload (`PanicHookInfo::payload()`).
/// - `location`  — `file:line:col` so postmortems start on the right line.
/// - `thread`    — `Thread::current().name().unwrap_or("unnamed")`.
/// - `backtrace` — `std::backtrace::Backtrace::force_capture()`. We
///   force here because the panic-hook contract is "this is the one
///   chance to record a useful trace"; the per-process `RUST_BACKTRACE`
///   env var only governs the *default* hook's printout.
fn install_tracing_panic_hook() {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let payload = if let Some(s) = info.payload().downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "<non-string panic payload>".to_string()
        };
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown>".to_string());
        let thread = std::thread::current()
            .name()
            .unwrap_or("unnamed")
            .to_string();
        let backtrace = std::backtrace::Backtrace::force_capture();

        tracing::error!(
            target: "claudette::panic",
            panic = %payload,
            location = %location,
            thread = %thread,
            backtrace = %backtrace,
            "thread panicked"
        );

        // Delegate to the default hook last so its stderr banner
        // shows up *after* our structured event, keeping the file
        // log's ordering intuitive (event then trailer).
        prev(info);
    }));
}

#[cfg(target_os = "macos")]
use tauri::Emitter;
use tauri::Manager;

use claudette::db::Database;

// Accelerator for the "Close Window" menu item on macOS.
//
// We intentionally do NOT use the platform default (`CmdOrCtrl+W`) here —
// that would let the macOS native menu catch the key before the webview
// does, which prevents the terminal's `Cmd+W = close pane` shortcut from
// ever firing. Using `Cmd+Shift+W` for close-window matches iTerm2 /
// Safari / Chrome conventions, and leaves `Cmd+W` free to reach xterm.
//
// `macos_close_window_accelerator_does_not_shadow_terminal_close` in the
// tests below locks in this invariant.
#[cfg(target_os = "macos")]
const MACOS_CLOSE_WINDOW_ACCELERATOR: &str = "CmdOrCtrl+Shift+W";

// URLs for the macOS Help submenu — mirrored from the TS side's single
// source of truth at `src/ui/src/helpUrls.ts`. Update both together
// when any of these change. The frontend Help menu and Settings → Help
// section import the matching constants from that file.
#[cfg(target_os = "macos")]
const HELP_DOCS_URL: &str = "https://utensils.io/claudette/getting-started/installation/";
#[cfg(target_os = "macos")]
const HELP_RELEASE_URL_BASE: &str = "https://github.com/utensils/claudette/releases/tag/v";
#[cfg(target_os = "macos")]
const HELP_ISSUES_URL: &str =
    "https://github.com/utensils/claudette/issues/new?template=bug_report.md";

fn main() {
    // Install the rustls crypto provider before any TLS usage. Both
    // aws-lc-rs and ring are active (tauri-plugin-updater pulls in ring),
    // so rustls cannot auto-detect — we must pick one explicitly.
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();

    // Subsidiary entry points run as short-lived child processes
    // (Claude CLI's stdio MCP grandchild, command hooks, the embedded
    // claudette-server). They need `tracing::*` events for their
    // own error paths, but NOT the GUI's heavy init: opening the
    // SQLite DB to read `diagnostics.log_level`, creating the rolling
    // file appender at `~/.claudette/logs/`, and walking the
    // retention sweep would all be wasted work for processes that
    // exit in milliseconds, and N children writing to the same
    // daily file would contend on the appender's internal lock.
    //
    // We dispatch them FIRST and pin them to a stderr-only
    // subscriber so their `tracing::error!`s still reach the
    // parent's captured stderr. The parent's daily file log
    // covers the GUI side; child diagnostics show up in the
    // parent's stderr capture and / or the agent's transcript.
    let args: Vec<String> = std::env::args().collect();
    let child_mode = args.iter().find_map(|a| match a.as_str() {
        #[cfg(feature = "server")]
        "--server" => Some("--server"),
        "--agent-mcp" => Some("--agent-mcp"),
        "--agent-hook" => Some("--agent-hook"),
        _ => None,
    });
    if let Some(mode) = child_mode {
        let _log_handle = claudette::logging::init_stderr_only();
        let rt = tokio::runtime::Runtime::new().expect("Failed to create tokio runtime");
        match mode {
            #[cfg(feature = "server")]
            "--server" => rt.block_on(async {
                if let Err(e) =
                    claudette_server::run(claudette_server::ServerOptions::default()).await
                {
                    tracing::error!(target: "claudette::startup", error = %e, "embedded claudette-server exited with error");
                    std::process::exit(1);
                }
            }),
            "--agent-mcp" => rt.block_on(async {
                if let Err(e) = claudette::agent_mcp::server::run_stdio().await {
                    tracing::error!(target: "claudette::startup", error = %e, "agent-mcp child exited with error");
                    std::process::exit(1);
                }
            }),
            "--agent-hook" => rt.block_on(async {
                if let Err(e) = claudette::agent_mcp::hook::run_stdin().await {
                    tracing::error!(target: "claudette::startup", error = %e, "agent-hook child exited with error");
                    std::process::exit(1);
                }
            }),
            _ => unreachable!("child_mode is one of the matched arms"),
        }
        return;
    }

    // GUI path. Heavy init runs only here, after we've ruled out the
    // subsidiary entry points above.
    //
    // Tracing is brought up before plugin discovery and DB open so
    // their `tracing::info!`/`warn!` events land in the log file. The
    // handle is held for the whole `main` so the non-blocking file
    // appender's worker thread flushes pending writes on process
    // exit. Errors here are non-fatal: stderr-only logging still
    // covers us.
    //
    // Resolving the DB path once up-front lets us thread the
    // persisted `diagnostics.log_level` override into
    // `init_with_override` before the subscriber is built. Cheap
    // call: `dirs::data_dir()` is a syscall pair on macOS / a
    // registry read on Windows.
    let early_data_dir = claudette::path::data_dir();
    let early_db_path = early_data_dir.join("claudette.db");
    let persisted_log_level = commands::diagnostics::read_persisted_log_level(&early_db_path);
    let _log_handle = claudette::logging::init_with_override(persisted_log_level.as_deref());

    // Panic hook — run after the subscriber is installed so the event
    // lands in the rolling log file (and the existing daily one).
    // We delegate to whatever hook was previously registered (the
    // default in our case) so terminals attached to a `cargo tauri dev`
    // run still see the standard stderr panic banner. The webview-side
    // counterpart of this hook lives in `src/ui/src/utils/log.ts`.
    install_tracing_panic_hook();

    // Windows only: if the WebView2 Runtime is missing, Tauri's webview
    // initialization would fail with a generic system error dialog and exit.
    // Probe the runtime registry up-front and show a native MessageBox with
    // a download link instead. No-op on macOS/Linux.
    webview2_check::ensure_installed();

    // Determine database and worktree paths. Reuse the values resolved
    // above for the persisted-log-level read so the two never drift.
    let data_dir = early_data_dir;
    let db_path = early_db_path;

    // Stamp the resolved primary paths so a multi-instance dev session
    // can be reconstructed from the log file alone — knowing which DB
    // and worktree base each PID was holding is the first question
    // when investigating cross-session contamination.
    tracing::info!(
        target: "claudette::startup",
        pid = std::process::id(),
        data_dir = %data_dir.display(),
        db_path = %db_path.display(),
        "claudette paths resolved"
    );

    // Heuristic warning when another live Claudette dev process appears
    // to be running against this same DB path. Tauri's GUI build does
    // not enforce single-instance (multi-instance is intentional for
    // dev work), but two processes against the same SQLite file is the
    // most plausible source of cross-session message bleed-through.
    // The dev launcher (`scripts/dev.sh`) drops a discovery file at
    // `${TMPDIR}/claudette-dev/<pid>.json` we can scan here.
    warn_if_concurrent_dev_instance(&db_path);

    // Ensure DB exists and migrations are applied. Stamp the install date on
    // first-ever startup so lifetime stats ("days using Claudette") have an
    // anchor. Errors here are non-fatal — downstream code re-opens the DB.
    if let Ok(db) = Database::open(&db_path)
        && db.get_app_setting("install_date").ok().flatten().is_none()
    {
        let now = chrono::Utc::now().to_rfc3339();
        let _ = db.set_app_setting("install_date", &now);
    }

    // Load worktree base dir from settings, or use default.
    let worktree_base_dir = {
        let default = claudette::path::claudette_home().join("workspaces");
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
    let plugin_dir = claudette::path::claudette_home().join("plugins");
    let _ = std::fs::create_dir_all(&plugin_dir);
    let seed_warnings = claudette::plugin_runtime::seed::seed_bundled_plugins(&plugin_dir);
    for warning in &seed_warnings {
        tracing::warn!(target: "claudette::plugin", "{warning}");
    }
    let plugins = claudette::plugin_runtime::PluginRegistry::discover(&plugin_dir);
    tracing::info!(
        target: "claudette::plugin",
        count = plugins.plugins.len(),
        plugins = %plugins
            .plugins
            .keys()
            .cloned()
            .collect::<Vec<_>>()
            .join(", "),
        "plugins discovered"
    );

    // Hydrate the registry's in-memory state (globally disabled plugins,
    // user setting overrides) from app_settings so the very first call
    // after startup reflects what the user configured previously. Any
    // failure here is non-fatal: the registry just runs with defaults.
    if let Ok(db) = Database::open(&db_path)
        && let Ok(entries) = db.list_app_settings_with_prefix("plugin:")
    {
        for (key, value) in entries {
            let rest = &key["plugin:".len()..];
            if let Some((plugin_name, tail)) = rest.split_once(':') {
                if tail == "enabled" && value == "false" {
                    plugins.set_disabled(plugin_name, true);
                } else if let Some(setting_key) = tail.strip_prefix("setting:")
                    && let Ok(v) = serde_json::from_str::<serde_json::Value>(&value)
                {
                    plugins.set_setting(plugin_name, setting_key, Some(v));
                }
            }
        }
    }

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
    //
    // Built with the `*Builder` API and applied via `app.set_menu()` from
    // `.setup()` rather than the `.menu(|app| ...)` configuration closure.
    // Tauri's `.menu(...)` path appears to register the resulting menu in
    // a way that triggers AppKit's auto-detection of a Help submenu (which
    // injects a Spotlight-style search field into it); building inside
    // `setup` and calling `set_menu` directly skips that registration. See
    // `../aethon/src-tauri/src/commands/extensions.rs` for the same
    // pattern in another Tauri 2 project where the Help menu renders
    // search-field-free.
    #[cfg(target_os = "macos")]
    {
        builder = builder.on_menu_event(|app, event| {
            if event.id().as_ref() == "help-keyboard-shortcuts" {
                // Bring the window forward and emit a frontend-handled event;
                // the modal lives in React so we can't open it directly here.
                tray::show_and_focus(app);
                let _ = app.emit("menu://show-keyboard-shortcuts", ());
            } else if event.id().as_ref() == "help-changelog" {
                // Deep-link to the GitHub Release page for the running
                // version. Stable URL — doesn't depend on CHANGELOG.md
                // anchor formatting (which embeds the release date).
                let url = format!("{}{}", HELP_RELEASE_URL_BASE, env!("CARGO_PKG_VERSION"));
                if let Err(e) = commands::shell::opener::open(&url) {
                    tracing::warn!(target: "claudette::ui", url = %url, error = %e, "failed to open changelog URL");
                }
            } else if event.id().as_ref() == "help-open-docs" {
                // Deep-link into the Getting Started page so all three
                // Help surfaces (sidebar, Settings, macOS menu) land
                // users in the same place. Single source of truth for
                // the URL is `HELP_DOCS_URL` (mirrored in TS at
                // `src/ui/src/helpUrls.ts`).
                if let Err(e) = commands::shell::opener::open(HELP_DOCS_URL) {
                    tracing::warn!(target: "claudette::ui", url = HELP_DOCS_URL, error = %e, "failed to open docs URL");
                }
            } else if event.id().as_ref() == "help-report-issue" {
                // GitHub issue tracker. Mirrors Aethon's "Report an
                // Issue…" item — gives users a one-click path to file a
                // bug report.
                if let Err(e) = commands::shell::opener::open(HELP_ISSUES_URL) {
                    tracing::warn!(target: "claudette::ui", url = HELP_ISSUES_URL, error = %e, "failed to open issues URL");
                }
            } else if event.id().as_ref() == "zoom-in" {
                let _ = app.emit("zoom-in", ());
            } else if event.id().as_ref() == "zoom-out" {
                let _ = app.emit("zoom-out", ());
            } else if event.id().as_ref() == "reset-zoom" {
                let _ = app.emit("reset-zoom", ());
            } else if event.id().as_ref() == "open-settings" {
                tray::show_and_focus(app);
                let _ = app.emit("open-settings", ());
            } else if event.id().as_ref() == "close-window" {
                // Route to the existing CloseRequested flow so the
                // macOS "hide instead of quit" logic in
                // on_window_event stays in one place.
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.close();
                }
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
                tracing::warn!(target: "claudette::mdns", error = %e, "failed to start browser");
            }

            // Discover `claude --help` flags BEFORE the first turn can fire,
            // so user-toggled flags from Settings are honoured even on a
            // turn started in the first ~100ms after launch. We block_on
            // here (rather than spawn) because:
            //   - `claude --help` returns in ~50-100ms typically;
            //   - the alternative (spawn) leaves a race where send_chat_message
            //     hits the `Loading` arm in `cached_claude_flag_defs` and
            //     silently delivers `extra_claude_flags = Vec::new()`.
            // The existing `Loading` arm in `list_claude_flags` and
            // `cached_claude_flag_defs` stays as a defensive belt against
            // any future async-init regression.
            let flag_defs_handle =
                std::sync::Arc::clone(&app.state::<state::AppState>().claude_flag_defs);
            tauri::async_runtime::block_on(async move {
                match claudette::claude_help::discover_claude_flags().await {
                    Ok(defs) => {
                        let mut guard = flag_defs_handle.write().await;
                        *guard = state::ClaudeFlagDiscovery::Ok(defs);
                    }
                    Err(msg) => {
                        tracing::warn!(target: "claudette::startup", error = %msg, "claude-flags discovery failed");
                        let mut guard = flag_defs_handle.write().await;
                        *guard = state::ClaudeFlagDiscovery::Err(msg);
                    }
                }
            });

            // macOS native menu — built and applied here (rather than via
            // tauri::Builder::menu) so AppKit doesn't auto-promote the
            // "Help" submenu to its built-in help-search behavior. See
            // the comment block above the `on_menu_event` handler for
            // the full rationale.
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{
                    MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder,
                };
                let app_handle = app.handle();
                let app_menu = SubmenuBuilder::new(app_handle, "Claudette")
                    .item(&PredefinedMenuItem::about(app_handle, None, None)?)
                    .separator()
                    .item(
                        &MenuItemBuilder::with_id("open-settings", "Settings...")
                            .accelerator("CmdOrCtrl+,")
                            .build(app_handle)?,
                    )
                    .separator()
                    .item(&PredefinedMenuItem::services(app_handle, None)?)
                    .separator()
                    .item(&PredefinedMenuItem::hide(app_handle, None)?)
                    .item(&PredefinedMenuItem::hide_others(app_handle, None)?)
                    .item(&PredefinedMenuItem::show_all(app_handle, None)?)
                    .separator()
                    .item(
                        &MenuItemBuilder::with_id("quit-app", "Quit Claudette")
                            .accelerator("CmdOrCtrl+Q")
                            .build(app_handle)?,
                    )
                    .build()?;
                let edit_menu = SubmenuBuilder::new(app_handle, "Edit")
                    .item(&PredefinedMenuItem::undo(app_handle, None)?)
                    .item(&PredefinedMenuItem::redo(app_handle, None)?)
                    .separator()
                    .item(&PredefinedMenuItem::cut(app_handle, None)?)
                    .item(&PredefinedMenuItem::copy(app_handle, None)?)
                    .item(&PredefinedMenuItem::paste(app_handle, None)?)
                    .item(&PredefinedMenuItem::select_all(app_handle, None)?)
                    .build()?;
                let view_menu = SubmenuBuilder::new(app_handle, "View")
                    .item(
                        &MenuItemBuilder::with_id("zoom-in", "Zoom In")
                            .accelerator("CmdOrCtrl+Equal")
                            .build(app_handle)?,
                    )
                    .item(
                        &MenuItemBuilder::with_id("zoom-out", "Zoom Out")
                            .accelerator("CmdOrCtrl+Minus")
                            .build(app_handle)?,
                    )
                    .separator()
                    .item(
                        &MenuItemBuilder::with_id("reset-zoom", "Actual Size")
                            .accelerator("CmdOrCtrl+Shift+0")
                            .build(app_handle)?,
                    )
                    .build()?;
                // Custom Close Window item. We can't use
                // `PredefinedMenuItem::close_window` because it bakes in
                // Cmd+W on macOS, which would shadow the terminal's
                // `Cmd+W = close pane` shortcut — the OS menu would catch
                // the key before the webview saw it.
                let window_menu = SubmenuBuilder::new(app_handle, "Window")
                    .item(&PredefinedMenuItem::minimize(app_handle, None)?)
                    .item(&PredefinedMenuItem::maximize(app_handle, None)?)
                    .item(
                        &MenuItemBuilder::with_id("close-window", "Close Window")
                            .accelerator(MACOS_CLOSE_WINDOW_ACCELERATOR)
                            .build(app_handle)?,
                    )
                    .separator()
                    .item(&PredefinedMenuItem::fullscreen(app_handle, None)?)
                    .build()?;
                // Help menu — two items, no auto-search. AppKit's
                // helpMenu auto-detection only fires when the menu is
                // attached via `tauri::Builder::menu(...)`; here we go
                // the `set_menu` route from setup, which skips that.
                // (Compare to ../aethon/src-tauri/src/commands/extensions.rs.)
                // The "What's New" item label embeds the running version
                // so users can see which release the link will open before
                // clicking. Built from `CARGO_PKG_VERSION` at compile time
                // so it tracks `Cargo.toml` (release-please source of truth).
                let whats_new_label = format!("What's New (v{})", env!("CARGO_PKG_VERSION"));
                let help_menu = SubmenuBuilder::new(app_handle, "Help")
                    .item(
                        &MenuItemBuilder::with_id("help-keyboard-shortcuts", "Keyboard Shortcuts…")
                            .accelerator("CmdOrCtrl+Slash")
                            .build(app_handle)?,
                    )
                    .item(
                        &MenuItemBuilder::with_id("help-changelog", whats_new_label.as_str())
                            .build(app_handle)?,
                    )
                    .separator()
                    .item(
                        &MenuItemBuilder::with_id("help-open-docs", "Claudette Documentation")
                            .build(app_handle)?,
                    )
                    .item(
                        &MenuItemBuilder::with_id("help-report-issue", "Report an Issue…")
                            .build(app_handle)?,
                    )
                    .build()?;
                let menu = MenuBuilder::new(app_handle)
                    .items(&[&app_menu, &edit_menu, &view_menu, &window_menu, &help_menu])
                    .build()?;
                app.set_menu(menu)?;
            }

            // Restore the main window before showing it. The window starts
            // hidden in tauri.conf.json so users never see the default
            // 1200x800/maximized placement flash before saved bounds apply.
            window_state::restore_main_window(app);

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

            // Pre-warm the login-shell PATH cache. On Unix, `shell_path()`
            // spawns `$SHELL -l -c 'echo $PATH'` with a 5-second timeout —
            // fine to pay once at startup on a std thread, but lethal if
            // it ever runs inline on a Tokio worker (stalls every async
            // handler that touches `enriched_path` until the probe
            // returns). On Windows this is a no-op.
            std::thread::spawn(claudette::env::prewarm_shell_path);

            // Set up the system tray icon (respects tray_enabled setting).
            if let Err(e) = tray::setup_tray(app.handle()) {
                tracing::warn!(target: "claudette::tray", error = %e, "failed to setup tray");
            }

            // Start background SCM polling for PR status and CI checks.
            commands::scm::start_scm_polling(app.handle().clone());

            // Build the env-provider fs watcher now that the AppHandle
            // exists. On a change: invalidate the matching cache entry
            // and emit a Tauri event so the EnvPanel (and other
            // subscribers) can refetch without waiting for the next
            // spawn. If `notify` can't start (Linux inotify watch cap
            // hit, headless CI with no kernel support, etc.) we fall
            // back to pure lazy mtime invalidation.
            commands::env::setup_env_watcher(app.handle().clone());

            // Build the file-viewer fs watcher. Construction failure
            // here only disables realtime buffer refresh — file viewer
            // continues to work via the initial-load path. Same
            // fallback shape as the env watcher above.
            commands::files::setup_file_watcher(app.handle().clone());

            // Start the local IPC server the `claudette` CLI talks to.
            // Spawned async on the Tauri runtime; the resulting
            // `IpcServer` + discovery file are managed so they live for
            // the app's lifetime and `Drop` cleans up the socket on
            // shutdown.
            let ipc_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match ipc::IpcServer::start(ipc_app.clone()).await {
                    Ok(server) => {
                        let info = app_info::AppInfo {
                            pid: std::process::id(),
                            socket: server.socket.clone(),
                            token: server.token.clone(),
                            app_version: env!("CARGO_PKG_VERSION").to_string(),
                            started_at: chrono_iso_now(),
                        };
                        match app_info::AppInfoFile::write(&info) {
                            Ok(file) => {
                                tracing::info!(
                                    target: "claudette::ipc",
                                    socket = %server.socket,
                                    discovery = %app_info::app_info_path().display(),
                                    "listening"
                                );
                                ipc_app.manage(IpcGuard {
                                    _server: server,
                                    _file: file,
                                });
                            }
                            Err(e) => {
                                tracing::warn!(target: "claudette::ipc", error = %e, "failed to write app.json");
                            }
                        }
                    }
                    Err(e) => {
                        tracing::warn!(target: "claudette::ipc", error = %e, "failed to start");
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_) => {
                    window_state::schedule_main_window_save(window.clone());
                }
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    window_state::save_main_window_now(window);
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
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            // Devtools (webview inspector — Help → Open dev tools)
            commands::devtools::open_devtools,
            // Data
            commands::data::load_initial_data,
            // Repository
            commands::repository::add_repository,
            commands::repository::init_repository,
            commands::repository::update_repository_settings,
            commands::repository::relink_repository,
            commands::repository::remove_repository,
            commands::repository::get_repo_config,
            commands::repository::get_default_branch,
            commands::repository::list_git_remotes,
            commands::repository::list_git_remote_branches,
            commands::repository::reorder_repositories,
            commands::repository::set_setup_script_auto_run,
            commands::repository::set_archive_script_auto_run,
            // Workspace
            commands::workspace::create_workspace,
            commands::workspace::fork_workspace_at_checkpoint,
            commands::workspace::run_workspace_setup,
            commands::workspace::archive_workspace,
            commands::workspace::restore_workspace,
            commands::workspace::rename_workspace,
            commands::workspace::reorder_workspaces,
            commands::workspace::delete_workspace,
            commands::workspace::generate_workspace_name,
            commands::workspace::refresh_branches,
            commands::workspace::refresh_workspace_branch,
            commands::workspace::discover_worktrees,
            commands::workspace::import_worktrees,
            commands::workspace::open_workspace_in_terminal,
            // Slash commands
            commands::slash_commands::list_slash_commands,
            commands::slash_commands::record_slash_command_usage,
            // Pinned prompts
            commands::pinned_prompts::get_pinned_prompts,
            commands::pinned_prompts::list_pinned_prompts_in_scope,
            commands::pinned_prompts::create_pinned_prompt,
            commands::pinned_prompts::update_pinned_prompt,
            commands::pinned_prompts::delete_pinned_prompt,
            commands::pinned_prompts::reorder_pinned_prompts,
            // Files
            commands::files::list_workspace_files,
            commands::files::read_workspace_file,
            commands::files::read_workspace_file_for_viewer,
            commands::files::read_workspace_file_bytes,
            commands::files::read_workspace_file_at_revision,
            commands::files::write_workspace_file,
            commands::files::resolve_workspace_path,
            commands::files::open_workspace_path,
            commands::files::reveal_workspace_path,
            commands::files::create_workspace_file,
            commands::files::rename_workspace_path,
            commands::files::trash_workspace_path,
            commands::files::restore_workspace_path_from_trash,
            commands::files::save_attachment_bytes,
            commands::files::open_attachment_in_browser,
            commands::files::open_attachment_with_default_app,
            commands::files::copy_attachment_file_to_clipboard,
            commands::files::watch_workspace_files,
            commands::files::unwatch_workspace_files,
            // Chat
            commands::chat::send::load_chat_history,
            commands::chat::send::load_chat_history_page,
            commands::chat::send::send_chat_message,
            commands::chat::send::steer_queued_chat_message,
            commands::chat::attachments::load_attachments_for_session,
            commands::chat::attachments::load_attachment_data,
            commands::chat::attachments::read_file_as_base64,
            commands::chat::lifecycle::stop_agent,
            commands::chat::lifecycle::reset_agent_session,
            commands::chat::interaction::clear_attention,
            commands::chat::interaction::submit_agent_answer,
            commands::chat::interaction::submit_plan_approval,
            commands::chat::remote_control::get_claude_remote_control_status,
            commands::chat::remote_control::set_claude_remote_control,
            commands::chat::checkpoint::list_checkpoints,
            commands::chat::checkpoint::rollback_to_checkpoint,
            commands::chat::checkpoint::clear_conversation,
            commands::chat::checkpoint::save_turn_tool_activities,
            commands::chat::checkpoint::load_completed_turns,
            commands::chat::session::list_chat_sessions,
            commands::chat::session::get_chat_session,
            commands::chat::session::create_chat_session,
            commands::chat::session::rename_chat_session,
            commands::chat::session::set_session_cli_invocation,
            commands::chat::session::reorder_chat_sessions,
            commands::chat::session::archive_chat_session,
            commands::chat::session::restore_chat_session,
            // Plan
            commands::plan::read_plan_file,
            // Metrics
            commands::metrics::get_dashboard_metrics,
            commands::metrics::get_workspace_metrics_batch,
            commands::metrics::get_analytics_metrics,
            // Diff
            commands::diff::load_diff_files,
            commands::diff::compute_workspace_merge_base,
            commands::diff::load_file_diff,
            commands::diff::revert_file,
            commands::diff::discard_file,
            commands::diff::stage_file,
            commands::diff::unstage_file,
            commands::diff::stage_files,
            commands::diff::unstage_files,
            commands::diff::discard_files,
            commands::diff::load_commit_file_diff,
            // Terminal
            commands::terminal::create_terminal_tab,
            commands::terminal::delete_terminal_tab,
            commands::terminal::ensure_claudette_terminal_tab,
            commands::terminal::list_terminal_tabs,
            commands::terminal::update_terminal_tab_order,
            commands::terminal::start_agent_task_tail,
            commands::terminal::stop_agent_task_tail,
            commands::terminal::stop_agent_background_task,
            // PTY
            pty::spawn_pty,
            pty::write_pty,
            pty::resize_pty,
            pty::close_pty,
            pty::interrupt_pty_foreground,
            pty::detect_shell,
            // Settings
            // CLI install/uninstall (Settings → CLI)
            commands::cli::cli_status,
            commands::cli::install_cli_on_path,
            commands::cli::uninstall_cli_from_path,
            commands::settings::get_app_setting,
            commands::settings::set_app_setting,
            commands::settings::delete_app_setting,
            commands::settings::list_app_settings_with_prefix,
            commands::settings::list_user_themes,
            commands::settings::list_notification_sounds,
            commands::settings::list_system_fonts,
            commands::settings::play_notification_sound,
            commands::settings::run_notification_command,
            commands::settings::get_git_username,
            // Diagnostics — frontend log bridge, log dir surface,
            // persisted log-level override.
            commands::diagnostics::log_from_frontend,
            commands::diagnostics::get_log_dir,
            commands::diagnostics::open_log_dir,
            commands::diagnostics::get_diagnostics_settings,
            commands::diagnostics::set_log_level,
            commands::diagnostics::set_frontend_verbosity,
            commands::agent_backends::list_agent_backends,
            commands::agent_backends::save_agent_backend,
            commands::agent_backends::delete_agent_backend,
            commands::agent_backends::save_agent_backend_secret,
            commands::agent_backends::refresh_agent_backend_models,
            commands::agent_backends::test_agent_backend,
            commands::agent_backends::launch_codex_login,
            // Claude flags
            commands::claude_flags::list_claude_flags,
            commands::claude_flags::refresh_claude_flags,
            commands::claude_flags::get_claude_flag_state,
            commands::claude_flags::set_claude_flag_state,
            commands::claude_flags::clear_claude_flag_repo_override,
            commands::claude_flags::clear_claude_flag_global,
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
            // Sound Packs (CESP)
            commands::cesp::cesp_fetch_registry,
            commands::cesp::cesp_list_installed,
            commands::cesp::cesp_install_pack,
            commands::cesp::cesp_update_pack,
            commands::cesp::cesp_delete_pack,
            commands::cesp::cesp_preview_sound,
            commands::cesp::cesp_play_for_event,
            // Shell Integration
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
            // Auth
            commands::auth::get_claude_auth_status,
            commands::auth::claude_auth_login,
            commands::auth::cancel_claude_auth_login,
            // SCM Plugins
            commands::scm::list_scm_providers,
            commands::scm::get_scm_provider,
            commands::scm::set_scm_provider,
            commands::scm::load_scm_detail,
            commands::scm::scm_create_pr,
            commands::scm::scm_merge_pr,
            commands::scm::scm_refresh,
            // Env-provider diagnostic UI
            commands::env::get_env_sources,
            commands::env::get_env_target_worktree,
            commands::env::prepare_workspace_environment,
            commands::env::reload_env,
            commands::env::set_env_provider_enabled,
            commands::env::run_env_trust,
            commands::env::get_host_env_flags,
            // Claudette Lua plugins (SCM + env-provider) settings surface
            commands::plugins_runtime::list_claudette_plugins,
            commands::plugins_runtime::set_claudette_plugin_enabled,
            commands::plugins_runtime::set_claudette_plugin_setting,
            commands::plugins_runtime::reseed_bundled_plugins,
            // Built-in Claudette plugins (Rust-implemented agent surfaces)
            commands::plugins_runtime::list_builtin_claudette_plugins,
            commands::plugins_runtime::set_builtin_claudette_plugin_enabled,
            // Language-grammar plugins (TextMate grammars for chat/diff/editor)
            commands::grammars::list_language_grammars,
            commands::grammars::read_language_grammar,
            // Community registry — discover/install/uninstall third-party
            // themes/plugins/grammars from utensils/claudette-community.
            commands::community::community_registry_fetch,
            commands::community::community_install,
            commands::community::community_uninstall,
            commands::community::community_list_installed,
            commands::community::community_pending_reconsent,
            commands::community::community_grant_capabilities,
            // Voice providers
            commands::voice::voice_list_providers,
            commands::voice::voice_set_selected_provider,
            commands::voice::voice_set_provider_enabled,
            commands::voice::voice_prepare_provider,
            commands::voice::voice_remove_provider_model,
            commands::voice::voice_start_recording,
            commands::voice::voice_stop_and_transcribe,
            commands::voice::voice_cancel_recording,
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
        .run(shutdown_runtime_handler);
}

/// `RunEvent::Exit` is the last hook before the Tauri runtime tears down,
/// so anything Claudette spawned that we haven't already reaped will
/// re-parent to PID 1 if we don't kill it here.
///
/// We treat PTY shells and persistent Claude CLI agents the same way: each
/// is a "root" whose entire descendant tree must die. `cargo-watch` and
/// similar tools deliberately put their grandchildren into a fresh
/// session/PG, so signaling the root's process group leaves them behind —
/// the subtree walk in `subprocess_cleanup` is the reliable path.
#[cfg(unix)]
fn cleanup_subprocesses_on_exit(app_state: &state::AppState) {
    let mut roots: Vec<i32> = Vec::new();

    if let Ok(ptys) = app_state.ptys.try_read() {
        for handle in ptys.values() {
            if let Ok(child) = handle.child.lock()
                && let Some(pid) = child.process_id()
            {
                roots.push(pid as i32);
            }
        }
    }

    if let Ok(agents) = app_state.agents.try_read() {
        for ag in agents.values() {
            if let Some(sess) = &ag.persistent_session {
                roots.push(sess.pid() as i32);
            }
        }
    }

    subprocess_cleanup::kill_processes_with_descendants(&roots, 500);
}

fn shutdown_runtime_handler(_app: &tauri::AppHandle, _event: tauri::RunEvent) {
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

            // Kill all spawned children (PTY shells + Claude CLI agent
            // subprocesses) before our process dies, otherwise they
            // re-parent to launchd and survive — the user has to hunt
            // them down with `ps`. Each root's full descendant tree is
            // walked via `subprocess_cleanup` and signaled in parallel,
            // which catches grandchildren detached into a fresh
            // session/PG (e.g. cargo-watch's nxv serve) that a plain
            // PG signal would miss.
            #[cfg(unix)]
            cleanup_subprocesses_on_exit(&app_state);

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
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    use super::MACOS_CLOSE_WINDOW_ACCELERATOR;

    // Regression: the native macOS "Close Window" menu item must NOT bind
    // `Cmd+W`. If it does, macOS catches the key at the OS level before
    // xterm gets a chance to run its custom key-event handler, and the
    // terminal's `Cmd+W = close pane` shortcut silently becomes a hide-
    // window action. See `MACOS_CLOSE_WINDOW_ACCELERATOR` for the
    // rationale.
    #[cfg(target_os = "macos")]
    #[test]
    fn macos_close_window_accelerator_does_not_shadow_terminal_close() {
        let invalid_forms = [
            "CmdOrCtrl+W",
            "Cmd+W",
            "CommandOrControl+W",
            "Command+W",
            "Ctrl+W",
            "Meta+W",
        ];
        for bad in invalid_forms {
            assert_ne!(
                MACOS_CLOSE_WINDOW_ACCELERATOR, bad,
                "close-window must not bind {bad} — that shadows the terminal's Cmd+W = close pane"
            );
        }
        // Positive assertion: we expect the iTerm2 / Safari / Chrome
        // convention so users' muscle memory carries over.
        assert_eq!(MACOS_CLOSE_WINDOW_ACCELERATOR, "CmdOrCtrl+Shift+W");
    }
}
