use std::path::{Path, PathBuf};

use super::config::{DEFAULT_APPS_JSON, load_apps_config_from, merge_missing_default_entries};
use super::detection::detect_with_paths;
#[cfg(target_os = "windows")]
use super::detection::find_binary;
use super::model::{AppEntry, AppsConfig};
#[cfg(target_os = "linux")]
use super::platform::find_icon_file_recursive;
use super::platform::jetbrains_toolbox_script_dirs;
#[cfg(any(target_os = "macos", target_os = "linux"))]
use super::platform::{data_url_from_bytes, image_data_url_from_file};
#[cfg(target_os = "windows")]
use super::platform::{
    extract_windows_icon_data_url, icon_cache_dir, icon_cache_key, read_icon_cache,
    resolve_windows_icon_source, write_icon_cache,
};
use super::*;

fn detected_app(id: &str, name: &str, category: AppCategory) -> DetectedApp {
    DetectedApp {
        id: id.to_string(),
        name: name.to_string(),
        category,
        detected_path: format!("/usr/bin/{id}"),
        icon_data_url: None,
    }
}

#[test]
fn parse_valid_config() {
    let json = r#"{
        "apps": [{
            "id": "test-editor",
            "name": "Test Editor",
            "category": "editor",
            "bin_names": ["testedit"],
            "mac_app_names": ["Test Editor.app"],
            "open_args": ["{}"],
            "needs_terminal": false
        }]
    }"#;
    let config: AppsConfig = serde_json::from_str(json).unwrap();
    assert_eq!(config.apps.len(), 1);
    assert_eq!(config.apps[0].id, "test-editor");
    assert_eq!(config.apps[0].name, "Test Editor");
    assert_eq!(config.apps[0].category, AppCategory::Editor);
    assert_eq!(config.apps[0].bin_names, vec!["testedit"]);
    assert_eq!(config.apps[0].open_args, vec!["{}"]);
    assert!(!config.apps[0].needs_terminal);
}

#[test]
fn parse_optional_fields_use_defaults() {
    let json = r#"{
        "apps": [{
            "id": "minimal",
            "name": "Minimal",
            "category": "terminal",
            "open_args": ["--dir", "{}"]
        }]
    }"#;
    let config: AppsConfig = serde_json::from_str(json).unwrap();
    let app = &config.apps[0];
    assert!(app.bin_names.is_empty());
    assert!(app.mac_app_names.is_empty());
    assert!(!app.needs_terminal);
}

#[test]
fn parse_malformed_json_is_err() {
    let result = serde_json::from_str::<AppsConfig>("not valid json {{{");
    assert!(result.is_err());
}

#[test]
fn parse_unknown_fields_ignored() {
    let json = r#"{
        "apps": [{
            "id": "x",
            "name": "X",
            "category": "ide",
            "open_args": ["{}"],
            "future_field": true,
            "another": 42
        }],
        "version": 99
    }"#;
    let config: AppsConfig = serde_json::from_str(json).unwrap();
    assert_eq!(config.apps[0].id, "x");
    assert_eq!(config.apps[0].category, AppCategory::Ide);
}

#[test]
fn parse_file_manager_category() {
    let json = r#"{
        "apps": [{
            "id": "finder",
            "name": "Finder",
            "category": "file_manager",
            "open_args": ["__open__"]
        }]
    }"#;
    let config: AppsConfig = serde_json::from_str(json).unwrap();
    assert_eq!(config.apps[0].category, AppCategory::FileManager);
}

#[test]
fn select_workspace_terminal_prefers_detected_override() {
    let apps = vec![
        detected_app("vscode", "VS Code", AppCategory::Editor),
        detected_app("terminal", "Terminal", AppCategory::Terminal),
        detected_app("ghostty", "Ghostty", AppCategory::Terminal),
    ];

    assert_eq!(
        select_workspace_terminal_app_id(&apps, Some("ghostty")).as_deref(),
        Some("ghostty")
    );
}

#[test]
fn select_workspace_terminal_ignores_non_terminal_override() {
    let apps = vec![
        detected_app("vscode", "VS Code", AppCategory::Editor),
        detected_app("terminal", "Terminal", AppCategory::Terminal),
    ];

    assert_eq!(
        select_workspace_terminal_app_id(&apps, Some("vscode")).as_deref(),
        Some("terminal")
    );
}

#[test]
fn select_workspace_terminal_uses_first_detected_for_auto() {
    let apps = vec![
        detected_app("vscode", "VS Code", AppCategory::Editor),
        detected_app("iterm2", "iTerm2", AppCategory::Terminal),
        detected_app("ghostty", "Ghostty", AppCategory::Terminal),
    ];

    assert_eq!(
        select_workspace_terminal_app_id(&apps, None).as_deref(),
        Some("iterm2")
    );
}

#[test]
fn select_workspace_terminal_returns_none_without_terminals() {
    let apps = vec![detected_app("vscode", "VS Code", AppCategory::Editor)];

    assert_eq!(
        select_workspace_terminal_app_id(&apps, Some("ghostty")),
        None
    );
}

#[test]
fn parse_embedded_default_config() {
    let config: AppsConfig =
        serde_json::from_str(DEFAULT_APPS_JSON).expect("default-apps.json must parse");
    assert!(config.apps.len() >= 15, "expected at least 15 default apps");
    // Spot-check a few entries
    assert!(config.apps.iter().any(|a| a.id == "vscode"));
    assert!(config.apps.iter().any(|a| a.id == "ghostty"));
    assert!(
        config
            .apps
            .iter()
            .any(|a| a.id == "neovim" && a.needs_terminal)
    );
}

#[test]
fn load_apps_config_missing_file_returns_default() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("apps.json");
    let config = load_apps_config_from(&path);
    assert!(!config.apps.is_empty());
}

#[test]
fn load_apps_config_malformed_file_returns_default() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("apps.json");
    std::fs::write(&path, "NOT JSON").unwrap();
    let config = load_apps_config_from(&path);
    assert!(!config.apps.is_empty());
}

#[test]
fn detect_finds_executable_in_path() {
    let tmp = tempfile::tempdir().unwrap();
    let bin = tmp.path().join("myeditor");
    std::fs::write(&bin, "#!/bin/sh\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    let config = AppsConfig {
        apps: vec![AppEntry {
            id: "myeditor".into(),
            name: "My Editor".into(),
            category: AppCategory::Editor,
            bin_names: vec!["myeditor".into()],
            mac_app_names: vec![],
            windows_exe_names: vec![],
            windows_appx_package: String::new(),
            open_args: vec!["{}".into()],
            needs_terminal: false,
        }],
    };

    let detected = detect_with_paths(&config, &[tmp.path().to_path_buf()]);
    assert_eq!(detected.len(), 1);
    assert_eq!(detected[0].id, "myeditor");
    assert_eq!(detected[0].name, "My Editor");
    assert_eq!(detected[0].category, AppCategory::Editor);
    assert_eq!(detected[0].detected_path, bin.to_string_lossy().to_string());
}

#[test]
fn detect_skips_missing_binary() {
    let tmp = tempfile::tempdir().unwrap();
    // No binary created — the directory is empty.
    let config = AppsConfig {
        apps: vec![AppEntry {
            id: "missing".into(),
            name: "Missing App".into(),
            category: AppCategory::Editor,
            bin_names: vec!["nonexistent-binary".into()],
            mac_app_names: vec![],
            windows_exe_names: vec![],
            windows_appx_package: String::new(),
            open_args: vec!["{}".into()],
            needs_terminal: false,
        }],
    };

    let detected = detect_with_paths(&config, &[tmp.path().to_path_buf()]);
    assert!(detected.is_empty());
}

#[cfg(unix)]
#[test]
fn detect_skips_non_executable_file() {
    let tmp = tempfile::tempdir().unwrap();
    let bin = tmp.path().join("noexec");
    std::fs::write(&bin, "data").unwrap();
    // Permissions 0o644 — not executable.
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o644)).unwrap();

    let config = AppsConfig {
        apps: vec![AppEntry {
            id: "noexec".into(),
            name: "No Exec".into(),
            category: AppCategory::Editor,
            bin_names: vec!["noexec".into()],
            mac_app_names: vec![],
            windows_exe_names: vec![],
            windows_appx_package: String::new(),
            open_args: vec!["{}".into()],
            needs_terminal: false,
        }],
    };

    let detected = detect_with_paths(&config, &[tmp.path().to_path_buf()]);
    assert!(detected.is_empty());
}

#[test]
fn detect_sorted_by_category_then_config_order() {
    let tmp = tempfile::tempdir().unwrap();
    for name in ["zterm", "beditor", "aeditor"] {
        let bin = tmp.path().join(name);
        std::fs::write(&bin, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    let config = AppsConfig {
        apps: vec![
            AppEntry {
                id: "zterm".into(),
                name: "Z Terminal".into(),
                category: AppCategory::Terminal,
                bin_names: vec!["zterm".into()],
                mac_app_names: vec![],
                windows_exe_names: vec![],
                windows_appx_package: String::new(),
                open_args: vec!["{}".into()],
                needs_terminal: false,
            },
            AppEntry {
                id: "beditor".into(),
                name: "B Editor".into(),
                category: AppCategory::Editor,
                bin_names: vec!["beditor".into()],
                mac_app_names: vec![],
                windows_exe_names: vec![],
                windows_appx_package: String::new(),
                open_args: vec!["{}".into()],
                needs_terminal: false,
            },
            AppEntry {
                id: "aeditor".into(),
                name: "A Editor".into(),
                category: AppCategory::Editor,
                bin_names: vec!["aeditor".into()],
                mac_app_names: vec![],
                windows_exe_names: vec![],
                windows_appx_package: String::new(),
                open_args: vec!["{}".into()],
                needs_terminal: false,
            },
        ],
    };

    let detected = detect_with_paths(&config, &[tmp.path().to_path_buf()]);
    assert_eq!(detected.len(), 3);
    assert_eq!(
        detected
            .iter()
            .map(|app| app.id.as_str())
            .collect::<Vec<_>>(),
        vec!["beditor", "aeditor", "zterm"],
    );
}

/// Loading a stale user `apps.json` should yield a config that
/// includes any embedded entries the user file is missing. This is
/// the migration path for users whose file pre-dates the addition
/// of e.g. Windows Terminal, PowerShell 7, etc.
#[test]
fn load_apps_config_merges_missing_default_entries() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("apps.json");
    // Write a one-entry user config — nothing else present.
    std::fs::write(
        &path,
        r#"{"apps":[{"id":"vscode","name":"VS Code","category":"editor","bin_names":["code"],"open_args":["{}"]}]}"#,
    )
    .unwrap();

    let config = load_apps_config_from(&path);

    // User's vscode entry is preserved.
    assert!(config.apps.iter().any(|a| a.id == "vscode"));
    // Embedded entries the user lacked are now present.
    assert!(config.apps.iter().any(|a| a.id == "cursor"));
    assert!(config.apps.iter().any(|a| a.id == "windows-terminal"));
    assert!(config.apps.iter().any(|a| a.id == "cmd"));
    for id in JETBRAINS_IDE_IDS {
        assert!(
            config.apps.iter().any(|a| a.id == *id),
            "missing JetBrains IDE default entry for {id}"
        );
    }
}

/// Backfilling `windows_exe_names` on a user entry that lacks it
/// is the mechanism that lights up icon extraction on Windows for
/// pre-existing `apps.json` files. The user's other fields must
/// stay untouched — we're only filling the gap for a new
/// optional field.
#[test]
fn merge_backfills_windows_exe_names_without_clobbering_user_fields() {
    let user = AppsConfig {
        apps: vec![AppEntry {
            id: "vscode".into(),
            // Custom name the user has set — must persist.
            name: "My VSCode".into(),
            category: AppCategory::Editor,
            bin_names: vec!["my-code".into()],
            mac_app_names: vec![],
            windows_exe_names: vec![],
            windows_appx_package: String::new(),
            open_args: vec!["--user".into(), "{}".into()],
            needs_terminal: false,
        }],
    };
    let embedded = AppsConfig {
        apps: vec![AppEntry {
            id: "vscode".into(),
            name: "VS Code".into(),
            category: AppCategory::Editor,
            bin_names: vec!["code".into()],
            mac_app_names: vec!["Visual Studio Code.app".into()],
            windows_exe_names: vec!["Code.exe".into()],
            windows_appx_package: String::new(),
            open_args: vec!["{}".into()],
            needs_terminal: false,
        }],
    };

    let merged = merge_missing_default_entries(user, embedded);
    assert_eq!(merged.apps.len(), 1);
    let entry = &merged.apps[0];
    // User-customized fields untouched.
    assert_eq!(entry.name, "My VSCode");
    assert_eq!(entry.bin_names, vec!["my-code".to_string()]);
    assert_eq!(
        entry.open_args,
        vec!["--user".to_string(), "{}".to_string()]
    );
    // New optional fields backfilled from the embedded default.
    assert_eq!(entry.windows_exe_names, vec!["Code.exe".to_string()]);
    assert_eq!(
        entry.mac_app_names,
        vec!["Visual Studio Code.app".to_string()]
    );
}

/// If the user has explicitly set `windows_exe_names`, the merge
/// must NOT overwrite it. This guards the customize-then-upgrade
/// path: an advanced user pointing at a portable / non-default
/// install shouldn't have their override silently wiped on
/// startup.
#[test]
fn merge_does_not_overwrite_user_windows_exe_names() {
    let user = AppsConfig {
        apps: vec![AppEntry {
            id: "vscode".into(),
            name: "VS Code".into(),
            category: AppCategory::Editor,
            bin_names: vec!["code".into()],
            mac_app_names: vec![],
            windows_exe_names: vec!["PortableCode.exe".into()],
            windows_appx_package: String::new(),
            open_args: vec!["{}".into()],
            needs_terminal: false,
        }],
    };
    let embedded = AppsConfig {
        apps: vec![AppEntry {
            id: "vscode".into(),
            name: "VS Code".into(),
            category: AppCategory::Editor,
            bin_names: vec!["code".into()],
            mac_app_names: vec![],
            windows_exe_names: vec!["Code.exe".into()],
            windows_appx_package: String::new(),
            open_args: vec!["{}".into()],
            needs_terminal: false,
        }],
    };

    let merged = merge_missing_default_entries(user, embedded);
    assert_eq!(
        merged.apps[0].windows_exe_names,
        vec!["PortableCode.exe".to_string()]
    );
}

const JETBRAINS_IDE_IDS: &[&str] = &[
    "intellij",
    "aqua",
    "clion",
    "datagrip",
    "dataspell",
    "fleet",
    "goland",
    "phpstorm",
    "pycharm",
    "rider",
    "rubymine",
    "rustrover",
    "webstorm",
    "writerside",
];

#[test]
fn embedded_jetbrains_entries_have_cross_platform_detection_metadata() {
    let config: AppsConfig =
        serde_json::from_str(DEFAULT_APPS_JSON).expect("default-apps.json must parse");

    for id in JETBRAINS_IDE_IDS {
        let entry = config
            .apps
            .iter()
            .find(|app| app.id == *id)
            .unwrap_or_else(|| panic!("missing JetBrains IDE default entry for {id}"));
        assert_eq!(entry.category, AppCategory::Ide);
        assert!(
            !entry.bin_names.is_empty(),
            "{id} needs Unix/Linux launcher names"
        );
        assert!(
            !entry.mac_app_names.is_empty(),
            "{id} needs macOS app bundle names"
        );
        assert!(
            !entry.windows_exe_names.is_empty(),
            "{id} needs Windows exe names"
        );
        assert_eq!(entry.open_args, vec!["{}".to_string()]);
    }
}

#[test]
fn detect_finds_jetbrains_ides_from_default_config_when_launchers_are_on_path() {
    let tmp = tempfile::tempdir().unwrap();
    for id in JETBRAINS_IDE_IDS {
        let bin = tmp.path().join(default_bin_name_for_app(id));
        std::fs::write(&bin, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    let config: AppsConfig =
        serde_json::from_str(DEFAULT_APPS_JSON).expect("default-apps.json must parse");

    let detected = detect_with_paths(&config, &[tmp.path().to_path_buf()]);
    for id in JETBRAINS_IDE_IDS {
        let app = detected
            .iter()
            .find(|app| app.id == *id)
            .unwrap_or_else(|| panic!("{id} should be detected from the embedded defaults"));
        assert_eq!(app.category, AppCategory::Ide);
        assert_eq!(
            app.detected_path,
            tmp.path()
                .join(default_bin_name_for_app(id))
                .to_string_lossy()
                .to_string()
        );
    }
}

fn default_bin_name_for_app(id: &str) -> &str {
    if id == "intellij" { "idea" } else { id }
}

#[cfg(target_os = "macos")]
#[test]
fn jetbrains_toolbox_script_dirs_include_macos_toolbox_location() {
    let home = Path::new("/Users/example");
    assert_eq!(
        jetbrains_toolbox_script_dirs(Some(home)),
        vec![
            PathBuf::from("/Users/example")
                .join("Library")
                .join("Application Support")
                .join("JetBrains")
                .join("Toolbox")
                .join("scripts")
        ],
    );
}

#[cfg(target_os = "linux")]
#[test]
fn jetbrains_toolbox_script_dirs_include_linux_toolbox_location() {
    let home = Path::new("/home/example");
    assert_eq!(
        jetbrains_toolbox_script_dirs(Some(home)),
        vec![
            PathBuf::from("/home/example")
                .join(".local")
                .join("share")
                .join("JetBrains")
                .join("Toolbox")
                .join("scripts")
        ],
    );
}

#[cfg(target_os = "windows")]
#[test]
fn jetbrains_toolbox_script_dirs_include_windows_toolbox_location_without_home() {
    let dirs = jetbrains_toolbox_script_dirs(None);
    if let Some(local_data) = dirs::data_local_dir() {
        assert_eq!(
            dirs,
            vec![local_data.join("JetBrains").join("Toolbox").join("scripts")],
        );
    } else {
        assert!(dirs.is_empty());
    }
}

/// End-to-end Windows-only regression test for icon extraction.
/// Targets `cmd.exe` because it's:
///   - always present on every Windows install (no install
///     dependency in CI),
///   - has a real embedded icon resource (not a generic shell
///     fallback), and
///   - is a fixed path (`%WINDIR%\System32\cmd.exe`) so the
///     test exercises both the COM path and the data-URL framing
///     without needing any user config.
///
/// Asserts:
///   1. The extractor returns `Some` (the previous shipped
///      version returned None for many inputs because of bad
///      `-Command` quoting),
///   2. The data URL has the expected `data:image/png;base64,`
///      prefix,
///   3. The decoded PNG is at least 64×64. The previous
///      `ExtractAssociatedIcon` path always produced 32×32 — if
///      we regress to that, this assert fails. 64 is a deliberate
///      floor below the IShellItemImageFactory 256 we ask for so
///      Windows builds with shell-image disabled (rare) still
///      pass via the upgraded fallback.
#[cfg(target_os = "windows")]
#[test]
fn extract_windows_icon_data_url_returns_high_res_png_for_cmd_exe() {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;

    let cmd = PathBuf::from(std::env::var_os("WINDIR").unwrap_or_else(|| "C:\\Windows".into()))
        .join("System32")
        .join("cmd.exe");
    assert!(
        cmd.is_file(),
        "test precondition: {} must exist on every Windows host",
        cmd.display()
    );

    let url = extract_windows_icon_data_url("", &cmd)
        .expect("icon extraction returned None for cmd.exe — extractor regression");

    let prefix = "data:image/png;base64,";
    assert!(
        url.starts_with(prefix),
        "data URL missing png prefix: {}",
        &url[..url.len().min(64)]
    );

    let payload = &url[prefix.len()..];
    let png = STANDARD
        .decode(payload)
        .expect("base64 in data URL must decode");

    // PNG signature: 89 50 4E 47 0D 0A 1A 0A.
    assert!(png.len() > 200, "PNG body too small: {} bytes", png.len());
    assert_eq!(
        &png[..8],
        b"\x89PNG\r\n\x1a\n",
        "decoded bytes are not a PNG header"
    );

    // Parse IHDR (starts at byte 8: 4-byte length + "IHDR" chunk type
    // + 4-byte width + 4-byte height, all big-endian).
    let width = u32::from_be_bytes([png[16], png[17], png[18], png[19]]);
    let height = u32::from_be_bytes([png[20], png[21], png[22], png[23]]);
    assert!(
        width >= 64 && height >= 64,
        "icon resolution regressed to ExtractAssociatedIcon-only output \
         ({width}x{height}); expected ≥64×64 from IShellItemImageFactory"
    );
}

/// Bad input must surface as `None` (not panic, not hang). This
/// pins the contract that callers can treat the extractor as
/// best-effort and fall through to the lucide placeholder icon.
#[cfg(target_os = "windows")]
#[test]
fn extract_windows_icon_returns_none_for_missing_path() {
    let bogus = PathBuf::from(r"C:\does-not-exist\definitely-not-a-real-binary.exe");
    let result = extract_windows_icon_data_url("", &bogus);
    assert!(
        result.is_none(),
        "expected None for missing path; got {:?}",
        result
    );
}

/// Process-global env-var lock so any future test in this binary
/// that mutates `$CLAUDETTE_HOME` (or reads it via
/// [`claudette::path::claudette_home`]) doesn't observe another
/// test's override mid-run. Mirrors the `env_lock()` pattern in
/// `src/path.rs::tests` — cargo runs tests in a thread pool by
/// default, so a `--test-threads=1` assumption is not safe.
#[cfg(windows)]
fn env_lock() -> &'static std::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| std::sync::Mutex::new(()))
}

/// `icon_cache_dir()` must route through `claudette_home` so the
/// cache lands under `dev --new` / `dev --clone`'s per-PID sandbox
/// instead of the real `~/.claudette/icon-cache/`. A direct
/// `dirs::home_dir()` would silently leak across sessions — this
/// test pins the override against that regression.
///
/// `$CLAUDETTE_HOME` is process-global, so we (a) hold `env_lock()`
/// for the duration of the test to serialize against any future
/// env-mutating test in this binary, and (b) restore the previous
/// value before returning regardless of pass/fail.
#[cfg(windows)]
#[test]
fn icon_cache_dir_honors_claudette_home_override() {
    let _guard = env_lock().lock().unwrap_or_else(|p| p.into_inner());
    let prev = std::env::var_os("CLAUDETTE_HOME");
    let tmp = tempfile::tempdir().unwrap();
    // SAFETY: protected by env_lock() so no other test in this
    // binary is reading CLAUDETTE_HOME (directly or via
    // claudette_home()) while we mutate it.
    unsafe {
        std::env::set_var("CLAUDETTE_HOME", tmp.path());
    }
    let dir = icon_cache_dir().expect("home is set, dir should resolve");
    assert_eq!(dir, tmp.path().join("icon-cache"));
    unsafe {
        match prev {
            Some(v) => std::env::set_var("CLAUDETTE_HOME", v),
            None => std::env::remove_var("CLAUDETTE_HOME"),
        }
    }
}

/// Cache key must be stable for the same .exe (same path, size,
/// mtime) so a cold launch's extracted icon still hits on the
/// next launch — that's the whole point of disk caching.
/// `merge_*` and `resolve_windows_*` already pin the upstream
/// fields; this pins the downstream key derivation.
#[cfg(windows)]
#[test]
fn icon_cache_key_stable_for_same_exe() {
    let tmp = tempfile::tempdir().unwrap();
    let exe = tmp.path().join("stable.exe");
    std::fs::write(&exe, b"MZ").unwrap();
    let k1 = icon_cache_key("", &exe).expect("key");
    let k2 = icon_cache_key("", &exe).expect("key");
    assert_eq!(k1, k2);
}

/// Different paths must produce different keys, otherwise two
/// apps would clobber each other's cached icons.
#[cfg(windows)]
#[test]
fn icon_cache_key_differs_per_path() {
    let tmp = tempfile::tempdir().unwrap();
    let a = tmp.path().join("a.exe");
    let b = tmp.path().join("b.exe");
    std::fs::write(&a, b"MZ").unwrap();
    std::fs::write(&b, b"MZ").unwrap();
    let ka = icon_cache_key("", &a).expect("key a");
    let kb = icon_cache_key("", &b).expect("key b");
    assert_ne!(ka, kb);
}

/// AppxPackage entries must key off the package name, not the
/// .exe path — `wt.exe` and `cmd.exe` both resolve to the same
/// system console alias if we only hashed the path, and the UWP
/// icon would never get cached separately. Passing different
/// packages with the same path must produce different keys.
#[cfg(windows)]
#[test]
fn icon_cache_key_separates_appx_from_exe() {
    let tmp = tempfile::tempdir().unwrap();
    let exe = tmp.path().join("alias.exe");
    std::fs::write(&exe, b"MZ").unwrap();
    let k_exe = icon_cache_key("", &exe).expect("exe key");
    let k_uwp = icon_cache_key("Microsoft.WindowsTerminal", &exe).expect("uwp key");
    assert_ne!(k_exe, k_uwp);
}

/// Cache miss must surface `None` so `app_icon_data_url` knows
/// to fall through to extraction. We exercise the read path with
/// a definitely-nonexistent key.
#[cfg(windows)]
#[test]
fn icon_cache_read_miss_returns_none() {
    let key = "claudette-test-definitely-not-a-real-key-9q3jklm";
    // Defensive: clean up if a prior test run left this lying.
    if let Some(dir) = icon_cache_dir() {
        let _ = std::fs::remove_file(dir.join(format!("{key}.b64")));
    }
    assert!(read_icon_cache(key).is_none());
}

/// Round-trip the cache: write then read must return the exact
/// same data URL. Pins the on-disk format so we don't accidentally
/// add a header / encoding step that breaks existing entries.
#[cfg(windows)]
#[test]
fn icon_cache_write_then_read_roundtrips() {
    let key = format!("claudette-roundtrip-{}", std::process::id());
    let value = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    write_icon_cache(&key, value);
    let got = read_icon_cache(&key).expect("just-written cache must read back");
    assert_eq!(got, value);
    // Cleanup so the test is hermetic.
    if let Some(dir) = icon_cache_dir() {
        let _ = std::fs::remove_file(dir.join(format!("{key}.b64")));
    }
}

/// Cache invalidation: changing the file's mtime must produce a
/// different cache key so a re-extract triggers next launch.
/// This is what makes VS Code's silent auto-update get a fresh
/// icon if the vendor ever changes it.
#[cfg(windows)]
#[test]
fn icon_cache_key_changes_on_mtime_change() {
    let tmp = tempfile::tempdir().unwrap();
    let exe = tmp.path().join("upgraded.exe");
    std::fs::write(&exe, b"MZ").unwrap();
    let k1 = icon_cache_key("", &exe).expect("key1");

    // Bump the file's mtime by writing different content + waiting
    // for filesystem timestamp granularity (NTFS = 100ns, but
    // some toolchains coalesce same-second writes; sleep keeps it
    // honest).
    std::thread::sleep(std::time::Duration::from_secs(1));
    std::fs::write(&exe, b"MZ\x90\x90").unwrap();
    let k2 = icon_cache_key("", &exe).expect("key2");
    assert_ne!(k1, k2, "cache key did not change after mtime + size delta");
}

/// End-to-end UWP regression: only meaningful on machines where
/// Windows Terminal is installed via Appx (default on Windows 11).
/// We skip cleanly otherwise so this can run unconditionally on
/// any Windows host.
///
/// What's pinned: the AppxPackage path returns *something* high-
/// res (≥64×64 PNG) for `Microsoft.WindowsTerminal`. If a future
/// refactor drops the UWP branch, the icon would silently fall
/// back to the generic console glyph at 32×32 and this test
/// fails loudly.
#[cfg(windows)]
#[test]
fn extract_windows_icon_resolves_appx_package_logo_for_terminal() {
    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;

    // Quick gate: skip when WT isn't installed (e.g. Windows
    // Server hosts without the optional component).
    let pkg_check = claudette::process::std_command("powershell.exe")
        .args([
            "-NoProfile",
            "-Command",
            "if (Get-AppxPackage -Name 'Microsoft.WindowsTerminal*' -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }",
        ])
        .output();
    let installed =
        matches!(pkg_check, Ok(o) if String::from_utf8_lossy(&o.stdout).trim() == "yes");
    if !installed {
        eprintln!("skipping: Microsoft.WindowsTerminal not installed");
        return;
    }

    // Empty path is fine — the AppxPackage branch fires before we
    // ever look at line 2.
    let url = extract_windows_icon_data_url("Microsoft.WindowsTerminal", Path::new(""))
        .expect("Appx icon extraction returned None for installed package");

    let prefix = "data:image/png;base64,";
    assert!(url.starts_with(prefix), "missing png prefix: {url}");
    let png = STANDARD
        .decode(&url[prefix.len()..])
        .expect("base64 decodes");
    assert!(png.len() > 200, "PNG body too small ({} bytes)", png.len());
    assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    let width = u32::from_be_bytes([png[16], png[17], png[18], png[19]]);
    let height = u32::from_be_bytes([png[20], png[21], png[22], png[23]]);
    assert!(
        width >= 64 && height >= 64,
        "Appx logo regressed below 64x64 ({width}x{height}) — \
         ExtractAssociatedIcon fallback path may have taken over"
    );
}

/// On Windows, find_binary should prefer `.exe` over `.cmd` over a
/// no-extension shim — mirroring PATHEXT order. This protects
/// against the VS Code layout where `bin/code` (a Bash script) and
/// `bin/code.cmd` coexist; we want the latter so the icon resolver
/// can walk up to `Code.exe` and `Command::new` doesn't try to
/// invoke a sh-style script.
#[cfg(windows)]
#[test]
fn find_binary_prefers_exe_then_cmd_then_bare_on_windows() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    std::fs::write(dir.join("tool"), "shim").unwrap();
    std::fs::write(dir.join("tool.cmd"), "@echo off").unwrap();
    std::fs::write(dir.join("tool.exe"), b"MZ").unwrap();

    let resolved = find_binary("tool", &[dir.to_path_buf()]).unwrap();
    assert_eq!(resolved, dir.join("tool.exe"));

    std::fs::remove_file(dir.join("tool.exe")).unwrap();
    let resolved = find_binary("tool", &[dir.to_path_buf()]).unwrap();
    assert_eq!(resolved, dir.join("tool.cmd"));

    std::fs::remove_file(dir.join("tool.cmd")).unwrap();
    let resolved = find_binary("tool", &[dir.to_path_buf()]).unwrap();
    assert_eq!(resolved, dir.join("tool"));
}

/// `resolve_windows_icon_source` must walk up from the detected
/// shim to the real `.exe` named in `windows_exe_names`. The
/// fixture mirrors VS Code's layout: `bin/code.cmd` one level
/// below `Code.exe`.
#[cfg(windows)]
#[test]
fn resolve_windows_icon_walks_up_to_named_exe() {
    let tmp = tempfile::tempdir().unwrap();
    let app_root = tmp.path().join("MyApp");
    let bin_dir = app_root.join("bin");
    std::fs::create_dir_all(&bin_dir).unwrap();
    let shim = bin_dir.join("myapp.cmd");
    std::fs::write(&shim, "@echo off").unwrap();
    let real_exe = app_root.join("MyApp.exe");
    std::fs::write(&real_exe, b"MZ").unwrap();

    let entry = AppEntry {
        id: "myapp".into(),
        name: "My App".into(),
        category: AppCategory::Editor,
        bin_names: vec!["myapp".into()],
        mac_app_names: vec![],
        windows_exe_names: vec!["MyApp.exe".into()],
        windows_appx_package: String::new(),
        open_args: vec!["{}".into()],
        needs_terminal: false,
    };

    assert_eq!(resolve_windows_icon_source(&entry, &shim), real_exe);
}

/// Cursor's `cursor.cmd` lives three directories below `Cursor.exe`
/// (`<root>/resources/app/bin/cursor.cmd`). The walk-up cap of five
/// must comfortably cover that.
#[cfg(windows)]
#[test]
fn resolve_windows_icon_walks_up_multiple_levels() {
    let tmp = tempfile::tempdir().unwrap();
    let app_root = tmp.path().join("cursor");
    let deep = app_root.join("resources").join("app").join("bin");
    std::fs::create_dir_all(&deep).unwrap();
    let shim = deep.join("cursor.cmd");
    std::fs::write(&shim, "@echo off").unwrap();
    let real_exe = app_root.join("Cursor.exe");
    std::fs::write(&real_exe, b"MZ").unwrap();

    let entry = AppEntry {
        id: "cursor".into(),
        name: "Cursor".into(),
        category: AppCategory::Editor,
        bin_names: vec!["cursor".into()],
        mac_app_names: vec![],
        windows_exe_names: vec!["Cursor.exe".into()],
        windows_appx_package: String::new(),
        open_args: vec!["{}".into()],
        needs_terminal: false,
    };

    assert_eq!(resolve_windows_icon_source(&entry, &shim), real_exe);
}

/// When `windows_exe_names` doesn't match anything in the walk-up,
/// fall back to the original detected path so the caller still
/// gets a stable input for `ExtractAssociatedIcon`.
#[cfg(windows)]
#[test]
fn resolve_windows_icon_falls_back_to_detected_path() {
    let tmp = tempfile::tempdir().unwrap();
    let bin_dir = tmp.path().join("bin");
    std::fs::create_dir_all(&bin_dir).unwrap();
    let shim = bin_dir.join("ghost.cmd");
    std::fs::write(&shim, "@echo off").unwrap();

    let entry = AppEntry {
        id: "ghost".into(),
        name: "Ghost".into(),
        category: AppCategory::Editor,
        bin_names: vec!["ghost".into()],
        mac_app_names: vec![],
        windows_exe_names: vec!["Nonexistent.exe".into()],
        windows_appx_package: String::new(),
        open_args: vec!["{}".into()],
        needs_terminal: false,
    };

    assert_eq!(resolve_windows_icon_source(&entry, &shim), shim);
}

/// An entry without `windows_exe_names` must skip the walk and
/// return the detected path verbatim — that's the existing
/// behavior for shimless apps and we don't want to regress it.
#[cfg(windows)]
#[test]
fn resolve_windows_icon_no_walk_without_exe_names() {
    let tmp = tempfile::tempdir().unwrap();
    let exe = tmp.path().join("standalone.exe");
    std::fs::write(&exe, b"MZ").unwrap();

    let entry = AppEntry {
        id: "standalone".into(),
        name: "Standalone".into(),
        category: AppCategory::Terminal,
        bin_names: vec!["standalone".into()],
        mac_app_names: vec![],
        windows_exe_names: vec![],
        windows_appx_package: String::new(),
        open_args: vec![],
        needs_terminal: false,
    };

    assert_eq!(resolve_windows_icon_source(&entry, &exe), exe);
}

// --- icon-helper cfg-gating regression tests ----------------------
//
// These exist to catch a class of regression where someone narrows
// the `cfg(...)` on `data_url_from_bytes` / `image_data_url_from_file`
// and breaks the Linux build, because the Linux icon lookup path
// (`find_icon_file_recursive`, `app_icon_data_url`) also calls
// `image_data_url_from_file`. That mistake shipped once already
// (PR #729's "only consumed by mac_icon_from_app_bundle" claim was
// wrong — Linux's XDG icon walk consumes it too) and only surfaced
// in nightly because PR CI doesn't compile `claudette-tauri` on
// Linux. Every test here is `#[cfg(any(target_os = "macos",
// target_os = "linux"))]` or stricter — narrowing either gate will
// refuse to compile this module, which is the signal we want.

/// `data_url_from_bytes` must be reachable from both macOS and Linux
/// — both platforms encode discovered icon files as data URLs for
/// the workspace opener UI.
#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn data_url_from_bytes_encodes_payload() {
    let url = data_url_from_bytes("image/png", b"hello");
    // base64("hello") == "aGVsbG8="
    assert_eq!(url, "data:image/png;base64,aGVsbG8=");
}

/// `image_data_url_from_file` must compile and return a data URL
/// for known image extensions on both macOS and Linux. The bytes
/// don't have to be a real PNG — the helper picks media type from
/// the extension and base64-encodes whatever it reads.
#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn image_data_url_from_file_returns_data_url_for_known_extensions() {
    let tmp = tempfile::tempdir().unwrap();

    let png = tmp.path().join("icon.png");
    std::fs::write(&png, b"hello").unwrap();
    assert_eq!(
        image_data_url_from_file(&png).as_deref(),
        Some("data:image/png;base64,aGVsbG8=")
    );

    let svg = tmp.path().join("icon.svg");
    std::fs::write(&svg, b"<svg/>").unwrap();
    assert_eq!(
        image_data_url_from_file(&svg).as_deref(),
        Some("data:image/svg+xml;base64,PHN2Zy8+")
    );

    // Case folding on the extension — covers `.PNG` etc.
    let upper = tmp.path().join("upper.PNG");
    std::fs::write(&upper, b"hi").unwrap();
    assert!(
        image_data_url_from_file(&upper)
            .is_some_and(|url| url.starts_with("data:image/png;base64,"))
    );
}

/// Unknown / non-image extensions must return `None` so the icon
/// fallback chain can keep walking. Pinning this guards against a
/// future "default to octet-stream" change that would smuggle
/// arbitrary files into the UI.
#[cfg(any(target_os = "macos", target_os = "linux"))]
#[test]
fn image_data_url_from_file_rejects_unknown_extension() {
    let tmp = tempfile::tempdir().unwrap();
    let txt = tmp.path().join("not-an-icon.txt");
    std::fs::write(&txt, b"hello").unwrap();
    assert!(image_data_url_from_file(&txt).is_none());

    let no_ext = tmp.path().join("bare");
    std::fs::write(&no_ext, b"hello").unwrap();
    assert!(image_data_url_from_file(&no_ext).is_none());
}

/// End-to-end: the Linux icon lookup walks an XDG-shaped tree and
/// must hand the resulting path to `image_data_url_from_file`. This
/// is the *exact* call site that broke in nightly — if either the
/// recursive walk or the data-URL helper is gated wrong on Linux,
/// this test stops compiling on Linux.
#[cfg(target_os = "linux")]
#[test]
fn linux_find_icon_file_recursive_returns_path_consumable_by_data_url_helper() {
    let tmp = tempfile::tempdir().unwrap();
    // Mirror the production call shape — `linux_icon_file_from_name`
    // hands each entry of `linux_icon_roots()` (e.g. `/usr/share/icons`)
    // to `find_icon_file_recursive`, which expects the
    // `hicolor/<size>/apps/<icon>` tree to live *inside* that root.
    let icons_root = tmp.path().join("icons");
    let icon_dir = icons_root.join("hicolor/16x16/apps");
    std::fs::create_dir_all(&icon_dir).unwrap();
    let icon_path = icon_dir.join("myapp.png");
    std::fs::write(&icon_path, b"hello").unwrap();

    let found = find_icon_file_recursive(&icons_root, "myapp", 6)
        .expect("recursive walk must find the staged icon");
    assert_eq!(found, icon_path);

    let data_url =
        image_data_url_from_file(&found).expect("found path must be encodable by the helper");
    assert!(data_url.starts_with("data:image/png;base64,"));
}

/// Decoy filename with the same stem but a non-image extension
/// must be skipped — `find_icon_file_recursive` filters via
/// `image_data_url_from_file`, and that contract is what makes the
/// Linux walk safe. Regressing this would let `myapp.txt` shadow
/// `myapp.svg` and surface a missing-icon to the UI.
#[cfg(target_os = "linux")]
#[test]
fn linux_find_icon_file_recursive_skips_non_image_extensions() {
    let tmp = tempfile::tempdir().unwrap();
    let icons_root = tmp.path().join("icons");
    // Decoy lives in the shallow `16x16/apps` slot — a hit-by-stem
    // that the walker must reject because `.txt` isn't an image
    // type the data-URL helper recognizes.
    let decoy_dir = icons_root.join("hicolor/16x16/apps");
    std::fs::create_dir_all(&decoy_dir).unwrap();
    std::fs::write(decoy_dir.join("myapp.txt"), b"not an icon").unwrap();
    // Real icon lives one tier deeper in `scalable/apps`. The walker
    // has to keep going past the decoy to reach it.
    let real_dir = icons_root.join("hicolor/scalable/apps");
    std::fs::create_dir_all(&real_dir).unwrap();
    let real = real_dir.join("myapp.svg");
    std::fs::write(&real, b"<svg/>").unwrap();

    let found = find_icon_file_recursive(&icons_root, "myapp", 6)
        .expect("walker must find the .svg even when a .txt decoy exists");
    assert_eq!(found, real);
}
