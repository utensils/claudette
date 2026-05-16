import { useId, useMemo } from "react";
import type { CompletedTurn, ToolActivity } from "../../stores/useAppStore";
import type { TaskTrackerResult } from "../../hooks/useTaskTracker";
import styles from "./ChatPanel.module.css";
import { TurnFooter } from "./TurnFooter";
import { TaskProgressBar } from "./TaskProgressBar";
import { activityMatchesSearch } from "./agentToolCallRendering";
import { toolColor } from "./chatHelpers";
import { AgentToolCallGroup } from "./AgentToolCallGroup";
import { ToolActivityRow } from "./ToolActivityRow";
import { isAgentActivity } from "./toolActivityGroups";
import { TurnEditSummaryCard } from "./EditChangeSummary";
import {
  type EditPreviewLine,
  type EditSummary,
  summarizeTurnEdits,
} from "./editActivitySummary";

/// Split the leading "Agent" / "Skill" prefix on a turn label into a
/// colored span so the finalized summary matches the accent color used
/// while the turn was still running. Anything else renders as a plain
/// string. Kept inline rather than promoted to a helper module — the
/// only other consumer of `toolColor` already lives in TurnSummary.
const COLORED_PREFIX = /^(Agent|Skill) (.+)$/;
function renderTurnLabel(label: string) {
  const match = COLORED_PREFIX.exec(label);
  if (!match) return label;
  const [, tool, rest] = match;
  return (
    <>
      <span style={{ color: toolColor(tool) }}>{tool}</span>
      {" "}
      {rest}
    </>
  );
}

/**
 * Render a single completed turn summary (collapsible tool call list).
 */
export function TurnSummary({
  turn,
  activities,
  showFooter = true,
  collapsed,
  onToggle,
  taskProgress,
  assistantText,
  onFork,
  onRollback,
  searchQuery,
  worktreePath,
  label,
  inline = false,
  editSummaryFallback,
  onLoadEditPreview,
  onOpenEditFile,
}: {
  turn: CompletedTurn;
  activities?: ToolActivity[];
  showFooter?: boolean;
  collapsed: boolean;
  onToggle: () => void;
  taskProgress?: TaskTrackerResult;
  /** Joined text from assistant messages in this turn, used by copy action.
   *  When empty, the copy button is not rendered. */
  assistantText: string;
  /** Called when the user clicks fork. When undefined the fork button is not
   *  rendered (e.g. remote workspaces, where the fork command cannot run). */
  onFork?: () => void;
  /** Called when the user clicks rollback. Undefined hides the button
   *  (e.g. turn is running, or no checkpoint exists for this turn). */
  onRollback?: () => void;
  /** Active chat-search query. Force-expands this card when non-empty and
   *  the query matches inside any of the contained activity summaries. */
  searchQuery: string;
  worktreePath?: string | null;
  label?: string;
  inline?: boolean;
  /** Rescue summary used only when activity-derived edits return null —
   *  typically the workspace-diff summary for the latest turn, where the
   *  agent's tools couldn't be parsed (Bash heredoc, MCP write tool, etc.).
   *  Activity-derived data wins when present so per-turn churn stays
   *  scoped to what THIS turn touched, not the cumulative worktree diff. */
  editSummaryFallback?: EditSummary | null;
  onLoadEditPreview?: (filePath: string) => Promise<EditPreviewLine[]>;
  /** Open a file in the Monaco editor tab. Wired by
   *  `MessagesWithTurns` to `openFileTab(workspaceId, filePath)` —
   *  same action the FILES tree uses, NOT the diff viewer. */
  onOpenEditFile?: (filePath: string) => void;
}) {
  const visibleActivities = activities ?? turn.activities;
  const hasElapsed = typeof turn.durationMs === "number" && turn.durationMs > 0;
  const hasTokens =
    typeof turn.inputTokens === "number" && typeof turn.outputTokens === "number";
  const hasCopy = assistantText.length > 0;
  const activitiesId = useId();
  const hasFork = !!onFork;
  const hasRollback = !!onRollback;
  const shouldShowFooter =
    showFooter && (hasElapsed || hasTokens || hasCopy || hasFork || hasRollback);
  const activityEditSummary = useMemo(
    () => (showFooter ? summarizeTurnEdits(turn.activities) : null),
    [showFooter, turn.activities],
  );
  const editSummary = showFooter
    ? activityEditSummary ?? editSummaryFallback ?? null
    : null;

  // Force-expand if the query matches in any activity summary or the
  // resolved tool-summary fallback. Without this, marks would land in
  // detached DOM (the collapsed branch never renders), so the bar's
  // counter would tick up but nothing visible would change.
  // Match against the same relativized text we render — otherwise a query
  // hitting only the stripped workspace prefix would force-expand with no
  // visible highlight inside.
  const queryHasMatch =
    !!searchQuery &&
    visibleActivities.some((activity) =>
      activityMatchesSearch(activity, searchQuery, worktreePath),
    );
  const isExpanded = inline || !collapsed || queryHasMatch;
  const renderedActivities = visibleActivities.map((act: ToolActivity) => {
    if (isAgentActivity(act)) {
      return (
        <AgentToolCallGroup
          key={act.toolUseId}
          activity={act}
          searchQuery={searchQuery}
          worktreePath={worktreePath}
          inline={inline}
        />
      );
    }

    return (
      <ToolActivityRow
        key={act.toolUseId}
        activity={act}
        searchQuery={searchQuery}
        worktreePath={worktreePath}
        inline={inline}
      />
    );
  });

  return (
    <div className={styles.turnSummaryWrapper}>
      {inline ? (
        <div className={styles.inlineTurnActivities}>{renderedActivities}</div>
      ) : (
        <div className={styles.turnSummary}>
          <div
            className={styles.turnHeader}
            role="button"
            tabIndex={0}
            aria-expanded={isExpanded}
            aria-controls={activitiesId}
            onClick={onToggle}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onToggle();
              }
            }}
          >
            <span className={styles.toolChevron}>{isExpanded ? "⌄" : "›"}</span>
            <span className={styles.turnLabel}>
              {label != null ? (
                renderTurnLabel(label)
              ) : (
                `${visibleActivities.length} tool call${
                  visibleActivities.length !== 1 ? "s" : ""
                }`
              )}
              {showFooter && turn.messageCount > 0 &&
                `, ${turn.messageCount} message${turn.messageCount !== 1 ? "s" : ""}`}
            </span>
          </div>
          {isExpanded && (
            <div id={activitiesId} className={styles.turnActivities}>
              {renderedActivities}
            </div>
          )}
        </div>
      )}
      {taskProgress && taskProgress.totalCount > 0 && (
        <TaskProgressBar
          completedCount={taskProgress.completedCount}
          totalCount={taskProgress.totalCount}
        />
      )}
      {editSummary && (
        <TurnEditSummaryCard
          summary={editSummary}
          searchQuery={searchQuery}
          worktreePath={worktreePath}
          onLoadPreview={onLoadEditPreview}
          onOpenFile={onOpenEditFile}
        />
      )}
      {shouldShowFooter && (
        <TurnFooter
          durationMs={turn.durationMs}
          inputTokens={turn.inputTokens}
          outputTokens={turn.outputTokens}
          assistantText={hasCopy ? assistantText : undefined}
          onFork={onFork}
          onRollback={onRollback}
        />
      )}
    </div>
  );
}
