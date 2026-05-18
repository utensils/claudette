# Interactive Claude — Test Coverage Plan (≥ 85%)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Patch set:** PR #855 (`codefriar/emerald-cypress`) — the Claude (Interactive) experimental backend.

**Goal:** Bring the patch set's branch coverage to **≥ 85%** measured against the production source files introduced or substantively modified by the PR. Existing test counts on the branch: **1,373 Rust lib tests, 24 session-host tests, 504 Tauri tests, 2,608 vitest tests** — already strong, but the audit found ~25 reachable code paths with no direct assertion.

**Architecture for coverage measurement:**
- **Rust:** `cargo llvm-cov` (already used by CI for the workspace) restricted to the patch set's source set via `--include-files`.
- **TypeScript:** `vitest run --coverage` (Istanbul provider; already wired in `src/ui/vite.config.ts` per upstream) restricted via `--coverage.include`.

Per CLAUDE.md, CI already runs `cargo llvm-cov` and uploads to Codecov (informational, non-blocking). This plan adds a per-file gate scoped to the patch set's new files.

---

## File map (new tests this plan adds)

### New test files
| Path | Crate / surface | Responsibility |
|---|---|---|
| `src/agent/interactive_host/sidecar_conn_tests.rs` (`#[cfg(test)] mod` inline) | `claudette` | `ConnHandle` reader/writer fault paths against an in-memory `duplex()` channel. |
| `src/agent/claude_interactive_io_tests.rs` (inline `#[cfg(test)] mod`) | `claudette` | I/O failure paths for `SettingsOverlay::materialize` / `cleanup`. |
| `src/interactive_partial_tests.rs` (inline `#[cfg(test)] mod`) | `claudette` | Partial-failure isolation for `reattach_rows`. |
| `src-tauri/src/interactive_lifecycle_tests.rs` (new module under `tests/` or as `#[cfg(test)] mod`) | `claudette-tauri` | Boot reconciler branches (flag gate, DB failure, host resolution failure, orphan fallback, emit failure). |
| `src-tauri/src/commands/interactive_tests.rs` (inline `#[cfg(test)] mod`) | `claudette-tauri` | Command handlers (`interactive_start`, `interactive_send_input`, `interactive_capture_screen`, `interactive_stop`, `interactive_list_orphans`, `interactive_cleanup_orphans`) exercised via `AppState::new_for_test` + a `FakeInteractiveHost`. |
| `src-cli/src/commands/chat_hook_ipc_tests.rs` (inline `#[cfg(test)] mod`) | `claudette-cli` | `claudette chat hook` IPC failure path (no socket, malformed reply). |
| `src/ui/src/components/chat/InteractiveTerminalMode.keystrokes.test.tsx` | `src/ui` | xterm `onData → sendInput` keystroke forwarding + ResizeObserver fit. |
| `src/ui/src/services/interactive.errors.test.ts` | `src/ui` | Rejected `invoke` paths for `attach`, `stopInteractive`, `cleanupOrphans`, plus `subscribeOutput` rejection cleanup. |
| `src/ui/src/App.orphans.test.tsx` | `src/ui` | Frontend orphan-detected event → toast + auto-cleanup wiring. |

### Modified test files
| Path | Adds |
|---|---|
| `src/agent/interactive_host/sidecar.rs::tests` | EOF-after-handshake, retry-backoff deadline, `try_connect` failure variants. |
| `src/agent/interactive_protocol.rs::frame_tests` | Truncated header, partial payload, zero-length payload. |
| `src/interactive.rs::tests` | Empty-rows fast path, DB write failure isolation, host status error fallback. |
| `src-session-host/src/session.rs::tests` (or `tests/`) | Spurious-zero-read path, child waiter `Err(_)` path. |
| `src-session-host/tests/attach_stream.rs` | Lagged subscriber warn path + clean termination. |
| `src/ui/src/components/chat/InteractiveTerminalMode.test.tsx` | subscribeOutput rejection, unlisten throw, post-unmount listener-resolution race. |
| `src/ui/src/components/sidebar/InteractiveBadge.test.tsx` | Mixed-state precedence (crashed + awaiting in same workspace), exhaustive `InteractiveSessionState` switch coverage. |
| `src/ui/src/hooks/useInteractiveTurnAssembler.test.ts` | Output-before-prompt buffering edge case, `Exit` arriving after `Stop`. |

### Build / CI changes
| Path | Change |
|---|---|
| `.github/workflows/ci.yml` (new step or extend existing `cargo llvm-cov` step) | Add `--include-files` allowlist for the patch set's source paths + emit a JSON summary that a follow-up step compares against an 85% threshold. Informational on this PR; blocking on follow-ups touching these files. |
| `src/ui/vite.config.ts` (or `vitest.config.ts`) | Add `coverage.include` glob for the patch set's new TS source files. Add a script `bun run test:coverage:interactive` that runs vitest with the include set. |
| `CLAUDE.md` | One-line bullet under "Build & test commands" naming `cargo llvm-cov` and `bun run test:coverage:interactive` as the patch-coverage gates. |

---

## Conventions

- **Conventional commits:** `test(<scope>): ...` for pure test additions; `chore(ci): ...` for CI / coverage gate plumbing.
- Each task ends with a coverage delta — run the gate command, paste the before/after percentage in the commit body.
- TypeScript: vitest + `@testing-library` already present. **No new test frameworks.**
- Rust: each new test uses the existing `tempfile::tempdir()` / mock-host pattern. The `FakeInteractiveHost` used by `interactive::tests` is the model for new mocks.
- Frontend: each new test follows the existing pattern in `InteractiveTerminalMode.test.tsx` (`react-dom/client` + `act`, NOT `@testing-library/react` — that pattern was deliberately chosen by the implementer; do not introduce a competing library).

---

## Phase A — Baseline measurement & CI gate

Establish a known coverage number for the patch set BEFORE writing new tests, so progress is measurable.

### Task A1: Add `bun run test:coverage:interactive` script

**Files:**
- Modify: `src/ui/package.json`
- Modify: `src/ui/vitest.config.ts` (or `vite.config.ts` if that's where vitest config lives)

- [ ] **Step 1: Locate the existing vitest config.** Run `grep -n "vitest\|coverage" src/ui/package.json src/ui/vite.config.ts src/ui/vitest.config.ts 2>/dev/null`. Find the coverage block.

- [ ] **Step 2: Add an include allowlist for the patch set.** Inside the existing `coverage` config (or add one), declare an explicit include list covering the patch set's new/touched files:

```ts
coverage: {
  provider: "istanbul",
  reporter: ["text", "json-summary"],
  include: [
    "src/components/chat/InteractiveTurnView.tsx",
    "src/components/chat/InteractiveTurns.tsx",
    "src/components/chat/InteractiveTerminalMode.tsx",
    "src/components/chat/InteractiveTerminalModeToggle.tsx",
    "src/components/chat/useInteractiveChatMode.ts",
    "src/hooks/useInteractiveTurnAssembler.ts",
    "src/services/interactive.ts",
    "src/components/sidebar/InteractiveBadge.tsx",
    "src/stores/slices/interactiveSessionsSlice.ts",
  ],
  thresholds: {
    statements: 85,
    branches: 85,
    functions: 85,
    lines: 85,
  },
},
```

- [ ] **Step 3: Add the package.json script.**

```json
"test:coverage:interactive": "vitest run --coverage --coverage.include=src/components/chat/Interactive* --coverage.include=src/hooks/useInteractive* --coverage.include=src/services/interactive.ts --coverage.include=src/components/sidebar/InteractiveBadge.tsx --coverage.include=src/stores/slices/interactiveSessionsSlice.ts"
```

- [ ] **Step 4: Capture baseline.** Run `bun run test:coverage:interactive 2>&1 | tail -30`. Record the % per file in the commit body. Expected: pass with whatever the current coverage is; the `thresholds: 85` will gate future runs but should already pass on most files given the existing test work.

- [ ] **Step 5: If thresholds fail**, **DO NOT lower them.** That's the point of the plan — subsequent tasks raise coverage. If the baseline is below 85%, mark the thresholds with `TODO(coverage-plan)` comments and proceed to Task A2 to record what's failing.

- [ ] **Step 6: Commit.**

```bash
git add src/ui/package.json src/ui/vitest.config.ts
git commit -m "chore(ci): add interactive-claude coverage gate (vitest)"
```

### Task A2: Add `cargo llvm-cov` patch-coverage script

**Files:**
- Modify: `.github/workflows/ci.yml` (the existing `cargo llvm-cov` step) OR create a new `scripts/coverage-interactive.sh`.
- Modify: `CLAUDE.md` (one-line bullet in the build/test commands section).

- [ ] **Step 1: Read the existing coverage step.** Run `grep -nB2 -A6 "llvm-cov" .github/workflows/ci.yml`. Note the existing invocation.

- [ ] **Step 2: Add a scoped invocation.** Append a step (or extend the existing one) that runs:

```bash
cargo llvm-cov --workspace \
  --include-files 'src/agent/interactive_host/*' \
  --include-files 'src/agent/interactive_protocol.rs' \
  --include-files 'src/agent/claude_interactive.rs' \
  --include-files 'src/interactive.rs' \
  --include-files 'src/db/interactive_sessions.rs' \
  --include-files 'src-session-host/src/*' \
  --include-files 'src-tauri/src/commands/interactive.rs' \
  --include-files 'src-tauri/src/interactive_lifecycle.rs' \
  --json --output-path target/llvm-cov-interactive.json
```

- [ ] **Step 3: Add a JSON-parsing assertion** (small Node or bash script — `scripts/check-coverage-interactive.sh`):

```bash
#!/usr/bin/env bash
set -euo pipefail
threshold=85
percent=$(jq '.data[0].totals.lines.percent' target/llvm-cov-interactive.json)
echo "interactive patch coverage: ${percent}%"
awk -v p="$percent" -v t="$threshold" 'BEGIN { if (p+0 < t+0) exit 1 }'
```

Make it executable. Invoke from CI after the `llvm-cov` step.

- [ ] **Step 4: Capture the baseline number in the commit body.** Run the same commands locally:

```bash
cargo llvm-cov --workspace \
  --include-files 'src/agent/interactive_host/*' \
  --include-files 'src/agent/interactive_protocol.rs' \
  --include-files 'src/agent/claude_interactive.rs' \
  --include-files 'src/interactive.rs' \
  --include-files 'src/db/interactive_sessions.rs' \
  --include-files 'src-session-host/src/*' \
  --include-files 'src-tauri/src/commands/interactive.rs' \
  --include-files 'src-tauri/src/interactive_lifecycle.rs' 2>&1 | tail -50
```

Paste the final TOTAL line into the commit body.

- [ ] **Step 5: CLAUDE.md update.** Add one bullet under the existing build/test list:

```markdown
cargo llvm-cov --workspace --include-files ... # Patch coverage gate for the Claude (Interactive) backend (≥85%, CI-blocking)
```

- [ ] **Step 6: Commit.**

```bash
git add .github/workflows/ci.yml scripts/check-coverage-interactive.sh CLAUDE.md
git commit -m "chore(ci): gate Claude Interactive patch at >=85% via cargo llvm-cov"
```

---

## Phase B — Rust lib (`claudette` crate) coverage

### Task B1: `SidecarHost::ConnHandle` reader/writer fault paths

**Files:**
- Modify: `src/agent/interactive_host/sidecar.rs` — extend the existing `#[cfg(test)] mod tests` block.

The audit flagged: reader-task EOF handling, inflight-wakeup-on-close, writer-task death mid-flight, malformed first frame, `HelloNack` response branch.

- [ ] **Step 1: Add a `Hello` malformed-first-frame test.** Use `tokio::io::duplex` to fake the socket; write garbage as the first frame; assert `open_handshaked` returns `HostError::Other` with a parse-error message.

```rust
#[tokio::test]
async fn open_handshaked_rejects_non_hello_first_frame() {
    use tokio::io::AsyncWriteExt;
    let (mut client, server) = tokio::io::duplex(4096);
    let server_task = tokio::spawn(async move {
        // Don't bother handshaking — just close.
        drop(server);
    });
    let bad = b"\x00\x00\x00\x05hello"; // 5-byte payload, not valid JSON Hello
    client.write_all(bad).await.unwrap();
    let res = open_handshaked_for_test(&mut client, &mut tokio::io::sink()).await;
    assert!(matches!(res, Err(HostError::Other(_))));
    let _ = server_task.await;
}
```

(Promote `open_handshaked` to `pub(crate)` if not already; OR add a `#[cfg(test)] pub(crate) fn open_handshaked_for_test` thin wrapper.)

- [ ] **Step 2: `HelloNack` branch.** Same shape, but the server writes a valid `InboundFrame::Response { request_id: 0, response: Response::HelloNack { ... } }`. Assert the client surfaces `HostError::Other("hello_nack: ...")` (or whatever the production code does).

- [ ] **Step 3: EOF mid-stream wakes inflight waiters.** Set up a `ConnHandle` against a duplex stream; submit a `request()` future; immediately close the server side; assert the request resolves with `HostError::Other("conn closed")` (or similar) rather than hanging.

- [ ] **Step 4: Writer task dies → next `request()` fails.** Close the writer half explicitly; submit `request()`; assert it errors. This exercises the writer-task drop path.

- [ ] **Step 5: Test target — `try_connect` failure variants.** Pure unit test: pass a path that doesn't exist; assert the right `std::io::Error` kind bubbles out (NotFound / ConnectionRefused).

- [ ] **Step 6: Run + commit.**

```bash
cargo test -p claudette interactive_host::sidecar -- --nocapture
git commit -m "test(agent): cover SidecarHost ConnHandle fault paths"
```

### Task B2: `interactive_protocol::frame` edge cases

**Files:**
- Modify: `src/agent/interactive_protocol.rs` (the existing `frame_tests` module).

- [ ] **Step 1: Truncated header.** Write 2 bytes (instead of the 4-byte length prefix); call `read_frame`; assert `Err` with `UnexpectedEof` kind.

- [ ] **Step 2: Partial payload.** Write a 4-byte header announcing 100 bytes, then write only 50; call `read_frame`; assert `UnexpectedEof`.

- [ ] **Step 3: Zero-length payload.** Write `[0, 0, 0, 0]`; call `read_frame`; assert `Ok(vec![])` (empty payload is valid).

- [ ] **Step 4: Commit.**

```bash
cargo test -p claudette interactive_protocol::frame
git commit -m "test(agent): cover frame truncation and zero-length payloads"
```

### Task B3: `claude_interactive::SettingsOverlay` I/O failures

**Files:**
- Modify: `src/agent/claude_interactive.rs::tests`.

- [ ] **Step 1: `materialize` on a non-existent parent directory** (with `create_dir_all` failure). Use a tempdir + remove all permissions, OR pass a parent whose component is a regular file. Either way, assert `Err`.

- [ ] **Step 2: `cleanup()` on an already-deleted overlay.** Materialize, manually delete the dir, then call `cleanup()`. Assert `Ok(())` (idempotent).

- [ ] **Step 3: Commit.**

```bash
cargo test -p claudette claude_interactive::tests::settings_overlay
git commit -m "test(agent): cover SettingsOverlay I/O failures and idempotent cleanup"
```

### Task B4: `interactive::reattach_rows` partial-failure isolation

**Files:**
- Modify: `src/interactive.rs::tests`.

The audit flagged: a row whose DB write fails should not abort the iteration over the remaining rows.

- [ ] **Step 1: Mock a DB that errors on one specific sid.** The simplest path is to insert a row whose `workspace_id` violates an FK after a fake-removed workspace — but that's brittle. Cleaner: add a `#[cfg(test)]` trait `DbWrites` that `set_interactive_session_state` calls, and have the test provide a fake that errors on one sid.

  Alternative (simpler, no refactor): use a real DB but truncate `interactive_sessions` between the `list_running_*` call and the per-row updates so subsequent updates return `QueryReturnedNoRows`. Verify the function logs and continues.

- [ ] **Step 2: Assert the surviving row(s) reached the expected terminal state.**

- [ ] **Step 3: Commit.**

```bash
cargo test -p claudette interactive::tests::reattach_rows_partial
git commit -m "test(interactive): cover reattach_rows DB-write isolation"
```

### Task B5: `detect_orphans` + `reattach_pending` empty-input fast paths

**Files:**
- Modify: `src/interactive.rs::tests`.

- [ ] **Step 1: `reattach_pending` with empty `running` list** — assert no `host.status()` call (use a `PanickyHost` that panics on `status`).

- [ ] **Step 2: `detect_orphans` with empty host status** — assert `Ok(Vec::new())`.

- [ ] **Step 3: Commit.**

```bash
git commit -m "test(interactive): empty-input fast paths skip host.status"
```

---

## Phase C — Session-host crate coverage

### Task C1: Session reader spurious-zero-read + child-waiter error paths

**Files:**
- Modify: `src-session-host/src/session.rs::tests`, possibly add `src-session-host/tests/reader_paths.rs`.

The reader's EOF-vs-spurious-zero distinction uses a `tmux has-session` probe (TmuxHost) and a child-wait check (SidecarHost). Both have untested branches.

- [ ] **Step 1: Reader sees `Ok(0)` while child is still alive** → expect a brief pause and continued reading. Hard to set up deterministically — best done with the stub TUI by sending `STUB_TUI_NO_NEWLINES=1` and asserting reads continue.

- [ ] **Step 2: Child-waiter `Err(_)` path** (extremely rare; portable-pty's wait can fail if the child handle is dropped). May be unreachable in practice — leave as a `#[ignore]` documented test, OR document as known-unreachable in the source.

- [ ] **Step 3: Run + commit.**

### Task C2: Lagged broadcast subscriber warn path

**Files:**
- Modify: `src-session-host/tests/attach_stream.rs`.

- [ ] **Step 1: Attach two clients.** Drain one fast, leave the other ignoring messages, push enough output to overflow the 2048-cap broadcast channel.

- [ ] **Step 2: Assert the lagged consumer sees its stream end** (with the warn already emitted; we can't easily assert on `tracing` output but we can capture stderr if needed).

- [ ] **Step 3: Run + commit.**

```bash
cargo test -p claudette-session-host --test attach_stream lagged
git commit -m "test(session-host): cover lagged broadcast subscriber path"
```

### Task C3: Handshake protocol-version-mismatch path

**Files:**
- Modify: `src-session-host/tests/handshake.rs`.

- [ ] **Step 1: Send `Request::Hello { protocol_version: 999, claudette_version: "test" }`.** Assert response is `HelloNack` with `supported_versions: [1]`.

- [ ] **Step 2: Commit.**

```bash
git commit -m "test(session-host): cover Hello version mismatch returning HelloNack"
```

---

## Phase D — Tauri layer coverage

### Task D1: `interactive_lifecycle` boot reconciler branches

**Files:**
- Create: `src-tauri/src/interactive_lifecycle.rs::tests` (or `src-tauri/tests/interactive_lifecycle.rs`).

The boot reconciler has 7 branches (flag gate, DB read failure, group-by-workspace, host resolution, orphan fallback, status emit, orphan emit failure). Current coverage: zero.

The boot helper takes an `AppState`. Construct one via `AppState::new_for_test(db_path, ...)` (need to add this helper if missing — match the pattern from `commands/interactive.rs` if it has one).

- [ ] **Step 1: Flag OFF early return.** Set `claudeInteractiveEnabled = false`; insert a `running` row; call the boot helper; assert no host resolution attempted (use a panicky stub host registered in `AppState::interactive_hosts`).

- [ ] **Step 2: Empty DB + empty known sids.** Boot returns instantly; no host work.

- [ ] **Step 3: Single workspace, host knows session.** Row transitions to `detached`.

- [ ] **Step 4: Single workspace, host doesn't know.** Row transitions to `crashed` with `crash_reason = "host missing"`.

- [ ] **Step 5: Orphan-fallback probe.** Insert NO running rows but seed `interactive_orphans` with a session the host claims to know. Assert the orphan stays in the map.

- [ ] **Step 6: DB read failure** (open-after-removed file). Boot logs and returns `Err` (or `Ok` and logs — match actual code).

- [ ] **Step 7: Host resolution failure for one workspace** doesn't abort others. Two workspaces; one host errors on `status()`; assert the other workspace's rows still update.

- [ ] **Step 8: Run + commit.**

```bash
cargo test -p claudette-tauri interactive_lifecycle
git commit -m "test(tauri): cover boot reconciler branches"
```

### Task D2: `commands/interactive.rs` command handlers

**Files:**
- Modify: `src-tauri/src/commands/interactive.rs` — add a `#[cfg(test)] mod tests` block. Add an `AppState::new_for_test` helper if missing.

Each command has 4–7 branches: flag check, host resolution, body, DB persistence, state map cleanup. Currently zero branch coverage.

- [ ] **Step 1: `interactive_start` happy path.** Stub a `FakeInteractiveHost` that records `ensure_session` calls. Run the command. Assert the DB row was created with the right shape.

- [ ] **Step 2: `interactive_start` flag-off error.** Same setup but flag false; assert `Err("Claude Interactive is disabled")`.

- [ ] **Step 3: `interactive_start` host resolution fail.** Stub `interactive_host_for` to return `Err`; assert the command surfaces that error.

- [ ] **Step 4: `interactive_send_input`.** Happy path: register a session, call send_input, assert the host saw the bytes. Error path: missing sid → `Err("session not found")`.

- [ ] **Step 5: `interactive_capture_screen`.** Happy path + DB blob persistence. Error path: missing-row tolerance (the `set_interactive_session_state` "no rows" case the audit flagged — does it return Ok or Err? Pin the contract).

- [ ] **Step 6: `interactive_stop`.** Graceful + Force. Verify state transitions to `"stopped"` AND sid mapping is removed.

- [ ] **Step 7: `interactive_list_for_workspace`.** Returns the DB rows. Empty workspace → empty Vec.

- [ ] **Step 8: `interactive_list_orphans` + `interactive_cleanup_orphans`.** Seed `state.interactive_orphans` with two sids + a `StopTrackingHost`. Call cleanup. Assert both `host.stop` invocations happened AND the orphans map is drained.

- [ ] **Step 9: Run + commit.**

```bash
cargo test -p claudette-tauri commands::interactive::tests
git commit -m "test(tauri): cover interactive_* command handlers"
```

### Task D3: Workspace teardown — interactive session stop on archive/delete

**Files:**
- Modify: `src-tauri/src/commands/workspace.rs::tests` (or add a new integration test).

- [ ] **Step 1: Insert a workspace + an `interactive_sessions` row.** Stub a host in `state.interactive_hosts` that records `stop` calls.

- [ ] **Step 2: Call `delete_workspace` (the inner helper).** Assert the host saw `stop(sid, Graceful)`.

- [ ] **Step 3: Assert the DB row is gone (cascade fired).**

- [ ] **Step 4: Same shape for `archive_workspace_inner`.** Archive doesn't delete the workspace row, but per the spec it should still tear down interactive sessions.

- [ ] **Step 5: Run + commit.**

```bash
git commit -m "test(tauri): interactive session teardown fires on workspace archive + delete"
```

### Task D4: IPC `chat_hook` → per-session channel delivery

**Files:**
- Modify: `src-tauri/src/state.rs::tests` or `src-tauri/src/ipc.rs::tests`.

- [ ] **Step 1: Register a hook channel for sid X.** Dispatch a `Notification` hook via `state.dispatch_interactive_hook(...)`. Assert the channel receiver yields the right `HookEventKind::Awaiting`.

- [ ] **Step 2: Dispatch with no registered channel.** Assert the dispatch logs and discards (no panic).

- [ ] **Step 3: Unregister, then dispatch.** Assert the dispatch is silently dropped.

- [ ] **Step 4: Run + commit.**

```bash
git commit -m "test(tauri): cover interactive hook channel registration + dispatch"
```

---

## Phase E — CLI coverage

### Task E1: `chat hook` IPC failure path

**Files:**
- Modify: `src-cli/src/commands/chat_hook.rs::tests`.

- [ ] **Step 1: No socket present.** Point `CLAUDETTE_SOCK` (or however the CLI locates the socket) at a non-existent path; run the command; assert exit code != 0 AND the error message is user-readable.

- [ ] **Step 2: Stale socket.** Point at a path whose owner Claudette isn't running; expect a connect error.

- [ ] **Step 3: Commit.**

```bash
git commit -m "test(cli): cover chat hook IPC failure paths"
```

---

## Phase F — Frontend coverage

### Task F1: `InteractiveTerminalMode` keystroke forwarding + ResizeObserver

**Files:**
- Create: `src/ui/src/components/chat/InteractiveTerminalMode.keystrokes.test.tsx`.

The audit flagged: `term.onData → sendInput` keystroke path has no test; ResizeObserver re-fit on container changes has no test.

- [ ] **Step 1: Keystroke test.** Mount the component with a mock `sendInput`. Simulate `term.onData('x')` by calling the registered callback directly (xterm's `onData` returns a disposable — the test can grab the handler via the component's exposed terminal ref, or via mocking the Terminal class entirely). Assert `sendInput` called with `'x'`.

- [ ] **Step 2: ResizeObserver test.** Mock `ResizeObserver` to capture the callback. Trigger it manually. Assert `fit.fit()` is called.

- [ ] **Step 3: Disposal order test.** Unmount the component. Assert the data-disposable is disposed BEFORE the terminal itself (the order matters per the audit).

- [ ] **Step 4: Run + commit.**

```bash
cd src/ui && bun run test InteractiveTerminalMode.keystrokes
git commit -m "test(ui): cover xterm onData → sendInput keystroke path"
```

### Task F2: `services/interactive.ts` rejection paths

**Files:**
- Create: `src/ui/src/services/interactive.errors.test.ts`.

- [ ] **Step 1: `attach` invoke rejection** → caller receives the rejection. Mock `invoke` to reject with a known error.

- [ ] **Step 2: `stopInteractive` invoke rejection** → same.

- [ ] **Step 3: `cleanupOrphans` invoke rejection** → same.

- [ ] **Step 4: `subscribeOutput` rejection.** Mock `listen` to reject. Assert the caller's promise rejects. Cleanup-after-rejection path doesn't double-call unlisten.

- [ ] **Step 5: Commit.**

```bash
git commit -m "test(ui): cover services/interactive rejection paths"
```

### Task F3: `App.tsx` orphan-detected listener

**Files:**
- Create: `src/ui/src/App.orphans.test.tsx`.

The audit flagged: zero coverage on the frontend orphan-toast wiring.

- [ ] **Step 1: Mock `subscribeOrphansDetected` + `cleanupOrphans`.** Render `<App />`. Fire a fake orphan event. Assert a toast is shown.

- [ ] **Step 2: Auto-cleanup invocation.** Assert `cleanupOrphans` is called automatically after the toast.

- [ ] **Step 3: Listener cleanup on unmount.** Unmount; assert the unlisten function was called.

- [ ] **Step 4: Commit.**

```bash
git commit -m "test(ui): cover App.tsx orphan-detected listener wiring"
```

### Task F4: `useInteractiveTurnAssembler` race conditions

**Files:**
- Modify: `src/ui/src/hooks/useInteractiveTurnAssembler.test.ts`.

- [ ] **Step 1: Output-before-prompt buffering.** Feed `output → output → prompt_submitted → stop`. Assert turns include the pre-prompt output as `turn-0` (transient).

- [ ] **Step 2: `Exit` arriving after `Stop` doesn't crash the assembler.** Feed `prompt_submitted → output → stop → exit`. Assert state is consistent.

- [ ] **Step 3: `Exit` with no live turn.** Feed only `exit`. Assert `state.crashed = true` and `state.turns` is empty.

- [ ] **Step 4: Commit.**

```bash
git commit -m "test(ui): cover turn-assembler buffering and post-stop Exit"
```

### Task F5: `InteractiveTerminalMode.test.tsx` rejection paths

**Files:**
- Modify: existing `src/ui/src/components/chat/InteractiveTerminalMode.test.tsx`.

- [ ] **Step 1: `attach` rejection on mount.** Should log + continue rendering (no crash).

- [ ] **Step 2: `subscribeOutput` rejection.** Same.

- [ ] **Step 3: Unlisten throw.** Mock unlisten to throw. Unmount should still complete without throwing.

- [ ] **Step 4: Post-unmount listen-resolves race.** Mock subscribeOutput to resolve AFTER unmount. Assert the resolved unlisten is called immediately (don't leak the listener).

- [ ] **Step 5: Commit.**

```bash
git commit -m "test(ui): cover InteractiveTerminalMode promise-rejection and race paths"
```

### Task F6: `InteractiveBadge` mixed-state precedence

**Files:**
- Modify: `src/ui/src/components/sidebar/InteractiveBadge.test.tsx`.

- [ ] **Step 1: Workspace with both crashed AND awaiting rows.** Assert badge state resolves to `"crashed"` (precedence: crashed > awaiting > detached > null).

- [ ] **Step 2: Exhaustiveness.** Add a test that constructs every `InteractiveSessionState` value and asserts `badgeStateForRow` covers them all. (Strict-mode exhaustive switch already guards this at compile time — the test pins the runtime contract.)

- [ ] **Step 3: Commit.**

```bash
git commit -m "test(ui): cover InteractiveBadge mixed-state precedence + state exhaustiveness"
```

---

## Phase G — Verify ≥ 85% and commit the gate

### Task G1: Final coverage measurement

- [ ] **Step 1: Run the Rust coverage gate.**

```bash
cargo llvm-cov --workspace \
  --include-files 'src/agent/interactive_host/*' \
  --include-files 'src/agent/interactive_protocol.rs' \
  --include-files 'src/agent/claude_interactive.rs' \
  --include-files 'src/interactive.rs' \
  --include-files 'src/db/interactive_sessions.rs' \
  --include-files 'src-session-host/src/*' \
  --include-files 'src-tauri/src/commands/interactive.rs' \
  --include-files 'src-tauri/src/interactive_lifecycle.rs' 2>&1 | tail -40
```

Record the TOTAL line. Target: lines ≥ 85%, branches ≥ 85%.

- [ ] **Step 2: Run the frontend coverage gate.**

```bash
cd src/ui && bun run test:coverage:interactive
```

Target: per-file thresholds all ≥ 85%.

- [ ] **Step 3: If anything is below 85%**, identify the file via the per-file table in the llvm-cov / Istanbul reports. Add one more focused test. Re-measure.

- [ ] **Step 4: If everything ≥ 85%**, flip the CI gate from informational to blocking.

  In `.github/workflows/ci.yml`, change `cargo llvm-cov` to call `scripts/check-coverage-interactive.sh` (from Task A2) as a required step.

  In `src/ui/vitest.config.ts`, remove any `TODO(coverage-plan)` markers on the thresholds.

- [ ] **Step 5: Commit.**

```bash
git add .github/workflows/ci.yml src/ui/vitest.config.ts
git commit -m "chore(ci): enforce Claude Interactive patch coverage at >=85%"
```

### Task G2: Document the gate in the PR

- [ ] **Step 1: Update the PR description** to add a "Coverage" section listing the final numbers. Use `gh pr edit 855 --body ...` or edit through the web UI — both work.

---

## Risks

1. **`AppState::new_for_test` may not exist** for the Tauri layer — earlier tasks (E2 / F3) noted the absence. Task D1 / D2 require either adding it or routing tests through the production constructor with carefully-stubbed dependencies. If add is needed, do it as the FIRST step of D1 with a `#[cfg(test)] impl AppState { pub fn new_for_test(db_path: PathBuf) -> Self { ... } }` block that builds a minimal state with stub registries.
2. **`ConnHandle` tests need access to private types.** Either promote a few items to `pub(crate)` (acceptable) or add a `#[cfg(test)] pub(crate) fn` thin wrapper. **Do NOT change the public API.**
3. **xterm `onData` in JSDOM** — the keystroke test in F1 may need to mock the `Terminal` class wholesale rather than rely on xterm's real event wiring. The existing `InteractiveTerminalMode.test.tsx` shows the mocking pattern.
4. **Coverage thresholds set at 85% per file** — if one file is structurally hard to cover (e.g., the macOS-specific path of `current_exe()` resolution), prefer `#[cfg(target_os = "macos")]` test attributes over lowering the threshold. As a last resort, exclude the file via `coverage.exclude` with an inline comment explaining why.
5. **Coverage of `claudette-tauri`** — CI does not currently lint `claudette-tauri` because it requires system libs not installed on the runner. The same constraint applies to `cargo llvm-cov` for that crate. The plan handles this by running coverage from the host `claudette` and `claudette-cli` crates only; the Tauri-layer tests stay in the existing 504-test suite that's run separately on the dev machine. **CI gate covers the Rust lib + session-host crate only; the Tauri tests stay on the dev-machine pre-merge checklist.** Document this gap in the gate script.

## Out of scope

- **Integration / end-to-end tests against a real `claude` binary.** The plan stays within the existing stub-TUI + mock-host pattern. Real-claude smoke tests are a follow-up (already noted in the original spec).
- **Performance / load tests.** Coverage is about correctness paths, not throughput.
- **Visual regression tests.** No screenshots; the existing `InteractiveTurnView.test.tsx` covers rendering enough.

## File summary

### New
- `src/ui/src/components/chat/InteractiveTerminalMode.keystrokes.test.tsx`
- `src/ui/src/services/interactive.errors.test.ts`
- `src/ui/src/App.orphans.test.tsx`
- `scripts/check-coverage-interactive.sh`
- `src/ui/vitest.config.ts` (new coverage config) — if vitest config currently lives in `vite.config.ts`, edit that instead.

### Modified
- `src/agent/interactive_host/sidecar.rs` (`#[cfg(test)] mod tests`)
- `src/agent/interactive_protocol.rs` (`frame_tests`)
- `src/agent/claude_interactive.rs` (`tests`)
- `src/interactive.rs` (`tests`)
- `src-session-host/src/session.rs` (`tests`) + `tests/attach_stream.rs` + `tests/handshake.rs`
- `src-tauri/src/interactive_lifecycle.rs` (add `tests`)
- `src-tauri/src/commands/interactive.rs` (add `tests`)
- `src-tauri/src/commands/workspace.rs` (extend `tests` if any)
- `src-tauri/src/ipc.rs` or `state.rs` (hook channel tests)
- `src-cli/src/commands/chat_hook.rs` (`tests`)
- `src/ui/src/components/chat/InteractiveTerminalMode.test.tsx`
- `src/ui/src/components/sidebar/InteractiveBadge.test.tsx`
- `src/ui/src/hooks/useInteractiveTurnAssembler.test.ts`
- `src/ui/package.json`
- `src/ui/vite.config.ts` or `vitest.config.ts`
- `.github/workflows/ci.yml`
- `CLAUDE.md` (one bullet)
