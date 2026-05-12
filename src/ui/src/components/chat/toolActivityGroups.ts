import type { ToolDisplayMode } from "../../stores/slices/settingsSlice";
import type { ToolActivity } from "../../stores/useAppStore";

export type ToolActivityDisplayGroup = {
  key: string;
  kind: "tools" | "agent" | "skill";
  label: string;
  activities: ToolActivity[];
};

export function groupToolActivitiesForDisplay(
  activities: readonly ToolActivity[],
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
    // Agents and skills are first-class transcript entries, not tool
    // calls — they break a run of direct tools and render on their own
    // (agents as a collapsible group, skills as a flat "activated"
    // marker) rather than getting bundled into the "N tool calls" pill.
    if (isAgentActivity(activity) || isSkillActivity(activity)) {
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

export function isSkillActivity(activity: ToolActivity): boolean {
  return activity.toolName === "Skill";
}

/** Skill name from the `Skill` tool input (`{ "skill": "..." }`), falling
 *  back to the first token of the activity summary, then "Skill". Shared by
 *  the group label and the rendered "<skill> activated" marker. */
export function skillActivationName(activity: ToolActivity): string {
  try {
    const parsed = JSON.parse(activity.inputJson || "{}") as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof (parsed as { skill?: unknown }).skill === "string"
    ) {
      const skill = (parsed as { skill: string }).skill.trim();
      if (skill) return skill;
    }
  } catch {
    // Fall through to the summary-derived fallback below.
  }
  const fromSummary = activity.summary?.trim().split(/\s+/)[0] ?? "";
  return fromSummary || "Skill";
}

export function groupHasRunningActivity(
  activities: readonly ToolActivity[],
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
  if (isAgentActivity(activity)) {
    return {
      key: `agent:${activity.toolUseId}`,
      kind: "agent",
      label: agentGroupLabel(activity),
      activities: [activity],
    };
  }
  if (isSkillActivity(activity)) {
    return {
      key: `skill:${activity.toolUseId}`,
      kind: "skill",
      label: skillActivationName(activity),
      activities: [activity],
    };
  }
  return {
    key: `tool:${activity.toolUseId}`,
    kind: "tools",
    label: activity.toolName,
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
