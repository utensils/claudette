import { memo, useMemo } from "react";
import { Plug2 } from "lucide-react";
import { useAppStore } from "../../stores/useAppStore";
import type { ToolActivity } from "../../stores/useAppStore";
import type { ToolDisplayMode } from "../../stores/slices/settingsSlice";
import styles from "./ChatPanel.module.css";
import { EMPTY_ACTIVITIES } from "./chatConstants";
import { activityMatchesSearch } from "./agentToolCallRendering";
import { AgentToolCallGroup } from "./AgentToolCallGroup";
import { AgentRollupGroup, CollapsibleAgentActivity } from "./AgentActivityGroups";
import { DisclosureHeader } from "./DisclosureHeader";
import { WorkflowCard } from "./WorkflowCard";
import { ToolActivityRow } from "./ToolActivityRow";
import { groupToolActivitiesForDisplay, toolBreakdown } from "./toolActivityGroups";
import { collapsedToolGroupKey } from "./collapsedToolGroupKey";
import { useCollapsedToolGroup } from "./useCollapsedToolGroup";

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
  const displayGroups = useMemo(
    () => groupToolActivitiesForDisplay(activities, toolDisplayMode),
    [activities, toolDisplayMode],
  );
  if (displayGroups.length === 0) return null;
  const inline = toolDisplayMode === "inline";

  return (
    <div
      className={
        inline
          ? `${styles.toolActivities} ${styles.inlineTurnActivities}`
          : styles.toolActivities
      }
      aria-live="polite"
      aria-atomic="true"
    >
      {displayGroups.map((group) => {
        const first = group.activities[0];
        if (!first) return null;
        switch (group.kind) {
          case "skill":
            // Skills aren't tool calls — render the flat "<skill> activated"
            // marker directly, never inside a collapsible group.
            return (
              <ToolActivityRow
                key={first.toolUseId}
                activity={first}
                searchQuery={searchQuery}
                worktreePath={worktreePath}
                inline={inline}
              />
            );
          case "workflow":
            return inline ? (
              <WorkflowCard key={group.key} activity={first} inline live />
            ) : (
              <GroupedWorkflowActivity
                key={`grouped:${first.toolUseId}`}
                sessionId={sessionId}
                activity={first}
              />
            );
          case "agent":
            // Inline mode keeps the legacy always-expanded Agent rendering;
            // grouped mode adds a chevron + store-backed collapse.
            return inline ? (
              <AgentToolCallGroup
                key={group.key}
                activity={first}
                searchQuery={searchQuery}
                worktreePath={worktreePath}
                inline
                live
              />
            ) : (
              <CollapsibleAgentActivity
                key={`grouped:${first.toolUseId}`}
                sessionId={sessionId}
                activity={first}
                searchQuery={searchQuery}
                worktreePath={worktreePath}
                live
              />
            );
          case "agents":
            return (
              <GroupedAgentRollup
                key={`grouped-agents:${first.toolUseId}`}
                sessionId={sessionId}
                activities={group.activities}
                searchQuery={searchQuery}
                worktreePath={worktreePath}
              />
            );
          default:
            if (inline) {
              return group.activities.map((act) => (
                <ToolActivityRow
                  key={act.toolUseId}
                  activity={act}
                  searchQuery={searchQuery}
                  worktreePath={worktreePath}
                />
              ));
            }
            // Key by the first activity's toolUseId so the component
            // instance survives renders that append more activities to the
            // same direct-tools run. The group key embeds every member's
            // toolUseId, so keying on it would remount on each new tool.
            return (
              <GroupedToolActivityRows
                key={`grouped:${first.toolUseId}`}
                sessionId={sessionId}
                label={group.label}
                activities={group.activities}
                searchQuery={searchQuery}
                worktreePath={worktreePath}
                mcp={group.kind === "mcp"}
              />
            );
        }
      })}
    </div>
  );
});

function GroupedToolActivityRows({
  sessionId,
  label,
  activities,
  searchQuery,
  worktreePath,
  mcp = false,
}: {
  sessionId: string;
  label: string;
  activities: readonly ToolActivity[];
  searchQuery: string;
  worktreePath?: string | null;
  /** MCP group: render the Plug2 icon + bare-name rows. */
  mcp?: boolean;
}) {
  // The override lives in the shared slice (not local `useState`) so the
  // expand choice survives the running→completed transition: when the turn
  // ends this live group unmounts and `TurnSummary` renders the same
  // activities, reading the same key.
  //
  // Groups default to collapsed unconditionally — including while running —
  // so the chat surface stays quiet and the user expands what they want.
  // Completed turns initialize `turn.collapsed = true` too, so the default
  // doesn't flip at the turn boundary.
  const groupKey = collapsedToolGroupKey(activities);
  const [collapsed, setCollapsed] = useCollapsedToolGroup(sessionId, groupKey, true);

  // Search matches always force the group open — otherwise marks would land
  // in detached DOM and the hit counter would tick with nothing visible.
  // This deliberately wins over an explicit user collapse.
  const queryHasMatch =
    !!searchQuery &&
    activities.some((activity) =>
      activityMatchesSearch(activity, searchQuery, worktreePath),
    );
  const isExpanded = queryHasMatch || !collapsed;
  // Persist from the *visible* state: a click on a visible header is
  // "hide this". Toggling the raw `collapsed` while search forces the group
  // open would silently flip the override and spring it open later.
  const toggle = () => setCollapsed(isExpanded);
  const breakdown = toolBreakdown(activities);

  return (
    <div className={styles.turnSummary}>
      <DisclosureHeader
        className={styles.turnHeader}
        expanded={isExpanded}
        onToggle={toggle}
        ariaLabel={`${isExpanded ? "Collapse" : "Expand"} ${label}`}
      >
        {mcp && (
          <Plug2 size={13} aria-hidden="true" className={styles.mcpGroupIcon} />
        )}
        <span className={styles.turnLabel}>{label}</span>
        {breakdown && <span className={styles.turnBreakdown}>{breakdown}</span>}
      </DisclosureHeader>
      {isExpanded && (
        <div className={styles.turnActivities}>
          {activities.map((act) => (
            <ToolActivityRow
              key={act.toolUseId}
              activity={act}
              searchQuery={searchQuery}
              worktreePath={worktreePath}
              mcp={mcp}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Live wrapper around a single Workflow activity.
 *
 * Unlike agents and tool groups, workflows default to **expanded**. A
 * workflow's tool_result lands within a second ("launched in background")
 * while the run itself takes minutes, so collapsing by default would hide
 * the only indication that anything is happening for the entire run.
 *
 * Collapse persists under `workflow:<toolUseId>`, which `TurnSummary`
 * forwards to this same card after the turn ends, so collapse means "hide
 * the agent tree, keep the header and rail" on both sides of the boundary.
 */
function GroupedWorkflowActivity({
  sessionId,
  activity,
}: {
  sessionId: string;
  activity: ToolActivity;
}) {
  const groupKey = collapsedToolGroupKey([activity]);
  const [collapsed, setCollapsed] = useCollapsedToolGroup(sessionId, groupKey, false);
  return (
    <WorkflowCard
      activity={activity}
      collapsed={collapsed}
      onToggle={() => setCollapsed(!collapsed)}
      live
    />
  );
}

/**
 * Live wrapper for a fan-out of Agent calls. Defaults to expanded (each
 * agent inside is individually collapsed, so the rollup stays compact) —
 * the same default `MessagesWithTurns` applies after the turn ends, under
 * the same `agents:<firstToolUseId>` key.
 */
function GroupedAgentRollup({
  sessionId,
  activities,
  searchQuery,
  worktreePath,
}: {
  sessionId: string;
  activities: readonly ToolActivity[];
  searchQuery: string;
  worktreePath?: string | null;
}) {
  const groupKey = collapsedToolGroupKey(activities, "agents");
  const [collapsed, setCollapsed] = useCollapsedToolGroup(sessionId, groupKey, false);
  return (
    <AgentRollupGroup
      sessionId={sessionId}
      activities={activities}
      collapsed={collapsed}
      onToggle={() => setCollapsed(!collapsed)}
      searchQuery={searchQuery}
      worktreePath={worktreePath}
      live
    />
  );
}
