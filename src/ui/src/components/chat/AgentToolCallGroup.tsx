import type { ToolActivity } from "../../stores/useAppStore";
import { relativizePath } from "../../hooks/toolSummary";
import { HighlightedPlainText } from "./HighlightedPlainText";
import styles from "./ChatPanel.module.css";
import { toolColor } from "./chatHelpers";
import {
  activitySummaryText,
  agentToolCallSummary,
} from "./agentToolCallRendering";

export function AgentToolCallGroup({
  activity,
  searchQuery,
  worktreePath,
  inline = false,
}: {
  activity: ToolActivity;
  searchQuery: string;
  worktreePath?: string | null;
  inline?: boolean;
}) {
  const summary = activitySummaryText(activity);
  const calls = activity.agentToolCalls ?? [];

  return (
    <div className={inline ? styles.agentToolGroupInline : styles.agentToolGroup}>
      <div className={styles.agentToolGroupHeader}>
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
      <div className={styles.agentToolCallList}>
        {calls.map((call) => {
          const callSummary = agentToolCallSummary(call);
          return (
            <div key={call.toolUseId} className={styles.agentToolCall}>
              <span
                className={styles.agentToolCallName}
                style={{ color: toolColor(call.toolName) }}
              >
                {call.toolName}
              </span>
              {callSummary && (
                <span className={styles.agentToolCallSummary}>
                  <HighlightedPlainText
                    text={relativizePath(callSummary, worktreePath)}
                    query={searchQuery}
                  />
                </span>
              )}
              <span className={styles.agentToolCallStatus}>{call.status}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
