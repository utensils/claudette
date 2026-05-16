# Interactive Claude Sessions (tmux / sidecar host) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `superpowers/specs/2026-05-16-claude-interactive-tmux-design.md` (commit `f346b37`). Read it first if you have not.

**Goal:** Add a new experimental `ClaudeInteractive` agent backend that runs interactive `claude` inside a detachable host — tmux on Unix, a custom Rust sidecar (`claudette-session-host`) on Windows — alongside the existing `claude --print` flow.

**Architecture:** A new `InteractiveHost` async trait (`src/agent/interactive_host/`) with two impls (`tmux.rs`, `sidecar.rs`). A new workspace crate `claudette-session-host` provides the Windows sidecar. New types flow through `AgentHarnessKind::ClaudeInteractive` + `AgentSession::ClaudeInteractive(...)`. UI gated behind `claudeInteractiveEnabled` experimental flag. Hooks (`Stop`, `Notification`, `UserPromptSubmit`) flow back through a new `claudette-cli chat hook` subcommand into the existing IPC server.

**Tech Stack:** Rust (workspace, Tokio, `portable-pty`, `interprocess`, `alacritty_terminal`, `serde_json`, `tokio::process`), TypeScript (React, Zustand, xterm.js), SQLite (`rusqlite`), tmux ≥ 3.0 (Unix only).

**Conventions to follow:**
- Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`).
- `cargo fmt --all`, `cargo clippy -p claudette -p claudette-server -p claudette-cli -p claudette-session-host --all-targets --all-features` must pass with **zero warnings** (`RUSTFLAGS="-Dwarnings"` in CI).
- `cd src/ui && bunx tsc -b && bun run lint && bun run lint:css && bun run test` — run all four before any frontend commit.
- All migration files use `YYYYMMDDHHMMSS_snake_case.sql` named with the current UTC timestamp at the moment you author the file (`date -u +%Y%m%d%H%M%S`). The plan uses `<MIGRATION_TS>` as a placeholder — substitute when you create the file and use the same value in `MIGRATIONS`.
- `apiVersion 63.0` in cls-meta.xml is not relevant here (no Salesforce).
- Every Rust public item gets a doc comment.
- TypeScript: strict mode, no `any`. Vitest, not Jest. `bun`, not npm.
- All UI colors are CSS custom-property references (`var(--token-name)`) — no raw hex/rgba outside `theme.css`.
- Keep god files small: `TerminalPanel.tsx`, `ChatPanel.tsx`, `ChatInputArea.tsx`, `sidebar/Sidebar.tsx`, `services/tauri.ts`. Prefer new files over piling onto these.

**Test contract:** every step that says "Run …" expects the command to exit 0 with the documented output. Steps that say "Expected: FAIL with …" expect non-zero exit and the documented substring in stderr.

---

## File map

### New files
| Path | Responsibility |
|---|---|
| `src/agent/interactive_host/mod.rs` | `InteractiveHost` trait, shared types (`SessionId`, `SessionSpec`, etc.), host-selection function. |
| `src/agent/interactive_host/types.rs` | Data types: `SessionId`, `SessionSpec`, `HostHandle`, `AttachStream`, `InputPayload`, `OutputDelta`, `HookFired`, `HookKind`, `ScreenSnapshot`, `HostStatus`, `StopMode`. |
| `src/agent/interactive_host/tmux.rs` | `TmuxHost` impl (`#[cfg(unix)]`). |
| `src/agent/interactive_host/sidecar.rs` | `SidecarHost` impl (all platforms). Owns the local-socket connection. |
| `src/agent/interactive_host/conformance.rs` | `pub async fn run<H: InteractiveHost>(host: H, fixture: TestFixture)` — the shared test suite both impls must pass. |
| `src/agent/interactive_host/availability.rs` | Tmux/sidecar availability checks (with 30s TTL cache). |
| `src/agent/claude_interactive.rs` | The `ClaudeInteractive` backend module: turn execution, hook ingestion, settings-overlay materialization. |
| `src/agent/interactive_protocol.rs` | Wire protocol types shared between Rust client (`SidecarHost`) and the `claudette-session-host` server. Length-prefixed JSON-line frames. |
| `src/migrations/<MIGRATION_TS>_interactive_sessions.sql` | The new table. |
| `src-session-host/Cargo.toml` | The new crate manifest. |
| `src-session-host/src/main.rs` | Sidecar binary entry point. |
| `src-session-host/src/server.rs` | Local-socket server, per-connection task. |
| `src-session-host/src/session.rs` | Per-session PTY + grid model + attach broadcast. |
| `src-session-host/src/idle.rs` | Idle-exit timer. |
| `tests/interactive_host_sidecar.rs` | Sidecar conformance test (all platforms). |
| `tests/interactive_host_tmux.rs` | Tmux conformance test (`#[cfg(unix)]`). |
| `tests/fixtures/stub-tui/Cargo.toml` | Stub-TUI manifest. |
| `tests/fixtures/stub-tui/src/main.rs` | Stub TUI binary. |
| `src-cli/src/commands/chat_hook.rs` | `claudette-cli chat hook` subcommand. |
| `src/ui/src/components/chat/InteractiveTurnView.tsx` | Per-turn embedded xterm.js view. |
| `src/ui/src/components/chat/InteractiveTerminalMode.tsx` | Full-terminal mode of the chat panel. |
| `src/ui/src/hooks/useInteractiveTurnAssembler.ts` | Hook-delimited turn assembler. |
| `src/ui/src/services/interactive.ts` | Tauri bridge for interactive sessions (`startInteractive`, `attach`, `sendInput`, `stop`, etc.). |
| `src/ui/src/components/chat/InteractiveTurnView.test.tsx` | Turn-assembler tests. |
| `site/src/content/docs/features/interactive-claude.mdx` | User-facing docs page. |

### Modified files
| Path | What changes |
|---|---|
| `Cargo.toml` | Register `src-session-host` and `tests/fixtures/stub-tui` workspace members; add `alacritty_terminal` and `interprocess` to workspace deps if not already present. |
| `src/agent/mod.rs` | `pub mod interactive_host;` + `pub mod claude_interactive;` + re-exports. |
| `src/agent/harness.rs` | Add `ClaudeInteractive` variant to `AgentHarnessKind`, `AgentSession`, capabilities for it. |
| `src/agent_backend.rs` | New backend-kind enum value + resolver branch. |
| `src/migrations/mod.rs` | Append the new `MIGRATIONS` entry. |
| `src/db.rs` | New CRUD helpers `interactive_session_*`. |
| `src/lib.rs` | Re-export `interactive_host` and `claude_interactive` if needed by tests. |
| `src-cli/src/main.rs` and `src-cli/src/commands/mod.rs` | Register the new `chat hook` subcommand. |
| `src-tauri/Cargo.toml` | Add `claudette-session-host` as a workspace dep; add `bundle.externalBin` entry. |
| `src-tauri/tauri.conf.json` | Bundle the sidecar binary. |
| `src-tauri/src/commands/chat.rs` | Dispatch interactive backends; emit interactive events. |
| `src-tauri/src/commands/settings.rs` | Wire the new experimental flag setter/getter (boolean app_setting). |
| `src-tauri/src/commands/mod.rs` and a new `src-tauri/src/commands/interactive.rs` | Tauri commands for interactive sessions. |
| `src-tauri/src/ipc.rs` | Ingest hook events from the CLI. |
| `src-tauri/src/state.rs` | Store per-workspace `InteractiveHost` selection (Arc-ed). |
| `src/ui/src/components/chat/ChatPanel.tsx` | Conditional render: interactive vs print-mode. |
| `src/ui/src/components/chat/ChatHeader.tsx` (or wherever the chat header lives) | "Open in Terminal" toggle. |
| `src/ui/src/components/sidebar/Sidebar.tsx` | Badge states: Awaiting input / Detached / Crashed. |
| `src/ui/src/components/settings/sections/ExperimentalSettings.tsx` | New flag row. |
| `src/ui/src/components/settings/sections/ModelsSettings.tsx` (or the Runtime sub-section) | New backend card, greyed when flag off. |
| `src/ui/src/store/*.ts` | New Zustand slice for interactive sessions. |
| `site/src/content/docs/features/settings.mdx` | Reference-table row for the flag. |
| `site/astro.config.mjs` | Sidebar entry for the new docs page. |
| `CLAUDE.md` | Document the new backend, host model, experimental flag, hook protocol. |
| `.github/copilot-instructions.md` | Mirror the additions per the alignment rule in CLAUDE.md. |

---

## Phase A — Foundation: settings flag, types, migration

### Task A1: Add `claudeInteractiveEnabled` Settings key with a failing test

**Files:**
- Modify: `src/ui/src/store/settingsSlice.ts` (or equivalent — the file that owns the typed `Settings` shape; find via `grep -rn "pluginManagementEnabled" src/ui/src/store`)
- Modify: matching `*.test.ts` for the slice
- Create only if no existing slice test: `src/ui/src/store/settingsSlice.test.ts`

- [ ] **Step 1: Locate the existing flag.** Run `grep -rn "pluginManagementEnabled" src/ui/src` to find the type, default, and reducer. The new flag follows the exact same shape.

- [ ] **Step 2: Write the failing test** in the same file as the existing `pluginManagementEnabled` tests (search again to confirm path):

```ts
it("toggles claudeInteractiveEnabled and persists", async () => {
  const store = useAppStore.getState();
  expect(store.settings.claudeInteractiveEnabled).toBe(false);
  await store.setSetting("claudeInteractiveEnabled", true);
  expect(useAppStore.getState().settings.claudeInteractiveEnabled).toBe(true);
});
```

- [ ] **Step 3: Run the test** `cd src/ui && bun run test -t "claudeInteractiveEnabled"`. Expected: FAIL with `Property 'claudeInteractiveEnabled' is missing` or `expected undefined to be false`.

- [ ] **Step 4: Add the field to the `Settings` interface** (next to `pluginManagementEnabled`):

```ts
export interface Settings {
  // ... existing fields ...
  pluginManagementEnabled: boolean;
  claudeInteractiveEnabled: boolean;
}
```

- [ ] **Step 5: Default it to `false`** in the slice's initial state (next to `pluginManagementEnabled: false`).

- [ ] **Step 6: Wire the setter** if the slice uses a generic key-based setter, no further work is needed. If it has explicit per-field setters, add `setClaudeInteractiveEnabled`. The existing `pluginManagementEnabled` setter is the template — match it exactly.

- [ ] **Step 7: Rerun the test.** Run: `cd src/ui && bun run test -t "claudeInteractiveEnabled"`. Expected: PASS.

- [ ] **Step 8: Run type check.** Run: `cd src/ui && bunx tsc -b`. Expected: exit 0, no errors.

- [ ] **Step 9: Commit.**

```bash
git add src/ui/src/store/settingsSlice.ts src/ui/src/store/settingsSlice.test.ts
git commit -m "feat(settings): add claudeInteractiveEnabled experimental flag"
```

---

### Task A2: Persist the flag through the Rust app_settings table

**Files:**
- Modify: `src/db.rs` (search for `pluginManagementEnabled` to find the read path)
- Modify: `src-tauri/src/commands/settings.rs` (search for `pluginManagementEnabled` to find the IPC plumbing)

- [ ] **Step 1: Locate the read/write paths.** Run `grep -rn "pluginManagementEnabled" src/ src-tauri/src`. Note every site.

- [ ] **Step 2: Write a Rust test** at the bottom of `src/db.rs` (inside the existing `#[cfg(test)] mod tests` block):

```rust
#[test]
fn claude_interactive_enabled_round_trips() {
    let dir = tempfile::tempdir().unwrap();
    let db_path = dir.path().join("test.db");
    let db = Database::open(&db_path).unwrap();
    db.run_migrations().unwrap();
    db.set_app_setting("claudeInteractiveEnabled", "true").unwrap();
    let v = db.get_app_setting("claudeInteractiveEnabled").unwrap();
    assert_eq!(v.as_deref(), Some("true"));
}
```

- [ ] **Step 3: Run the test.** Run: `cargo test -p claudette claude_interactive_enabled_round_trips -- --exact`. Expected: PASS (this only exercises the existing generic `app_settings` table; no code change should be required).

- [ ] **Step 4: Update the typed `AppSettings` Rust struct** if there is one (search `grep -n "pluginManagementEnabled" src/`); add the new boolean field with `#[serde(default)]` and a default `false`.

- [ ] **Step 5: Wire the typed settings getter/setter** in `src-tauri/src/commands/settings.rs` to read/write the new key the same way `pluginManagementEnabled` is wired.

- [ ] **Step 6: Run** `cargo test -p claudette -p claudette-server -p claudette-cli --all-features` and `cargo clippy -p claudette -p claudette-server -p claudette-cli --all-targets --all-features`. Expected: both pass, zero warnings.

- [ ] **Step 7: Commit.**

```bash
git add src/db.rs src-tauri/src/commands/settings.rs # plus any AppSettings file you touched
git commit -m "feat(settings): persist claudeInteractiveEnabled via app_settings"
```

---

### Task A3: Migration for `interactive_sessions` table

**Files:**
- Create: `src/migrations/<MIGRATION_TS>_interactive_sessions.sql`
- Modify: `src/migrations/mod.rs`

- [ ] **Step 1: Pick the timestamp.** Run `date -u +%Y%m%d%H%M%S` and record the output as `<MIGRATION_TS>`. Use the exact same value in the filename and the `MIGRATIONS` entry.

- [ ] **Step 2: Write a failing test** appended to `src/migrations/mod.rs`'s `#[cfg(test)] mod tests` block:

```rust
#[test]
fn interactive_sessions_table_is_created() {
    use rusqlite::Connection;
    let tmp = tempfile::NamedTempFile::new().unwrap();
    let mut conn = Connection::open(tmp.path()).unwrap();
    super::run_pending_migrations(&mut conn).unwrap();
    let cols: Vec<String> = conn
        .prepare("SELECT name FROM pragma_table_info('interactive_sessions')")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .filter_map(Result::ok)
        .collect();
    for expected in [
        "sid",
        "workspace_id",
        "host_kind",
        "state",
        "crash_reason",
        "created_at",
        "last_attached_at",
        "last_screen_blob",
        "claude_flags_json",
        "pid",
    ] {
        assert!(cols.iter().any(|c| c == expected), "missing column {expected}");
    }
}
```

- [ ] **Step 3: Run the test.** Run: `cargo test -p claudette interactive_sessions_table_is_created -- --exact`. Expected: FAIL with `no such table: interactive_sessions`.

- [ ] **Step 4: Create the SQL file** at `src/migrations/<MIGRATION_TS>_interactive_sessions.sql`:

```sql
CREATE TABLE IF NOT EXISTS interactive_sessions (
    sid                TEXT PRIMARY KEY,
    workspace_id       TEXT NOT NULL,
    host_kind          TEXT NOT NULL,
    state              TEXT NOT NULL,
    crash_reason       TEXT,
    created_at         TEXT NOT NULL,
    last_attached_at   TEXT,
    last_screen_blob   BLOB,
    claude_flags_json  TEXT NOT NULL,
    pid                INTEGER,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_interactive_sessions_workspace
    ON interactive_sessions(workspace_id);
```

- [ ] **Step 5: Register it.** Append the entry inside `MIGRATIONS` (substitute the real timestamp):

```rust
    Migration {
        id: "<MIGRATION_TS>_interactive_sessions",
        sql: include_str!("<MIGRATION_TS>_interactive_sessions.sql"),
        legacy_version: None,
    },
```

- [ ] **Step 6: Run the test again.** Run: `cargo test -p claudette interactive_sessions_table_is_created -- --exact`. Expected: PASS.

- [ ] **Step 7: Run the migration-id uniqueness test.** Run: `cargo test -p claudette migrations -- --exact`. Expected: PASS (catches you accidentally duplicating an existing ID).

- [ ] **Step 8: Commit.**

```bash
git add src/migrations/<MIGRATION_TS>_interactive_sessions.sql src/migrations/mod.rs
git commit -m "feat(db): add interactive_sessions table migration"
```

---

### Task A4: DB CRUD helpers for `interactive_sessions`

**Files:**
- Modify: `src/db.rs`

- [ ] **Step 1: Write failing tests** in `src/db.rs`'s test module:

```rust
#[test]
fn interactive_session_create_get_update_delete() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("t.db")).unwrap();
    db.run_migrations().unwrap();
    // Need a workspace row to satisfy the FK.
    db.insert_workspace_for_test("ws-1").unwrap(); // see step 2

    let row = InteractiveSessionRow {
        sid: "claudette-ws1-aaaaaaaa".into(),
        workspace_id: "ws-1".into(),
        host_kind: "sidecar".into(),
        state: "running".into(),
        crash_reason: None,
        created_at: "2026-05-16T00:00:00Z".into(),
        last_attached_at: None,
        last_screen_blob: None,
        claude_flags_json: "[]".into(),
        pid: Some(1234),
    };
    db.create_interactive_session(&row).unwrap();
    let got = db.get_interactive_session("claudette-ws1-aaaaaaaa").unwrap().unwrap();
    assert_eq!(got.state, "running");
    assert_eq!(got.pid, Some(1234));

    db.set_interactive_session_state("claudette-ws1-aaaaaaaa", "detached", None).unwrap();
    let got2 = db.get_interactive_session("claudette-ws1-aaaaaaaa").unwrap().unwrap();
    assert_eq!(got2.state, "detached");

    db.update_interactive_session_screen("claudette-ws1-aaaaaaaa", b"\x1b[31mhi\x1b[0m").unwrap();
    let got3 = db.get_interactive_session("claudette-ws1-aaaaaaaa").unwrap().unwrap();
    assert_eq!(got3.last_screen_blob.as_deref(), Some(b"\x1b[31mhi\x1b[0m".as_slice()));

    let listed = db.list_interactive_sessions_for_workspace("ws-1").unwrap();
    assert_eq!(listed.len(), 1);

    db.delete_interactive_session("claudette-ws1-aaaaaaaa").unwrap();
    assert!(db.get_interactive_session("claudette-ws1-aaaaaaaa").unwrap().is_none());
}
```

- [ ] **Step 2: If a `insert_workspace_for_test` helper does not exist**, locate the existing workspace insert path (`grep -n "fn create_workspace" src/db.rs`) and add a small test-only wrapper that inserts a minimal row, gated `#[cfg(test)] pub fn insert_workspace_for_test`.

- [ ] **Step 3: Run the test to confirm failure.** Run: `cargo test -p claudette interactive_session_create_get_update_delete -- --exact`. Expected: FAIL (no `InteractiveSessionRow`, no methods).

- [ ] **Step 4: Add the struct and methods to `src/db.rs`:**

```rust
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct InteractiveSessionRow {
    pub sid: String,
    pub workspace_id: String,
    pub host_kind: String,
    pub state: String,
    pub crash_reason: Option<String>,
    pub created_at: String,
    pub last_attached_at: Option<String>,
    pub last_screen_blob: Option<Vec<u8>>,
    pub claude_flags_json: String,
    pub pid: Option<i64>,
}

impl Database {
    pub fn create_interactive_session(&self, row: &InteractiveSessionRow) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT INTO interactive_sessions
             (sid, workspace_id, host_kind, state, crash_reason, created_at,
              last_attached_at, last_screen_blob, claude_flags_json, pid)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            rusqlite::params![
                row.sid, row.workspace_id, row.host_kind, row.state, row.crash_reason,
                row.created_at, row.last_attached_at, row.last_screen_blob,
                row.claude_flags_json, row.pid,
            ],
        )?;
        Ok(())
    }

    pub fn get_interactive_session(&self, sid: &str) -> rusqlite::Result<Option<InteractiveSessionRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT sid, workspace_id, host_kind, state, crash_reason, created_at,
                    last_attached_at, last_screen_blob, claude_flags_json, pid
             FROM interactive_sessions WHERE sid = ?1",
        )?;
        let mut rows = stmt.query([sid])?;
        if let Some(r) = rows.next()? {
            Ok(Some(InteractiveSessionRow {
                sid: r.get(0)?,
                workspace_id: r.get(1)?,
                host_kind: r.get(2)?,
                state: r.get(3)?,
                crash_reason: r.get(4)?,
                created_at: r.get(5)?,
                last_attached_at: r.get(6)?,
                last_screen_blob: r.get(7)?,
                claude_flags_json: r.get(8)?,
                pid: r.get(9)?,
            }))
        } else {
            Ok(None)
        }
    }

    pub fn list_interactive_sessions_for_workspace(&self, workspace_id: &str) -> rusqlite::Result<Vec<InteractiveSessionRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT sid, workspace_id, host_kind, state, crash_reason, created_at,
                    last_attached_at, last_screen_blob, claude_flags_json, pid
             FROM interactive_sessions WHERE workspace_id = ?1
             ORDER BY created_at DESC",
        )?;
        let iter = stmt.query_map([workspace_id], |r| Ok(InteractiveSessionRow {
            sid: r.get(0)?,
            workspace_id: r.get(1)?,
            host_kind: r.get(2)?,
            state: r.get(3)?,
            crash_reason: r.get(4)?,
            created_at: r.get(5)?,
            last_attached_at: r.get(6)?,
            last_screen_blob: r.get(7)?,
            claude_flags_json: r.get(8)?,
            pid: r.get(9)?,
        }))?;
        iter.collect()
    }

    pub fn set_interactive_session_state(
        &self,
        sid: &str,
        state: &str,
        crash_reason: Option<&str>,
    ) -> rusqlite::Result<()> {
        self.conn.execute(
            "UPDATE interactive_sessions SET state = ?1, crash_reason = ?2 WHERE sid = ?3",
            rusqlite::params![state, crash_reason, sid],
        )?;
        Ok(())
    }

    pub fn update_interactive_session_screen(&self, sid: &str, blob: &[u8]) -> rusqlite::Result<()> {
        self.conn.execute(
            "UPDATE interactive_sessions SET last_screen_blob = ?1,
             last_attached_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
             WHERE sid = ?2",
            rusqlite::params![blob, sid],
        )?;
        Ok(())
    }

    pub fn delete_interactive_session(&self, sid: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "DELETE FROM interactive_sessions WHERE sid = ?1",
            rusqlite::params![sid],
        )?;
        Ok(())
    }
}
```

- [ ] **Step 5: Run the test.** Run: `cargo test -p claudette interactive_session_create_get_update_delete -- --exact`. Expected: PASS.

- [ ] **Step 6: Clippy.** Run: `cargo clippy -p claudette --all-targets --all-features`. Expected: zero warnings.

- [ ] **Step 7: Commit.**

```bash
git add src/db.rs
git commit -m "feat(db): add interactive_sessions CRUD helpers"
```

---

## Phase B — Trait + protocol types + stub TUI

### Task B1: Shared protocol/types module

**Files:**
- Create: `src/agent/interactive_protocol.rs`
- Modify: `src/agent/mod.rs`

- [ ] **Step 1: Add `pub mod interactive_protocol;`** to `src/agent/mod.rs`.

- [ ] **Step 2: Write failing tests** at the bottom of `src/agent/interactive_protocol.rs` (create the file with this content):

```rust
//! Wire-protocol types for the `claudette-session-host` sidecar.
//!
//! These types are also re-used by the in-process `SidecarHost` client and the
//! `claudette-session-host` binary, so they live in the library crate so both
//! sides see the same definitions.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Request {
    Hello { protocol_version: u32, claudette_version: String },
    EnsureSession { sid: String, spec: SessionSpec },
    Attach { sid: String },
    SendInput { sid: String, payload: InputPayload },
    CaptureScreen { sid: String },
    Resize { sid: String, rows: u16, cols: u16 },
    Detach { sid: String, attach_id: u64 },
    Stop { sid: String, mode: StopMode },
    Status,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Response {
    HelloAck { protocol_version: u32, host_version: String, pid: u32 },
    HelloNack { reason: String, supported_versions: Vec<u32> },
    SessionStarted { sid: String, pid: u32, rows: u16, cols: u16 },
    AttachStarted { attach_id: u64 },
    Ok,
    ScreenSnapshot { rows: u16, cols: u16, ansi_bytes_b64: String },
    Stopped { exit_status: i32 },
    Status { sessions: Vec<SessionSummary>, host_version: String },
    Error { message: String, recoverable: bool },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Event {
    Output { sid: String, bytes_b64: String, seq: u64 },
    Hook { sid: String, hook: HookFired },
    Exit { sid: String, exit_status: i32, reason: String },
    StreamError { sid: String, message: String, recoverable: bool },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionSpec {
    pub working_dir: String,
    pub rows: u16,
    pub cols: u16,
    pub claude_binary: String,
    pub claude_args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub claude_config_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionSummary {
    pub sid: String,
    pub pid: Option<u32>,
    pub running: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InputPayload {
    Text { text: String },
    Keys { name: String },
    Bytes { bytes_b64: String },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StopMode {
    Graceful,
    Force,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HookFired {
    Stop,
    Awaiting { reason: Option<String> },
    PromptSubmitted,
    SubagentStop,
    Unknown { raw_kind: String, raw_payload: String },
}

pub const PROTOCOL_VERSION: u32 = 1;

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip<T>(value: &T)
    where
        T: serde::Serialize + serde::de::DeserializeOwned + PartialEq + std::fmt::Debug,
    {
        let json = serde_json::to_string(value).unwrap();
        let back: T = serde_json::from_str(&json).unwrap();
        assert_eq!(value, &back);
    }

    #[test]
    fn request_kinds_round_trip() {
        roundtrip(&Request::Hello {
            protocol_version: PROTOCOL_VERSION,
            claudette_version: "0.0.0".into(),
        });
        roundtrip(&Request::EnsureSession {
            sid: "x".into(),
            spec: SessionSpec {
                working_dir: "/tmp".into(),
                rows: 24,
                cols: 80,
                claude_binary: "/bin/claude".into(),
                claude_args: vec!["--model".into(), "opus".into()],
                env: vec![("FOO".into(), "BAR".into())],
                claude_config_dir: "/tmp/cfg".into(),
            },
        });
        roundtrip(&Request::SendInput {
            sid: "x".into(),
            payload: InputPayload::Text { text: "hello\r".into() },
        });
        roundtrip(&Request::Stop { sid: "x".into(), mode: StopMode::Graceful });
    }

    #[test]
    fn event_kinds_round_trip() {
        roundtrip(&Event::Output {
            sid: "x".into(),
            bytes_b64: "aGk=".into(),
            seq: 5,
        });
        roundtrip(&Event::Hook {
            sid: "x".into(),
            hook: HookFired::Awaiting { reason: Some("blocked on permission".into()) },
        });
    }

    #[test]
    fn hook_unknown_preserves_raw_for_schema_drift() {
        let v = HookFired::Unknown {
            raw_kind: "FutureHook".into(),
            raw_payload: "{\"a\":1}".into(),
        };
        roundtrip(&v);
    }
}
```

- [ ] **Step 3: Run.** `cargo test -p claudette interactive_protocol`. Expected: PASS for all three. Then `cargo clippy -p claudette --all-targets --all-features`. Expected: zero warnings.

- [ ] **Step 4: Commit.**

```bash
git add src/agent/interactive_protocol.rs src/agent/mod.rs
git commit -m "feat(agent): add interactive_protocol wire types"
```

---

### Task B2: Length-prefixed JSON-line framing

**Files:**
- Create: `src/agent/interactive_host/mod.rs` with a `frame` submodule, OR add the framing inside `interactive_protocol.rs`. We will put it in `interactive_protocol::frame` to keep client and server symmetric.

- [ ] **Step 1: Append failing test** to `src/agent/interactive_protocol.rs`:

```rust
#[cfg(test)]
mod frame_tests {
    use super::frame::{read_frame, write_frame};
    use tokio::io::{AsyncReadExt, AsyncWriteExt, duplex};

    #[tokio::test]
    async fn frame_round_trip() {
        let (mut a, mut b) = duplex(64 * 1024);
        write_frame(&mut a, b"{\"hi\":1}").await.unwrap();
        a.shutdown().await.unwrap();
        let buf = read_frame(&mut b).await.unwrap();
        assert_eq!(buf, b"{\"hi\":1}");
    }

    #[tokio::test]
    async fn frame_rejects_oversized() {
        let (mut a, mut b) = duplex(64 * 1024);
        // 100 MB header — must reject without allocating.
        let header = (100u32 * 1024 * 1024).to_be_bytes();
        a.write_all(&header).await.unwrap();
        let err = read_frame(&mut b).await.unwrap_err();
        assert!(err.to_string().contains("frame too large"), "got: {err}");
    }
}
```

- [ ] **Step 2: Run.** `cargo test -p claudette frame_round_trip`. Expected: FAIL (no `frame` module).

- [ ] **Step 3: Implement the frame submodule.** Append to `src/agent/interactive_protocol.rs`:

```rust
pub mod frame {
    use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

    pub const MAX_FRAME: usize = 8 * 1024 * 1024; // 8 MB ceiling.

    pub async fn write_frame<W: AsyncWrite + Unpin>(w: &mut W, payload: &[u8]) -> std::io::Result<()> {
        let len = u32::try_from(payload.len())
            .map_err(|_| std::io::Error::other("frame too large"))?;
        w.write_all(&len.to_be_bytes()).await?;
        w.write_all(payload).await?;
        Ok(())
    }

    pub async fn read_frame<R: AsyncRead + Unpin>(r: &mut R) -> std::io::Result<Vec<u8>> {
        let mut hdr = [0u8; 4];
        r.read_exact(&mut hdr).await?;
        let len = u32::from_be_bytes(hdr) as usize;
        if len > MAX_FRAME {
            return Err(std::io::Error::other("frame too large"));
        }
        let mut buf = vec![0u8; len];
        r.read_exact(&mut buf).await?;
        Ok(buf)
    }
}
```

- [ ] **Step 4: Run.** `cargo test -p claudette frame`. Expected: PASS. Then clippy on the package. Expected: zero warnings.

- [ ] **Step 5: Commit.**

```bash
git add src/agent/interactive_protocol.rs
git commit -m "feat(agent): add length-prefixed JSON-line framing"
```

---

### Task B3: Stub-TUI binary used by integration tests

**Files:**
- Create: `tests/fixtures/stub-tui/Cargo.toml`
- Create: `tests/fixtures/stub-tui/src/main.rs`
- Modify: root `Cargo.toml` (`workspace.members += ["tests/fixtures/stub-tui"]`)

- [ ] **Step 1: Create the manifest.**

```toml
[package]
name = "stub-tui"
version = "0.0.0"
edition = "2024"
publish = false

[dependencies]
```

- [ ] **Step 2: Create `src/main.rs`** — a deterministic line-echo TUI with three behaviors:

```rust
//! Stub TUI used by interactive_host integration tests.
//!
//! Behavior:
//! - Prints `READY\n` on startup so tests can synchronize.
//! - Reads stdin line-by-line. Each line is echoed back as `OUT: <line>\n`.
//! - If `STUB_TUI_FAKE_AWAITING_AFTER` is set to a positive integer N, after
//!   echoing N lines we exit 0 (simulating `Stop` hook) without further output.
//! - If `STUB_TUI_CRASH_AFTER` is set, panic after that many lines.
//! - Line `quit\n` exits 0 immediately.

use std::io::{BufRead, Write};

fn main() {
    let mut stdout = std::io::stdout().lock();
    writeln!(stdout, "READY").unwrap();
    stdout.flush().unwrap();

    let limit: Option<u32> = std::env::var("STUB_TUI_FAKE_AWAITING_AFTER")
        .ok()
        .and_then(|s| s.parse().ok());
    let crash_after: Option<u32> = std::env::var("STUB_TUI_CRASH_AFTER")
        .ok()
        .and_then(|s| s.parse().ok());

    let stdin = std::io::stdin();
    let mut count: u32 = 0;
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line == "quit" {
            return;
        }
        writeln!(stdout, "OUT: {line}").unwrap();
        stdout.flush().unwrap();
        count += 1;
        if let Some(n) = limit {
            if count >= n {
                return;
            }
        }
        if let Some(n) = crash_after {
            if count >= n {
                panic!("stub-tui crashing as instructed");
            }
        }
    }
}
```

- [ ] **Step 3: Register the member** in the workspace `Cargo.toml`. Find the `[workspace]` `members = [ ... ]` array and append `"tests/fixtures/stub-tui"`.

- [ ] **Step 4: Build.** Run: `cargo build -p stub-tui`. Expected: succeeds.

- [ ] **Step 5: Smoke-run the binary.** Run: `echo -e "hi\nbye\nquit" | cargo run -q -p stub-tui`. Expected output:
```
READY
OUT: hi
OUT: bye
```

- [ ] **Step 6: Commit.**

```bash
git add tests/fixtures/stub-tui Cargo.toml
git commit -m "test(agent): add stub-tui fixture for interactive host tests"
```

---

### Task B4: Define `InteractiveHost` trait + shared types

**Files:**
- Create: `src/agent/interactive_host/mod.rs`
- Create: `src/agent/interactive_host/types.rs`
- Modify: `src/agent/mod.rs`

- [ ] **Step 1: Create the types file** `src/agent/interactive_host/types.rs`:

```rust
//! Shared types used by both InteractiveHost implementations.

use serde::{Deserialize, Serialize};

pub use crate::agent::interactive_protocol::{
    HookFired, InputPayload, SessionSpec, StopMode,
};

/// Stable identifier for an interactive session.
///
/// Format: `claudette-<workspace_id_short>-<sid8>`. Identical between tmux and
/// sidecar so a single string identifies the session in any host.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SessionId(pub String);

impl SessionId {
    pub fn new(workspace_short: &str, sid8: &str) -> Self {
        Self(format!("claudette-{workspace_short}-{sid8}"))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Returned from `ensure_session`.
#[derive(Debug, Clone)]
pub struct HostHandle {
    pub sid: SessionId,
    pub pid: Option<u32>,
    pub rows: u16,
    pub cols: u16,
}

/// Identifies a single attach subscription. Multiple attaches per session are
/// allowed; detach uses the attach_id to drop the right one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct AttachId(pub u64);

/// Event yielded by an `AttachStream`.
#[derive(Debug, Clone)]
pub enum AttachEvent {
    Output { bytes: Vec<u8>, seq: u64 },
    Hook(HookFired),
    Exit { exit_status: i32, reason: String },
    Error { message: String, recoverable: bool },
}

/// Snapshot of the current screen for instant repaint on reattach.
#[derive(Debug, Clone)]
pub struct ScreenSnapshot {
    pub rows: u16,
    pub cols: u16,
    pub ansi_bytes: Vec<u8>,
}

/// Host enumeration entry.
#[derive(Debug, Clone)]
pub struct HostSessionSummary {
    pub sid: SessionId,
    pub pid: Option<u32>,
    pub running: bool,
}

#[derive(Debug, Clone)]
pub struct HostStatus {
    pub host_version: String,
    pub sessions: Vec<HostSessionSummary>,
}
```

- [ ] **Step 2: Create the trait** at `src/agent/interactive_host/mod.rs`:

```rust
//! Detachable host abstraction for interactive `claude` sessions.

pub mod availability;
pub mod conformance;
pub mod sidecar;
#[cfg(unix)]
pub mod tmux;
pub mod types;

pub use types::{
    AttachEvent, AttachId, HostHandle, HostSessionSummary, HostStatus, ScreenSnapshot, SessionId,
};
pub use crate::agent::interactive_protocol::{HookFired, InputPayload, SessionSpec, StopMode};

use async_trait::async_trait;
use std::pin::Pin;
use tokio_stream::Stream;

/// Type alias for the live attach stream.
pub type AttachStream = Pin<Box<dyn Stream<Item = AttachEvent> + Send + 'static>>;

#[async_trait]
pub trait InteractiveHost: Send + Sync {
    async fn ensure_session(&self, sid: &SessionId, spec: &SessionSpec) -> Result<HostHandle, HostError>;
    async fn attach(&self, sid: &SessionId) -> Result<(AttachId, AttachStream), HostError>;
    async fn send_input(&self, sid: &SessionId, payload: InputPayload) -> Result<(), HostError>;
    async fn capture_screen(&self, sid: &SessionId) -> Result<ScreenSnapshot, HostError>;
    async fn resize(&self, sid: &SessionId, rows: u16, cols: u16) -> Result<(), HostError>;
    async fn detach(&self, sid: &SessionId, attach_id: AttachId) -> Result<(), HostError>;
    async fn stop(&self, sid: &SessionId, mode: StopMode) -> Result<(), HostError>;
    async fn status(&self) -> Result<HostStatus, HostError>;
}

#[derive(Debug, thiserror::Error)]
pub enum HostError {
    #[error("session not found: {0}")]
    NotFound(String),
    #[error("host unavailable: {0}")]
    Unavailable(String),
    #[error("protocol error: {0}")]
    Protocol(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("other: {0}")]
    Other(String),
}
```

- [ ] **Step 3: Add `pub mod interactive_host;`** to `src/agent/mod.rs` and re-export the trait + main types:

```rust
pub mod interactive_host;
pub use interactive_host::{
    AttachEvent, AttachId, AttachStream, HostError, HostHandle, HostStatus, InteractiveHost,
    ScreenSnapshot, SessionId,
};
```

- [ ] **Step 4: Add deps to root `Cargo.toml`.** If not already present in workspace deps: `async-trait = "0.1"`, `tokio-stream = "0.1"`, `thiserror = "2"` (use the version already pinned elsewhere in the workspace — `grep -n "thiserror" Cargo.toml` first).

- [ ] **Step 5: Build.** Run: `cargo build -p claudette`. Expected: succeeds.

- [ ] **Step 6: Clippy.** Run: `cargo clippy -p claudette --all-targets --all-features`. Expected: zero warnings.

- [ ] **Step 7: Commit.**

```bash
git add src/agent/interactive_host src/agent/mod.rs Cargo.toml
git commit -m "feat(agent): define InteractiveHost trait and shared types"
```

---

### Task B5: Conformance suite skeleton

**Files:**
- Create: `src/agent/interactive_host/conformance.rs`

- [ ] **Step 1: Write the suite skeleton.** Each test is `async` and takes a fresh `Box<dyn InteractiveHost>` + a `SessionSpec` configured to launch the stub TUI:

```rust
//! Conformance suite both InteractiveHost impls must pass.
//!
//! Tests build a host, point it at a stub TUI, and exercise the full lifecycle.
//! Both impls share the same expectations.

use super::{
    AttachEvent, HostError, HostStatus, InteractiveHost, InputPayload, ScreenSnapshot,
    SessionId, SessionSpec, StopMode,
};
use crate::agent::interactive_protocol::HookFired;
use futures::StreamExt;
use std::time::Duration;
use tokio::time::timeout;

pub struct ConformanceFixture {
    pub spec: SessionSpec,
    pub sid: SessionId,
}

/// Run the full conformance suite against `host`.
pub async fn run<H: InteractiveHost>(host: &H, fx: &ConformanceFixture) {
    ensure_session_is_idempotent(host, fx).await;
    send_then_capture_returns_bytes(host, fx).await;
    multiple_attaches_each_receive_events(host, fx).await;
    detach_does_not_kill_session(host, fx).await;
    stop_graceful_yields_exit_event(host, fx).await;
    status_lists_only_running_sessions(host, fx).await;
}

async fn ensure_session_is_idempotent<H: InteractiveHost>(host: &H, fx: &ConformanceFixture) {
    let h1 = host.ensure_session(&fx.sid, &fx.spec).await.expect("ensure 1");
    let h2 = host.ensure_session(&fx.sid, &fx.spec).await.expect("ensure 2");
    assert_eq!(h1.sid, h2.sid);
}

async fn send_then_capture_returns_bytes<H: InteractiveHost>(host: &H, fx: &ConformanceFixture) {
    let _ = host.ensure_session(&fx.sid, &fx.spec).await.unwrap();
    let (_attach_id, mut stream) = host.attach(&fx.sid).await.unwrap();
    host.send_input(&fx.sid, InputPayload::Text { text: "hello\n".into() })
        .await
        .unwrap();
    let mut got = Vec::<u8>::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    while tokio::time::Instant::now() < deadline {
        match timeout(Duration::from_millis(200), stream.next()).await {
            Ok(Some(AttachEvent::Output { bytes, .. })) => got.extend_from_slice(&bytes),
            Ok(Some(_)) => {}
            Ok(None) => break,
            Err(_) => {}
        }
        if String::from_utf8_lossy(&got).contains("OUT: hello") {
            break;
        }
    }
    assert!(
        String::from_utf8_lossy(&got).contains("OUT: hello"),
        "did not see echoed line in stream: {:?}",
        String::from_utf8_lossy(&got)
    );
    let snap: ScreenSnapshot = host.capture_screen(&fx.sid).await.unwrap();
    assert!(snap.rows >= 1 && snap.cols >= 1);
}

async fn multiple_attaches_each_receive_events<H: InteractiveHost>(host: &H, fx: &ConformanceFixture) {
    let _ = host.ensure_session(&fx.sid, &fx.spec).await.unwrap();
    let (_a1, mut s1) = host.attach(&fx.sid).await.unwrap();
    let (_a2, mut s2) = host.attach(&fx.sid).await.unwrap();
    host.send_input(&fx.sid, InputPayload::Text { text: "ping\n".into() })
        .await
        .unwrap();
    let s1_seen = drain_until_contains(&mut s1, "OUT: ping", Duration::from_secs(3)).await;
    let s2_seen = drain_until_contains(&mut s2, "OUT: ping", Duration::from_secs(3)).await;
    assert!(s1_seen, "first attach missed ping");
    assert!(s2_seen, "second attach missed ping");
}

async fn detach_does_not_kill_session<H: InteractiveHost>(host: &H, fx: &ConformanceFixture) {
    let _ = host.ensure_session(&fx.sid, &fx.spec).await.unwrap();
    let (attach_id, _stream) = host.attach(&fx.sid).await.unwrap();
    host.detach(&fx.sid, attach_id).await.unwrap();
    // Session must still be enumerable as running.
    let st = host.status().await.unwrap();
    assert!(
        st.sessions.iter().any(|s| s.sid == fx.sid && s.running),
        "session vanished after detach"
    );
}

async fn stop_graceful_yields_exit_event<H: InteractiveHost>(host: &H, fx: &ConformanceFixture) {
    let _ = host.ensure_session(&fx.sid, &fx.spec).await.unwrap();
    let (_attach_id, mut stream) = host.attach(&fx.sid).await.unwrap();
    host.stop(&fx.sid, StopMode::Graceful).await.unwrap();
    let mut got_exit = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while tokio::time::Instant::now() < deadline {
        match timeout(Duration::from_millis(200), stream.next()).await {
            Ok(Some(AttachEvent::Exit { .. })) => {
                got_exit = true;
                break;
            }
            Ok(Some(_)) => {}
            Ok(None) => break,
            Err(_) => {}
        }
    }
    assert!(got_exit, "no exit event after stop");
}

async fn status_lists_only_running_sessions<H: InteractiveHost>(host: &H, _fx: &ConformanceFixture) {
    let st: HostStatus = host.status().await.unwrap();
    // After stop in the previous test, our session should be gone.
    assert!(!st.sessions.iter().any(|s| s.running && s.sid.as_str().contains("claudette-")));
}

async fn drain_until_contains<S>(stream: &mut S, needle: &str, total: Duration) -> bool
where
    S: futures::Stream<Item = AttachEvent> + Unpin,
{
    use futures::StreamExt;
    let mut buf = Vec::<u8>::new();
    let deadline = tokio::time::Instant::now() + total;
    while tokio::time::Instant::now() < deadline {
        match timeout(Duration::from_millis(200), stream.next()).await {
            Ok(Some(AttachEvent::Output { bytes, .. })) => buf.extend_from_slice(&bytes),
            Ok(Some(_)) => {}
            Ok(None) => return String::from_utf8_lossy(&buf).contains(needle),
            Err(_) => {}
        }
        if String::from_utf8_lossy(&buf).contains(needle) {
            return true;
        }
    }
    String::from_utf8_lossy(&buf).contains(needle)
}
```

- [ ] **Step 2: Add dev-deps** `futures = "0.3"` to the workspace dev-deps if not already present (`grep -n "futures" Cargo.toml`).

- [ ] **Step 3: Build.** Run: `cargo build -p claudette`. Expected: succeeds (the suite compiles even though no impl exists yet — it's parameterised).

- [ ] **Step 4: Commit.**

```bash
git add src/agent/interactive_host/conformance.rs Cargo.toml
git commit -m "test(agent): add InteractiveHost conformance suite skeleton"
```

---

### Task B6: Availability check (tmux + sidecar) with 30s TTL cache

**Files:**
- Create: `src/agent/interactive_host/availability.rs`

- [ ] **Step 1: Write failing tests** in the same file (this single test is enough — caching is exercised by it):

```rust
//! Availability checks for the supported interactive hosts.
//!
//! These checks cache their result for 30 seconds to avoid shelling out on
//! every operation.

use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TmuxAvailability {
    /// tmux >= 3.0 found on PATH.
    Available { version: String },
    /// tmux found but too old.
    TooOld { version: String, minimum: String },
    /// tmux not on PATH.
    NotFound,
}

const TTL: Duration = Duration::from_secs(30);

struct CachedTmux {
    at: Instant,
    value: TmuxAvailability,
}

static TMUX_CACHE: Mutex<Option<CachedTmux>> = Mutex::new(None);

pub async fn check_tmux() -> TmuxAvailability {
    {
        let g = TMUX_CACHE.lock().expect("poisoned");
        if let Some(c) = g.as_ref() {
            if c.at.elapsed() < TTL {
                return c.value.clone();
            }
        }
    }
    let v = check_tmux_uncached().await;
    let mut g = TMUX_CACHE.lock().expect("poisoned");
    *g = Some(CachedTmux { at: Instant::now(), value: v.clone() });
    v
}

async fn check_tmux_uncached() -> TmuxAvailability {
    let out = tokio::process::Command::new("tmux").arg("-V").output().await;
    let Ok(out) = out else { return TmuxAvailability::NotFound };
    if !out.status.success() {
        return TmuxAvailability::NotFound;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    // tmux -V prints e.g. "tmux 3.4"
    let ver = s.trim().split_whitespace().nth(1).unwrap_or("").to_string();
    if version_at_least(&ver, 3, 0) {
        TmuxAvailability::Available { version: ver }
    } else {
        TmuxAvailability::TooOld {
            version: ver,
            minimum: "3.0".into(),
        }
    }
}

fn version_at_least(ver: &str, want_major: u32, want_minor: u32) -> bool {
    let mut parts = ver.split('.');
    let major = parts.next().and_then(|p| p.parse::<u32>().ok()).unwrap_or(0);
    let minor = parts
        .next()
        .and_then(|p| p.trim_end_matches(|c: char| !c.is_ascii_digit()).parse::<u32>().ok())
        .unwrap_or(0);
    (major, minor) >= (want_major, want_minor)
}

/// Clear the tmux cache (test-only helper).
#[cfg(test)]
pub fn clear_tmux_cache_for_test() {
    *TMUX_CACHE.lock().unwrap() = None;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_at_least_examples() {
        assert!(version_at_least("3.4", 3, 0));
        assert!(version_at_least("3.0", 3, 0));
        assert!(!version_at_least("2.9", 3, 0));
        assert!(!version_at_least("", 3, 0));
        assert!(version_at_least("3.4a", 3, 0));
    }

    #[tokio::test]
    async fn check_tmux_cache_is_stable_within_ttl() {
        clear_tmux_cache_for_test();
        let a = check_tmux().await;
        let b = check_tmux().await;
        assert_eq!(a, b);
    }
}
```

- [ ] **Step 2: Run.** `cargo test -p claudette interactive_host::availability`. Expected: PASS.

- [ ] **Step 3: Clippy.** `cargo clippy -p claudette --all-targets --all-features`. Expected: zero warnings.

- [ ] **Step 4: Commit.**

```bash
git add src/agent/interactive_host/availability.rs
git commit -m "feat(agent): add tmux availability check with TTL cache"
```

---

## Phase C — `claudette-session-host` sidecar crate

### Task C1: Crate skeleton

**Files:**
- Create: `src-session-host/Cargo.toml`
- Create: `src-session-host/src/main.rs`
- Modify: root `Cargo.toml` (add member, add `claudette-session-host` to deps section if used elsewhere)

- [ ] **Step 1: Manifest.**

```toml
[package]
name = "claudette-session-host"
version.workspace = true
edition.workspace = true
license.workspace = true

[[bin]]
name = "claudette-session-host"
path = "src/main.rs"

[dependencies]
claudette = { path = "..", default-features = false }
tokio = { workspace = true, features = ["full"] }
interprocess = { workspace = true }
serde = { workspace = true, features = ["derive"] }
serde_json = { workspace = true }
tracing = { workspace = true }
tracing-subscriber = { workspace = true }
portable-pty = { workspace = true }
alacritty_terminal = { workspace = true }
base64 = { workspace = true }
async-trait = { workspace = true }
thiserror = { workspace = true }
futures = { workspace = true }
tokio-stream = { workspace = true }

[dev-dependencies]
tempfile = { workspace = true }
```

If any of those workspace deps aren't present in the root `Cargo.toml`, add them (`grep -n "alacritty_terminal\|interprocess\|portable-pty\|base64" Cargo.toml`). Pick versions consistent with what `claudette` already uses.

- [ ] **Step 2: Hello-world `main.rs`.**

```rust
//! The Claudette interactive-Claude session host.
//!
//! Long-lived sidecar process. Owns claude PTYs. Exposes a JSON-line local
//! socket protocol (Unix-domain socket / Named Pipe). See
//! `claudette::agent::interactive_protocol`.

fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt().with_env_filter("info").init();
    tracing::info!("claudette-session-host {} starting", env!("CARGO_PKG_VERSION"));
    // Stub: just exit. Real server logic comes in Task C2+.
    Ok(())
}
```

- [ ] **Step 3: Register the member.** Add `"src-session-host"` to the workspace `members` array in the root `Cargo.toml`.

- [ ] **Step 4: Build.** Run: `cargo build -p claudette-session-host`. Expected: succeeds.

- [ ] **Step 5: Run it.** Run: `cargo run -q -p claudette-session-host`. Expected: prints the `INFO claudette-session-host …` line then exits 0.

- [ ] **Step 6: Commit.**

```bash
git add src-session-host Cargo.toml
git commit -m "feat(session-host): scaffold claudette-session-host crate"
```

---

### Task C2: Local-socket listener with handshake

**Files:**
- Create: `src-session-host/src/server.rs`
- Modify: `src-session-host/src/main.rs`

- [ ] **Step 1: Determine the socket path scheme.** Use this module-level helper (paste into `server.rs`):

```rust
//! Local-socket server for the session host.
//!
//! Listens on a per-user path:
//!   Unix:    $TMPDIR/claudette-session-host/<user>.sock
//!   Windows: \\.\pipe\claudette-session-host-<user>

use interprocess::local_socket::{
    GenericFilePath, GenericNamespaced, ListenerOptions, Stream, ToFsName, ToNsName, prelude::*,
    tokio::Listener,
};
use std::path::PathBuf;

pub fn default_socket_path() -> PathBuf {
    let user = whoami::username();
    #[cfg(unix)]
    {
        let base = std::env::var("TMPDIR").unwrap_or_else(|_| "/tmp".into());
        let dir = PathBuf::from(base).join("claudette-session-host");
        let _ = std::fs::create_dir_all(&dir);
        dir.join(format!("{user}.sock"))
    }
    #[cfg(windows)]
    {
        PathBuf::from(format!(r"\\.\pipe\claudette-session-host-{user}"))
    }
}
```

Add `whoami = "1"` to the session-host crate's deps (and workspace deps if not present).

- [ ] **Step 2: Write a failing integration test.** Create `tests/handshake.rs` in the session-host crate (`src-session-host/tests/handshake.rs`):

```rust
use claudette::agent::interactive_protocol::{frame, Request, Response, PROTOCOL_VERSION};
use interprocess::local_socket::{ToFsName, prelude::*, tokio::Stream};

#[tokio::test]
async fn handshake_round_trip() {
    let socket_path = std::env::temp_dir().join(format!(
        "claudette-handshake-test-{}.sock",
        std::process::id()
    ));
    let _ = std::fs::remove_file(&socket_path);
    let server = tokio::spawn({
        let sp = socket_path.clone();
        async move { claudette_session_host::server::run_for_test(&sp).await.unwrap() }
    });
    // Give the listener time to bind.
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    let name = socket_path.as_path().to_fs_name::<interprocess::local_socket::GenericFilePath>().unwrap();
    let mut s = Stream::connect(name).await.unwrap();
    let req = serde_json::to_vec(&Request::Hello {
        protocol_version: PROTOCOL_VERSION,
        claudette_version: "test".into(),
    })
    .unwrap();
    let (mut r, mut w) = s.split();
    frame::write_frame(&mut w, &req).await.unwrap();
    let resp_bytes = frame::read_frame(&mut r).await.unwrap();
    let resp: Response = serde_json::from_slice(&resp_bytes).unwrap();
    match resp {
        Response::HelloAck { protocol_version, .. } => assert_eq!(protocol_version, PROTOCOL_VERSION),
        other => panic!("expected HelloAck, got {other:?}"),
    }
    server.abort();
}
```

- [ ] **Step 3: Make the crate a lib too** so the test can call into it. In `src-session-host/Cargo.toml` add:

```toml
[lib]
name = "claudette_session_host"
path = "src/lib.rs"
```

Create `src-session-host/src/lib.rs`:

```rust
pub mod server;
pub mod session;
pub mod idle;
```

- [ ] **Step 4: Run test.** `cargo test -p claudette-session-host --test handshake -- --nocapture`. Expected: FAIL (no `server::run_for_test`).

- [ ] **Step 5: Implement the server.** Append to `src-session-host/src/server.rs`:

```rust
use claudette::agent::interactive_protocol::{
    frame::{read_frame, write_frame},
    Event, Request, Response, PROTOCOL_VERSION,
};
use std::path::Path;
use tokio::io::AsyncWriteExt;

pub async fn run_for_test(socket_path: &Path) -> std::io::Result<()> {
    run_at(socket_path).await
}

pub async fn run_at(socket_path: &Path) -> std::io::Result<()> {
    let name = socket_path.to_fs_name::<GenericFilePath>()?;
    let listener = ListenerOptions::new().name(name).create_tokio()?;
    loop {
        let stream = match listener.accept().await {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!(?e, "accept failed");
                continue;
            }
        };
        tokio::spawn(async move {
            if let Err(e) = handle_connection(stream).await {
                tracing::warn!(?e, "connection ended with error");
            }
        });
    }
}

async fn handle_connection(stream: Stream) -> std::io::Result<()> {
    let (mut r, mut w) = stream.split();
    // First frame must be Hello.
    let first = read_frame(&mut r).await?;
    let req: Request = serde_json::from_slice(&first).map_err(std::io::Error::other)?;
    let Request::Hello { protocol_version, .. } = req else {
        let bad = Response::Error {
            message: "first frame was not Hello".into(),
            recoverable: false,
        };
        write_frame(&mut w, &serde_json::to_vec(&bad).unwrap()).await?;
        return Ok(());
    };
    let resp = if protocol_version == PROTOCOL_VERSION {
        Response::HelloAck {
            protocol_version: PROTOCOL_VERSION,
            host_version: env!("CARGO_PKG_VERSION").to_string(),
            pid: std::process::id(),
        }
    } else {
        Response::HelloNack {
            reason: format!("unsupported protocol_version {protocol_version}"),
            supported_versions: vec![PROTOCOL_VERSION],
        }
    };
    write_frame(&mut w, &serde_json::to_vec(&resp).unwrap()).await?;
    Ok(())
}
```

- [ ] **Step 6: Update `main.rs`** to call `server::run_at(&server::default_socket_path()).await?;` and use `#[tokio::main]`.

- [ ] **Step 7: Run the test.** `cargo test -p claudette-session-host --test handshake -- --nocapture`. Expected: PASS.

- [ ] **Step 8: Clippy.** `cargo clippy -p claudette-session-host --all-targets --all-features`. Expected: zero warnings.

- [ ] **Step 9: Commit.**

```bash
git add src-session-host
git commit -m "feat(session-host): accept connections and answer Hello handshake"
```

---

### Task C3: Per-session PTY actor (ensure_session + status)

**Files:**
- Create: `src-session-host/src/session.rs`
- Modify: `src-session-host/src/server.rs`

- [ ] **Step 1: Write a failing integration test** at `src-session-host/tests/ensure_session.rs`:

```rust
use claudette::agent::interactive_protocol::{frame, Request, Response, SessionSpec, PROTOCOL_VERSION};
use interprocess::local_socket::{ToFsName, prelude::*, tokio::Stream};
use std::path::PathBuf;

fn stub_tui_binary() -> PathBuf {
    // Set by cargo for any workspace test that has stub-tui as a build target.
    PathBuf::from(env!("CARGO_BIN_EXE_stub-tui"))
}

#[tokio::test]
async fn ensure_session_starts_and_status_lists_it() {
    let socket = std::env::temp_dir().join(format!("ess-test-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&socket);
    let server = tokio::spawn({
        let sp = socket.clone();
        async move { claudette_session_host::server::run_for_test(&sp).await.unwrap() }
    });
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;

    let mut conn = open_conn(&socket).await;
    send(&mut conn, &Request::Hello { protocol_version: PROTOCOL_VERSION, claudette_version: "t".into() }).await;
    expect_helloack(&mut conn).await;

    send(&mut conn, &Request::EnsureSession {
        sid: "claudette-test-aaaaaaaa".into(),
        spec: SessionSpec {
            working_dir: std::env::temp_dir().to_string_lossy().into(),
            rows: 24,
            cols: 80,
            claude_binary: stub_tui_binary().to_string_lossy().into(),
            claude_args: vec![],
            env: vec![],
            claude_config_dir: std::env::temp_dir().to_string_lossy().into(),
        },
    }).await;
    let resp = recv(&mut conn).await;
    match resp {
        Response::SessionStarted { sid, .. } => assert_eq!(sid, "claudette-test-aaaaaaaa"),
        other => panic!("expected SessionStarted, got {other:?}"),
    }

    send(&mut conn, &Request::Status).await;
    let st = recv(&mut conn).await;
    match st {
        Response::Status { sessions, .. } => {
            assert!(sessions.iter().any(|s| s.sid == "claudette-test-aaaaaaaa" && s.running));
        }
        other => panic!("expected Status, got {other:?}"),
    }
    server.abort();
}

// Helpers
async fn open_conn(path: &std::path::Path) -> Stream {
    Stream::connect(path.to_fs_name::<interprocess::local_socket::GenericFilePath>().unwrap()).await.unwrap()
}
async fn send(s: &mut Stream, req: &Request) {
    let bytes = serde_json::to_vec(req).unwrap();
    let (_r, mut w) = s.split();
    frame::write_frame(&mut w, &bytes).await.unwrap();
}
async fn recv(s: &mut Stream) -> Response {
    let (mut r, _w) = s.split();
    let buf = frame::read_frame(&mut r).await.unwrap();
    serde_json::from_slice(&buf).unwrap()
}
async fn expect_helloack(s: &mut Stream) {
    match recv(s).await {
        Response::HelloAck { .. } => {}
        other => panic!("expected HelloAck, got {other:?}"),
    }
}
```

Note: `CARGO_BIN_EXE_stub-tui` requires the test to declare `stub-tui` as a dep. Add to `src-session-host/Cargo.toml`:

```toml
[dev-dependencies]
stub-tui = { path = "../tests/fixtures/stub-tui", artifact = "bin:stub-tui" }
```

If the artifact-deps feature isn't available, use the alternative: spawn `stub-tui` by absolute path discovered via `cargo metadata` — but artifact deps are stable on Rust edition 2024 and the workspace pins ≥ 1.94 per `mise.toml`.

- [ ] **Step 2: Run test.** `cargo test -p claudette-session-host --test ensure_session -- --nocapture`. Expected: FAIL (server doesn't handle `EnsureSession`).

- [ ] **Step 3: Implement `session.rs`** — a per-session actor that owns a `PtyPair` from `portable-pty`:

```rust
use claudette::agent::interactive_protocol::{HookFired, InputPayload, SessionSpec};
use portable_pty::{CommandBuilder, NativePtySystem, PtyPair, PtySize, PtySystem};
use std::sync::Arc;
use tokio::sync::{Mutex, broadcast};
use tracing::{info, warn};

#[derive(Debug, Clone)]
pub enum SessionEvent {
    Output { bytes: Vec<u8>, seq: u64 },
    Hook(HookFired),
    Exit { exit_status: i32, reason: String },
}

pub struct Session {
    pub sid: String,
    pub pid: Option<u32>,
    pub rows: Mutex<u16>,
    pub cols: Mutex<u16>,
    /// Broadcast channel for live attaches.
    pub tx: broadcast::Sender<SessionEvent>,
    pty: Mutex<Option<PtyPair>>,
    writer: Mutex<Option<Box<dyn std::io::Write + Send>>>,
    /// Last screen replay bytes (capped). Used by capture_screen.
    pub screen: Arc<Mutex<Vec<u8>>>,
    pub running: Arc<std::sync::atomic::AtomicBool>,
}

impl Session {
    pub async fn spawn(sid: String, spec: SessionSpec) -> std::io::Result<Arc<Self>> {
        let pty_system = NativePtySystem::default();
        let pair = pty_system
            .openpty(PtySize { rows: spec.rows, cols: spec.cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        let mut cmd = CommandBuilder::new(&spec.claude_binary);
        for arg in &spec.claude_args { cmd.arg(arg); }
        for (k, v) in &spec.env { cmd.env(k, v); }
        cmd.env("CLAUDE_CONFIG_DIR", &spec.claude_config_dir);
        cmd.cwd(&spec.working_dir);
        let mut child = pair.slave.spawn_command(cmd)
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        let pid = child.process_id();
        let writer = pair.master.take_writer()
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        let mut reader = pair.master.try_clone_reader()
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        let (tx, _) = broadcast::channel(2048);
        let running = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let session = Arc::new(Self {
            sid: sid.clone(),
            pid,
            rows: Mutex::new(spec.rows),
            cols: Mutex::new(spec.cols),
            tx: tx.clone(),
            pty: Mutex::new(Some(pair)),
            writer: Mutex::new(Some(writer)),
            screen: Arc::new(Mutex::new(Vec::new())),
            running: running.clone(),
        });

        // Reader task: pumps PTY output to broadcast + screen blob.
        let screen = session.screen.clone();
        let tx_reader = tx.clone();
        let running_reader = running.clone();
        tokio::task::spawn_blocking(move || {
            let mut buf = [0u8; 8192];
            let mut seq: u64 = 0;
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        seq += 1;
                        let bytes = buf[..n].to_vec();
                        // Capture into screen, cap at 256 KB.
                        {
                            let mut s = screen.blocking_lock();
                            s.extend_from_slice(&bytes);
                            let max = 256 * 1024;
                            if s.len() > max {
                                let drop_to = s.len() - max;
                                s.drain(..drop_to);
                            }
                        }
                        let _ = tx_reader.send(SessionEvent::Output { bytes, seq });
                    }
                }
            }
            running_reader.store(false, std::sync::atomic::Ordering::SeqCst);
        });

        // Waiter task: reaps child + emits Exit.
        let tx_exit = tx.clone();
        tokio::task::spawn_blocking(move || {
            match child.wait() {
                Ok(status) => {
                    let code = status.exit_code() as i32;
                    let _ = tx_exit.send(SessionEvent::Exit {
                        exit_status: code,
                        reason: format!("child exited with {code}"),
                    });
                }
                Err(e) => {
                    let _ = tx_exit.send(SessionEvent::Exit {
                        exit_status: -1,
                        reason: format!("wait failed: {e}"),
                    });
                }
            }
        });

        info!(%sid, ?pid, "session spawned");
        Ok(session)
    }

    pub async fn send_input(&self, payload: InputPayload) -> std::io::Result<()> {
        let bytes = match payload {
            InputPayload::Text { text } => text.into_bytes(),
            InputPayload::Bytes { bytes_b64 } => {
                use base64::Engine as _;
                base64::engine::general_purpose::STANDARD
                    .decode(bytes_b64)
                    .map_err(std::io::Error::other)?
            }
            InputPayload::Keys { name } => key_bytes(&name),
        };
        let mut w = self.writer.lock().await;
        let Some(writer) = w.as_mut() else { return Err(std::io::Error::other("session closed")) };
        writer.write_all(&bytes)?;
        writer.flush()?;
        Ok(())
    }

    pub async fn resize(&self, rows: u16, cols: u16) -> std::io::Result<()> {
        let pty = self.pty.lock().await;
        let Some(pair) = pty.as_ref() else { return Err(std::io::Error::other("session closed")) };
        pair.master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        *self.rows.lock().await = rows;
        *self.cols.lock().await = cols;
        Ok(())
    }

    pub async fn stop_graceful(&self) {
        // Send Ctrl+C first. Real wait/kill done by the server task.
        let _ = self.send_input(InputPayload::Keys { name: "C-c".into() }).await;
    }

    pub async fn capture_screen(&self) -> Vec<u8> {
        self.screen.lock().await.clone()
    }
}

fn key_bytes(name: &str) -> Vec<u8> {
    match name {
        "Enter" => vec![b'\r'],
        "Tab" => vec![b'\t'],
        "Backspace" => vec![0x7f],
        "Escape" => vec![0x1b],
        "C-c" => vec![0x03],
        "C-d" => vec![0x04],
        // Strict matcher — unknown keys yield no bytes. Tests assert on this.
        _ => Vec::new(),
    }
}
```

- [ ] **Step 4: Extend the server** to handle `EnsureSession`, `Status`, `SendInput`, `Stop`. Replace `handle_connection` with a dispatch loop after handshake. Use a per-server `SessionMap` (paste into `server.rs` above `handle_connection`):

```rust
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use crate::session::{Session, SessionEvent};

pub type SessionMap = Arc<Mutex<HashMap<String, Arc<Session>>>>;

pub fn new_session_map() -> SessionMap {
    Arc::new(Mutex::new(HashMap::new()))
}

pub async fn run_at_with(map: SessionMap, socket_path: &Path) -> std::io::Result<()> {
    let name = socket_path.to_fs_name::<GenericFilePath>()?;
    let listener = ListenerOptions::new().name(name).create_tokio()?;
    loop {
        let stream = listener.accept().await?;
        let m = map.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_connection(stream, m).await {
                tracing::warn!(?e, "connection ended with error");
            }
        });
    }
}

pub async fn run_for_test(socket_path: &Path) -> std::io::Result<()> {
    run_at_with(new_session_map(), socket_path).await
}
```

Then update `handle_connection`:

```rust
async fn handle_connection(stream: Stream, map: SessionMap) -> std::io::Result<()> {
    let (mut r, mut w) = stream.split();
    // Handshake (unchanged) ... then:
    loop {
        let frame_bytes = match read_frame(&mut r).await {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(()),
            Err(e) => return Err(e),
        };
        let req: Request = match serde_json::from_slice(&frame_bytes) {
            Ok(v) => v,
            Err(e) => {
                let r = Response::Error { message: format!("bad request: {e}"), recoverable: false };
                write_frame(&mut w, &serde_json::to_vec(&r).unwrap()).await?;
                continue;
            }
        };
        let resp = dispatch(&map, req).await;
        write_frame(&mut w, &serde_json::to_vec(&resp).unwrap()).await?;
    }
}

async fn dispatch(map: &SessionMap, req: Request) -> Response {
    match req {
        Request::Hello { .. } => Response::Error {
            message: "Hello received after handshake".into(),
            recoverable: true,
        },
        Request::EnsureSession { sid, spec } => {
            let mut m = map.lock().await;
            if let Some(s) = m.get(&sid) {
                return Response::SessionStarted {
                    sid: s.sid.clone(),
                    pid: s.pid.unwrap_or(0),
                    rows: *s.rows.lock().await,
                    cols: *s.cols.lock().await,
                };
            }
            match Session::spawn(sid.clone(), spec).await {
                Ok(s) => {
                    m.insert(sid.clone(), s.clone());
                    Response::SessionStarted { sid, pid: s.pid.unwrap_or(0), rows: *s.rows.lock().await, cols: *s.cols.lock().await }
                }
                Err(e) => Response::Error { message: e.to_string(), recoverable: false },
            }
        }
        Request::Status => {
            let m = map.lock().await;
            let sessions = m.values().map(|s| crate::SessionSummary {
                sid: s.sid.clone(),
                pid: s.pid,
                running: s.running.load(std::sync::atomic::Ordering::SeqCst),
            }).collect::<Vec<_>>();
            Response::Status {
                host_version: env!("CARGO_PKG_VERSION").into(),
                sessions,
            }
        }
        Request::SendInput { sid, payload } => {
            let m = map.lock().await;
            let Some(s) = m.get(&sid).cloned() else {
                return Response::Error { message: format!("not found: {sid}"), recoverable: true };
            };
            drop(m);
            match s.send_input(payload).await {
                Ok(()) => Response::Ok,
                Err(e) => Response::Error { message: e.to_string(), recoverable: true },
            }
        }
        Request::Stop { sid, mode } => {
            let mut m = map.lock().await;
            let Some(s) = m.remove(&sid) else {
                return Response::Error { message: format!("not found: {sid}"), recoverable: true };
            };
            match mode {
                claudette::agent::interactive_protocol::StopMode::Graceful => s.stop_graceful().await,
                claudette::agent::interactive_protocol::StopMode::Force => {} // master drop kills below
            }
            // Dropping pty pair kills the child.
            drop(s);
            Response::Stopped { exit_status: 0 }
        }
        // Resize / Detach / CaptureScreen / Attach come in later tasks.
        Request::Resize { .. } | Request::Detach { .. } | Request::CaptureScreen { .. } | Request::Attach { .. } => {
            Response::Error { message: "not yet implemented".into(), recoverable: false }
        }
    }
}
```

Re-export `SessionSummary` in the lib so the server can use it from the shared protocol. Update `src-session-host/src/lib.rs`:

```rust
pub mod server;
pub mod session;
pub mod idle;
pub use claudette::agent::interactive_protocol::SessionSummary;
```

- [ ] **Step 5: Run.** `cargo test -p claudette-session-host --test ensure_session -- --nocapture`. Expected: PASS. Also re-run `cargo test -p claudette-session-host --test handshake`. Expected: still PASS.

- [ ] **Step 6: Clippy.** `cargo clippy -p claudette-session-host --all-targets --all-features`. Expected: zero warnings.

- [ ] **Step 7: Commit.**

```bash
git add src-session-host
git commit -m "feat(session-host): EnsureSession + Status + SendInput + Stop"
```

---

### Task C4: Attach streaming + Detach + CaptureScreen + Resize

**Files:**
- Modify: `src-session-host/src/server.rs`
- Modify: `src-session-host/src/session.rs`

- [ ] **Step 1: Write a failing test** at `src-session-host/tests/attach_stream.rs`. Duplicate the connection helpers from `ensure_session.rs` (test-file duplication is fine):

```rust
use base64::Engine as _;
use claudette::agent::interactive_protocol::{
    frame, Event, InputPayload, Request, Response, SessionSpec, PROTOCOL_VERSION,
};
use interprocess::local_socket::{ToFsName, prelude::*, tokio::Stream};
use std::path::PathBuf;
use std::time::Duration;

fn stub_tui_binary() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_stub-tui"))
}

#[tokio::test]
async fn attach_streams_echoed_output() {
    let socket = std::env::temp_dir().join(format!("attach-test-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&socket);
    let server = tokio::spawn({
        let sp = socket.clone();
        async move { claudette_session_host::server::run_for_test(&sp).await.unwrap() }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;

    // Connection 1: control (ensure + send input).
    let mut ctrl = open_conn(&socket).await;
    handshake(&mut ctrl).await;
    let sid = "claudette-attach-aaaaaaaa".to_string();
    send_req(&mut ctrl, &Request::EnsureSession {
        sid: sid.clone(),
        spec: SessionSpec {
            working_dir: std::env::temp_dir().to_string_lossy().into(),
            rows: 24,
            cols: 80,
            claude_binary: stub_tui_binary().to_string_lossy().into(),
            claude_args: vec![],
            env: vec![],
            claude_config_dir: std::env::temp_dir().to_string_lossy().into(),
        },
    }).await;
    expect_session_started(&mut ctrl, &sid).await;

    // Connection 2: attach.
    let mut att = open_conn(&socket).await;
    handshake(&mut att).await;
    send_req(&mut att, &Request::Attach { sid: sid.clone() }).await;
    match recv_resp(&mut att).await {
        Response::AttachStarted { attach_id } => assert!(attach_id > 0),
        other => panic!("expected AttachStarted, got {other:?}"),
    }

    // Drain stub-tui's `READY\n` first.
    drain_until_contains(&mut att, "READY", Duration::from_secs(2)).await;

    // Send input on control connection.
    send_req(&mut ctrl, &Request::SendInput {
        sid: sid.clone(),
        payload: InputPayload::Text { text: "hello\n".into() },
    }).await;
    let resp = recv_resp(&mut ctrl).await;
    assert!(matches!(resp, Response::Ok), "expected Ok, got {resp:?}");

    // Drain attach until we see the echo.
    let seen = drain_until_contains(&mut att, "OUT: hello", Duration::from_secs(3)).await;
    assert!(seen, "did not observe echoed line on attach stream");

    server.abort();
}

async fn open_conn(p: &std::path::Path) -> Stream {
    Stream::connect(p.to_fs_name::<interprocess::local_socket::GenericFilePath>().unwrap()).await.unwrap()
}
async fn handshake(s: &mut Stream) {
    send_req(s, &Request::Hello { protocol_version: PROTOCOL_VERSION, claudette_version: "t".into() }).await;
    match recv_resp(s).await {
        Response::HelloAck { .. } => {}
        other => panic!("expected HelloAck, got {other:?}"),
    }
}
async fn send_req(s: &mut Stream, r: &Request) {
    let bytes = serde_json::to_vec(r).unwrap();
    let (_r, mut w) = s.split();
    frame::write_frame(&mut w, &bytes).await.unwrap();
}
async fn recv_resp(s: &mut Stream) -> Response {
    let (mut r, _w) = s.split();
    let buf = frame::read_frame(&mut r).await.unwrap();
    serde_json::from_slice(&buf).unwrap()
}
async fn expect_session_started(s: &mut Stream, expected_sid: &str) {
    match recv_resp(s).await {
        Response::SessionStarted { sid, .. } => assert_eq!(sid, expected_sid),
        other => panic!("expected SessionStarted, got {other:?}"),
    }
}
async fn drain_until_contains(s: &mut Stream, needle: &str, total: Duration) -> bool {
    let (mut r, _w) = s.split();
    let mut buf = Vec::<u8>::new();
    let deadline = tokio::time::Instant::now() + total;
    while tokio::time::Instant::now() < deadline {
        let frame_res = tokio::time::timeout(
            Duration::from_millis(200),
            frame::read_frame(&mut r),
        ).await;
        let Ok(Ok(bytes)) = frame_res else { continue };
        let ev: Event = match serde_json::from_slice(&bytes) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if let Event::Output { bytes_b64, .. } = ev {
            let decoded = base64::engine::general_purpose::STANDARD.decode(bytes_b64).unwrap_or_default();
            buf.extend_from_slice(&decoded);
            if String::from_utf8_lossy(&buf).contains(needle) {
                return true;
            }
        }
    }
    String::from_utf8_lossy(&buf).contains(needle)
}
```

- [ ] **Step 2: Run.** Expected: FAIL.

- [ ] **Step 3: Implement Attach.** In `dispatch`, add:

```rust
Request::Attach { sid } => {
    // dispatch returns Response::Error here to keep the request/response shape
    // sane, but actual attach output is interleaved on the same connection.
    // We treat the Attach response specially in handle_connection by
    // returning a marker — implementation below.
    Response::Error { message: "INTERNAL_ATTACH_MARKER".into(), recoverable: false }
}
```

This is a bit ugly because attach streams. Cleaner: handle Attach **inside** `handle_connection` directly (don't go through `dispatch`). Move the Attach branch:

```rust
async fn handle_connection(stream: Stream, map: SessionMap) -> std::io::Result<()> {
    let (mut r, mut w) = stream.split();
    // Handshake first.
    let first = read_frame(&mut r).await?;
    let req: Request = serde_json::from_slice(&first).map_err(std::io::Error::other)?;
    let Request::Hello { protocol_version, .. } = req else {
        let bad = Response::Error { message: "first frame was not Hello".into(), recoverable: false };
        write_frame(&mut w, &serde_json::to_vec(&bad).unwrap()).await?;
        return Ok(());
    };
    let resp = if protocol_version == PROTOCOL_VERSION {
        Response::HelloAck {
            protocol_version: PROTOCOL_VERSION,
            host_version: env!("CARGO_PKG_VERSION").to_string(),
            pid: std::process::id(),
        }
    } else {
        Response::HelloNack {
            reason: format!("unsupported protocol_version {protocol_version}"),
            supported_versions: vec![PROTOCOL_VERSION],
        }
    };
    write_frame(&mut w, &serde_json::to_vec(&resp).unwrap()).await?;

    let mut attach_id_counter: u64 = 0;
    loop {
        let frame_bytes = match read_frame(&mut r).await {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(()),
            Err(e) => return Err(e),
        };
        let req: Request = serde_json::from_slice(&frame_bytes).map_err(std::io::Error::other)?;
        match req {
            Request::Attach { sid } => {
                let m = map.lock().await;
                let Some(s) = m.get(&sid).cloned() else {
                    let r = Response::Error { message: format!("not found: {sid}"), recoverable: true };
                    write_frame(&mut w, &serde_json::to_vec(&r).unwrap()).await?;
                    continue;
                };
                drop(m);
                attach_id_counter += 1;
                let attach_id = attach_id_counter;
                let ack = Response::AttachStarted { attach_id };
                write_frame(&mut w, &serde_json::to_vec(&ack).unwrap()).await?;
                stream_attach(&mut w, s, sid).await?;
            }
            other => {
                let resp = dispatch(&map, other).await;
                write_frame(&mut w, &serde_json::to_vec(&resp).unwrap()).await?;
            }
        }
    }
}

async fn stream_attach<W: tokio::io::AsyncWrite + Unpin>(
    w: &mut W,
    sess: Arc<Session>,
    sid: String,
) -> std::io::Result<()> {
    use base64::Engine as _;
    let mut rx = sess.tx.subscribe();
    while let Ok(ev) = rx.recv().await {
        let event = match ev {
            SessionEvent::Output { bytes, seq } => Event::Output {
                sid: sid.clone(),
                bytes_b64: base64::engine::general_purpose::STANDARD.encode(&bytes),
                seq,
            },
            SessionEvent::Hook(h) => Event::Hook { sid: sid.clone(), hook: h },
            SessionEvent::Exit { exit_status, reason } => {
                let ev = Event::Exit { sid: sid.clone(), exit_status, reason };
                write_frame(w, &serde_json::to_vec(&ev).unwrap()).await?;
                break;
            }
        };
        let bytes = serde_json::to_vec(&event).unwrap();
        write_frame(w, &bytes).await?;
    }
    Ok(())
}
```

- [ ] **Step 4: Implement Detach.** Detach drops the per-connection broadcast receiver. Track receivers per attach_id in a `HashMap<u64, broadcast::Receiver<…>>` on the connection. For v1 simplicity: an explicit Detach request closes the per-connection attach by setting a per-attach `tokio::sync::Notify` that `stream_attach` selects on. Implementation:

```rust
// In handle_connection, replace the single `stream_attach` call:
let stop_notify = Arc::new(tokio::sync::Notify::new());
let stop_clone = stop_notify.clone();
let detach_id = attach_id;
// Spawn streaming on this connection in-place (don't `tokio::spawn` — we need
// to keep using `w`).
stream_attach_with_cancel(&mut w, s, sid.clone(), stop_notify).await?;
```

`stream_attach_with_cancel` uses `tokio::select!` between `rx.recv()` and `stop.notified()`.

In the dispatch path for `Detach { sid, attach_id }`, signal the matching Notify. Bookkeeping:

```rust
type DetachMap = Arc<Mutex<HashMap<(String, u64), Arc<tokio::sync::Notify>>>>;
```

Track entries by `(sid, attach_id)`. Insert on Attach, remove on Detach. The Detach Response::Ok is returned by the SAME connection that owns the attach.

If this gets too tangled, fall back to a simpler v1 model: client closes the connection to detach (no explicit Detach request). The trait's `detach(sid, attach_id)` can call into a per-attach kill-channel. For v1, **simpler is fine** — document that "Detach via socket close" is supported, and the Detach request is a no-op that the host accepts for symmetry. Update the spec's `Sidecar wire protocol` table footnote to match.

- [ ] **Step 5: Implement Resize and CaptureScreen** by extending `dispatch`:

```rust
Request::Resize { sid, rows, cols } => {
    let m = map.lock().await;
    let Some(s) = m.get(&sid).cloned() else { return Response::Error { message: format!("not found: {sid}"), recoverable: true } };
    drop(m);
    match s.resize(rows, cols).await {
        Ok(()) => Response::Ok,
        Err(e) => Response::Error { message: e.to_string(), recoverable: true },
    }
}
Request::CaptureScreen { sid } => {
    let m = map.lock().await;
    let Some(s) = m.get(&sid).cloned() else { return Response::Error { message: format!("not found: {sid}"), recoverable: true } };
    drop(m);
    let bytes = s.capture_screen().await;
    use base64::Engine as _;
    Response::ScreenSnapshot {
        rows: *s.rows.lock().await,
        cols: *s.cols.lock().await,
        ansi_bytes_b64: base64::engine::general_purpose::STANDARD.encode(&bytes),
    }
}
```

- [ ] **Step 6: Run.** All sidecar tests: `cargo test -p claudette-session-host -- --nocapture`. Expected: PASS.

- [ ] **Step 7: Clippy.** Zero warnings.

- [ ] **Step 8: Commit.**

```bash
git add src-session-host
git commit -m "feat(session-host): Attach streaming, Detach (via close), Resize, CaptureScreen"
```

---

### Task C5: Idle-exit timer

**Files:**
- Create / fill: `src-session-host/src/idle.rs`
- Modify: `src-session-host/src/server.rs`, `src-session-host/src/main.rs`

- [ ] **Step 1: Write test.** `src-session-host/tests/idle_exit.rs`:

```rust
#[tokio::test]
async fn idle_exit_when_no_sessions_and_no_clients() {
    let map = claudette_session_host::server::new_session_map();
    let idle = claudette_session_host::idle::Idle::new(std::time::Duration::from_millis(200));
    idle.notify_client_count(0);
    let started = std::time::Instant::now();
    let exit_fut = claudette_session_host::idle::wait_for_idle_exit(map.clone(), idle.clone()).await;
    let _ = exit_fut; // returns when idle for the configured duration
    assert!(started.elapsed() >= std::time::Duration::from_millis(180));
}
```

- [ ] **Step 2: Run.** Expected: FAIL.

- [ ] **Step 3: Implement idle module:**

```rust
//! Idle-exit timer for the sidecar.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;
use tokio::sync::Notify;
use crate::server::SessionMap;

#[derive(Clone)]
pub struct Idle {
    pub timeout: Duration,
    clients: Arc<AtomicUsize>,
    pub waker: Arc<Notify>,
}

impl Idle {
    pub fn new(timeout: Duration) -> Self {
        Self {
            timeout,
            clients: Arc::new(AtomicUsize::new(0)),
            waker: Arc::new(Notify::new()),
        }
    }
    pub fn client_connected(&self) {
        self.clients.fetch_add(1, Ordering::SeqCst);
        self.waker.notify_waiters();
    }
    pub fn client_disconnected(&self) {
        self.clients.fetch_sub(1, Ordering::SeqCst);
        self.waker.notify_waiters();
    }
    pub fn notify_client_count(&self, n: usize) {
        self.clients.store(n, Ordering::SeqCst);
        self.waker.notify_waiters();
    }
}

pub async fn wait_for_idle_exit(map: SessionMap, idle: Idle) {
    loop {
        let clients = idle.clients.load(Ordering::SeqCst);
        let session_count = map.lock().await.len();
        if clients == 0 && session_count == 0 {
            tokio::select! {
                _ = tokio::time::sleep(idle.timeout) => {
                    let clients = idle.clients.load(Ordering::SeqCst);
                    let session_count = map.lock().await.len();
                    if clients == 0 && session_count == 0 {
                        return;
                    }
                }
                _ = idle.waker.notified() => { continue; }
            }
        } else {
            idle.waker.notified().await;
        }
    }
}
```

- [ ] **Step 4: Wire it.** Update `main.rs`:

```rust
#[tokio::main]
async fn main() -> std::io::Result<()> {
    tracing_subscriber::fmt().with_env_filter("info").init();
    let map = claudette_session_host::server::new_session_map();
    let idle = claudette_session_host::idle::Idle::new(std::time::Duration::from_secs(600));
    let path = claudette_session_host::server::default_socket_path();

    let server_fut = claudette_session_host::server::run_at_with_idle(map.clone(), &path, idle.clone());
    let idle_fut = claudette_session_host::idle::wait_for_idle_exit(map.clone(), idle.clone());

    tokio::select! {
        r = server_fut => r,
        _ = idle_fut => {
            tracing::info!("idle timeout reached, exiting");
            Ok(())
        }
    }
}
```

Then add `run_at_with_idle` to `server.rs` that increments/decrements `Idle` around each connection lifetime. (The simplest path: wrap the accept loop with `idle.client_connected()` / `client_disconnected()` per connection task.)

- [ ] **Step 5: Run.** `cargo test -p claudette-session-host -- --nocapture`. Expected: all pass.

- [ ] **Step 6: Clippy.** Zero warnings.

- [ ] **Step 7: Commit.**

```bash
git add src-session-host
git commit -m "feat(session-host): idle-exit when no sessions and no clients"
```

---

### Task C6: `SidecarHost` client (Rust-side `InteractiveHost` impl)

**Files:**
- Create / fill: `src/agent/interactive_host/sidecar.rs`

- [ ] **Step 1: Write failing tests.** Append to `src/agent/interactive_host/sidecar.rs`:

```rust
//! `SidecarHost` — the InteractiveHost impl that talks to `claudette-session-host`.
//!
//! Owns a Tokio task that maintains a long-lived connection, multiplexes
//! requests, and fans-out attach events.

use super::{AttachEvent, AttachId, AttachStream, HostError, HostHandle, HostStatus, InteractiveHost, ScreenSnapshot, SessionId};
use crate::agent::interactive_protocol::{InputPayload, SessionSpec, StopMode};
use async_trait::async_trait;
use std::path::PathBuf;
use std::sync::Arc;

pub struct SidecarHost {
    socket_path: PathBuf,
    binary_path: PathBuf,
}

impl SidecarHost {
    pub fn new(socket_path: PathBuf, binary_path: PathBuf) -> Self {
        Self { socket_path, binary_path }
    }

    /// Ensure the sidecar is running, spawning it if not. Idempotent.
    pub async fn ensure_running(&self) -> std::io::Result<()> {
        // Try to connect; if it fails, spawn the binary.
        // Implementation lands inside this method (concrete code in step 3).
        Ok(())
    }
}

#[async_trait]
impl InteractiveHost for SidecarHost {
    async fn ensure_session(&self, sid: &SessionId, spec: &SessionSpec) -> Result<HostHandle, HostError> { todo!() }
    async fn attach(&self, sid: &SessionId) -> Result<(AttachId, AttachStream), HostError> { todo!() }
    async fn send_input(&self, sid: &SessionId, payload: InputPayload) -> Result<(), HostError> { todo!() }
    async fn capture_screen(&self, sid: &SessionId) -> Result<ScreenSnapshot, HostError> { todo!() }
    async fn resize(&self, sid: &SessionId, rows: u16, cols: u16) -> Result<(), HostError> { todo!() }
    async fn detach(&self, sid: &SessionId, attach_id: AttachId) -> Result<(), HostError> { todo!() }
    async fn stop(&self, sid: &SessionId, mode: StopMode) -> Result<(), HostError> { todo!() }
    async fn status(&self) -> Result<HostStatus, HostError> { todo!() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::interactive_host::conformance::{run, ConformanceFixture};

    #[tokio::test]
    #[ignore = "spawned-sidecar conformance test — run with --ignored"]
    async fn sidecar_passes_conformance() {
        let bin = PathBuf::from(env!("CARGO_BIN_EXE_claudette-session-host"));
        let stub = PathBuf::from(env!("CARGO_BIN_EXE_stub-tui"));
        let socket = std::env::temp_dir().join(format!("sidecar-conformance-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&socket);
        let host = SidecarHost::new(socket.clone(), bin);
        host.ensure_running().await.unwrap();
        let fx = ConformanceFixture {
            sid: SessionId("claudette-conformance-aaaaaaaa".into()),
            spec: SessionSpec {
                working_dir: std::env::temp_dir().to_string_lossy().into(),
                rows: 24,
                cols: 80,
                claude_binary: stub.to_string_lossy().into(),
                claude_args: vec![],
                env: vec![],
                claude_config_dir: std::env::temp_dir().to_string_lossy().into(),
            },
        };
        run(&host, &fx).await;
    }
}
```

Add the `claudette-session-host` artifact-dep so the `CARGO_BIN_EXE_*` env-var is available. In root `Cargo.toml`'s `claudette` dev-dependencies (or `dev-dependencies` in the lib package section):

```toml
[dev-dependencies]
claudette-session-host = { path = "src-session-host", artifact = "bin:claudette-session-host" }
stub-tui = { path = "tests/fixtures/stub-tui", artifact = "bin:stub-tui" }
```

- [ ] **Step 2: Run test.** `cargo test -p claudette sidecar_passes_conformance --ignored`. Expected: panic (all impls `todo!()`).

- [ ] **Step 3: Implement the actor.** Inside `sidecar.rs`, design:

- A `ConnHandle` struct wraps the local-socket connection. It runs one Tokio task that reads frames and dispatches them: response frames go to a per-request oneshot; attach event frames go to per-attach `mpsc::Sender<AttachEvent>`.
- `SidecarHost::ensure_running` first tries to connect to `socket_path`; if `ConnectionRefused` or `NotFound`, spawns `binary_path` as a detached child (`tokio::process::Command` with `kill_on_drop(false)`).
- Each trait method serialises the request, awaits the response oneshot.
- `attach` returns the `mpsc::Receiver` wrapped as a `Stream` via `tokio_stream::wrappers::ReceiverStream`.

Full implementation outline (every block paste-able as concrete code; you do not need to invent additional types):

```rust
use crate::agent::interactive_protocol::{
    frame::{read_frame, write_frame},
    Event, Request, Response, PROTOCOL_VERSION,
};
use interprocess::local_socket::{
    GenericFilePath, ToFsName, prelude::*, tokio::Stream as SockStream,
};
use std::collections::HashMap;
use tokio::sync::{Mutex, mpsc, oneshot};

struct ConnHandle {
    tx: mpsc::Sender<OutFrame>,
    inflight: Arc<Mutex<HashMap<u64, oneshot::Sender<Response>>>>,
    attaches: Arc<Mutex<HashMap<String, mpsc::Sender<AttachEvent>>>>,
    next_id: Arc<std::sync::atomic::AtomicU64>,
}

enum OutFrame { Bytes(Vec<u8>) }

impl ConnHandle {
    async fn connect(socket_path: &Path) -> std::io::Result<Self> {
        use std::path::Path as StdPath;
        let name = <StdPath>::to_fs_name::<GenericFilePath>(socket_path)?;
        let stream = SockStream::connect(name).await?;
        let (mut r, mut w) = stream.split();

        // Send Hello.
        let hello = Request::Hello {
            protocol_version: PROTOCOL_VERSION,
            claudette_version: env!("CARGO_PKG_VERSION").to_string(),
        };
        let env = crate::agent::interactive_protocol::RequestEnvelope { request_id: 0, request: hello };
        write_frame(&mut w, &serde_json::to_vec(&env).unwrap()).await?;
        let first = read_frame(&mut r).await?;
        let inbound: crate::agent::interactive_protocol::InboundFrame =
            serde_json::from_slice(&first).map_err(std::io::Error::other)?;
        match inbound {
            crate::agent::interactive_protocol::InboundFrame::Response { response: Response::HelloAck { .. }, .. } => {}
            other => return Err(std::io::Error::other(format!("handshake failed: {other:?}"))),
        }

        let (tx_out, mut rx_out) = mpsc::channel::<OutFrame>(256);
        let inflight: Arc<Mutex<HashMap<u64, oneshot::Sender<Response>>>> = Arc::new(Mutex::new(HashMap::new()));
        let attaches: Arc<Mutex<HashMap<String, mpsc::Sender<AttachEvent>>>> = Arc::new(Mutex::new(HashMap::new()));
        let next_id = Arc::new(std::sync::atomic::AtomicU64::new(1));

        // Writer task: drains tx_out and writes frames.
        tokio::spawn(async move {
            while let Some(OutFrame::Bytes(bytes)) = rx_out.recv().await {
                if write_frame(&mut w, &bytes).await.is_err() { break; }
            }
        });

        // Reader task: dispatches frames to inflight or attaches.
        let inflight_r = inflight.clone();
        let attaches_r = attaches.clone();
        tokio::spawn(async move {
            loop {
                let bytes = match read_frame(&mut r).await {
                    Ok(b) => b,
                    Err(_) => break,
                };
                let Ok(frame) = serde_json::from_slice::<crate::agent::interactive_protocol::InboundFrame>(&bytes) else { continue };
                match frame {
                    crate::agent::interactive_protocol::InboundFrame::Response { request_id, response } => {
                        if let Some(tx) = inflight_r.lock().await.remove(&request_id) {
                            let _ = tx.send(response);
                        }
                    }
                    crate::agent::interactive_protocol::InboundFrame::Event(ev) => {
                        let (sid, ev) = match ev {
                            Event::Output { sid, bytes_b64, seq } => {
                                use base64::Engine as _;
                                let bytes = base64::engine::general_purpose::STANDARD.decode(bytes_b64).unwrap_or_default();
                                (sid, AttachEvent::Output { bytes, seq })
                            }
                            Event::Hook { sid, hook } => (sid, AttachEvent::Hook(hook)),
                            Event::Exit { sid, exit_status, reason } => (sid, AttachEvent::Exit { exit_status, reason }),
                            Event::StreamError { sid, message, recoverable } => (sid, AttachEvent::Error { message, recoverable }),
                        };
                        if let Some(tx) = attaches_r.lock().await.get(&sid).cloned() {
                            let _ = tx.send(ev).await;
                        }
                    }
                }
            }
        });

        Ok(Self { tx: tx_out, inflight, attaches, next_id })
    }

    async fn request(&self, req: Request) -> Result<Response, HostError> {
        let request_id = self.next_id.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let (tx_resp, rx_resp) = oneshot::channel();
        self.inflight.lock().await.insert(request_id, tx_resp);
        let env = crate::agent::interactive_protocol::RequestEnvelope { request_id, request: req };
        let bytes = serde_json::to_vec(&env).map_err(|e| HostError::Other(e.to_string()))?;
        self.tx.send(OutFrame::Bytes(bytes)).await.map_err(|_| HostError::Other("conn closed".into()))?;
        rx_resp.await.map_err(|_| HostError::Other("response channel dropped".into()))
    }

    async fn attach_for(&self, sid: String) -> mpsc::Receiver<AttachEvent> {
        let (tx, rx) = mpsc::channel(1024);
        self.attaches.lock().await.insert(sid, tx);
        rx
    }
}
```

The pump:

1. Connect to `socket_path` (return `io::Error::NotFound` if it doesn't exist — caller will spawn the binary).
2. Send `Request::Hello`.
3. Read response — error if not `HelloAck`.
4. Split the stream into reader/writer halves.
5. Spawn read task: each inbound frame is parsed as either `Response` (delivered to an inflight oneshot by request-id correlation) or `Event` (delivered to per-`sid` attach channel).
6. Writer task pulls from the outbound `mpsc::Receiver<OutFrame>` and writes frames.

For request-id correlation: each `Request` is wrapped in `serde_json::json!({ "request_id": <u64>, "request": <Request> })`. Add a small request-envelope at the protocol layer. **Update `interactive_protocol.rs` to define:**

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestEnvelope {
    pub request_id: u64,
    pub request: Request,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum InboundFrame {
    Response { request_id: u64, response: Response },
    Event(Event),
}
```

And update the **session host's `handle_connection`** to read `RequestEnvelope` and reply with the corresponding shape. Round-trip test (add to `interactive_protocol.rs`):

```rust
#[test]
fn request_envelope_round_trips() {
    let env = RequestEnvelope { request_id: 42, request: Request::Status };
    let s = serde_json::to_string(&env).unwrap();
    let back: RequestEnvelope = serde_json::from_str(&s).unwrap();
    assert_eq!(back.request_id, 42);
}
```

This wire-format change is **breaking** for protocol-version 1. That is fine — nothing ships yet. Keep `PROTOCOL_VERSION = 1`.

- [ ] **Step 4: Update the session-host server to use envelopes.** In `src-session-host/src/server.rs`, change the read loop to deserialize `RequestEnvelope` and write responses as the matching `InboundFrame::Response { request_id, response }`:

```rust
// Replace the existing per-frame parse:
let env: crate::agent::interactive_protocol::RequestEnvelope =
    serde_json::from_slice(&frame_bytes).map_err(std::io::Error::other)?;
let req = env.request;
let request_id = env.request_id;
// ...existing dispatch returns Response...
let outbound = crate::agent::interactive_protocol::InboundFrame::Response { request_id, response: resp };
write_frame(&mut w, &serde_json::to_vec(&outbound).unwrap()).await?;
```

Update Hello-handshake handling so the first frame is an envelope too (`request_id == 0` by convention). Update the existing handshake/ensure_session/attach_stream tests in `src-session-host/tests/` to send envelopes and expect `InboundFrame::Response` shapes — the test helpers should grow `send_env` and `recv_inbound` variants. Run the entire `src-session-host` test suite and confirm green.

- [ ] **Step 5: Run.** `cargo test -p claudette sidecar_passes_conformance --ignored` and `cargo test -p claudette-session-host`. Expected: both pass.

- [ ] **Step 6: Clippy.** Zero warnings in both crates.

- [ ] **Step 7: Commit.**

```bash
git add src/agent/interactive_host/sidecar.rs src/agent/interactive_protocol.rs src-session-host Cargo.toml
git commit -m "feat(agent): SidecarHost client passes InteractiveHost conformance"
```

---

## Phase D — Tmux host

### Task D1: `TmuxHost` implementation

**Files:**
- Create: `src/agent/interactive_host/tmux.rs` (`#[cfg(unix)]`)

This is one task because every operation is a shell-out; the implementations are small.

- [ ] **Step 1: Write a failing ignored test** at the bottom of the file:

```rust
//! TmuxHost — InteractiveHost backed by the system tmux binary.

#![cfg(unix)]

use super::{
    AttachEvent, AttachId, AttachStream, HostError, HostHandle, HostSessionSummary, HostStatus,
    InteractiveHost, ScreenSnapshot, SessionId,
};
use super::availability::{check_tmux, TmuxAvailability};
use crate::agent::interactive_protocol::{InputPayload, SessionSpec, StopMode};
use async_trait::async_trait;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::process::Command;

pub struct TmuxHost {
    /// Per-host directory under $TMPDIR for FIFOs etc.
    runtime_dir: PathBuf,
    next_attach: Arc<AtomicU64>,
}

impl TmuxHost {
    pub fn new(runtime_dir: PathBuf) -> Self {
        Self { runtime_dir, next_attach: Arc::new(AtomicU64::new(0)) }
    }
}

#[async_trait]
impl InteractiveHost for TmuxHost {
    // ... methods below ...
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::interactive_host::conformance::{run, ConformanceFixture};

    #[tokio::test]
    #[ignore = "requires tmux >= 3.0"]
    async fn tmux_passes_conformance() {
        match check_tmux().await {
            TmuxAvailability::Available { .. } => {}
            other => {
                eprintln!("skipping: tmux not available: {other:?}");
                return;
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let host = TmuxHost::new(dir.path().to_path_buf());
        let stub = PathBuf::from(env!("CARGO_BIN_EXE_stub-tui"));
        let fx = ConformanceFixture {
            sid: SessionId("claudette-tmux-conformance-aaaaaaaa".into()),
            spec: SessionSpec {
                working_dir: dir.path().to_string_lossy().into(),
                rows: 24,
                cols: 80,
                claude_binary: stub.to_string_lossy().into(),
                claude_args: vec![],
                env: vec![],
                claude_config_dir: dir.path().to_string_lossy().into(),
            },
        };
        run(&host, &fx).await;
    }
}
```

- [ ] **Step 2: Run.** `cargo test -p claudette tmux_passes_conformance --ignored`. Expected: not compiled or failing because methods are missing.

- [ ] **Step 3: Implement each method.** Concrete:

```rust
impl TmuxHost {
    fn fifo_path(&self, sid: &SessionId) -> PathBuf {
        self.runtime_dir.join(format!("{}.fifo", sid.as_str()))
    }
}

#[async_trait]
impl InteractiveHost for TmuxHost {
    async fn ensure_session(&self, sid: &SessionId, spec: &SessionSpec) -> Result<HostHandle, HostError> {
        let exists = Command::new("tmux")
            .args(["has-session", "-t", sid.as_str()])
            .output().await
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !exists {
            let mut cmd = Command::new("tmux");
            cmd.args(["new-session", "-d", "-s", sid.as_str(),
                      "-x", &spec.cols.to_string(),
                      "-y", &spec.rows.to_string()]);
            for (k, v) in &spec.env {
                cmd.args(["-e", &format!("{k}={v}")]);
            }
            cmd.args(["-e", &format!("CLAUDE_CONFIG_DIR={}", spec.claude_config_dir)]);
            cmd.arg("--").arg(&spec.claude_binary);
            for arg in &spec.claude_args { cmd.arg(arg); }
            let st = cmd.status().await.map_err(HostError::Io)?;
            if !st.success() {
                return Err(HostError::Other(format!("tmux new-session failed: {st}")));
            }
            // Set up pipe-pane to the fifo (idempotent).
            std::fs::create_dir_all(&self.runtime_dir).ok();
            let fifo = self.fifo_path(sid);
            if !fifo.exists() {
                nix::unistd::mkfifo(&fifo, nix::sys::stat::Mode::S_IRUSR | nix::sys::stat::Mode::S_IWUSR)
                    .map_err(|e| HostError::Other(e.to_string()))?;
            }
            let pipe_cmd = format!("cat >> {}", shell_escape(&fifo.to_string_lossy()));
            Command::new("tmux").args(["pipe-pane", "-O", "-t", sid.as_str(), &pipe_cmd])
                .status().await.map_err(HostError::Io)?;
        }
        Ok(HostHandle { sid: sid.clone(), pid: None, rows: spec.rows, cols: spec.cols })
    }

    async fn attach(&self, sid: &SessionId) -> Result<(AttachId, AttachStream), HostError> {
        let id = AttachId(self.next_attach.fetch_add(1, Ordering::SeqCst));
        let fifo = self.fifo_path(sid);
        let (tx, rx) = tokio::sync::mpsc::channel::<AttachEvent>(1024);
        // Open the FIFO for reading on a blocking thread; pump bytes to tx as Output events.
        let fifo_clone = fifo.clone();
        tokio::task::spawn_blocking(move || {
            let mut f = match std::fs::OpenOptions::new().read(true).open(&fifo_clone) {
                Ok(f) => f,
                Err(e) => { let _ = tx.blocking_send(AttachEvent::Error { message: e.to_string(), recoverable: false }); return; }
            };
            let mut buf = [0u8; 8192];
            let mut seq: u64 = 0;
            use std::io::Read;
            loop {
                match f.read(&mut buf) {
                    Ok(0) => { std::thread::sleep(std::time::Duration::from_millis(50)); }
                    Ok(n) => { seq += 1; if tx.blocking_send(AttachEvent::Output { bytes: buf[..n].to_vec(), seq }).is_err() { return; } }
                    Err(_) => return,
                }
            }
        });
        use tokio_stream::wrappers::ReceiverStream;
        let stream: AttachStream = Box::pin(ReceiverStream::new(rx));
        Ok((id, stream))
    }

    async fn send_input(&self, sid: &SessionId, payload: InputPayload) -> Result<(), HostError> {
        let mut args: Vec<String> = vec!["send-keys".into(), "-t".into(), sid.as_str().into()];
        match payload {
            InputPayload::Text { text } => { args.push("-l".into()); args.push("--".into()); args.push(text); }
            InputPayload::Keys { name } => { args.push("--".into()); args.push(name); }
            InputPayload::Bytes { bytes_b64 } => {
                use base64::Engine as _;
                let raw = base64::engine::general_purpose::STANDARD.decode(&bytes_b64).map_err(|e| HostError::Other(e.to_string()))?;
                let s = String::from_utf8_lossy(&raw).to_string();
                args.push("-l".into()); args.push("--".into()); args.push(s);
            }
        }
        let st = Command::new("tmux").args(&args).status().await.map_err(HostError::Io)?;
        if !st.success() { return Err(HostError::Other("tmux send-keys failed".into())); }
        Ok(())
    }

    async fn capture_screen(&self, sid: &SessionId) -> Result<ScreenSnapshot, HostError> {
        let out = Command::new("tmux")
            .args(["capture-pane", "-t", sid.as_str(), "-pJ", "-e"])
            .output().await.map_err(HostError::Io)?;
        if !out.status.success() {
            return Err(HostError::Other(format!("capture-pane failed: {}", String::from_utf8_lossy(&out.stderr))));
        }
        // Also fetch rows/cols.
        let dims = Command::new("tmux")
            .args(["display-message", "-p", "-t", sid.as_str(), "#{pane_height},#{pane_width}"])
            .output().await.map_err(HostError::Io)?;
        let s = String::from_utf8_lossy(&dims.stdout);
        let (h, w): (u16, u16) = {
            let mut parts = s.trim().split(',');
            let h = parts.next().and_then(|p| p.parse().ok()).unwrap_or(24);
            let w = parts.next().and_then(|p| p.parse().ok()).unwrap_or(80);
            (h, w)
        };
        Ok(ScreenSnapshot { rows: h, cols: w, ansi_bytes: out.stdout })
    }

    async fn resize(&self, sid: &SessionId, rows: u16, cols: u16) -> Result<(), HostError> {
        Command::new("tmux").args(["resize-window", "-t", sid.as_str(), "-x", &cols.to_string(), "-y", &rows.to_string()])
            .status().await.map_err(HostError::Io)?;
        Ok(())
    }

    async fn detach(&self, _sid: &SessionId, _attach_id: AttachId) -> Result<(), HostError> {
        // Our "attach" is a FIFO tailer task; dropping the receiver stops it. No tmux-side action.
        Ok(())
    }

    async fn stop(&self, sid: &SessionId, mode: StopMode) -> Result<(), HostError> {
        match mode {
            StopMode::Graceful => {
                Command::new("tmux").args(["send-keys", "-t", sid.as_str(), "--", "C-c"]).status().await.ok();
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            }
            StopMode::Force => {}
        }
        Command::new("tmux").args(["kill-session", "-t", sid.as_str()]).status().await.map_err(HostError::Io)?;
        let _ = std::fs::remove_file(self.fifo_path(sid));
        Ok(())
    }

    async fn status(&self) -> Result<HostStatus, HostError> {
        let out = Command::new("tmux").args(["list-sessions", "-F", "#{session_name}|#{session_created}"]).output().await;
        let mut sessions = Vec::new();
        if let Ok(o) = out {
            if o.status.success() {
                for line in String::from_utf8_lossy(&o.stdout).lines() {
                    let mut parts = line.split('|');
                    let name = parts.next().unwrap_or("");
                    if !name.starts_with("claudette-") { continue; }
                    sessions.push(HostSessionSummary {
                        sid: SessionId(name.to_string()),
                        pid: None,
                        running: true,
                    });
                }
            }
        }
        Ok(HostStatus { host_version: "tmux".into(), sessions })
    }
}

fn shell_escape(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}
```

Add `nix = { version = "...", features = ["fs"] }` to the workspace deps if not already there.

- [ ] **Step 4: Add to module list.** `src/agent/interactive_host/mod.rs` already has `#[cfg(unix)] pub mod tmux;` from Task B4.

- [ ] **Step 5: Run.** On Unix: `cargo test -p claudette tmux_passes_conformance --ignored -- --nocapture`. Expected: PASS (skip-with-message if tmux not installed).

- [ ] **Step 6: Clippy.** `cargo clippy -p claudette --all-targets --all-features` on Unix. Zero warnings.

- [ ] **Step 7: Commit.**

```bash
git add src/agent/interactive_host/tmux.rs Cargo.toml
git commit -m "feat(agent): TmuxHost passes InteractiveHost conformance"
```

---

### Task D2: Periodic reconciliation against tmux

**Files:**
- Modify: `src/agent/interactive_host/tmux.rs`

- [ ] **Step 1: Write failing test.**

```rust
#[tokio::test]
#[ignore = "requires tmux >= 3.0"]
async fn reconciliation_marks_externally_killed_sessions_dead() {
    // 1. Spawn a stub-tui session through TmuxHost::ensure_session.
    // 2. Kill it externally via `tmux kill-session -t <sid>`.
    // 3. Call host.reconcile() — observe that `status()` no longer lists it.
}
```

- [ ] **Step 2: Implement a `reconcile()` method** on `TmuxHost` that calls `status()` and returns the diff against an in-memory `expected` set. Provide a hook that callers (the lifecycle worker in `claude_interactive.rs`) can use to mark DB rows.

```rust
impl TmuxHost {
    pub async fn reconcile(&self, expected: &[SessionId]) -> Result<Vec<SessionId>, HostError> {
        let st = self.status().await?;
        let live: std::collections::HashSet<_> = st.sessions.iter().map(|s| s.sid.clone()).collect();
        Ok(expected.iter().filter(|sid| !live.contains(sid)).cloned().collect())
    }
}
```

- [ ] **Step 3: Run.** Expected: PASS.

- [ ] **Step 4: Commit.**

```bash
git add src/agent/interactive_host/tmux.rs
git commit -m "feat(agent): TmuxHost::reconcile returns sessions killed externally"
```

---

## Phase E — Hooks, CLI subcommand, IPC ingestion

### Task E1: `claudette-cli chat hook` subcommand

**Files:**
- Create: `src-cli/src/commands/chat_hook.rs`
- Modify: `src-cli/src/commands/mod.rs` and `src-cli/src/main.rs` (CLI parser)

- [ ] **Step 1: Locate existing `chat` subcommand wiring.** Run `grep -n "chat" src-cli/src/main.rs src-cli/src/commands/*.rs` to find the parser. The new subcommand parallels existing `chat stop`, `chat answer`, etc.

- [ ] **Step 2: Write a CLI parse test.** Append (or create) `src-cli/src/commands/chat_hook_tests.rs` (or `#[cfg(test)] mod tests` block):

```rust
#[test]
fn parses_chat_hook_arguments() {
    let parsed = crate::cli::parse_for_test(&[
        "claudette", "chat", "hook",
        "--sid", "claudette-x-y",
        "--kind", "awaiting",
        "--reason", "blocked on permission",
    ]).unwrap();
    match parsed.command {
        crate::cli::Command::ChatHook(args) => {
            assert_eq!(args.sid, "claudette-x-y");
            assert_eq!(args.kind, "awaiting");
            assert_eq!(args.reason.as_deref(), Some("blocked on permission"));
        }
        other => panic!("expected ChatHook, got {other:?}"),
    }
}
```

(`parse_for_test` may or may not exist — match the existing pattern in the CLI tests; if there is none, follow whatever existing `chat answer` test does. The point is: parsing is covered by a test before adding code.)

- [ ] **Step 3: Run.** Expected: FAIL.

- [ ] **Step 4: Add the `ChatHookArgs` struct + `Command::ChatHook` variant** in the same place the existing `chat` subcommands are registered (use `clap` derive — pattern is already in the file).

```rust
#[derive(Debug, clap::Args)]
pub struct ChatHookArgs {
    #[arg(long)]
    pub sid: String,
    #[arg(long)]
    pub kind: String,
    #[arg(long)]
    pub reason: Option<String>,
}
```

Add the dispatch in `run.rs` (or wherever the CLI dispatches):

```rust
Command::ChatHook(args) => {
    let req = ChatHookRequest {
        sid: args.sid,
        kind: args.kind,
        reason: args.reason,
        // Hook payload from stdin (Claude Code passes JSON on stdin to hooks).
        payload_stdin: read_stdin_to_string()?,
    };
    let socket = resolve_claudette_socket()?;
    send_ipc(&socket, IpcRequest::ChatHook(req))?;
    Ok(())
}
```

- [ ] **Step 5: Define `IpcRequest::ChatHook`** in the shared IPC types module (`grep -n "IpcRequest" src-tauri/src/ipc.rs src-cli/src` to find it). Add the new variant + serde tag.

- [ ] **Step 6: Run tests, clippy, commit.**

```bash
cargo test -p claudette-cli
cargo clippy -p claudette-cli --all-targets --all-features
git add src-cli src-tauri/src/ipc.rs
git commit -m "feat(cli): add 'chat hook' subcommand for Claude Code hook events"
```

---

### Task E2: Tauri-side hook ingestion + per-session event channel

**Files:**
- Modify: `src-tauri/src/ipc.rs`
- Modify: `src-tauri/src/state.rs`

- [ ] **Step 1: Write a failing test** at the bottom of `src-tauri/src/ipc.rs` (the file already has tests — match the style):

```rust
#[tokio::test]
async fn chat_hook_dispatches_to_session_channel() {
    let state = AppState::new_for_test();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<crate::state::InteractiveHookEvent>();
    state.register_interactive_hook_channel("claudette-x-y", tx).await;
    let req = IpcRequest::ChatHook(ChatHookRequest {
        sid: "claudette-x-y".into(),
        kind: "awaiting".into(),
        reason: Some("perm".into()),
        payload_stdin: "{\"hook_event_name\":\"Notification\"}".into(),
    });
    handle_ipc_request(&state, req).await.unwrap();
    let got = rx.recv().await.unwrap();
    assert_eq!(got.sid, "claudette-x-y");
    matches!(got.kind, crate::state::HookEventKind::Awaiting);
}
```

- [ ] **Step 2: Implement.** Add to `state.rs`:

```rust
#[derive(Debug, Clone)]
pub enum HookEventKind {
    Stop,
    Awaiting { reason: Option<String> },
    PromptSubmitted,
    SubagentStop,
    Unknown { raw_kind: String },
}

#[derive(Debug, Clone)]
pub struct InteractiveHookEvent {
    pub sid: String,
    pub kind: HookEventKind,
}
```

Add a `HashMap<String, tokio::sync::mpsc::UnboundedSender<InteractiveHookEvent>>` to `AppState` (`Mutex` or `RwLock` per existing conventions). Add `register_interactive_hook_channel`, `unregister_interactive_hook_channel`, and `dispatch_interactive_hook`.

In `ipc.rs`, the `IpcRequest::ChatHook(req)` arm parses `kind` and calls `state.dispatch_interactive_hook(req.sid, kind)`.

- [ ] **Step 3: Run.** Expected: PASS.

- [ ] **Step 4: Clippy, commit.**

```bash
git add src-tauri/src/ipc.rs src-tauri/src/state.rs
git commit -m "feat(tauri): route 'chat hook' IPC into per-session interactive channels"
```

---

### Task E3: Settings overlay materialization

**Files:**
- Create: `src/agent/claude_interactive.rs` (initial skeleton)

- [ ] **Step 1: Test.** At the bottom of `src/agent/claude_interactive.rs` (create with this):

```rust
//! ClaudeInteractive backend.
//!
//! Materializes a per-session settings overlay that registers Claude Code
//! hooks, then asks an `InteractiveHost` to spawn `claude` with
//! `CLAUDE_CONFIG_DIR` pointing at the overlay.

use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct SettingsOverlay {
    pub dir: PathBuf,
}

impl SettingsOverlay {
    /// Create a fresh per-session overlay directory and write `settings.json`
    /// registering hooks that call back via `cli_bin_abs` with `--sid <sid>`.
    pub fn materialize(parent: &Path, sid: &str, cli_bin_abs: &Path) -> std::io::Result<Self> {
        let dir = parent.join(sid).join("claude-config");
        std::fs::create_dir_all(&dir)?;
        let settings = serde_json::json!({
            "hooks": {
                "Stop": [
                    { "matcher": "", "hooks": [
                        { "type": "command", "command": format!("{} chat hook --sid {} --kind stop",
                            shell_quote(cli_bin_abs.to_string_lossy().as_ref()), sid) }
                    ]}
                ],
                "Notification": [
                    { "matcher": "", "hooks": [
                        { "type": "command", "command": format!("{} chat hook --sid {} --kind awaiting",
                            shell_quote(cli_bin_abs.to_string_lossy().as_ref()), sid) }
                    ]}
                ],
                "UserPromptSubmit": [
                    { "matcher": "", "hooks": [
                        { "type": "command", "command": format!("{} chat hook --sid {} --kind prompt_submitted",
                            shell_quote(cli_bin_abs.to_string_lossy().as_ref()), sid) }
                    ]}
                ]
            }
        });
        std::fs::write(dir.join("settings.json"), serde_json::to_vec_pretty(&settings)?)?;
        Ok(Self { dir })
    }

    pub fn cleanup(&self) -> std::io::Result<()> {
        if self.dir.exists() {
            std::fs::remove_dir_all(&self.dir)?;
        }
        Ok(())
    }
}

fn shell_quote(s: &str) -> String {
    if s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-' | '.')) {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlay_writes_settings_with_three_hooks() {
        let dir = tempfile::tempdir().unwrap();
        let overlay = SettingsOverlay::materialize(
            dir.path(),
            "claudette-x-y",
            Path::new("/abs/path/to/claudette-cli"),
        ).unwrap();
        let json: serde_json::Value = serde_json::from_slice(
            &std::fs::read(overlay.dir.join("settings.json")).unwrap()
        ).unwrap();
        let hooks = json.get("hooks").unwrap();
        for key in ["Stop", "Notification", "UserPromptSubmit"] {
            assert!(hooks.get(key).is_some(), "missing hook: {key}");
        }
        overlay.cleanup().unwrap();
        assert!(!overlay.dir.exists());
    }
}
```

Note: The exact Claude Code hooks JSON schema (matcher / hooks / type / command) is what the existing `-p` path uses today via `AgentHookBridge`. Verify by reading `src/agent/args.rs::build_claude_args` and matching its overlay shape — copy that shape verbatim into the new overlay.

- [ ] **Step 2: Add module + re-export.** In `src/agent/mod.rs`:

```rust
pub mod claude_interactive;
```

- [ ] **Step 3: Run.** `cargo test -p claudette overlay_writes_settings_with_three_hooks`. Expected: PASS.

- [ ] **Step 4: Clippy. Commit.**

```bash
git add src/agent/claude_interactive.rs src/agent/mod.rs
git commit -m "feat(agent): settings overlay materializes Claude Code hooks"
```

---

## Phase F — Backend wiring + Tauri commands

### Task F1: Add `ClaudeInteractive` variant to harness layer

**Files:**
- Modify: `src/agent/harness.rs`
- Modify: `src/agent_backend.rs`

- [ ] **Step 1: Test for capabilities.** In `src/agent/harness.rs`'s test block:

```rust
#[test]
fn claude_interactive_capabilities() {
    let c = AgentHarnessCapabilities::claude_interactive();
    assert!(c.persistent_sessions);
    assert!(!c.attachments, "interactive mode does not yet support rich attachments");
}
```

- [ ] **Step 2: Run.** Expected: FAIL.

- [ ] **Step 3: Implement.**

```rust
impl AgentHarnessCapabilities {
    pub const fn claude_interactive() -> Self {
        Self {
            persistent_sessions: true,
            steer_turn: false,        // v1: no mid-turn steering through the interactive PTY.
            host_permission_prompts: false, // claude handles them natively in its TUI.
            remote_control: false,
            mcp_config: true,
            attachments: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentHarnessKind {
    ClaudeCode,
    ClaudeInteractive,
    CodexAppServer,
    #[cfg(feature = "pi-sdk")]
    PiSdk,
}

pub enum AgentSession {
    ClaudeCode(PersistentSession),
    ClaudeInteractive(crate::agent::claude_interactive::InteractiveSession),
    CodexAppServer(CodexAppServerSession),
    #[cfg(feature = "pi-sdk")]
    PiSdk(PiSdkSession),
}
```

`InteractiveSession` does not exist yet — create a stub in `claude_interactive.rs`:

```rust
pub struct InteractiveSession {
    pub sid: String,
}
```

- [ ] **Step 4: Add the runtime in `src/agent_backend.rs`.** Locate `effective_harness` (the function the spec calls out). Add a new branch that maps to `AgentHarnessKind::ClaudeInteractive` when the user-selected runtime is `ClaudeInteractive`. **Only available when `claudeInteractiveEnabled` is true**, so the resolver also takes the flag as input (or reads it from the DB at call time). Match the existing resolver shape for how it consults settings.

- [ ] **Step 5: Run all tests.** `cargo test -p claudette`. Then clippy. Both pass.

- [ ] **Step 6: Commit.**

```bash
git add src/agent/harness.rs src/agent/claude_interactive.rs src/agent_backend.rs
git commit -m "feat(agent): add ClaudeInteractive harness variant and backend resolver branch"
```

---

### Task F2: `InteractiveSession::start` (host selection + spawn + hook channel)

**Files:**
- Modify: `src/agent/claude_interactive.rs`
- Modify: `src/agent/interactive_host/mod.rs` (small selection helper)

- [ ] **Step 1: Test.** Append to `claude_interactive.rs`:

```rust
#[cfg(test)]
mod start_tests {
    use super::*;

    #[tokio::test]
    #[ignore = "requires stub-tui binary"]
    async fn start_creates_session_via_sidecar_host() {
        // 1. Use SidecarHost pointing at the bundled session-host binary.
        // 2. InteractiveSession::start with stub-tui as the claude_binary.
        // 3. Assert sid matches expected format and hook channel is registered.
    }
}
```

- [ ] **Step 2: Implement.**

```rust
pub struct InteractiveSession {
    pub sid: String,
    pub host: Arc<dyn crate::agent::interactive_host::InteractiveHost>,
    pub overlay: SettingsOverlay,
}

impl InteractiveSession {
    pub async fn start(
        workspace_short: &str,
        host: Arc<dyn crate::agent::interactive_host::InteractiveHost>,
        spec: SessionSpec,
        overlay_parent: &Path,
        cli_bin_abs: &Path,
    ) -> Result<Self, HostError> {
        let sid_str = format!("claudette-{}-{}", workspace_short, random_hex8());
        let overlay = SettingsOverlay::materialize(overlay_parent, &sid_str, cli_bin_abs)
            .map_err(|e| HostError::Other(e.to_string()))?;
        let spec = SessionSpec {
            claude_config_dir: overlay.dir.to_string_lossy().into(),
            ..spec
        };
        let sid = crate::agent::interactive_host::SessionId(sid_str.clone());
        host.ensure_session(&sid, &spec).await?;
        Ok(Self { sid: sid_str, host, overlay })
    }
}

fn random_hex8() -> String {
    use rand::RngCore;
    let mut buf = [0u8; 4];
    rand::thread_rng().fill_bytes(&mut buf);
    buf.iter().map(|b| format!("{b:02x}")).collect()
}
```

Use the `rand` crate already in workspace deps (`grep -n "rand" Cargo.toml`).

- [ ] **Step 3: Add host-selection helper** in `src/agent/interactive_host/mod.rs`:

```rust
pub async fn select_default_host(
    runtime_dir: &std::path::Path,
    sidecar_socket: &std::path::Path,
    sidecar_binary: &std::path::Path,
    prefer_sidecar_on_unix: bool,
) -> Result<std::sync::Arc<dyn InteractiveHost>, HostError> {
    #[cfg(unix)]
    if !prefer_sidecar_on_unix {
        use availability::*;
        match check_tmux().await {
            TmuxAvailability::Available { .. } => {
                return Ok(std::sync::Arc::new(tmux::TmuxHost::new(runtime_dir.to_path_buf())));
            }
            _ => {}
        }
    }
    Ok(std::sync::Arc::new(sidecar::SidecarHost::new(sidecar_socket.to_path_buf(), sidecar_binary.to_path_buf())))
}
```

- [ ] **Step 4: Run.** Build, clippy. (Test is `#[ignore]`d for now — wire it up in F3.) Commit.

```bash
git add src/agent/claude_interactive.rs src/agent/interactive_host/mod.rs
git commit -m "feat(agent): InteractiveSession::start with host selection"
```

---

### Task F3: Tauri commands for interactive sessions

**Files:**
- Create: `src-tauri/src/commands/interactive.rs`
- Modify: `src-tauri/src/commands/mod.rs`, `src-tauri/src/state.rs`, `src-tauri/src/main.rs` (handler registration)

- [ ] **Step 1: Tests live mostly in Rust integration tests for the underlying logic** (already covered). The Tauri command layer is thin — its job is parameter parsing + dispatch. Skip a unit test for these wrappers if the existing repo style is to do so (it largely is — `grep -L "tauri::test" src-tauri/src/commands` to confirm).

- [ ] **Step 2: Implement commands:**

```rust
//! Tauri commands for the Claude (Interactive) experimental backend.

use crate::state::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Deserialize)]
pub struct StartInteractiveArgs {
    pub workspace_id: String,
    pub working_dir: String,
    pub rows: u16,
    pub cols: u16,
    pub claude_binary: String,
    pub claude_args: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct StartInteractiveResult {
    pub sid: String,
    pub host_kind: String,
}

#[tauri::command]
pub async fn interactive_start(
    state: State<'_, AppState>,
    args: StartInteractiveArgs,
) -> Result<StartInteractiveResult, String> {
    // Flag check.
    if !state.claude_interactive_enabled().await {
        return Err("Claude Interactive is disabled".into());
    }
    // Resolve host, overlay parent, CLI binary path.
    let host = state.interactive_host_for(&args.workspace_id).await
        .map_err(|e| e.to_string())?;
    let overlay_parent = state.runtime_dir_for_interactive().await;
    let cli_bin = state.bundled_cli_binary_path().await
        .ok_or_else(|| "claudette-cli binary not found".to_string())?;
    let sess = claudette::agent::claude_interactive::InteractiveSession::start(
        workspace_short(&args.workspace_id),
        host.clone(),
        claudette::agent::interactive_protocol::SessionSpec {
            working_dir: args.working_dir.clone(),
            rows: args.rows, cols: args.cols,
            claude_binary: args.claude_binary,
            claude_args: args.claude_args,
            env: vec![],
            claude_config_dir: String::new(), // overlay populates this
        },
        &overlay_parent,
        &cli_bin,
    ).await.map_err(|e| e.to_string())?;
    // Persist row.
    let db = claudette::db::Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.create_interactive_session(&claudette::db::InteractiveSessionRow {
        sid: sess.sid.clone(),
        workspace_id: args.workspace_id.clone(),
        host_kind: state.interactive_host_kind_for(&args.workspace_id).await.to_string(),
        state: "running".into(),
        crash_reason: None,
        created_at: chrono::Utc::now().to_rfc3339(),
        last_attached_at: None,
        last_screen_blob: None,
        claude_flags_json: serde_json::to_string(&args.claude_args).unwrap(),
        pid: None,
    }).map_err(|e| e.to_string())?;
    state.register_interactive_session(&sess.sid, args.workspace_id.clone()).await;
    Ok(StartInteractiveResult { sid: sess.sid, host_kind: "tmux-or-sidecar".into() })
}

#[tauri::command]
pub async fn interactive_send_input(
    state: State<'_, AppState>,
    sid: String,
    text: String,
) -> Result<(), String> {
    let host = state.host_for_session(&sid).await.ok_or_else(|| "session not found".to_string())?;
    host.send_input(
        &claudette::agent::interactive_host::SessionId(sid),
        claudette::agent::interactive_protocol::InputPayload::Text { text },
    ).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn interactive_capture_screen(state: State<'_, AppState>, sid: String) -> Result<String, String> {
    use base64::Engine as _;
    let host = state.host_for_session(&sid).await.ok_or_else(|| "session not found".to_string())?;
    let snap = host.capture_screen(&claudette::agent::interactive_host::SessionId(sid.clone()))
        .await.map_err(|e| e.to_string())?;
    // Persist to DB for instant repaint on next launch.
    let db = claudette::db::Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.update_interactive_session_screen(&sid, &snap.ansi_bytes).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&snap.ansi_bytes))
}

#[tauri::command]
pub async fn interactive_stop(state: State<'_, AppState>, sid: String, force: bool) -> Result<(), String> {
    let host = state.host_for_session(&sid).await.ok_or_else(|| "session not found".to_string())?;
    let mode = if force {
        claudette::agent::interactive_protocol::StopMode::Force
    } else {
        claudette::agent::interactive_protocol::StopMode::Graceful
    };
    host.stop(&claudette::agent::interactive_host::SessionId(sid.clone()), mode)
        .await.map_err(|e| e.to_string())?;
    let db = claudette::db::Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.set_interactive_session_state(&sid, "stopped", None).map_err(|e| e.to_string())?;
    state.unregister_interactive_session(&sid).await;
    Ok(())
}

#[tauri::command]
pub async fn interactive_list_for_workspace(
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<Vec<claudette::db::InteractiveSessionRow>, String> {
    let db = claudette::db::Database::open(&state.db_path).map_err(|e| e.to_string())?;
    db.list_interactive_sessions_for_workspace(&workspace_id).map_err(|e| e.to_string())
}
```

Implementations for each follow the same pattern — call into `state.interactive_host_for(...)` then forward to the trait method.

- [ ] **Step 3: Register commands** in `src-tauri/src/main.rs` `tauri::generate_handler!` macro (alphabetical / by-domain — match existing order).

- [ ] **Step 4: Emit events to the webview.** Add an `attach` Tauri command that spawns a Tokio task subscribing to the `AttachStream` and emitting Tauri events `interactive://<sid>/output` (base64) and `interactive://<sid>/hook` (json). Reuse the existing `tauri::AppHandle::emit` pattern from `commands/chat.rs`.

- [ ] **Step 5: Build + clippy** the full app (Tauri included on the dev machine).

```bash
cd src-tauri && cargo build --features tauri/custom-protocol,server,voice,devtools,alternative-backends,pi-sdk
cargo clippy -p claudette -p claudette-server -p claudette-cli --all-targets --all-features
```

Expected: zero warnings, builds succeed.

- [ ] **Step 6: Commit.**

```bash
git add src-tauri
git commit -m "feat(tauri): interactive_start/send_input/attach/capture_screen/stop commands"
```

---

### Task F4: Bundle `claudette-session-host` via `externalBin`

**Files:**
- Modify: `src-tauri/Cargo.toml` (add `claudette-session-host` to `[dependencies]` or `[build-dependencies]` as needed for staging)
- Modify: `src-tauri/tauri.conf.json` (`bundle.externalBin`)
- Create / modify: `scripts/stage-session-host-sidecar.sh` (mirror the pi-harness staging script's shape)
- Modify: `scripts/stage-cli-sidecar.sh` (chain to the new script, mirroring how it chains to `stage-pi-harness-sidecar.sh`)

- [ ] **Step 1: Add the externalBin entry** in `tauri.conf.json`:

```json
{
  "bundle": {
    "externalBin": [
      "binaries/claudette-cli",
      "binaries/claudette-pi-harness",
      "binaries/claudette-session-host"
    ]
  }
}
```

- [ ] **Step 2: Stage script.** Create `scripts/stage-session-host-sidecar.sh` (copy from `scripts/stage-cli-sidecar.sh`):

```bash
#!/usr/bin/env bash
set -euo pipefail
TARGET_TRIPLE=$(rustc -vV | sed -n 's/host: //p')
TARGET_DIR=${CARGO_TARGET_DIR:-target}
mkdir -p src-tauri/binaries
cargo build -p claudette-session-host --release
src=${TARGET_DIR}/release/claudette-session-host$(rustc -vV | sed -n 's/host: //p' | grep -q windows && echo .exe || echo "")
dest=src-tauri/binaries/claudette-session-host-${TARGET_TRIPLE}$(echo "$src" | grep -q '\.exe$' && echo .exe || echo "")
cp -f "$src" "$dest"
echo "staged $dest"
```

(Cross-platform `.exe` suffix logic mirrors `stage-pi-harness-sidecar.sh` — check that file's actual shape and copy.)

- [ ] **Step 3: Chain from `stage-cli-sidecar.sh`** so `scripts/dev.sh`'s existing chain stages all three sidecars in one shot.

- [ ] **Step 4: Modify `scripts/macos-dev-app-runner.sh`** to also copy the staged session-host binary into the dev `.app`'s `Contents/MacOS/` next to the CLI / pi-harness.

- [ ] **Step 5: Verify staging.** Run: `bash scripts/stage-cli-sidecar.sh`. Expected: prints `staged …/claudette-session-host-…`.

- [ ] **Step 6: Run the app in dev.** `./scripts/dev.sh`. Verify the binary is alongside the others in the dev `.app`.

- [ ] **Step 7: Commit.**

```bash
git add src-tauri scripts
git commit -m "build(tauri): bundle claudette-session-host as externalBin sidecar"
```

---

## Phase G — UI integration

### Task G1: Experimental flag row in Settings

**Files:**
- Modify: `src/ui/src/components/settings/sections/ExperimentalSettings.tsx`
- Modify: `src/ui/src/components/settings/sections/ExperimentalSettings.test.tsx` (or sibling test if test naming differs)

- [ ] **Step 1: Find the existing pattern.** `grep -n "pluginManagementEnabled" src/ui/src/components/settings/sections/ExperimentalSettings.tsx`.

- [ ] **Step 2: Write failing test.** Add to the test file:

```tsx
it("toggles claudeInteractiveEnabled when the switch is clicked", async () => {
  const user = userEvent.setup();
  render(<ExperimentalSettings />);
  const sw = screen.getByLabelText(/claude.*interactive/i);
  expect(sw).not.toBeChecked();
  await user.click(sw);
  expect(useAppStore.getState().settings.claudeInteractiveEnabled).toBe(true);
});
```

- [ ] **Step 3: Run.** `cd src/ui && bun run test -t "claudeInteractiveEnabled"`. Expected: FAIL.

- [ ] **Step 4: Add the row to the component**, copying the `pluginManagementEnabled` row exactly:

```tsx
<SettingRow
  id="claudeInteractiveEnabled"
  label="Claude (Interactive)"
  description="Run interactive claude inside a detachable host (tmux on Unix, sidecar on Windows). Survives Claudette closing."
  checked={settings.claudeInteractiveEnabled}
  onChange={(v) => setSetting("claudeInteractiveEnabled", v)}
/>
```

- [ ] **Step 5: Run test + tsc + lint + css-lint.** All pass. Commit.

```bash
cd src/ui && bunx tsc -b && bun run lint && bun run lint:css && bun run test
cd ../..
git add src/ui/src/components/settings/sections/ExperimentalSettings.tsx src/ui/src/components/settings/sections/ExperimentalSettings.test.tsx
git commit -m "feat(ui): add Claude (Interactive) toggle to Experimental settings"
```

---

### Task G2: Runtime card for Claude (Interactive) in Models settings

**Files:**
- Modify: `src/ui/src/components/settings/sections/ModelsSettings.tsx` (or wherever the Runtime sub-section lives — search `Runtime`)
- Modify: matching test

- [ ] **Step 1: Test.** Add to the Runtime section's test file (e.g., `ModelsSettings.test.tsx`):

```tsx
import { render, screen } from "@testing-library/react";
import { useAppStore } from "../../../store";

it("renders Interactive runtime card disabled when claudeInteractiveEnabled is false", () => {
  useAppStore.setState({ settings: { ...useAppStore.getState().settings, claudeInteractiveEnabled: false } });
  render(<ModelsSettings />);
  const card = screen.getByTestId("runtime-card-claude-interactive");
  expect(card).toHaveAttribute("aria-disabled", "true");
  expect(card).toHaveTextContent(/enable in experimental/i);
});

it("renders Interactive runtime card selectable when flag is on", () => {
  useAppStore.setState({ settings: { ...useAppStore.getState().settings, claudeInteractiveEnabled: true } });
  render(<ModelsSettings />);
  const card = screen.getByTestId("runtime-card-claude-interactive");
  expect(card).not.toHaveAttribute("aria-disabled", "true");
});
```

- [ ] **Step 2: Implement.** Add a new card matching the existing Runtime card pattern (find an existing one in `ModelsSettings.tsx` and duplicate its JSX shape — Ollama or Codex Native is a good template). Set `data-testid="runtime-card-claude-interactive"`, `aria-disabled={!settings.claudeInteractiveEnabled}` and conditionally render the "Enable in Experimental" text when disabled. Click-handler must noop when disabled.

- [ ] **Step 3: Run tests + tsc + lint. Commit.**

```bash
cd src/ui && bunx tsc -b && bun run lint && bun run lint:css && bun run test
cd ../..
git add src/ui/src/components/settings/sections/ModelsSettings.tsx
git commit -m "feat(ui): expose Claude (Interactive) runtime card gated by experimental flag"
```

---

### Task G3: Tauri bridge service `interactive.ts`

**Files:**
- Create: `src/ui/src/services/interactive.ts`
- Create: `src/ui/src/services/interactive.test.ts`

- [ ] **Step 1: Define the API surface** in `services/interactive.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

export interface StartInteractiveArgs {
  workspaceId: string;
  workingDir: string;
  rows: number;
  cols: number;
  claudeBinary: string;
  claudeArgs: string[];
}

export interface StartInteractiveResult {
  sid: string;
  hostKind: string;
}

export async function startInteractive(args: StartInteractiveArgs): Promise<StartInteractiveResult> {
  return invoke<StartInteractiveResult>("interactive_start", { args });
}

export async function sendInput(sid: string, text: string): Promise<void> {
  return invoke("interactive_send_input", { sid, text });
}

export async function captureScreen(sid: string): Promise<string> {
  return invoke<string>("interactive_capture_screen", { sid });
}

export async function stopInteractive(sid: string, force = false): Promise<void> {
  return invoke("interactive_stop", { sid, force });
}

export interface OutputEvent { sid: string; bytesB64: string; seq: number; }
export interface HookEvent { sid: string; kind: "stop" | "awaiting" | "prompt_submitted" | "subagent_stop" | "unknown"; reason?: string; }

export async function subscribeOutput(sid: string, fn: (ev: OutputEvent) => void): Promise<UnlistenFn> {
  return listen<OutputEvent>(`interactive://${sid}/output`, (e) => fn(e.payload));
}
export async function subscribeHooks(sid: string, fn: (ev: HookEvent) => void): Promise<UnlistenFn> {
  return listen<HookEvent>(`interactive://${sid}/hook`, (e) => fn(e.payload));
}
```

- [ ] **Step 2: Vitest mock.** In the test file, mock `@tauri-apps/api/core` and `@tauri-apps/api/event`, then assert each function calls the right invoke command with the right payload. Run, expect PASS. Commit.

```bash
cd src/ui && bunx tsc -b && bun run lint && bun run test
cd ../..
git add src/ui/src/services/interactive.ts src/ui/src/services/interactive.test.ts
git commit -m "feat(ui): add interactive Tauri bridge service"
```

---

### Task G4: Hook-delimited turn assembler

**Files:**
- Create: `src/ui/src/hooks/useInteractiveTurnAssembler.ts`
- Create: `src/ui/src/hooks/useInteractiveTurnAssembler.test.ts`

- [ ] **Step 1: Test cases** to write before the code (all in one file):

```ts
describe("useInteractiveTurnAssembler", () => {
  it("emits a turn on Stop", () => { /* feed UserPromptSubmit, OUTPUT, Stop; assert one turn collected */ });
  it("clears awaiting badge when UserPromptSubmit fires", () => { /* feed Awaiting then UserPromptSubmit; assert badge cleared */ });
  it("ignores duplicate awaiting events", () => { /* feed Awaiting, Awaiting; assert flag is true only once */ });
  it("flips to crashed state on Exit event", () => { /* feed Exit; assert state.crashed = true */ });
  it("falls back to raw_kind for unknown hooks", () => { /* feed unknown kind; assert turn still progresses */ });
});
```

- [ ] **Step 2: Run.** `cd src/ui && bun run test -t useInteractiveTurnAssembler`. Expected: FAIL.

- [ ] **Step 3: Implement** as a pure reducer (`assemblerReducer(state, ev) -> newState`) + a thin React hook around `useReducer`. Reducer takes:

```ts
type Event =
  | { type: "output"; bytes: Uint8Array; seq: number }
  | { type: "hook"; kind: HookEvent["kind"]; reason?: string }
  | { type: "exit"; reason: string };

interface AssemblerState {
  turns: { id: number; bytes: Uint8Array; status: "live" | "done" | "crashed" }[];
  awaitingInput: boolean;
  crashed: boolean;
}
```

Reducer logic: `UserPromptSubmit` opens a new turn; `OUTPUT` appends to current turn (or to a transient "before first prompt" turn); `Stop` marks current turn done; `Awaiting` flips `awaitingInput`; `UserPromptSubmit` clears `awaitingInput`; `Exit` marks current turn crashed and sets `state.crashed`.

- [ ] **Step 4: Run, tsc, lint. Commit.**

```bash
cd src/ui && bunx tsc -b && bun run lint && bun run test -t useInteractiveTurnAssembler
cd ../..
git add src/ui/src/hooks/useInteractiveTurnAssembler.ts src/ui/src/hooks/useInteractiveTurnAssembler.test.ts
git commit -m "feat(ui): hook-delimited turn assembler for interactive sessions"
```

---

### Task G5: Per-turn embedded xterm.js view

**Files:**
- Create: `src/ui/src/components/chat/InteractiveTurnView.tsx`
- Create: `src/ui/src/components/chat/InteractiveTurnView.test.tsx`

- [ ] **Step 1: Test outline.**

```tsx
it("writes incoming bytes into xterm.js", async () => {
  const { container } = render(<InteractiveTurnView bytes={new TextEncoder().encode("hello\r\n")} />);
  await waitFor(() => expect(container.textContent).toContain("hello"));
});
```

xterm.js writes asynchronously — use `waitFor`.

- [ ] **Step 2: Implement.** Use the same imports as `TerminalPanel.tsx` (`@xterm/xterm`, `@xterm/addon-fit`). One xterm.js instance per `<InteractiveTurnView>` mount; on unmount, dispose. Resize via `FitAddon`.

- [ ] **Step 3: Run, tsc, lint. Commit.**

```bash
cd src/ui && bunx tsc -b && bun run lint && bun run test -t InteractiveTurnView
cd ../..
git add src/ui/src/components/chat/InteractiveTurnView.tsx src/ui/src/components/chat/InteractiveTurnView.test.tsx
git commit -m "feat(ui): InteractiveTurnView renders per-turn xterm.js"
```

---

### Task G6: ChatPanel conditional render + full-terminal toggle

**Files:**
- Modify: `src/ui/src/components/chat/ChatPanel.tsx` (god file — only the minimal hook here)
- Create: `src/ui/src/components/chat/InteractiveTerminalMode.tsx` (full-terminal view)
- Modify: matching tests

- [ ] **Step 1: Check the god-file rule.** `ChatPanel.tsx` is on the avoid-piling-on list. The minimum here is to read `useInteractiveTurnAssembler` and render `InteractiveTurnView` per turn — that's two new imports and one conditional. Acceptable. The full-terminal view is its own new file.

- [ ] **Step 2: Tests.** Mock the bridge + assembler; render ChatPanel with `backend.kind === "ClaudeInteractive"` and assert it renders `InteractiveTurnView`s. Render with `backend.kind === "ClaudeCode"` and assert the existing render path still works (regression).

- [ ] **Step 3: Implement.** In ChatPanel, after the existing turn-render loop, add a branch:

```tsx
{backend.kind === "ClaudeInteractive" ? (
  <InteractiveTurns workspaceId={workspaceId} sid={sid} />
) : (
  /* existing rendering */
)}
```

`InteractiveTurns` is a small sibling component (also new) wrapping `useInteractiveTurnAssembler` + the list of `InteractiveTurnView`s. Putting it in a sibling keeps ChatPanel diff small.

- [ ] **Step 4: Implement `InteractiveTerminalMode.tsx`** — full-size xterm.js attached to the same sid, plus a "Back to chat" button. Triggered from the chat header (modify the header component — find it via `grep -rn "ChatHeader" src/ui/src/components/chat`).

- [ ] **Step 5: Run, tsc, lint, css-lint. Commit.**

```bash
cd src/ui && bunx tsc -b && bun run lint && bun run lint:css && bun run test
cd ../..
git add src/ui/src/components/chat
git commit -m "feat(ui): wire ChatPanel to interactive backend (embedded + full-terminal modes)"
```

---

### Task G7: Sidebar badges (Awaiting / Detached / Crashed)

**Files:**
- Modify: `src/ui/src/components/sidebar/Sidebar.tsx` (god file — be surgical)
- Create: `src/ui/src/components/sidebar/InteractiveBadge.tsx` (so the diff to Sidebar.tsx is one import + one render)
- Modify: matching test

- [ ] **Step 1: Test.** Render `InteractiveBadge` with each state and assert the rendered text/title.

- [ ] **Step 2: Implement** the component (~40 lines), reusing the existing attention-badge color tokens (`var(--accent-attention)`, `var(--muted)`, etc.).

- [ ] **Step 3: Wire into Sidebar.tsx** with a single new import + one conditional `<InteractiveBadge state={...} />` next to the row's existing badge slot.

- [ ] **Step 4: Run, tsc, lint, css-lint. Commit.**

```bash
git add src/ui/src/components/sidebar
git commit -m "feat(ui): sidebar badges for interactive session state"
```

---

### Task G8: `tmux attach` copy-string menu item (Unix)

**Files:**
- Modify: wherever the workspace/session context menu is built (search `Workspace.*ContextMenu` in `src/ui/src/components/sidebar`)

- [ ] **Step 1: Test** the menu rendering: when `hostKind === "tmux"` and on Unix, the "Copy `tmux attach` command" item appears; otherwise it doesn't.

- [ ] **Step 2: Implement.** Compose the command:

```ts
const cmd = `tmux attach-session -t ${sid}`;
await navigator.clipboard.writeText(cmd);
toast.info(`Copied: ${cmd}`);
```

Detect OS via `import.meta.env.TAURI_PLATFORM` or a Tauri command — match how the rest of the app handles OS gating.

- [ ] **Step 3: Run, commit.**

```bash
git add src/ui/src/components/sidebar
git commit -m "feat(ui): copy tmux attach command for interactive sessions on Unix"
```

---

## Phase H — Lifecycle: reattach, cleanup, orphans

### Task H1: Reattach-on-startup

**Files:**
- Modify: `src-tauri/src/state.rs` or the existing startup function in `src-tauri/src/main.rs`/`commands/workspace.rs`

- [ ] **Step 1: Test.** Use a mock host so the test doesn't need a real tmux/sidecar:

```rust
#[tokio::test]
async fn reattach_on_startup_classifies_rows() {
    use claudette::agent::interactive_host::{HostSessionSummary, HostStatus, InteractiveHost, SessionId};
    use std::sync::Arc;

    let dir = tempfile::tempdir().unwrap();
    let db = claudette::db::Database::open(&dir.path().join("t.db")).unwrap();
    db.run_migrations().unwrap();
    db.insert_workspace_for_test("ws-1").unwrap();
    for (sid, state) in [
        ("claudette-ws1-aaaaaaaa", "running"),
        ("claudette-ws1-bbbbbbbb", "running"),
        ("claudette-ws1-cccccccc", "detached"),
    ] {
        db.create_interactive_session(&claudette::db::InteractiveSessionRow {
            sid: sid.into(),
            workspace_id: "ws-1".into(),
            host_kind: "tmux".into(),
            state: state.into(),
            crash_reason: None,
            created_at: "2026-05-16T00:00:00Z".into(),
            last_attached_at: None,
            last_screen_blob: None,
            claude_flags_json: "[]".into(),
            pid: None,
        }).unwrap();
    }

    // Host knows about A and C only.
    let host: Arc<dyn InteractiveHost> = Arc::new(MockHost {
        status_response: HostStatus {
            host_version: "mock".into(),
            sessions: vec![
                HostSessionSummary { sid: SessionId("claudette-ws1-aaaaaaaa".into()), pid: None, running: true },
                HostSessionSummary { sid: SessionId("claudette-ws1-cccccccc".into()), pid: None, running: true },
            ],
        },
    });

    crate::interactive::reattach_pending(&db, &host).await.unwrap();

    assert_eq!(db.get_interactive_session("claudette-ws1-aaaaaaaa").unwrap().unwrap().state, "detached");
    let b = db.get_interactive_session("claudette-ws1-bbbbbbbb").unwrap().unwrap();
    assert_eq!(b.state, "crashed");
    assert_eq!(b.crash_reason.as_deref(), Some("host missing"));
    assert_eq!(db.get_interactive_session("claudette-ws1-cccccccc").unwrap().unwrap().state, "detached");
}

// Minimal mock — paste alongside the test.
struct MockHost { status_response: claudette::agent::interactive_host::HostStatus }
#[async_trait::async_trait]
impl claudette::agent::interactive_host::InteractiveHost for MockHost {
    async fn ensure_session(&self, _: &claudette::agent::interactive_host::SessionId, _: &claudette::agent::interactive_protocol::SessionSpec) -> Result<claudette::agent::interactive_host::HostHandle, claudette::agent::interactive_host::HostError> { unimplemented!() }
    async fn attach(&self, _: &claudette::agent::interactive_host::SessionId) -> Result<(claudette::agent::interactive_host::AttachId, claudette::agent::interactive_host::AttachStream), claudette::agent::interactive_host::HostError> { unimplemented!() }
    async fn send_input(&self, _: &claudette::agent::interactive_host::SessionId, _: claudette::agent::interactive_protocol::InputPayload) -> Result<(), claudette::agent::interactive_host::HostError> { unimplemented!() }
    async fn capture_screen(&self, _: &claudette::agent::interactive_host::SessionId) -> Result<claudette::agent::interactive_host::ScreenSnapshot, claudette::agent::interactive_host::HostError> { unimplemented!() }
    async fn resize(&self, _: &claudette::agent::interactive_host::SessionId, _: u16, _: u16) -> Result<(), claudette::agent::interactive_host::HostError> { unimplemented!() }
    async fn detach(&self, _: &claudette::agent::interactive_host::SessionId, _: claudette::agent::interactive_host::AttachId) -> Result<(), claudette::agent::interactive_host::HostError> { unimplemented!() }
    async fn stop(&self, _: &claudette::agent::interactive_host::SessionId, _: claudette::agent::interactive_protocol::StopMode) -> Result<(), claudette::agent::interactive_host::HostError> { unimplemented!() }
    async fn status(&self) -> Result<claudette::agent::interactive_host::HostStatus, claudette::agent::interactive_host::HostError> { Ok(self.status_response.clone()) }
}
```

- [ ] **Step 2: Implement.** Iterate over `interactive_sessions` where `state = 'running'`. For each, call `host.status()` once (cached per host_kind). For each row: if host knows about it, mark `detached` (we will re-attach on workspace open); else mark `crashed`.

- [ ] **Step 3: Run, clippy, commit.**

```bash
git add src-tauri
git commit -m "feat(tauri): reattach surviving interactive sessions on startup"
```

---

### Task H2: Per-workspace cleanup on archive/delete

**Files:**
- Modify: the existing workspace-archive / workspace-delete code path (`grep -n "archive_workspace\|delete_workspace" src-tauri/src/commands`)

- [ ] **Step 1: Test.** Insert an `interactive_sessions` row pointing at a workspace; call the workspace-delete command (or its inner function); assert the row is gone AND that the host's `stop` was called (mock the host in test).

- [ ] **Step 2: Implement** the call chain: before deleting workspace row, enumerate interactive sessions for that workspace and call `host.stop(sid, Graceful)` on each. The DB `ON DELETE CASCADE` then removes the rows.

- [ ] **Step 3: Run, commit.**

```bash
git add src-tauri
git commit -m "feat(tauri): stop interactive sessions when workspaces are deleted"
```

---

### Task H3: Orphaned session detection

**Files:**
- Modify: same startup function as Task H1

- [ ] **Step 1: Test.** Host reports a `claudette-<workspace>-<sid>` session that the DB has no row for → state contains an `orphans` list with that sid.

- [ ] **Step 2: Implement.** During startup, compute `host_sessions - db_sessions` for sessions matching the `claudette-` prefix. Surface them as a tray notification + clean-up action.

- [ ] **Step 3: UI side.** Add a one-shot toast / banner with a "Clean up" button that calls a new `interactive_cleanup_orphans` command (which iterates and stops each).

- [ ] **Step 4: Run, commit.**

```bash
git add src-tauri src/ui
git commit -m "feat(interactive): detect and clean up orphaned interactive sessions"
```

---

## Phase I — Docs + alignment files

### Task I1: User-facing docs page

**Files:**
- Create: `site/src/content/docs/features/interactive-claude.mdx`
- Modify: `site/astro.config.mjs` (sidebar nav)
- Modify: `site/src/content/docs/features/settings.mdx` (reference table row)

- [ ] **Step 1: Write the docs page** using this scaffold (fill prose around each heading; do not leave any heading without content):

```mdx
---
title: Claude (Interactive)
description: Run interactive claude inside a detachable host that survives Claudette closing.
---

import { Aside } from "@astrojs/starlight/components";

<Aside type="caution">Experimental. Enable in **Settings → Experimental → Claude (Interactive)**.</Aside>

## What it is

Claude (Interactive) is an alternate agent backend that runs the interactive
`claude` TUI (no `--print`) inside a host process that outlives Claudette:
- On macOS and Linux: tmux (≥ 3.0).
- On Windows: a bundled sidecar `claudette-session-host`.

Sessions survive closing Claudette, OS sleep, and Claudette crashes. They do
not survive a host crash (tmux server kill, sidecar crash).

## When to use it

- You want claude's native plan-mode and slash-command UI.
- You want to keep a long-running session open across Claudette restarts.
- On Unix, you want to attach to the same session from an external terminal.

## When not to use it

- You rely on attachments (images, files) sent through the chat composer —
  v1 does not pipe stream-json into interactive claude; use slash commands
  (`/file …`) instead.
- You want fully cross-machine session sharing — v1 is local-only.

## Enabling it

1. Settings → Experimental → toggle **Claude (Interactive)** on.
2. Open a workspace → Settings → Models → Runtime → pick **Claude (Interactive)**.
3. (Unix only) Confirm `tmux -V` reports ≥ 3.0; otherwise install tmux first.

## Hooks that fire

Claudette registers three Claude Code hooks via a transient
`CLAUDE_CONFIG_DIR` overlay:

| Hook | Effect inside Claudette |
|---|---|
| `Stop` | Marks the turn complete. |
| `Notification` | Surfaces an "Awaiting input" badge + OS notification. |
| `UserPromptSubmit` | Clears the awaiting badge and starts a new turn. |

The overlay is removed when the session is stopped.

## Attaching from an external terminal (Unix)

Right-click the session in the sidebar → **Copy tmux attach command**, then
paste into any terminal:

```bash
tmux attach-session -t claudette-<workspace>-<sid>
```

<Aside type="note">Typing in an external attach bypasses Claudette's hook-delimited turn assembly. Use it for inspection; type new prompts in Claudette.</Aside>

## Stopping a session

Sidebar → session row → **Stop**. Graceful by default (`Ctrl+C`, then SIGTERM, then SIGKILL).
The "Force" link in the confirm dialog skips straight to SIGKILL.

## Crash recovery

If tmux or the sidecar dies, sessions are marked **Crashed**. Start a new
session from the same workspace — there is no recovery beyond what claude's
own `/resume` provides.

## Limitations (v1)

- Attachments (image / file uploads) are not routed through the chat composer.
- A separate xterm.js renders the session — native renderer is a follow-up.
- External tmux input can confuse turn assembly (documented above).
```

- [ ] **Step 2: Add sidebar entry** to `site/astro.config.mjs`. Use the existing pattern for `features/diagnostics.mdx` as the template.

- [ ] **Step 3: Add the settings row** to `settings.mdx` under the appropriate `## Section`. Include flag name, default, what it gates.

- [ ] **Step 4: Build the docs site** to verify it compiles. Run (from `site/`): `bun install && bun run build`. Expected: succeeds.

- [ ] **Step 5: Commit.**

```bash
git add site
git commit -m "docs(site): describe interactive-claude experimental backend"
```

---

### Task I2: CLAUDE.md sync

**Files:**
- Modify: `CLAUDE.md`
- Modify: `.github/copilot-instructions.md`

- [ ] **Step 1: Add a section** to `CLAUDE.md` under the agent-integration paragraph documenting:

  - The new `ClaudeInteractive` harness kind, gated by `claudeInteractiveEnabled`.
  - The two-host model (tmux on Unix, `claudette-session-host` sidecar on Windows + opt-in Unix fallback).
  - Where the wire protocol lives (`src/agent/interactive_protocol.rs`).
  - Hook plumbing (`claudette-cli chat hook` → IPC ingest in `src-tauri/src/ipc.rs`).
  - Add `src-session-host/` to the crate table.
  - Add `claudette-session-host` to the externalBin list.
  - Add `InteractiveTurnView.tsx`, the new chat surface, and the assembler hook to the frontend tour.
  - Add the experimental flag and Models > Runtime card under settings.

- [ ] **Step 2: Mirror the same changes in `.github/copilot-instructions.md`** per the alignment rule in CLAUDE.md.

- [ ] **Step 3: Commit.**

```bash
git add CLAUDE.md .github/copilot-instructions.md
git commit -m "docs: document interactive-claude backend in CLAUDE.md + copilot instructions"
```

---

## Self-review checklist (run after every Phase)

After completing each Phase A–I, run **all four** before marking it done:

1. `cargo fmt --all` — must produce zero diff.
2. `cargo clippy -p claudette -p claudette-server -p claudette-cli -p claudette-session-host --all-targets --all-features` — zero warnings.
3. `cargo test -p claudette -p claudette-server -p claudette-cli -p claudette-session-host --all-features` — all pass.
4. `cd src/ui && bunx tsc -b && bun run lint && bun run lint:css && bun run test` — all pass.

On a Unix machine, additionally run: `cargo test -p claudette tmux_passes_conformance --ignored -- --nocapture`.

On any machine with the session-host binary built, additionally run: `cargo test -p claudette sidecar_passes_conformance --ignored -- --nocapture`.

---

## Done criteria

The feature is shippable when **all** of these are true:

- All tasks A1–I2 are checked.
- `claudeInteractiveEnabled` defaults to `false` in a fresh install (Task A1 / A2).
- With the flag on and tmux installed, manual flow on macOS or Linux works end-to-end: create workspace → switch backend → send a turn → see hook badge → close Claudette → reopen → see reattached session.
- With the flag on and no tmux installed, Unix users see a clear "install tmux" message and the sidecar fallback works.
- Windows manual flow works against the sidecar.
- The user-facing docs page and the settings reference row exist and the site builds.
- CLAUDE.md and `.github/copilot-instructions.md` describe the new backend.
- CI passes (Rust + frontend, all platforms).
