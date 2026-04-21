import { describe, it, expect } from "vitest";
import {
  buildCompactionSentinel,
  parseCompactionSentinel,
  buildSyntheticSummarySentinel,
  parseSyntheticSummarySentinel,
  extractCompactionEvents,
} from "./compactionSentinel";
import type { ChatMessage } from "../types/chat";

function sysMsg(id: string, content: string, afterIndex: number = 0): ChatMessage {
  return {
    id,
    workspace_id: "ws",
    role: "System",
    content,
    cost_usd: null,
    duration_ms: null,
    created_at: `2026-04-20T00:00:${String(afterIndex).padStart(2, "0")}Z`,
    thinking: null,
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_creation_tokens: null,
  };
}

describe("buildCompactionSentinel", () => {
  it("formats the sentinel deterministically", () => {
    expect(
      buildCompactionSentinel({
        trigger: "manual",
        preTokens: 174144,
        postTokens: 8782,
        durationMs: 94167,
      }),
    ).toBe("COMPACTION:manual:174144:8782:94167");
  });
});

describe("parseCompactionSentinel", () => {
  it("parses a well-formed sentinel", () => {
    expect(parseCompactionSentinel("COMPACTION:manual:174144:8782:94167")).toEqual({
      trigger: "manual",
      preTokens: 174144,
      postTokens: 8782,
      durationMs: 94167,
    });
  });

  it("parses trigger values it doesn't recognize", () => {
    expect(parseCompactionSentinel("COMPACTION:auto:1:2:3")?.trigger).toBe("auto");
    expect(parseCompactionSentinel("COMPACTION:scheduled:1:2:3")?.trigger).toBe("scheduled");
  });

  it("returns null for non-sentinel content", () => {
    expect(parseCompactionSentinel("")).toBeNull();
    expect(parseCompactionSentinel("some system message")).toBeNull();
    expect(parseCompactionSentinel("COMPACTION:")).toBeNull();
    expect(parseCompactionSentinel("COMPACTION:manual:1:2")).toBeNull(); // too few fields
    expect(parseCompactionSentinel("COMPACTION:manual:1:2:3:extra")).toBeNull(); // too many
    expect(parseCompactionSentinel("COMPACTION:manual:not-a-number:2:3")).toBeNull();
  });
});

describe("buildSyntheticSummarySentinel / parseSyntheticSummarySentinel", () => {
  it("round-trips", () => {
    const body = "Pre-compaction summary\nwith\nmultiple lines.";
    const built = buildSyntheticSummarySentinel(body);
    expect(built).toBe("SYNTHETIC_SUMMARY:\nPre-compaction summary\nwith\nmultiple lines.");
    expect(parseSyntheticSummarySentinel(built)).toBe(body);
  });

  it("returns null for non-sentinel content", () => {
    expect(parseSyntheticSummarySentinel("")).toBeNull();
    expect(parseSyntheticSummarySentinel("SYNTHETIC_SUMMARY ")).toBeNull();
    expect(parseSyntheticSummarySentinel("SYNTHETIC_SUMMARY:no-leading-newline")).toBeNull();
    expect(parseSyntheticSummarySentinel("some random text")).toBeNull();
  });
});

describe("extractCompactionEvents", () => {
  it("returns an empty array when no messages match", () => {
    expect(extractCompactionEvents([])).toEqual([]);
    expect(
      extractCompactionEvents([
        sysMsg("m1", "regular system message"),
        sysMsg("m2", "another one"),
      ]),
    ).toEqual([]);
  });

  it("extracts compaction events with correct afterMessageIndex", () => {
    const messages: ChatMessage[] = [
      sysMsg("m0", "not a sentinel", 0),
      sysMsg("m1", "COMPACTION:manual:100:50:1000", 1),
      sysMsg("m2", "some other message", 2),
      sysMsg("m3", "COMPACTION:auto:200:75:2000", 3),
    ];
    const events = extractCompactionEvents(messages);
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      timestamp: "2026-04-20T00:00:01Z",
      trigger: "manual",
      preTokens: 100,
      postTokens: 50,
      durationMs: 1000,
      afterMessageIndex: 1,
    });
    expect(events[1].trigger).toBe("auto");
    expect(events[1].afterMessageIndex).toBe(3);
  });

  it("skips malformed sentinels silently", () => {
    const messages: ChatMessage[] = [
      sysMsg("m1", "COMPACTION:manual:100:50:1000"),
      sysMsg("m2", "COMPACTION:malformed"),
    ];
    const events = extractCompactionEvents(messages);
    expect(events).toHaveLength(1);
  });

  it("ignores non-system messages", () => {
    const msgs: ChatMessage[] = [
      { ...sysMsg("m1", "COMPACTION:manual:100:50:1000"), role: "User" },
    ];
    expect(extractCompactionEvents(msgs)).toEqual([]);
  });
});
