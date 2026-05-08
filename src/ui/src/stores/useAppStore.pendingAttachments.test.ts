import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "./useAppStore";
import type { StoredAttachment } from "../types/chat";

const SESSION_A = "session-a";
const SESSION_B = "session-b";

function makeAttachment(id: string, filename = `${id}.png`): StoredAttachment {
  return {
    id,
    filename,
    media_type: "image/png",
    data_base64: "iVBORw0KGgo=",
    size_bytes: 7,
    text_content: null,
  };
}

describe("pendingAttachmentsBySession", () => {
  beforeEach(() => {
    useAppStore.setState({ pendingAttachmentsBySession: {} });
  });

  it("starts empty for a fresh session", () => {
    expect(
      useAppStore.getState().pendingAttachmentsBySession[SESSION_A],
    ).toBeUndefined();
  });

  it("adds attachments preserving insertion order", () => {
    useAppStore.getState().addPendingAttachment(SESSION_A, makeAttachment("1"));
    useAppStore.getState().addPendingAttachment(SESSION_A, makeAttachment("2"));
    useAppStore.getState().addPendingAttachment(SESSION_A, makeAttachment("3"));
    const list = useAppStore.getState().pendingAttachmentsBySession[SESSION_A];
    expect(list?.map((a) => a.id)).toEqual(["1", "2", "3"]);
  });

  it("survives session-keyed updates without leaking across sessions", () => {
    // Regression for #??? — attachments must be per-session so that
    // pasting images in session A and then switching to session B
    // (which mounts a different ChatInputArea instance) doesn't bleed
    // A's attachments into B and doesn't lose A's.
    useAppStore.getState().addPendingAttachment(SESSION_A, makeAttachment("a1"));
    useAppStore.getState().addPendingAttachment(SESSION_A, makeAttachment("a2"));
    useAppStore.getState().addPendingAttachment(SESSION_B, makeAttachment("b1"));

    const state = useAppStore.getState();
    expect(state.pendingAttachmentsBySession[SESSION_A]?.map((a) => a.id)).toEqual([
      "a1",
      "a2",
    ]);
    expect(state.pendingAttachmentsBySession[SESSION_B]?.map((a) => a.id)).toEqual([
      "b1",
    ]);
  });

  it("removes a single attachment by id without disturbing siblings", () => {
    useAppStore.getState().addPendingAttachment(SESSION_A, makeAttachment("1"));
    useAppStore.getState().addPendingAttachment(SESSION_A, makeAttachment("2"));
    useAppStore.getState().addPendingAttachment(SESSION_A, makeAttachment("3"));
    useAppStore.getState().removePendingAttachment(SESSION_A, "2");
    const list = useAppStore.getState().pendingAttachmentsBySession[SESSION_A];
    expect(list?.map((a) => a.id)).toEqual(["1", "3"]);
  });

  it("removePendingAttachment is a no-op for unknown ids", () => {
    useAppStore.getState().addPendingAttachment(SESSION_A, makeAttachment("1"));
    const before = useAppStore.getState().pendingAttachmentsBySession[SESSION_A];
    useAppStore.getState().removePendingAttachment(SESSION_A, "missing");
    const after = useAppStore.getState().pendingAttachmentsBySession[SESSION_A];
    // Reference-stable: same array, no needless re-render.
    expect(after).toBe(before);
  });

  it("clearPendingAttachments drops the session entry entirely", () => {
    useAppStore.getState().addPendingAttachment(SESSION_A, makeAttachment("1"));
    useAppStore.getState().clearPendingAttachments(SESSION_A);
    expect(
      useAppStore.getState().pendingAttachmentsBySession[SESSION_A],
    ).toBeUndefined();
  });

  it("setPendingAttachmentsForSession replaces the whole list", () => {
    useAppStore.getState().addPendingAttachment(SESSION_A, makeAttachment("orig"));
    useAppStore
      .getState()
      .setPendingAttachmentsForSession(SESSION_A, [
        makeAttachment("new-1"),
        makeAttachment("new-2"),
      ]);
    const list = useAppStore.getState().pendingAttachmentsBySession[SESSION_A];
    expect(list?.map((a) => a.id)).toEqual(["new-1", "new-2"]);
  });

  it("removeChatSession drops the matching pendingAttachments entry", () => {
    // Pin the cleanup wired in `chatSessionsSlice.removeChatSession` so
    // archiving a session doesn't leave its attachments stranded.
    useAppStore.setState({
      sessionsByWorkspace: {
        ws: [
          {
            id: SESSION_A,
            workspace_id: "ws",
            session_id: null,
            name: "Session A",
            name_edited: false,
            turn_count: 0,
            sort_order: 0,
            status: "Active",
            created_at: new Date().toISOString(),
            archived_at: null,
            cli_invocation: null,
            agent_status: "Stopped",
            needs_attention: false,
            attention_kind: null,
          },
        ],
      },
    });
    useAppStore.getState().addPendingAttachment(SESSION_A, makeAttachment("1"));
    useAppStore.getState().removeChatSession(SESSION_A);
    expect(
      useAppStore.getState().pendingAttachmentsBySession[SESSION_A],
    ).toBeUndefined();
  });
});
