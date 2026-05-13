# Native Codex CLI Harness Support

## Reference

- Codex CLI reference clone: `/tmp/claudette-codex-cli-reference`
- Upstream: `https://github.com/openai/codex.git`
- Reference commit: `d1430fd61e4a8189e6669dce31bc9b9ea19a3148`
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
- 2026-05-13: Committed and pushed milestone 1 as `ee05f21d` (`feat: add native codex harness foundation`).
- 2026-05-13: Added `AgentSession`, a harness-neutral session handle, and moved Tauri chat/session ownership from `PersistentSession` to `AgentSession` while keeping the Claude Code variant delegated to the existing implementation.
- 2026-05-13: Verified the neutral session handle with:
  - `nix develop -c cargo test -p claudette agent::harness --all-features`
  - `nix develop -c cargo test -p claudette-tauri --all-features --no-run`
  - `nix develop -c cargo fmt --all`
- 2026-05-13: Committed and pushed milestone 2 as `2bcb3f07` (`refactor: store agent sessions behind harness handle`).
- 2026-05-13: Added the hidden `CodexAppServerSession` variant skeleton and mapped Codex app-server notifications into Claudette `AgentEvent` values for assistant text, reasoning deltas, command output, token usage, and turn completion/failure.
- 2026-05-13: Verified Codex mapping and session skeleton tests with:
  - `nix develop -c cargo test -p claudette agent::harness --all-features`
  - `nix develop -c cargo test -p claudette agent::codex_app_server --all-features`
  - `nix develop -c cargo fmt --all`

## Next Stage

- Add the Codex app-server process/client request loop behind the `AgentSession` wrapper, with fake stdio tests before any UI/backend selection changes.
- Add fake-harness tests around chat send lifecycle seams before selecting the native Codex runtime from backend settings.
- Keep `codex-subscription` hidden/replaced only after the native `Experimental Codex` backend has a real harness path.
