import type { KeyboardEvent } from "react";
import type { ToolActivity } from "../../stores/useAppStore";
import { relativizePath } from "../../hooks/toolSummary";
import { HighlightedPlainText } from "./HighlightedPlainText";
import styles from "./ChatPanel.module.css";
import { toolColor } from "./chatHelpers";
import {
  activitySummaryText,
  agentPromptText,
  agentToolCallSummary,
} from "./agentToolCallRendering";
import { InlineEditSummary } from "./EditChangeSummary";
import { summarizeAgentToolCallEdit } from "./editActivitySummary";
import { ThinkingBlock } from "./ThinkingBlock";
import { HighlightedMessageMarkdown } from "./HighlightedMessageMarkdown";

export function AgentToolCallGroup({
  activity,
  searchQuery,
  worktreePath,
  inline = false,
  collapsed,
  onToggle,
}: {
  activity: ToolActivity;
  searchQuery: string;
  worktreePath?: string | null;
  inline?: boolean;
  /**
   * Optional collapse state. When `onToggle` is provided alongside this,
   * the header becomes interactive (chevron + click/keyboard) and the
   * per-tool-call list is hidden while `collapsed` is true. Header
   * label and progress row remain visible regardless — Agent invocations
   * run for minutes and a fully-hidden live agent would feel dead. The
   * `inline` mode (grouped-tool-calls setting OFF) ignores both props
   * to preserve the original always-expanded behavior.
   */
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const summary = activitySummaryText(activity);
  const prompt = agentPromptText(activity);
  const calls = activity.agentToolCalls ?? [];
  const thinkingBlocks = activity.agentThinkingBlocks ?? [];
  const resultText = activity.agentResultText || activity.resultText;
  // Inline mode is the legacy "show everything inline" rendering; do
  // not let collapse semantics leak into it. Only when an explicit
  // toggle has been wired (the new live-agent wrapper) do we render
  // the chevron and gate the call list.
  const collapsible = !inline && typeof onToggle === "function";
  const isCollapsed = collapsible && collapsed === true;
  const headerInteractiveProps = collapsible
    ? {
        role: "button" as const,
        tabIndex: 0,
        "aria-expanded": !isCollapsed,
        "aria-label": `${isCollapsed ? "Expand" : "Collapse"} ${activity.toolName} tool call list`,
        onClick: onToggle,
        onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        },
      }
    : undefined;

  return (
    <div className={inline ? styles.agentToolGroupInline : styles.agentToolGroup}>
      <div className={styles.agentToolGroupHeader} {...headerInteractiveProps}>
        {collapsible && (
          <span className={styles.toolChevron}>{isCollapsed ? "›" : "⌄"}</span>
        )}
        <span
          className={styles.toolName}
          style={{ color: toolColor(activity.toolName) }}
        >
          {activity.toolName}
        </span>
        {summary && (
          <span className={styles.toolSummary}>
            <HighlightedPlainText
              text={relativizePath(summary, worktreePath)}
              query={searchQuery}
            />
          </span>
        )}
      </div>
      {(activity.agentStatus ||
        typeof activity.agentToolUseCount === "number" ||
        activity.agentLastToolName) && (
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
          {activity.agentLastToolName && (
            <span>latest: {activity.agentLastToolName}</span>
          )}
        </div>
      )}
      {!isCollapsed && (
        <div className={styles.agentNestedChat}>
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
                {calls.map((call) => {
                  const callSummary = agentToolCallSummary(call);
                  const editSummary = summarizeAgentToolCallEdit(call);
                  return (
                    <div key={call.toolUseId} className={styles.agentToolCall}>
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
                      <span className={styles.agentToolCallStatus}>
                        {call.status}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {resultText && (
            <div className={styles.agentNestedMessage}>
              <div className={styles.agentNestedRole}>Result</div>
              <div className={styles.agentNestedMarkdown}>
                <HighlightedMessageMarkdown
                  content={resultText}
                  query={searchQuery}
                />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
