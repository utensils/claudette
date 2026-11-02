import { nonEmptyStringField, parseToolInput } from "../../utils/toolInput";
import type { ToolDisplayMode } from "../../stores/slices/settingsSlice";
import type { ToolActivity } from "../../stores/useAppStore";
import { parseMcpToolName } from "./mcpToolName";
import { workflowDisplayName } from "./workflowMeta";

export type ToolActivityDisplayGroup = {
  key: string;
  kind: "tools" | "agent" | "agents" | "skill" | "mcp" | "workflow";
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
  let mcpRun: { server: string; activities: ToolActivity[] } | null = null;
  let agentRun: ToolActivity[] = [];

  // Consecutive Agent calls are a fan-out (the model launched them in one
  // message, usually in parallel). One agent keeps its own group; two or
  // more roll up under a single "N agents" header with per-state counts.
  const flushAgentRun = () => {
    if (agentRun.length === 1) {
      groups.push(activityDisplayGroup(agentRun[0]));
    } else if (agentRun.length > 1) {
      groups.push({
        key: `agents:${agentRun.map((activity) => activity.toolUseId).join(",")}`,
        kind: "agents",
        label: `${agentRun.length} agents`,
        activities: agentRun,
      });
    }
    agentRun = [];
  };

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

  const flushMcpRun = () => {
    if (!mcpRun) return;
    groups.push({
      key: `mcp:${mcpRun.server}:${mcpRun.activities
        .map((activity) => activity.toolUseId)
        .join(",")}`,
      kind: "mcp",
      label: mcpRun.server,
      activities: mcpRun.activities,
    });
    mcpRun = null;
  };

  // `directTools`, `mcpRun`, and `agentRun` are mutually exclusive
  // accumulators: pushing to one flushes the others first, so at most one is
  // non-empty at a time.
  for (const activity of activities) {
    if (isAgentActivity(activity)) {
      flushDirectTools();
      flushMcpRun();
      agentRun.push(activity);
      continue;
    }
    flushAgentRun();
    // Agents, skills, and workflows are first-class transcript entries,
    // not tool calls — they break a run of direct tools and render on
    // their own (agents and workflows as collapsible groups, skills as a
    // flat "activated" marker) rather than getting bundled into the
    // "N tool calls" pill.
    if (isSkillActivity(activity) || isWorkflowActivity(activity)) {
      flushDirectTools();
      flushMcpRun();
      groups.push(activityDisplayGroup(activity));
      continue;
    }
    // MCP tool calls get pulled out of the generic "N tool calls" pill into
    // a per-server group (Plug2 + server name). Consecutive calls to the
    // same server accumulate; a different server or a plain tool flushes the
    // run, preserving transcript order.
    const mcp = parseMcpToolName(activity.toolName);
    if (mcp) {
      flushDirectTools();
      if (mcpRun && mcpRun.server !== mcp.server) flushMcpRun();
      (mcpRun ??= { server: mcp.server, activities: [] }).activities.push(
        activity,
      );
      continue;
    }
    flushMcpRun();
    directTools.push(activity);
  }

  flushDirectTools();
  flushMcpRun();
  flushAgentRun();
  return groups;
}

/**
 * Compact "what happened" line for a collapsed tool group — tool names in
 * first-seen order with repeat counts, e.g. `Read ×3 · Edit · Bash`. Capped
 * at `maxNames` distinct tools with a `+N` overflow so a long run of mixed
 * calls doesn't wrap the header. Returns "" for a single-tool group (the
 * row itself already says it).
 */
export function toolBreakdown(
  activities: readonly ToolActivity[],
  maxNames = 4,
): string {
  if (activities.length < 2) return "";
  const counts = new Map<string, number>();
  for (const activity of activities) {
    const name = parseMcpToolName(activity.toolName)?.tool ?? activity.toolName;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const entries = [...counts.entries()];
  const shown = entries
    .slice(0, maxNames)
    .map(([name, count]) => (count > 1 ? `${name} ×${count}` : name));
  const overflow = entries.length - maxNames;
  if (overflow > 0) shown.push(`+${overflow}`);
  return shown.join(" · ");
}

export function isAgentActivity(activity: ToolActivity): boolean {
  return activity.toolName === "Agent";
}

export function isSkillActivity(activity: ToolActivity): boolean {
  return activity.toolName === "Skill";
}

export function isWorkflowActivity(activity: ToolActivity): boolean {
  return activity.toolName === "Workflow";
}

/** Skill name from the `Skill` tool input (`{ "skill": "..." }`), falling
 *  back to the first token of the activity summary, then "Skill". Shared by
 *  the group label and the rendered "<skill> activated" marker. */
export function skillActivationName(activity: ToolActivity): string {
  const skill = nonEmptyStringField(parseToolInput(activity.inputJson)?.skill);
  if (skill) return skill;
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
  if (isWorkflowActivity(activity)) {
    return {
      key: `workflow:${activity.toolUseId}`,
      kind: "workflow",
      // Name comes from the tool input (stable from the moment the
      // tool_use arrives), not the streamed description — which the CLI
      // repoints at whichever agent is currently running.
      label: `Workflow ${workflowDisplayName(activity.inputJson)}`,
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
