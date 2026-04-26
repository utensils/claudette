import { describe, expect, it } from "vitest";
import type { ConversationCheckpoint } from "../types/checkpoint";
import type { ChatMessage } from "../types/chat";
import {
  assistantTextForTurn,
  buildPlainTurnFooters,
  findTriggeringUserIndex,
} from "./chatTurnFooter";

function msg(
  id: string,
  role: "User" | "Assistant" | "System",
  content = "",
): ChatMessage {
  return {
    id,
    workspace_id: "ws",
    chat_session_id: "sess",
    role,
    content,
    cost_usd: null,
    duration_ms: null,
    created_at: "",
    thinking: null,
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_creation_tokens: null,
  };
}

function cp(id: string, messageId: string): ConversationCheckpoint {
  return {
    id,
    workspace_id: "ws",
    message_id: messageId,
    commit_hash: null,
    has_file_state: false,
    turn_index: 0,
    message_count: 1,
    created_at: "",
  };
}

describe("chat turn footer derivation", () => {
  it("builds footer data for plain assistant turns without tool summaries", () => {
    const messages = [
      msg("m1", "User", "question"),
      {
        ...msg("m2", "Assistant", "answer"),
        duration_ms: 1_500,
        input_tokens: 100,
        output_tokens: 25,
      },
    ];
    const rollbackMap = new Map<number, ConversationCheckpoint | null>([
      [0, null],
    ]);

    const result = buildPlainTurnFooters(messages, rollbackMap, new Set());

    expect(result.get(2)).toEqual({
      position: 2,
      userIdx: 0,
      rollbackCheckpointId: null,
      forkCheckpointId: null,
      assistantText: "answer",
      durationMs: 1_500,
      inputTokens: 100,
      outputTokens: 25,
    });
  });

  it("does not duplicate footer data when a completed tool turn owns that position", () => {
    const messages = [
      msg("m1", "User", "read the file"),
      msg("m2", "Assistant", "done"),
    ];
    const rollbackMap = new Map<number, ConversationCheckpoint | null>([
      [0, null],
    ]);

    const result = buildPlainTurnFooters(messages, rollbackMap, new Set([2]));

    expect(result.size).toBe(0);
  });

  it("builds copy footer data even when rollback is unavailable", () => {
    const messages = [
      msg("m1", "User", "first"),
      msg("m2", "Assistant", "first answer"),
      msg("m3", "User", "second"),
      msg("m4", "Assistant", "second answer"),
    ];
    const rollbackMap = new Map<number, ConversationCheckpoint | null>([
      [0, null],
    ]);

    const result = buildPlainTurnFooters(messages, rollbackMap, new Set());

    expect(result.get(4)).toMatchObject({
      position: 4,
      userIdx: 2,
      rollbackCheckpointId: null,
      forkCheckpointId: null,
      assistantText: "second answer",
    });
  });

  it("keeps the nearest prior user as a completed turn trigger after a plain turn", () => {
    const messages = [
      msg("m1", "User", "plain question"),
      msg("m2", "Assistant", "plain answer"),
      msg("m3", "User", "tool request"),
      msg("m4", "Assistant", "tool answer"),
    ];

    const userIdx = findTriggeringUserIndex(messages, 4);

    expect(userIdx).toBe(2);
    expect(assistantTextForTurn(messages, userIdx, 4)).toBe("tool answer");
  });

  it("uses the current turn checkpoint for fork, not the rollback checkpoint", () => {
    const messages = [
      msg("m1", "User", "first"),
      msg("m2", "Assistant", "first answer"),
      msg("m3", "User", "second"),
      msg("m4", "Assistant", "second answer"),
    ];
    const rollbackMap = new Map<number, ConversationCheckpoint | null>([
      [0, null],
      [2, cp("cp1", "m2")],
    ]);

    const result = buildPlainTurnFooters(
      messages,
      rollbackMap,
      new Set(),
      [cp("cp1", "m2"), cp("cp2", "m4")],
    );

    expect(result.get(4)?.rollbackCheckpointId).toBe("cp1");
    expect(result.get(4)?.forkCheckpointId).toBe("cp2");
  });
});
