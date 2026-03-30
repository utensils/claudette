<p align="center">
  <img src="assets/logo.png" alt="Claudette" width="128" />
</p>

<h1 align="center">Claudette</h1>

<p align="center">Claude's missing better half — a companion tool for Claude Code usage.</p>

Claudette is a cross-platform desktop application built with [Tauri 2](https://tauri.app) (Rust backend) and React/TypeScript (frontend). It provides a lightweight interface for managing and orchestrating Claude Code sessions, similar in spirit to [Conductor.build](https://conductor.build) but with a focused feature set.

## Prerequisites

- [Rust](https://rustup.rs/) (stable toolchain, edition 2024)
- [Bun](https://bun.sh/) (JavaScript runtime and package manager)
- [Tauri CLI](https://tauri.app/start/): `cargo install tauri-cli --version "^2"`
- Platform dependencies for Tauri:
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`)
  - **Linux**: System libraries for WebKitGTK. On Debian/Ubuntu:
    ```sh
    sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
      libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
    ```

## Getting started

```sh
# Install frontend dependencies
cd src/ui && bun install && cd ../..

# Run in development mode (hot-reload)
cargo tauri dev

# Build optimized release binary
cargo tauri build

# Run backend tests
cargo test --all-features

# Lint
cargo clippy --workspace --all-targets

# Check frontend types
cd src/ui && bunx tsc --noEmit
```

## Project structure

```
Cargo.toml              # Workspace root + claudette lib crate
src/
  lib.rs                # Backend library entry point
  db.rs                 # SQLite database (rusqlite)
  git.rs                # Async git operations
  diff.rs               # Diff parsing
  agent.rs              # Claude CLI subprocess + streaming
  model/                # Data types
  names/                # Random workspace name generator
  ui/                   # React/Vite frontend
    src/
      components/       # UI components (sidebar, chat, diff, terminal, modals)
      hooks/            # Tauri event listeners
      stores/           # Zustand state management
      services/         # Typed Tauri IPC wrappers
      types/            # TypeScript types matching Rust models
src-tauri/
  Cargo.toml            # Tauri binary crate
  tauri.conf.json       # Tauri configuration
  src/
    main.rs             # Tauri entry point
    commands/           # #[tauri::command] handlers
    state.rs            # Managed application state
    pty.rs              # Terminal PTY management
```

## Development notes

- The project uses Rust edition 2024 and Bun as the frontend package manager.
- The backend (`src/`) is a library crate consumed by the Tauri binary (`src-tauri/`).
- See `CLAUDE.md` for detailed architecture and contribution guidelines.
- See `docs/tauri-migration-tdd.md` for the technical design document.
