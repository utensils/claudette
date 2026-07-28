/**
 * Terminal statuses for a Claude Code background task.
 *
 * `useAgentStream` copies `task_notification.status` onto an activity's
 * `agentStatus`, and writes `"running"` itself on every `task_progress`
 * tick. Asking "has this run ended?" therefore means asking this set.
 *
 * The CLI declares a closed enum for the notification that ends a run:
 *
 * ```
 * subtype: "task_notification", status: z.enum(["completed", "failed", "stopped"])
 * ```
 *
 * `"stopped"` is what a *terminated* run reports — `TaskStop`, an
 * interrupt, or the task being killed out from under the agent. It was
 * missing from the two copies of this set that used to live in
 * `useLiveWorkflows` and `WorkflowCard`, so a stopped workflow never read
 * as finished: its status pill stayed pinned above the composer for the
 * rest of the session, and because the wedged status is persisted to
 * `turn_tool_activities.agent_status`, it came back on every reload.
 *
 * `"killed"` belongs to a different channel — `task_updated.patch.status`
 * (`pending | running | completed | failed | killed | paused`), which
 * Claudette does not consume today. It is listed anyway so wiring that
 * channel up later can't reintroduce the same wedge. `"paused"` is
 * deliberately absent: a paused task has not ended.
 *
 * `"error"` / `"cancelled"` / `"canceled"` appear in neither schema. They
 * are kept as tolerated aliases because the cost of a false positive here
 * (a finished run stops being advertised) is much lower than the cost of a
 * false negative (an indicator that never goes away), which is the exact
 * failure this set exists to prevent.
 */
const TERMINAL_BACKGROUND_TASK_STATUSES = new Set([
  // Emitted on `task_notification` — the authoritative closed set.
  "completed",
  "failed",
  "stopped",
  // Emitted on `task_updated.patch.status`, not consumed yet.
  "killed",
  // Not emitted by any current schema; tolerated aliases.
  "error",
  "cancelled",
  "canceled",
]);

/**
 * Whether a background task's status means the task itself has ended.
 *
 * `null` / `undefined` / `""` are NOT terminal. A workflow whose row was
 * checkpointed before its first `task_progress` tick has no status yet and
 * is genuinely still starting — the pill renders it as "starting", which is
 * correct. Orphaned rows in that state are resolved by the reaper on
 * `ProcessExited` and by the startup sweep, not by treating absence as an
 * ending.
 */
export function isTerminalBackgroundTaskStatus(
  status: string | null | undefined,
): boolean {
  return TERMINAL_BACKGROUND_TASK_STATUSES.has((status ?? "").toLowerCase());
}

/**
 * Status recorded for a background task whose owning CLI process went away
 * without ever reporting an outcome.
 *
 * Deliberately `"stopped"` rather than a Claudette-specific sentinel: it is
 * a real value in the CLI's own `task_notification` enum with exactly this
 * meaning ("ended without completing"), so it needs no special-casing at
 * any read site and reads correctly in the card's status line.
 */
export const REAPED_BACKGROUND_TASK_STATUS = "stopped";
