// G7 — Sidebar badge for interactive-session state.
//
// Surfaces the per-workspace interactive session state on the Sidebar
// workspace row. Pulled into its own file (rather than inlined into the
// already-1700+-line Sidebar god-file, per CLAUDE.md "god files" rule)
// so the Sidebar diff is just `import + render`.
//
// Three states are visualized in v1:
//   - "awaiting"  — at least one session is parked in an awaiting-input
//                   state (e.g. tmux session waiting on user input from
//                   the InteractiveTurnAssembler `awaiting` hook).
//   - "detached"  — at least one session is alive in the host but not
//                   currently attached in this Claudette client. Maps to
//                   `interactive_sessions.state === "running"` (the DB
//                   stores `running` for both attached and detached
//                   sessions; v1 treats DB-`running` as "detached" since
//                   the user-perceived attached state is owned by the
//                   active ChatPanel, not the row).
//   - "crashed"   — at least one session is in DB state `"crashed"`.
//
// Wired in G7 v1: DB-row state derived from
// `interactive_sessions.state` (`InteractiveSessionRow.state`). The
// live awaiting-input signal from the per-workspace turn assembler is
// represented via an optional `awaitingFromAssembler` flag — Sidebar
// can pass `true` when the active workspace's assembler is in the
// `awaiting` state. Deferred to a follow-up: assembler awaiting-state
// for *background* workspaces (not the currently open one), and the
// "attached vs detached" distinction (we currently treat any
// `running` DB row as detached for badge purposes).
//
// The component is presentational only — no store reads, no async — so
// it stays trivial to test and renders identically under SSR / happy-dom.

import type { CSSProperties } from "react";
import type { InteractiveSessionRow } from "../../services/interactive";

/** Visual states surfaced by the badge. `null` means "no badge". */
export type InteractiveBadgeState = "awaiting" | "detached" | "crashed";

export interface InteractiveBadgeProps {
  state: InteractiveBadgeState;
  /** Optional override for tests / non-English locales. Defaults to a
   *  built-in English label keyed off `state`. */
  label?: string;
  /** Optional className applied alongside the state-specific class. */
  className?: string;
}

const DEFAULT_LABELS: Record<InteractiveBadgeState, string> = {
  awaiting: "Awaiting input",
  detached: "Detached",
  crashed: "Crashed",
};

/**
 * Map a badge state to its presentation. Colors are picked from the
 * existing theme token palette so the badge fits into every theme
 * without inventing new tokens (which would fail `bun run lint:css`):
 *
 *   - awaiting → `--badge-ask` (same hue family as the existing
 *     "Question requires attention" badge, since both signal "user
 *     input wanted").
 *   - detached → `--text-dim` (muted; the session is alive but the
 *     user isn't currently looking at it).
 *   - crashed  → `--status-stopped` (same red as the stopped-agent
 *     icon — a crashed interactive host is a hard failure).
 */
function styleForState(state: InteractiveBadgeState): CSSProperties {
  switch (state) {
    case "awaiting":
      return { color: "var(--badge-ask)" };
    case "detached":
      return { color: "var(--text-dim)" };
    case "crashed":
      return { color: "var(--status-stopped)" };
  }
}

const STATE_DATA_ATTR: Record<InteractiveBadgeState, string> = {
  awaiting: "awaiting",
  detached: "detached",
  crashed: "crashed",
};

/**
 * Renders a small inline text badge next to a workspace row in the
 * sidebar. The badge carries its own `title` and `aria-label` so
 * hover and screen-reader contexts both describe what the badge is
 * signaling.
 */
export function InteractiveBadge({
  state,
  label,
  className,
}: InteractiveBadgeProps) {
  const text = label ?? DEFAULT_LABELS[state];
  return (
    <span
      data-interactive-badge-state={STATE_DATA_ATTR[state]}
      className={className}
      title={text}
      aria-label={text}
      role="img"
      style={styleForState(state)}
    >
      {text}
    </span>
  );
}

// ---------------------------------------------------------------------------
// State derivation
// ---------------------------------------------------------------------------

/**
 * Compute the single badge state to display for a workspace given the
 * persisted interactive sessions for that workspace plus optional
 * runtime signals.
 *
 * Precedence (highest first):
 *   1. `crashed` — any session in DB state `"crashed"`.
 *   2. `awaiting` — `awaitingFromAssembler` is `true`. The DB state
 *      column does not currently distinguish "awaiting" from "running"
 *      so the only authoritative awaiting signal in v1 is the live
 *      assembler state (G4).
 *   3. `detached` — any session in DB state `"running"`. v1 treats
 *      every running session as "detached" for badge purposes; a
 *      future revision can refine this once we track which client is
 *      currently attached.
 *   4. `null` — no badge.
 *
 * Sessions in DB states `"exited"` / `"unknown"` are ignored — a
 * cleanly-exited session doesn't warrant a sidebar badge.
 */
export function computeInteractiveBadgeState(
  sessions: readonly InteractiveSessionRow[] | undefined,
  awaitingFromAssembler = false,
): InteractiveBadgeState | null {
  if (!sessions || sessions.length === 0) {
    // No persisted sessions. The live assembler signal still wins if
    // present — an interactive session can have a `start` hook fire
    // before its DB row lands on the next `listInteractive` refresh.
    return awaitingFromAssembler ? "awaiting" : null;
  }
  let hasRunning = false;
  for (const row of sessions) {
    if (row.state === "crashed") return "crashed";
    if (row.state === "running") hasRunning = true;
  }
  if (awaitingFromAssembler) return "awaiting";
  if (hasRunning) return "detached";
  return null;
}
