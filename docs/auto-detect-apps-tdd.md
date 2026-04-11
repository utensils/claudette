# Technical Design: Auto-Detect Installed Apps for Actions

**Status**: Draft
**Date**: 2026-04-11
**Issue**: [#115](https://github.com/utensils/Claudette/issues/115)

## 1. Overview

Auto-detect installed editors, terminals, and IDEs on the user's system and offer contextual "Open in X" actions for workspaces. The app registry is fully config-driven — users can add, remove, or modify entries without rebuilding the app.

### User Stories

- As a developer, I want to open my workspace directly in my preferred editor (VS Code, Zed, Cursor, etc.) from the workspace actions menu
- As a developer, I want to open a terminal at my workspace path using my actual terminal emulator (Ghostty, Kitty, iTerm2, etc.) instead of whatever the system tries first
- As a developer, I want the app to detect what I have installed so I don't have to configure anything manually
- As a developer, I want to add my own custom apps (scripts, project launchers, niche tools) to the actions menu

## 2. Current Architecture

### Workspace Actions Flow

```
User clicks "Actions" dropdown on workspace header
  → WorkspaceActions renders static ITEMS list
  → "Open in Terminal" → openWorkspaceInTerminal(worktreePath) → Tauri command
  → Rust tries 6 hardcoded terminals in order until one spawns
  → "Copy Path" → clipboard write
```

### Key Components

| Component | File | Current State |
|-----------|------|---------------|
| Actions dropdown | `src/ui/src/components/chat/WorkspaceActions.tsx` | Hardcoded 2-item menu (terminal + copy path) |
| Dropdown component | `src/ui/src/components/chat/HeaderMenu.tsx` | Flat list of `{ value, label }` items |
| Terminal open | `src-tauri/src/commands/workspace.rs:410-486` | Tries 6 terminals in order, no upfront detection |
| Editor open | `src-tauri/src/commands/shell.rs:179-211` | Uses `xdg-open`/`open` (system default), unused by frontend |
| Service layer | `src/ui/src/services/tauri.ts` | Exports `openWorkspaceInTerminal()`, which is used by `WorkspaceActions`; no `openInEditor()` wrapper currently exists |
| User config dir | `~/.claudette/` | Used for themes (`themes/*.json`), follows same pattern |

### Gap Analysis

1. **No application detection**: The app doesn't know what's installed — it just tries terminals in a hardcoded order at open time
2. **No editor/IDE support**: `open_in_editor` exists but uses generic system open, not specific apps; not wired into the UI
3. **No dynamic menu**: `WorkspaceActions` has a static 2-item list with no way to add detected apps
4. **No grouped menu support**: `HeaderMenu` renders a flat list with no category separators
5. **No user extensibility**: Adding a new app requires a code change and a rebuild

## 3. Design

### 3.1 Config-Driven Registry

The app registry lives in `~/.claudette/apps.json` — a user-editable JSON file. On first launch (or when the file is missing), Claudette writes a default registry with ~20 common developer tools. Users can freely add, remove, or modify entries.

This follows the same pattern as `~/.claudette/themes/*.json` (user-configurable, loaded at startup, gracefully handles parse errors).

**Why config-driven over hardcoded?**
- Users can add niche tools, custom scripts, or project-specific launchers
- No rebuild needed to support new apps
- Users can remove apps they don't use to keep the menu clean
- Community can share registry files

### 3.2 `apps.json` Schema

```json
{
  "apps": [
    {
      "id": "vscode",
      "name": "VS Code",
      "category": "editor",
      "bin_names": ["code"],
      "mac_app_names": ["Visual Studio Code.app"],
      "open_args": ["{}"],
      "needs_terminal": false
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
      "id": "my-script",
      "name": "Dev Launcher",
      "category": "editor",
      "bin_names": ["dev-launcher"],
      "open_args": ["--project", "{}"]
    }
  ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `apps` | array | yes | List of app definitions |
| `apps[].id` | string | yes | Unique identifier (used internally) |
| `apps[].name` | string | yes | Display name in the menu |
| `apps[].category` | string | yes | One of `"editor"`, `"terminal"`, `"ide"` |
| `apps[].bin_names` | string[] | no | Binary names to search for in `$PATH` (default: `[]`) |
| `apps[].mac_app_names` | string[] | no | `.app` bundle names to check in `/Applications` (default: `[]`) |
| `apps[].open_args` | string[] | yes | Args passed after binary; `{}` is replaced with `worktree_path` |
| `apps[].needs_terminal` | bool | no | If `true`, launches inside the first detected terminal (default: `false`) |

Unknown keys are silently ignored for forward compatibility.

### 3.3 Detection Strategy

On startup, Claudette:

1. Reads `~/.claudette/apps.json` (or writes the default if missing)
2. For each app entry, checks whether it exists on the system:
   - **`bin_names`**: Stat-check each binary name across `$PATH` directories; on Linux verify executable bit via `PermissionsExt`
   - **`mac_app_names`** (macOS only): Check `/Applications/{name}` existence
   - An app is "detected" if **any** of its `bin_names` or `mac_app_names` are found
3. Returns only the detected (installed) apps to the frontend

No new crate dependencies. Pure `std::fs::metadata` stat calls.

**macOS GUI process PATH**: Tauri apps on macOS launch as GUI processes and do not inherit the user's full shell `$PATH`. The detection logic augments `$PATH` with well-known prefixes before scanning:

```rust
const EXTRA_PATH_DIRS: &[&str] = &[
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/local/sbin",
];
// + expand ~/.local/bin at runtime
```

These are prepended to the parsed PATH dirs and deduplicated.

### 3.4 Default Registry

Shipped as a built-in constant in Rust. Written to `~/.claudette/apps.json` on first run only (never overwrites an existing file). Contains:

| id | name | category | bin_names | mac_app_names | open_args | needs_terminal |
|---|---|---|---|---|---|---|
| `vscode` | VS Code | editor | `["code"]` | `["Visual Studio Code.app"]` | `["{}"]` | no |
| `cursor` | Cursor | editor | `["cursor"]` | `["Cursor.app"]` | `["{}"]` | no |
| `zed` | Zed | editor | `["zed"]` | `["Zed.app"]` | `["{}"]` | no |
| `sublime` | Sublime Text | editor | `["subl"]` | `["Sublime Text.app"]` | `["{}"]` | no |
| `neovim` | Neovim | editor | `["nvim"]` | | `["{}"]` | yes |
| `vim` | Vim | editor | `["vim"]` | | `["{}"]` | yes |
| `helix` | Helix | editor | `["hx"]` | | `["{}"]` | yes |
| `emacs` | Emacs | editor | `["emacs"]` | `["Emacs.app"]` | `["{}"]` | no |
| `alacritty` | Alacritty | terminal | `["alacritty"]` | `["Alacritty.app"]` | `["--working-directory", "{}"]` | |
| `kitty` | Kitty | terminal | `["kitty"]` | `["kitty.app"]` | `["--directory", "{}"]` | |
| `ghostty` | Ghostty | terminal | `["ghostty"]` | `["Ghostty.app"]` | `["--working-directory={}"]` | |
| `wezterm` | WezTerm | terminal | `["wezterm"]` | `["WezTerm.app"]` | `["start", "--cwd", "{}"]` | |
| `iterm2` | iTerm2 | terminal | | `["iTerm.app"]` | `["__applescript__"]` | |
| `macos-terminal` | Terminal | terminal | | `["__always__"]` | `["__applescript__"]` | |
| `gnome-terminal` | GNOME Terminal | terminal | `["gnome-terminal"]` | | `["--working-directory", "{}"]` | |
| `konsole` | Konsole | terminal | `["konsole"]` | | `["--workdir", "{}"]` | |
| `xfce4-terminal` | Xfce Terminal | terminal | `["xfce4-terminal"]` | | `["--working-directory", "{}"]` | |
| `foot` | Foot | terminal | `["foot"]` | | `["--working-directory", "{}"]` | |
| `intellij` | IntelliJ IDEA | ide | `["idea"]` | `["IntelliJ IDEA.app", "IntelliJ IDEA CE.app"]` | `["{}"]` | no |
| `xcode` | Xcode | ide | | `["Xcode.app"]` | `["__open_a__"]` | no |

Special sentinel values in `open_args`:
- `["__applescript__"]` — handled specially by the backend (iTerm2 and Terminal.app use AppleScript, see §3.6)
- `["__open_a__"]` — uses `open -a "{app_name}" "{worktree_path}"`

Special sentinel in `mac_app_names`:
- `["__always__"]` — always detected on macOS (for Terminal.app which ships with the OS)

### 3.5 TUI Editor Handling

Apps with `"needs_terminal": true` cannot launch standalone — they need a terminal host. When `open_workspace_in_app` is called for such an app:

1. Look up the first detected terminal from `AppState.detected_apps`
2. Prefer launching without `sh -c` by passing the workspace path via the terminal's `--working-directory` flag and the editor as separate argv entries:
   - `alacritty --working-directory {worktree_path} -e nvim .`
   - `gnome-terminal --working-directory {worktree_path} -- nvim .`
   - `konsole --workdir {worktree_path} -e nvim .`
   - `kitty --directory {worktree_path} nvim .`
3. Only if a terminal provides no argv-safe alternative, fall back to the robust escaping approach already used by `open_workspace_in_terminal` in `src-tauri/src/commands/workspace.rs` (which escapes single quotes and backslashes before interpolation). Never build ad hoc commands like `cd '{path}' && {editor} .`.

All paths are passed as separate `tokio::process::Command` arguments — not interpolated into shell strings — so no shell quoting or escaping is needed for the common case. This eliminates the shell injection risk.

If no terminal is detected, return an error.

### 3.6 macOS AppleScript Terminals

Apps with `open_args: ["__applescript__"]` (iTerm2, Terminal.app) require AppleScript to open with a working directory. Reuse the existing escaping pattern from `open_workspace_in_terminal` in `src-tauri/src/commands/workspace.rs:459-480`:

```rust
let escaped = worktree_path.replace('\\', r"\\").replace('\'', r"'\''");
```

**Terminal.app:**
```applescript
tell application "Terminal"
    activate
    do script "cd '{escaped_path}'"
end tell
```

**iTerm2:**
```applescript
tell application "iTerm"
    activate
    create window with default profile command "cd '{escaped_path}' && exec $SHELL"
end tell
```

The `{escaped_path}` notation indicates the path has been processed through the escaping logic above before interpolation.

### 3.7 macOS .app Bundle Detection for CLI Tools

Some macOS apps install CLI wrappers only after the user explicitly enables them (VS Code's "Install 'code' command in PATH"). When an app's `.app` bundle exists in `/Applications` but the CLI binary is not in `$PATH`, use `open -a "{App Name}" "{worktree_path}"` as the open command instead of the CLI binary.

To avoid ambiguity:
- **`DetectedApp.detected_path`**: The location of the app itself — either the resolved binary path from `$PATH` (e.g., `/opt/homebrew/bin/code`) or the `.app` bundle path (e.g., `/Applications/Visual Studio Code.app`).
- **`worktree_path`**: The workspace directory to open. Always passed as the target argument.

The `open_workspace_in_app` command inspects `detected_path` to decide the launch strategy: if it ends in `.app`, use `open -a`; otherwise, invoke the binary directly with `open_args`.

## 4. Implementation

### 4.1 New module: `src-tauri/src/commands/apps.rs`

Data types:

```rust
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
    /// The resolved binary path or .app bundle path
    pub detected_path: String,
}
```

Config loading:

```rust
/// Load apps.json from ~/.claudette/apps.json.
/// If the file doesn't exist, write the default and return it.
/// If the file is malformed, log a warning and return the default.
fn load_apps_config() -> AppsConfig
```

The default config is embedded as a `const DEFAULT_APPS_JSON: &str = include_str!("../../default-apps.json")` so it can be written to disk on first run and also used as a fallback.

Detection command:

```rust
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
    // Cache in AppState for TUI editor terminal wrapping
    *state.detected_apps.lock().unwrap() = apps.clone();
    Ok(apps)
}
```

`detect_from_config` implementation:
1. Parse `$PATH` into a `Vec<PathBuf>` (split on `:`), augment with well-known prefixes, deduplicate
2. For each `AppEntry` in the config:
   - Check each `bin_names` entry against each PATH dir via `std::fs::metadata`
   - On Linux: verify executable bit with `PermissionsExt` (`mode & 0o111 != 0`)
   - On macOS: also check `/Applications/{name}` for each `mac_app_names` entry
   - Handle sentinels: `__always__` → always detected on macOS
3. Return `Vec<DetectedApp>` sorted by category then name

Open command:

```rust
#[tauri::command]
pub async fn open_workspace_in_app(
    app_id: String,
    worktree_path: String,
    state: State<'_, AppState>,
) -> Result<(), String>
```

- Reload `apps.json` to get the `AppEntry` for `app_id` (ensures edits take effect without restart)
- Build argv by substituting `{}` in `open_args` with `worktree_path` — all paths passed as separate `Command` args
- Handle sentinels:
  - `__applescript__`: dispatch to AppleScript handler based on `app_id` (see §3.6)
  - `__open_a__`: use `open -a "{name}" "{worktree_path}"`
- For `needs_terminal` apps: read `state.detected_apps` to find the first detected terminal, launch using argv-style args (see §3.5)
- For `.app`-only detections: use `open -a "{app_name}" "{worktree_path}"`
- Spawn detached via `tokio::process::Command`

**AppState extension** in `src-tauri/src/state.rs`:

```rust
pub struct AppState {
    // ... existing fields ...
    pub detected_apps: Mutex<Vec<DetectedApp>>,
}
```

**Default apps file**: `src-tauri/default-apps.json` — the default registry as JSON, embedded via `include_str!`.

Register in `src-tauri/src/commands/mod.rs`: `pub mod apps;`

Register in `src-tauri/src/main.rs` invoke_handler:
```rust
// Apps
commands::apps::detect_installed_apps,
commands::apps::open_workspace_in_app,
```

### 4.2 Frontend: Types

New file `src/ui/src/types/apps.ts`:

```typescript
export type AppCategory = "editor" | "terminal" | "ide";

export interface DetectedApp {
  id: string;
  name: string;
  category: AppCategory;
  detected_path: string;
}
```

Re-export from `src/ui/src/types/index.ts`.

### 4.3 Frontend: Service layer

Add to `src/ui/src/services/tauri.ts`:

```typescript
export function detectInstalledApps(): Promise<DetectedApp[]> {
  return invoke("detect_installed_apps");
}

export function openWorkspaceInApp(appId: string, worktreePath: string): Promise<void> {
  return invoke("open_workspace_in_app", { appId, worktreePath });
}
```

### 4.4 Frontend: Zustand store

Add to `useAppStore.ts` state interface and implementation:

```typescript
// State
detectedApps: DetectedApp[];
setDetectedApps: (apps: DetectedApp[]) => void;

// Implementation
detectedApps: [],
setDetectedApps: (apps) => set({ detectedApps: apps }),
```

### 4.5 Frontend: App initialization

Add to `App.tsx` inside the existing startup `useEffect`, parallel with other loads:

```typescript
detectInstalledApps()
  .then(setDetectedApps)
  .catch((err) => console.error("Failed to detect installed apps:", err));
```

### 4.6 Frontend: HeaderMenu group support

Extend `MenuItem` interface in `HeaderMenu.tsx`:

```typescript
interface MenuItem {
  value: string;
  label: string;
  group?: string;  // Optional category heading
}
```

Render group headings when `group` changes between consecutive items:

```tsx
{items.map((item, i) => {
  const showGroupHeader = item.group && (i === 0 || items[i - 1].group !== item.group);
  return (
    <Fragment key={item.value}>
      {showGroupHeader && (
        <div className={styles.groupHeader}>{item.group}</div>
      )}
      <button ...>{item.label}</button>
    </Fragment>
  );
})}
```

New CSS in `HeaderMenu.module.css`:

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

This is backward-compatible — existing callers that omit `group` see no change.

### 4.7 Frontend: WorkspaceActions rewrite

Rewrite `WorkspaceActions.tsx` to build menu items dynamically from detected apps:

```typescript
const CATEGORY_LABELS: Record<string, string> = {
  editor: "Editors",
  terminal: "Terminals",
  ide: "IDEs",
};

const CATEGORY_ORDER = ["editor", "terminal", "ide"];
```

- Read `detectedApps` from Zustand store
- Build grouped `MenuItem[]` via `useMemo`: for each category in order, map detected apps to `{ value: "open:{id}", label: "Open in {name}", group: "{Category}" }`
- Append `{ value: "copy-path", label: "Copy Path", group: "Other" }` at the end
- On select: parse `open:{id}` prefix → call `openWorkspaceInApp(id, worktreePath)`

## 5. Files Modified

| File | Change |
|------|--------|
| `src-tauri/default-apps.json` | **New** — default app registry (embedded at compile time) |
| `src-tauri/src/commands/apps.rs` | **New** — config loading, detection logic, open command |
| `src-tauri/src/commands/mod.rs` | Add `pub mod apps;` |
| `src-tauri/src/main.rs` | Register `detect_installed_apps`, `open_workspace_in_app` |
| `src-tauri/src/state.rs` | Add `detected_apps: Mutex<Vec<DetectedApp>>` to `AppState` |
| `src/ui/src/types/apps.ts` | **New** — `DetectedApp`, `AppCategory` types |
| `src/ui/src/types/index.ts` | Re-export apps types |
| `src/ui/src/services/tauri.ts` | Add `detectInstalledApps`, `openWorkspaceInApp` |
| `src/ui/src/stores/useAppStore.ts` | Add `detectedApps` state + setter |
| `src/ui/src/App.tsx` | Call `detectInstalledApps` on startup |
| `src/ui/src/components/chat/HeaderMenu.tsx` | Add `group` field to `MenuItem`, render group headings |
| `src/ui/src/components/chat/HeaderMenu.module.css` | Add `.groupHeader` style |
| `src/ui/src/components/chat/WorkspaceActions.tsx` | Rewrite with dynamic app items from store |

## 6. Testing

### Unit tests (`src-tauri/src/commands/apps.rs`)

- `load_apps_config` with valid JSON → parses all fields correctly
- `load_apps_config` with missing optional fields (`bin_names`, `mac_app_names`, `needs_terminal`) → uses defaults
- `load_apps_config` with malformed JSON → returns default config (no crash)
- `load_apps_config` with missing file → writes default and returns it
- `detect_from_config` with a temp directory containing a mock executable → returns matching app
- `detect_from_config` with non-existent binary → does not include app
- `detect_from_config` with `__always__` sentinel → always included on macOS

### Manual verification

1. Run `cargo tauri dev`, open a workspace, click "Actions" dropdown
2. Verify detected apps appear grouped by category (Editors, Terminals, IDEs)
3. Click an editor entry → app opens with workspace directory
4. Click a terminal entry → terminal opens at workspace path
5. "Copy Path" still works at the bottom of the menu
6. Edit `~/.claudette/apps.json` to add a custom entry, restart app → new entry appears
7. Remove an entry from `apps.json`, restart → entry disappears from menu
8. Delete `apps.json` entirely, restart → default file is recreated

## 7. User Documentation

Users can customize the actions menu by editing `~/.claudette/apps.json`. Example of adding a custom entry:

```json
{
  "id": "my-tmux",
  "name": "Tmux Session",
  "category": "terminal",
  "bin_names": ["tmux"],
  "open_args": ["new-session", "-c", "{}"]
}
```

To remove an app from the menu, delete its entry from the `apps` array. To reset to defaults, delete the file and restart Claudette.

## 8. Future Considerations

- **In-app editor for `apps.json`**: Add a UI in App Settings to manage the registry without editing JSON by hand
- **User preferences**: Allow setting a preferred app per category via `app_settings`, displayed first in its group
- **Flatpak/Snap detection (Linux)**: Check `flatpak list --columns=application` for additional detection paths
- **File-level actions**: Extend to support opening specific files (not just directories) from the diff viewer
- **Keyboard shortcuts**: Add keybindings for "Open in preferred editor" and "Open in preferred terminal"
- **Hot-reload**: Watch `apps.json` for changes and re-run detection without requiring restart
