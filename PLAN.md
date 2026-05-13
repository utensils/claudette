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
- Keep **Experimental Codex** independent from **Alternative Claude Code backends**. Alternative backend runtime exposure stays off by default for new users and only gates Ollama, LM Studio, OpenAI API, and future non-Codex providers.
- Map Claudette fast mode to Codex app-server `serviceTier: "priority"` for native Codex turns and thread starts.
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

### Phase 4: Native Codex Approval UX And Completion Hardening

- Replace the temporary non-stalling approval fallback with real host prompts for Codex app-server server requests:
  - `item/commandExecution/requestApproval`
  - `item/fileChange/requestApproval`
  - `item/permissions/requestApproval`
- Route those requests through the harness-neutral `control_request` path so the Tauri state layer can persist pending approvals before the UI can respond.
- Add a dedicated in-chat Codex approval card and keep attention badges, tray notifications, cleanup denial, rollbacks, model/backend changes, and session resets in sync.
- Answer approved/denied Codex requests with app-server `response` JSON-RPC messages rather than Claude Code `control_response` payloads.
- Update docs to describe native Codex interactive approvals.

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
- 2026-05-13: Committed and pushed interrupt scaffolding as `437519a8` (`feat: add codex app-server interrupt hook`).
- 2026-05-13: Ran another Copilot review pass on PR #786. Valid findings addressed:
  - stdout parse/IO termination and process exit now drain pending Codex requests so waiters do not hang.
  - unimplemented app-server server-to-client requests now receive a JSON-RPC method-not-found response when stdin is available.
  - Codex capabilities now advertise only currently wired features (`persistent_sessions` and `steer_turn`; prompts, MCP config, attachments remain false).
- 2026-05-13: Verified Copilot follow-up fixes with:
  - `nix develop -c cargo test -p claudette agent::codex_app_server --all-features`
  - `nix develop -c cargo test -p claudette agent::harness --all-features`
  - `nix develop -c cargo fmt --all`
- 2026-05-13: Added the gated `experimental-codex` backend row (`CodexNative`) and runtime harness selection so native Codex resolves to `CodexAppServer` while existing OpenAI API and legacy gateway backends stay on the Claude Code harness.
- 2026-05-13: Added the **Experimental Codex** settings gate. When enabled, backend loading hides the legacy `codex-subscription` row and aliases stale subscription selections to `experimental-codex`; when disabled, OpenAI API and the legacy subscription gateway remain unchanged.
- 2026-05-13: Wired chat spawning to start `CodexAppServerSession::start_with_options` for the native Codex runtime, including model and permission-level mapping, while skipping Claude-only MCP hook injection for Codex sessions.
- 2026-05-13: Updated docs and settings copy for native Codex vs OpenAI API gateway behavior:
  - `site/src/content/docs/features/providers/openai-codex.mdx`
  - `site/src/content/docs/features/providers/index.mdx`
  - `site/src/content/docs/features/settings.mdx`
- 2026-05-13: Verified the gated backend selection milestone with:
  - `nix develop -c cargo test -p claudette agent_backend --all-features`
  - `nix develop -c cargo test -p claudette-tauri agent_backends --all-features`
  - `nix develop -c cargo test -p claudette agent::harness --all-features`
  - `cd src/ui && bunx tsc -b`
  - `cd src/ui && bun run test -- modelRegistry alternativeBackendCleanup`
  - `git diff --check`
- 2026-05-13: Ran the regular Copilot pass after pushing `f287edfc`. Valid findings addressed:
  - Codex `send_turn` now emits start events only after `thread/start` and `turn/start` succeed.
  - Codex terminal notifications (`turn/completed`, `turn/failed`) now clear the active turn id so later steering cannot target a finished turn.
- 2026-05-13: Verified the Copilot lifecycle fixes with:
  - `nix develop -c cargo test -p claudette agent::codex_app_server --all-features`
- 2026-05-13: Ran the next Copilot review pass. Valid findings addressed:
  - Hidden Codex gate configs now survive unrelated backend saves in both directions, so customized `codex-subscription` and `experimental-codex` rows are not lost while hidden.
  - Backend request/default aliasing now works both ways between `codex-subscription` and `experimental-codex` depending on the active gate.
  - Toggling **Experimental Codex** now migrates persisted default and per-session backend selections in both directions and resets affected live sessions.
- 2026-05-13: Verified the Codex gate persistence/migration fixes with:
  - `nix develop -c cargo test -p claudette-tauri agent_backends --all-features`
  - `cd src/ui && bun run test -- codexBackendMigration`
  - `cd src/ui && bunx tsc -b`
  - `nix develop -c cargo fmt --all`
- 2026-05-13: Synced with `origin/main` (already current), committed and pushed the gate persistence/migration fixes as `087082eb` (`fix: preserve codex gate selections`), replied to the latest Copilot threads, resolved them, verified no unresolved Copilot reviewer threads remained, and confirmed PR checks were green with deploy skipped as expected.
- 2026-05-13: Added native Codex app-server account/model RPC support:
  - `account/read` powers **Test** for `experimental-codex` and surfaces missing `codex login` auth.
  - `model/list` powers **Refresh models** for `experimental-codex` and keeps the static seed list only as a pre-refresh fallback.
  - Native Codex backend cards now advertise model discovery through Settings.
- 2026-05-13: Expanded Codex notification mapping for app-server item lifecycle events:
  - `commandExecution` starts map to Claudette `Bash` tool-use events and command output/result events.
  - `mcpToolCall` starts map to Claudette `mcp__server__tool` tool-use events and completion result events.
  - `fileChange` starts/completions map to Claudette edit-style tool-use/result events.
  - Empty `turn/failed` errors now surface a stable fallback message.
- 2026-05-13: Updated stop behavior so persistent native Codex sessions receive protocol-level `turn/interrupt` before falling back to process kill, preserving the app-server/thread when possible.
- 2026-05-13: Updated docs for native Codex auth/model refresh and MCP/file-change event mapping:
  - `site/src/content/docs/features/providers/openai-codex.mdx`
  - `site/src/content/docs/features/experimental-features.mdx`
- 2026-05-13: Smoke-tested the local `codex app-server --listen stdio://` against `initialize`, `account/read`, and `model/list` with Codex CLI `0.130.0`; the live response confirmed ChatGPT auth and surfaced the app-server nuance that `requiresOpenaiAuth: true` can still accompany an authenticated ChatGPT account.
- 2026-05-13: Adjusted native Codex auth parsing so an account-bearing `account/read` response is treated as authenticated while preserving `requiresOpenaiAuth` as provider metadata.
- 2026-05-13: Verified the native Codex model/auth and lifecycle milestone with:
  - `nix develop -c cargo test -p claudette agent::codex_app_server --all-features`
  - `nix develop -c cargo test -p claudette-tauri agent_backends --all-features`
  - `nix develop -c cargo test -p claudette-tauri chat::lifecycle --all-features`
- 2026-05-13: Committed and pushed native Codex auth/model surfacing as `7c65a30f` (`feat: surface native codex auth and models`) after rebasing with `origin/main`.
- 2026-05-13: Ran the next Copilot review pass on PR #786. Valid findings addressed:
  - Claude Remote Control now refuses non-Claude persistent harness sessions instead of handing a Codex app-server session to the Claude-only protocol.
  - Persistent-session and stop lifecycle comments now describe harness-neutral behavior and scope Claude `--resume` details to Claude Code.
  - Frontend backend error tests now pin that `codex_native` has no synthetic Base URL for CLI transport failures.
- 2026-05-13: Verified the Copilot fixes with:
  - `nix develop -c cargo test -p claudette-tauri chat::remote_control --all-features`
  - `nix develop -c cargo test -p claudette-tauri chat::lifecycle --all-features`
  - `cd src/ui && bun run test -- backendSettingsErrors`
  - `cd src/ui && bunx tsc -b`
  - `nix develop -c cargo fmt --all --check`
  - `git diff --check`
- 2026-05-13: Committed and pushed the Copilot fixes as `388ed967` (`fix: keep remote control claude only`), replied to all four Copilot threads, resolved them, and verified zero unresolved Copilot reviewer threads remain.
- 2026-05-13: PR checks after `388ed967` were partially complete: commit-message/PR-title/version/format/migration checks passed; build, lint, frontend, and test were still pending.
- 2026-05-13: Ran the next Copilot review pass after `a80f1604`; CI was green except pending bundle smoke, and Copilot found one valid stop regression risk.
- 2026-05-13: Addressed the stop regression risk by only capturing a protocol interrupt handle when an in-flight `active_pid` exists, preserving idle persistent sessions.
- 2026-05-13: Verified the idle-stop fix with:
  - `nix develop -c cargo test -p claudette-tauri chat::lifecycle --all-features`
  - `nix develop -c cargo fmt --all --check`
  - `git diff --check`
- 2026-05-13: Committed and pushed the idle-stop fix as `a5426aae` (`fix: avoid idle agent interruption`), replied to the Copilot thread, resolved it, and verified zero unresolved Copilot reviewer threads remain.
- 2026-05-13: Latest PR checks for `a5426aae` passed: Cargo Version Sync, Commit messages, Format, Frontend, Frontend Bundle Smoke, Lint, Migration guard, PR title, Test, Updater Manifest, build, codecov/patch, and codecov/project. Deploy was skipped as expected for this draft PR.
- 2026-05-13: Ran the next Copilot review pass after `c42b34a1`; valid findings identified:
  - Codex app-server child processes needed explicit teardown if initialization failed after spawning router tasks.
  - Codex app-server approval server requests needed a non-stalling response path while user-facing Codex approval prompts remain unwired.
- 2026-05-13: Addressed those findings by terminating the app-server on initialization failure and by declining command/file approval requests (and returning an empty turn-scoped permissions grant for permission escalation requests) instead of returning method-not-found.
- 2026-05-13: Verified the initialization cleanup and approval-response fixes with:
  - `nix develop -c cargo test -p claudette agent::codex_app_server --all-features`
  - `nix develop -c cargo fmt --all --check`
- 2026-05-13: Corrected the feature-gate split after live app testing:
  - **Alternative Claude Code backends** is again disabled by default and no longer includes, enables, or exposes Codex.
  - **Experimental Codex** independently exposes the native `experimental-codex` backend and seeded/refreshed Codex models.
  - Legacy `codex-subscription` remains hidden from Settings/model pickers and never reappears through the Alternative backend gate.
- 2026-05-13: Implemented native Codex fast mode:
  - Codex app-server `thread/start` and `turn/start` now send `serviceTier: "priority"` when Claudette fast mode is enabled.
  - Fast-mode drift now respawns persistent sessions so toggling Fast takes effect on the next turn.
  - Provider-aware model registry checks now keep Fast visible for Codex models even while Alternative backends are off.
  - Codex `sandboxPolicy` now serializes as the app-server tagged object shape (`{"type":"dangerFullAccess"}` etc.), fixing the live `dangerFullAccess` deserialization failure.
- 2026-05-13: Verified the fast-mode and gate split fixes with:
  - `nix develop -c cargo test -p claudette agent::codex_app_server --all-features`
  - `nix develop -c cargo test -p claudette drift_when_fast_mode_flips --all-features`
  - `nix develop -c cargo test -p claudette-tauri agent_backends --all-features`
  - `nix develop -c cargo test -p claudette-tauri chat::lifecycle --all-features`
  - `cd src/ui && bun run test -- modelRegistry codexBackendMigration`
  - `cd src/ui && bunx tsc -b`
  - `cd src/ui && bun run lint` (warnings only; no errors)
  - `cd src/ui && bun run lint:css`
  - `nix develop -c cargo fmt --all --check`
  - `git diff --check`
- 2026-05-13: Reopened the completion bar after identifying that blanket app-server approval declines were only a temporary non-stalling fallback, not complete native Codex support.
- 2026-05-13: Implemented interactive native Codex approval routing:
  - app-server approval server requests now become harness-neutral `ControlRequest` events instead of immediate declines.
  - `AgentSession::send_control_response` writes Codex app-server `response` JSON-RPC messages for native Codex sessions.
  - Tauri pending-permission cleanup now denies Codex approvals using Codex-shaped response payloads.
  - The UI now renders Codex command/file/permission approval cards, keeps workspace attention badges in sync, and clears them during reset/rollback/model/backend changes.
  - Provider docs now mention native Codex approval prompts.
- 2026-05-13: Verified the focused approval milestone with:
  - `nix develop -c cargo test -p claudette agent::codex_app_server --all-features`
  - `nix develop -c cargo test -p claudette agent::harness --all-features`
  - `nix develop -c cargo test -p claudette-tauri chat::interaction --all-features`
  - `nix develop -c cargo test -p claudette-tauri chat::lifecycle --all-features`
  - `nix develop -c cargo test -p claudette-tauri agent_backends --all-features`
  - `cd src/ui && bunx tsc -b`
  - `cd src/ui && bun run test -- useAppStore`
  - `cd src/ui && bun run lint`
  - `cd src/ui && bun run lint:css`
  - `nix develop -c cargo fmt --all --check`
  - `git diff --check`
- 2026-05-13: Ran the next Copilot review pass after `a4b7b1e3`. Valid findings addressed:
  - Codex streamed assistant text/thinking is now buffered per turn and emitted as a synthesized `StreamEvent::Assistant` before the terminal result so chat persistence and streaming cleanup follow the existing Claude path.
  - The native Codex approval card now uses unique detail-row keys.
  - Native Codex approval card titles, descriptions, and detail labels now use locale keys instead of hard-coded English strings.
- 2026-05-13: Verified the Copilot approval follow-up with:
  - `nix develop -c cargo test -p claudette agent::codex_app_server --all-features`
  - `nix develop -c cargo fmt --all --check`
  - `cd src/ui && bunx tsc -b`
  - `cd src/ui && bun run test -- useAppStore`
  - `cd src/ui && bun run lint`
  - `git diff --check`
- 2026-05-13: Committed and pushed the Copilot approval follow-up as `35e7ab89` (`fix: persist native codex assistant output`) after rebasing with `origin/main`.
- 2026-05-13: Replied to and resolved the three latest Copilot threads, then re-queried Copilot and confirmed zero unresolved Copilot reviewer threads.
- 2026-05-13: Latest PR checks for `35e7ab89` passed: Cargo Version Sync, Commit messages, Format, Frontend, Frontend Bundle Smoke, Lint, Migration guard, PR title, Test, Updater Manifest, build, codecov/patch, and codecov/project. Deploy was skipped as expected for this draft PR.
- 2026-05-13: Ran one more Copilot pass after the final plan-status commit. Valid finding addressed:
  - Codex command output deltas are now buffered per command item and emitted to Claudette as cumulative tool-result text so the UI no longer overwrites prior chunks with only the latest delta.
- 2026-05-13: Verified the command-output buffering fix with:
  - `nix develop -c cargo test -p claudette agent::codex_app_server --all-features`
  - `nix develop -c cargo fmt --all --check`
  - `git diff --check`
- 2026-05-13: Final implementation audit against this plan:
  - Harness abstraction is in place and Claude behavior remains routed through the existing Claude Code implementation.
  - Native Codex app-server spawn, initialization, persistent thread/turn lifecycle, steering, interrupt, auth check, model list, notification mapping, command/file/MCP event mapping, token usage, failed turns, and process cleanup are implemented behind the experimental gate.
  - Native Codex approval prompts now cover command execution, file changes, and permission escalation with user-facing UI and Codex-shaped JSON-RPC responses.
  - Settings, model/backend gate behavior, migration between legacy and native Codex rows, docs, and tests are updated.
  - Intentionally unsupported in this first implementation: Claude Remote Control, Claude MCP config injection, and file/image attachments for native Codex. These are documented as Claude Code-only until Codex app-server surfaces are mapped.

## Next Stage

- Native Codex implementation is complete for this branch's planned scope and ready for final human review in draft PR #786.
- Keep monitoring the draft PR for any new Copilot or CI feedback after this final plan-status commit.
- 2026-05-13: Superseded the earlier surfacing approach after live dev-app validation:
  - The native Codex models still surface when **Experimental Codex** is enabled, but they do so through a Codex-specific registry path rather than by enabling or depending on **Alternative Claude Code backends**.
  - **Alternative Claude Code backends** is disabled by default for new users and no longer controls or reveals Codex.
  - The Tauri `alternative-backends` compile feature remains enabled in dev/release build feature sets so the code is available, but the runtime setting is independent and default-off.
  - `dev.sh` continues to append the compile feature when a local override omits it; this does not enable the user-facing runtime setting.
  - Settings copy and provider/settings docs now describe Codex as a separate experimental gate.

## Current Next Stage

- Rebase with `origin/main`, commit, push, and run the regular Copilot review loop for the fast-mode/gate-separation fix.
- After push, verify the dev app can select an `experimental-codex/*` model with **Experimental Codex** on and **Alternative Claude Code backends** off.
- 2026-05-13: Ran the Copilot review loop after `79321da8`. Valid finding addressed:
  - Clearing one pending prompt source now preserves tab/sidebar attention when another agent question, plan approval, or native Codex approval remains pending.
  - The stale Alternative-backends default-on comment was declined because the corrected requirement is runtime default-off.
- 2026-05-13: Verified the attention cleanup fix with:
  - `cd src/ui && bun run test -- useAppStore`
  - `cd src/ui && bunx tsc -b`
  - `cd src/ui && bun run lint` (warnings only; no errors)
  - `git diff --check`
