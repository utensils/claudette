import { memo } from "react";
import { useAppStore } from "../../stores/useAppStore";
import type { ToolActivity } from "../../stores/useAppStore";
import type { ToolDisplayMode } from "../../stores/slices/settingsSlice";
import styles from "./ChatPanel.module.css";
import { EMPTY_ACTIVITIES } from "./chatConstants";
import { activityMatchesSearch } from "./agentToolCallRendering";
import { AgentToolCallGroup } from "./AgentToolCallGroup";
import { ToolActivityRow } from "./ToolActivityRow";
import { groupToolActivitiesForDisplay } from "./toolActivityGroups";
import { collapsedToolGroupKey } from "./collapsedToolGroupKey";

/**
 * Current tool activities section — subscribes to toolActivities for this workspace.
 * Isolated so streaming text changes don't cause re-renders here.
 */
export const ToolActivitiesSection = memo(function ToolActivitiesSection({
  sessionId,
  toolDisplayMode,
  searchQuery,
  worktreePath,
  activities: activityOverride,
}: {
  sessionId: string;
  toolDisplayMode: ToolDisplayMode;
  searchQuery: string;
  worktreePath?: string | null;
  activities?: readonly ToolActivity[];
}) {
  const activities = useAppStore(
    (s) => activityOverride ?? s.toolActivities[sessionId] ?? EMPTY_ACTIVITIES,
  );
  const displayGroups = groupToolActivitiesForDisplay(activities, toolDisplayMode);
  if (displayGroups.length === 0) return null;

  return (
    <div
      className={
        toolDisplayMode === "inline"
          ? `${styles.toolActivities} ${styles.inlineTurnActivities}`
          : styles.toolActivities
      }
      aria-live="polite"
      aria-atomic="true"
    >
      {displayGroups.map((group) =>
        group.kind === "agent" && group.activities[0] ? (
          // Inline mode keeps the legacy always-expanded Agent rendering;
          // grouped mode wraps the same component with a chevron+toggle
          // and a default-collapsed-while-running stance so live Agent
          // groups behave like any other tool group.
          toolDisplayMode === "inline" ? (
            <AgentToolCallGroup
              key={group.key}
              activity={group.activities[0]}
              searchQuery={searchQuery}
              worktreePath={worktreePath}
              inline
            />
          ) : (
            <GroupedAgentActivity
              key={`grouped:${group.activities[0].toolUseId}`}
              sessionId={sessionId}
              activity={group.activities[0]}
              searchQuery={searchQuery}
              worktreePath={worktreePath}
            />
          )
        ) : toolDisplayMode === "inline" ? (
          group.activities.map((act) => (
            <ToolActivityRow
              key={act.toolUseId}
              activity={act}
              searchQuery={searchQuery}
              worktreePath={worktreePath}
            />
          ))
        ) : (
          // Key by the first activity's toolUseId so the component
          // instance survives across renders that append more
          // activities to the same direct-tools run. Without this, the
          // group key (which embeds every member's toolUseId) changes
          // every time a new tool is added and React would unmount the
          // child — losing the user's manual expand/collapse choice.
          <GroupedToolActivityRows
            key={`grouped:${group.activities[0]?.toolUseId ?? group.key}`}
            sessionId={sessionId}
            label={group.label}
            activities={group.activities}
            searchQuery={searchQuery}
            worktreePath={worktreePath}
          />
        ),
      )}
    </div>
  );
});

function GroupedToolActivityRows({
  sessionId,
  label,
  activities,
  searchQuery,
  worktreePath,
}: {
  sessionId: string;
  label: string;
  activities: readonly ToolActivity[];
  searchQuery: string;
  worktreePath?: string | null;
}) {
  // The user override lives in the shared slice (not local
  // `useState`) so the expand choice survives the running→completed
  // transition: when the agent's turn ends, this live group is
  // unmounted and its activities are rendered through `TurnSummary`
  // by `MessagesWithTurns` — which reads the same slice key. Without
  // this unification, expanding a running group only to have it
  // silently collapse the moment the turn finished was a frequent
  // dogfooding complaint.
  const groupKey = collapsedToolGroupKey(activities);
  const userOverride = useAppStore((s) =>
    groupKey ? s.collapsedToolGroupsBySession[sessionId]?.[groupKey] : undefined,
  );
  const setCollapsedToolGroup = useAppStore((s) => s.setCollapsedToolGroup);

  const queryHasMatch =
    !!searchQuery &&
    activities.some((activity) =>
      activityMatchesSearch(activity, searchQuery, worktreePath),
    );
  // Search matches always force the group open — otherwise marks would
  // land in detached DOM (collapsed branch never renders) and the
  // search bar's hit counter would tick up but nothing visible would
  // change. This wins over `userOverride === true` (user explicitly
  // collapsed) on purpose: the user typed a query expecting matches,
  // and surprise-hidden hits regress chat search.
  //
  // Groups default to collapsed unconditionally — including while
  // running. The previous "expand if any activity is still running"
  // heuristic was intentionally removed: with grouped tool calls on
  // (the new-user default), the chat surface stays quiet and the user
  // expands what they want. Completed turns initialize
  // `turn.collapsed = true` in `chatSlice.finalizeTurn` and
  // `reconstructTurns.ts` (the DB-replay path), so the
  // running→completed transition no longer changes the default.
  const defaultCollapsed = true;
  const collapsed = userOverride ?? defaultCollapsed;
  const isExpanded = queryHasMatch || !collapsed;
  const toggle = () => {
    if (!groupKey) return;
    // Persist based on the *visible* state, not the raw `collapsed`
    // boolean. Otherwise, clicking the header while a search query is
    // forcing the group expanded would silently flip the underlying
    // override (`!collapsed` = `!true` = `false`, expand) — the click
    // appears to do nothing because aria-expanded stays true, but
    // when the user clears the search the group surprises them by
    // springing open. Storing `isExpanded` ("if currently visible,
    // collapse it") matches the user's intent: a click on a visible
    // header is "hide this", a click on a hidden header is "show this".
    setCollapsedToolGroup(sessionId, groupKey, isExpanded);
  };

  return (
    <div className={styles.turnSummary}>
      <div
        className={styles.turnHeader}
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        aria-label={`${isExpanded ? "Collapse" : "Expand"} ${label}`}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle();
          }
        }}
      >
        <span className={styles.toolChevron}>{isExpanded ? "⌄" : "›"}</span>
        <span className={styles.turnLabel}>{label}</span>
      </div>
      {isExpanded && (
        <div className={styles.turnActivities}>
          {activities.map((act) => (
            <ToolActivityRow
              key={act.toolUseId}
              activity={act}
              searchQuery={searchQuery}
              worktreePath={worktreePath}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Live (running-turn) wrapper around a single Agent activity that
 * adds a chevron + collapse toggle while leaving the existing
 * `AgentToolCallGroup` markup intact. The header label and the
 * progress row (status / count / latest tool) remain visible while
 * collapsed; only the per-tool-call list is hidden. This matches the
 * UX choice for grouped tool calls: live agents run for minutes, and
 * a user glancing at the chat needs to see "is it making progress"
 * without expanding.
 *
 * Persistence reuses `collapsedToolGroupsBySession` keyed via
 * `collapsedToolGroupKey` (which already discriminates `agent:` vs
 * `tools:`) so a user's expand/collapse choice survives the
 * running→completed transition: when the turn ends, `TurnSummary`
 * reads the same key.
 */
function GroupedAgentActivity({
  sessionId,
  activity,
  searchQuery,
  worktreePath,
}: {
  sessionId: string;
  activity: ToolActivity;
  searchQuery: string;
  worktreePath?: string | null;
}) {
  const groupKey = collapsedToolGroupKey([activity]);
  const userOverride = useAppStore((s) =>
    groupKey ? s.collapsedToolGroupsBySession[sessionId]?.[groupKey] : undefined,
  );
  const setCollapsedToolGroup = useAppStore((s) => s.setCollapsedToolGroup);

  // Force-expand on a search hit for the same reason regular tool
  // groups do: marks need a mounted DOM target. `activityMatchesSearch`
  // already walks `activity.agentToolCalls`, so a query that matches
  // an agent-internal call still pops the parent open.
  const queryHasMatch =
    !!searchQuery && activityMatchesSearch(activity, searchQuery, worktreePath);
  const defaultCollapsed = true;
  const collapsed = userOverride ?? defaultCollapsed;
  const isCollapsed = !queryHasMatch && collapsed;
  const toggle = () => {
    if (!groupKey) return;
    // Persist based on the visible state (`isCollapsed`), not the raw
    // `collapsed` boolean — see the matching comment in
    // `GroupedToolActivityRows#toggle` for why. Without this, clicking
    // a search-force-expanded agent header silently flips the override
    // and the agent surprises the user when the search is cleared.
    setCollapsedToolGroup(sessionId, groupKey, !isCollapsed);
  };

  return (
    <AgentToolCallGroup
      activity={activity}
      searchQuery={searchQuery}
      worktreePath={worktreePath}
      collapsed={isCollapsed}
      onToggle={toggle}
    />
  );
}
