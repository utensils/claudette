<p align="center">
  <img src="assets/logo.png" alt="Claudette" width="128" />
</p>

<h1 align="center">Claudette</h1>

<p align="center">Claude's missing better half — a companion tool for Claude Code usage.</p>

Claudette is a cross-platform desktop application built with Rust and [Iced](https://iced.rs). It aims to provide a lightweight interface for managing and orchestrating Claude Code sessions, similar in spirit to [Conductor.build](https://conductor.build) but with a focused feature set.

## Prerequisites

- [Rust](https://rustup.rs/) (stable toolchain, edition 2024)
- Platform dependencies for Iced:
  - **macOS**: Xcode Command Line Tools (`xcode-select --install`)
  - **Linux**: `pkg-config`, `libfontconfig-dev`, `libxkbcommon-dev`, and a Vulkan driver. On Debian/Ubuntu:
    ```sh
    sudo apt install pkg-config libfontconfig-dev libxkbcommon-dev libvulkan-dev
    ```

## Getting started

```sh
# Build and run (debug)
cargo run

# Build optimized release binary
cargo build --release

# Run tests
cargo test

# Lint
cargo clippy
```

## Project structure

```
src/
  main.rs      # Application entry point and Iced app scaffold
Cargo.toml     # Dependencies and project metadata
```

## Future plans

- **Terminal emulation** via [libghostty](https://github.com/ghostty-org/ghostty) — integration is planned once the library stabilizes (requires zig toolchain to build).

## Development notes

- The project uses Rust edition 2024.
- Iced renders via wgpu (Vulkan/Metal/DX12) by default.
- Editor configs for VS Code and Neovim are gitignored — use your preferred setup.
