import type { ToolActivity } from "../../stores/useAppStore";
import { isTerminalBackgroundTaskStatus } from "../../types/backgroundTaskStatus";
import { nonEmptyStringField, parseToolInput } from "../../utils/toolInput";
import type { TaskState } from "./TaskStateIcon";

/**
 * Collapse an Agent activity's raw `agentStatus` (plus whether a result has
 * landed) into the shared `TaskState` the status glyph renders.
 *
 * `live` is whether the enclosing turn is still running. An Agent with no
 * status and no result is "in progress" while its turn runs (the task events
 * simply haven't arrived yet) but merely "queued"/unknown on replay.
 */
export function agentTaskState(activity: ToolActivity, live = false): TaskState {
  const status = (activity.agentStatus ?? "").toLowerCase();
  if (isTerminalBackgroundTaskStatus(status)) {
    if (status === "completed") return "done";
    if (status === "failed" || status === "error") return "error";
    return "stopped";
  }
  if (status === "running" || status === "starting") return "progress";
  // Historical rows (and foreground agents whose task events never
  // reported a status) are finished once a result exists.
  if (activity.agentResultText || activity.resultText) return "done";
  return live ? "progress" : "queued";
}

/** `subagent_type` from the Agent tool input ("Explore", "Plan", …), or
 *  null for the default general-purpose agent / an unparseable input. */
export function agentSubagentType(activity: ToolActivity): string | null {
  const input = parseToolInput(activity.inputJson);
  return nonEmptyStringField(input?.subagent_type) ?? null;
}

export function isAgentRunningState(state: TaskState): boolean {
  return state === "progress";
}
