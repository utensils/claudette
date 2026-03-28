<p align="center">
  <img src="assets/logo.png" alt="Claudette" width="128" />
</p>

<h1 align="center">Claudette</h1>

<p align="center">Cross-platform desktop orchestrator for parallel Claude Code agents.</p>

Claudette is an open-source alternative to [Conductor](https://docs.conductor.build/) — bringing isolated workspaces, parallel agent orchestration, and unified review/merge to both macOS and Linux. Built with [Tauri v2](https://v2.tauri.app/) + React.

## Features (Planned)

- **Workspace management** — Isolated git worktrees per task with their own Claude Code agent
- **Agent chat** — Rich chat interface with markdown rendering and syntax highlighting
- **Diff viewer** — Side-by-side or unified diffs of workspace changes
- **Integrated terminal** — Terminal sessions scoped to each workspace
- **Checkpoints** — Automatic snapshots before each agent turn with revert capability
- **Git integration** — Branch management, push/pull, PR creation
- **Scripts** — Setup, run, and archive scripts per repository

See [Issue #5](https://github.com/utensils/Claudette/issues/5) for the full PRD.

## Prerequisites

- [Rust](https://rustup.rs/) (1.94+)
- [Bun](https://bun.sh/) (1.x+)

### macOS

```bash
xcode-select --install
```

### Linux (Arch)

```bash
sudo pacman -S --needed webkit2gtk-4.1 base-devel curl wget file openssl appmenu-gtk-module libappindicator-gtk3 librsvg xdotool
```

### Linux (Ubuntu/Debian)

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
```

## Development

```bash
bun install           # Install frontend dependencies
bun run tauri dev     # Start in dev mode (hot-reload)
```

## Build

```bash
bun run tauri build   # Produce release binary
```

## Project structure

```
src/                   — Frontend (React + TypeScript)
src-tauri/             — Backend (Rust + Tauri v2)
  src/lib.rs           — Main Rust logic and command registration
  tauri.conf.json      — Tauri configuration
assets/                — Workspace icon SVGs
```

## License

TBD
