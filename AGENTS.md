# Claudette

Cross-platform desktop orchestrator for parallel Claude Code agents: Rust (Tauri 2) backend, React/TypeScript webview, SQLite, git worktrees, PTYs, a Lua plugin runtime, a local CLI over IPC, and a WSS remote server. Ships to macOS, Linux, and Windows; users upgrade in place with their existing data.

## About these instruction files

`AGENTS.md` files are the source of truth for agent instructions. This root file holds what applies everywhere; nested files hold what applies to one area and load when you work there:

- `src/ui/AGENTS.md` — frontend (React, Zustand, styling, vitest)
- `src-tauri/AGENTS.md` — Tauri binary crate (commands, notifications, voice, sidecars)
- `src/migrations/AGENTS.md` — schema migrations
- `src/plugin_runtime/AGENTS.md` — Lua plugin system
- `scripts/AGENTS.md` — dev launcher and platform tooling

Each has a sibling `CLAUDE.md` containing only `@AGENTS.md`, so Claude Code loads the same text. Edit the `AGENTS.md` files, never the `CLAUDE.md` stubs. Keep this root file under 32 KiB (Codex's default `project_doc_max_bytes`); move area-specific detail into a nested file instead.

Copilot reads `.github/copilot-instructions.md` and `.github/instructions/*.instructions.md`. When you change a rule, command, or god-file list here, update the matching statement there too, or Copilot's PR reviews will enforce stale rules.

## Commands

```bash
# Rust
cargo fmt --all --check
cargo clippy -p claudette -p claudette-server -p claudette-cli --all-targets --all-features  # zero warnings
cargo test -p claudette -p claudette-server -p claudette-cli --all-features                 # what CI's Test job runs
cargo test -p claudette <substring>                                                         # tests whose path matches
cargo test -p claudette --lib diff::tests::test_validate_file_path_rejects_traversal -- --exact
cargo test -p claudette --test grants_enforcement                                           # one file in tests/

# Frontend
cd src/ui && bun install
cd src/ui && bunx tsc -b          # type check; vitest does not type-check
cd src/ui && bun run test         # vitest
cd src/ui && bun run lint:css     # design-token enforcement
cd src/ui && bun run lint         # ESLint (not run in CI)

# App
./scripts/dev.sh                  # dev mode (Windows: scripts\dev.ps1); see scripts/AGENTS.md
cargo tauri build                 # release build
```

CI sets `RUSTFLAGS=-Dwarnings`, so any compiler warning fails the build.

## Before you commit

Run what applies to what you touched:

- **Rust:** `cargo fmt --all`, the clippy command above with zero warnings, then the tests for the crate you changed.
- **`src-tauri/`:** also the checks in `src-tauri/AGENTS.md`. CI neither lints that crate nor runs its tests.
- **TypeScript or CSS:** `cd src/ui && bunx tsc -b && bun run lint:css && bun run test && bun run lint`. Run `tsc -b` after any TS change, tests included.
- **User-visible change:** a docs update in the same PR (see Documentation discipline).
- **Lockfiles:** CI runs `bun install --frozen-lockfile`; don't change `bun.lock` unless you meant to.

## Never do

- Edit, rename, or delete a released migration (`src/migrations/AGENTS.md`).
- Spawn a subprocess with a raw `Command::new` (Windows specifics).
- Trigger a macOS permission prompt at app launch (macOS privacy-prompt contract).
- Fix a failing check by deleting tests, weakening assertions, broadening types, or removing UI controls, settings, or translation keys (Regression discipline).
- Put business logic in a `#[tauri::command]` wrapper (Architecture).
- Use npm, or raw color literals outside `theme.css` (`src/ui/AGENTS.md`).
- Read or write `PRAGMA user_version`.

## Architecture

Five crates in one Cargo workspace:

| Crate | Path | Role |
|---|---|---|
| `claudette` | `src/` | Core library: models, db, git, diff, agents, transport. No UI or Tauri deps. |
| `claudette-tauri` | `src-tauri/` | The app binary (`claudette-app`). Thin `#[tauri::command]` wrappers over `claudette`. |
| `claudette-server` | `src-server/` | WSS remote server (TLS, pairing). Runs standalone or in-process for "Share this machine". |
| `claudette-cli` | `src-cli/` | `claudette` CLI; drives the running GUI over a local IPC socket. |
| `claudette-mobile` | `src-mobile/` | iOS/Android remote-control client; pairs with a desktop or server. |

- **Logic lives in the `claudette` crate.** Tauri commands parse input, call core, and map the result. Data types go in `src/model/`, stay IO-free, and derive `Serialize`.
- **Three entry points, one core.** Most operations are reachable from the GUI (Tauri command), the CLI (`src-tauri/src/ipc.rs`), and paired remote clients (`src-tauri/src/remote_host.rs`, `src-server/`). When you change one, check the others still do the same things around the core call (events, tray rebuilds, notifications). Move shared side effects into the core rather than copying them.
- **State:** UI state lives in Zustand slices. Agent sessions live in the Rust-side `AppState`. Streaming data (agent events, PTY output) flows as Tauri events. UI-only state (collapsed sections, panel widths, selection) is never persisted.
- **SQLite:** `rusqlite::Connection` is not `Send`. Open a fresh connection per command with `Database::open(&state.db_path)`.
- **Agent backends** dispatch on `AgentBackendConfig::effective_harness` in `src/agent_backend.rs`, not on `AgentBackendKind`. `kind` only declares which harness is valid.
- **The CLI** is `src-cli/` (clap) talking to `src-tauri/src/ipc.rs`. It needs the GUI running. Prefer it over poking the SQLite DB directly. (`src-tauri/src/commands/cli.rs` only installs the bundled binary onto `PATH`.)
- **Shell environment:** `src/env.rs` captures the user's interactive shell env at launch. Every spawn site applies `crate::env::enriched_env().apply(&mut cmd)`; env-provider plugins (direnv, mise, dotenv, nix-devshell) layer on top. The captured env is full of secrets, so never log it whole.

## Regression discipline

Regressions are the main risk, ahead of style. Before changing behavior, identify the current contract and don't remove, rename, or silently reinterpret any of these unless the task explicitly asks for it:

- persisted DB fields
- Tauri command payloads
- CLI output
- plugin manifests
- settings keys
- localized strings
- terminal and session semantics
- worktree behavior
- visible UI workflows

Users upgrade in place, so new code must read data written by the previous release (`#[serde(default)]` / `#[serde(alias)]` on changed fields). The CLI, a paired server, and the mobile app may each be a version apart from the desktop.

An intentional behavior change is called out in the PR summary and pinned by tests. An incidental one is reverted to keep compatibility. Never fix a type, lint, or test failure by deleting tests, removing controls, dropping state fields, weakening assertions, or broadening types; fix the mismatch.

For a bug, confirm it first: read the code path, reproduce it, or check `git log` / `git blame` for why the code is that way. Then prove it with the narrowest test that fails before the fix. If a test is impractical, the PR carries a concrete UAT checklist.

## God files — keep diffs surgical

These files are already too large. Don't make them the default home for new behavior. Extract a focused module, hook, slice, or child component near the owning feature and wire it in. If the right home doesn't exist yet, create it in its own commit first.

- **Rust:**
  - `src/`: `agent/codex_app_server.rs`, `db/checkpoint.rs`, `diff.rs`, `git.rs`, `env.rs`, `plugin.rs`, `mcp.rs`, `mcp_supervisor.rs`
  - `src-tauri/src/`: `main.rs`, `ipc.rs`, `voice.rs`
  - `src-tauri/src/commands/`: `chat/send.rs`, `scm.rs`, `workspace.rs`, `env.rs`, `agent_backends/mod.rs` and its largest siblings (`gateway_translate.rs`, `runtime_dispatch.rs`, `discovery.rs`, `config.rs`), plus any other command file already a few hundred lines long
- **Frontend** (`src/ui/src/`): `components/sidebar/Sidebar.tsx`, `components/chat/ChatPanel.tsx`, `components/chat/ChatInputArea.tsx`, `components/terminal/TerminalPanel.tsx`, `hooks/useAgentStream.ts`, and large CSS modules such as `Settings.module.css` and `ChatPanel.module.css`

## Windows specifics

- **No raw `Command::new`.** A Windows GUI process has no console, so a child spawned without `CREATE_NO_WINDOW` flashes a blank `cmd.exe` window. It only shows in release builds, never in dev.
  - Build commands with the `claudette::process` helpers, or call `.no_console_window()` (`CommandWindowExt`) before `.spawn()` / `.output()` / `.status()`.
  - Use `.new_console_window()` only for a terminal the user deliberately opens (cmd, pwsh, wt).
  - `clippy.toml` bans raw `Command::new` in the crates CI lints, but not in `claudette-tauri`, so check spawn sites there by hand.
- Gate OS-specific code with `#[cfg(windows)]` / `#[cfg(not(windows))]` and friends. Don't assume Unix paths or shells.
- There is no Windows build on PRs (only nightly and release), so `cfg(windows)` code goes unchecked until after merge. Say in the PR how you verified it. For cross-compiling and Windows VMs, see `scripts/AGENTS.md`.

## macOS privacy-prompt contract

macOS attributes a permission (TCC) prompt to whatever triggered it, so an unprompted one at launch looks like spyware. Never touch CoreAudio, Speech.framework, or the microphone at app launch.

- **Voice status** uses the prompt-safe `PlatformSpeechEngine::availability()`. The prompting `prepare()` runs only inside `start_recording_locked`, when the user clicks the mic.
- **No prewarm:** there is no startup prewarm and no cpal device enumeration at launch.
- **mDNS exception:** mDNS discovery starts at launch on purpose, to keep the Nearby list populated. Changing that changes when the Local Network prompt appears, so it needs a deliberate replacement UX.

## Documentation discipline

Update the user-facing docs in the same PR as the feature change. That covers any user-visible change: settings, commands, CLI flags, keyboard shortcuts, environment variables, file locations, plugin manifests, and notification triggers. The docs site is `site/src/content/docs/` (Astro Starlight).

- **Feature pages:** `features/<topic>.mdx` covers one feature. A new feature gets a new page, registered in the sidebar in `site/astro.config.mjs`. A new setting on an existing feature updates its page.
- **Settings table:** `features/settings.mdx` has a row for every Settings panel control, under its `## <Section>` table.

If a change is intentionally undocumented (a debug-only flag, an internal env var), say so in the PR description. CI does not check this.

## Testing patterns

- **Rust:** tests build throwaway git repos with `tempfile::tempdir()` instead of using fixtures or test databases. Async tests use `#[tokio::test]`. Test modules go at the bottom of the file in `#[cfg(test)] mod tests`.
- **TypeScript:** see `src/ui/AGENTS.md`.

## Commits and pull requests

- **Conventional commits:** types are listed in `.commitlintrc.yml`; the header is at most 100 characters.
- **Pick the type by who notices the change.** `feat`, `fix` and `perf` reach the user-facing changelog via release-please. Contributor-facing work is `chore`, `refactor`, `test`, `ci`, or `docs`.
- **Merging:** `main` allows squash or rebase merges. With squash, the PR title (checked by `PR title`) becomes the commit. With rebase, every branch commit lands and feeds the changelog.
- **Opening a PR:** a maintainer-approved issue comes first. Follow `.github/PULL_REQUEST_TEMPLATE.md`: `Closes #N`, Summary, Screenshots for UI changes, UAT Plan, Checklist.
- **Review:** one approving review is needed, including a code owner. Approvals are dismissed on push, so batch fixes into one push. Copilot reviews every push, drafts included.

## CI

`.github/workflows/ci.yml` runs on PRs and on pushes to `main`:

- **Rust:** `Format`, `Lint`, `Test` (`cargo llvm-cov`, coverage informational), `Desktop Tauri Check` (compiles `claudette-tauri` tests without running them), `Mobile (macOS)`
- **Frontend:** `Frontend` (`tsc --noEmit`, `lint:css`, build, vitest), `Frontend Bundle Smoke`
- **Repo guards:** `Migration guard`, `Cargo Version Sync`, `Updater Manifest`

Only `Format` and `Test` are required, and the check is not strict (a PR need not be up to date with `main`). Treat every red check as blocking anyway.

**Not covered by CI** — run these yourself, or say in the PR why you couldn't:

- `claudette-tauri` tests are never run, and the crate is not linted
- ESLint
- Windows builds
- iOS and Android targets
- docs updates

Nightly builds every platform from each push to `main` and stamps all five `Cargo.toml` versions. Releases go through release-please (`.github/workflows/release-please.yml`).

## Working in parallel worktrees

- Each worktree has its own `target/`, `src/ui/node_modules`, and `src-tauri/binaries/`, all gitignored. A fresh one needs `cd src/ui && bun install`. Its first Cargo build is slow and CPU-heavy.
- `git stash` is shared across worktrees. Never use bare `git stash` or `git stash pop`; commit work in progress instead.
- Launch the app only via `./scripts/dev.sh`, which probes for free ports. Stop only processes you started, by PID, since other worktrees run processes with the same names.

## Dependencies

- Add dependencies conservatively. The binary must stay under 30 MB and cold start to interactive UI under 2 s. Prefer well-maintained crates with few transitive dependencies.
- Use `bun` for the frontend, never npm.

## Code style

- Rust edition 2024, default `rustfmt`, default `clippy` plus `clippy.toml`.
- TypeScript strict mode, with no `any`.
