# Contributing to Claudette

Thank you for your interest in contributing to Claudette! This guide will help you get started.

## Code of Conduct

This project adheres to the [Contributor Covenant 3.0 Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code. Please report unacceptable behavior to seancallan@gmail.com.

## How to Contribute

### Reporting Bugs

Before filing a bug report, please check [existing issues](https://github.com/utensils/Claudette/issues) to avoid duplicates.

When filing a bug report, include:

- A clear, descriptive title
- Steps to reproduce the issue
- Expected behavior vs. actual behavior
- Your OS and version (macOS or Linux)
- Relevant logs or screenshots

### Suggesting Features

Feature suggestions are welcome! Please open an issue describing:

- The problem your feature would solve
- Your proposed solution
- Any alternatives you've considered

### Submitting Changes

1. **Fork the repository** and create a feature branch from `main`.
2. **Set up the development environment** — see the [README](README.md#prerequisites) for prerequisites.
3. **Make your changes** following the guidelines below.
4. **Test your changes** — run the full test and lint suite before submitting:
   ```sh
   cargo test --all-features
   cargo clippy --workspace --all-targets
   cargo fmt --all --check
   cd src/ui && bunx tsc --noEmit
   ```
5. **Commit your changes** using [conventional commit](#commit-conventions) format.
6. **Open a pull request** against `main` with a clear description of your changes.

## Development Setup

```sh
# Clone your fork
git clone https://github.com/<your-username>/claudette.git
cd claudette

# Install frontend dependencies
cd src/ui && bun install && cd ../..

# Run in development mode
cargo tauri dev
```

> **macOS — voice input dev mode:** if you're working on or testing the
> voice-input feature, run `./scripts/dev.sh` instead of `cargo tauri dev`.
> The script wraps the dev binary in a signed `.app` bundle with the
> usage strings + entitlements that macOS TCC requires before granting
> Microphone or Speech Recognition permission. Plain `cargo tauri dev`
> works for everything else.

> **Linux — ALSA development headers:** Debian/Ubuntu users need
> `libasound2-dev` installed (Fedora: `alsa-lib-devel`, Arch: `alsa-lib`).
> The `cpal` audio crate fails to build without it. The full apt
> install line is in the [README prerequisites](README.md#prerequisites).
> Nix users get this automatically via `flake.nix`.

## Commit Conventions

This project uses **conventional commits**. Every commit message and PR title must follow this format:

```
<type>: <description>
```

Common types: `feat`, `fix`, `docs`, `refactor`, `test`, `ci`, `chore`

- Keep the header under 100 characters
- Use the imperative mood ("add feature" not "added feature")
- PR titles are validated by CI

## Code Style

### Rust

- Edition 2024 — use modern idioms
- Run `cargo fmt` before committing (CI enforces formatting)
- Run `cargo clippy` with zero warnings (CI sets `RUSTFLAGS="-Dwarnings"`)

### TypeScript

- Strict mode enabled — no `any` types
- Use `bun` as the package manager (not npm)

## Architecture Overview

Claudette is a Tauri 2 desktop app with a Rust backend and React/TypeScript frontend. See `CLAUDE.md` for the full architecture guide.

Key principles:

- **Data types** go in `src/model/` — keep them free of UI and IO dependencies
- **Service modules** (`db.rs`, `git.rs`, `agent.rs`) live at the `src/` level
- **Tauri commands** go in `src-tauri/src/commands/` as thin wrappers
- **React components** are organized by feature area in `src/ui/src/components/`
- **State management** uses Zustand with domain slices

## Pull Request Guidelines

- Keep PRs focused — one feature or fix per PR
- Include tests for new functionality where applicable
- Update documentation if your change affects public behavior
- Ensure CI passes before requesting review
- Link related issues in the PR description

## License

By contributing to Claudette, you agree that your contributions will be licensed under the [MIT License](LICENSE).
