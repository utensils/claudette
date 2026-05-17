// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useQueuedMessageAutoDispatch } from "./useQueuedMessageAutoDispatch";
import { useAppStore } from "../stores/useAppStore";
import type { ChatSession, Workspace } from "../types";
import { sendChatMessage, sendRemoteCommand } from "../services/tauri";

vi.mock("../services/tauri", () => ({
  sendChatMessage: vi.fn().mockResolvedValue(undefined),
  sendRemoteCommand: vi.fn().mockResolvedValue(undefined),
}));

function Harness() {
  useQueuedMessageAutoDispatch();
  return null;
}

const baseTime = "2026-05-17T00:00:00.000Z";

function makeWorkspace(id: string, remoteConnectionId: string | null = null): Workspace {
  return {
    id,
    repository_id: "repo-1",
    name: id,
    branch_name: "main",
    worktree_path: `/tmp/${id}`,
    status: "Active",
    agent_status: "Idle",
    status_line: "",
    created_at: baseTime,
    sort_order: 0,
    remote_connection_id: remoteConnectionId,
  };
}

function makeSession(
  id: string,
  workspaceId: string,
  agentStatus: ChatSession["agent_status"],
): ChatSession {
  return {
    id,
    workspace_id: workspaceId,
    session_id: null,
    name: id,
    name_edited: false,
    turn_count: 0,
    sort_order: 0,
    status: "Active",
    created_at: baseTime,
    archived_at: null,
    cli_invocation: null,
    agent_status: agentStatus,
    needs_attention: false,
    attention_kind: null,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function mountHook() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<Harness />);
  });
}

async function flushQueuedDispatch() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("useQueuedMessageAutoDispatch", () => {
  beforeEach(() => {
    vi.mocked(sendChatMessage).mockClear();
    vi.mocked(sendRemoteCommand).mockClear();
    useAppStore.setState({
      selectedWorkspaceId: "ws-a",
      workspaces: [makeWorkspace("ws-a"), makeWorkspace("ws-b")],
      sessionsByWorkspace: {
        "ws-a": [makeSession("session-a", "ws-a", "Idle")],
        "ws-b": [makeSession("session-b", "ws-b", "Running")],
      },
      selectedSessionIdByWorkspaceId: {
        "ws-a": "session-a",
        "ws-b": "session-b",
      },
      queuedMessages: {},
      queuedMessageAutoDispatchPaused: {},
      queuedMessageEditing: {},
      queuedMessageSteering: {},
      chatMessages: {},
      chatAttachments: {},
      promptStartTime: {},
      permissionLevel: {},
      selectedModel: {},
      selectedModelProvider: {},
      fastMode: {},
      thinkingEnabled: {},
      planMode: {},
      effortLevel: {},
      chromeEnabled: {},
      agentQuestions: {},
      planApprovals: {},
      agentApprovals: {},
      unreadCompletions: new Set<string>(),
    });
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
    }
    root = null;
    container?.remove();
    container = null;
  });

  it("dispatches an idle background session's queued message while another workspace is focused", async () => {
    useAppStore.getState().setQueuedMessage("session-b", "follow up from B");
    await mountHook();
    await flushQueuedDispatch();
    expect(sendChatMessage).not.toHaveBeenCalled();

    await act(async () => {
      useAppStore.getState().updateChatSession("session-b", {
        agent_status: "Idle",
      });
    });
    await flushQueuedDispatch();

    expect(sendChatMessage).toHaveBeenCalledTimes(1);
    expect(sendChatMessage).toHaveBeenCalledWith(
      "session-b",
      "follow up from B",
      undefined,
      "full",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      expect.any(String),
    );
    expect(useAppStore.getState().selectedWorkspaceId).toBe("ws-a");
    expect(useAppStore.getState().queuedMessages["session-b"]).toBeUndefined();
  });

  it("routes background queued messages for remote workspaces through the remote bridge", async () => {
    useAppStore.setState({
      workspaces: [makeWorkspace("ws-a"), makeWorkspace("ws-b", "remote-1")],
    });
    useAppStore.getState().setQueuedMessage("session-b", "remote follow up");
    await mountHook();

    await act(async () => {
      useAppStore.getState().updateChatSession("session-b", {
        agent_status: "Idle",
      });
    });
    await flushQueuedDispatch();

    expect(sendChatMessage).not.toHaveBeenCalled();
    expect(sendRemoteCommand).toHaveBeenCalledWith(
      "remote-1",
      "send_chat_message",
      expect.objectContaining({
        chat_session_id: "session-b",
        content: "remote follow up",
      }),
    );
  });

  it("does not dispatch a queued message while that session is paused, edited, or steering", async () => {
    useAppStore.getState().setQueuedMessage("session-b", "wait for me");
    useAppStore.getState().setQueuedMessageAutoDispatchPaused("session-b", true);
    useAppStore.getState().setQueuedMessageEditing("session-b", true);
    useAppStore.getState().setQueuedMessageSteering("session-b", true);
    await mountHook();

    await act(async () => {
      useAppStore.getState().updateChatSession("session-b", {
        agent_status: "Idle",
      });
    });
    await flushQueuedDispatch();

    expect(sendChatMessage).not.toHaveBeenCalled();
    expect(useAppStore.getState().queuedMessages["session-b"]).toHaveLength(1);
  });

  it("clears queued state for sessions that are no longer present", async () => {
    useAppStore.getState().setQueuedMessage("ghost-session", "stale follow up");
    useAppStore.getState().setQueuedMessageAutoDispatchPaused("ghost-session", true);
    useAppStore.getState().setQueuedMessageEditing("ghost-session", true);
    useAppStore.getState().setQueuedMessageSteering("ghost-session", true);

    await mountHook();
    await flushQueuedDispatch();

    const state = useAppStore.getState();
    expect(sendChatMessage).not.toHaveBeenCalled();
    expect(state.queuedMessages["ghost-session"]).toBeUndefined();
    expect(state.queuedMessageAutoDispatchPaused["ghost-session"]).toBeUndefined();
    expect(state.queuedMessageEditing["ghost-session"]).toBeUndefined();
    expect(state.queuedMessageSteering["ghost-session"]).toBeUndefined();
  });
});
