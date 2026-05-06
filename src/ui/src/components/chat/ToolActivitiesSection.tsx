import { memo, useEffect, useRef, useState } from "react";
import { useAppStore } from "../../stores/useAppStore";
import type { ToolActivity } from "../../stores/useAppStore";
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
  isAgentActivity,
} from "./toolActivityGroups";

/**
 * Current tool activities section — subscribes to toolActivities for this workspace.
 * Isolated so streaming text changes don't cause re-renders here.
 */
export const ToolActivitiesSection = memo(function ToolActivitiesSection({
  sessionId,
  isRunning,
  searchQuery,
  worktreePath,
}: {
  sessionId: string;
  isRunning: boolean;
  searchQuery: string;
  worktreePath?: string | null;
}) {
  const activities = useAppStore(
    (s) => s.toolActivities[sessionId] ?? EMPTY_ACTIVITIES,
  );
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>(
    {},
  );

  // Auto-collapse when a new turn starts (activities goes from 0 to non-zero)
  const prevLengthRef = useRef(0);
  useEffect(() => {
    if (isRunning && activities.length > 0 && prevLengthRef.current === 0) {
      setCollapsedGroups({});
    }
    prevLengthRef.current = activities.length;
  }, [isRunning, activities.length]);

  if (activities.length === 0) return null;

  const groups = groupToolActivitiesForDisplay(activities);

  return (
    <div className={styles.toolActivities} aria-live="polite" aria-atomic="true">
      {groups.map((group) => {
        const groupHasMatch =
          !!searchQuery &&
          group.activities.some((activity) =>
            activityMatchesSearch(activity, searchQuery, worktreePath),
          );
        const isExpanded = !(collapsedGroups[group.key] ?? true) || groupHasMatch;
        const toggleGroup = () =>
          setCollapsedGroups((current) => ({
            ...current,
            [group.key]: !(current[group.key] ?? true),
          }));
        return (
          <div key={group.key} className={styles.turnSummary}>
            <div
              className={styles.turnHeader}
              role="button"
              tabIndex={0}
              onClick={toggleGroup}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggleGroup();
                }
              }}
            >
              <span className={styles.toolChevron}>{isExpanded ? "⌄" : "›"}</span>
              <span className={styles.turnLabel}>
                {group.label}
                {groupHasRunningActivity(group.activities, isRunning) && (
                  <span className={styles.inProgressNote}> in progress</span>
                )}
              </span>
            </div>
            {isExpanded && (
              <div className={styles.turnActivities}>
                {group.activities.map((act: ToolActivity) =>
                  isAgentActivity(act) ? (
                    <AgentToolCallGroup
                      key={act.toolUseId}
                      activity={act}
                      searchQuery={searchQuery}
                      worktreePath={worktreePath}
                    />
                  ) : (
                    <div key={act.toolUseId} className={styles.toolActivity}>
                      <div className={styles.toolHeader}>
                        <span
                          className={styles.toolName}
                          style={{ color: toolColor(act.toolName) }}
                        >
                          {act.toolName}
                        </span>
                        {activitySummaryText(act) && (
                          <span className={styles.toolSummary}>
                            <HighlightedPlainText
                              text={relativizePath(
                                activitySummaryText(act),
                                worktreePath,
                              )}
                              query={searchQuery}
                            />
                          </span>
                        )}
                      </div>
                    </div>
                  ),
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
});
