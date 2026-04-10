import type { CompletedTurn } from "../stores/useAppStore";
import type { ChatMessage } from "../types/chat";
import type { CompletedTurnData } from "../types/checkpoint";

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

  return turnData.map((td) => {
    const anchorIdx = msgIdToIndex.get(td.message_id);
    const afterMessageIndex = anchorIdx !== undefined ? anchorIdx + 1 : 0;

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
      messageCount: td.message_count,
      collapsed: false,
      afterMessageIndex,
    };
  });
}
