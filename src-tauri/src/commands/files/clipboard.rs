use std::path::Path;

#[cfg(any(target_os = "macos", windows))]
use super::attachments::write_attachment_to_temp_file;

pub(super) fn copy_file_path_to_clipboard(path: &Path) -> Result<(), String> {
    copy_file_path(path)
}

pub(super) fn copy_image_bytes_to_clipboard(
    dir: &Path,
    bytes: &[u8],
    filename: &str,
    media_type: &str,
) -> Result<(), String> {
    copy_image_bytes(dir, bytes, filename, media_type)
}

#[cfg(target_os = "macos")]
fn copy_file_path(path: &Path) -> Result<(), String> {
    let output = claudette::process::std_command("osascript")
        .args([
            "-e",
            "on run argv",
            "-e",
            "set the clipboard to POSIX file (item 1 of argv)",
            "-e",
            "end run",
        ])
        .arg(path)
        .output()
        .map_err(|e| format!("failed to run osascript: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("osascript failed: {}", stderr.trim()))
    }
}

#[cfg(target_os = "linux")]
fn copy_file_path(path: &Path) -> Result<(), String> {
    let uri = url::Url::from_file_path(path)
        .map_err(|_| format!("failed to create file URI for {}", path.display()))?
        .to_string();
    let gnome_files = format!("copy\n{uri}\n");
    let uri_list = format!("{uri}\n");

    let attempts: [(&str, &[&str], &str); 5] = [
        (
            "wl-copy",
            &["--type", "x-special/gnome-copied-files"],
            &gnome_files,
        ),
        ("wl-copy", &["--type", "text/uri-list"], &uri_list),
        (
            "xclip",
            &[
                "-selection",
                "clipboard",
                "-t",
                "x-special/gnome-copied-files",
            ],
            &gnome_files,
        ),
        (
            "xclip",
            &["-selection", "clipboard", "-t", "text/uri-list"],
            &uri_list,
        ),
        ("xclip", &["-selection", "clipboard"], &uri),
    ];

    let mut errors = Vec::new();
    for (program, args, input) in attempts {
        match pipe_to_command(program, args, input.as_bytes()) {
            Ok(()) => return Ok(()),
            Err(e) => errors.push(format!("{program}: {e}")),
        }
    }
    Err(format!(
        "copying files requires wl-copy or xclip on Linux ({})",
        errors.join("; ")
    ))
}

#[cfg(target_os = "linux")]
fn pipe_to_command(program: &str, args: &[&str], input: &[u8]) -> Result<(), String> {
    use std::io::Write as _;
    use std::process::Stdio;

    let mut child = claudette::process::std_command(program)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "failed to open stdin".to_string())?;
    stdin.write_all(input).map_err(|e| e.to_string())?;
    drop(stdin);
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[cfg(windows)]
fn copy_file_path(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt as _;
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
    };
    use windows_sys::Win32::System::Memory::{GHND, GlobalAlloc, GlobalLock, GlobalUnlock};
    use windows_sys::Win32::System::Ole::CF_HDROP;
    use windows_sys::Win32::UI::Shell::DROPFILES;

    struct ClipboardGuard;
    impl Drop for ClipboardGuard {
        fn drop(&mut self) {
            unsafe {
                CloseClipboard();
            }
        }
    }

    let mut wide_path: Vec<u16> = path.as_os_str().encode_wide().collect();
    // CF_HDROP expects one NUL after each path plus one extra NUL to end
    // the file list.
    wide_path.push(0);
    wide_path.push(0);

    let header_size = std::mem::size_of::<DROPFILES>();
    let bytes_len = header_size + wide_path.len() * std::mem::size_of::<u16>();
    unsafe {
        let hmem = GlobalAlloc(GHND, bytes_len);
        if hmem.is_null() {
            return Err("GlobalAlloc failed".to_string());
        }
        let ptr = GlobalLock(hmem);
        if ptr.is_null() {
            return Err("GlobalLock failed".to_string());
        }

        let header = DROPFILES {
            pFiles: header_size as u32,
            pt: std::mem::zeroed(),
            fNC: 0,
            fWide: 1,
        };
        std::ptr::copy_nonoverlapping(
            &header as *const DROPFILES as *const u8,
            ptr as *mut u8,
            header_size,
        );
        std::ptr::copy_nonoverlapping(
            wide_path.as_ptr() as *const u8,
            (ptr as *mut u8).add(header_size),
            wide_path.len() * std::mem::size_of::<u16>(),
        );
        GlobalUnlock(hmem);

        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return Err("OpenClipboard failed".to_string());
        }
        let _guard = ClipboardGuard;
        if EmptyClipboard() == 0 {
            return Err("EmptyClipboard failed".to_string());
        }
        if SetClipboardData(CF_HDROP as u32, hmem).is_null() {
            return Err("SetClipboardData failed".to_string());
        }
    }
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn copy_file_path(_path: &Path) -> Result<(), String> {
    Err("file clipboard copy is not supported on this platform".to_string())
}

#[cfg(target_os = "macos")]
fn copy_image_bytes(
    dir: &Path,
    bytes: &[u8],
    filename: &str,
    media_type: &str,
) -> Result<(), String> {
    let path = write_attachment_to_temp_file(dir, filename, media_type, bytes)
        .map_err(|e| format!("write attachment: {e}"))?;
    // ASObjC bridge: create an NSImage from the file and write it to the
    // general pasteboard as image data (not a Finder file reference).
    // Error on nil NSImage (unsupported format) and on writeObjects: returning
    // false — both would otherwise produce a silent success (exit 0).
    let output = claudette::process::std_command("osascript")
        .args([
            "-e",
            "use framework \"AppKit\"",
            "-e",
            "use scripting additions",
            "-e",
            "on run argv",
            "-e",
            "set img to (current application's NSImage's alloc()'s initWithContentsOfFile:(item 1 of argv))",
            "-e",
            "if img is missing value then error \"Failed to load image from file\" number 1",
            "-e",
            "set pb to current application's NSPasteboard's generalPasteboard()",
            "-e",
            "pb's clearContents()",
            "-e",
            "if (pb's writeObjects:{img}) is false then error \"NSPasteboard writeObjects: failed\" number 1",
            "-e",
            "end run",
        ])
        .arg(&path)
        .output()
        .map_err(|e| format!("failed to run osascript: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("osascript failed: {}", stderr.trim()))
    }
}

#[cfg(target_os = "linux")]
fn copy_image_bytes(
    _dir: &Path,
    bytes: &[u8],
    _filename: &str,
    media_type: &str,
) -> Result<(), String> {
    let attempts: [(&str, &[&str]); 2] = [
        ("wl-copy", &["--type", media_type]),
        ("xclip", &["-selection", "clipboard", "-t", media_type]),
    ];
    let mut errors = Vec::new();
    for (program, args) in attempts {
        match pipe_to_command(program, args, bytes) {
            Ok(()) => return Ok(()),
            Err(e) => errors.push(format!("{program}: {e}")),
        }
    }
    Err(format!(
        "copying image requires wl-copy or xclip on Linux ({})",
        errors.join("; ")
    ))
}

#[cfg(windows)]
fn copy_image_bytes(
    dir: &Path,
    bytes: &[u8],
    filename: &str,
    media_type: &str,
) -> Result<(), String> {
    let path = write_attachment_to_temp_file(dir, filename, media_type, bytes)
        .map_err(|e| format!("write attachment: {e}"))?;
    let path_str = path.to_string_lossy().replace('\'', "''");
    // Use WPF/WIC (PresentationCore) instead of System.Drawing — WIC handles
    // more formats including WebP (Windows 10 v1903+) and HEIC.
    let script = format!(
        "Add-Type -AssemblyName PresentationCore; \
         $fs = [System.IO.File]::OpenRead('{path_str}'); \
         $dec = [System.Windows.Media.Imaging.BitmapDecoder]::Create($fs, \
           [System.Windows.Media.Imaging.BitmapCreateOptions]::None, \
           [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad); \
         $fs.Dispose(); \
         $frame = $dec.Frames[0]; \
         $frame.Freeze(); \
         [System.Windows.Clipboard]::SetImage($frame)"
    );
    let output = claudette::process::std_command("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .map_err(|e| format!("failed to run powershell: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("powershell failed: {}", stderr.trim()))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
fn copy_image_bytes(
    _dir: &Path,
    _bytes: &[u8],
    _filename: &str,
    _media_type: &str,
) -> Result<(), String> {
    Err("image clipboard copy is not supported on this platform".to_string())
}
