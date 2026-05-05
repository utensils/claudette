import type { CompletedTurn, ToolActivity } from "../../stores/useAppStore";
import type { TaskTrackerResult } from "../../hooks/useTaskTracker";
import { extractToolSummary, relativizePath } from "../../hooks/toolSummary";
import { HighlightedPlainText } from "./HighlightedPlainText";
import styles from "./ChatPanel.module.css";
import { toolColor } from "./chatHelpers";
import { TurnFooter } from "./TurnFooter";
import { TaskProgressBar } from "./TaskProgressBar";

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
}) {
  const visibleActivities = activities ?? turn.activities;
  const hasElapsed = typeof turn.durationMs === "number" && turn.durationMs > 0;
  const hasTokens =
    typeof turn.inputTokens === "number" && typeof turn.outputTokens === "number";
  const hasCopy = assistantText.length > 0;
  const hasFork = !!onFork;
  const hasRollback = !!onRollback;
  const shouldShowFooter =
    showFooter && (hasElapsed || hasTokens || hasCopy || hasFork || hasRollback);

  // Force-expand if the query matches in any activity summary or the
  // resolved tool-summary fallback. Without this, marks would land in
  // detached DOM (the collapsed branch never renders), so the bar's
  // counter would tick up but nothing visible would change.
  // Match against the same relativized text we render — otherwise a query
  // hitting only the stripped workspace prefix would force-expand with no
  // visible highlight inside.
  const queryHasMatch =
    !!searchQuery &&
    visibleActivities.some((a) => {
      const text = relativizePath(
        activitySummaryText(a),
        worktreePath,
      );
      return text.toLowerCase().includes(searchQuery.toLowerCase());
    });
  const isExpanded = !collapsed || queryHasMatch;

  return (
    <div className={styles.turnSummaryWrapper}>
      <div
        className={styles.turnSummary}
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <div className={styles.turnHeader}>
          <span className={styles.toolChevron}>
            {isExpanded ? "⌄" : "›"}
          </span>
          <span className={styles.turnLabel}>
            {visibleActivities.length} tool call
            {visibleActivities.length !== 1 ? "s" : ""}
            {turn.messageCount > 0 &&
              `, ${turn.messageCount} message${turn.messageCount !== 1 ? "s" : ""}`}
          </span>
        </div>
        {isExpanded && (
          <div className={styles.turnActivities}>
            {visibleActivities.map((act: ToolActivity) => (
              <div key={act.toolUseId} className={styles.toolActivity}>
                <div className={styles.toolHeader}>
                  <span className={styles.toolName} style={{ color: toolColor(act.toolName) }}>
                    {act.toolName}
                  </span>
                  {activitySummaryText(act) && (
                    <span className={styles.toolSummary}>
                      <HighlightedPlainText
                        text={relativizePath(activitySummaryText(act), worktreePath)}
                        query={searchQuery}
                      />
                    </span>
                  )}
                </div>
                {(act.agentLastToolName || act.agentToolUseCount || act.agentStatus) && (
                  <div className={styles.agentToolProgress}>
                    {act.agentStatus && (
                      <span className={styles.agentToolStatus}>{act.agentStatus}</span>
                    )}
                    {typeof act.agentToolUseCount === "number" && (
                      <span>
                        {act.agentToolUseCount} agent tool call
                        {act.agentToolUseCount !== 1 ? "s" : ""}
                      </span>
                    )}
                    {act.agentLastToolName && (
                      <span>latest: {act.agentLastToolName}</span>
                    )}
                  </div>
                )}
                {act.agentToolCalls && act.agentToolCalls.length > 0 && (
                  <div className={styles.agentToolCallList}>
                    {act.agentToolCalls.map((call) => (
                      <div key={call.toolUseId} className={styles.agentToolCall}>
                        <span className={styles.agentToolCallName}>
                          {call.toolName}
                        </span>
                        <span className={styles.agentToolCallStatus}>
                          {call.status}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      {taskProgress && taskProgress.totalCount > 0 && (
        <TaskProgressBar
          completedCount={taskProgress.completedCount}
          totalCount={taskProgress.totalCount}
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

function activitySummaryText(activity: ToolActivity): string {
  return (
    activity.summary ||
    activity.agentDescription ||
    extractToolSummary(activity.toolName, activity.inputJson) ||
    ""
  );
}
