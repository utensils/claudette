import { memo, useEffect, useRef, useState } from "react";
import { useAppStore } from "../../stores/useAppStore";
import type { ToolActivity } from "../../stores/useAppStore";
import { relativizePath } from "../../hooks/toolSummary";
import { HighlightedPlainText } from "./HighlightedPlainText";
import styles from "./ChatPanel.module.css";
import { toolColor } from "./chatHelpers";
import { EMPTY_ACTIVITIES } from "./chatConstants";
import {
  activityHasAgentToolCalls,
  activityMatchesSearch,
  activitySummaryText,
} from "./agentToolCallRendering";
import { AgentToolCallGroup } from "./AgentToolCallGroup";

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
  const [collapsed, setCollapsed] = useState(true);

  // Auto-collapse when a new turn starts (activities goes from 0 to non-zero)
  const prevLengthRef = useRef(0);
  useEffect(() => {
    if (isRunning && activities.length > 0 && prevLengthRef.current === 0) {
      setCollapsed(true);
    }
    prevLengthRef.current = activities.length;
  }, [isRunning, activities.length]);

  if (activities.length === 0) return null;

  // Force-expand when the active search query matches inside any of this
  // section's activity summaries — otherwise marks would be silently
  // hidden behind the collapsed header and the user would see a non-zero
  // counter with no visible highlight. Match against the same relativized
  // text we render, not the raw summary.
  const queryHasMatch =
    !!searchQuery &&
    activities.some((activity) =>
      activityMatchesSearch(activity, searchQuery, worktreePath),
    );
  const isExpanded = !collapsed || queryHasMatch;

  return (
    <div className={styles.toolActivities} aria-live="polite" aria-atomic="true">
      <div className={styles.turnSummary}>
        <div
          className={styles.turnHeader}
          role="button"
          tabIndex={0}
          onClick={() => setCollapsed(!collapsed)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setCollapsed(!collapsed);
            }
          }}
        >
          <span className={styles.toolChevron}>
            {isExpanded ? "⌄" : "›"}
          </span>
          <span className={styles.turnLabel}>
            {activities.length} tool call{activities.length !== 1 ? "s" : ""}
            {isRunning && <span className={styles.inProgressNote}> in progress</span>}
          </span>
        </div>
        {isExpanded && (
          <div className={styles.turnActivities}>
            {activities.map((act: ToolActivity) =>
              activityHasAgentToolCalls(act) ? (
                <AgentToolCallGroup
                  key={act.toolUseId}
                  activity={act}
                  searchQuery={searchQuery}
                  worktreePath={worktreePath}
                />
              ) : (
                <div key={act.toolUseId} className={styles.toolActivity}>
                  <div className={styles.toolHeader}>
                    <span className={styles.toolName} style={{ color: toolColor(act.toolName) }}>{act.toolName}</span>
                    {activitySummaryText(act) && (
                      <span className={styles.toolSummary}>
                        <HighlightedPlainText text={relativizePath(activitySummaryText(act), worktreePath)} query={searchQuery} />
                      </span>
                    )}
                  </div>
                </div>
              ),
            )}
          </div>
        )}
      </div>
    </div>
  );
});
