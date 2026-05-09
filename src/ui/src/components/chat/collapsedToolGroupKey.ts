import type { ToolActivity } from "../../stores/useAppStore";

/**
 * Stable key under which a tool-call group's user-toggled
 * collapsed/expanded state is stored in
 * `collapsedToolGroupsBySession`.
 *
 * The key is derived from the *first activity's `toolUseId`* (plus a
 * `tools:` / `agent:` discriminator) and intentionally does **not**
 * embed any turn-level identifier:
 *
 *   - While the agent is mid-turn, activities live in
 *     `toolActivities[sessionId]` and there is no enclosing turn id.
 *   - Once the turn ends, those same activities migrate into
 *     `completedTurns[sessionId][N].activities`. The activities and
 *     their `toolUseId`s are preserved verbatim — only the wrapper
 *     changes.
 *
 * Keeping the key activity-based (not turn-based) means the user's
 * expand/collapse choice survives the running→completed transition:
 * the same key is computed on both sides of the boundary, so the
 * slice override the live `GroupedToolActivityRows` wrote is the same
 * one the post-turn `TurnSummary` reads.
 *
 * Returns `null` for an empty activity list — callers should fall
 * back to a synthetic key (or skip rendering) in that case.
 */
export function collapsedToolGroupKey(
  activities: readonly ToolActivity[],
): string | null {
  const first = activities[0];
  if (!first) return null;
  // Match the discriminator `groupToolActivitiesForDisplay` uses for
  // its own React `key` (`agent:` for Agent tool, `tools:` otherwise)
  // so the slice key collides with nothing user-meaningful and reads
  // sensibly in dev tools.
  const kind = first.toolName === "Agent" ? "agent" : "tools";
  return `${kind}:${first.toolUseId}`;
}
