import { describe, expect, it } from "vitest";
import { makeChatMessage } from "./chatMessage";

describe("makeChatMessage", () => {
  it("defaults usage fields to null and fills id/timestamp", () => {
    const msg = makeChatMessage({
      workspaceId: "ws",
      sessionId: "s",
      role: "System",
      content: "hi",
    });
    expect(msg).toMatchObject({
      workspace_id: "ws",
      chat_session_id: "s",
      role: "System",
      content: "hi",
      cost_usd: null,
      duration_ms: null,
      thinking: null,
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_creation_tokens: null,
    });
    expect(msg.id).toBeTruthy();
    expect(Number.isNaN(Date.parse(msg.created_at))).toBe(false);
  });

  it("honours explicit overrides", () => {
    const msg = makeChatMessage({
      id: "m1",
      workspaceId: "ws",
      sessionId: "s",
      role: "Assistant",
      content: "x",
      createdAt: "2026-01-01T00:00:00.000Z",
      thinking: "t",
      cacheReadTokens: 7,
    });
    expect(msg.id).toBe("m1");
    expect(msg.created_at).toBe("2026-01-01T00:00:00.000Z");
    expect(msg.thinking).toBe("t");
    expect(msg.cache_read_tokens).toBe(7);
  });
});
