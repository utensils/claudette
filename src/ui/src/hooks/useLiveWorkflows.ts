import { useMemo } from "react";
import { useAppStore } from "../stores/useAppStore";
import type { CompletedTurn, ToolActivity } from "../stores/useAppStore";
import { workflowDisplayName } from "../components/chat/workflowMeta";
import {
  summarizeWorkflowProgress,
  type WorkflowRunSummary,
} from "../types/workflow";

export interface LiveWorkflow {
  toolUseId: string;
  name: string;
  summary: WorkflowRunSummary;
}

const EMPTY_ACTIVITIES: ToolActivity[] = [];
const EMPTY_TURNS: CompletedTurn[] = [];
const EMPTY_WORKFLOWS: LiveWorkflow[] = [];

/** Statuses meaning the background task has ended. Mirrors the set in
 *  `WorkflowCard`; kept local rather than shared because the two consume it
 *  for different questions ("is this card live" vs "should the pill show"). */
const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "error",
  "killed",
  "cancelled",
  "canceled",
]);

function isInFlight(activity: ToolActivity): boolean {
  if (activity.toolName !== "Workflow") return false;
  return !TERMINAL_STATUSES.has((activity.agentStatus ?? "").toLowerCase());
}

/**
 * Workflows still running in this session.
 *
 * Scans completed turns as well as the live turn, because a workflow
 * routinely outlives the turn that launched it — that is the normal case,
 * not an edge one, and a pill that only looked at `toolActivities` would go
 * dark for most of a run's duration.
 *
 * Ordered oldest-first so a second workflow launched later appears after
 * the one already running, matching transcript order.
 */
export function useLiveWorkflows(sessionId: string | null): LiveWorkflow[] {
  const toolActivities = useAppStore(
    (s) => (sessionId ? s.toolActivities[sessionId] : null) ?? EMPTY_ACTIVITIES,
  );
  const completedTurns = useAppStore(
    (s) => (sessionId ? s.completedTurns[sessionId] : null) ?? EMPTY_TURNS,
  );

  return useMemo(() => {
    if (!sessionId) return EMPTY_WORKFLOWS;

    // De-dupe by toolUseId: an activity can briefly appear in both lanes
    // around the turn boundary. The live copy is the fresher one, so it
    // wins.
    const byId = new Map<string, ToolActivity>();
    for (const turn of completedTurns) {
      for (const activity of turn.activities) {
        if (isInFlight(activity)) byId.set(activity.toolUseId, activity);
      }
    }
    for (const activity of toolActivities) {
      if (isInFlight(activity)) byId.set(activity.toolUseId, activity);
    }
    if (byId.size === 0) return EMPTY_WORKFLOWS;

    return [...byId.values()].map((activity) => ({
      toolUseId: activity.toolUseId,
      name: workflowDisplayName(activity.inputJson),
      summary: summarizeWorkflowProgress(activity.workflowProgress),
    }));
  }, [sessionId, toolActivities, completedTurns]);
}
