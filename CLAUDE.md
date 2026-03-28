# Claudette

Cross-platform desktop orchestrator for parallel Claude Code agents, built with Tauri v2 + React.

## Build & run commands

```bash
bun install                          # Install frontend dependencies
bun run tauri dev                    # Run in development mode (hot-reload)
bun run tauri build                  # Build release binary
bun run build                        # Build frontend only

# Rust backend (run from src-tauri/)
cargo clippy --all-targets --all-features  # Lint (must pass with zero warnings)
cargo fmt --all --check              # Check formatting
cargo test --all-features            # Run Rust tests
```

IMPORTANT: CI sets `RUSTFLAGS="-Dwarnings"` — all compiler warnings are errors. Fix warnings before committing.

## Code style

- **Frontend**: TypeScript + React — use functional components, hooks, and modern React patterns
- **Backend**: Rust edition 2021 — default `rustfmt` and `clippy` rules, no custom overrides
- Prefer `cargo fmt` and consistent TypeScript formatting before committing; CI enforces both

## Commit conventions

- **Conventional commits required** — `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `ci:`, `chore:`, etc.
- Header max 100 characters
- PR titles must also follow conventional commit format (validated by CI)
- Release management is automated via release-please

## Architecture

- **Frontend**: React 19 + TypeScript + Vite (SPA served by Tauri)
- **Backend**: Tauri v2 (Rust) — commands, event system, plugin ecosystem
- **Process management**: Tokio async runtime (via Tauri) for spawning Claude Code agents
- **Data persistence**: SQLite via rusqlite (or Tauri plugin) for workspace metadata, chat history, settings
- **Git operations**: Shelling out to `git` via `tokio::process::Command` for worktree ops
- **IPC**: Tauri command system — Rust functions callable from JS via `invoke()`

### Tauri pattern

- **Rust commands** are defined with `#[tauri::command]` and registered in `src-tauri/src/lib.rs`
- **Frontend** calls commands via `import { invoke } from "@tauri-apps/api/core"`
- **Events** can be emitted from Rust and listened to in JS (and vice versa)
- **Plugins** extend functionality (e.g., `tauri-plugin-opener`, `tauri-plugin-shell`)

## Project structure

```
package.json               — Frontend dependencies and scripts
index.html                 — Web entry point
vite.config.ts             — Vite bundler config
tsconfig.json              — TypeScript config
src/                       — Frontend source (React + TypeScript)
  main.tsx                 — React entry point
  App.tsx                  — Root component
  App.css                  — Root styles
  assets/                  — Static assets (images, SVGs)
src-tauri/                 — Rust backend (Tauri core)
  tauri.conf.json          — Tauri config (app ID, window settings, build commands)
  Cargo.toml               — Rust dependencies
  build.rs                 — Tauri build script
  src/
    main.rs                — Desktop entry point
    lib.rs                 — Main Rust logic, Tauri builder setup, command registration
  capabilities/            — Security capabilities (permissions for JS command access)
    default.json
  icons/                   — App icons (png, icns, ico)
assets/                    — Workspace icon SVGs (for UI)
```

### Guidelines for new code

#### Frontend (`src/`)
- **Components** go in `src/components/` — one file per component, named `PascalCase.tsx`
- **Hooks** go in `src/hooks/` — custom hooks for shared logic
- **Types** go in `src/types/` — shared TypeScript interfaces and types
- **Services** go in `src/services/` — Tauri command wrappers (invoke calls)
- **State management**: Use React context + hooks, or a lightweight state lib if needed

#### Backend (`src-tauri/src/`)
- **Commands** are defined with `#[tauri::command]` — group related commands in modules
- **Data types** used by commands go in `src-tauri/src/model/`
- **Service/IO modules** (`db.rs`, `git.rs`) live at `src-tauri/src/` level
- Keep command handlers thin — delegate to service modules

### Database conventions

- `rusqlite::Connection` is not `Send` — open connections within Tauri command handlers, not stored on app state
- Schema migrations use `PRAGMA user_version` — bump the version when adding new migrations

## Project context

- See GitHub Issue #5 for the full MVP PRD
- See GitHub Issue #11 for the Workspace Management TDD
- P0 features: workspace management, agent chat, diff viewer, integrated terminal, checkpoints, git/GitHub integration, scripts, repo settings
- Target platforms: macOS (Apple Silicon + Intel) and Linux (x86_64, Wayland + X11)

## System dependencies (Linux)

Arch Linux:
```bash
sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget file openssl appmenu-gtk-module libappindicator-gtk3 librsvg xdotool
```

Ubuntu/Debian:
```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

## Dependencies

- Add dependencies conservatively — binary size target is < 30 MB
- Cold start target is < 2 seconds to interactive UI
- When choosing crates or npm packages, prefer well-maintained options with minimal transitive dependencies
