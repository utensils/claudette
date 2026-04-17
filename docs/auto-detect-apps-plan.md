# Auto-Detect Installed Apps — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-detect installed editors, terminals, and IDEs, then offer contextual "Open in X" workspace actions from a config-driven app registry.

**Architecture:** Config-driven `~/.claudette/apps.json` registry with ~20 default developer tools. Rust backend scans `$PATH` and `/Applications` (macOS) at startup, caches results in `AppState`, and exposes two Tauri commands (`detect_installed_apps`, `open_workspace_in_app`). Frontend reads detected apps into Zustand and renders a grouped dropdown menu.

**Tech Stack:** Rust (Tauri 2, tokio, serde_json), React/TypeScript (Zustand), existing CSS custom properties.

**Spec:** `docs/auto-detect-apps-tdd.md`

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src-tauri/default-apps.json` | Default app registry (embedded at compile time via `include_str!`) |
| Create | `src-tauri/src/commands/apps.rs` | Config loading, detection logic, open-in-app command |
| Create | `src/ui/src/types/apps.ts` | `DetectedApp` and `AppCategory` TypeScript types |
| Modify | `src-tauri/src/commands/mod.rs` | Add `pub mod apps;` |
| Modify | `src-tauri/src/state.rs` | Add `detected_apps: RwLock<Vec<DetectedApp>>` to `AppState` |
| Modify | `src-tauri/src/main.rs` | Register `detect_installed_apps`, `open_workspace_in_app` |
| Modify | `src/ui/src/types/index.ts` | Re-export apps types |
| Modify | `src/ui/src/services/tauri.ts` | Add `detectInstalledApps()`, `openWorkspaceInApp()` |
| Modify | `src/ui/src/stores/useAppStore.ts` | Add `detectedApps` state slice |
| Modify | `src/ui/src/App.tsx` | Call `detectInstalledApps` on startup |
| Modify | `src/ui/src/components/chat/HeaderMenu.tsx` | Add optional `group` field to `MenuItem`, render group headings |
| Modify | `src/ui/src/components/chat/HeaderMenu.module.css` | Add `.groupHeader` style |
| Modify | `src/ui/src/components/chat/WorkspaceActions.tsx` | Rewrite: dynamic grouped menu from Zustand store |

---

### Task 1: Create default app registry JSON

**Files:**
- Create: `src-tauri/default-apps.json`

- [ ] **Step 1: Create the default registry file**

Create `src-tauri/default-apps.json` with all 20 default app entries from the TDD §3.4:

```json
{
  "apps": [
    {
      "id": "vscode",
      "name": "VS Code",
      "category": "editor",
      "bin_names": ["code"],
      "mac_app_names": ["Visual Studio Code.app"],
      "open_args": ["{}"]
    },
    {
      "id": "cursor",
      "name": "Cursor",
      "category": "editor",
      "bin_names": ["cursor"],
      "mac_app_names": ["Cursor.app"],
      "open_args": ["{}"]
    },
    {
      "id": "zed",
      "name": "Zed",
      "category": "editor",
      "bin_names": ["zed"],
      "mac_app_names": ["Zed.app"],
      "open_args": ["{}"]
    },
    {
      "id": "sublime",
      "name": "Sublime Text",
      "category": "editor",
      "bin_names": ["subl"],
      "mac_app_names": ["Sublime Text.app"],
      "open_args": ["{}"]
    },
    {
      "id": "neovim",
      "name": "Neovim",
      "category": "editor",
      "bin_names": ["nvim"],
      "open_args": ["{}"],
      "needs_terminal": true
    },
    {
      "id": "vim",
      "name": "Vim",
      "category": "editor",
      "bin_names": ["vim"],
      "open_args": ["{}"],
      "needs_terminal": true
    },
    {
      "id": "helix",
      "name": "Helix",
      "category": "editor",
      "bin_names": ["hx"],
      "open_args": ["{}"],
      "needs_terminal": true
    },
    {
      "id": "emacs",
      "name": "Emacs",
      "category": "editor",
      "bin_names": ["emacs"],
      "mac_app_names": ["Emacs.app"],
      "open_args": ["{}"]
    },
    {
      "id": "alacritty",
      "name": "Alacritty",
      "category": "terminal",
      "bin_names": ["alacritty"],
      "mac_app_names": ["Alacritty.app"],
      "open_args": ["--working-directory", "{}"]
    },
    {
      "id": "kitty",
      "name": "Kitty",
      "category": "terminal",
      "bin_names": ["kitty"],
      "mac_app_names": ["kitty.app"],
      "open_args": ["--directory", "{}"]
    },
    {
      "id": "ghostty",
      "name": "Ghostty",
      "category": "terminal",
      "bin_names": ["ghostty"],
      "mac_app_names": ["Ghostty.app"],
      "open_args": ["--working-directory={}"]
    },
    {
      "id": "wezterm",
      "name": "WezTerm",
      "category": "terminal",
      "bin_names": ["wezterm"],
      "mac_app_names": ["WezTerm.app"],
      "open_args": ["start", "--cwd", "{}"]
    },
    {
      "id": "iterm2",
      "name": "iTerm2",
      "category": "terminal",
      "mac_app_names": ["iTerm.app"],
      "open_args": ["__applescript__"]
    },
    {
      "id": "macos-terminal",
      "name": "Terminal",
      "category": "terminal",
      "mac_app_names": ["__always__"],
      "open_args": ["__applescript__"]
    },
    {
      "id": "gnome-terminal",
      "name": "GNOME Terminal",
      "category": "terminal",
      "bin_names": ["gnome-terminal"],
      "open_args": ["--working-directory", "{}"]
    },
    {
      "id": "konsole",
      "name": "Konsole",
      "category": "terminal",
      "bin_names": ["konsole"],
      "open_args": ["--workdir", "{}"]
    },
    {
      "id": "xfce4-terminal",
      "name": "Xfce Terminal",
      "category": "terminal",
      "bin_names": ["xfce4-terminal"],
      "open_args": ["--working-directory", "{}"]
    },
    {
      "id": "foot",
      "name": "Foot",
      "category": "terminal",
      "bin_names": ["foot"],
      "open_args": ["--working-directory", "{}"]
    },
    {
      "id": "intellij",
      "name": "IntelliJ IDEA",
      "category": "ide",
      "bin_names": ["idea"],
      "mac_app_names": ["IntelliJ IDEA.app", "IntelliJ IDEA CE.app"],
      "open_args": ["{}"]
    },
    {
      "id": "xcode",
      "name": "Xcode",
      "category": "ide",
      "mac_app_names": ["Xcode.app"],
      "open_args": ["__open_a__"]
    }
  ]
}
```

- [ ] **Step 2: Verify JSON is valid**

Run: `python3 -c "import json; json.load(open('src-tauri/default-apps.json')); print('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add src-tauri/default-apps.json
git commit -m "feat: add default app registry for auto-detect"
```

---

### Task 2: Rust types and config parsing (TDD)

**Files:**
- Create: `src-tauri/src/commands/apps.rs`
- Modify: `src-tauri/src/commands/mod.rs`

- [ ] **Step 1: Register the module**

In `src-tauri/src/commands/mod.rs`, add `pub mod apps;` alongside the existing modules.

- [ ] **Step 2: Write types and failing config-parsing tests**

Create `src-tauri/src/commands/apps.rs` with the data types and test stubs. Do NOT write `load_apps_config` yet — just the types and tests:

```rust
use serde::{Deserialize, Serialize};

const DEFAULT_APPS_JSON: &str = include_str!("../../default-apps.json");

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AppCategory {
    Editor,
    Terminal,
    Ide,
}

/// Entry in the user-editable apps.json config.
#[derive(Debug, Clone, Deserialize)]
pub struct AppEntry {
    pub id: String,
    pub name: String,
    pub category: AppCategory,
    #[serde(default)]
    pub bin_names: Vec<String>,
    #[serde(default)]
    pub mac_app_names: Vec<String>,
    pub open_args: Vec<String>,
    #[serde(default)]
    pub needs_terminal: bool,
}

/// The apps.json file structure.
#[derive(Debug, Clone, Deserialize)]
pub struct AppsConfig {
    pub apps: Vec<AppEntry>,
}

/// App that passed detection (returned to frontend).
#[derive(Debug, Clone, Serialize)]
pub struct DetectedApp {
    pub id: String,
    pub name: String,
    pub category: AppCategory,
    /// The resolved binary path or .app bundle path.
    pub detected_path: String,
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn parse_embedded_default_config() {
        let config: AppsConfig =
            serde_json::from_str(DEFAULT_APPS_JSON).expect("default-apps.json must parse");
        assert!(config.apps.len() >= 15, "expected at least 15 default apps");
        // Spot-check a few entries
        assert!(config.apps.iter().any(|a| a.id == "vscode"));
        assert!(config.apps.iter().any(|a| a.id == "ghostty"));
        assert!(config.apps.iter().any(|a| a.id == "neovim" && a.needs_terminal));
    }

    #[test]
    fn load_apps_config_missing_file_returns_default() {
        // Point at a path that definitely doesn't exist
        let config = load_apps_config_from(std::path::Path::new("/tmp/claudette-test-nonexistent/apps.json"));
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
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cargo test -p claudette-tauri apps::tests -- --nocapture 2>&1 | head -40`
Expected: Compilation error — `load_apps_config_from` doesn't exist yet. The type-only tests would pass, but the function-calling tests prevent compilation. This confirms the tests are meaningful.

- [ ] **Step 4: Implement `load_apps_config` and `load_apps_config_from`**

Add these functions to `apps.rs` above the `#[cfg(test)]` block:

```rust
use std::path::{Path, PathBuf};

/// Resolve the path to the user's apps.json config file.
fn apps_config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claudette").join("apps.json"))
}

/// Load and parse apps.json from the given path.
/// If the file doesn't exist, write the embedded default and return it.
/// If the file is malformed, log a warning and return the embedded default.
fn load_apps_config_from(path: &Path) -> AppsConfig {
    if path.exists() {
        match std::fs::read_to_string(path) {
            Ok(content) => match serde_json::from_str::<AppsConfig>(&content) {
                Ok(config) => return config,
                Err(e) => eprintln!("[apps] Failed to parse {}: {e}", path.display()),
            },
            Err(e) => eprintln!("[apps] Failed to read {}: {e}", path.display()),
        }
    } else {
        // Write the default file for the user to discover and customize.
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Err(e) = std::fs::write(path, DEFAULT_APPS_JSON) {
            eprintln!("[apps] Failed to write default config to {}: {e}", path.display());
        }
    }
    // Fallback: the embedded default always parses.
    serde_json::from_str(DEFAULT_APPS_JSON).expect("embedded default-apps.json must be valid")
}

/// Public entry point — resolves ~/.claudette/apps.json and loads it.
fn load_apps_config() -> AppsConfig {
    match apps_config_path() {
        Some(path) => load_apps_config_from(&path),
        None => serde_json::from_str(DEFAULT_APPS_JSON)
            .expect("embedded default-apps.json must be valid"),
    }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p claudette-tauri apps::tests -- --nocapture`
Expected: All 7 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/apps.rs src-tauri/src/commands/mod.rs
git commit -m "feat: add app registry types and config loading with tests"
```

---

### Task 3: App detection logic (TDD)

**Files:**
- Modify: `src-tauri/src/commands/apps.rs`

- [ ] **Step 1: Write failing detection tests**

Append to the `mod tests` block in `apps.rs`:

```rust
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
                open_args: vec!["{}".into()],
                needs_terminal: false,
            }],
        };

        let detected = detect_with_paths(&config, &[tmp.path().to_path_buf()]);
        assert_eq!(detected.len(), 1);
        assert_eq!(detected[0].id, "myeditor");
        assert_eq!(detected[0].name, "My Editor");
        assert_eq!(detected[0].category, AppCategory::Editor);
        assert_eq!(
            detected[0].detected_path,
            bin.to_string_lossy().to_string()
        );
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
                open_args: vec!["{}".into()],
                needs_terminal: false,
            }],
        };

        let detected = detect_with_paths(&config, &[tmp.path().to_path_buf()]);
        assert!(detected.is_empty());
    }

    #[test]
    fn detect_sorted_by_category_then_name() {
        let tmp = tempfile::tempdir().unwrap();
        // Create two executables
        for name in ["zterm", "aeditor"] {
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
                    open_args: vec!["{}".into()],
                    needs_terminal: false,
                },
                AppEntry {
                    id: "aeditor".into(),
                    name: "A Editor".into(),
                    category: AppCategory::Editor,
                    bin_names: vec!["aeditor".into()],
                    mac_app_names: vec![],
                    open_args: vec!["{}".into()],
                    needs_terminal: false,
                },
            ],
        };

        let detected = detect_with_paths(&config, &[tmp.path().to_path_buf()]);
        assert_eq!(detected.len(), 2);
        // Editors come before Terminals (category order: editor, terminal, ide)
        assert_eq!(detected[0].id, "aeditor");
        assert_eq!(detected[1].id, "zterm");
    }
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `cargo test -p claudette-tauri apps::tests -- --nocapture 2>&1 | head -20`
Expected: Compilation error — `detect_with_paths` doesn't exist yet.

- [ ] **Step 3: Implement detection logic**

Add these functions to `apps.rs` (above the tests module, below `load_apps_config`):

```rust
/// Well-known PATH prefixes that macOS GUI apps may not inherit.
const EXTRA_PATH_DIRS: &[&str] = &[
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/local/sbin",
];

/// Build the list of directories to scan for binaries.
fn build_path_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    for dir in EXTRA_PATH_DIRS {
        dirs.push(PathBuf::from(dir));
    }
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".local/bin"));
    }

    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            dirs.push(dir);
        }
    }

    // Deduplicate while preserving order.
    let mut seen = std::collections::HashSet::new();
    dirs.retain(|d| seen.insert(d.clone()));
    dirs
}

/// Check whether `name` exists as an executable in any of `path_dirs`.
/// Returns the full path to the first match, or `None`.
fn find_binary(name: &str, path_dirs: &[PathBuf]) -> Option<PathBuf> {
    for dir in path_dirs {
        let candidate = dir.join(name);
        let Ok(meta) = std::fs::metadata(&candidate) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        // On Unix, verify the executable bit is set.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if meta.permissions().mode() & 0o111 == 0 {
                continue;
            }
        }
        return Some(candidate);
    }
    None
}

/// Check whether a .app bundle exists in /Applications (macOS only).
#[cfg(target_os = "macos")]
fn find_mac_app(app_name: &str) -> Option<PathBuf> {
    if app_name == "__always__" {
        // Sentinel: always detected on macOS (e.g. Terminal.app).
        return Some(PathBuf::from("/System/Applications/Utilities/Terminal.app"));
    }
    let path = PathBuf::from("/Applications").join(app_name);
    if path.exists() {
        Some(path)
    } else {
        None
    }
}

/// Detect installed apps from the given config, searching the provided PATH dirs.
/// This is the testable core — `detect_from_config` wraps it with the real PATH.
fn detect_with_paths(config: &AppsConfig, path_dirs: &[PathBuf]) -> Vec<DetectedApp> {
    let category_order = |c: &AppCategory| -> u8 {
        match c {
            AppCategory::Editor => 0,
            AppCategory::Terminal => 1,
            AppCategory::Ide => 2,
        }
    };

    let mut detected: Vec<DetectedApp> = Vec::new();

    for entry in &config.apps {
        // Try bin_names first.
        if let Some(bin_path) = entry
            .bin_names
            .iter()
            .find_map(|name| find_binary(name, path_dirs))
        {
            detected.push(DetectedApp {
                id: entry.id.clone(),
                name: entry.name.clone(),
                category: entry.category,
                detected_path: bin_path.to_string_lossy().to_string(),
            });
            continue;
        }

        // Try mac_app_names (macOS only).
        #[cfg(target_os = "macos")]
        if let Some(app_path) = entry
            .mac_app_names
            .iter()
            .find_map(|name| find_mac_app(name))
        {
            detected.push(DetectedApp {
                id: entry.id.clone(),
                name: entry.name.clone(),
                category: entry.category,
                detected_path: app_path.to_string_lossy().to_string(),
            });
            continue;
        }
    }

    detected.sort_by(|a, b| {
        category_order(&a.category)
            .cmp(&category_order(&b.category))
            .then_with(|| a.name.cmp(&b.name))
    });

    detected
}

/// Public detection entry point using the real system PATH.
fn detect_from_config(config: &AppsConfig) -> Vec<DetectedApp> {
    let path_dirs = build_path_dirs();
    detect_with_paths(config, &path_dirs)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p claudette-tauri apps::tests -- --nocapture`
Expected: All 11 tests pass.

- [ ] **Step 5: Run clippy**

Run: `cargo clippy -p claudette-tauri --all-targets -- -D warnings 2>&1 | tail -5`
Expected: No warnings.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/apps.rs
git commit -m "feat: implement app detection logic with tests"
```

---

### Task 4: AppState extension and detect_installed_apps command

**Files:**
- Modify: `src-tauri/src/state.rs`
- Modify: `src-tauri/src/commands/apps.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Add `detected_apps` to AppState**

In `src-tauri/src/state.rs`, import `DetectedApp`:

```rust
use crate::commands::apps::DetectedApp;
```

Add the field to the `AppState` struct (after `local_server`):

```rust
    /// Detected apps cache (populated on startup, read by open_workspace_in_app for TUI wrapping).
    pub detected_apps: RwLock<Vec<DetectedApp>>,
```

Initialize it in `AppState::new`:

```rust
    detected_apps: RwLock::new(Vec::new()),
```

- [ ] **Step 2: Add the detect command to apps.rs**

Add at the bottom of `apps.rs` (above `#[cfg(test)]`):

```rust
use tauri::State;
use crate::state::AppState;

#[tauri::command]
pub async fn detect_installed_apps(
    state: State<'_, AppState>,
) -> Result<Vec<DetectedApp>, String> {
    let apps = tokio::task::spawn_blocking(|| {
        let config = load_apps_config();
        detect_from_config(&config)
    })
    .await
    .map_err(|e| e.to_string())?;

    // Cache for TUI editor terminal wrapping in open_workspace_in_app.
    *state.detected_apps.write().await = apps.clone();
    Ok(apps)
}
```

- [ ] **Step 3: Register the command in main.rs**

In `src-tauri/src/main.rs`, inside the `invoke_handler` macro, add after the `// Shell Integration` block:

```rust
            // Apps
            commands::apps::detect_installed_apps,
```

- [ ] **Step 4: Verify it compiles**

Run: `cargo build -p claudette-tauri 2>&1 | tail -5`
Expected: Compiles successfully.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/state.rs src-tauri/src/commands/apps.rs src-tauri/src/main.rs
git commit -m "feat: wire detect_installed_apps command into Tauri"
```

---

### Task 5: Open-in-app command

**Files:**
- Modify: `src-tauri/src/commands/apps.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: Implement the open command and its helpers**

Add to `apps.rs` (below `detect_installed_apps`, above `#[cfg(test)]`):

```rust
/// Launch an app using macOS `open -a` command.
#[cfg(target_os = "macos")]
async fn open_macos_app(app_name: &str, worktree_path: &str) -> Result<(), String> {
    tokio::process::Command::new("open")
        .args(["-a", app_name, worktree_path])
        .spawn()
        .map_err(|e| format!("Failed to launch {app_name}: {e}"))?;
    Ok(())
}

/// Launch a terminal app via AppleScript (iTerm2, Terminal.app).
#[cfg(target_os = "macos")]
async fn open_applescript(app_id: &str, worktree_path: &str) -> Result<(), String> {
    let escaped = worktree_path.replace('\\', r"\\").replace('\'', r"'\''");
    let script = match app_id {
        "iterm2" => format!(
            r#"tell application "iTerm"
    activate
    create window with default profile command "cd '{escaped}' && exec $SHELL"
end tell"#
        ),
        "macos-terminal" => format!(
            r#"tell application "Terminal"
    activate
    do script "cd '{escaped}'"
end tell"#
        ),
        other => return Err(format!("No AppleScript handler for app '{other}'")),
    };

    tokio::process::Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .spawn()
        .map_err(|e| format!("Failed to run AppleScript for {app_id}: {e}"))?;
    Ok(())
}

/// Determine the exec-separator args for launching an editor inside a given terminal.
/// Returns (separator args, should use working-dir from terminal open_args).
fn terminal_exec_args(terminal_id: &str) -> &'static [&'static str] {
    match terminal_id {
        "alacritty" | "konsole" | "xfce4-terminal" => &["-e"],
        "gnome-terminal" => &["--"],
        // kitty, foot, wezterm, ghostty: just append the command directly.
        _ => &[],
    }
}

/// Launch a TUI editor (needs_terminal=true) inside the first detected terminal.
async fn open_in_terminal(
    editor_entry: &AppEntry,
    editor_detected: &DetectedApp,
    worktree_path: &str,
    state: &State<'_, AppState>,
) -> Result<(), String> {
    let detected_apps = state.detected_apps.read().await;
    let terminal = detected_apps
        .iter()
        .find(|a| a.category == AppCategory::Terminal)
        .ok_or("No terminal emulator detected — cannot launch TUI editor")?
        .clone();
    drop(detected_apps);

    // Reload config to get the terminal's open_args.
    let config = load_apps_config();
    let terminal_entry = config
        .apps
        .iter()
        .find(|a| a.id == terminal.id)
        .ok_or_else(|| format!("Terminal '{}' not found in config", terminal.id))?;

    // Build: terminal_binary [terminal_open_args with {} → path] [exec_separator] editor_binary .
    let mut cmd = tokio::process::Command::new(&terminal.detected_path);

    // Add terminal's open_args with path substitution.
    for arg in &terminal_entry.open_args {
        cmd.arg(arg.replace("{}", worktree_path));
    }

    // Add exec separator for this terminal.
    for arg in terminal_exec_args(&terminal.id) {
        cmd.arg(arg);
    }

    // Add the editor binary and "." (cwd is set by terminal's --working-directory).
    cmd.arg(&editor_detected.detected_path);
    cmd.arg(".");

    cmd.spawn()
        .map_err(|e| format!("Failed to launch {} in {}: {e}", editor_entry.name, terminal.name))?;
    Ok(())
}

#[tauri::command]
pub async fn open_workspace_in_app(
    app_id: String,
    worktree_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Reload config each time so user edits take effect without restart.
    let config = load_apps_config();
    let entry = config
        .apps
        .iter()
        .find(|a| a.id == app_id)
        .ok_or_else(|| format!("App '{app_id}' not found in apps.json"))?
        .clone();

    // Handle AppleScript sentinel (iTerm2, Terminal.app).
    #[cfg(target_os = "macos")]
    if entry.open_args.first().is_some_and(|a| a == "__applescript__") {
        return open_applescript(&app_id, &worktree_path).await;
    }

    // Handle __open_a__ sentinel (Xcode).
    #[cfg(target_os = "macos")]
    if entry.open_args.first().is_some_and(|a| a == "__open_a__") {
        return open_macos_app(&entry.name, &worktree_path).await;
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
        return open_in_terminal(&entry, &detected, &worktree_path, &state).await;
    }

    // Handle .app-only detection on macOS (CLI not in PATH).
    #[cfg(target_os = "macos")]
    if detected.detected_path.ends_with(".app") {
        return open_macos_app(&entry.name, &worktree_path).await;
    }

    // Normal binary launch: substitute {} in open_args with the worktree path.
    let args: Vec<String> = entry
        .open_args
        .iter()
        .map(|a| a.replace("{}", &worktree_path))
        .collect();

    tokio::process::Command::new(&detected.detected_path)
        .args(&args)
        .spawn()
        .map_err(|e| format!("Failed to launch {}: {e}", entry.name))?;

    Ok(())
}
```

- [ ] **Step 2: Register the command in main.rs**

In `src-tauri/src/main.rs`, add to the `// Apps` section inside `invoke_handler`:

```rust
            commands::apps::open_workspace_in_app,
```

- [ ] **Step 3: Verify it compiles and tests pass**

Run: `cargo build -p claudette-tauri 2>&1 | tail -5 && cargo test -p claudette-tauri apps::tests -- --nocapture`
Expected: Compiles with no errors, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/apps.rs src-tauri/src/main.rs
git commit -m "feat: implement open_workspace_in_app with terminal wrapping and macOS support"
```

---

### Task 6: Frontend types and service layer

**Files:**
- Create: `src/ui/src/types/apps.ts`
- Modify: `src/ui/src/types/index.ts`
- Modify: `src/ui/src/services/tauri.ts`

- [ ] **Step 1: Create the TypeScript types**

Create `src/ui/src/types/apps.ts`:

```typescript
export type AppCategory = "editor" | "terminal" | "ide";

export interface DetectedApp {
  id: string;
  name: string;
  category: AppCategory;
  detected_path: string;
}
```

- [ ] **Step 2: Re-export from the barrel file**

In `src/ui/src/types/index.ts`, append:

```typescript
export type { DetectedApp, AppCategory } from "./apps";
```

- [ ] **Step 3: Add service functions**

In `src/ui/src/services/tauri.ts`, add the import for `DetectedApp` at the top (alongside other type imports):

```typescript
import type { DetectedApp } from "../types/apps";
```

Then add at the bottom (before the debug section):

```typescript
// -- Apps --

export function detectInstalledApps(): Promise<DetectedApp[]> {
  return invoke("detect_installed_apps");
}

export function openWorkspaceInApp(appId: string, worktreePath: string): Promise<void> {
  return invoke("open_workspace_in_app", { appId, worktreePath });
}
```

- [ ] **Step 4: Type-check**

Run: `cd src/ui && bunx tsc --noEmit 2>&1 | tail -10`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/ui/src/types/apps.ts src/ui/src/types/index.ts src/ui/src/services/tauri.ts
git commit -m "feat: add frontend types and service layer for app detection"
```

---

### Task 7: Zustand store and app initialization

**Files:**
- Modify: `src/ui/src/stores/useAppStore.ts`
- Modify: `src/ui/src/App.tsx`

- [ ] **Step 1: Add detectedApps to the store interface**

In `src/ui/src/stores/useAppStore.ts`, add the import:

```typescript
import type { DetectedApp } from "../types/apps";
```

Add to the `AppState` interface (after the `// -- Local Server --` section, before `// -- Updater --`):

```typescript
  // -- Detected Apps --
  detectedApps: DetectedApp[];
  setDetectedApps: (apps: DetectedApp[]) => void;
```

- [ ] **Step 2: Add the implementation**

Add to the `create<AppState>` body (matching the same position):

```typescript
  // -- Detected Apps --
  detectedApps: [],
  setDetectedApps: (apps) => set({ detectedApps: apps }),
```

- [ ] **Step 3: Call detection on app startup**

In `src/ui/src/App.tsx`, add the import:

```typescript
import { loadInitialData, getAppSetting, listRemoteConnections, listDiscoveredServers, getLocalServerStatus, clearAttention, detectInstalledApps } from "./services/tauri";
```

Add the selector at the top of the `App` component (alongside the other selectors):

```typescript
  const setDetectedApps = useAppStore((s) => s.setDetectedApps);
```

Add the detection call inside the existing `useEffect`, after the `getLocalServerStatus` block:

```typescript
    detectInstalledApps()
      .then(setDetectedApps)
      .catch((err) => console.error("Failed to detect installed apps:", err));
```

Add `setDetectedApps` to the `useEffect` dependency array.

- [ ] **Step 4: Type-check**

Run: `cd src/ui && bunx tsc --noEmit 2>&1 | tail -10`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/ui/src/stores/useAppStore.ts src/ui/src/App.tsx
git commit -m "feat: load detected apps into Zustand store on startup"
```

---

### Task 8: HeaderMenu group support

**Files:**
- Modify: `src/ui/src/components/chat/HeaderMenu.tsx`
- Modify: `src/ui/src/components/chat/HeaderMenu.module.css`

- [ ] **Step 1: Add `group` field to MenuItem interface**

In `src/ui/src/components/chat/HeaderMenu.tsx`, update the `MenuItem` interface:

```typescript
interface MenuItem {
  value: string;
  label: string;
  group?: string;
}
```

- [ ] **Step 2: Render group headings**

Add `Fragment` to the React import:

```typescript
import { useState, useRef, useEffect, Fragment } from "react";
```

Replace the menu items rendering (the `{items.map((item) => (` block inside the `.menu` div) with:

```tsx
          {items.map((item, i) => {
            const showGroupHeader =
              item.group && (i === 0 || items[i - 1].group !== item.group);
            return (
              <Fragment key={item.value}>
                {showGroupHeader && (
                  <div className={styles.groupHeader}>{item.group}</div>
                )}
                <button
                  className={`${styles.item} ${item.value === value ? styles.itemActive : ""}`}
                  onClick={() => {
                    onSelect(item.value);
                    setOpen(false);
                  }}
                  type="button"
                >
                  {item.label}
                </button>
              </Fragment>
            );
          })}
```

- [ ] **Step 3: Add the CSS for group headers**

In `src/ui/src/components/chat/HeaderMenu.module.css`, append:

```css
.groupHeader {
  font-size: 10px;
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 6px 10px 2px;
  pointer-events: none;
}
```

- [ ] **Step 4: Type-check to confirm backward compatibility**

Run: `cd src/ui && bunx tsc --noEmit 2>&1 | tail -10`
Expected: No errors. Existing callers that omit `group` are unaffected because the field is optional.

- [ ] **Step 5: Commit**

```bash
git add src/ui/src/components/chat/HeaderMenu.tsx src/ui/src/components/chat/HeaderMenu.module.css
git commit -m "feat: add group headings support to HeaderMenu dropdown"
```

---

### Task 9: Rewrite WorkspaceActions with dynamic app menu

**Files:**
- Modify: `src/ui/src/components/chat/WorkspaceActions.tsx`

- [ ] **Step 1: Rewrite WorkspaceActions**

Replace the entire contents of `src/ui/src/components/chat/WorkspaceActions.tsx`:

```tsx
import { useMemo } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useAppStore } from "../../stores/useAppStore";
import { openWorkspaceInApp } from "../../services/tauri";
import { HeaderMenu } from "./HeaderMenu";

interface WorkspaceActionsProps {
  worktreePath: string | null;
  disabled?: boolean;
}

const CATEGORY_LABELS: Record<string, string> = {
  editor: "Editors",
  terminal: "Terminals",
  ide: "IDEs",
};

const CATEGORY_ORDER = ["editor", "terminal", "ide"] as const;

export function WorkspaceActions({
  worktreePath,
  disabled = false,
}: WorkspaceActionsProps) {
  const detectedApps = useAppStore((s) => s.detectedApps);

  const items = useMemo(() => {
    const menuItems: { value: string; label: string; group?: string }[] = [];

    for (const category of CATEGORY_ORDER) {
      const apps = detectedApps.filter((a) => a.category === category);
      const groupLabel = CATEGORY_LABELS[category];
      for (const app of apps) {
        menuItems.push({
          value: `open:${app.id}`,
          label: `Open in ${app.name}`,
          group: groupLabel,
        });
      }
    }

    menuItems.push({
      value: "copy-path",
      label: "Copy Path",
      group: "Other",
    });

    return menuItems;
  }, [detectedApps]);

  const handleSelect = async (action: string) => {
    if (!worktreePath) return;

    if (action.startsWith("open:")) {
      const appId = action.slice(5);
      try {
        await openWorkspaceInApp(appId, worktreePath);
      } catch (err) {
        console.error(`Failed to open in app ${appId}:`, err);
      }
    } else if (action === "copy-path") {
      try {
        await writeText(worktreePath);
      } catch (err) {
        console.error("Failed to copy path:", err);
      }
    }
  };

  return (
    <HeaderMenu
      label="Actions"
      items={items}
      disabled={disabled || !worktreePath}
      title="Workspace actions"
      onSelect={handleSelect}
    />
  );
}
```

- [ ] **Step 2: Type-check**

Run: `cd src/ui && bunx tsc --noEmit 2>&1 | tail -10`
Expected: No errors.

- [ ] **Step 3: Build the frontend**

Run: `cd src/ui && bun run build 2>&1 | tail -10`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/ui/src/components/chat/WorkspaceActions.tsx
git commit -m "feat: rewrite WorkspaceActions with dynamic detected-app menu"
```

---

### Task 10: Full build verification

- [ ] **Step 1: Run all Rust tests**

Run: `cargo test --all-features 2>&1 | tail -20`
Expected: All tests pass.

- [ ] **Step 2: Run clippy**

Run: `RUSTFLAGS="-Dwarnings" cargo clippy --workspace --all-targets 2>&1 | tail -10`
Expected: No warnings.

- [ ] **Step 3: Check Rust formatting**

Run: `cargo fmt --all --check`
Expected: No formatting issues.

- [ ] **Step 4: TypeScript type-check**

Run: `cd src/ui && bunx tsc --noEmit`
Expected: No errors.

- [ ] **Step 5: Full Tauri build (dev mode)**

Run: `cargo build -p claudette-tauri 2>&1 | tail -5`
Expected: Compiles successfully.

- [ ] **Step 6: Final commit (if any formatting fixes needed)**

```bash
cargo fmt --all
git add -A
git commit -m "chore: format and final verification"
```
