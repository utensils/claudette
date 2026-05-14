//! Pre-webview probe for the Microsoft Edge WebView2 Runtime.
//!
//! Claudette is a Tauri app that renders its UI in an embedded WebView2
//! surface. On Windows, if the runtime isn't installed, Tauri's internal
//! initialization fails with a generic "Could not find the WebView2 Runtime"
//! system dialog and the process exits — the user has no path forward.
//!
//! This module probes the well-known Evergreen Runtime registry keys *before*
//! Tauri starts. If the runtime is missing, we show a native `MessageBoxW`
//! (no webview required) with a button that opens Microsoft's download page,
//! then exit cleanly so the shell doesn't surface a crash.
//!
//! No-op on non-Windows targets.

/// Run the WebView2 probe. On Windows, exits the process with a native error
/// dialog if the runtime isn't installed. No-op elsewhere.
pub fn ensure_installed() {
    #[cfg(windows)]
    imp::ensure_installed();
}

#[cfg(windows)]
mod imp {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    use claudette::process::CommandWindowExt as _;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        IDOK, MB_ICONERROR, MB_OKCANCEL, MB_SETFOREGROUND, MB_SYSTEMMODAL, MessageBoxW,
    };
    use winreg::RegKey;
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};

    /// Evergreen WebView2 Runtime app ID, per Microsoft's distribution docs.
    const EVERGREEN_GUID: &str = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

    const DOWNLOAD_URL: &str = "https://developer.microsoft.com/en-us/microsoft-edge/webview2/";

    pub fn ensure_installed() {
        if is_runtime_installed() {
            return;
        }
        show_missing_dialog_and_exit();
    }

    /// Check the three registry locations where the Evergreen Runtime stamps
    /// its product version. Any populated `pv != "0.0.0.0"` means the runtime
    /// is registered on this machine.
    ///
    /// Note: this does not detect the edge case where the runtime is installed
    /// for a different user only. In that case Tauri/wry will still surface
    /// its own system dialog — see follow-up issue for a more thorough probe.
    fn is_runtime_installed() -> bool {
        let hklm_paths = [
            format!(r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{EVERGREEN_GUID}"),
            format!(r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{EVERGREEN_GUID}"),
        ];
        let hkcu_path = format!(r"Software\Microsoft\EdgeUpdate\Clients\{EVERGREEN_GUID}");

        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        for path in &hklm_paths {
            if has_valid_pv(&hklm, path) {
                return true;
            }
        }
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        has_valid_pv(&hkcu, &hkcu_path)
    }

    /// Returns `true` iff `hive\path` exists and has a non-empty `pv` value
    /// that isn't the placeholder `"0.0.0.0"` EdgeUpdate stamps when it
    /// hasn't finished registering a runtime.
    fn has_valid_pv(hive: &RegKey, path: &str) -> bool {
        let Ok(key) = hive.open_subkey(path) else {
            return false;
        };
        let Ok(pv) = key.get_value::<String, _>("pv") else {
            return false;
        };
        !pv.is_empty() && pv != "0.0.0.0"
    }

    fn show_missing_dialog_and_exit() -> ! {
        let title = to_wide("Claudette — WebView2 Runtime required");
        let body = to_wide(
            "Claudette needs the Microsoft Edge WebView2 Runtime, which isn't installed \
            on this system.\n\n\
            Click OK to open Microsoft's download page. After installing the \
            Evergreen Runtime, relaunch Claudette.\n\n\
            Click Cancel to quit.",
        );
        // SAFETY: MessageBoxW with null hWnd is always safe; the pointers are
        // to local, NUL-terminated UTF-16 buffers that outlive the call.
        let result = unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                body.as_ptr(),
                title.as_ptr(),
                MB_OKCANCEL | MB_ICONERROR | MB_SYSTEMMODAL | MB_SETFOREGROUND,
            )
        };
        if result == IDOK as i32 {
            let _ = std::process::Command::new("cmd")
                .no_console_window()
                .args(["/C", "start", "", DOWNLOAD_URL])
                .spawn();
        }
        std::process::exit(1);
    }

    fn to_wide(s: &str) -> Vec<u16> {
        OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn to_wide_is_nul_terminated() {
            let w = to_wide("abc");
            assert_eq!(w, vec![b'a' as u16, b'b' as u16, b'c' as u16, 0]);
        }

        #[test]
        fn evergreen_guid_is_well_formed() {
            // Microsoft-documented runtime app ID — guard against typos that
            // would make `is_runtime_installed` silently always-false.
            assert_eq!(EVERGREEN_GUID.len(), 38);
            assert!(EVERGREEN_GUID.starts_with('{'));
            assert!(EVERGREEN_GUID.ends_with('}'));
        }
    }
}
