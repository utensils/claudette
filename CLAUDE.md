# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Claudette

Cross-platform desktop orchestrator for parallel Claude Code agents, built with Rust (Tauri 2) and React/TypeScript.

## Build & test commands

```bash
# Backend (Rust)
cargo test --all-features                        # Run all backend tests
cargo test -p claudette --test diff_tests        # Run a single test file
cargo test -p claudette parse_unified -- --exact # Run a single test by name
cargo clippy --workspace --all-targets           # Lint (must pass with zero warnings)
cargo fmt --all --check                          # Check formatting

# Frontend (React/TypeScript)
cd src/ui && bun install                         # Install frontend dependencies
cd src/ui && bun run build                       # Build frontend (runs tsc -b && vite build)
cd src/ui && bunx tsc -b                         # TypeScript type check (same as CI)
cd src/ui && bun run test                        # Run frontend tests (vitest)
cd src/ui && bun run test:watch                  # Run tests in watch mode

# Full app
cargo tauri dev                                  # Dev mode with hot-reload
cargo tauri build                                # Release build
```

IMPORTANT: CI sets `RUSTFLAGS="-Dwarnings"` — all compiler warnings are errors. Fix warnings before committing.

IMPORTANT: Always run `cd src/ui && bunx tsc -b` after modifying TypeScript files (including tests). CI runs `tsc -b` via `bun run build` — `vitest` does **not** type-check (it uses esbuild), so tests can pass locally while types are broken. Run `tsc -b` as the final check before committing any frontend change.

CI also enforces `bun install --frozen-lockfile` — do not modify `bun.lock` without intention. CI runs `cargo llvm-cov` for Rust test coverage (uploaded to Codecov). CI lints only the `claudette` and `claudette-server` crates (not `claudette-tauri`, which requires system libs).

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

### Crate structure

Three crates in a Cargo workspace:

| Crate | Path | Purpose |
|---|---|---|
| `claudette` | `src/` (workspace root) | Core library — models, db, git, diff, agent logic. No UI or Tauri dependencies. |
| `claudette-tauri` | `src-tauri/` | Tauri binary. Thin `#[tauri::command]` wrappers that call into `claudette`. |
| `claudette-server` | `src-server/` | WebSocket server for remote access. Also embeddable in the Tauri binary. |

Feature flags in `claudette-tauri`:
- `default = ["server"]` — bundles the remote server into the desktop app
- `devtools` — enables Tauri devtools (`tauri/devtools`)
- `server` — optional dep on `claudette-server`

### Frontend

- Vite dev server runs on **port 1420** with `strictPort: true` — if the port is taken, dev mode fails
- TypeScript enforces `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`
- Test runner is **vitest** (not Jest)
- macOS uses overlay title bar (`titleBarStyle: "Overlay"`) — affects layout near top of window

### Tauri commands

Commands in `src-tauri/src/commands/` are organized by domain: `chat`, `workspace`, `repository`, `scm`, `terminal`, `diff`, `settings`, `plugin`, `mcp`, `remote`, `usage`, `metrics`, `files`, `shell`, `slash_commands`, `plan`, `apps`, `data`, `cesp`, `updater`, `debug`. Each is a thin wrapper — business logic belongs in the `claudette` crate.

## Project structure

```
Cargo.toml              — workspace root + claudette lib crate
src/
  lib.rs                — library entry point, re-exports backend modules
  db.rs                 — SQLite database: connection, migrations, CRUD
  migrations/           — versioned .sql files + MIGRATIONS registry
  git.rs                — async git worktree operations
  diff.rs               — diff parsing and git diff operations
  agent.rs              — Claude CLI subprocess + JSON streaming
  fork.rs               — session forking / checkpoint branching
  snapshot.rs           — workspace snapshots
  process.rs            — cross-platform process spawning helpers
  mcp.rs / mcp_supervisor.rs — MCP server config + lifecycle supervision
  plugin.rs             — Claude-Code plugin marketplace integration
  plugin_runtime/       — sandboxed Lua runtime (mlua) shared across plugin kinds
  permissions.rs        — tool/permission policy
  scm/                  — SCM consumer of plugin_runtime: PR/CI types + host/URL detection
  env_provider/         — env-provider consumer: dispatcher, mtime cache, merged ResolvedEnv
  slash_commands.rs     — slash command loading and dispatch
  cesp.rs               — CESP (Claudette event stream protocol)
  config.rs / env.rs / path.rs / file_expand.rs — config, env, path helpers
  model/                — data types (no UI or IO logic); all derive Serialize
  names/                — random workspace name generator
  ui/                   — React/Vite frontend (see src/ui/package.json)
src-tauri/              — Tauri binary crate
  src/commands/         — #[tauri::command] wrappers by domain
  src/state.rs          — managed AppState (db_path, agents, PTYs)
  src/pty.rs            — PTY management via portable-pty
  src/tray.rs           — system tray: icon/menu/tooltip, notifications
  src/transport/        — Remote transport trait + WebSocket client
  src/remote.rs         — embedded remote server wiring
  src/mdns.rs           — mDNS advertisement for remote discovery
  src/osc133.rs         — OSC 133 terminal prompt-marker parsing
src-server/             — Standalone + embeddable remote server
plugins/                — bundled Lua plugins (compiled in via include_str!)
  scm-github/           — GitHub PR / CI provider
  scm-gitlab/           — GitLab PR / CI provider
  env-direnv/           — direnv env activation
  env-mise/             — mise env activation
  env-dotenv/           — `.env` in-process parser
  env-nix-devshell/     — `nix print-dev-env` env activation
```

### Plugin system

A single sandboxed Lua runtime (`src/plugin_runtime/`) serves multiple plugin kinds declared via `plugin.json`'s `kind` field (`scm` | `env-provider`, defaults to `scm`). Each kind has its own domain consumer (`src/scm/`, `src/env_provider/`) that dispatches operations on top of the shared runtime. Bundled plugins live in `plugins/*/` and are seeded into the user's plugin dir on first run. Users can drop their own plugins into `~/.claudette/plugins/<name>/` (one `plugin.json` + one `init.lua`); discovery picks them up at startup.

### Guidelines for new code

- **Data types** go in `model/` — keep them free of UI and IO dependencies. All model types must derive `Serialize`.
- **Service/IO modules** (`db.rs`, `git.rs`, `diff.rs`, `agent.rs`) live at `src/` level in the `claudette` crate
- **Tauri commands** go in `src-tauri/src/commands/` — thin wrappers that call into `claudette`
- **React components** go in `src/ui/src/components/` — organized by feature area
- **State** lives in the Zustand store (`useAppStore`) — UI state in React, agent sessions in Rust-side `AppState`
- **Streaming data** (agent events, PTY output) flows via Tauri events, consumed by React hooks
- **Colors and styling** use CSS custom properties defined in `styles/theme.css`

### Testing patterns

- **Rust**: tests use `tempfile::tempdir()` to create ephemeral git repos — no fixtures or test databases. Async tests use `#[tokio::test]`. Test modules live at the bottom of each file (`#[cfg(test)] mod tests`).
- **TypeScript**: vitest with `describe`/`it`/`expect`. Zustand tests reset state via `useAppStore.setState()` in `beforeEach`. No test database — frontend tests are pure state/logic tests. When constructing fixtures for store state, always read the actual type definition (e.g., `TerminalTab` in `types/terminal.ts`) — do not guess field names. Look for existing `make*` helpers in adjacent test files before creating new fixtures.

### Windows specifics

- `AGENTS.md` is a symlink to `CLAUDE.md` for Codex/other agent-tool compatibility — edit `CLAUDE.md`, never `AGENTS.md`.
- Windows builds use MSVC toolchain; `[target.'cfg(windows)'.dependencies]` in `Cargo.toml` pulls in Windows-only crates. Gate Windows-specific code with `#[cfg(windows)]` / `#[cfg(not(windows))]` rather than Unix-only paths.

### Notification architecture

- Notification sound and commands run on the **Rust side** (not in the webview) — macOS suspends webview JS when the window is hidden
- `tray.rs` handles attention notifications (AskUserQuestion/ExitPlanMode); `commands/chat.rs` handles agent-finished notifications
- Both paths use the shared `build_notification_command` helper in `commands/settings.rs`
- `mac-notification-sys` for native macOS notifications with click-to-navigate; `tauri-plugin-notification` on Linux

### Database conventions

- `rusqlite::Connection` is not `Send` — open a fresh connection in each Tauri command via `Database::open(&state.db_path)`
- UI-only state (collapsed sections, panel widths, selection) is NOT persisted — keep in Zustand

### Schema migrations

- Migrations live as `.sql` files under `src/migrations/` and are registered in `src/migrations/mod.rs` as `Migration` entries in the `MIGRATIONS` const slice.
- **Adding a migration:** create `src/migrations/YYYYMMDDHHMMSS_snake_case_description.sql` using the current UTC timestamp, then append a matching `Migration { id, sql: include_str!(...), legacy_version: None }` entry to `MIGRATIONS`. Migration IDs must be unique — a test enforces this.
- **Never edit the SQL of a released migration.** The `id` is the tracked identity; rewriting or renaming applied migrations will desync databases in the field. Fix forward with a new migration.
- **Merging branches:** each new migration is a distinct `.sql` file and a distinct `MIGRATIONS` entry, so parallel-branch migrations no longer collide on an integer version — both apply when merged. If two branches happen to choose the same timestamp (e.g. from `date -u +%Y%m%d%H%M%S` run at the same second), git will surface the clash as a merge conflict in `mod.rs`; bump one timestamp by a second and rename its file to resolve.
- `PRAGMA user_version` is retained only to seed `schema_migrations` once on pre-redesign databases during the first run of the new runner. Do not read or write it in new code.

## Project context

- See GitHub Issue #5 for the full MVP PRD
- See GitHub Issue #11 for the Workspace Management TDD
- P0 features: workspace management, agent chat, diff viewer, integrated terminal, checkpoints, git/GitHub integration, scripts, repo settings
- Target platforms: macOS (Apple Silicon + Intel), Linux (x86_64, Wayland + X11), and Windows (x86_64 + ARM64)

## Debugging (dev builds only)

A debug TCP eval server runs on `127.0.0.1:19432` in dev builds. It executes JS in the webview and returns results over TCP. **Always use the `/claudette-debug` skill for debugging** — it has recipes for state inspection, store tracing, session monitoring, and UAT.

```bash
/claudette-debug state                    # Store overview
/claudette-debug state completedTurns     # Dump a specific slice
/claudette-debug eval 'return 1+1'        # Arbitrary JS
/claudette-debug monitor start            # Background session monitor → /tmp/claudette-debug/monitor.log
/claudette-debug monitor read             # Tail monitor log
/claudette-debug snapshot                 # Full store dump
```

Helper scripts (use relative paths from project root):
- `.claude/skills/claudette-debug/scripts/debug-eval.sh` — single-shot JS eval
- `.claude/skills/claudette-debug/scripts/debug-monitor.sh` — long-running session monitor

Key globals exposed in dev mode:
- `window.__CLAUDETTE_STORE__` — Zustand store (`.getState()` / `.setState()`)
- `window.__CLAUDETTE_INVOKE__` — Tauri `invoke` function

All debug code is gated behind `#[cfg(debug_assertions)]` / `import.meta.env.DEV` and excluded from release builds. See `.claude/skills/claudette-debug/SKILL.md` for full docs.

## Dependencies

- Add dependencies conservatively — binary size target is < 30 MB
- Cold start target is < 2 seconds to interactive UI
- When choosing crates, prefer well-maintained options with minimal transitive dependencies
- Frontend: use `bun` as package manager, not npm
