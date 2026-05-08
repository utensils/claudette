import { memo } from "react";
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
  const storeActivities = useAppStore(
    (s) => s.toolActivities[sessionId] ?? EMPTY_ACTIVITIES,
  );
  const activities = activityOverride ?? storeActivities;
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
          <GroupedToolActivityRows
            key={group.key}
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
  const queryHasMatch =
    !!searchQuery &&
    activities.some((activity) =>
      activityMatchesSearch(activity, searchQuery, worktreePath),
    );
  const isExpanded = groupHasRunningActivity(activities, true) || queryHasMatch;

  return (
    <div className={styles.turnSummary}>
      <div className={styles.turnHeader}>
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
