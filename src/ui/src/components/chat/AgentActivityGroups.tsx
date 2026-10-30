import { memo, useId } from "react";
import { useTranslation } from "react-i18next";
import type { ToolActivity } from "../../stores/useAppStore";
import styles from "./ChatPanel.module.css";
import { activityMatchesSearch } from "./agentToolCallRendering";
import { agentTaskState } from "./agentActivityDisplay";
import { AgentToolCallGroup } from "./AgentToolCallGroup";
import { collapsedToolGroupKey } from "./collapsedToolGroupKey";
import { DisclosureHeader } from "./DisclosureHeader";
import { formatTokens } from "./formatTokens";
import type { TaskState } from "./TaskStateIcon";
import { TaskStateIcon } from "./TaskStateIcon";
import { useCollapsedToolGroup } from "./useCollapsedToolGroup";

/**
 * One Agent activity with a store-backed collapse toggle. The header label
 * and progress row (status / count / usage) stay visible while collapsed;
 * only the nested transcript is hidden — live agents run for minutes and a
 * glance should show whether they're making progress.
 *
 * Persists under `agent:<toolUseId>` in `collapsedToolGroupsBySession`, the
 * same key the completed-turn path reads, so the user's choice survives the
 * running→completed transition.
 */
export const CollapsibleAgentActivity = memo(function CollapsibleAgentActivity({
  sessionId,
  activity,
  searchQuery,
  worktreePath,
  live = false,
}: {
  sessionId: string;
  activity: ToolActivity;
  searchQuery: string;
  worktreePath?: string | null;
  live?: boolean;
}) {
  const groupKey = collapsedToolGroupKey([activity]);
  const [collapsed, setCollapsed] = useCollapsedToolGroup(sessionId, groupKey, true);
  // Force-expand on a search hit: marks need a mounted DOM target.
  // `activityMatchesSearch` walks `agentToolCalls`, so a query matching an
  // agent-internal call still pops the parent open.
  const queryHasMatch =
    !!searchQuery && activityMatchesSearch(activity, searchQuery, worktreePath);
  const isCollapsed = !queryHasMatch && collapsed;
  // Persist the *visible* state's inverse, not `!collapsed`: clicking a
  // search-forced-open header means "hide this", and must not silently
  // flip the stored override so the agent springs open once search clears.
  const toggle = () => setCollapsed(!isCollapsed);

  return (
    <AgentToolCallGroup
      activity={activity}
      searchQuery={searchQuery}
      worktreePath={worktreePath}
      collapsed={isCollapsed}
      onToggle={toggle}
      live={live}
    />
  );
});

const ROLLUP_STATE_ORDER: readonly TaskState[] = [
  "progress",
  "done",
  "error",
  "stopped",
  "queued",
];

/**
 * Rollup for a fan-out of consecutive Agent calls: one header with
 * per-state counts and total tokens, each agent below as its own
 * collapsible row. Collapse is owned by the caller (store-backed while
 * live, turn-level while completed) so both paths share one key
 * (`agents:<firstToolUseId>`).
 */
export const AgentRollupGroup = memo(function AgentRollupGroup({
  sessionId,
  activities,
  collapsed,
  onToggle,
  searchQuery,
  worktreePath,
  live = false,
}: {
  sessionId: string;
  activities: readonly ToolActivity[];
  collapsed: boolean;
  onToggle: () => void;
  searchQuery: string;
  worktreePath?: string | null;
  live?: boolean;
}) {
  const { t } = useTranslation("chat");
  const bodyId = useId();

  const counts = new Map<TaskState, number>();
  let totalTokens = 0;
  let hasTokens = false;
  for (const activity of activities) {
    const state = agentTaskState(activity, live);
    counts.set(state, (counts.get(state) ?? 0) + 1);
    if (typeof activity.agentTotalTokens === "number") {
      totalTokens += activity.agentTotalTokens;
      hasTokens = true;
    }
  }
  const stateLabel = (state: TaskState, count: number): string => {
    switch (state) {
      case "progress":
        return t("agents_running", { count, defaultValue: `${count} running` });
      case "done":
        return t("agents_done", { count, defaultValue: `${count} done` });
      case "error":
        return t("agents_failed", { count, defaultValue: `${count} failed` });
      case "stopped":
        return t("agents_stopped", { count, defaultValue: `${count} stopped` });
      default:
        return t("agents_queued", { count, defaultValue: `${count} queued` });
    }
  };

  const queryHasMatch =
    !!searchQuery &&
    activities.some((activity) =>
      activityMatchesSearch(activity, searchQuery, worktreePath),
    );
  const isExpanded = queryHasMatch || !collapsed;
  const label = `${activities.length} agents`;

  return (
    <div className={styles.turnSummary}>
      <DisclosureHeader
        className={styles.turnHeader}
        expanded={isExpanded}
        onToggle={onToggle}
        ariaLabel={`${isExpanded ? "Collapse" : "Expand"} ${label}`}
        ariaControls={bodyId}
      >
        <span className={styles.turnLabel}>{label}</span>
        <span className={styles.agentRollupCounts}>
          {ROLLUP_STATE_ORDER.filter((state) => counts.has(state)).map((state) => (
            <span key={state} className={styles.agentRollupCount}>
              <TaskStateIcon state={state} className={styles.agentStateIcon} />
              {stateLabel(state, counts.get(state) ?? 0)}
            </span>
          ))}
          {hasTokens && (
            <span className={styles.agentRollupCount}>
              {t("agent_tokens", {
                tokens: formatTokens(totalTokens),
                defaultValue: `${formatTokens(totalTokens)} tokens`,
              })}
            </span>
          )}
        </span>
      </DisclosureHeader>
      {isExpanded && (
        <div id={bodyId} className={styles.agentRollupBody}>
          {activities.map((activity) => (
            <CollapsibleAgentActivity
              key={activity.toolUseId}
              sessionId={sessionId}
              activity={activity}
              searchQuery={searchQuery}
              worktreePath={worktreePath}
              live={live}
            />
          ))}
        </div>
      )}
    </div>
  );
});
