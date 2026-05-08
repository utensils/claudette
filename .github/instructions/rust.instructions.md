---
applyTo: "**/*.rs"
---

Rust code uses edition 2024, default rustfmt, and clippy with warnings denied in CI. Prefer clear ownership, explicit error handling, and small focused modules over large multi-purpose functions.

Keep crate boundaries intact. Business logic belongs in the `claudette` crate under `src/`. Tauri command files should parse inputs, open state/resources, call core services, and return serializable results. Do not move durable logic into the webview or into Tauri wrappers just because the caller is UI-driven.

Model types belong in `src/model/`, should be IO-free, and should derive `Serialize`. Database code should open fresh rusqlite connections per command because `Connection` is not `Send`.

For migrations, create a new timestamped SQL file and add a `Migration` entry. Do not modify released migration SQL. Prefer additive, forward-only migrations and include `IF NOT EXISTS` where appropriate.

For process, git, terminal, MCP, plugin, workspace, and agent changes, preserve current lifecycle semantics unless the task explicitly changes them: cancellation, cleanup, event ordering, worktree branch state, persisted session state, and streaming message chronology are regression-sensitive.

When adding backend behavior, add focused tests close to the changed module. Use `tempfile::tempdir()` for git repos and transient DBs. Use `#[tokio::test]` for async behavior.

Avoid expanding god files. If adding a separate concern to `src/diff.rs`, `src/git.rs`, `src/plugin.rs`, `src/mcp.rs`, `src/mcp_supervisor.rs`, `src-tauri/src/ipc.rs`, `src-tauri/src/voice.rs`, or a large command file, extract a helper module or domain file and keep the entry point as orchestration.

Gate OS-specific code with `#[cfg(windows)]`, `#[cfg(unix)]`, `#[cfg(target_os = "macos")]`, or matching negative cfgs. Do not assume Unix paths or shells in cross-platform code.
