# Claudette

Cross-platform desktop orchestrator for parallel Claude Code agents, built with Rust (Tauri 2) and React/TypeScript.

## Build & test commands

```bash
# Backend (Rust)
cargo test --all-features                        # Run all backend tests
cargo clippy --workspace --all-targets           # Lint (must pass with zero warnings)
cargo fmt --all --check                          # Check formatting

# Frontend (React/TypeScript)
cd src/ui && bun install                         # Install frontend dependencies
cd src/ui && bun run build                       # Build frontend for production
cd src/ui && bunx tsc --noEmit                   # TypeScript type check

# Full app
cargo tauri dev                                  # Dev mode with hot-reload
cargo tauri build                                # Release build
```

IMPORTANT: CI sets `RUSTFLAGS="-Dwarnings"` — all compiler warnings are errors. Fix warnings before committing.

## Code style

- Rust edition 2024 — use modern idioms (`let chains`, `gen blocks` if stabilized, etc.)
- Default `rustfmt` and `clippy` rules — no custom overrides
- Prefer `cargo fmt` before committing; CI enforces it
- TypeScript: strict mode, no `any` types

## Commit conventions

- **Conventional commits required** — `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `ci:`, `chore:`, etc.
- Header max 100 characters
- PR titles must also follow conventional commit format (validated by CI)
- Release management is automated via release-please

## Architecture

- **GUI**: Tauri 2.x (Rust backend) + React/TypeScript (webview frontend)
- **State management**: Zustand (single store with domain slices)
- **Async runtime**: Tokio for process management and git operations
- **Data persistence**: SQLite via rusqlite (bundled)
- **Git operations**: Shelling out to `git` via `tokio::process::Command` for worktree ops
- **Agent integration**: Claude CLI subprocess with JSON streaming, bridged to frontend via Tauri events
- **Terminal emulation**: portable-pty (Rust) + xterm.js (frontend)
- **IPC**: Tauri commands (`#[tauri::command]`) for request/response, Tauri events for streaming

## Project structure

```
Cargo.toml              — workspace root + claudette lib crate
src/
  lib.rs                — library entry point, re-exports backend modules
  db.rs                 — SQLite database: connection, migrations, CRUD
  git.rs                — async git worktree operations
  diff.rs               — diff parsing and git diff operations
  agent.rs              — Claude CLI subprocess + JSON streaming
  model/                — data types (no UI or IO logic)
    repository.rs
    workspace.rs
    chat_message.rs
    terminal_tab.rs
    diff.rs
  names/                — random workspace name generator
  ui/                   — React/Vite frontend
    src/
      App.tsx           — root component, loads initial data
      components/       — UI components by feature area
        layout/         — AppLayout, StatusBar
        sidebar/        — Sidebar with repo/workspace tree
        chat/           — ChatPanel with markdown + streaming
        diff/           — DiffViewer with unified diff rendering
        terminal/       — TerminalPanel with xterm.js
        modals/         — Modal dialogs (add repo, create workspace, etc.)
        right-sidebar/  — Changed files list
        fuzzy-finder/   — Cmd+K workspace search
      hooks/            — useAgentStream, useKeyboardShortcuts, useBranchRefresh
      stores/           — Zustand store (useAppStore)
      services/         — Typed Tauri invoke() wrappers
      types/            — TypeScript types matching Rust models
      styles/           — CSS custom properties (dark theme)
src-tauri/
  Cargo.toml            — Tauri binary crate (depends on claudette)
  tauri.conf.json       — Tauri configuration
  src/
    main.rs             — Tauri entry point, command registration
    commands/           — #[tauri::command] wrappers by domain
    state.rs            — managed AppState (db_path, agents, PTYs)
    pty.rs              — PTY management via portable-pty
```

### Guidelines for new code

- **Data types** go in `model/` — keep them free of UI and IO dependencies. All model types must derive `Serialize`.
- **Service/IO modules** (`db.rs`, `git.rs`, `diff.rs`, `agent.rs`) live at `src/` level in the `claudette` crate
- **Tauri commands** go in `src-tauri/src/commands/` — thin wrappers that call into `claudette`
- **React components** go in `src/ui/src/components/` — organized by feature area
- **State** lives in the Zustand store (`useAppStore`) — UI state in React, agent sessions in Rust-side `AppState`
- **Streaming data** (agent events, PTY output) flows via Tauri events, consumed by React hooks
- **Colors and styling** use CSS custom properties defined in `styles/theme.css`

### Database conventions

- `rusqlite::Connection` is not `Send` — open a fresh connection in each Tauri command via `Database::open(&state.db_path)`
- Schema migrations use `PRAGMA user_version` — bump the version when adding new migrations
- UI-only state (collapsed sections, panel widths, selection) is NOT persisted — keep in Zustand

## Project context

- See GitHub Issue #5 for the full MVP PRD
- See GitHub Issue #11 for the Workspace Management TDD
- See `docs/tauri-migration-tdd.md` for the Iced-to-Tauri migration design document
- P0 features: workspace management, agent chat, diff viewer, integrated terminal, checkpoints, git/GitHub integration, scripts, repo settings
- Target platforms: macOS (Apple Silicon + Intel) and Linux (x86_64, Wayland + X11)

## Dependencies

- Add dependencies conservatively — binary size target is < 30 MB
- Cold start target is < 2 seconds to interactive UI
- When choosing crates, prefer well-maintained options with minimal transitive dependencies
- Frontend: use `bun` as package manager, not npm
