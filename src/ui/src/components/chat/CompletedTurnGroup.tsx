import { memo, useCallback } from "react";
import { useAppStore } from "../../stores/useAppStore";
import type { CompletedTurn, ToolActivity } from "../../stores/useAppStore";
import type { ToolDisplayMode } from "../../stores/slices/settingsSlice";
import type { TaskTrackerResult } from "../../hooks/useTaskTracker";
import type { RollbackModalData } from "./chatConstants";
import type { ToolActivityDisplayGroup } from "./toolActivityGroups";
import { TurnSummary } from "./TurnSummary";

/**
 * One display group of a completed turn (a tool-call group, an agent, a
 * workflow, …) rendered through `TurnSummary`.
 *
 * Exists so the group can be memoized: `MessagesWithTurns` used to build
 * fresh `onToggle` / `onFork` / `onRollback` closures for every group on
 * every render, so every completed turn in the transcript re-rendered on
 * any transcript update. Here the props are data plus stable callbacks, and
 * the per-group handlers are derived inside.
 */
export const CompletedTurnGroup = memo(function CompletedTurnGroup({
  sessionId,
  turn,
  globalIdx,
  groupKey,
  userOverride,
  isSingleGroupTurn,
  activities,
  label,
  kind,
  showFooter,
  toolDisplayMode,
  searchQuery,
  worktreePath,
  taskProgress,
  assistantText,
  rollbackData,
  onForkTurn,
  onOpenEditFile,
}: {
  sessionId: string;
  turn: CompletedTurn;
  /** Index of `turn` in the session's `completedTurns`. */
  globalIdx: number;
  /** `collapsedToolGroupKey` for this group. */
  groupKey: string;
  /** The user's stored collapse choice for `groupKey`, if any. */
  userOverride: boolean | undefined;
  /** Whether this is the turn's only display group (see `onToggle`). */
  isSingleGroupTurn: boolean;
  activities: ToolActivity[];
  label: string;
  kind: ToolActivityDisplayGroup["kind"];
  showFooter: boolean;
  toolDisplayMode: ToolDisplayMode;
  searchQuery: string;
  worktreePath?: string | null;
  taskProgress?: TaskTrackerResult;
  assistantText: string;
  /** Rollback target; undefined hides the button (running turn, or no
   *  checkpoint for this turn). */
  rollbackData?: RollbackModalData;
  onForkTurn?: (checkpointId: string) => void;
  onOpenEditFile?: (filePath: string) => void;
}) {
  // Workflows and agent rollups default to expanded on both sides of the
  // turn boundary. `turn.collapsed` defaults to true, which would fold an
  // untouched workflow card the instant its turn ended — reversing what the
  // user was just watching (see `GroupedWorkflowActivity` /
  // `GroupedAgentRollup` for the matching live defaults).
  const expandedByDefault = kind === "workflow" || kind === "agents";
  const collapsed = userOverride ?? (expandedByDefault ? false : turn.collapsed);

  const onToggle = useCallback(() => {
    const next = !collapsed;
    const { setCollapsedToolGroup, toggleCompletedTurn } = useAppStore.getState();
    setCollapsedToolGroup(sessionId, groupKey, next);
    // Single-group turns also flip the legacy `turn.collapsed` flag so
    // persistence-aware code sees the same state without consulting the
    // override map. Multi-group turns only touch the per-group override —
    // flipping `turn.collapsed` there would drag every sibling group with
    // it. Expanded-by-default groups read the override against their own
    // `false` default and never consult `turn.collapsed`, so syncing would
    // drift it away from what the card shows.
    if (!expandedByDefault && isSingleGroupTurn && next !== turn.collapsed) {
      toggleCompletedTurn(sessionId, globalIdx);
    }
  }, [
    collapsed,
    expandedByDefault,
    globalIdx,
    groupKey,
    isSingleGroupTurn,
    sessionId,
    turn.collapsed,
  ]);

  const onFork = useCallback(() => onForkTurn?.(turn.id), [onForkTurn, turn.id]);
  const onRollback = useCallback(() => {
    if (rollbackData) useAppStore.getState().openModal("rollback", rollbackData);
  }, [rollbackData]);

  return (
    <TurnSummary
      turn={turn}
      activities={activities}
      label={label}
      inline={toolDisplayMode === "inline"}
      mcp={kind === "mcp"}
      kind={kind}
      sessionId={sessionId}
      showFooter={showFooter}
      collapsed={collapsed}
      onToggle={onToggle}
      taskProgress={showFooter ? taskProgress : undefined}
      assistantText={showFooter ? assistantText : ""}
      onFork={showFooter && onForkTurn ? onFork : undefined}
      onRollback={showFooter && rollbackData ? onRollback : undefined}
      searchQuery={searchQuery}
      worktreePath={worktreePath}
      onOpenEditFile={showFooter ? onOpenEditFile : undefined}
    />
  );
});
