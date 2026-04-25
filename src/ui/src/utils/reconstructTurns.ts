import type { CompletedTurn, TurnSegment } from "../stores/useAppStore";
import type { ChatMessage } from "../types/chat";
import type {
  CompletedTurnData,
  TurnToolActivityData,
} from "../types/checkpoint";
import { debugChat } from "./chatDebug";
import { isSubagentTool } from "./toolClassification";

/**
 * Rebuild the segment list for a completed turn from the persisted
 * `group_id` on each activity. Rows that share a `group_id` collapse into
 * one tool-group (or a subagent segment if the group is a lone Task/Agent
 * call). Legacy rows — all `group_id` missing/null — fall back to a single
 * tool-group covering every activity so pre-migration turns still render.
 */
function deriveSegmentsFromActivities(
  activities: TurnToolActivityData[],
): TurnSegment[] | undefined {
  if (activities.length === 0) return undefined;

  const anyGroupId = activities.some(
    (a) => a.group_id !== null && a.group_id !== undefined,
  );
  if (!anyGroupId) return undefined;

  const segments: TurnSegment[] = [];
  let currentKey: number | null = null;
  let currentBucket: TurnToolActivityData[] = [];

  const flush = () => {
    if (currentBucket.length === 0) return;
    const first = currentBucket[0];
    const isSoloSubagent =
      currentBucket.length === 1 && isSubagentTool(first.tool_name);
    if (isSoloSubagent) {
      segments.push({
        kind: "subagent",
        id: `seg-sub-${first.tool_use_id}`,
        toolUseId: first.tool_use_id,
      });
    } else {
      segments.push({
        kind: "tool-group",
        id: `seg-grp-${first.tool_use_id}`,
        toolUseIds: currentBucket.map((a) => a.tool_use_id),
      });
    }
    currentBucket = [];
  };

  for (const a of activities) {
    const key = a.group_id ?? null;
    if (currentBucket.length === 0 || key === currentKey) {
      currentBucket.push(a);
      currentKey = key;
    } else {
      flush();
      currentBucket.push(a);
      currentKey = key;
    }
  }
  flush();

  return segments.length > 0 ? segments : undefined;
}

/**
 * Reconstruct CompletedTurn[] from persisted turn data and loaded messages.
 * Resolves afterMessageIndex by finding the checkpoint's message_id in the
 * messages array and setting it to index + 1 (the turn renders after that message).
 */
export function reconstructCompletedTurns(
  messages: ChatMessage[],
  turnData: CompletedTurnData[],
): CompletedTurn[] {
  const msgIdToIndex = new Map(messages.map((m, i) => [m.id, i]));
  const droppedTurnIds = turnData
    .filter((td) => !msgIdToIndex.has(td.message_id))
    .map((td) => ({
      checkpointId: td.checkpoint_id,
      messageId: td.message_id,
    }));

  if (droppedTurnIds.length > 0) {
    debugChat("reconstructTurns", "dropped-turns", {
      messageIds: messages.map((message) => message.id),
      droppedTurnIds,
    });
  }

  const valid = turnData.filter((td) => msgIdToIndex.has(td.message_id));

  return valid.map((td, i) => {
    const afterMessageIndex = msgIdToIndex.get(td.message_id)! + 1;
    const priorBoundary =
      i > 0 ? msgIdToIndex.get(valid[i - 1].message_id)! + 1 : 0;
    const turnAssistantMessages = messages
      .slice(priorBoundary, afterMessageIndex)
      .filter((m) => m.role === "Assistant");
    const durationMs =
      turnAssistantMessages.reduce(
        (sum, m) => sum + (m.duration_ms ?? 0),
        0,
      ) || undefined;
    const inputTokens =
      turnAssistantMessages.reduce(
        (sum, m) => sum + (m.input_tokens ?? 0),
        0,
      ) || undefined;
    const outputTokens =
      turnAssistantMessages.reduce(
        (sum, m) => sum + (m.output_tokens ?? 0),
        0,
      ) || undefined;
    // Cache tokens on each assistant message row represent cumulative-per-
    // API-call usage, not per-message deltas. Summing across a multi-message
    // (tool-use) turn double-counts the shared prompt prefix that each call
    // re-reads from cache. Using max approximates the turn's actual cache
    // footprint more faithfully — matches what `result.usage` reports live.
    const cacheReadTokens =
      turnAssistantMessages.reduce(
        (maxSeen, m) => Math.max(maxSeen, m.cache_read_tokens ?? 0),
        0,
      ) || undefined;
    const cacheCreationTokens =
      turnAssistantMessages.reduce(
        (maxSeen, m) => Math.max(maxSeen, m.cache_creation_tokens ?? 0),
        0,
      ) || undefined;

    return {
      id: td.checkpoint_id,
      activities: td.activities.map((a) => ({
        toolUseId: a.tool_use_id,
        toolName: a.tool_name,
        inputJson: a.input_json,
        resultText: a.result_text,
        collapsed: true,
        summary: a.summary,
      })),
      segments: deriveSegmentsFromActivities(td.activities),
      messageCount: td.message_count,
      collapsed: true,
      afterMessageIndex,
      commitHash: td.commit_hash,
      durationMs,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
    };
  });
}
