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

# Run in development mode (macOS / Linux)
./scripts/dev.sh
```

```powershell
# Windows equivalent — same flags, PowerShell launcher
.\scripts\dev.ps1
.\scripts\dev.ps1 --help
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
>
> Headless or sandboxed Linux environments without ALSA can omit voice
> support entirely:
> ```sh
> cargo tauri build --no-default-features --features tauri/custom-protocol,server
> ```

> **Windows — use `scripts\dev.ps1` (not `cargo tauri dev`).** The
> PowerShell launcher refreshes PATH from the registry (so a fresh
> shell sees clang/cargo without restarting), forces Vite onto
> `127.0.0.1` (Windows resolves `localhost` to `::1` first; WebView2
> doesn't follow), drops `voice` from the default feature set
> (`gemm-f16` requires the `fullfp16` ARMv8.2 target feature that
> stock aarch64-pc-windows-msvc doesn't enable), skips
> `tauri/custom-protocol` (it would suppress `import.meta.env.DEV`
> and break `/claudette-debug`), and stages the
> `claudette-cli` sidecar that the bundled `tauri.conf.json` would
> otherwise look for. `--clean` and `--help` work the same as on
> the .sh version.
>
> First-time prerequisites on Windows: VS C++ Build Tools (Desktop
> development with C++ workload) and Clang/LLVM on PATH (e.g.
> `scoop install llvm`). The PowerShell profile snippet for a bare
> `dev` command is in the [README — Run in development mode](README.md#run-in-development-mode).

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

## Translating Claudette

Claudette is internationalized using [i18next](https://www.i18next.com/) on the frontend and a small bespoke loader on the Rust side. Today the app ships with five complete translations: English (`en`, the baseline), Spanish (`es`), Brazilian Portuguese (`pt-BR`), Japanese (`ja`), and Simplified Chinese (`zh-CN`). Each ships the full UI plus the system tray menu, notifications, and the quit-confirm dialog. Missing keys fall back to English at runtime, so partial translations are safe to ship — they just leave a few English strings showing through.

Adding a language is mostly a JSON-translation task. You don't need Rust or TypeScript experience to translate the strings; the small registration step at the end is just a handful of lines.

### Where translation files live

- **Frontend** — `src/ui/src/locales/<lang>/` contains five namespace files: `common.json`, `chat.json`, `modals.json`, `settings.json`, and `sidebar.json`.
- **Backend** — `src/locales/<lang>/tray.json` contains the tray, notification, and quit-dialog strings.

Both sides use the same `{{var}}` placeholder syntax for interpolation, so a translator only learns one convention.

### Adding a new language

1. **Pick a locale code.** Use the 2-letter [ISO 639-1](https://en.wikipedia.org/wiki/List_of_ISO_639_language_codes) code (e.g. `fr`, `de`, `pt`). If you need a regional variant, use BCP-47 style (e.g. `pt-BR`, `zh-TW`).
2. **Copy the English files.** Duplicate `src/ui/src/locales/en/` and `src/locales/en/` to your new locale directory. Translate the **values**; leave the **keys** byte-for-byte identical to English.
3. **Register the language on the frontend.** In `src/ui/src/i18n.ts`, add imports for each of the five namespace files, append your locale code to `SUPPORTED_LANGUAGES`, and add a matching entry to the `resources` map.
4. **Update the TypeScript declaration** in `src/ui/src/types/i18next.d.ts` only if you've introduced a new namespace (most translation contributions don't need this).
5. **Register the language on the backend.** In `src/i18n/mod.rs`, add a variant to the `Locale` enum, add an `include_str!` line for your `tray.json`, add a matching `*_store()` function alongside the existing per-locale stores (each wraps a `OnceLock` over the parsed JSON), and update `Locale::from_db_value` and `Locale::store` to recognize the new code. Also extend the `locales_have_identical_key_sets` test in the same file to include your new store, so the parity check covers your locale.
6. **Add the language to the selector** in Settings → General, following the existing pattern (`general_language_<code>` translation key plus an `<option>` entry).

### Updating an existing translation

If you'd like to fix a mistranslation or polish wording in an existing language, just edit the relevant file under `src/ui/src/locales/<lang>/` or `src/locales/<lang>/tray.json` and open a PR — no registration steps required.

### Conventions

- **Keep `{{placeholder}}` interpolation tokens verbatim.** They're substituted at runtime; translating them will break the rendered string.
- **Honor `_one` / `_other` plural keys.** If a key has both forms in English (i18next's plural convention), provide both forms in your language even if your language uses fewer plural categories — i18next will pick the right one.
- **Match casing and punctuation choices** to the language's UI conventions, but be aware that some strings (e.g. button labels) have tight space budgets in the UI.

### What CI checks

- `cargo test --all-features` runs `locales_have_identical_key_sets` in `src/i18n/mod.rs`, which fails if the backend locales it includes (currently `es`, `pt-BR`, `ja`, and `zh-CN`, each compared against `en`) disagree on which keys exist. The check only covers the locales explicitly compared in the test, so when adding a new backend locale make sure to extend the test to include it (see the registration step above). Run the suite locally before opening a PR.
- `cd src/ui && bunx tsc -b` enforces frontend type safety, which transitively catches mistyped translation keys consumed via `useTranslation()`.
- `cargo clippy --workspace --all-targets` and `cargo fmt --all --check` round out the standard checks.

If you're not sure where to start, [open an issue](https://github.com/utensils/Claudette/issues/new) to claim a language so two contributors don't unknowingly translate in parallel.

## Pull Request Guidelines

- Keep PRs focused — one feature or fix per PR
- Include tests for new functionality where applicable
- Update documentation if your change affects public behavior
- Ensure CI passes before requesting review
- Link related issues in the PR description

## License

By contributing to Claudette, you agree that your contributions will be licensed under the [MIT License](LICENSE).
