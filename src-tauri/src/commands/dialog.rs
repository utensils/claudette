//! File-dialog capability probe.
//!
//! Tauri 2's `tauri-plugin-dialog` routes "Browse" / file-picker calls
//! through `rfd`, which on Linux talks to `org.freedesktop.portal.
//! FileChooser` over DBus. If the portal daemon isn't running (minimal
//! Arch / sway / i3 installs without a desktop environment), the
//! FileChooser call panics from inside the Rust side of the plugin and
//! takes the whole app with it — no JS-level try/catch can catch it.
//!
//! We expose `file_dialog_capability()` so the frontend can probe once
//! at boot and hide Browse buttons (falling back to manual path entry)
//! when there is no working backend. macOS and Windows always have a
//! native file picker, so the check short-circuits to `true` there.

use std::sync::OnceLock;

/// Cached capability result. We probe once per process — the user
/// can't install a portal daemon mid-session, and our re-checks
/// would just spend DBus round-trips reaffirming the same answer.
static CAPABILITY: OnceLock<bool> = OnceLock::new();

#[tauri::command]
pub async fn file_dialog_capability() -> bool {
    if let Some(cached) = CAPABILITY.get() {
        return *cached;
    }

    let available = probe().await;
    let _ = CAPABILITY.set(available);
    available
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
async fn probe() -> bool {
    // Both macOS and Windows ship a native file picker as part of the
    // OS — there's no failure mode that crashes the app on either
    // platform from the dialog plugin path.
    true
}

#[cfg(target_os = "linux")]
async fn probe() -> bool {
    use std::time::Duration;

    // Probe via `gdbus introspect`. gdbus ships with glib2, which is
    // already a transitive runtime dep of any GTK app (Tauri included)
    // so we don't add a new system requirement just for this check.
    // The probe is "is the FileChooser interface reachable on the
    // session bus" — succeeds when xdg-desktop-portal is running AND
    // a backend implementing FileChooser is registered.
    //
    // Full introspection rather than `--only-properties` because some
    // FileChooser backends expose no properties; `--only-properties`
    // would print empty output and miss the interface header.
    //
    // 3-second timeout guards against a DBus daemon that's up but
    // unresponsive (cold-boot races). On timeout we report "no
    // picker" — Browse hides, app stays alive, no crash.
    let probe_fut = async {
        tokio::process::Command::new("gdbus")
            .args([
                "introspect",
                "--session",
                "--dest",
                "org.freedesktop.portal.Desktop",
                "--object-path",
                "/org/freedesktop/portal/desktop",
            ])
            .output()
            .await
    };

    let output = match tokio::time::timeout(Duration::from_secs(3), probe_fut).await {
        Ok(result) => result,
        Err(_) => return false,
    };

    match output {
        Ok(o) if o.status.success() => {
            // Require the FileChooser interface to be advertised on
            // the object. Some minimal portal backends register
            // Desktop without FileChooser (e.g. headless screencast-
            // only portals), and we'd still crash if we called
            // open() against those.
            let stdout = String::from_utf8_lossy(&o.stdout);
            stdout.contains("org.freedesktop.portal.FileChooser")
        }
        _ => false,
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
async fn probe() -> bool {
    // Unknown platform. Err on "available" because the alternative —
    // hiding Browse everywhere — is the worse default for the user;
    // a crash they can report is more actionable than missing UI
    // they wouldn't think to look for.
    true
}
