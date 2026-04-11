# Technical Design: Auto-Detect Installed Apps for Actions

**Status**: Draft
**Date**: 2026-04-11
**Issue**: [#115](https://github.com/utensils/Claudette/issues/115)

## 1. Overview

Auto-detect installed editors, terminals, and IDEs on the user's system and offer contextual "Open in X" actions for workspaces. Similar to how macOS Conductor offers actions like "Open in iTerm2" or "Open in Xcode" depending on what's installed.

### User Stories

- As a developer, I want to open my workspace directly in my preferred editor (VS Code, Zed, Cursor, etc.) from the workspace actions menu
- As a developer, I want to open a terminal at my workspace path using my actual terminal emulator (Ghostty, Kitty, iTerm2, etc.) instead of whatever the system tries first
- As a developer, I want the app to detect what I have installed so I don't have to configure anything manually

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

### Gap Analysis

1. **No application detection**: The app doesn't know what's installed — it just tries terminals in a hardcoded order at open time
2. **No editor/IDE support**: `open_in_editor` exists but uses generic system open, not specific apps; not wired into the UI
3. **No dynamic menu**: `WorkspaceActions` has a static 2-item list with no way to add detected apps
4. **No grouped menu support**: `HeaderMenu` renders a flat list with no category separators

## 3. Design

### 3.1 Detection Strategy

Use a static registry of ~20 known applications with platform-specific detection. For each candidate, check whether it exists on the system:

- **Linux**: Stat-check each candidate's binary name across `$PATH` directories, verify executable bit via `PermissionsExt`
- **macOS**: Same `$PATH` scan, plus check `/Applications/{name}.app` existence for GUI apps

No new crate dependencies. Pure `std::fs::metadata` stat calls (~200 checks) complete in well under 50ms.

**macOS GUI process PATH**: Tauri apps on macOS launch as GUI processes and do not inherit the user's full shell `$PATH`. Common tool locations like `/opt/homebrew/bin`, `/usr/local/bin`, and `~/.local/bin` may be absent. The detection logic must augment `$PATH` with well-known prefixes before scanning:

```rust
const EXTRA_PATH_DIRS: &[&str] = &[
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/local/sbin",
];
// + expand ~/.local/bin at runtime
```

These are prepended to the parsed PATH dirs and deduplicated before scanning.

**Why a static registry?** Dynamic discovery (scanning all installed apps) would be slow and return hundreds of irrelevant apps. A curated list of developer tools gives a focused, useful menu.

**Alternatives considered:**
1. **`which` crate** — adds a dependency for something achievable with ~10 lines of PATH scanning
2. **`.desktop` file parsing (Linux)** — complex, many apps lack `.desktop` files, returns non-developer apps
3. **`lsregister` dump (macOS)** — slow, returns every registered app, requires parsing proprietary format

### 3.2 App Registry

Each entry defines how to detect and launch an app:

```rust
struct AppCandidate {
    id: &'static str,
    name: &'static str,
    category: AppCategory,        // Editor, Terminal, Ide
    bin_names: &'static [&'static str],  // Binaries to find in $PATH
    mac_app_names: &'static [&'static str],  // .app bundles in /Applications (empty on Linux-only apps)
    open_args: &'static [&'static str],  // Extra args after binary, {} = worktree_path placeholder
    needs_terminal: bool,         // TUI apps (vim, nvim, helix)
}
```

`mac_app_names` is present on all platforms (set to `&[]` for Linux-only apps) rather than using `#[cfg(target_os = "macos")]` on the field. This avoids per-platform struct layout divergence and cfg-gating every registry entry. The detection code skips `.app` scanning on Linux, so an empty slice is a clean no-op.

Initial registry:

The `open_args` column shows only the **extra arguments** after the binary name. The binary to execute is resolved from `bin_names` (or `open -a` for `.app`-only detections). `{}` is a placeholder for `worktree_path`.

| id | name | category | bin_names | mac_app_names | open_args | needs_terminal |
|---|---|---|---|---|---|---|
| `vscode` | VS Code | Editor | `["code"]` | `["Visual Studio Code.app"]` | `["{}"]` | no |
| `cursor` | Cursor | Editor | `["cursor"]` | `["Cursor.app"]` | `["{}"]` | no |
| `zed` | Zed | Editor | `["zed"]` | `["Zed.app"]` | `["{}"]` | no |
| `sublime` | Sublime Text | Editor | `["subl"]` | `["Sublime Text.app"]` | `["{}"]` | no |
| `neovim` | Neovim | Editor | `["nvim"]` | `[]` | `["{}"]` | yes |
| `vim` | Vim | Editor | `["vim"]` | `[]` | `["{}"]` | yes |
| `helix` | Helix | Editor | `["hx"]` | `[]` | `["{}"]` | yes |
| `emacs` | Emacs | Editor | `["emacs"]` | `["Emacs.app"]` | `["{}"]` | no |
| `alacritty` | Alacritty | Terminal | `["alacritty"]` | `["Alacritty.app"]` | `["--working-directory", "{}"]` | — |
| `kitty` | Kitty | Terminal | `["kitty"]` | `["kitty.app"]` | `["--directory", "{}"]` | — |
| `ghostty` | Ghostty | Terminal | `["ghostty"]` | `["Ghostty.app"]` | `["--working-directory={}"]` | — |
| `wezterm` | WezTerm | Terminal | `["wezterm"]` | `["WezTerm.app"]` | `["start", "--cwd", "{}"]` | — |
| `iterm2` | iTerm2 | Terminal | `[]` | `["iTerm.app"]` | (AppleScript) | — |
| `macos-terminal` | Terminal | Terminal | `[]` | *(always on macOS)* | (AppleScript) | — |
| `gnome-terminal` | GNOME Terminal | Terminal | `["gnome-terminal"]` | `[]` | `["--working-directory", "{}"]` | — |
| `konsole` | Konsole | Terminal | `["konsole"]` | `[]` | `["--workdir", "{}"]` | — |
| `xfce4-terminal` | Xfce Terminal | Terminal | `["xfce4-terminal"]` | `[]` | `["--working-directory", "{}"]` | — |
| `foot` | Foot | Terminal | `["foot"]` | `[]` | `["--working-directory", "{}"]` | — |
| `intellij` | IntelliJ IDEA | IDE | `["idea"]` | `["IntelliJ IDEA.app", "IntelliJ IDEA CE.app"]` | `["{}"]` | no |
| `xcode` | Xcode | IDE | `[]` | `["Xcode.app"]` | (uses `open -a`) | no |

### 3.3 TUI Editor Handling

Terminal-based editors (vim, nvim, helix) cannot launch standalone — they need a terminal host. When `open_workspace_in_app` is called for an app with `needs_terminal: true`:

1. Look up the first detected terminal from `AppState.detected_apps` (see §4.1)
2. Prefer launching without `sh -c` by passing the workspace path via the terminal's `--working-directory` flag and the editor as separate argv entries:
   - `alacritty --working-directory {worktree_path} -e nvim .`
   - `gnome-terminal --working-directory {worktree_path} -- nvim .`
   - `konsole --workdir {worktree_path} -e nvim .`
   - `kitty --directory {worktree_path} nvim .`
3. Only if a terminal provides no argv-safe alternative, fall back to the robust escaping approach already used by `open_workspace_in_terminal` in `src-tauri/src/commands/workspace.rs` (which escapes single quotes and backslashes before interpolation). Never build ad hoc commands like `cd '{path}' && {editor} .`.

All paths are passed as separate `tokio::process::Command` arguments — not interpolated into shell strings — so no shell quoting or escaping is needed for the common case. This eliminates the shell injection risk.

If no terminal is detected (unlikely), return an error.

### 3.4 macOS AppleScript Terminals

iTerm2 and macOS Terminal.app require AppleScript to open with a working directory. Reuse the existing escaping pattern from `open_workspace_in_terminal` in `src-tauri/src/commands/workspace.rs:459-480`, which escapes both backslashes and single quotes before interpolating into AppleScript strings:

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

The `{escaped_path}` notation indicates the path has been processed through the escaping logic above before interpolation. This is the same strategy the codebase already uses and is safe against paths containing single quotes, backslashes, or shell metacharacters.

### 3.5 macOS .app Bundle Detection for CLI Tools

Some macOS apps install CLI wrappers only after the user explicitly enables them (VS Code's "Install 'code' command in PATH"). When the `.app` bundle exists in `/Applications` but the CLI binary is not in `$PATH`, use `open -a "{App Name}" "{worktree_path}"` as the open command instead of the CLI binary.

To avoid ambiguity between the detected application location and the workspace target path:

- **`DetectedApp.detected_path`**: The location of the app itself — either the resolved binary path from `$PATH` (e.g., `/opt/homebrew/bin/code`) or the `.app` bundle path (e.g., `/Applications/Visual Studio Code.app`). Used by `open_workspace_in_app` to determine the launch strategy.
- **`worktree_path`**: The workspace directory to open. Always passed as the target argument to the app.

The `open_workspace_in_app` command inspects `detected_path` to decide the launch strategy: if it ends in `.app`, use `open -a`; otherwise, invoke the binary directly with `open_args`.

## 4. Implementation

### 4.1 New module: `src-tauri/src/commands/apps.rs`

Data types:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AppCategory {
    Editor,
    Terminal,
    Ide,
}

#[derive(Debug, Clone, Serialize)]
pub struct DetectedApp {
    pub id: String,
    pub name: String,
    pub category: AppCategory,
    /// The location of the app itself — binary path from $PATH or .app bundle path
    pub detected_path: String,
}
```

Detection command:

```rust
#[tauri::command]
pub async fn detect_installed_apps(
    state: State<'_, AppState>,
) -> Result<Vec<DetectedApp>, String> {
    let apps = tokio::task::spawn_blocking(detect_apps_blocking)
        .await
        .map_err(|e| e.to_string())?;
    // Cache in AppState so open_workspace_in_app can access detected terminals for TUI wrapping
    *state.detected_apps.lock().unwrap() = apps.clone();
    Ok(apps)
}
```

`detect_apps_blocking` implementation:
1. Parse `$PATH` into a `Vec<PathBuf>` (split on `:`), then augment with well-known prefixes (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`) and deduplicate
2. For each `AppCandidate` in the registry:
   - Check each `bin_name` against each PATH dir via `std::fs::metadata(dir.join(bin))`
   - On Linux: verify executable bit with `std::os::unix::fs::PermissionsExt` (`mode & 0o111 != 0`)
   - On macOS: also check `/Applications/{app_name}` via `Path::exists()`
   - On macOS: always include `macos-terminal` (ships with the OS)
3. Return `Vec<DetectedApp>` sorted by category then name

**AppState extension** in `src-tauri/src/state.rs`:

```rust
pub struct AppState {
    // ... existing fields ...
    pub detected_apps: Mutex<Vec<DetectedApp>>,
}
```

This allows `open_workspace_in_app` to look up detected terminals when wrapping TUI editors, without re-running detection on every call.

Open command:

```rust
#[tauri::command]
pub async fn open_workspace_in_app(
    app_id: String,
    worktree_path: String,
    state: State<'_, AppState>,
) -> Result<(), String>
```

- Look up `AppCandidate` by id in the static registry
- Build argv by substituting `{}` in `open_args` with `worktree_path` — all paths passed as separate `Command` args, never interpolated into shell strings
- For `needs_terminal` apps: read `state.detected_apps` to find the first detected terminal, then launch using argv-style args (see §3.3)
- For macOS AppleScript apps (iterm2, macos-terminal): spawn via `osascript -e` with escaped path (see §3.4)
- For `.app`-only detections (no CLI binary in PATH): use `open -a "{app_name}" "{worktree_path}"`
- Spawn detached via `tokio::process::Command`

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
| `src-tauri/src/commands/apps.rs` | **New** — app registry, detection logic, open command |
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

- `find_in_path` with a temp directory containing a mock executable → returns path
- `find_in_path` with non-existent binary → returns `None`
- `detect_apps_blocking` returns only apps that actually exist (test with controlled PATH)
- Registry consistency: every `AppCandidate` has a non-empty `id`, `name`, and at least one `bin_names` or `mac_app_names` entry

### Manual verification

1. Run `cargo tauri dev`, open a workspace, click "Actions" dropdown
2. Verify detected apps appear grouped by category (Editors, Terminals, IDEs)
3. Click an editor entry → app opens with workspace directory
4. Click a terminal entry → terminal opens at workspace path
5. "Copy Path" still works at the bottom of the menu
6. On a system with few apps installed, menu gracefully shows only what's found plus "Copy Path"

## 7. Future Considerations

- **User preferences**: Allow setting a preferred app per category via `app_settings` (keys: `preferred_editor`, `preferred_terminal`, `preferred_ide`), displayed first in its group with a checkmark
- **Flatpak/Snap detection (Linux)**: Check `flatpak list --columns=application` for additional apps
- **File-level actions**: Extend to support opening specific files (not just directories) from the diff viewer
- **Keyboard shortcuts**: Add keybindings for "Open in preferred editor" (Cmd+Shift+E) and "Open in preferred terminal" (Cmd+Shift+T)
- **Refresh detection**: Allow re-running detection after the user installs new apps without restarting
