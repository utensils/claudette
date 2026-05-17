# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Claudette

Cross-platform desktop orchestrator for parallel Claude Code agents, built with Rust (Tauri 2) and React/TypeScript.

## AI assistant configuration

This file is the source of truth for project conventions. Several companion configs read by other AI tools live alongside it and need to stay aligned when the rules here change:

- `.github/copilot-instructions.md` — repo-wide guidance read by GitHub Copilot on every PR review and code suggestion.
- `.github/instructions/rust.instructions.md` — scoped to `**/*.rs` via `applyTo` frontmatter.
- `.github/instructions/frontend.instructions.md` — scoped to `src/ui/**/*.{ts,tsx,css}`.
- `.github/instructions/regression-review.instructions.md` — scoped to all files; used during PR review for regression-first checking.
- `AGENTS.md` — symlink to this CLAUDE.md, read by Codex / OpenCode / other agent tools that look for that filename. **Edit CLAUDE.md, never AGENTS.md.**

When you change architecture, commands, code-style, regression rules, or god-file lists in this CLAUDE.md, scan the Copilot files for the same statement and update both. Drift here causes Copilot's PR reviews to flag (or miss) issues that don't match what we tell humans.

## Documentation discipline

**Always update the user-facing docs in the same PR as the feature change.** Adding, removing, or changing user-visible behavior — settings, commands, CLI flags, keyboard shortcuts, environment variables, file locations, plugin manifests, notification triggers — requires a matching docs change. The docs site lives at `site/src/content/docs/` (Astro Starlight). Two surfaces matter:

- `site/src/content/docs/features/<topic>.mdx` — the per-feature deep-dive page. New cross-cutting feature → new page. Existing feature gained a knob → update the page. Register new pages in the sidebar nav at `site/astro.config.mjs` so they're reachable.
- `site/src/content/docs/features/settings.mdx` — the flat settings reference table. Every Settings panel control belongs in this file's matching `## <Section>` table; add the row when you add the control.

If a change is intentionally undocumented (debug-only flag, internal env var nobody outside the repo should touch), call that out in the PR description so the omission is reviewed, not assumed. CI does not enforce this — the discipline does.

## Build & test commands

```bash
# Backend (Rust)
cargo test -p claudette -p claudette-server -p claudette-cli --all-features  # Run all backend tests (CI runs the same crates via cargo llvm-cov)
cargo test -p claudette --test diff_tests        # Run a single test file
cargo test -p claudette parse_unified -- --exact # Run a single test by name
cargo clippy -p claudette -p claudette-server -p claudette-cli --all-targets --all-features  # Lint (CI command — must pass with zero warnings)
cargo clippy -p claudette-mobile --target aarch64-apple-darwin --all-targets --locked  # Mobile lint (CI command — macOS only)
cargo test -p claudette-mobile --locked          # Mobile tests (CI command — macOS only)
cargo fmt --all --check                          # Check formatting

# Frontend (React/TypeScript)
cd src/ui && bun install                         # Install frontend dependencies
cd src/ui && bun run build                       # Build frontend (runs tsc -b && vite build)
cd src/ui && bunx tsc -b                         # TypeScript type check (same as CI)
cd src/ui && bun run test                        # Run frontend tests (vitest)
cd src/ui && bun run test:watch                  # Run tests in watch mode
cd src/ui && bun run lint                        # ESLint check
cd src/ui && bun run lint:css                    # CSS design-token enforcement (also runs in CI)

# Full app
cargo tauri dev                                  # Dev mode with hot-reload
cargo tauri build                                # Release build
```

IMPORTANT: CI sets `RUSTFLAGS="-Dwarnings"` — all compiler warnings are errors. Fix warnings before committing.

IMPORTANT: Always run `cd src/ui && bunx tsc -b` after modifying TypeScript files (including tests). CI runs `tsc -b` via `bun run build` — `vitest` does **not** type-check (it uses esbuild), so tests can pass locally while types are broken. Run `tsc -b` as the final check before committing any frontend change.

CI also enforces `bun install --frozen-lockfile` — do not modify `bun.lock` without intention. CI runs `cargo llvm-cov` for Rust test coverage (uploaded to Codecov, informational/non-blocking). CI clippy lints `claudette`, `claudette-server`, and `claudette-cli` on Linux, runs `scripts/stage-cli-sidecar.sh --profile debug` and then `cargo test -p claudette-tauri --no-default-features --features devtools,server,voice,alternative-backends,pi-sdk --no-run` with the Linux Tauri system libraries installed (`--no-run` so the binary crate's test targets are compiled too — the `test` job only covers `claudette` / `-server` / `-cli`, so a non-compiling test fixture in `claudette-tauri` would otherwise slip through), and checks `claudette-mobile` on macOS (host target `aarch64-apple-darwin`, desktop-fallback build — iOS target compilation is intentionally not in CI; it requires Xcode + Apple SDK + `cargo tauri ios init` scaffolding). The Tauri check uses the shared Rust cache plus Bun's package cache for the Pi harness sidecar staging path; keep it cache-friendly when editing. Frontend CI runs `bunx tsc --noEmit` as a dedicated type-check step before `bun run build`.

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
- **Agent integration**: Claude CLI subprocess with JSON streaming, bridged to frontend via Tauri events. The chat-send resolver dispatches on a per-backend `runtime_harness` (`AgentBackendConfig::effective_harness` in `src/agent_backend.rs`), not on `AgentBackendKind` directly — `kind` only declares which harnesses are valid; the user picks the active one in Settings > Models > Runtime. Ollama / LM Studio default to Pi, OpenAI cards to the Claude CLI gateway, Codex Native to the Codex app-server. Anthropic / Custom Anthropic / Codex Subscription are locked to Claude CLI so subscription OAuth tokens never reach Pi.
- **Interactive Claude (experimental)**: a second Anthropic harness, `AgentHarnessKind::ClaudeInteractive` (`src/agent/claude_interactive.rs`), runs the real `claude` TUI inside a long-lived PTY instead of the JSON-streaming subprocess. It is gated behind the `claudeInteractiveEnabled` experimental flag and surfaced as a "Claude (Interactive)" card in Settings > Models > Runtime. Two hosts back it: a `TmuxHost` (`src/agent/interactive_host/tmux.rs`) preferred on Unix when `tmux >= 3.4` is available and the flag is on, and a `SidecarHost` (`src/agent/interactive_host/sidecar.rs`) client that talks to the bundled `claudette-session-host` binary — required on Windows, opt-in fallback on Unix. Both implement the shared `InteractiveHost` trait (`src/agent/interactive_host/mod.rs`). The wire protocol between Tauri and the sidecar lives in `src/agent/interactive_protocol.rs` (length-prefixed JSON-line framing, request/event envelopes). Turn boundaries flow over Claude Code hooks: `claudette chat hook` (CLI subcommand) sends a `chat_hook` IPC request that the Tauri side routes via `AppState::dispatch_interactive_hook` into the matching per-session channel, which the frontend assembler (`useInteractiveTurnAssembler`) turns into per-turn xterm.js views (`InteractiveTurnView`). **Known limitation:** `SidecarHost` reconnect is not yet implemented — the cached `ConnHandle` in `OnceCell` is never reset if the underlying connection dies, so if the bundled `claudette-session-host` sidecar exits (e.g., due to its 600s idle timer) while Claudette is still running, subsequent `interactive_*` commands fail with "conn closed" errors until Claudette is restarted. Tracking as follow-up work.
- **Terminal emulation**: portable-pty (Rust) + xterm.js (frontend)
- **IPC**: Tauri commands (`#[tauri::command]`) for request/response, Tauri events for streaming

### Crate structure

Six crates in a Cargo workspace:

| Crate | Path | Purpose |
|---|---|---|
| `claudette` | `src/` (workspace root) | Core library — models, db, git, diff, agent logic, WSS transport. No UI or Tauri dependencies. |
| `claudette-tauri` | `src-tauri/` | Tauri binary (`claudette-app`). Thin `#[tauri::command]` wrappers that call into `claudette`. |
| `claudette-server` | `src-server/` | WebSocket server for remote access. Also embeddable in the Tauri binary. Uses `PersistentSession` so interactive controls (AskUserQuestion / ExitPlanMode) work over WSS. |
| `claudette-cli` | `src-cli/` | Command-line client (`claudette` binary) that drives the running GUI over a local IPC socket. |
| `claudette-mobile` | `src-mobile/` | Tauri 2 iOS / Android client — thin WSS remote-control app. Pairs with a running desktop or headless server; doesn't run agents locally. See `src-mobile/README.md` for the `cargo tauri ios init` setup. |
| `claudette-session-host` | `src-session-host/` | Sidecar binary that owns interactive Claude PTYs via `portable-pty` for the `ClaudeInteractive` harness. Required on Windows, opt-in fallback on Unix when tmux is unavailable or the user prefers it. Bundled as a Tauri `externalBin`; speaks the framed JSON protocol in `src/agent/interactive_protocol.rs`. |

Feature flags in `claudette-tauri`:
- `default = ["server", "voice", "devtools", "alternative-backends", "pi-sdk"]`
- `voice` — pulls in `cpal` (audio capture), `candle-*` (Whisper inference), `tokenizers`, `rubato`, `hound`. Linux requires `libasound2-dev` (ALSA); headless builds drop it via `--no-default-features --features tauri/custom-protocol,server`.
- `devtools` — enables Tauri devtools (`tauri/devtools`)
- `server` — optional dep on `claudette-server`
- `alternative-backends` — surfaces the user-facing alt-backend gate (Codex Native + the Pi runtime option on Ollama / LM Studio / OpenAI cards). Does not by itself compile the Pi sidecar into the binary; pairs with `pi-sdk` for that.
- `pi-sdk` — compiles the Pi coding-agent harness (sidecar wrapper around `@earendil-works/pi-coding-agent`), bundles `binaries/claudette-pi-harness` + `binaries/pi/package.json`, and exposes the Pi card / Pi runtime option in Settings. Independent of `alternative-backends` — drop it (with `--no-default-features --features tauri/custom-protocol,server,voice,devtools,alternative-backends -c src-tauri/tauri.no-pi.conf.json`) to ship a Codex-Native-enabled build without Pi. The lib crate mirrors this flag (`claudette::pi-sdk`) and downstream `claudette-server` / `claudette-cli` set `default-features = false` on their `claudette` dep so workspace feature unification can't drag Pi back in.

### Frontend

- Vite dev server port is chosen by `scripts/dev.sh` (default base **14253**, probes for the first free port and exports `VITE_PORT`); `strictPort: true` so a probe/Vite race fails loudly. Default was moved off Tauri's stock 1420 because other Tauri starter templates default to it and their dev scripts can rebind the port underneath a running webview.
- TypeScript enforces `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`
- Test runner is **vitest** (not Jest)
- macOS uses overlay title bar (`titleBarStyle: "Overlay"`) — affects layout near top of window
- **Interactive Claude UI** lives in sibling files next to `ChatPanel.tsx` (which stays a god file — see below): `InteractiveTurnView` and `InteractiveTurns` render per-turn xterm.js views, `InteractiveTerminalMode` / `InteractiveTerminalModeToggle` provide the full-terminal embed, `useInteractiveTurnAssembler` assembles hook events into turns, `useInteractiveChatMode` picks the embedded-vs-terminal mode, and `services/interactive.ts` is the Tauri bridge (start / send_input / attach / capture_screen / stop and the hook-event subscription).

### Tauri commands

Commands in `src-tauri/src/commands/` are organized by domain: `agent_backends`, `apps`, `auth`, `boot`, `cesp`, `chat`, `claude_flags`, `cli`, `community`, `data`, `debug`, `devtools`, `diagnostics`, `dialog`, `diff`, `env`, `files`, `grammars`, `interactive`, `mcp`, `metrics`, `pinned_prompts`, `plan`, `plugin`, `plugins_runtime`, `remote`, `repository`, `scheduling`, `scm`, `settings`, `shell`, `slash_commands`, `storage`, `terminal`, `updater`, `usage`, `voice`, `workspace`. Each is a thin wrapper — business logic belongs in the `claudette` crate.

### CLI client

`claudette` (in `src-cli/`) drives the running GUI over a local IPC socket (Unix domain socket on macOS/Linux, Named Pipes on Windows; `interprocess` crate). It reuses the same command core as the GUI, so tray, notifications, and workspace list update live. Top-level subcommands include `version`, `capabilities`, `rpc`, `workspace` (alias `ws`), `chat`, `repo`, `batch`, `plugin`, `pr`, `routine`, and `completion`. `chat hook` is the hook target wired into the materialized Claude Code settings overlay for interactive sessions — it carries the hook kind (`UserPromptSubmit`, `Stop`, `AwaitingUserInput`, …) and the session id, and lands on the Tauri side as a `chat_hook` IPC method that `AppState::dispatch_interactive_hook` routes into the matching per-session channel. IPC server lives in `src-tauri/src/ipc.rs`; CLI surface in `src-tauri/src/commands/cli.rs`. The CLI requires the GUI to be running — prefer it over poking the SQLite DB directly.

## Project structure

```
Cargo.toml              — workspace root + claudette lib crate
src/
  lib.rs                — library entry point, re-exports backend modules
  db/                   — SQLite database (module dir): connection, migrations, CRUD
  migrations/           — versioned .sql files + MIGRATIONS registry
  git.rs                — async git worktree operations
  diff.rs               — diff parsing and git diff operations
  agent/                — agent runtime (module dir): Claude CLI subprocess + JSON streaming,
                          plus alternative backends (`codex_app_server.rs`, `harness.rs` shared
                          scaffolding). The Pi modules (`pi_sdk.rs`, `pi_control.rs`) are gated
                          behind the lib crate's `pi-sdk` feature.
                          Interactive Claude (experimental): `claude_interactive.rs`,
                          `interactive_host/` (tmux + sidecar implementations of the
                          `InteractiveHost` trait, plus `availability.rs` / `conformance.rs`),
                          and `interactive_protocol.rs` (framed JSON wire types shared with
                          `claudette-session-host`).
  fork.rs               — session forking / checkpoint branching
  snapshot.rs           — workspace snapshots
  process.rs            — cross-platform process spawning helpers
  mcp.rs / mcp_supervisor.rs — MCP server config + lifecycle supervision
  plugin.rs             — Claude-Code plugin marketplace integration
  plugin_runtime/       — sandboxed Lua runtime (mlua) shared across plugin kinds
  permissions.rs        — tool/permission policy
  scm/                  — SCM consumer of plugin_runtime: PR/CI types + host/URL detection
  env_provider/         — env-provider consumer: dispatcher, mtime cache, merged ResolvedEnv,
                          plus `nix develop` wrapping for Nix devshell terminals/agents
  slash_commands.rs     — slash command loading and dispatch
  cesp.rs               — CESP (Claudette event stream protocol)
  config.rs / env.rs / path.rs / file_expand.rs — config, env, path helpers
  transport/            — WSS client transport (trait + WebSocket client),
                          shared by `claudette-tauri` and `claudette-mobile`
  model/                — data types (no UI or IO logic); all derive Serialize
  names/                — random workspace name generator
  ui/                   — React/Vite frontend (see src/ui/package.json)
src-tauri/              — Tauri binary crate
  src/commands/         — #[tauri::command] wrappers by domain
  src/state.rs          — managed AppState (db_path, agents, PTYs)
  src/pty.rs            — PTY management via portable-pty
  src/tray.rs           — system tray: icon/menu/tooltip, notifications
  src/remote.rs         — embedded remote server wiring
  src/mdns.rs           — mDNS advertisement for remote discovery
  src/pty_tracker.rs    — PTY foreground-process-group polling for the sidebar command indicator (Unix-only; replaced OSC 133)
src-server/             — Standalone + embeddable remote server
plugins/                — bundled Lua plugins (compiled in via include_str!)
  scm-github/           — GitHub PR / CI provider
  scm-gitlab/           — GitLab PR / CI provider
  env-direnv/           — direnv env activation
  env-mise/             — mise env activation
  env-dotenv/           — `.env` in-process parser
  env-nix-devshell/     — Nix devshell detection/env export; terminals and agents enter via
                          `nix develop` directly instead of through direnv
src-pi-harness/         — TypeScript/Bun sidecar wrapping `@earendil-works/pi-coding-agent`.
                          Compiled by `scripts/stage-pi-harness-sidecar.sh` into a single Bun
                          executable at `src-tauri/binaries/claudette-pi-harness-<triple>` and
                          shipped via Tauri `bundle.externalBin`. Glue lives in
                          `src/agent/pi_sdk.rs`; only built/loaded when the
                          `pi-sdk` feature is on.
src-session-host/       — `claudette-session-host` sidecar binary. Owns interactive Claude
                          PTYs via `portable-pty` and serves `EnsureSession` / `SendInput` /
                          `Attach` / `Resize` / `CaptureScreen` / `Stop` over the framed JSON
                          protocol in `src/agent/interactive_protocol.rs`. Required on
                          Windows, opt-in on Unix. Bundled as a Tauri `externalBin`.
tests/                  — workspace-level Rust integration tests (e.g. `grants_enforcement.rs`
                          covering the community-plugin granted_capabilities flow).
```

### Plugin system

A single sandboxed Lua runtime (`src/plugin_runtime/`) serves multiple plugin kinds declared via `plugin.json`'s `kind` field (`scm` | `env-provider`, defaults to `scm`). Each kind has its own domain consumer (`src/scm/`, `src/env_provider/`) that dispatches operations on top of the shared runtime. Bundled plugins live in `plugins/*/` and are seeded into the user's plugin dir on first run. Users can drop their own plugins into `~/.claudette/plugins/<name>/` (one `plugin.json` + one `init.lua`); discovery picks them up at startup.

**Plugin settings** (`manifest.settings: Vec<PluginSettingField>`) let a plugin declare typed user-configurable fields (boolean/text/select) that the Plugins settings section renders as a form. Values persist in `app_settings` as `plugin:{name}:setting:{key}` and are piped into the Lua `host.config("<key>")` surface at invocation time. Manifest defaults apply when no override is set. Global on/off state persists as `plugin:{name}:enabled = "false"` (absent key = enabled).

**Settings UI** separates two plugin concepts:
- **Plugins** (`src/ui/src/components/settings/sections/PluginsSettings.tsx`) — Claudette's own Lua plugins (SCM + env-provider). Always visible. Shows status, per-plugin toggle, and the manifest-declared settings form.
- **Claude Code Plugins** (`ClaudeCodePluginsSettings.tsx`, route key `claude-code-plugins`) — the Claude CLI marketplace integration from `src/plugin.rs` (marketplaces, channels, install/uninstall). Always visible in the Settings sidebar nav.

**Experimental flags** persist as rows in `app_settings`. Current entries include `pluginManagementEnabled` (Claude Code Plugins section) and `claudeInteractiveEnabled` (Claude (Interactive) runtime card in Settings > Models > Runtime, the interactive PTY/host wiring described in the Architecture section, and the matching `claude_interactive` harness override in `effectiveHarness`). Add new flags via `ExperimentalSettings.tsx` so they show up under Settings > Experimental.

### Guidelines for new code

- **Data types** go in `model/` — keep them free of UI and IO dependencies. All model types must derive `Serialize`.
- **Service/IO modules** (`db/`, `git.rs`, `diff.rs`, `agent/`) live at `src/` level in the `claudette` crate
- **Tauri commands** go in `src-tauri/src/commands/` — thin wrappers that call into `claudette`
- **React components** go in `src/ui/src/components/` — organized by feature area
- **State** lives in the Zustand store (`useAppStore`) — UI state in React, agent sessions in Rust-side `AppState`
- **Streaming data** (agent events, PTY output) flows via Tauri events, consumed by React hooks
- **Colors and styling** use CSS custom properties defined in `styles/theme.css` — all colors must be `var(--token-name)` references; raw hex/rgba literals anywhere outside `theme.css` fail `bun run lint:css` (CI-blocking). Allowed exceptions: `rgba(var(--*-rgb), <alpha>)` for alpha layering, `getPropertyValue(...) || "#..."` safety fallbacks in `theme.ts`, and `accentPreview` swatches in CommandPalette that mirror existing theme hex values.

### God files — keep diffs surgical

These files are already large enough that adding more responsibility makes them harder to reason about. When touching them, prefer extracting cohesive behavior into a focused helper / hook / slice / child component near the owning feature, then wire it through the existing entry point. The goal is to reduce or isolate complexity, not pile on another unrelated concern.

- **Rust**: `src/diff.rs`, `src/git.rs`, `src/plugin.rs`, `src/mcp.rs`, `src/mcp_supervisor.rs`, `src-tauri/src/ipc.rs`, `src-tauri/src/voice.rs`, the largest siblings of the recently-split `src-tauri/src/commands/agent_backends/` directory (`gateway_translate.rs`, `runtime_dispatch.rs`, `discovery.rs`, `config.rs`), and anything else in `src-tauri/src/commands/*` that's already a few hundred lines.
- **Frontend**: `src/ui/src/components/sidebar/Sidebar.tsx`, `src/ui/src/components/chat/ChatPanel.tsx`, `src/ui/src/components/chat/ChatInputArea.tsx`, `src/ui/src/components/terminal/TerminalPanel.tsx`, `src/ui/src/services/tauri.ts`, large CSS modules (e.g. `Settings.module.css`).

If a god file grew because the right home for the new behavior didn't exist yet, build that home first and land it as a separate (or stacked) commit before adding the new responsibility. Concrete example: the interactive-Claude UI lives in sibling files (`InteractiveTurnView`, `InteractiveTurns`, `InteractiveTerminalMode*`, `useInteractiveTurnAssembler`, `useInteractiveChatMode`, `services/interactive.ts`) and `ChatPanel.tsx` only branches into them — do the same for any future runtime-specific surface.

### Regression discipline

Treat regressions as the main risk before style or aesthetic concerns. Before changing behavior, identify the current contract: persisted DB fields, Tauri command payloads, CLI output, plugin manifests, settings keys, localized strings, terminal/session semantics, worktree behavior, and visible UI workflows. Do not remove, rename, or silently reinterpret any of these unless the task explicitly asks for that change.

If a behavior change is intentional, call it out plainly in the PR summary or review response and add or update tests that pin the new behavior. If it was incidental, preserve compatibility instead. Never fix a type / lint / test failure by deleting tests, removing UI controls, dropping state fields, weakening assertions, or broadening types — fix the underlying mismatch and keep existing user-visible capabilities intact.

### Testing patterns

- **Rust**: tests use `tempfile::tempdir()` to create ephemeral git repos — no fixtures or test databases. Async tests use `#[tokio::test]`. Test modules live at the bottom of each file (`#[cfg(test)] mod tests`).
- **TypeScript**: vitest with `describe`/`it`/`expect`. Zustand tests reset state via `useAppStore.setState()` in `beforeEach`. No test database — frontend tests are pure state/logic tests. When constructing fixtures for store state, always read the actual type definition (e.g., `TerminalTab` in `types/terminal.ts`) — do not guess field names. Look for existing `make*` helpers in adjacent test files before creating new fixtures.

### Dev launcher

- **Use `./scripts/dev.sh`** (not bare `cargo tauri dev`). It probes free Vite + debug-eval ports (bases `14253` / `19432`), writes a per-PID discovery file at `${TMPDIR:-/tmp}/claudette-dev/<pid>.json` so `/claudette-debug` can find the right instance, stages the CLI sidecar via `scripts/stage-cli-sidecar.sh` (which also chains to `scripts/stage-pi-harness-sidecar.sh` for the Pi SDK sidecar), and on macOS adds `--runner scripts/macos-dev-app-runner.sh` so the build is wrapped in a signed `.app` bundle (using `src-tauri/Entitlements.plist`) — required for TCC to grant mic/speech permissions to Claudette rather than the terminal. The runner also mirrors the staged sidecars and Pi package metadata into the dev `.app`'s `Contents/MacOS/` and `Contents/Resources/binaries/pi/`, so `current_exe.parent()` resolution behaves the same way it does in release. Default features used: `devtools,server,voice,alternative-backends` (override via `$CARGO_TAURI_FEATURES`; `alternative-backends` is always appended).
- Bare `cargo tauri dev` still works for non-voice changes but **does not** invoke the macOS runner, probe ports, or write the discovery file.
- **Non-Nix contributors** use `mise` (`mise.toml` pins `rust = "1.94"`, `bun = "latest"`, `tauri-cli` from npm). `make setup` runs `mise install` + `bun install` + `cargo fetch`; `make run` invokes `cargo tauri dev --features devtools,server,alternative-backends`. On macOS, `mise.toml` force-sets `CC=/usr/bin/cc` and per-target Cargo linkers so transitive `-liconv`/`-lSystem` links succeed under `nix-darwin`'s `ld` — leave those env entries alone unless you're fixing them.

### macOS privacy-prompt contract

Do not trigger CoreAudio or Speech.framework permission prompts at app launch — macOS attributes the TCC prompt to that moment, and an unmotivated launch-time prompt looks like spyware.
- Voice setup uses `PlatformSpeechEngine::availability()` (prompt-safe; reports `NeedsSpeechPermission` etc.) for status display, and `prepare()` (triggers the TCC prompt) only inside `start_recording_locked` — i.e. when the user actually clicks the mic. There is no startup prewarm; cpal device enumeration is also avoided at launch.
- mDNS discovery currently starts at app launch so the sidebar's Nearby list stays populated without extra UI. Changing that affects macOS Local Network prompt timing and should come with an intentional replacement UX.

### Windows specifics

- Windows builds use MSVC toolchain; `[target.'cfg(windows)'.dependencies]` in `Cargo.toml` pulls in Windows-only crates. Gate Windows-specific code with `#[cfg(windows)]` / `#[cfg(not(windows))]` rather than Unix-only paths.
- **Never spawn a subprocess with a raw `Command::new`.** A Windows GUI process has no console, so every `CreateProcessW` child without the `CREATE_NO_WINDOW` flag pops a transient blank `cmd.exe` window. Construct commands via the `claudette::process` helper (or call `.no_console_window()` from `CommandWindowExt` on every `std::process::Command` / `tokio::process::Command` before `.spawn()`/`.output()`/`.status()`). The only exception is a terminal the user is intentionally opening (cmd/pwsh/wt) — use `.new_console_window()` there, and only there. This bug is invisible in dev/terminal-launched builds and only surfaces in shipped release builds, so guard at the spawn site. CI enforces this via `clippy.toml`'s `disallowed-methods`; a raw `Command::new` will fail the build.
- **Cross-compilation** (Nix devshell): `build-win-arm64` / `build-win-x64` via `cargo xwin` (requires `XWIN_ACCEPT_LICENSE=1`); `deploy-win-arm64` / `deploy-win-x64` build and push to the test VM.
- **Ephemeral Windows EC2** (Nix devshell): `aws-win-spinup` launches a Windows Server 2022 instance (state in `.claudette/aws-win/`, gitignored); `aws-win-rdp` opens RDP; `aws-win-destroy` terminates. Defaults: `AWS_PROFILE=dev.urandom.io`, `AWS_REGION=us-west-2`.
- CI/nightly/release builds Windows as bare `.exe` (no installer), zipped for distribution — `cargo xwin build --release --features tauri/custom-protocol`.

### Notification architecture

- Notification sound and commands run on the **Rust side** (not in the webview) — macOS suspends webview JS when the window is hidden
- `tray.rs` handles attention notifications (AskUserQuestion/ExitPlanMode); `commands/chat/` handles agent-finished notifications
- Both paths use the shared `build_notification_command` helper in `commands/settings.rs` — `sh -c <cmd>` on macOS/Linux, `cmd.exe /S /C <cmd>` on Windows
- Native notification banners: `mac-notification-sys` on macOS (click-to-navigate), `tauri-plugin-notification` on Linux/Windows
- **Sound playback** is platform-specific. macOS/Linux shell out to `afplay` / `paplay` / `ffplay` inline. Windows uses `claudette::audio` (`src/audio.rs`): `PlaySoundW` for built-in `C:\Windows\Media` system sounds (no decoder, no per-call volume) and `rodio` (cpal + Symphonia, gated to Windows-only deps) for OpenPeon sound packs that ship MP3/OGG/WAV. New Windows audio code belongs in `audio.rs` so the `unsafe` FFI and feature gating stay in one place.

### Database conventions

- `rusqlite::Connection` is not `Send` — open a fresh connection in each Tauri command via `Database::open(&state.db_path)`
- UI-only state (collapsed sections, panel widths, selection) is NOT persisted — keep in Zustand

### Schema migrations

- Migrations live as `.sql` files under `src/migrations/` and are registered in `src/migrations/mod.rs` as `Migration` entries in the `MIGRATIONS` const slice.
- **Adding a migration:** create `src/migrations/YYYYMMDDHHMMSS_snake_case_description.sql` using the current UTC timestamp, then append a matching `Migration { id, sql: include_str!(...), legacy_version: None }` entry to `MIGRATIONS`. Migration IDs must be unique — a test enforces this.
- **Never edit the SQL of a released migration.** The `id` is the tracked identity; rewriting or renaming applied migrations will desync databases in the field. Fix forward with a new migration.
- **Merging branches:** each new migration is a distinct `.sql` file and a distinct `MIGRATIONS` entry, so parallel-branch migrations no longer collide on an integer version — both apply when merged. If two branches happen to choose the same timestamp (e.g. from `date -u +%Y%m%d%H%M%S` run at the same second), git will surface the clash as a merge conflict in `mod.rs`; bump one timestamp by a second and rename its file to resolve.
- `PRAGMA user_version` is retained only to seed `schema_migrations` once on pre-redesign databases during the first run of the new runner. Do not read or write it in new code.
- **"Already exists" leniency:** the runner treats `SQLITE_ERROR` failures whose message contains `"already exists"` or `"duplicate column name"` as benign — it logs `[migrations] <id> skipped: ...` to stderr, marks the migration applied, and continues. This makes hand-applied or out-of-order migrations on dev DBs survivable. It does **not** license writing migrations that depend on this: keep them strictly forward-only and additive, and prefer `IF NOT EXISTS` on new `CREATE TABLE` / `CREATE INDEX` statements.

## CI/CD pipeline

- **PR CI** (`.github/workflows/ci.yml`): Rust fmt + clippy + tests (coverage → Codecov), desktop Tauri compile check, TypeScript type-check + `lint:css` + build + vitest. (ESLint via `bun run lint` is available locally but not run in CI.)
- **Nightly** (`.github/workflows/nightly.yml`): Every push to `main` (excluding docs/README). Computes version as `<next-minor>-dev.<commit-count>.g<short-sha>`, stamps all five Cargo.toml files (workspace root + `src-tauri` + `src-server` + `src-cli` + `src-mobile`), builds macOS (arm64 + x86_64), Linux (x86_64 + aarch64), Windows (x86_64 + arm64), promotes atomically from `nightly-staging` to `nightly` tag.
- **Release** (`.github/workflows/release-please.yml`): Triggered by Conventional Commits via release-please. Auto-generates CHANGELOG, bumps workspace `Cargo.toml` (source of truth) and the workspace-member crates (`src-tauri`, `src-server`, `src-cli`, `src-mobile`), builds all platforms, uploads assets, posts to Discord (`DISCORD_WEBHOOK_URL` secret).
- Windows builds in CI skip app bundling (bare `.exe`, zipped). macOS builds produce `.dmg`; Linux produces `.AppImage` + `.deb`.

## Project context

- See GitHub Issue #5 for the full MVP PRD
- See GitHub Issue #11 for the Workspace Management TDD
- P0 features: workspace management, agent chat, diff viewer, integrated terminal, checkpoints, git/GitHub integration, scripts, repo settings
- Target platforms: macOS (Apple Silicon + Intel), Linux (x86_64 + aarch64, Wayland + X11), and Windows (x86_64 + ARM64)

## Debugging (dev builds only)

A debug TCP eval server runs on `127.0.0.1` in dev builds (default port `19432`, overridable via `$CLAUDETTE_DEBUG_PORT` — `scripts/dev.sh` probes for a free port so multiple dev instances can coexist). It executes JS in the webview and returns results over TCP. **Always use the `/claudette-debug` skill for debugging** — it auto-discovers the right instance via `${TMPDIR:-/tmp}/claudette-dev/<pid>.json` and has recipes for state inspection, store tracing, session monitoring, and UAT.

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

### Voice click→prompt latency

Every successful mic click emits one info-level event on the `claudette::voice` target with fields `provider_id`, `total_ms` (full `voice_start_recording` command duration), and `stream_open_ms` (just the cpal input-stream open). Failed starts (permission denied, model missing, recorder open failure, already-active recording) emit an error-level event on the same target via `#[tracing::instrument(err)]`, so cold-start regressions show up regardless of outcome. Watch both in the dev-build console or in `~/.claudette/logs/claudette.<date>.log`. Dev builds also emit a Tauri event `voice://debug/start_latency` (success path only) so the `/claudette-debug` skill can sample without log tailing. There is no cold/warm split — voice subsystems are intentionally not prewarmed at launch (see the macOS privacy-prompt contract above), so every click is effectively cold. Documented end-to-end under the public Diagnostics page (`site/src/content/docs/features/diagnostics.mdx`).

All debug code is gated behind `#[cfg(debug_assertions)]` / `import.meta.env.DEV` and excluded from release builds. See `.claude/skills/claudette-debug/SKILL.md` for full docs.

## Dependencies

- Add dependencies conservatively — binary size target is < 30 MB
- Cold start target is < 2 seconds to interactive UI
- When choosing crates, prefer well-maintained options with minimal transitive dependencies
- Frontend: use `bun` as package manager, not npm
