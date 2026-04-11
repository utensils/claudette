import { describe, it, expect } from "vitest";
import { reconstructCompletedTurns } from "./reconstructTurns";
import type { ChatMessage } from "../types/chat";
import type { CompletedTurnData } from "../types/checkpoint";

function makeMsg(id: string, role: "User" | "Assistant" = "Assistant"): ChatMessage {
  return { id, workspace_id: "ws", role, content: "", cost_usd: null, duration_ms: null, created_at: "", thinking: null };
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
    const messages = [makeMsg("m1", "User"), makeMsg("m2"), makeMsg("m3", "User"), makeMsg("m4")];
    const turnData = [
      makeTurnData("cp1", "m2", 3),       // valid — anchored to m2
      makeTurnData("cp2", "orphaned", 2),  // invalid — message_id not in messages
      makeTurnData("cp3", "m4", 1),        // valid — anchored to m4
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

  it("maps activity fields correctly", () => {
    const messages = [makeMsg("m1")];
    const turnData: CompletedTurnData[] = [{
      checkpoint_id: "cp1",
      message_id: "m1",
      turn_index: 0,
      message_count: 5,
      activities: [{
        id: "act-1",
        checkpoint_id: "cp1",
        tool_use_id: "tu-abc",
        tool_name: "Bash",
        input_json: '{"command":"ls"}',
        result_text: "file.txt",
        summary: "list files",
        sort_order: 0,
      }],
    }];

    const result = reconstructCompletedTurns(messages, turnData);

    expect(result[0].messageCount).toBe(5);
    expect(result[0].collapsed).toBe(false);
    const act = result[0].activities[0];
    expect(act.toolUseId).toBe("tu-abc");
    expect(act.toolName).toBe("Bash");
    expect(act.inputJson).toBe('{"command":"ls"}');
    expect(act.resultText).toBe("file.txt");
    expect(act.summary).toBe("list files");
    expect(act.collapsed).toBe(true);
  });
});
