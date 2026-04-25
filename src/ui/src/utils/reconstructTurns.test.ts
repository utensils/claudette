import { describe, it, expect } from "vitest";
import { reconstructCompletedTurns } from "./reconstructTurns";
import type { ChatMessage } from "../types/chat";
import type { CompletedTurnData } from "../types/checkpoint";

function makeMsg(
  id: string,
  role: "User" | "Assistant" = "Assistant",
): ChatMessage {
  return {
    id,
    workspace_id: "ws",
    role,
    content: "",
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

function makeTurnData(
  checkpointId: string,
  messageId: string,
  toolCount: number = 1,
): CompletedTurnData {
  return {
    checkpoint_id: checkpointId,
    message_id: messageId,
    turn_index: 0,
    message_count: 1,
    commit_hash: null,
    activities: Array.from({ length: toolCount }, (_, i) => ({
      id: `act-${checkpointId}-${i}`,
      checkpoint_id: checkpointId,
      tool_use_id: `tool-${checkpointId}-${i}`,
      tool_name: "Read",
      input_json: "{}",
      result_text: "ok",
      summary: `read file ${i}`,
      sort_order: i,
    })),
  };
}

describe("reconstructCompletedTurns", () => {
  it("returns empty array for empty turnData", () => {
    const result = reconstructCompletedTurns([makeMsg("m1")], []);
    expect(result).toEqual([]);
  });

  it("returns empty array for empty messages", () => {
    const result = reconstructCompletedTurns([], [makeTurnData("cp1", "m1")]);
    expect(result).toEqual([]);
  });

  it("resolves afterMessageIndex from message_id", () => {
    const messages = [makeMsg("m1", "User"), makeMsg("m2")];
    const turnData = [makeTurnData("cp1", "m2")];

    const result = reconstructCompletedTurns(messages, turnData);

    expect(result).toHaveLength(1);
    expect(result[0].afterMessageIndex).toBe(2); // index 1 + 1
    expect(result[0].id).toBe("cp1");
    expect(result[0].activities).toHaveLength(1);
    expect(result[0].activities[0].toolName).toBe("Read");
  });

  it("filters out turns with unknown message_id", () => {
    const messages = [makeMsg("m1"), makeMsg("m2")];
    const turnData = [makeTurnData("cp1", "nonexistent-msg-id")];

    const result = reconstructCompletedTurns(messages, turnData);

    expect(result).toEqual([]);
  });

  it("keeps valid turns and drops invalid ones from mixed input", () => {
    const messages = [
      makeMsg("m1", "User"),
      makeMsg("m2"),
      makeMsg("m3", "User"),
      makeMsg("m4"),
    ];
    const turnData = [
      makeTurnData("cp1", "m2", 3), // valid — anchored to m2
      makeTurnData("cp2", "orphaned", 2), // invalid — message_id not in messages
      makeTurnData("cp3", "m4", 1), // valid — anchored to m4
    ];

    const result = reconstructCompletedTurns(messages, turnData);

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("cp1");
    expect(result[0].afterMessageIndex).toBe(2); // m2 is index 1, +1 = 2
    expect(result[0].activities).toHaveLength(3);
    expect(result[1].id).toBe("cp3");
    expect(result[1].afterMessageIndex).toBe(4); // m4 is index 3, +1 = 4
    expect(result[1].activities).toHaveLength(1);
  });

  it("anchors to index 1 when message_id is the first message", () => {
    const messages = [makeMsg("m1")];
    const turnData = [makeTurnData("cp1", "m1")];

    const result = reconstructCompletedTurns(messages, turnData);

    expect(result).toHaveLength(1);
    expect(result[0].afterMessageIndex).toBe(1); // index 0 + 1
  });

  it("sums assistant message duration_ms into durationMs per turn", () => {
    const m1: ChatMessage = { ...makeMsg("m1", "User"), duration_ms: 99_999 };
    const m2: ChatMessage = { ...makeMsg("m2", "Assistant"), duration_ms: 1_200 };
    const m3: ChatMessage = { ...makeMsg("m3", "Assistant"), duration_ms: 800 };
    const m4: ChatMessage = { ...makeMsg("m4", "User"), duration_ms: 99_999 };
    const m5: ChatMessage = { ...makeMsg("m5", "Assistant"), duration_ms: 3_000 };
    const messages = [m1, m2, m3, m4, m5];
    const turnData = [makeTurnData("cp1", "m3"), makeTurnData("cp2", "m5")];

    const result = reconstructCompletedTurns(messages, turnData);

    expect(result).toHaveLength(2);
    // Turn 1: spans m1..m3 — only m2+m3 are assistant → 2000ms
    expect(result[0].durationMs).toBe(2_000);
    // Turn 2: spans m4..m5 — only m5 is assistant → 3000ms
    expect(result[1].durationMs).toBe(3_000);
  });

  it("sums assistant message token counts into inputTokens/outputTokens per turn", () => {
    const m1: ChatMessage = { ...makeMsg("m1", "User") };
    const m2: ChatMessage = {
      ...makeMsg("m2", "Assistant"),
      input_tokens: 1_000,
      output_tokens: 150,
    };
    const m3: ChatMessage = {
      ...makeMsg("m3", "Assistant"),
      input_tokens: 500,
      output_tokens: 50,
    };
    const m4: ChatMessage = { ...makeMsg("m4", "User") };
    const m5: ChatMessage = {
      ...makeMsg("m5", "Assistant"),
      input_tokens: 2_500,
      output_tokens: 300,
    };
    const messages = [m1, m2, m3, m4, m5];
    const turnData = [makeTurnData("cp1", "m3"), makeTurnData("cp2", "m5")];

    const result = reconstructCompletedTurns(messages, turnData);

    expect(result).toHaveLength(2);
    // Turn 1: m2+m3 assistant → 1500 in, 200 out
    expect(result[0].inputTokens).toBe(1_500);
    expect(result[0].outputTokens).toBe(200);
    // Turn 2: m5 only → 2500 in, 300 out
    expect(result[1].inputTokens).toBe(2_500);
    expect(result[1].outputTokens).toBe(300);
  });

  it("takes the max of assistant message cache tokens per turn (not sum)", () => {
    // Cache tokens are cumulative-per-API-call — summing would double-count
    // the shared prompt prefix each call re-reads. Max approximates the
    // turn's actual cache footprint to match live Result.usage.
    const m1: ChatMessage = { ...makeMsg("m1", "User") };
    const m2: ChatMessage = {
      ...makeMsg("m2", "Assistant"),
      cache_read_tokens: 50_000,
      cache_creation_tokens: 1_000,
    };
    const m3: ChatMessage = {
      ...makeMsg("m3", "Assistant"),
      cache_read_tokens: 10_000,
      cache_creation_tokens: 200,
    };
    const m4: ChatMessage = { ...makeMsg("m4", "User") };
    const m5: ChatMessage = {
      ...makeMsg("m5", "Assistant"),
      cache_read_tokens: 100_000,
      cache_creation_tokens: 500,
    };
    const messages = [m1, m2, m3, m4, m5];
    const turnData = [makeTurnData("cp1", "m3"), makeTurnData("cp2", "m5")];

    const result = reconstructCompletedTurns(messages, turnData);

    expect(result).toHaveLength(2);
    // Turn 1: max(m2.cache_read=50_000, m3.cache_read=10_000) = 50_000
    //         max(m2.cache_creation=1_000, m3.cache_creation=200) = 1_000
    expect(result[0].cacheReadTokens).toBe(50_000);
    expect(result[0].cacheCreationTokens).toBe(1_000);
    // Turn 2: m5 only → 100_000 cache read, 500 cache creation
    expect(result[1].cacheReadTokens).toBe(100_000);
    expect(result[1].cacheCreationTokens).toBe(500);
  });

  it("leaves cacheReadTokens/cacheCreationTokens undefined when no assistant message has cache data", () => {
    const messages = [
      makeMsg("m1", "User"),
      makeMsg("m2", "Assistant"),
    ];
    const turnData = [makeTurnData("cp1", "m2")];

    const result = reconstructCompletedTurns(messages, turnData);

    expect(result).toHaveLength(1);
    expect(result[0].cacheReadTokens).toBeUndefined();
    expect(result[0].cacheCreationTokens).toBeUndefined();
  });

  it("leaves inputTokens/outputTokens undefined for legacy turns with no token data", () => {
    const messages = [makeMsg("m1", "User"), makeMsg("m2", "Assistant")];
    const turnData = [makeTurnData("cp1", "m2")];

    const result = reconstructCompletedTurns(messages, turnData);

    expect(result).toHaveLength(1);
    expect(result[0].inputTokens).toBeUndefined();
    expect(result[0].outputTokens).toBeUndefined();
  });

  it("passes commit_hash through as commitHash", () => {
    const messages = [makeMsg("m1")];
    const turnData: CompletedTurnData[] = [
      {
        checkpoint_id: "cp1",
        message_id: "m1",
        turn_index: 0,
        message_count: 1,
        commit_hash: "abc123",
        activities: [],
      },
    ];

    const result = reconstructCompletedTurns(messages, turnData);
    expect(result[0].commitHash).toBe("abc123");
  });

  it("leaves segments undefined when every activity has null group_id (legacy rows)", () => {
    // Legacy turns persisted before the group_id column existed. The renderer
    // treats absent `segments` as "one flat tool-group" — preserving the
    // pre-migration visual exactly.
    const messages = [makeMsg("m1")];
    const turnData = [makeTurnData("cp1", "m1", 3)];
    // `makeTurnData` doesn't set group_id → all activities get undefined.
    const result = reconstructCompletedTurns(messages, turnData);
    expect(result[0].segments).toBeUndefined();
  });

  it("derives one tool-group segment per distinct group_id, preserving order", () => {
    const messages = [makeMsg("m1")];
    const turnData: CompletedTurnData[] = [
      {
        checkpoint_id: "cp1",
        message_id: "m1",
        turn_index: 0,
        message_count: 1,
        commit_hash: null,
        activities: [
          {
            id: "act-1",
            checkpoint_id: "cp1",
            tool_use_id: "t1",
            tool_name: "Read",
            input_json: "{}",
            result_text: "",
            summary: "",
            sort_order: 0,
            group_id: 0,
          },
          {
            id: "act-2",
            checkpoint_id: "cp1",
            tool_use_id: "t2",
            tool_name: "Read",
            input_json: "{}",
            result_text: "",
            summary: "",
            sort_order: 1,
            group_id: 0,
          },
          {
            id: "act-3",
            checkpoint_id: "cp1",
            tool_use_id: "t3",
            tool_name: "Read",
            input_json: "{}",
            result_text: "",
            summary: "",
            sort_order: 2,
            group_id: 1,
          },
        ],
      },
    ];

    const result = reconstructCompletedTurns(messages, turnData);
    const segs = result[0].segments!;
    expect(segs).toHaveLength(2);
    expect(segs[0]).toMatchObject({
      kind: "tool-group",
      toolUseIds: ["t1", "t2"],
    });
    expect(segs[1]).toMatchObject({
      kind: "tool-group",
      toolUseIds: ["t3"],
    });
  });

  it("reconstructs a solo Task/Agent group as a subagent segment", () => {
    const messages = [makeMsg("m1")];
    const turnData: CompletedTurnData[] = [
      {
        checkpoint_id: "cp1",
        message_id: "m1",
        turn_index: 0,
        message_count: 1,
        commit_hash: null,
        activities: [
          {
            id: "act-1",
            checkpoint_id: "cp1",
            tool_use_id: "t1",
            tool_name: "Read",
            input_json: "{}",
            result_text: "",
            summary: "",
            sort_order: 0,
            group_id: 0,
          },
          {
            id: "act-2",
            checkpoint_id: "cp1",
            tool_use_id: "t2",
            tool_name: "Task",
            input_json: "{}",
            result_text: "",
            summary: "",
            sort_order: 1,
            group_id: 1,
          },
          {
            id: "act-3",
            checkpoint_id: "cp1",
            tool_use_id: "t3",
            tool_name: "Agent",
            input_json: "{}",
            result_text: "",
            summary: "",
            sort_order: 2,
            group_id: 2,
          },
        ],
      },
    ];

    const result = reconstructCompletedTurns(messages, turnData);
    const segs = result[0].segments!;
    expect(segs).toHaveLength(3);
    expect(segs[0]).toMatchObject({ kind: "tool-group" });
    expect(segs[1]).toMatchObject({ kind: "subagent", toolUseId: "t2" });
    expect(segs[2]).toMatchObject({ kind: "subagent", toolUseId: "t3" });
  });

  it("maps activity fields correctly", () => {
    const messages = [makeMsg("m1")];
    const turnData: CompletedTurnData[] = [
      {
        checkpoint_id: "cp1",
        message_id: "m1",
        turn_index: 0,
        message_count: 5,
        commit_hash: null,
        activities: [
          {
            id: "act-1",
            checkpoint_id: "cp1",
            tool_use_id: "tu-abc",
            tool_name: "Bash",
            input_json: '{"command":"ls"}',
            result_text: "file.txt",
            summary: "list files",
            sort_order: 0,
          },
        ],
      },
    ];

    const result = reconstructCompletedTurns(messages, turnData);

    expect(result[0].messageCount).toBe(5);
    expect(result[0].collapsed).toBe(true);
    const act = result[0].activities[0];
    expect(act.toolUseId).toBe("tu-abc");
    expect(act.toolName).toBe("Bash");
    expect(act.inputJson).toBe('{"command":"ls"}');
    expect(act.resultText).toBe("file.txt");
    expect(act.summary).toBe("list files");
    expect(act.collapsed).toBe(true);
  });
});
