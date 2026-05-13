# Native Codex CLI Harness Support

## Reference

- Codex CLI reference clone for this implementation machine: `/tmp/claudette-codex-cli-reference`
- Upstream: `https://github.com/openai/codex.git`
- Reference commit: `d1430fd61e4a8189e6669dce31bc9b9ea19a3148`
- Reproduce the reference elsewhere with:
  - `git clone https://github.com/openai/codex.git <temp-dir>/claudette-codex-cli-reference`
  - `git -C <temp-dir>/claudette-codex-cli-reference checkout d1430fd61e4a8189e6669dce31bc9b9ea19a3148`
- Draft PR: `https://github.com/utensils/claudette/pull/786`
- Selected integration surface: `codex app-server --listen stdio://`
- Reason: app-server exposes persistent threads, turn start/steer/interrupt, typed notifications, permission profiles, token usage, and richer future harness compatibility than `codex exec --json`.

## Decisions

- Preserve the existing OpenAI API gateway backend.
- Supersede only the current `codex-subscription` gateway backend with native Codex when the new experimental gate is enabled.
- Use the UI label `Experimental Codex` for native Codex.
- Keep Claude Remote Control Claude-only in this first Codex implementation.
- Refactor Claude Code into a behavior-preserving harness adapter before adding native Codex behavior.

## Implementation Phases

### Phase 1: Harness Refactor With Zero Regressions

- Introduce a harness-neutral module under `src/agent/` for session lifecycle, turn handles, normalized events, command-line banners, stop/interrupt, steering, and capability metadata.
- Move existing Claude Code process/session behavior behind a `ClaudeCodeHarness` adapter.
- Keep Claude stream-json parsing, permission prompts, plan approval, MCP bridge behavior, background Bash handling, env-provider drift, and invocation banners unchanged.
- Add regression tests around Claude argv, env, session-id, resume, drift, and permission behavior.

### Phase 2: Native Codex App-Server Harness

- Add a native Codex harness that spawns `codex app-server --listen stdio://`.
- Implement JSON-RPC v2 request/response and notification handling over child stdin/stdout.
- Map Claudette turns to `thread/start`, `thread/resume`, `turn/start`, `turn/steer`, and `turn/interrupt`.
- Map permission levels:
  - `readonly` -> read-only sandbox with untrusted approvals.
  - `standard` -> workspace-write sandbox with on-request approvals.
  - `full` -> danger-full-access with never approvals.
- Map Codex notifications into Claudette stream events for assistant text, reasoning summaries, command execution, MCP calls, file changes, usage, turn completion/failure, and process exit.

### Phase 3: Feature Gate, Settings, And Docs

- Add a tightly scoped experimental gate for native Codex.
- Replace or hide `codex-subscription` when the native Codex gate is active.
- Keep `openai-api` visible and functional.
- Update Settings UI copy and types for `Experimental Codex`.
- Update docs:
  - `site/src/content/docs/features/providers/openai-codex.mdx`
  - `site/src/content/docs/features/providers/index.mdx`
  - `site/src/content/docs/features/settings.mdx`
  - sidebar registration only if a page split becomes necessary.

## Test Plan

- `nix develop -c cargo test -p claudette --all-features`
- `nix develop -c cargo test -p claudette-tauri --all-features`
- `nix develop -c cargo fmt --all --check`
- `nix develop -c cargo clippy -p claudette -p claudette-server -p claudette-cli --all-targets --all-features`
- `cd src/ui && bunx tsc -b`
- `cd src/ui && bun run test`
- `cd src/ui && bun run lint`
- `cd src/ui && bun run lint:css`
- `git diff --check`

## Progress Log

- 2026-05-13: Created `feat/native-codex-harness`.
- 2026-05-13: Verified Codex reference clone at `/tmp/claudette-codex-cli-reference`, commit `d1430fd61e4a8189e6669dce31bc9b9ea19a3148`.
- 2026-05-13: Selected Codex app-server as the native integration surface and preserved OpenAI API scope.
- 2026-05-13: Added the first harness boundary with `ClaudeCodeHarness` delegating to the existing persistent Claude Code session startup path.
- 2026-05-13: Rewired local chat send and Claude Remote Control session spawning through `ClaudeCodeHarness` without changing Claude stream-json behavior.
- 2026-05-13: Added Codex app-server JSON-RPC request/notification codec helpers, permission mapping, and notification decoding tests for assistant deltas and usage.
- 2026-05-13: Verified focused Rust tests:
  - `nix develop -c cargo test -p claudette agent::harness --all-features`
  - `nix develop -c cargo test -p claudette agent::codex_app_server --all-features`
- 2026-05-13: Committed and pushed milestone 1 as `b26831fc` after the `origin/main` rebase (`feat: add native codex harness foundation`).
- 2026-05-13: Added `AgentSession`, a harness-neutral session handle, and moved Tauri chat/session ownership from `PersistentSession` to `AgentSession` while keeping the Claude Code variant delegated to the existing implementation.
- 2026-05-13: Verified the neutral session handle with:
  - `nix develop -c cargo test -p claudette agent::harness --all-features`
  - `nix develop -c cargo test -p claudette-tauri --all-features --no-run`
  - `nix develop -c cargo fmt --all`
- 2026-05-13: Committed and pushed milestone 2 as `8c7127fe` after the `origin/main` rebase (`refactor: store agent sessions behind harness handle`).
- 2026-05-13: Added the hidden `CodexAppServerSession` variant skeleton and mapped Codex app-server notifications into Claudette `AgentEvent` values for assistant text, reasoning deltas, command output, token usage, and turn completion/failure.
- 2026-05-13: Verified Codex mapping and session skeleton tests with:
  - `nix develop -c cargo test -p claudette agent::harness --all-features`
  - `nix develop -c cargo test -p claudette agent::codex_app_server --all-features`
  - `nix develop -c cargo fmt --all`
- 2026-05-13: Committed and pushed milestone 3 as `b9e1f331` after the `origin/main` rebase (`feat: add codex app-server event adapter`).
- 2026-05-13: Added newline-delimited Codex app-server JSON-RPC read/write helpers, locked the `codex app-server --listen stdio://` argv in tests, and verified fake stdio request/response parsing.
- 2026-05-13: Verified the Codex JSON-RPC codec with:
  - `nix develop -c cargo test -p claudette agent::codex_app_server --all-features`
  - `nix develop -c cargo fmt --all`
- 2026-05-13: Committed and pushed milestone 4 as `5dadc542` after the `origin/main` rebase (`feat: add codex app-server jsonrpc codec`).
- 2026-05-13: Added Codex response routing for request/response correlation, notification decoding, orphan response detection, and server request preservation for future approval handling.
- 2026-05-13: Verified the response router with:
  - `nix develop -c cargo test -p claudette agent::codex_app_server --all-features`
  - `nix develop -c cargo fmt --all`
- 2026-05-13: Committed and pushed milestone 5 as `589d3758` after the `origin/main` rebase (`feat: add codex app-server response router`) and opened draft PR #786 for incremental Copilot review.
- 2026-05-13: Added hidden Codex app-server spawn/handshake scaffolding, stdout/stderr/exit tasks, pending-response delivery, and notification routing tests.
- 2026-05-13: Verified the spawn/router scaffold with:
  - `nix develop -c cargo test -p claudette agent::codex_app_server --all-features`
  - `nix develop -c cargo fmt --all`
- 2026-05-13: Synced branch with `origin/main` before the spawn/router scaffold commit using `git fetch origin main` and `git rebase origin/main`; rebase completed cleanly.
- 2026-05-13: Started regular Copilot review pass on draft PR #786. Valid findings addressed:
  - JSON-RPC responses/errors now tolerate `id: null` and route them as orphan/unroutable.
  - Reference clone path is now labeled implementation-local with reproducible clone/checkout steps.
- 2026-05-13: Verified Copilot fixes with:
  - `nix develop -c cargo test -p claudette agent::codex_app_server --all-features`
  - `nix develop -c cargo fmt --all`
- 2026-05-13: Committed and pushed Copilot fixes as `08c47f82` (`fix: tolerate null codex jsonrpc ids`), replied to both Copilot threads, resolved them, and verified no unresolved Copilot threads remained.
- 2026-05-13: Added hidden Codex turn start and steer methods on `CodexAppServerSession`, including lazy `thread/start`, `turn/start` response ID validation, per-turn event forwarding, and `AgentSession::CodexAppServer` dispatch.
- 2026-05-13: Verified hidden Codex turn path scaffolding with:
  - `nix develop -c cargo test -p claudette agent::codex_app_server --all-features`
  - `nix develop -c cargo test -p claudette agent::harness --all-features`
  - `nix develop -c cargo fmt --all`
- 2026-05-13: Committed and pushed hidden Codex turn flow as `c0f85c89` (`feat: wire codex app-server turn flow`).
- 2026-05-13: Added Codex `turn/interrupt` support and a provider-neutral `AgentSession::interrupt_turn` entry point.
- 2026-05-13: Verified interrupt scaffolding with:
  - `nix develop -c cargo test -p claudette agent::codex_app_server --all-features`
  - `nix develop -c cargo test -p claudette agent::harness --all-features`
  - `nix develop -c cargo fmt --all`

## Next Stage

- Begin regular Copilot review passes on draft PR #786 after pushed checkpoints.
- Select native Codex from backend runtime only under the native Codex experimental gate.
- Add fake-harness tests around chat send lifecycle seams before selecting the native Codex runtime from backend settings.
- Keep `codex-subscription` hidden/replaced only after the native `Experimental Codex` backend has a real harness path.
