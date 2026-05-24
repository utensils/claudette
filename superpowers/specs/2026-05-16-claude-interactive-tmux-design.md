# Interactive Claude Sessions (tmux / Sidecar Host) — Design

- **Date:** 2026-05-16
- **Status:** Design — pending implementation plan
- **Scope:** Add a new agent backend that runs `claude` interactively in a detachable host (tmux on Unix, custom Rust sidecar on Windows), gated behind an experimental flag. Coexists with the existing `claude --print` path; does not replace it.

## Goals

1. **Detachability / resilience.** A Claude session survives Claudette closing, crashing, or restarting. On Unix, the same session is reachable from an external terminal via `tmux attach`.
2. **Full Claude Code TUI parity.** Run the interactive `claude` binary, not `claude --print`. Pick up features that the interactive client gets first (slash-command UI, plan-mode polish, native permission prompts, hooks).
3. **Foundation for renderer perf.** The protocol leaves explicit room for swapping byte-streaming for grid-diff streaming and for native renderers later, but renderer work is **not** in this spec.

## Non-goals (v1)

- Replacing the `claude --print` backend. The new backend lives alongside.
- Native terminal widgets (libGhostty, wezterm-gui, alacritty_terminal as a renderer). Renderer perf is a separate follow-up spec.
- Sharing or transferring running sessions between workspaces or users.
- Remote (over-WebSocket) interactive sessions. Sidecar IPC is local-only in v1.
- Subagents-as-interactive-sessions. Each subagent today is its own `claude -p` and stays that way.

## Decision summary

| Decision | Choice | Why |
|---|---|---|
| Replace `-p` or add alongside? | **Add alongside**, opt-in via experimental flag | Existing `-p` flow is stable; new code path de-risks rollout. |
| Host implementation | **tmux on Unix + custom Rust sidecar on Windows** | Real tmux on Unix gives users `tmux attach` for free; Windows has no tmux. Two code paths accepted, capped by a shared trait-conformance test suite. |
| Awaiting-input signal | **Claude Code hooks** (`Stop`, `Notification`, `UserPromptSubmit`) | Structured, official, version-stable; no fragile output parsing. |
| Streaming format in v1 | **Raw VT bytes + interleaved hook events** | Smallest delta to existing xterm.js infrastructure. Grid-diff path is a future addition, not a rewrite. |
| Renderer | **Existing xterm.js (no WebGL upgrade required in this spec)** | Renderer perf is its own spec. Protocol designed to allow swap later. |
| Experimental flag | `claudeInteractiveEnabled` in Settings → Experimental | Matches existing `pluginManagementEnabled` shape. |

## Architecture

### New crate

A new workspace member: **`claudette-session-host`** at `src-session-host/`. Sibling to `claudette-cli` and `claudette-server`. Built for all platforms (gives Unix users a fallback if tmux is unavailable, and gives the test suite a single binary to drive on every CI runner). Bundled into the Tauri app via `bundle.externalBin`, same mechanism as `claudette-pi-harness`.

The sidecar owns interactive Claude PTYs via `portable-pty` and exposes a line-framed JSON protocol over a Unix domain socket / Named Pipe. It maintains an in-memory grid model per session via `alacritty_terminal` (used only for `capture_screen` snapshots in v1; full grid-diff streaming is deferred).

### Backend kind and routing

A new agent backend kind `ClaudeInteractive` is added to `src/agent/harness.rs`. Routing in `src/agent_backend.rs::effective_harness` recognises the kind and dispatches to a new module `src/agent/claude_interactive.rs` instead of the existing `src/agent/process.rs` `--print` path. The kind is only selectable when `claudeInteractiveEnabled = true`.

### `InteractiveHost` trait

`src/agent/interactive_host/mod.rs` defines:

```rust
#[async_trait]
pub trait InteractiveHost: Send + Sync {
    async fn ensure_session(&self, sid: &SessionId, spec: &SessionSpec) -> Result<HostHandle>;
    async fn attach(&self, sid: &SessionId) -> Result<AttachStream>;     // streams OutputDelta + HookFired
    async fn send_input(&self, sid: &SessionId, payload: InputPayload) -> Result<()>;
    async fn capture_screen(&self, sid: &SessionId) -> Result<ScreenSnapshot>;
    async fn resize(&self, sid: &SessionId, rows: u16, cols: u16) -> Result<()>;
    async fn detach(&self, sid: &SessionId, attach_id: AttachId) -> Result<()>;
    async fn stop(&self, sid: &SessionId, mode: StopMode) -> Result<()>;
    async fn status(&self) -> Result<HostStatus>;
}
```

Two implementations:

- **`src/agent/interactive_host/tmux.rs`** (Unix only). Shells out to `tmux` via `tokio::process::Command`. Operations map as documented in the protocol section below.
- **`src/agent/interactive_host/sidecar.rs`** (all platforms). Connects to the bundled `claudette-session-host` over the IPC transport.

A shared conformance test suite (`src/agent/interactive_host/conformance.rs`) takes any `InteractiveHost` and runs the full lifecycle test. Both impls must pass it.

### Host selection at runtime

- **Windows:** always sidecar.
- **Unix:** prefer tmux if `which tmux` succeeds AND `tmux -V` reports ≥ 3.0. Otherwise fall back to sidecar (only if explicitly enabled by the user in Settings; do not silently switch hosts).
- Availability is cached with a 30-second TTL and re-checked at each `ensure_session` and on every reattach.

If a workspace has rows with `host_kind = "tmux"` and tmux is no longer available at startup, those rows transition to `state = "crashed"` with `crash_reason = "tmux unavailable"`. The UI surfaces an "install tmux" hint with platform-specific commands.

### Session identity

```
SessionId = "claudette-<workspace_id_short>-<sid8>"
```

`sid8` is 8 hex chars from a CSPRNG. The session name is identical between tmux's session-name namespace and the sidecar's session-key namespace — making `tmux attach -t <SessionId>` directly usable on Unix.

## Sidecar wire protocol

Length-prefixed JSON-line frames over `interprocess::local_socket` (Unix domain socket on macOS/Linux, Named Pipe on Windows). Same crate already used by `claudette-cli`.

Default socket paths:
- Unix: `${TMPDIR:-/tmp}/claudette-session-host/<user>.sock`
- Windows: `\\.\pipe\claudette-session-host-<user>`

### Handshake

Every new connection first exchanges:

```jsonc
// client → server
{ "kind": "hello", "protocol_version": 1, "claudette_version": "..." }
// server → client
{ "kind": "hello_ack", "protocol_version": 1, "host_version": "...", "pid": 12345 }
```

Version mismatch returns `hello_nack { "reason": "...", "supported_versions": [1] }` and the client surfaces a "restart Claudette to update the session host" error.

### Request kinds

| Kind | Payload | Response | Notes |
|---|---|---|---|
| `ensure_session` | `{sid, spec: SessionSpec}` | `SessionStarted{sid, pid, rows, cols}` | Idempotent. Returns existing if already running. |
| `attach` | `{sid}` | streaming `OutputDelta` + `HookFired` events until detach | Multiple concurrent attaches per session allowed. |
| `send_input` | `{sid, payload: InputPayload}` | `Ok` | `InputPayload` = `Text{string}` or `Keys{name}` (e.g. `"C-c"`). |
| `capture_screen` | `{sid}` | `ScreenSnapshot{rows, cols, ansi_bytes}` | v1 returns ANSI replay bytes; v2 may add `cells`. |
| `resize` | `{sid, rows, cols}` | `Ok` | |
| `detach` | `{sid, attach_id}` | `Ok` | |
| `stop` | `{sid, mode: "graceful"|"force"}` | `Stopped{exit_status}` | Graceful = `C-c`, then SIGTERM after 5s, then SIGKILL. |
| `status` | `{}` | `HostStatus{sessions: [...], host_version}` | |

### Streamed events (over an open `attach`)

| Kind | Payload |
|---|---|
| `output` | `OutputDelta{bytes: base64, seq: u64}` |
| `hook` | `HookFired{kind: "stop"|"awaiting"|"prompt_submitted"|..., payload: opaque}` |
| `exit` | `SessionExited{sid, exit_status, reason}` |
| `error` | `StreamError{message, recoverable: bool}` |

`seq` is monotonic per session and per attach so clients can detect dropped frames.

## tmux mapping (Unix)

| Trait op | tmux command |
|---|---|
| `ensure_session` | `tmux new-session -d -s <sid> -x <cols> -y <rows> -e CLAUDE_CONFIG_DIR=<tmpdir> claude <flags…>` |
| `attach` | `tmux pipe-pane -O -t <sid> 'cat >> $output_fifo'` (once per session), then tail the fifo per Claudette-side attach |
| `send_input` (text) | `tmux send-keys -t <sid> -l -- <payload>` |
| `send_input` (key) | `tmux send-keys -t <sid> -- <keyname>` (e.g. `C-c`, `Enter`) |
| `capture_screen` | `tmux capture-pane -t <sid> -pJ -e` |
| `resize` | `tmux resize-window -t <sid> -x <cols> -y <rows>` |
| `stop` (graceful) | `send-keys C-c` → wait 5s → `kill-session` |
| `stop` (force) | `tmux kill-session -t <sid>` |
| `status` | `tmux list-sessions -F '#{session_name}|#{session_created}|#{session_attached}'`, filtered to `claudette-…` prefix |

The `pipe-pane` output FIFO lives under `${TMPDIR}/claudette-session-host/<user>/<sid>.fifo`. Claudette tails it; each tailer is one "attach" in `InteractiveHost` terms.

A periodic 30-second reconciliation job (`tmux list-sessions`) cross-checks our DB against reality and flips state for sessions killed externally.

## Awaiting-input signal — Claude Code hooks

At `ensure_session` time, Claudette materialises a per-session settings overlay directory at `${TMPDIR}/claudette-session-host/<user>/<sid>/claude-config/` and exports `CLAUDE_CONFIG_DIR` pointing at it when spawning the `claude` process. This keeps the overlay transient and per-session — we never write to the user's real `~/.claude/` or to `.claude/settings.local.json`. The overlay directory is removed when the session is stopped.

The overlay registers hooks whose command strings use the **absolute path** to the bundled `claudette-cli` binary, resolved once at sidecar / Claudette startup (via `tauri::path::resolve_resource` or the CLI's `current_exe` lookup) and burned into the rendered `settings.json`. We do not assume `claudette-cli` is on `PATH` inside the spawned `claude` process.

| Hook | Maps to |
|---|---|
| `Stop` | `<abs-cli-path> chat hook --sid $SID --kind stop` |
| `Notification` | `<abs-cli-path> chat hook --sid $SID --kind awaiting --reason "$REASON"` |
| `UserPromptSubmit` | `<abs-cli-path> chat hook --sid $SID --kind prompt_submitted` |
| `SubagentStop` *(optional)* | `<abs-cli-path> chat hook --sid $SID --kind subagent_stop` |

`claudette-cli chat hook` is a new subcommand that writes the structured event to the existing CLI IPC socket. The running GUI's IPC server ingests hook events the same way it ingests other CLI commands today (`src-tauri/src/ipc.rs`). No new transport.

**Schema fallback.** Each incoming hook payload is parsed against a versioned schema. On parse failure, we still emit a degraded `HookFired{kind: "unknown_hook", payload: raw_text}` event so the UI doesn't lock up, log a warning, and continue. Anthropic-side schema drift becomes a visible warning, not a silent break.

**Watchdog (deferred).** A future `tcgetattr`-based TTY-mode poll could detect "claude is in input state" as a coarse-grained fallback if hooks fail to fire. Not in v1.

## UI integration

### Experimental flag

A new boolean in `app_settings`: `claudeInteractiveEnabled`. Rendered in **Settings → Experimental** alongside `pluginManagementEnabled`. Default `false`. When false, the "Claude (Interactive)" runtime card in Models → Runtime is greyed out with "Enable in Experimental" text.

### Backend selection

When the user picks "Claude (Interactive)" as a workspace's runtime, the chat-send resolver routes new turns to `claude_interactive.rs`. The first turn calls `ensure_session` lazily; subsequent turns call `send_input` with the user's text plus a carriage return.

### Chat surface

Two coexisting modes, both backed by the same session:

1. **In-chat embedded view (default).** Each active turn renders a small xterm.js instance inside its chat bubble, scoped to the bytes between `UserPromptSubmit` and `Stop` hook events (or the live cursor if mid-turn). Completed turns collapse to a static rendered transcript so the chat panel still feels like chat.
2. **Full-terminal view.** A chat-header toggle swaps the chat panel into a full-size xterm.js attached to the same session. Useful for plan mode, native permission prompts, debugging. Switching back keeps the session running. State is per-workspace and persists across reloads.

Both modes reuse the existing xterm.js setup; no new terminal renderer or new dependency in v1.

### Awaiting-input indicator

`Notification:awaiting` hook → set the session's badge to "Awaiting input" using the existing attention plumbing (the same surface that lights up for AskUserQuestion / ExitPlanMode in `-p` mode today). Fire the existing OS notification path via `tray.rs` (sound, click-to-navigate). The badge clears on `UserPromptSubmit` or after `Stop`.

No new notification infrastructure.

### Detach / reattach

- **Close Claudette with a running session.** Session stays alive in the host. DB row stays with `state = "running"`; sidebar shows "Detached" on next launch.
- **Reopen Claudette.** Boot path calls `interactive_host::status()` (per-host) and reconciles with DB. For each surviving session, we `capture_screen` to paint instantly, then `attach` for live updates. User sees a "Reattached" toast.
- **Power-user external attach (Unix only).** Session row's context menu copies `tmux attach-session -t <SessionId>`. Documented warning the first time: typing in an external attach can confuse Claudette's turn assembly because input bypasses `UserPromptSubmit` synthesis. Accepted v1 degradation.
- **Stop session button.** Confirm dialog → `stop` with `mode = "graceful"`. "Force kill" link in the dialog for `mode = "force"`.

## Persistence

A new migration `src/migrations/<UTC_TIMESTAMP>_interactive_sessions.sql`:

```sql
CREATE TABLE IF NOT EXISTS interactive_sessions (
    sid                TEXT PRIMARY KEY,
    workspace_id       TEXT NOT NULL,
    host_kind          TEXT NOT NULL,      -- "tmux" | "sidecar"
    state              TEXT NOT NULL,      -- "running" | "detached" | "stopped" | "crashed"
    crash_reason       TEXT,
    created_at         TEXT NOT NULL,
    last_attached_at   TEXT,
    last_screen_blob   BLOB,               -- ANSI replay bytes for instant repaint
    claude_flags_json  TEXT NOT NULL,
    pid                INTEGER,
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_interactive_sessions_workspace
    ON interactive_sessions(workspace_id);
```

`last_screen_blob` is ANSI bytes (the result of `capture_screen`) so reattach can paint instantly while the live stream catches up. Stored as a SQLite BLOB; an alternative is a sidecar file at `~/.claudette/sessions/<sid>.screen`. Open question — leaning toward BLOB for v1 (one fewer thing to clean up).

## Lifecycle and crash semantics

### Sidecar process lifecycle

- Launched lazily on first `ensure_session` call.
- Listens on the per-user socket path described above.
- Self-exits after **600 seconds** of zero live sessions AND zero connected clients (configurable).
- Survives Claudette quitting. On Claudette restart, the existing socket is detected via `status` round-trip; if reachable, we reuse it; if not, we launch a fresh sidecar.

### tmux server lifecycle

We do not own the tmux server. We use whatever the user runs. Our session names live entirely under the `claudette-…` prefix and we never operate on sessions outside that prefix.

### Crash matrix

| Failure | Behaviour |
|---|---|
| `claude` subprocess dies | `Stop` hook fires (or `exit` event from host); session row marked `state = "stopped"`; UI offers "Start a fresh session" or "Resume with `/resume`". |
| tmux server dies | All our tmux sessions die. We mark them `state = "crashed"` with `crash_reason = "tmux server died"`. Rare. |
| Sidecar dies | All sidecar sessions die. Same treatment. Sidecar relaunches on the next `ensure_session`. |
| Claudette GUI quits | Nothing dies in the host. Reattach on next launch. |

### Cleanup

- Per-workspace: `workspaces ON DELETE CASCADE` removes the rows; before delete, we call `stop` on each running session to also kill it in the host.
- Orphaned host-side sessions (host sees a `claudette-…` session that our DB doesn't know about): logged on startup, surfaced as a "found N orphaned sessions" toast with a "clean up" action. We never auto-kill.

## Testing

### Rust unit tests
- Wire-protocol serde round-trips for every request/response/event kind, including partial-read framing and oversized frames.
- `InteractiveHost` trait conformance suite (`src/agent/interactive_host/conformance.rs`) parameterised by host impl. Tests start, send, capture, detach, reattach, stop, status enumeration, idempotent double-start.
- Hook ingestion state machine: given a sequence of hook events, asserts session state transitions.

### Sidecar integration tests
- A small stub TUI program at `tests/fixtures/stub-tui/` (Rust binary). Echoes input lines with a prompt sentinel, supports an env-var-driven fake `Notification` hook, exits on `q\n`. Used in place of real `claude` so CI doesn't need the binary.
- Workspace-level integration tests at `tests/interactive_host_sidecar.rs` spawn a real `claudette-session-host` against the stub TUI on macOS, Linux, and Windows.

### tmux integration tests (Unix only)
- Same conformance suite at `tests/interactive_host_tmux.rs`, `#[cfg(unix)]`. CI Linux + macOS runners already have tmux; if absent, the test is `#[ignore]`d with a clear message.
- `TMUX_TMPDIR` per test to isolate concurrent runs.

### Frontend tests (vitest)
- Hook-delimited turn assembler given a sequence of `OutputDelta` + `HookFired` events.
- Backend-selector UI behaviour for the experimental flag, including the tmux-missing warning.
- Reattach toast logic on store hydrate.

### Acceptance gaps (documented)
- No real `claude` binary in CI; stub TUI is the contract. Real-binary smoke tests are manual + a nightly job (not blocking).
- External `tmux attach` from another terminal is not tested; warning-only mitigation.

## Phasing

### v1 (this spec)
1. `claudette-session-host` crate + Tauri externalBin bundling.
2. `InteractiveHost` trait + tmux + sidecar impls.
3. New backend kind `ClaudeInteractive`, gated by `claudeInteractiveEnabled`.
4. Settings overlay that registers Claude Code hooks routing to `claudette-cli chat hook`.
5. Migration for `interactive_sessions` table.
6. ChatPanel embedded turn view + full-terminal mode toggle.
7. Sidebar "Awaiting input", "Detached", and "Crashed" states.
8. Reattach-on-startup with `last_screen_blob` instant paint.
9. `tmux attach -t …` copy-string on Unix.
10. Test harness: stub TUI, conformance suite, frontend tests.
11. Docs: `site/src/content/docs/features/interactive-claude.mdx`, `settings.mdx` row, `CLAUDE.md` + `.github/copilot-instructions.md` sync.

### Deferred (named follow-up specs)
- **Renderer perf.** Move VT parsing fully server-side; ship grid-diff events; xterm.js WebGL addon; later possibly libGhostty / wezterm-gui native widget.
- **Multi-attach safety.** Mirror external-`tmux attach` user input into synthetic `UserPromptSubmit` events so turn assembly stays coherent.
- **Remote interactive sessions.** Sidecar protocol over the existing `claudette-server` WebSocket transport.
- **Subagents as interactive sessions.** Each subagent gets its own host-managed pane.
- **TTY-mode watchdog.** Coarse-grained fallback signal if hooks fail to fire.

## Risks

1. **Hook schema drift.** Anthropic changes a hook event shape; turn assembly breaks. Mitigation: per-kind versioned parsers, fall back to `unknown_hook` raw text on parse failure, surface a warning.
2. **macOS TCC.** `claudette-session-host` is a new binary path; TCC bindings can be granular. Verify before shipping that no new privacy prompts fire at launch (we already spawn PTYs for the existing terminal panel, so this should be neutral).
3. **Named Pipe reliability on Windows.** Different reconnect semantics from Unix sockets. Stress-test rapid Claudette restarts; sidecar must handle "client disappeared without proper detach" cleanly.
4. **Two-code-path drift.** The whole point of B is paying this cost knowingly. The conformance test suite is the structural mitigation; every protocol change must land in both impls or the suite fails.

## Open questions (flagged, not blockers)

- Sidecar log location: own file at `~/.claudette/logs/session-host.<date>.log`, or pipe through Claudette's tracing? Lean: own file (survives Claudette closing).
- `last_screen_blob` as ANSI bytes vs serialised cell grid? Lean: ANSI bytes (lighter, lossier but adequate).
- Sidecar-protocol version mismatch handling: blocker or auto-restart sidecar? Lean: blocker with "restart Claudette to update" message; auto-restart could mask real bugs.
- **Attachments in interactive mode.** The existing `-p` path uses `--input-format stream-json` on stdin to send rich user payloads (images, files). Interactive `claude` reads from a PTY and does not accept stream-json the same way. v1 likely treats the user input as plain typed text + relies on interactive claude's own slash-command paste-file flow (`/file …`, drag-and-drop UI hooks where supported). Implementor should verify what the current interactive client supports and design the UI affordance to match; if attachments cannot be supported well, surface that limitation in the experimental-flag description so users know what they're trading off.

## File summary

### New
- `src-session-host/` — new workspace crate (`claudette-session-host`).
- `src/agent/claude_interactive.rs`
- `src/agent/interactive_host/{mod,tmux,sidecar,conformance}.rs`
- `tests/interactive_host_sidecar.rs`
- `tests/interactive_host_tmux.rs` (`#[cfg(unix)]`)
- `tests/fixtures/stub-tui/` — Rust binary used by the integration tests.
- `src/ui/src/components/chat/InteractiveTurnView.tsx`
- `src/migrations/<UTC_TIMESTAMP>_interactive_sessions.sql`
- `site/src/content/docs/features/interactive-claude.mdx`

### Modified
- `Cargo.toml` — register new workspace member.
- `src/agent/harness.rs` — new `ClaudeInteractive` kind.
- `src/agent_backend.rs` — resolver branch.
- `src-tauri/Cargo.toml` + `src-tauri/tauri.conf.json` — bundle the sidecar via `externalBin`.
- `src-tauri/src/commands/chat.rs` — turn-assembly wiring for interactive backend.
- `src-tauri/src/ipc.rs` — hook event ingestion.
- `src/migrations/mod.rs` — register the new migration.
- `src/ui/src/components/chat/ChatPanel.tsx` — conditional render based on backend kind.
- `src/ui/src/components/settings/sections/ExperimentalSettings.tsx` — new flag row.
- `site/src/content/docs/features/settings.mdx` — settings reference row.
- `site/astro.config.mjs` — sidebar entry for the new docs page.
- `CLAUDE.md` + `.github/copilot-instructions.md` — sync per the alignment rule.
