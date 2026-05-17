// Hook-delimited turn assembler for interactive (tmux/sidecar) Claude
// sessions.
//
// Consumes the three event streams exposed by G3's
// `services/interactive.ts` — output bytes, normalized hooks, and exit —
// and folds them into a flat list of "turns". A turn is the continuous
// run of output bytes between a `UserPromptSubmit` hook (the user
// pressed Enter) and the next `Stop` hook (the agent finished its
// reply). The reducer also tracks two pieces of auxiliary state the UI
// surfaces near the chat input: `awaitingInput` (Claude asked a
// question via `AskUserQuestion` / `ExitPlanMode`) and `crashed` (the
// child process exited, expected or otherwise).
//
// G4 keeps the reducer pure (`assemblerReducer`) so it can be unit
// tested without React, while the hook is just `useReducer` plus the
// G3 subscriptions wired in via `useEffect`.

import { useEffect, useReducer } from "react";

import {
  subscribeExit,
  subscribeHooks,
  subscribeOutput,
  type HookKind,
} from "../services/interactive";
import { base64ToBytes } from "../utils/base64";

// ---------------------------------------------------------------------------
// Public state shape
// ---------------------------------------------------------------------------

/**
 * One assembled chunk of agent output. The id is monotonic per
 * session — turn 0 is reserved for any output observed *before* the
 * first `UserPromptSubmit` (e.g. the splash / banner Claude prints at
 * launch). Subsequent turns are numbered 1, 2, … in submission order.
 *
 * `status` reflects lifecycle:
 *   - `live`   — accepting more output bytes
 *   - `done`   — closed by a `stop` or implicit close on the next
 *                `prompt_submitted`
 *   - `crashed`— the underlying session emitted an `exit` while this
 *                turn was still live
 */
export interface Turn {
  id: number;
  bytes: Uint8Array;
  status: "live" | "done" | "crashed";
}

/** Aggregated assembler state surfaced to React. */
export interface AssemblerState {
  turns: Turn[];
  awaitingInput: boolean;
  crashed: boolean;
}

// ---------------------------------------------------------------------------
// Reducer events
// ---------------------------------------------------------------------------

/**
 * Internal event union dispatched into the reducer. We keep this
 * narrower than the raw `OutputEvent` / `HookEvent` / `ExitEvent` so
 * the reducer never depends on `sid` or other transport plumbing —
 * subscription wiring lives entirely in the hook.
 */
export type AssemblerEvent =
  | { type: "output"; bytes: Uint8Array; seq: number }
  | { type: "hook"; kind: HookKind; reason?: string }
  | { type: "exit"; reason: string };

export const initialAssemblerState: AssemblerState = {
  turns: [],
  awaitingInput: false,
  crashed: false,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Concatenate two byte buffers. Allocates a fresh `Uint8Array` so the
 * reducer stays referentially-pure with respect to its inputs — never
 * mutate `prev` in place, otherwise React's `useReducer` may bail on a
 * re-render because the surrounding turn array still points at the
 * same object.
 */
function concatBytes(prev: Uint8Array, next: Uint8Array): Uint8Array {
  const out = new Uint8Array(prev.length + next.length);
  out.set(prev, 0);
  out.set(next, prev.length);
  return out;
}

/**
 * Find the active (live) turn's index, or `-1` if none. We look at the
 * tail of the array first because the reducer only ever appends, so
 * the live turn — when one exists — is always last.
 */
function liveTurnIndex(turns: readonly Turn[]): number {
  if (turns.length === 0) return -1;
  return turns[turns.length - 1].status === "live" ? turns.length - 1 : -1;
}

function replaceTurn(turns: readonly Turn[], index: number, replacement: Turn): Turn[] {
  const out = turns.slice();
  out[index] = replacement;
  return out;
}

/** Next monotonic turn id. The "before-first-prompt" turn is 0. */
function nextTurnId(turns: readonly Turn[]): number {
  if (turns.length === 0) return 0;
  return turns[turns.length - 1].id + 1;
}

// ---------------------------------------------------------------------------
// Pure reducer
// ---------------------------------------------------------------------------

/**
 * Pure event reducer. Exported separately from the hook so tests can
 * drive it without mounting a React component or mocking Tauri.
 *
 * Semantics:
 *
 *   - `output`           — append bytes to the live turn. If none
 *                          exists yet (no `prompt_submitted` has fired)
 *                          start a transient turn 0 so the splash /
 *                          banner is preserved.
 *   - `prompt_submitted` — close the live turn as `done` (acts like an
 *                          implicit Stop for the previous turn), open
 *                          a fresh live turn, and clear
 *                          `awaitingInput` (the user just responded).
 *   - `stop`             — close the live turn as `done`. No-op when
 *                          nothing is live.
 *   - `awaiting`         — set `awaitingInput = true`. Idempotent —
 *                          duplicate awaiting events do not produce a
 *                          new state object, so React skips a re-render.
 *   - `subagent_stop`    — v1: ignored. The orchestrating agent's own
 *                          `stop` is what closes the visible turn.
 *   - `unknown`          — log a one-shot warning with the surfaced
 *                          raw label and otherwise leave state alone.
 *                          The hook's normalization layer guarantees
 *                          the `reason` field carries the raw kind.
 *   - `exit`             — mark the live turn (if any) as `crashed`
 *                          and set the global `crashed` flag.
 *
 * The reducer never mutates its inputs and always returns the same
 * reference when an event is a no-op so consumers can use referential
 * equality to short-circuit work.
 */
export function assemblerReducer(
  state: AssemblerState,
  event: AssemblerEvent,
): AssemblerState {
  switch (event.type) {
    case "output": {
      const liveIdx = liveTurnIndex(state.turns);
      if (liveIdx === -1) {
        // No live turn yet — open the "before-first-prompt" turn so
        // pre-prompt output (banner, status lines) isn't dropped.
        const id = nextTurnId(state.turns);
        const newTurn: Turn = {
          id,
          bytes: event.bytes,
          status: "live",
        };
        return { ...state, turns: [...state.turns, newTurn] };
      }
      const current = state.turns[liveIdx];
      const merged: Turn = {
        ...current,
        bytes: concatBytes(current.bytes, event.bytes),
      };
      return { ...state, turns: replaceTurn(state.turns, liveIdx, merged) };
    }
    case "hook": {
      switch (event.kind) {
        case "prompt_submitted": {
          // Close any live turn, open a fresh one, and clear the
          // awaiting badge in one shot.
          const liveIdx = liveTurnIndex(state.turns);
          const closed =
            liveIdx === -1
              ? state.turns
              : replaceTurn(state.turns, liveIdx, {
                  ...state.turns[liveIdx],
                  status: "done",
                });
          const newTurn: Turn = {
            id: nextTurnId(closed),
            bytes: new Uint8Array(0),
            status: "live",
          };
          return {
            ...state,
            turns: [...closed, newTurn],
            awaitingInput: false,
          };
        }
        case "stop": {
          const liveIdx = liveTurnIndex(state.turns);
          if (liveIdx === -1) return state;
          return {
            ...state,
            turns: replaceTurn(state.turns, liveIdx, {
              ...state.turns[liveIdx],
              status: "done",
            }),
          };
        }
        case "awaiting": {
          // Idempotent — preserve referential equality on duplicates
          // so React can bail on the re-render.
          if (state.awaitingInput) return state;
          return { ...state, awaitingInput: true };
        }
        case "subagent_stop": {
          // v1: intentionally a no-op. The orchestrator's own `stop`
          // is what closes the visible turn; subagent boundaries are
          // not surfaced in the assembled turn list yet.
          return state;
        }
        case "unknown": {
          // Schema-drift fallback. Surface once via console.warn so
          // the kind name is visible in dev tools, but leave the
          // visible state alone — adding turns for hooks we don't
          // understand would corrupt the assembled view.
          if (event.reason !== undefined) {
            console.warn(
              "[interactive] ignoring unknown hook kind:",
              event.reason,
            );
          } else {
            console.warn("[interactive] ignoring unknown hook (no label)");
          }
          return state;
        }
      }
      // Exhaustiveness guard — TypeScript ensures every HookKind is
      // handled above. Belt-and-braces fallback so the reducer is
      // total even if a new kind lands without an updated switch.
      return state;
    }
    case "exit": {
      const liveIdx = liveTurnIndex(state.turns);
      const turns =
        liveIdx === -1
          ? state.turns
          : replaceTurn(state.turns, liveIdx, {
              ...state.turns[liveIdx],
              status: "crashed",
            });
      return { ...state, turns, crashed: true };
    }
  }
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

export interface UseInteractiveTurnAssembler {
  turns: Turn[];
  awaitingInput: boolean;
  crashed: boolean;
}

/**
 * Subscribe to the three G3 event streams for `sid` and assemble them
 * into a flat list of turns plus the `awaitingInput` / `crashed`
 * aux state. Passing `null` (or switching it later) tears down any
 * existing subscriptions and resets to the initial state — useful when
 * the chat panel deselects.
 */
export function useInteractiveTurnAssembler(
  sid: string | null,
): UseInteractiveTurnAssembler {
  const [state, dispatch] = useReducer(assemblerReducer, initialAssemblerState);

  useEffect(() => {
    if (!sid) return;
    // We can't await inside `useEffect`, so the cleanup may run before
    // the three `subscribe*` promises resolve. Track that with a flag
    // and invoke each unlisten as soon as it becomes available; this
    // keeps us from leaking a listener if the effect tears down
    // mid-handshake.
    let cancelled = false;
    const unlistens: (() => void)[] = [];

    const register = (unlisten: () => void) => {
      if (cancelled) {
        unlisten();
        return;
      }
      unlistens.push(unlisten);
    };

    void subscribeOutput(sid, (ev) => {
      dispatch({
        type: "output",
        bytes: base64ToBytes(ev.bytesB64),
        seq: ev.seq,
      });
    }).then(register);

    void subscribeHooks(sid, (ev) => {
      dispatch({ type: "hook", kind: ev.kind, reason: ev.reason });
    }).then(register);

    void subscribeExit(sid, (ev) => {
      dispatch({ type: "exit", reason: ev.reason });
    }).then(register);

    return () => {
      cancelled = true;
      for (const u of unlistens) u();
    };
  }, [sid]);

  return state;
}
