import type { CompletedTurn } from "../stores/useAppStore";
import type { ChatMessage } from "../types/chat";
import type { CompletedTurnData } from "../types/checkpoint";
import { debugChat } from "./chatDebug";

/**
 * Reconstruct CompletedTurn[] from persisted turn data and loaded messages.
 * Resolves afterMessageIndex by finding the checkpoint's message_id in the
 * messages array and setting it to (local index + 1) + globalOffset.
 *
 * `globalOffset` is the number of older messages that exist in the session
 * but aren't in `messages` because of pagination — pass it so the returned
 * `afterMessageIndex` values are global session positions, matching the rest
 * of the rendering pipeline. Defaults to 0 for fully-loaded sessions.
 */
export function reconstructCompletedTurns(
  messages: ChatMessage[],
  turnData: CompletedTurnData[],
  globalOffset = 0,
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
    const localAfter = msgIdToIndex.get(td.message_id)! + 1;
    const afterMessageIndex = localAfter + globalOffset;
    const priorBoundary =
      i > 0 ? msgIdToIndex.get(valid[i - 1].message_id)! + 1 : 0;
    // Slice bounds are LOCAL — `afterMessageIndex` is global and would over-
    // run into the next turn's range when the slice clamps.
    const turnAssistantMessages = messages
      .slice(priorBoundary, localAfter)
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
        assistantMessageOrdinal: a.assistant_message_ordinal,
        agentTaskId: a.agent_task_id,
        agentDescription: a.agent_description,
        agentLastToolName: a.agent_last_tool_name,
        agentToolUseCount: a.agent_tool_use_count,
        agentStatus: a.agent_status,
        agentToolCalls: parseAgentToolCalls(a.agent_tool_calls_json),
      })),
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

function parseAgentToolCalls(value: string | null | undefined) {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
