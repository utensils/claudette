import type { AgentToolCall, ToolActivity } from "../../stores/useAppStore";
import { extractToolSummary, relativizePath } from "../../hooks/toolSummary";

export function activityHasAgentToolCalls(activity: ToolActivity): boolean {
  return activity.toolName === "Agent" && (activity.agentToolCalls?.length ?? 0) > 0;
}

export function activityMatchesSearch(
  activity: ToolActivity,
  query: string,
  worktreePath?: string | null,
): boolean {
  if (!query) return false;
  const normalizedQuery = query.toLowerCase();
  const summary = relativizePath(activitySummaryText(activity), worktreePath);
  if (summary.toLowerCase().includes(normalizedQuery)) return true;
  return (activity.agentToolCalls ?? []).some((call) =>
    relativizePath(agentToolCallSummary(call), worktreePath)
      .toLowerCase()
      .includes(normalizedQuery),
  );
}

export function activitySummaryText(activity: ToolActivity): string {
  return (
    activity.summary ||
    activity.agentDescription ||
    extractToolSummary(activity.toolName, activity.inputJson) ||
    ""
  );
}

export function agentToolCallSummary(call: AgentToolCall): string {
  const inputSummary = extractToolSummary(call.toolName, safeJson(call.input));
  if (inputSummary) return inputSummary;
  if (call.error) return call.error;
  return valuePreview(call.input ?? call.response);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function valuePreview(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
