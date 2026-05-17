// Typed Tauri bridge for the Claude (Interactive) experimental backend.
//
// Mirrors the Rust command surface in `src-tauri/src/commands/interactive.rs`
// (F3) and is intentionally kept as a sibling of `tauri.ts` rather than
// piled into that already-large file. Components landing in G4-G8 (turn
// assembler, terminal panel, sidebar list, etc.) should depend on this
// module instead of calling `invoke` / `listen` directly so the wire
// shapes have one canonical TypeScript representation.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// ---------------------------------------------------------------------------
// Command arg / result shapes
// ---------------------------------------------------------------------------

/**
 * Arguments for `interactive_start`. Mirrors Rust
 * `commands::interactive::StartInteractiveArgs`; field names are
 * camelCase because Tauri's `invoke` macro rewrites the Rust
 * `snake_case` field names from the `#[derive(Deserialize)]` struct to
 * camelCase on the JS side.
 */
export interface StartInteractiveArgs {
  workspaceId: string;
  workingDir: string;
  rows: number;
  cols: number;
  claudeBinary: string;
  claudeArgs: string[];
}

/**
 * Return value of `interactive_start`. `hostKind` is `"tmux"` on Unix
 * when the user has tmux available and `"sidecar"` otherwise (and
 * always `"sidecar"` on Windows). The frontend uses this string
 * verbatim alongside the persisted `interactive_sessions.host_kind`
 * column.
 */
export interface StartInteractiveResult {
  sid: string;
  hostKind: string;
}

/**
 * Canonical lifecycle states for a persisted `interactive_sessions`
 * row. Mirrors the discrete `state` values written by the Rust CRUD in
 * `src/db/interactive_sessions.rs` (A3 migration + A4 commands):
 *
 *   - `"running"`   — host has the session alive and Claudette is the
 *                     active client.
 *   - `"detached"`  — host has the session alive but Claudette is not
 *                     currently attached to it.
 *   - `"stopped"`   — session ended (graceful or forced teardown).
 *   - `"crashed"`   — session terminated with a non-zero exit / host
 *                     error; `crashReason` carries the diagnostic.
 *   - `"unknown"`   — defensive forward-compat fallback so a future DB
 *                     value doesn't crash the type checker; callers
 *                     should treat this as "ignore for UI purposes".
 *
 * Typing this as a discriminated union (rather than plain `string`)
 * keeps `computeInteractiveBadgeState` exhaustive — adding a new state
 * here without updating the badge selector is a compile error.
 */
export type InteractiveSessionState =
  | "running"
  | "detached"
  | "stopped"
  | "crashed"
  | "unknown";

/**
 * Wire shape for a persisted `interactive_sessions` row, returned by
 * `interactive_list_for_workspace`. Mirrors Rust
 * `commands::interactive::InteractiveSessionListItem` (camelCase via
 * `#[serde(rename_all = "camelCase")]`).
 *
 * `lastScreenBlob` is the persisted last-captured screen bytes as a
 * byte array (Tauri serializes `Vec<u8>` to a JSON number array). It's
 * `null` for sessions that never had `captureScreen` called.
 */
export interface InteractiveSessionRow {
  sid: string;
  workspaceId: string;
  hostKind: string;
  state: InteractiveSessionState;
  crashReason: string | null;
  createdAt: string;
  lastAttachedAt: string | null;
  lastScreenBlob: number[] | null;
  claudeFlagsJson: string;
  pid: number | null;
}

// ---------------------------------------------------------------------------
// Event payload shapes
// ---------------------------------------------------------------------------

/** Payload of `interactive://<sid>/output`. ANSI bytes are base64. */
export interface OutputEvent {
  sid: string;
  bytesB64: string;
  seq: number;
}

/**
 * Stable set of hook kinds the frontend cares about. `"unknown"`
 * carries the raw name in `reason` so we can log schema drift without
 * the typed turn assembler having to handle every future variant.
 */
export type HookKind =
  | "stop"
  | "awaiting"
  | "prompt_submitted"
  | "subagent_stop"
  | "unknown";

/**
 * Normalized hook event the frontend consumes. Both the attach-stream
 * (nested `HookPayload { sid, hook: HookFired }`) and the
 * CLI-relayed path (flat `{ sid, kind, reason }`) collapse into this
 * shape via `normalizeHookPayload`.
 */
export interface HookEvent {
  sid: string;
  kind: HookKind;
  reason?: string;
}

/** Payload of `interactive://<sid>/exit`. */
export interface ExitEvent {
  sid: string;
  exitStatus: number;
  reason: string;
}

/** Payload of `interactive://<sid>/error`. */
export interface StreamErrorEvent {
  sid: string;
  message: string;
  recoverable: boolean;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Spawn a fresh interactive Claude session. Persists an
 * `interactive_sessions` row in state `"running"`. Caller must then
 * invoke {@link attach} (and subscribe via {@link subscribeOutput} /
 * {@link subscribeHooks}) to receive live events.
 */
export function startInteractive(
  args: StartInteractiveArgs,
): Promise<StartInteractiveResult> {
  return invoke<StartInteractiveResult>("interactive_start", { args });
}

/**
 * Send a UTF-8 text payload to a running interactive session. The
 * underlying host translates this to a tmux `send-keys` call (Unix
 * tmux host) or an `InputPayload::Text` envelope over the sidecar
 * socket.
 */
export function sendInput(sid: string, text: string): Promise<void> {
  return invoke("interactive_send_input", { sid, text });
}

/**
 * Capture the current ANSI screen contents for a session. The returned
 * string is base64-encoded raw ANSI bytes. Best-effort persisted via
 * `Database::update_interactive_session_screen` so a reattach can
 * repaint instantly.
 */
export function captureScreen(sid: string): Promise<string> {
  return invoke<string>("interactive_capture_screen", { sid });
}

/**
 * Stop a running interactive session. `force=true` maps to a
 * `StopMode::Force` (SIGKILL on tmux, immediate teardown on sidecar);
 * the default is `StopMode::Graceful`. The DB row is updated to
 * `state = "stopped"` and the sid→workspace_id mapping is dropped.
 */
export function stopInteractive(sid: string, force = false): Promise<void> {
  return invoke("interactive_stop", { sid, force });
}

/**
 * List every persisted interactive session for `workspaceId`. The
 * underlying CRUD orders by `created_at DESC`, so the returned list is
 * newest-first.
 */
export function listInteractive(
  workspaceId: string,
): Promise<InteractiveSessionRow[]> {
  return invoke<InteractiveSessionRow[]>("interactive_list_for_workspace", {
    workspaceId,
  });
}

/**
 * Subscribe to the live attach stream for an interactive session.
 * Spawns a Rust-side forwarder that fans `AttachEvent::Output / Hook /
 * Exit / Error` to the matching `interactive://<sid>/...` Tauri
 * events. Returns immediately after the attach handshake; the
 * forwarder runs until the host's `AttachStream` terminates.
 */
export function attach(sid: string): Promise<void> {
  return invoke("interactive_attach", { sid });
}

// ---------------------------------------------------------------------------
// Event subscriptions
// ---------------------------------------------------------------------------

/**
 * Subscribe to `interactive://<sid>/output`. The returned promise
 * resolves to an unlisten function — invoke it to drop the listener.
 */
export function subscribeOutput(
  sid: string,
  fn: (ev: OutputEvent) => void,
): Promise<UnlistenFn> {
  return listen<OutputEvent>(`interactive://${sid}/output`, (e) =>
    fn(e.payload),
  );
}

/**
 * Raw payload shapes accepted on the `interactive://<sid>/hook` topic.
 *
 * F3 emits two different shapes on this topic depending on where the
 * hook came from:
 *
 * 1. Attach-stream path (`spawn_attach_forwarder` in
 *    `commands/interactive.rs`): the typed `HookPayload { sid, hook:
 *    HookFired }`, where `HookFired` is `#[serde(tag = "kind",
 *    rename_all = "snake_case")]` so the inner shape is `{ kind:
 *    "stop"|"awaiting"|"prompt_submitted"|"subagent_stop"|"unknown",
 *    reason?, raw_kind?, raw_payload? }`.
 * 2. CLI-relayed path (`interactive_start`'s hook channel forwarder):
 *    a flat `{ sid, kind, reason? }` object.
 *
 * G3 accepts either and normalizes to {@link HookEvent} so downstream
 * code (G4 turn assembler) doesn't have to discriminate.
 */
export type NestedHookPayload = {
  sid: string;
  hook: {
    kind: string;
    reason?: string | null;
    raw_kind?: string;
    raw_payload?: string;
  };
};

export type FlatHookPayload = {
  sid: string;
  kind: string;
  reason?: string | null;
};

export type RawHookPayload = NestedHookPayload | FlatHookPayload;

function isNestedHookPayload(p: RawHookPayload): p is NestedHookPayload {
  return (
    typeof (p as NestedHookPayload).hook === "object" &&
    (p as NestedHookPayload).hook !== null
  );
}

const KNOWN_HOOK_KINDS: ReadonlySet<HookKind> = new Set<HookKind>([
  "stop",
  "awaiting",
  "prompt_submitted",
  "subagent_stop",
  "unknown",
]);

function coerceHookKind(raw: string): HookKind {
  return KNOWN_HOOK_KINDS.has(raw as HookKind) ? (raw as HookKind) : "unknown";
}

/**
 * Collapse either of F3's hook payload shapes into the canonical
 * {@link HookEvent}. Exported for tests / advanced callers; subscribe
 * via {@link subscribeHooks} for the normal case.
 *
 * For the nested variant, an `Unknown` HookFired carries `raw_kind` —
 * we surface that as `reason` so logs / UI still have a label for the
 * unrecognized hook name. For the flat variant we trust the dispatched
 * `kind` string (the Rust side already normalized via
 * `kind_to_wire`).
 */
export function normalizeHookPayload(raw: RawHookPayload): HookEvent {
  if (isNestedHookPayload(raw)) {
    const inner = raw.hook;
    const kind = coerceHookKind(inner.kind);
    if (kind === "unknown") {
      // Prefer the typed `raw_kind` over the absent `reason` so the
      // schema-drift label survives the round-trip.
      const label = inner.raw_kind ?? inner.reason ?? undefined;
      return label !== undefined && label !== null
        ? { sid: raw.sid, kind, reason: label }
        : { sid: raw.sid, kind };
    }
    const reason = inner.reason ?? undefined;
    return reason !== undefined && reason !== null
      ? { sid: raw.sid, kind, reason }
      : { sid: raw.sid, kind };
  }
  const kind = coerceHookKind(raw.kind);
  const reason = raw.reason ?? (kind === "unknown" ? raw.kind : undefined);
  return reason !== undefined && reason !== null
    ? { sid: raw.sid, kind, reason }
    : { sid: raw.sid, kind };
}

/**
 * Subscribe to `interactive://<sid>/hook`. Accepts both F3 payload
 * shapes (attach-stream nested + CLI-relayed flat) and normalizes to
 * {@link HookEvent} before invoking `fn`. The returned promise
 * resolves to an unlisten function.
 */
export function subscribeHooks(
  sid: string,
  fn: (ev: HookEvent) => void,
): Promise<UnlistenFn> {
  return listen<RawHookPayload>(`interactive://${sid}/hook`, (e) => {
    fn(normalizeHookPayload(e.payload));
  });
}

/** Subscribe to `interactive://<sid>/exit`. */
export function subscribeExit(
  sid: string,
  fn: (ev: ExitEvent) => void,
): Promise<UnlistenFn> {
  return listen<ExitEvent>(`interactive://${sid}/exit`, (e) => fn(e.payload));
}

/** Subscribe to `interactive://<sid>/error`. */
export function subscribeStreamError(
  sid: string,
  fn: (ev: StreamErrorEvent) => void,
): Promise<UnlistenFn> {
  return listen<StreamErrorEvent>(`interactive://${sid}/error`, (e) =>
    fn(e.payload),
  );
}

// ---------------------------------------------------------------------------
// Orphan detection / cleanup (H3)
// ---------------------------------------------------------------------------

/**
 * Wire payload of `interactive://orphans-detected`. Emitted once
 * during boot when the reconciler finds `claudette-` sessions on the
 * host that aren't tracked by the DB — typically left over from a
 * previous Claudette process that crashed.
 */
export interface OrphansDetectedEvent {
  sids: string[];
}

/**
 * List orphan interactive sids currently pending cleanup. Returns an
 * empty array when there is nothing to clean up. Useful for late-
 * mounting UI that missed the boot-time `interactive://orphans-detected`
 * event.
 */
export function listOrphans(): Promise<string[]> {
  return invoke<string[]>("interactive_list_orphans");
}

/**
 * Gracefully stop every orphan interactive session. Returns the sids
 * that were successfully stopped (any whose `host.stop` failed are
 * logged on the Rust side and dropped from the orphan map, so the
 * frontend toast doesn't keep reappearing).
 */
export function cleanupOrphans(): Promise<string[]> {
  return invoke<string[]>("interactive_cleanup_orphans");
}

/**
 * Subscribe to the one-shot boot-time `interactive://orphans-detected`
 * event. Fires exactly once per Claudette process — if the listener
 * mounts after the event fired, use {@link listOrphans} to pull the
 * current list instead.
 */
export function subscribeOrphansDetected(
  fn: (ev: OrphansDetectedEvent) => void,
): Promise<UnlistenFn> {
  return listen<OrphansDetectedEvent>("interactive://orphans-detected", (e) =>
    fn(e.payload),
  );
}
