import { useMemo } from "react";
import { useAppStore } from "../stores/useAppStore";
import type { CompletedTurn, ToolActivity } from "../stores/useAppStore";
import { collectInFlightWorkflows } from "../stores/inFlightWorkflows";
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

/**
 * Workflows still running in this session.
 *
 * The two-lane scan and the in-flight predicate live in
 * `stores/inFlightWorkflows` because the reaper in `useAgentStream` has to
 * answer the identical question when a session's CLI process exits. This
 * used to carry its own copy of the terminal-status set, which drifted from
 * `WorkflowCard`'s copy and from the CLI's actual vocabulary — both omitted
 * `"stopped"`, so a terminated run pinned its pill here forever.
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

    const inFlight = collectInFlightWorkflows(toolActivities, completedTurns);
    if (inFlight.length === 0) return EMPTY_WORKFLOWS;

    return inFlight.map((activity) => ({
      toolUseId: activity.toolUseId,
      name: workflowDisplayName(activity.inputJson),
      summary: summarizeWorkflowProgress(activity.workflowProgress),
    }));
  }, [sessionId, toolActivities, completedTurns]);
}
