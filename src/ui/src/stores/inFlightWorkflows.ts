import type { CompletedTurn, ToolActivity } from "./useAppStore";
import { isTerminalBackgroundTaskStatus } from "../types/backgroundTaskStatus";

/** A `Workflow` activity whose background task has not reported an ending.
 *
 *  Note this is a claim about what Claudette has been *told*, not about
 *  what is actually running: a run whose CLI process died without emitting
 *  a `task_notification` still looks in-flight here. Resolving that is the
 *  reaper's job (`useAgentStream`'s `ProcessExited` handler) and the
 *  startup sweep's; this predicate stays honest about the recorded state. */
export function isInFlightWorkflow(activity: ToolActivity): boolean {
  return (
    activity.toolName === "Workflow" &&
    !isTerminalBackgroundTaskStatus(activity.agentStatus)
  );
}

/**
 * Every workflow in a session that has not reported an ending, across both
 * places a tool activity can live.
 *
 * A backgrounded workflow routinely outlives the turn that launched it —
 * that is the normal case, not an edge one — so it spends most of its life
 * in `completedTurns` rather than the live `toolActivities` lane. Anything
 * asking "what is still running" has to scan both.
 *
 * Ordered oldest-first: `Map.set` on an existing key updates the value
 * without moving it, so seeding from completed turns first fixes each
 * workflow's position at its transcript order, and the second pass only
 * swaps in the fresher live copy for anything sitting on the turn boundary.
 */
export function collectInFlightWorkflows(
  liveActivities: ToolActivity[],
  completedTurns: CompletedTurn[],
): ToolActivity[] {
  const byId = new Map<string, ToolActivity>();
  for (const turn of completedTurns) {
    for (const activity of turn.activities) {
      if (isInFlightWorkflow(activity)) byId.set(activity.toolUseId, activity);
    }
  }
  for (const activity of liveActivities) {
    if (isInFlightWorkflow(activity)) byId.set(activity.toolUseId, activity);
  }
  return [...byId.values()];
}
