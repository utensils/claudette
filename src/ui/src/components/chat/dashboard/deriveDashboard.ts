import type { ChatMessage } from "../../../types/chat";
import type { CompletedTurn, ToolActivity } from "../../../stores/useAppStore";
import { deriveTasks } from "../../../hooks/useTaskTracker";
import { skillActivationName } from "../toolActivityGroups";

/**
 * Pure read-model for the experimental chat "dashboard mode" (gated by the
 * `dashboardModeEnabled` setting). It re-projects the existing chat store
 * state — `chatMessages`, `completedTurns`, `toolActivities`,
 * `streamingThinking` — into per-turn and per-session activity metrics. No
 * React, no store access: every input is passed in so the functions stay
 * unit-testable and cheap to memoize at the call site.
 *
 * Nothing here mutates state or duplicates the backend; it is a different
 * *view* over data the default streamed transcript already consumes.
 */

export type ActivityCategory =
  | "file"
  | "edit"
  | "bash"
  | "mcp"
  | "skill"
  | "subagent"
  | "question"
  | "plan"
  | "other";

export const ACTIVITY_CATEGORIES: ActivityCategory[] = [
  "file",
  "edit",
  "bash",
  "mcp",
  "skill",
  "subagent",
  "question",
  "plan",
  "other",
];

/**
 * A turn as the dashboard sees it: one triggering User message and the
 * Assistant / System messages that follow it, up to (but excluding) the next
 * User message. Mirrors the User-boundary turn model the default view uses in
 * `buildPlainTurnFooters` / `findTriggeringUserIndex`.
 *
 * `userMessage` is null for a leading/orphan group — System banners before the
 * first prompt, or Assistant output with no preceding User (rare, defensive).
 */
export interface TurnGroup {
  /** Stable React key. The triggering user message id, or a positional
   *  fallback for leading/orphan groups. */
  id: string;
  /** Local index of the triggering User message in the source array, or -1
   *  for leading/orphan groups. */
  userIndex: number;
  /** Local index one past the turn's last message (the next User boundary or
   *  the array end). Matches `CompletedTurn.afterMessageIndex` once shifted by
   *  the pagination `globalOffset`. */
  endExclusive: number;
  userMessage: ChatMessage | null;
  /** All Assistant messages in the turn, in order (used for thought counting
   *  and tool-free token/duration reconstruction). */
  assistantMessages: ChatMessage[];
  /** System messages inside the turn slice (compaction dividers, setup-script
   *  results, synthetic continuations) — rendered as passthrough so dashboard
   *  mode doesn't drop these markers. */
  systemMessages: ChatMessage[];
  /** The turn's final Assistant message — the only assistant text dashboard
   *  mode shows. Null when the turn produced no assistant message yet. */
  finalAssistant: ChatMessage | null;
}

export interface TurnDashboardMetrics {
  thoughts: number;
  questions: number;
  plans: number;
  toolCalls: number;
  byCategory: Record<ActivityCategory, number>;
  tasks: { completed: number; total: number };
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** True while the turn is still streaming (no `CompletedTurn` yet). */
  isLive: boolean;
}

/** Split a flat message list into User-bounded turn groups. */
export function groupMessagesIntoTurns(messages: ChatMessage[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  let current: TurnGroup | null = null;

  const startGroup = (
    id: string,
    userIndex: number,
    userMessage: ChatMessage | null,
    startIndex: number,
  ): TurnGroup => {
    const group: TurnGroup = {
      id,
      userIndex,
      endExclusive: startIndex + 1,
      userMessage,
      assistantMessages: [],
      systemMessages: [],
      finalAssistant: null,
    };
    groups.push(group);
    return group;
  };

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "User") {
      current = startGroup(m.id, i, m, i);
      continue;
    }
    if (!current) {
      // Leading System banners or orphan Assistant output before any prompt.
      current = startGroup(`lead-${i}`, -1, null, i);
    }
    if (m.role === "Assistant") {
      current.assistantMessages.push(m);
      current.finalAssistant = m;
    } else {
      current.systemMessages.push(m);
    }
    current.endExclusive = i + 1;
  }

  return groups;
}

/** Map a tool name to a coarse activity category. Mirrors the canonical tool
 *  names used elsewhere (`isSkillActivity` → `"Skill"`, the task tools, the
 *  `mcp__` prefix convention) so categories stay consistent with the default
 *  view's groupings. */
export function categorizeActivity(toolName: string): ActivityCategory {
  if (toolName.startsWith("mcp__")) return "mcp";
  if (toolName === "Agent" || toolName === "Task") return "subagent";
  if (toolName === "AskUserQuestion") return "question";
  if (toolName === "ExitPlanMode") return "plan";
  if (toolName === "Skill") return "skill";
  if (
    toolName === "Edit" ||
    toolName === "MultiEdit" ||
    toolName === "Write" ||
    toolName === "NotebookEdit"
  ) {
    return "edit";
  }
  if (
    toolName === "Read" ||
    toolName === "Glob" ||
    toolName === "Grep" ||
    toolName === "LS"
  ) {
    return "file";
  }
  if (toolName === "Bash") return "bash";
  return "other";
}

function emptyByCategory(): Record<ActivityCategory, number> {
  return {
    file: 0,
    edit: 0,
    bash: 0,
    mcp: 0,
    skill: 0,
    subagent: 0,
    question: 0,
    plan: 0,
    other: 0,
  };
}

/** Count "thoughts": persisted assistant messages carrying a non-empty
 *  `thinking` block, plus any subagent thinking blocks captured on Agent
 *  activities, plus a +1 for an actively-streaming live thinking buffer. */
function countThoughts(
  assistantMessages: ChatMessage[],
  activities: ToolActivity[],
  liveThinking: string | undefined,
): number {
  let thoughts = 0;
  for (const m of assistantMessages) {
    if (m.thinking && m.thinking.trim().length > 0) thoughts += 1;
  }
  for (const a of activities) {
    if (a.agentThinkingBlocks) thoughts += a.agentThinkingBlocks.length;
  }
  if (liveThinking && liveThinking.trim().length > 0) thoughts += 1;
  return thoughts;
}

function sumOrUndefined(values: Array<number | null | undefined>): number | undefined {
  const total = values.reduce<number>((sum, v) => sum + (v ?? 0), 0);
  return total || undefined;
}

/**
 * Derive the metrics for a single turn.
 *
 * - `completedTurn` (when present) supplies the authoritative tool list and
 *   the turn-total duration / token aggregates.
 * - For a tool-free completed turn (no `CompletedTurn` is recorded — see
 *   `chatSlice.finalizeTurn`), duration / tokens are reconstructed from the
 *   turn's assistant messages, matching `buildPlainTurnFooters`.
 * - For the live (in-progress) turn, pass `activities` from
 *   `toolActivities[sessionId]` and `liveThinking` from
 *   `streamingThinking[sessionId]`; aggregate tokens stay undefined until the
 *   turn finalizes.
 */
export function deriveTurnDashboard(params: {
  assistantMessages: ChatMessage[];
  completedTurn?: CompletedTurn | null;
  liveActivities?: ToolActivity[];
  liveThinking?: string;
  isLive?: boolean;
}): TurnDashboardMetrics {
  const { assistantMessages, completedTurn, isLive = false } = params;
  const activities = completedTurn
    ? completedTurn.activities
    : (params.liveActivities ?? []);

  const byCategory = emptyByCategory();
  for (const a of activities) {
    byCategory[categorizeActivity(a.toolName)] += 1;
  }

  const taskResult = deriveTasks([], activities);

  const thoughts = countThoughts(
    assistantMessages,
    activities,
    isLive ? params.liveThinking : undefined,
  );

  const durationMs = completedTurn
    ? completedTurn.durationMs
    : sumOrUndefined(assistantMessages.map((m) => m.duration_ms));
  const inputTokens = completedTurn
    ? completedTurn.inputTokens
    : sumOrUndefined(assistantMessages.map((m) => m.input_tokens));
  const outputTokens = completedTurn
    ? completedTurn.outputTokens
    : sumOrUndefined(assistantMessages.map((m) => m.output_tokens));

  return {
    thoughts,
    questions: byCategory.question,
    plans: byCategory.plan,
    toolCalls: activities.length,
    byCategory,
    tasks: {
      completed: taskResult.completedCount,
      total: taskResult.totalCount,
    },
    durationMs,
    inputTokens,
    outputTokens,
    isLive,
  };
}

/** True when a turn produced any activity worth summarizing — i.e. there is
 *  something the dashboard card hides that the user might want to expand. A
 *  pure prompt → answer turn with no tools or thinking renders without a card. */
export function turnHasDashboardActivity(metrics: TurnDashboardMetrics): boolean {
  return metrics.toolCalls > 0 || metrics.thoughts > 0;
}

/** One entry in a session leaderboard (e.g. "github → 7"). */
export interface SkillTally {
  name: string;
  count: number;
}

/** Session-level rollup. Distinct from `TurnDashboardMetrics` because the
 *  aggregate view surfaces things a single turn can't: leaderboards of the
 *  most-used skills / MCP servers, and `thinkingTurns` (the number of turns
 *  that involved any thinking, not a count of thoughts). */
export interface SessionDashboardMetrics {
  thoughts: number;
  /** Turns with at least one thought — answers "how often did it think?". */
  thinkingTurns: number;
  toolCalls: number;
  mcpCalls: number;
  inputTokens: number;
  outputTokens: number;
  byCategory: Record<ActivityCategory, number>;
  /** Most-invoked skills, by display name, descending. Capped at 5. */
  topSkills: SkillTally[];
  /** Most-used MCP servers, descending. Capped at 5. */
  topMcps: SkillTally[];
}

/** Per-turn input to `deriveSessionMetrics`: the turn's derived metrics plus
 *  its raw activities (leaderboards need tool names, not just counts). */
export interface SessionInputTurn {
  metrics: TurnDashboardMetrics;
  activities: ToolActivity[];
}

/** `mcp__github__create_issue` → `github`. Falls back to the de-prefixed name
 *  for any non-standard MCP tool id so the leaderboard never shows a blank. */
export function mcpServerLabel(toolName: string): string {
  const parts = toolName.split("__");
  if (parts[0] === "mcp" && parts.length >= 2 && parts[1]) return parts[1];
  return toolName.replace(/^mcp__/, "");
}

function bumpCount(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function topN(map: Map<string, number>, n: number): SkillTally[] {
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, n);
}

/** Roll several turns up into the session dashboard, including skill / MCP
 *  leaderboards derived from the turns' raw activities. */
export function deriveSessionMetrics(
  turns: SessionInputTurn[],
): SessionDashboardMetrics {
  const byCategory = emptyByCategory();
  const skillCounts = new Map<string, number>();
  const mcpCounts = new Map<string, number>();
  let thoughts = 0;
  let thinkingTurns = 0;
  let toolCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  for (const { metrics, activities } of turns) {
    thoughts += metrics.thoughts;
    if (metrics.thoughts > 0) thinkingTurns += 1;
    toolCalls += metrics.toolCalls;
    inputTokens += metrics.inputTokens ?? 0;
    outputTokens += metrics.outputTokens ?? 0;
    for (const c of ACTIVITY_CATEGORIES) byCategory[c] += metrics.byCategory[c];
    for (const a of activities) {
      const cat = categorizeActivity(a.toolName);
      if (cat === "skill") bumpCount(skillCounts, skillActivationName(a));
      else if (cat === "mcp") bumpCount(mcpCounts, mcpServerLabel(a.toolName));
    }
  }

  return {
    thoughts,
    thinkingTurns,
    toolCalls,
    mcpCalls: byCategory.mcp,
    inputTokens,
    outputTokens,
    byCategory,
    topSkills: topN(skillCounts, 5),
    topMcps: topN(mcpCounts, 5),
  };
}
