import { memo, useMemo } from "react";
import { useAppStore } from "../../stores/useAppStore";
import { deriveTasks, hasTaskActivity } from "../../hooks/useTaskTracker";
import { TaskProgressBar } from "./TaskProgressBar";
import { EMPTY_ACTIVITIES, EMPTY_COMPLETED_TURNS } from "./chatConstants";

/**
 * Shows a progress bar for the current in-progress turn, only when
 * task-related tools are among the current activities. Disappears when
 * the turn finalises (tasks move into CompletedTurn rendering).
 */
export const CurrentTurnTaskProgress = memo(function CurrentTurnTaskProgress({
  sessionId,
}: {
  sessionId: string;
}) {
  const completedTurns = useAppStore(
    (s) => s.completedTurns[sessionId] ?? EMPTY_COMPLETED_TURNS,
  );
  const toolActivities = useAppStore(
    (s) => s.toolActivities[sessionId] ?? EMPTY_ACTIVITIES,
  );

  const result = useMemo(
    () => deriveTasks(completedTurns, toolActivities),
    [completedTurns, toolActivities],
  );

  // Only render when the current turn has task tools
  if (!hasTaskActivity(toolActivities) || result.totalCount === 0) return null;

  return (
    <TaskProgressBar completedCount={result.completedCount} totalCount={result.totalCount} />
  );
});
