import { describe, it, expect } from "vitest";
import { extractLatestCallUsage } from "./extractLatestCallUsage";
import type { ChatMessage } from "../types/chat";

function msg(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: overrides.id ?? "m",
    workspace_id: overrides.workspace_id ?? "ws",
    chat_session_id: overrides.chat_session_id ?? "ws",
    role: overrides.role ?? "Assistant",
    content: overrides.content ?? "",
    cost_usd: overrides.cost_usd ?? null,
    duration_ms: overrides.duration_ms ?? null,
    created_at: overrides.created_at ?? "",
    thinking: overrides.thinking ?? null,
    input_tokens: overrides.input_tokens ?? null,
    output_tokens: overrides.output_tokens ?? null,
    cache_read_tokens: overrides.cache_read_tokens ?? null,
    cache_creation_tokens: overrides.cache_creation_tokens ?? null,
  };
}

describe("extractLatestCallUsage", () => {
  it("returns null for an empty message list", () => {
    expect(extractLatestCallUsage([])).toBeNull();
  });

  it("returns null when there are no assistant messages", () => {
    expect(
      extractLatestCallUsage([
        msg({ id: "1", role: "User" }),
        msg({ id: "2", role: "System" }),
      ]),
    ).toBeNull();
  });

  it("returns null when assistant messages have no token data", () => {
    // Pre-migration rows — all token fields null.
    expect(
      extractLatestCallUsage([
        msg({ id: "1", role: "Assistant" }),
        msg({ id: "2", role: "Assistant" }),
      ]),
    ).toBeNull();
  });

  it("picks the last assistant message when it has tokens", () => {
    const result = extractLatestCallUsage([
      msg({
        id: "1",
        role: "Assistant",
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 10_000,
        cache_creation_tokens: 500,
      }),
      msg({
        id: "2",
        role: "Assistant",
        input_tokens: 200,
        output_tokens: 75,
        cache_read_tokens: 20_000,
        cache_creation_tokens: 1_000,
      }),
    ]);
    expect(result).toEqual({
      inputTokens: 200,
      outputTokens: 75,
      cacheReadTokens: 20_000,
      cacheCreationTokens: 1_000,
    });
  });

  it("skips trailing user messages to find the last assistant", () => {
    const result = extractLatestCallUsage([
      msg({
        id: "1",
        role: "Assistant",
        input_tokens: 100,
        output_tokens: 50,
      }),
      msg({ id: "2", role: "User" }),
      msg({ id: "3", role: "System" }),
    ]);
    expect(result).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: undefined,
      cacheCreationTokens: undefined,
    });
  });

  it("skips assistant messages with no token data to find an earlier one", () => {
    // Mixed: older assistant has tokens, newer one is pre-migration.
    const result = extractLatestCallUsage([
      msg({
        id: "1",
        role: "Assistant",
        input_tokens: 100,
        output_tokens: 50,
      }),
      msg({ id: "2", role: "Assistant" }), // pre-migration, skip
    ]);
    expect(result).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: undefined,
      cacheCreationTokens: undefined,
    });
  });

  it("treats null cache fields as undefined in the returned TurnUsage", () => {
    const result = extractLatestCallUsage([
      msg({
        id: "1",
        role: "Assistant",
        input_tokens: 100,
        output_tokens: 50,
        // cache fields left null
      }),
    ]);
    expect(result?.cacheReadTokens).toBeUndefined();
    expect(result?.cacheCreationTokens).toBeUndefined();
  });

  // --- COMPACTION sentinel tests ---

  it("returns postTokens as cacheReadTokens when the last message is a compaction sentinel", () => {
    const result = extractLatestCallUsage([
      msg({ id: "1", role: "User", content: "hello" }),
      msg({
        id: "2",
        role: "System",
        content: "COMPACTION:auto:95000:12000:3400",
      }),
    ]);
    expect(result).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 12000,
      cacheCreationTokens: undefined,
    });
  });

  it("sentinel wins over an earlier assistant message when sentinel is more recent", () => {
    const result = extractLatestCallUsage([
      msg({
        id: "1",
        role: "Assistant",
        input_tokens: 500,
        output_tokens: 100,
        cache_read_tokens: 80000,
      }),
      msg({
        id: "2",
        role: "System",
        content: "COMPACTION:auto:95000:12000:3400",
      }),
    ]);
    expect(result).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 12000,
      cacheCreationTokens: undefined,
    });
  });

  it("assistant message wins over an earlier sentinel when assistant is more recent", () => {
    const result = extractLatestCallUsage([
      msg({
        id: "1",
        role: "System",
        content: "COMPACTION:auto:95000:12000:3400",
      }),
      msg({
        id: "2",
        role: "Assistant",
        input_tokens: 200,
        output_tokens: 80,
        cache_read_tokens: 15000,
      }),
    ]);
    expect(result).toEqual({
      inputTokens: 200,
      outputTokens: 80,
      cacheReadTokens: 15000,
      cacheCreationTokens: undefined,
    });
  });

  it("skips a non-sentinel system message and falls through to an assistant message", () => {
    const result = extractLatestCallUsage([
      msg({
        id: "1",
        role: "Assistant",
        input_tokens: 100,
        output_tokens: 50,
      }),
      msg({ id: "2", role: "System", content: "some-other-system-content" }),
    ]);
    expect(result).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: undefined,
      cacheCreationTokens: undefined,
    });
  });

  it("treats a malformed COMPACTION prefix as a non-match and keeps looking", () => {
    // "COMPACTION:" with nothing after — parseCompactionSentinel returns null.
    const result = extractLatestCallUsage([
      msg({
        id: "1",
        role: "Assistant",
        input_tokens: 300,
        output_tokens: 60,
      }),
      msg({ id: "2", role: "System", content: "COMPACTION:" }),
    ]);
    expect(result).toEqual({
      inputTokens: 300,
      outputTokens: 60,
      cacheReadTokens: undefined,
      cacheCreationTokens: undefined,
    });
  });
});
