import { describe, expect, it } from "vitest";
import type { ChatMessage, ChatRole } from "../../types/chat";
import { makeChatMessage } from "../../utils/chatMessage";
import { buildTurnAssistantRouter } from "./turnAssistantRouting";

function msg(id: string, role: ChatRole): ChatMessage {
  return makeChatMessage({ id, workspaceId: "w", sessionId: "s", role, content: id });
}

describe("buildTurnAssistantRouter", () => {
  it("routes a user anchor to the next assistant message", () => {
    const route = buildTurnAssistantRouter([
      msg("u1", "User"),
      msg("a1", "Assistant"),
      msg("u2", "User"),
      msg("a2", "Assistant"),
    ]);
    expect(route("u1")).toBe("a1");
    expect(route("u2")).toBe("a2");
  });

  it("falls back to the carry-over assistant on a mid-turn page", () => {
    const route = buildTurnAssistantRouter([
      msg("sys", "System"),
      msg("a0", "Assistant"),
      msg("u1", "User"),
    ]);
    expect(route("not-loaded")).toBe("a0");
    expect(route(null)).toBe("a0");
  });

  it("returns the anchor (or null) when nothing routes", () => {
    const route = buildTurnAssistantRouter([msg("u1", "User")]);
    expect(route("u1")).toBe("u1");
    expect(route("gone")).toBe("gone");
    expect(route(null)).toBeNull();
  });
});
