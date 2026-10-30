import { memo, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ToolActivity } from "../../stores/useAppStore";
import { relativizePath } from "../../hooks/toolSummary";
import { HighlightedPlainText } from "./HighlightedPlainText";
import styles from "./ChatPanel.module.css";
import { formatDurationMs, toolColor } from "./chatHelpers";
import { formatTokens } from "./formatTokens";
import {
  activitySummaryText,
  agentPromptText,
  agentToolCallSummary,
} from "./agentToolCallRendering";
import { agentSubagentType, agentTaskState } from "./agentActivityDisplay";
import { DisclosureHeader } from "./DisclosureHeader";
import { InlineEditSummary } from "./EditChangeSummary";
import { summarizeAgentToolCallEdit } from "./editActivitySummary";
import { TaskStateIcon } from "./TaskStateIcon";
import { ThinkingBlock } from "./ThinkingBlock";
import { HighlightedMessageMarkdown } from "./HighlightedMessageMarkdown";

/** Nested tool calls shown before the "show all" affordance. Long-running
 *  subagents routinely make 50–200 calls; rendering every row buries the
 *  prompt and result the user actually came for. The *latest* calls are
 *  kept because they are what a live reader is watching. */
export const AGENT_VISIBLE_CALLS = 8;

/** Results longer than this start clamped behind a "show full result"
 *  toggle so a single verbose subagent doesn't dominate the transcript. */
const AGENT_RESULT_CLAMP_CHARS = 1200;

export const AgentToolCallGroup = memo(function AgentToolCallGroup({
  activity,
  searchQuery,
  worktreePath,
  inline = false,
  collapsed,
  onToggle,
  live = false,
}: {
  activity: ToolActivity;
  searchQuery: string;
  worktreePath?: string | null;
  inline?: boolean;
  /**
   * Optional collapse state. When `onToggle` is provided alongside this,
   * the header becomes interactive (chevron + click/keyboard) and the
   * nested transcript is hidden while `collapsed` is true. The header and
   * progress row (status, call count, usage) remain visible regardless —
   * Agent invocations run for minutes and a fully-hidden live agent would
   * feel dead. The `inline` mode (grouped-tool-calls setting OFF) ignores
   * both props to preserve the original always-expanded behavior.
   */
  collapsed?: boolean;
  onToggle?: () => void;
  /** The enclosing turn is still running — an Agent with no reported
   *  status yet reads as in-progress rather than unknown. */
  live?: boolean;
}) {
  const { t } = useTranslation("chat");
  const [showAllCalls, setShowAllCalls] = useState(false);
  const [showFullResult, setShowFullResult] = useState(false);
  const nestedId = useId();

  const summary = activitySummaryText(activity);
  const prompt = agentPromptText(activity);
  const subagentType = agentSubagentType(activity);
  const state = agentTaskState(activity, live);
  const calls = activity.agentToolCalls ?? [];
  const thinkingBlocks = activity.agentThinkingBlocks ?? [];
  const resultText = activity.agentResultText || activity.resultText;
  // Inline mode is the legacy "show everything inline" rendering; do
  // not let collapse semantics leak into it. Only when an explicit
  // toggle has been wired do we render the chevron and gate the body.
  const collapsible = !inline && typeof onToggle === "function";
  const isCollapsed = collapsible && collapsed === true;

  // A search query must be able to reach hidden calls and the clamped
  // tail of the result — otherwise the search bar counts hits the user
  // can't see.
  const searching = searchQuery.length > 0;
  const hiddenCallCount =
    showAllCalls || searching ? 0 : Math.max(0, calls.length - AGENT_VISIBLE_CALLS);
  const visibleCalls = hiddenCallCount > 0 ? calls.slice(hiddenCallCount) : calls;
  const resultClamped =
    !showFullResult && !searching && resultText.length > AGENT_RESULT_CLAMP_CHARS;

  const headerContent = (
    <>
      <TaskStateIcon
        state={state}
        label={activity.agentStatus || state}
        className={styles.agentStateIcon}
      />
      <span
        className={styles.toolName}
        style={{ color: toolColor(activity.toolName) }}
      >
        {activity.toolName}
      </span>
      {subagentType && (
        <span className={styles.agentTypeBadge}>{subagentType}</span>
      )}
      {summary && (
        <span className={styles.toolSummary}>
          <HighlightedPlainText
            text={relativizePath(summary, worktreePath)}
            query={searchQuery}
          />
        </span>
      )}
    </>
  );

  const hasUsage =
    typeof activity.agentTotalTokens === "number" ||
    (typeof activity.agentDurationMs === "number" && activity.agentDurationMs > 0);

  return (
    <div className={inline ? styles.agentToolGroupInline : styles.agentToolGroup}>
      {collapsible ? (
        <DisclosureHeader
          className={styles.agentToolGroupHeader}
          expanded={!isCollapsed}
          onToggle={onToggle}
          ariaLabel={`${isCollapsed ? "Expand" : "Collapse"} ${activity.toolName} transcript details`}
          ariaControls={nestedId}
        >
          {headerContent}
        </DisclosureHeader>
      ) : (
        <div className={styles.agentToolGroupHeader}>{headerContent}</div>
      )}
      {(activity.agentStatus ||
        typeof activity.agentToolUseCount === "number" ||
        activity.agentLastToolName ||
        hasUsage) && (
        <div className={styles.agentToolProgress}>
          {activity.agentStatus && (
            <span className={styles.agentToolStatus}>{activity.agentStatus}</span>
          )}
          {typeof activity.agentToolUseCount === "number" && (
            <span>
              {activity.agentToolUseCount} agent tool call
              {activity.agentToolUseCount !== 1 ? "s" : ""}
            </span>
          )}
          {typeof activity.agentTotalTokens === "number" && (
            <span>
              {t("agent_tokens", {
                tokens: formatTokens(activity.agentTotalTokens),
                defaultValue: `${formatTokens(activity.agentTotalTokens)} tokens`,
              })}
            </span>
          )}
          {typeof activity.agentDurationMs === "number" &&
            activity.agentDurationMs > 0 && (
              <span>{formatDurationMs(activity.agentDurationMs)}</span>
            )}
          {/* "latest" only means something while the agent is working. */}
          {activity.agentLastToolName && state === "progress" && (
            <span>latest: {activity.agentLastToolName}</span>
          )}
        </div>
      )}
      {!isCollapsed && (
        <div id={nestedId} className={styles.agentNestedChat}>
          {prompt && (
            <div className={styles.agentNestedMessage}>
              <div className={styles.agentNestedRole}>Prompt</div>
              <div className={styles.agentNestedText}>
                <HighlightedPlainText
                  text={relativizePath(prompt, worktreePath)}
                  query={searchQuery}
                />
              </div>
            </div>
          )}
          {thinkingBlocks.map((thinking, index) => (
            <ThinkingBlock
              key={`${activity.toolUseId}:thinking:${index}`}
              content={thinking}
              isStreaming={false}
              searchQuery={searchQuery}
            />
          ))}
          {calls.length > 0 && (
            <div className={styles.agentNestedSection}>
              <div className={styles.agentNestedRole}>Tool calls</div>
              <div className={styles.agentToolCallList}>
                {hiddenCallCount > 0 && (
                  <button
                    type="button"
                    className={styles.agentShowMore}
                    onClick={() => setShowAllCalls(true)}
                  >
                    {t("agent_show_all_calls", {
                      count: calls.length,
                      defaultValue: `Show all ${calls.length} tool calls`,
                    })}
                  </button>
                )}
                {visibleCalls.map((call) => {
                  const callSummary = agentToolCallSummary(call);
                  const editSummary = summarizeAgentToolCallEdit(call);
                  return (
                    <div key={call.toolUseId} className={styles.agentToolCall}>
                      <TaskStateIcon
                        state={
                          call.status === "completed"
                            ? "done"
                            : call.status === "failed"
                              ? "error"
                              : "progress"
                        }
                        label={call.status}
                        className={styles.agentToolCallStateIcon}
                      />
                      {editSummary ? (
                        <InlineEditSummary
                          summary={editSummary}
                          searchQuery={searchQuery}
                          worktreePath={worktreePath}
                        />
                      ) : (
                        <span
                          className={styles.agentToolCallName}
                          style={{ color: toolColor(call.toolName) }}
                        >
                          {call.toolName}
                        </span>
                      )}
                      {!editSummary && callSummary && (
                        <span className={styles.agentToolCallSummary}>
                          <HighlightedPlainText
                            text={relativizePath(callSummary, worktreePath)}
                            query={searchQuery}
                          />
                        </span>
                      )}
                    </div>
                  );
                })}
                {showAllCalls && calls.length > AGENT_VISIBLE_CALLS && (
                  <button
                    type="button"
                    className={styles.agentShowMore}
                    onClick={() => setShowAllCalls(false)}
                  >
                    {t("agent_show_fewer_calls", { defaultValue: "Show fewer" })}
                  </button>
                )}
              </div>
            </div>
          )}
          {resultText && (
            <div className={styles.agentNestedMessage}>
              <div className={styles.agentNestedRole}>Result</div>
              <div
                className={
                  resultClamped
                    ? `${styles.agentNestedMarkdown} ${styles.agentResultClamped}`
                    : styles.agentNestedMarkdown
                }
              >
                <HighlightedMessageMarkdown
                  content={resultText}
                  query={searchQuery}
                />
              </div>
              {resultText.length > AGENT_RESULT_CLAMP_CHARS && !searching && (
                <button
                  type="button"
                  className={styles.agentShowMore}
                  onClick={() => setShowFullResult((v) => !v)}
                >
                  {showFullResult
                    ? t("agent_result_show_less", { defaultValue: "Show less" })
                    : t("agent_result_show_more", {
                        defaultValue: "Show full result",
                      })}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
});
