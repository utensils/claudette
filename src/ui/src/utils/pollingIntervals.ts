/**
 * Centralized polling intervals for the workspace right-sidebar refresh
 * tiers. Three tiers are layered onto the Files / Changes panels:
 *
 *   1. On workspace selection — immediate one-shot load (no interval).
 *   2. While the agent is running — fast active polling so file/diff
 *      changes from tool calls show up promptly while the user watches
 *      the chat (`AGENT_RUNNING_*` below).
 *   3. While the agent is idle — slow idle polling so manual edits in
 *      another editor and external `git` ops still surface without
 *      requiring a workspace switch (`IDLE_REFRESH_INTERVAL_MS`).
 *
 * The active and idle effects are mutually exclusive (`isRunning` is the
 * exact complement); React's effect cleanup swaps the intervals atomically
 * when the agent transitions running → idle, so the two tiers never
 * overlap. Keeping the values in one place lets the panels stay in lockstep
 * — both should refresh at the same idle cadence so neither is visibly
 * stale relative to the other.
 */

/** Files panel — active polling cadence while an agent is running. */
export const FILES_AGENT_RUNNING_INTERVAL_MS = 5_000;

/** Right-sidebar diff list — active polling cadence while an agent is running. */
export const DIFF_AGENT_RUNNING_INTERVAL_MS = 3_000;

/** Idle refresh cadence shared by both panels. Slower than the active
 *  intervals because nothing is producing changes inside the worktree —
 *  this exists to catch manual edits and external `git` ops, not
 *  agent-driven activity. */
export const IDLE_REFRESH_INTERVAL_MS = 10_000;
