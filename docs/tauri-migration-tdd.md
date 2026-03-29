# Technical Design: Iced to Tauri + React Migration

**Status**: Draft
**Author**: @bakedbean
**Date**: 2026-03-29
**Branch**: `bakedbean/tauri-ui`

## 1. Motivation

The Iced GUI framework has proven limiting for the chat feature and rich text rendering needs of Claudette. Key pain points:

- **Chat rendering**: Iced's `markdown::view` widget lacks the flexibility needed for streaming content, collapsible tool activities, and clickable links
- **Terminal emulation**: `iced_term` is immature and incomplete compared to web-based alternatives like xterm.js
- **Diff rendering**: Building a side-by-side diff viewer with proper line pairing, syntax highlighting, and scrolling in Iced requires fighting the framework
- **Ecosystem**: Web technologies offer vastly better component libraries, CSS layout, and developer tooling for these UI patterns

This document proposes replacing the Iced frontend with **Tauri 2.x** (Rust backend) + **React/TypeScript** (webview UI), while preserving the existing backend modules which are already fully decoupled from Iced.

## 2. Current Architecture

```
src/
  main.rs          — Iced app entry point
  app.rs           — Monolithic App struct with update()/view() (~2,500 lines)
  app/chat.rs      — Chat-specific logic extracted from app (~217 lines)
  message.rs       — Message enum with ~180 variants
  terminal.rs      — iced_term PTY integration
  icons.rs         — Bundled Lucide SVG icons (~200 icons)
  names/           — Random workspace name generator (pure Rust)
  db.rs            — SQLite CRUD via rusqlite (zero Iced deps)
  git.rs           — Async git operations via tokio::process (zero Iced deps)
  diff.rs          — Diff parsing + git diff operations (zero Iced deps)
  agent.rs         — Claude CLI subprocess + JSON streaming (zero Iced deps)
  model/           — Pure data structs: Repository, Workspace, ChatMessage, TerminalTab, diff types
  ui/              — All Iced view functions (~2,900 lines across 15 files)
```

### Backend/Frontend Coupling Assessment

| Module | Iced Dependency | Reusable As-Is |
|--------|----------------|----------------|
| `db.rs` | None | Yes |
| `git.rs` | None | Yes |
| `diff.rs` | None | Yes |
| `agent.rs` | None | Yes |
| `model/` | None | Yes (add `Serialize` derives) |
| `names/` | None | Yes |
| `app.rs` | Heavy (`Task`, `Element`) | No — business logic must be extracted |
| `message.rs` | Heavy (framework dispatch) | No — replaced by Tauri commands |
| `terminal.rs` | Heavy (`iced_term`) | No — replaced by PTY bridge + xterm.js |
| `ui/` | Heavy (Iced widgets) | No — replaced by React components |
| `icons.rs` | Moderate (SVG bundling) | No — replaced by `lucide-react` |

**Key finding**: ~2,500 lines of backend code (db, git, diff, agent, model, names) have zero Iced imports and can be reused without modification. ~6,300 lines of Iced-specific code will be replaced.

## 3. Proposed Architecture

### 3.1 Directory Structure

```
Cargo.toml              <- workspace root + claudette-core lib package
src/
  lib.rs                <- re-exports backend modules (replaces main.rs)
  db.rs                 <- kept as-is
  git.rs                <- kept as-is
  diff.rs               <- kept as-is
  agent.rs              <- kept as-is
  model/                <- kept as-is (add Serialize derives)
  names/                <- kept as-is
  ui/                   <- React/Vite frontend (replaces Iced views)
    package.json
    vite.config.ts
    tsconfig.json
    index.html
    src/
      App.tsx
      components/       <- UI components organized by feature
      hooks/            <- Tauri event listeners and utilities
      stores/           <- Zustand state management
      types/            <- TypeScript types matching Rust models
      styles/           <- CSS custom properties and theme
src-tauri/              <- Tauri binary crate (flat layout)
  Cargo.toml            <- depends on claudette-core
  tauri.conf.json
  build.rs
  capabilities/
  src/
    main.rs             <- Tauri entry point + command registration
    commands/           <- #[tauri::command] wrappers by domain
    state.rs            <- managed AppState
    pty.rs              <- PTY management (replaces iced_term)
assets/
  logo.png
  icons/                <- Lucide SVGs (available but lucide-react preferred)
```

### 3.2 Cargo Workspace

The root `Cargo.toml` becomes both the workspace root and the `claudette-core` library package:

```toml
[workspace]
members = ["src-tauri"]

[package]
name = "claudette-core"
version = "0.1.0"
edition = "2024"

[lib]
path = "src/lib.rs"

[dependencies]
futures = "0.3"
tokio = { version = "1", features = ["process", "fs", "io-util", "time", "sync"] }
rusqlite = { version = "0.34", features = ["bundled"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
uuid = { version = "1", features = ["v4"] }
dirs = "6"
open = "5"
rand = "0.8"
```

The Tauri binary crate at `src-tauri/Cargo.toml`:

```toml
[package]
name = "claudette-tauri"
version = "0.1.0"
edition = "2024"

[dependencies]
claudette-core = { path = ".." }
tauri = { version = "2", features = ["devtools"] }
tauri-plugin-dialog = "2"
tauri-plugin-shell = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["sync", "time"] }
uuid = { version = "1", features = ["v4"] }
portable-pty = "0.8"

[build-dependencies]
tauri-build = "2"
```

### 3.3 Dependencies

**Rust — Remove**:
- `iced` (all features), `iced_term`, `rfd`, `image`
- `objc2`, `objc2-app-kit`, `objc2-foundation` (Tauri handles dock icon natively)

**Rust — Add** (in `src-tauri/`):
- `tauri` 2.x, `tauri-build` 2.x
- `tauri-plugin-dialog` 2.x (replaces `rfd`)
- `tauri-plugin-shell` 2.x
- `portable-pty` 0.8 (replaces `iced_term` for PTY management)

**NPM** (in `src/ui/`):
- `@tauri-apps/api` ^2, `@tauri-apps/plugin-dialog` ^2
- `react`, `react-dom`, `typescript`, `vite`
- `lucide-react` (tree-shakeable icon library, replaces `icons.rs`)
- `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links`
- `react-markdown`, `remark-gfm`, `rehype-highlight`
- `zustand` (state management)

## 4. Tauri Command Layer

Business logic currently embedded in `app.rs`'s `update()` method (~20 operations) is extracted into `#[tauri::command]` functions organized by domain.

### 4.1 Commands by Domain

**`commands/data.rs`** — App initialization:
| Command | Description |
|---------|-------------|
| `load_initial_data()` | Load repos, workspaces, settings, seed terminal IDs |

**`commands/repository.rs`** — Repository CRUD:
| Command | Description |
|---------|-------------|
| `add_repository(path)` | Validate git repo + insert DB record |
| `update_repository_settings(id, name, icon)` | Update display name and icon |
| `relink_repository(id, path)` | Validate + update path for moved repos |
| `remove_repository(id)` | Remove all worktrees + cascade delete |
| `browse_folder()` | Native folder picker via `tauri-plugin-dialog` |

**`commands/workspace.rs`** — Workspace lifecycle:
| Command | Description |
|---------|-------------|
| `create_workspace(repo_id, name)` | Validate name, create git worktree + DB record |
| `archive_workspace(id)` | Remove worktree, mark as archived |
| `restore_workspace(id)` | Restore worktree from existing branch |
| `delete_workspace(id)` | Remove worktree + branch + DB record |
| `generate_workspace_name()` | Random name via `names::NameGenerator` |

**`commands/chat.rs`** — Chat + agent:
| Command | Description |
|---------|-------------|
| `load_chat_history(workspace_id)` | Fetch all messages from DB |
| `send_chat_message(workspace_id, content)` | Spawn agent turn, bridge streaming to Tauri events |
| `stop_agent(workspace_id)` | Kill running agent process |

**`commands/diff.rs`** — Diff operations:
| Command | Description |
|---------|-------------|
| `load_diff_files(workspace_id)` | List changed files + merge base |
| `load_file_diff(worktree_path, merge_base, file_path)` | Unified diff for a single file |
| `revert_file(worktree_path, merge_base, file_path, status)` | Restore file to merge-base state |

**`commands/terminal.rs`** — Terminal tab metadata:
| Command | Description |
|---------|-------------|
| `create_terminal_tab(workspace_id)` | Insert DB record |
| `delete_terminal_tab(id)` | Remove DB record |
| `list_terminal_tabs(workspace_id)` | Fetch tabs for workspace |

**`commands/settings.rs`** — App settings:
| Command | Description |
|---------|-------------|
| `get_app_setting(key)` | Read setting from DB |
| `set_app_setting(key, value)` | Write setting to DB |

### 4.2 Managed State

```rust
pub struct AppState {
    pub db_path: PathBuf,
    pub worktree_base_dir: RwLock<PathBuf>,
    pub agents: RwLock<HashMap<String, AgentSessionState>>,
    pub ptys: RwLock<HashMap<u64, PtyHandle>>,
}
```

Each command that needs DB access opens a short-lived `Database::open(&db_path)` connection (matching the existing pattern — `rusqlite::Connection` is not `Send`).

Agent sessions are managed in Rust-side state (not React) to prevent race conditions during session teardown.

### 4.3 Agent Streaming Bridge

The current Iced implementation uses `tokio::sync::mpsc` channels polled by `Subscription::run_with()`. In Tauri, this becomes:

1. `send_chat_message` command calls `agent::run_turn()`, gets `TurnHandle` with `mpsc::Receiver<AgentEvent>`
2. A background Tokio task reads from the receiver
3. Each event is emitted as a typed Tauri event:

| Event | Payload | Description |
|-------|---------|-------------|
| `agent:stream-text` | `{ workspace_id, text }` | Incremental text delta |
| `agent:tool-start` | `{ workspace_id, tool_name, tool_use_id }` | Tool use block started |
| `agent:tool-result` | `{ workspace_id, tool_use_id, content }` | Tool result received |
| `agent:message-complete` | `{ workspace_id, message: ChatMessage }` | Full assistant message (persisted to DB) |
| `agent:turn-result` | `{ workspace_id, cost_usd, duration_ms }` | Turn finished |
| `agent:exit` | `{ workspace_id, exit_code }` | Process exited |

The React frontend listens via `listen("agent:stream-text", callback)` and updates Zustand state incrementally.

### 4.4 PTY Bridge (Terminal)

Replaces `iced_term` with `portable-pty` for cross-platform PTY management + xterm.js in the webview.

**Rust side** (`src-tauri/src/pty.rs`):

| Function | Description |
|----------|-------------|
| `spawn_pty(working_dir) -> pty_id` | Spawn shell process, start background reader task |
| `write_pty(pty_id, data)` | Write to PTY stdin |
| `resize_pty(pty_id, cols, rows)` | Send SIGWINCH |
| `close_pty(pty_id)` | Kill PTY process |

**Data flow**:
```
[Shell PTY] --stdout--> [Tokio reader] --emit--> [Tauri "pty:output" event] --> [xterm.js]
[xterm.js]  --onData--> [invoke("write_pty")] --> [Shell PTY stdin]
[xterm.js]  --onResize-> [invoke("resize_pty")] --> [SIGWINCH]
```

## 5. React Frontend

### 5.1 State Management — Zustand

Zustand was chosen over alternatives for this project:
- **Context API**: Too much boilerplate for 60+ UI state fields; re-render performance issues
- **Redux**: Over-engineered; action/reducer pattern duplicates Tauri's command-based architecture
- **Zustand**: Minimal API, natural async integration with Tauri `invoke()`, supports store slices

```
src/ui/src/stores/
  useAppStore.ts             — root store combining slices
  slices/
    repositorySlice.ts       — repos[], modal state
    workspaceSlice.ts        — workspaces[], selectedWorkspace, modal state
    chatSlice.ts             — chatMessages{}, chatInput, streaming state, tool activities
    diffSlice.ts             — diffFiles[], selectedFile, diffContent, viewMode
    terminalSlice.ts         — terminalTabs{}, activePtyIds
    uiSlice.ts               — panel visibility, widths, modal toggles, fuzzy finder
```

### 5.2 Component Tree

Maps 1:1 to the current Iced UI modules:

| Iced Module | React Component(s) | Notes |
|-------------|-------------------|-------|
| `ui/sidebar.rs` | `Sidebar`, `RepoGroup`, `WorkspaceItem` | |
| `ui/chat_panel.rs` | `ChatPanel`, `ChatMessage`, `ChatInput`, `StreamingIndicator`, `ToolActivity` | react-markdown for rendering |
| `ui/diff_content.rs` | `DiffContent` | Unified + side-by-side modes |
| `ui/diff_viewer.rs` | `DiffViewer` | Header + back navigation |
| `ui/diff_file_tree.rs` | `DiffFileTree` | Status indicators (A/M/D/R) |
| `ui/modal.rs` | 9 separate modal components | One per modal type |
| `ui/terminal_panel.rs` | `TerminalPanel`, `XTermWrapper` | xterm.js integration |
| `ui/fuzzy_finder.rs` | `FuzzyFinder` | Cmd+K workspace search |
| `ui/icon_picker.rs` | `IconPickerModal` | Uses lucide-react |
| `ui/right_sidebar.rs` | `RightSidebar` | |
| `ui/status_bar.rs` | `StatusBar` | Panel toggle icons |
| `ui/divider.rs` | `ResizableDivider` | Mouse drag-to-resize |
| `ui/style.rs` | CSS custom properties in `styles/theme.css` | |

### 5.3 Hooks

| Hook | Purpose |
|------|---------|
| `useAgentStream` | Listen to `agent:*` Tauri events, update Zustand chat/agent state |
| `usePtyStream` | Listen to `pty:output` events, write to xterm.js instance |
| `useKeyboardShortcuts` | Cmd+B (sidebar), Cmd+K (fuzzy finder), Cmd+D (right sidebar), Cmd+\` (terminal), Escape (dismiss modals) |
| `useBranchRefresh` | Poll `refresh_branches()` every 5 seconds |

### 5.4 Theme

Dark theme matching existing Iced color palette, translated to CSS custom properties:

```css
:root {
  --sidebar-bg: rgb(26, 26, 31);        /* SIDEBAR_BG */
  --sidebar-border: rgb(46, 46, 56);    /* SIDEBAR_BORDER */
  --text-primary: rgb(230, 230, 235);   /* TEXT */
  --text-muted: rgb(128, 128, 137);     /* MUTED */
  --text-dim: rgb(115, 115, 128);       /* DIM */
  --hover-bg: rgba(255, 255, 255, 0.05);/* HOVER_BG */
  --selected-bg: rgba(255, 255, 255, 0.08); /* SELECTED_BG */
  --status-running: rgb(51, 204, 77);   /* STATUS_RUNNING */
  --status-idle: rgb(128, 128, 128);    /* STATUS_IDLE */
  --status-stopped: rgb(204, 51, 51);   /* STATUS_STOPPED */
  --diff-added-bg: rgba(0, 128, 0, 0.15);   /* DIFF_ADDED_BG */
  --diff-removed-bg: rgba(128, 0, 0, 0.15); /* DIFF_REMOVED_BG */
  --chat-user-bg: rgba(255, 255, 255, 0.06);/* CHAT_USER_BG */
  /* ... full palette from src/ui/style.rs */
}
```

## 6. Implementation Phases

### Phase 0: Cargo Workspace Restructuring
**Goal**: Library crate compiles, all backend tests pass.

1. Convert root `Cargo.toml` to workspace + lib
2. Create `src/lib.rs` exporting backend modules
3. Add `Serialize` derives to model types and agent event types
4. Delete Iced-specific files: `main.rs`, `app.rs`, `app/`, `message.rs`, `terminal.rs`, `icons.rs`, `ui/`
5. Verify: `cargo test --all-features` passes, `cargo clippy` clean

### Phase 1: Tauri Binary + Commands
**Goal**: Window opens, IPC works, all backend operations accessible.

1. Clean up `src-tauri/` (delete nested scaffolding, stale artifacts)
2. Create Tauri binary crate with `tauri.conf.json`
3. Implement all `#[tauri::command]` wrappers (Section 4.1)
4. Implement agent streaming bridge (Section 4.3)
5. Implement PTY bridge (Section 4.4)
6. Placeholder HTML page confirms IPC works

### Phase 2: React Scaffolding
**Goal**: Vite project initialized, component structure in place, types defined.

1. Initialize Vite + React + TypeScript in `src/ui/`
2. Install NPM dependencies
3. Define TypeScript types matching Rust models
4. Create Zustand store slices
5. Scaffold all component files
6. Set up CSS theme

### Phase 3: Feature Implementation
**Goal**: Feature parity with the Iced implementation.

| Step | Feature | Test Criteria |
|------|---------|--------------|
| 3.1 | Sidebar + repository management | Add/remove/relink/settings repos |
| 3.2 | Workspace lifecycle + fuzzy finder | Create/archive/restore/delete workspaces |
| 3.3 | Chat + agent streaming | Send prompt, see streaming response + tool activities |
| 3.4 | Diff viewer | View changed files, unified/side-by-side diffs, revert |
| 3.5 | Terminal (xterm.js + PTY) | Open terminal, run commands, multiple tabs, resize |
| 3.6 | Polish | Panel resizing, keyboard shortcuts, status bar, branch refresh |

### Phase 4: Cleanup
1. Remove any leftover Iced artifacts
2. Update `.gitignore` (`node_modules/`, `src/ui/dist/`)
3. Update `mise.toml` (add `node = "22"`)
4. Update `CLAUDE.md` with new architecture and build commands
5. Update CI pipeline
6. Release build optimizations (`strip = true`, `lto = true`)

## 7. Verification

| Check | Command |
|-------|---------|
| Frontend dev server | `cd src/ui && npm run dev` |
| Tauri dev mode | `cd src-tauri && cargo tauri dev` |
| Backend tests | `cargo test -p claudette-core` |
| Rust lint | `cargo clippy --workspace` |
| TypeScript check | `cd src/ui && npx tsc --noEmit` |
| Release build | `cargo tauri build` |
| Binary size | Target < 30MB |
| Cold start | Target < 2s to interactive UI |

## 8. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| PTY throughput via Tauri events too slow | High | Benchmark early in Phase 3.5. Fallback: WebSocket or Tauri custom protocol for binary data |
| Large terminal output buffering | Medium | xterm.js handles this natively. Batch Tauri event emissions in reader task |
| Chat markdown re-render performance | Medium | Virtualize message list with `react-window` if needed. Only render visible messages |
| Binary size exceeds 30MB | Medium | Tauri 2.x Linux baseline is ~8-15MB. Tree-shake `lucide-react` imports. Use `cargo bloat` to audit |
| Cold start exceeds 2s | Low | Tauri WebView init is typically <500ms. Pre-render skeleton UI. Lazy-load heavy components |

## 9. What This Does NOT Change

- **Database schema** — no migrations needed
- **Git operations** — `git.rs` used as-is
- **Agent subprocess protocol** — `agent.rs` used as-is, streaming events are the same JSON format from the Claude CLI
- **Data models** — same structs, just adding `Serialize` derives
- **Worktree management strategy** — same base directory, same naming conventions
- **Target platforms** — macOS (Apple Silicon + Intel) and Linux (x86_64)
