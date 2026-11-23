---
applyTo: "**/*.rs"
---

Rust code uses edition 2024, default rustfmt, and clippy with warnings denied in CI. Prefer clear ownership, explicit error handling, and small focused modules over large multi-purpose functions.

Keep crate boundaries intact. Business logic belongs in the `claudette` crate under `src/`. Tauri command files should parse inputs, open state/resources, call core services, and return serializable results. Do not move durable logic into the webview or into Tauri wrappers just because the caller is UI-driven.

Model types belong in `src/model/`, should be IO-free, and should derive `Serialize`. Database code should open fresh rusqlite connections per command because `Connection` is not `Send`.

For migrations, create a new timestamped SQL file and add a `Migration` entry. Do not modify released migration SQL. Prefer additive, forward-only migrations and include `IF NOT EXISTS` where appropriate.

For process, git, terminal, MCP, plugin, workspace, and agent changes, preserve current lifecycle semantics unless the task explicitly changes them: cancellation, cleanup, event ordering, worktree branch state, persisted session state, and streaming message chronology are regression-sensitive.

When adding backend behavior, add focused tests close to the changed module. Use `tempfile::tempdir()` for git repos and transient DBs. Use `#[tokio::test]` for async behavior.

Avoid expanding god files. If adding a separate concern to `src/agent/codex_app_server.rs`, `src/db/checkpoint.rs`, `src/diff.rs`, `src/git.rs`, `src/env.rs`, `src/plugin.rs`, `src/mcp.rs`, `src/mcp_supervisor.rs`, `src-tauri/src/main.rs`, `src-tauri/src/ipc.rs`, `src-tauri/src/voice.rs`, `src-tauri/src/commands/chat/send.rs`, `src-tauri/src/commands/agent_backends/mod.rs`, or a large command file (`scm.rs`, `workspace.rs`, `env.rs`, ...), extract a helper module or domain file and keep the entry point as orchestration.

Gate OS-specific code with `#[cfg(windows)]`, `#[cfg(unix)]`, `#[cfg(target_os = "macos")]`, or matching negative cfgs. Do not assume Unix paths or shells in cross-platform code. Never spawn a subprocess with a raw `std::process::Command::new` / `tokio::process::Command::new` — on Windows that flashes a blank `cmd.exe` console window in release builds. Use the `claudette::process` helper or `CommandWindowExt::no_console_window()`; use `.new_console_window()` only for a terminal the user intentionally opens. CI's clippy `disallowed-methods` check does not run on `claudette-tauri` (`src-tauri/`), so flag raw spawns there in review.

Most operations are reachable from three entry points: the Tauri command, the CLI's IPC dispatch (`src-tauri/src/ipc.rs`), and the remote host (`src-tauri/src/remote_host.rs`, `src-server/`). When one changes, check the others still produce the same side effects (events, tray rebuilds, notifications); shared side effects belong in the `claudette` crate. Changed serialized types must keep reading data written by the previous release (`#[serde(default)]` / `#[serde(alias)]`).
