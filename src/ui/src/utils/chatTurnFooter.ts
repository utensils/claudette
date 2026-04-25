import type { ConversationCheckpoint } from "../types/checkpoint";
import type { ChatMessage } from "../types/chat";

export type PlainTurnFooterData = {
  position: number;
  userIdx: number;
  rollbackCheckpointId: string | null;
  forkCheckpointId: string | null;
  assistantText: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
};

export function findTriggeringUserIndex(
  messages: ChatMessage[],
  afterMessageIndex: number,
): number {
  for (
    let i = Math.min(afterMessageIndex, messages.length) - 1;
    i >= 0;
    i--
  ) {
    if (messages[i].role === "User") return i;
  }
  return -1;
}

export function assistantTextForTurn(
  messages: ChatMessage[],
  userIdx: number,
  afterMessageIndex: number,
): string {
  if (userIdx < 0) return "";
  return messages
    .slice(userIdx + 1, afterMessageIndex)
    .filter((m) => m.role === "Assistant")
    .map((m) => m.content)
    .join("\n\n")
    .trim();
}

export function buildPlainTurnFooters(
  messages: ChatMessage[],
  rollbackCheckpointByIdx: Map<number, ConversationCheckpoint | null>,
  completedTurnPositions: Set<number>,
  checkpoints: ConversationCheckpoint[] = [],
): Map<number, PlainTurnFooterData> {
  const map = new Map<number, PlainTurnFooterData>();
  const checkpointByMessageId = new Map(
    checkpoints.map((checkpoint) => [checkpoint.message_id, checkpoint]),
  );

  for (let userIdx = 0; userIdx < messages.length; userIdx++) {
    if (messages[userIdx].role !== "User") continue;

    let endExclusive = messages.length;
    for (let i = userIdx + 1; i < messages.length; i++) {
      if (messages[i].role === "User") {
        endExclusive = i;
        break;
      }
    }
    if (completedTurnPositions.has(endExclusive)) continue;

    const assistantMessages = messages
      .slice(userIdx + 1, endExclusive)
      .filter((m) => m.role === "Assistant");
    if (assistantMessages.length === 0) continue;

    const durationMs =
      assistantMessages.reduce((sum, m) => sum + (m.duration_ms ?? 0), 0) ||
      undefined;
    const inputTokens =
      assistantMessages.reduce((sum, m) => sum + (m.input_tokens ?? 0), 0) ||
      undefined;
    const outputTokens =
      assistantMessages.reduce((sum, m) => sum + (m.output_tokens ?? 0), 0) ||
      undefined;
    const rollbackTarget = rollbackCheckpointByIdx.get(userIdx) ?? null;
    let forkTarget: ConversationCheckpoint | undefined;
    for (let i = endExclusive - 1; i > userIdx; i--) {
      const checkpoint = checkpointByMessageId.get(messages[i].id);
      if (checkpoint) {
        forkTarget = checkpoint;
        break;
      }
    }

    map.set(endExclusive, {
      position: endExclusive,
      userIdx,
      rollbackCheckpointId: rollbackTarget ? rollbackTarget.id : null,
      forkCheckpointId: forkTarget ? forkTarget.id : null,
      assistantText: assistantTextForTurn(messages, userIdx, endExclusive),
      durationMs,
      inputTokens,
      outputTokens,
    });
  }

  return map;
}
