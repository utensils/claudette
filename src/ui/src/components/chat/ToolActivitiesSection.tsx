import { memo, useState } from "react";
import { useAppStore } from "../../stores/useAppStore";
import type { ToolActivity } from "../../stores/useAppStore";
import type { ToolDisplayMode } from "../../stores/slices/settingsSlice";
import { relativizePath } from "../../hooks/toolSummary";
import { HighlightedPlainText } from "./HighlightedPlainText";
import styles from "./ChatPanel.module.css";
import { toolColor } from "./chatHelpers";
import { EMPTY_ACTIVITIES } from "./chatConstants";
import {
  activityMatchesSearch,
  activitySummaryText,
} from "./agentToolCallRendering";
import { AgentToolCallGroup } from "./AgentToolCallGroup";
import {
  groupHasRunningActivity,
  groupToolActivitiesForDisplay,
} from "./toolActivityGroups";

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
          <AgentToolCallGroup
            key={group.key}
            activity={group.activities[0]}
            searchQuery={searchQuery}
            worktreePath={worktreePath}
          />
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
  label,
  activities,
  searchQuery,
  worktreePath,
}: {
  label: string;
  activities: readonly ToolActivity[];
  searchQuery: string;
  worktreePath?: string | null;
}) {
  // User-override expand state. `null` means "follow the default": the
  // group auto-expands while a member is running and auto-collapses
  // once everything has finished — matching the post-PR-696 default.
  // A click overrides the default to `true`/`false` for the rest of
  // this group's lifetime, so the user can drill into a finished group
  // or hide a noisy still-running one. The override persists across
  // rerenders because the parent keys this component by its first
  // toolUseId (stable across appended activities).
  const [userOverride, setUserOverride] = useState<boolean | null>(null);

  const queryHasMatch =
    !!searchQuery &&
    activities.some((activity) =>
      activityMatchesSearch(activity, searchQuery, worktreePath),
    );
  // Search matches always force the group open — otherwise marks would
  // land in detached DOM (collapsed branch never renders) and the
  // search bar's hit counter would tick up but nothing visible would
  // change. This wins over `userOverride === false` (a user-collapsed
  // group) on purpose: the user typed a query expecting matches, and
  // surprise-hidden hits regress chat search.
  const defaultExpanded = groupHasRunningActivity(activities, true);
  const isExpanded = queryHasMatch || (userOverride ?? defaultExpanded);
  const toggle = () => setUserOverride(!isExpanded);

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

function ToolActivityRow({
  activity,
  searchQuery,
  worktreePath,
}: {
  activity: ToolActivity;
  searchQuery: string;
  worktreePath?: string | null;
}) {
  return (
    <div className={styles.toolActivity}>
      <div className={styles.toolHeader}>
        <span
          className={styles.toolName}
          style={{ color: toolColor(activity.toolName) }}
        >
          {activity.toolName}
        </span>
        {activitySummaryText(activity) && (
          <span className={styles.toolSummary}>
            <HighlightedPlainText
              text={relativizePath(activitySummaryText(activity), worktreePath)}
              query={searchQuery}
            />
          </span>
        )}
      </div>
    </div>
  );
}
