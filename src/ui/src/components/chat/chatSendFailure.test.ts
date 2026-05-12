import { describe, expect, it } from "vitest";

import {
  buildSendFailureSystemMessage,
  shouldRecordSendFailureInChat,
} from "./chatSendFailure";

describe("shouldRecordSendFailureInChat", () => {
  it("records Claude auth failures so the chat can render the sign-in callout", () => {
    expect(
      shouldRecordSendFailureInChat(
        "Failed to authenticate. API Error: 401 Invalid authentication credentials",
      ),
    ).toBe(true);
    expect(shouldRecordSendFailureInChat("Not logged in · Please run /login")).toBe(true);
  });

  it("leaves generic send failures in the ephemeral error banner", () => {
    expect(shouldRecordSendFailureInChat("worktree path is missing")).toBe(false);
  });
});

describe("buildSendFailureSystemMessage", () => {
  it("builds a local system message with the original error text", () => {
    expect(
      buildSendFailureSystemMessage({
        error: "Not logged in · Please run /login",
        workspaceId: "ws-1",
        sessionId: "session-1",
        id: "msg-1",
        createdAt: "2026-05-12T00:00:00.000Z",
      }),
    ).toEqual({
      id: "msg-1",
      workspace_id: "ws-1",
      chat_session_id: "session-1",
      role: "System",
      content: "Not logged in · Please run /login",
      cost_usd: null,
      duration_ms: null,
      created_at: "2026-05-12T00:00:00.000Z",
      thinking: null,
      input_tokens: null,
      output_tokens: null,
      cache_read_tokens: null,
      cache_creation_tokens: null,
    });
  });
});
