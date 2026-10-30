import { useId, useMemo } from "react";
import { Plug2 } from "lucide-react";
import type { CompletedTurn, ToolActivity } from "../../stores/useAppStore";
import type { TaskTrackerResult } from "../../hooks/useTaskTracker";
import styles from "./ChatPanel.module.css";
import { TurnFooter } from "./TurnFooter";
import { TaskProgressBar } from "./TaskProgressBar";
import { activityMatchesSearch } from "./agentToolCallRendering";
import { toolColor } from "./chatHelpers";
import { AgentToolCallGroup } from "./AgentToolCallGroup";
import { WorkflowCard } from "./WorkflowCard";
import { ToolActivityRow } from "./ToolActivityRow";
import {
  isAgentActivity,
  isWorkflowActivity,
  toolBreakdown,
  type ToolActivityDisplayGroup,
} from "./toolActivityGroups";
import { AgentRollupGroup } from "./AgentActivityGroups";
import { DisclosureHeader } from "./DisclosureHeader";
import { TurnEditSummaryCard } from "./EditChangeSummary";
import {
  type EditPreviewLine,
  type EditSummary,
  summarizeTurnEdits,
} from "./editActivitySummary";

/// Split the leading "Agent" / "Skill" / "Workflow" prefix on a turn label
/// into a colored span so the finalized summary matches the accent color
/// used while the turn was still running. Handles three label shapes:
///   • bare  — "Agent" / "Skill" / "Workflow"
///   • prefixed — "Agent <description>" / "Workflow <name>"
///   • anything else — rendered untouched
/// Kept inline rather than promoted to a helper module — the only
/// other consumer of `toolColor` already lives in TurnSummary.
const COLORED_PREFIX = /^(Agent|Skill|Workflow)(?:\s+(.+))?$/;
function renderTurnLabel(label: string) {
  const match = COLORED_PREFIX.exec(label);
  if (!match) return label;
  const [, tool, rest] = match;
  return (
    <>
      <span style={{ color: toolColor(tool) }}>{tool}</span>
      {rest != null && (
        <>
          {" "}
          {rest}
        </>
      )}
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
  mcp = false,
  kind,
  sessionId,
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
  /** MCP group: prefix the header with the Plug2 icon and render the
   *  contained rows with their `mcp__<server>__` prefix stripped. */
  mcp?: boolean;
  /** Display-group kind from `groupToolActivitiesForDisplay`. Agent and
   *  agent-rollup groups own their header, so this card forwards its
   *  collapse state to them instead of wrapping them in a second chevron. */
  kind?: ToolActivityDisplayGroup["kind"];
  /** Needed by agent rollups, whose member agents persist their own
   *  collapse state per session. */
  sessionId?: string;
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
  const breakdown = useMemo(
    () => toolBreakdown(visibleActivities),
    [visibleActivities],
  );

  // In grouped mode a workflow is always a group of exactly one activity
  // (`groupToolActivitiesForDisplay` gives it its own group), and the card it
  // renders already owns a header, chevron, and progress rail. So hand this
  // group's `collapsed`/`onToggle` to the card rather than spending them on
  // the generic TurnSummary chevron.
  //
  // That keeps one chevron on screen instead of two, but the real reason is
  // that `workflow:<toolUseId>` is shared with the live card on purpose (see
  // `collapsedToolGroupKey`) — and wrapping made the key mean two different
  // things across the running→completed boundary. While live, collapse hid
  // only the agent tree and kept the header/rail; once the turn ended the
  // TurnSummary chevron unmounted the whole card, so the final agent count,
  // failure badge, and token total silently disappeared — exactly the summary
  // a user collapsing a finished run wants to keep. Forwarding makes collapse
  // mean "hide the agent tree" on both sides.
  const soleActivity =
    visibleActivities.length === 1 ? visibleActivities[0] : undefined;
  const workflowCollapseOwner =
    !inline && soleActivity && isWorkflowActivity(soleActivity)
      ? soleActivity
      : null;
  // Same reasoning for Agent groups. Wrapping one in a TurnSummary chevron
  // made a completed agent look different from the live one: collapsed, it
  // lost its status/count/usage row (only the outer label survived), and
  // expanded it showed two stacked headers. Forwarding keeps "collapse"
  // meaning "hide the nested transcript, keep the header and progress".
  const agentCollapseOwner =
    !inline && soleActivity && isAgentActivity(soleActivity) && kind !== "agents"
      ? soleActivity
      : null;
  const agentRollupOwner =
    !inline && kind === "agents" && sessionId ? visibleActivities : null;

  const renderedActivities = visibleActivities.map((act: ToolActivity) => {
    if (isWorkflowActivity(act)) {
      // Reached only in inline display mode (grouped mode routes the card
      // through `workflowCollapseOwner` above). Inline mode renders every
      // activity flush with no enclosing chevron, so the card has no collapse
      // affordance to inherit and stays expanded.
      return <WorkflowCard key={act.toolUseId} activity={act} inline />;
    }
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
        mcp={mcp}
      />
    );
  });

  return (
    <div className={styles.turnSummaryWrapper}>
      {workflowCollapseOwner ? (
        <div className={styles.inlineTurnActivities}>
          <WorkflowCard
            activity={workflowCollapseOwner}
            collapsed={!isExpanded}
            onToggle={onToggle}
          />
        </div>
      ) : agentCollapseOwner ? (
        <AgentToolCallGroup
          activity={agentCollapseOwner}
          searchQuery={searchQuery}
          worktreePath={worktreePath}
          collapsed={!isExpanded}
          onToggle={onToggle}
        />
      ) : agentRollupOwner && sessionId ? (
        <AgentRollupGroup
          sessionId={sessionId}
          activities={agentRollupOwner}
          collapsed={collapsed}
          onToggle={onToggle}
          searchQuery={searchQuery}
          worktreePath={worktreePath}
        />
      ) : inline ? (
        <div className={styles.inlineTurnActivities}>{renderedActivities}</div>
      ) : (
        <div className={styles.turnSummary}>
          <DisclosureHeader
            className={styles.turnHeader}
            expanded={isExpanded}
            onToggle={onToggle}
            ariaControls={activitiesId}
          >
            {mcp && (
              <Plug2
                size={13}
                aria-hidden="true"
                className={styles.mcpGroupIcon}
              />
            )}
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
            {label == null || kind === "tools" || kind === "mcp" ? (
              breakdown && <span className={styles.turnBreakdown}>{breakdown}</span>
            ) : null}
          </DisclosureHeader>
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
