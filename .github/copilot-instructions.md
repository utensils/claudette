# Claudette Repository Instructions

Claudette is a cross-platform desktop orchestrator for parallel Claude Code agents. It uses a Tauri 2 Rust backend, a React/TypeScript frontend, SQLite via rusqlite, Tokio process management, git worktrees, xterm.js terminals, Lua plugins, and a local CLI that talks to the running GUI over IPC.

Follow the existing architecture. Core behavior belongs in the `claudette` crate under `src/`. `src-tauri/src/commands/` should stay thin Tauri wrappers. Shared data types belong in `src/model/` and must derive `Serialize`. Frontend state lives in Zustand slices under `src/ui/src/stores/slices/`, not ad hoc globals.

Treat regressions as the main risk. Before changing behavior, identify the current contract: persisted DB fields, Tauri command payloads, CLI output, plugin manifests, settings keys, localized strings, terminal/session semantics, worktree behavior, and visible UI workflows. Do not remove, rename, or silently reinterpret any of these unless the task explicitly asks for that change.

If a behavior change is intentional, call it out plainly in the PR summary or review response and add/update tests that pin the new behavior. If the change was incidental, preserve compatibility instead.

Do not fix type, lint, or test failures by deleting tests, removing UI controls, dropping state fields, weakening assertions, or broadening types. Fix the underlying mismatch and keep existing user-visible capabilities intact.

Control god files. Do not make already-large files the default destination for new behavior. Prefer a focused module, helper, slice, hook, or component near the owning feature, then wire it through the existing entry point. Be especially cautious with `src/diff.rs`, `src/git.rs`, `src/plugin.rs`, `src/mcp.rs`, `src/mcp_supervisor.rs`, `src-tauri/src/commands/*`, `src-tauri/src/voice.rs`, `src-tauri/src/ipc.rs`, `src/ui/src/components/sidebar/Sidebar.tsx`, `src/ui/src/components/chat/ChatPanel.tsx`, `src/ui/src/components/chat/ChatInputArea.tsx`, `src/ui/src/components/terminal/TerminalPanel.tsx`, `src/ui/src/services/tauri.ts`, and large CSS modules.

When touching a god file, keep the diff surgical or extract cohesive behavior first. New code should reduce or isolate complexity, not add another unrelated responsibility.

Use the repo's tools. Rust CI expects `cargo fmt --all --check`, `cargo clippy -p claudette -p claudette-server -p claudette-cli --all-targets --all-features` with `RUSTFLAGS=-Dwarnings`, and `cargo test --all-features`. Frontend CI expects `cd src/ui && bun install --frozen-lockfile`, `bunx tsc --noEmit`, `bun run lint:css`, `bun run build`, and `bun run test`.

Always run `cd src/ui && bunx tsc -b` after TypeScript changes. Vitest uses esbuild and does not type-check the project.

Never edit, rename, or delete released SQL migrations under `src/migrations/*.sql`. Add a new forward migration and register it in `src/migrations/mod.rs`.

Use `bun`, not npm. Keep TypeScript strict and avoid `any`. Keep Rust cross-platform with explicit `#[cfg(...)]` gates for OS-specific code.

Always update user-facing docs in the same PR as the feature change. New or changed user-visible behavior — settings, commands, CLI flags, keyboard shortcuts, environment variables, file locations, plugin manifests, notification triggers — needs a matching update under `site/src/content/docs/`. Per-feature deep-dives go in `site/src/content/docs/features/<topic>.mdx` (register new pages in `site/astro.config.mjs`); every Settings panel control belongs in the matching `## <Section>` table in `site/src/content/docs/features/settings.mdx`. If a change is intentionally undocumented, say so in the PR description.
