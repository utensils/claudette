import type { ToolDisplayMode } from "../../stores/slices/settingsSlice";
import type { ToolActivity } from "../../stores/useAppStore";

export type ToolActivityDisplayGroup = {
  key: string;
  kind: "tools" | "agent";
  label: string;
  activities: ToolActivity[];
};

export function groupToolActivitiesForDisplay(
  activities: ToolActivity[],
  mode: ToolDisplayMode = "grouped",
): ToolActivityDisplayGroup[] {
  if (mode === "inline") {
    return activities.map((activity) => activityDisplayGroup(activity));
  }

  const groups: ToolActivityDisplayGroup[] = [];
  let directTools: ToolActivity[] = [];

  const flushDirectTools = () => {
    if (directTools.length === 0) return;
    groups.push({
      key: `tools:${directTools.map((activity) => activity.toolUseId).join(",")}`,
      kind: "tools",
      label: toolCallLabel(directTools.length),
      activities: directTools,
    });
    directTools = [];
  };

  for (const activity of activities) {
    if (isAgentActivity(activity)) {
      flushDirectTools();
      groups.push(activityDisplayGroup(activity));
      continue;
    }
    directTools.push(activity);
  }

  flushDirectTools();
  return groups;
}

export function isAgentActivity(activity: ToolActivity): boolean {
  return activity.toolName === "Agent";
}

export function groupHasRunningActivity(
  activities: ToolActivity[],
  parentIsRunning = false,
): boolean {
  return activities.some((activity) => {
    if (activity.resultText.length > 0) return false;
    if (isAgentActivity(activity)) {
      const status = (activity.agentStatus ?? "").toLowerCase();
      return status === "running" || status === "starting" || parentIsRunning;
    }
    return parentIsRunning;
  });
}

function toolCallLabel(count: number): string {
  return `${count} tool call${count !== 1 ? "s" : ""}`;
}

function activityDisplayGroup(activity: ToolActivity): ToolActivityDisplayGroup {
  const agent = isAgentActivity(activity);
  return {
    key: `${agent ? "agent" : "tool"}:${activity.toolUseId}`,
    kind: agent ? "agent" : "tools",
    label: agent ? agentGroupLabel(activity) : activity.toolName,
    activities: [activity],
  };
}

function agentGroupLabel(activity: ToolActivity): string {
  const label =
    activity.agentDescription ||
    activity.summary ||
    activity.agentTaskId ||
    "agent";
  if (label.toLowerCase() === "agent") return "Agent";
  return label.toLowerCase().startsWith("agent ")
    ? label
    : `Agent ${label}`;
}
