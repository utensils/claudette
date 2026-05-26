// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../../stores/useAppStore";
import type { ChatSession } from "../../types/chat";
import type { TerminalTab } from "../../types/terminal";
import type { Workspace } from "../../types/workspace";
import {
  markChatTurnStarting,
  rollbackChatTurnStarting,
} from "./chatTurnLifecycle";

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws-1",
    repository_id: "repo-1",
    name: "workspace",
    branch_name: "fix/timer",
    worktree_path: "/tmp/workspace",
    status: "Active",
    agent_status: "Idle",
    status_line: "",
    created_at: "2026-05-21T00:00:00Z",
    sort_order: 0,
    remote_connection_id: null,
    input_values: null,
    ...overrides,
  };
}

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "session-1",
    workspace_id: "ws-1",
    session_id: null,
    name: "New chat",
    name_edited: false,
    turn_count: 0,
    sort_order: 0,
    status: "Active",
    created_at: "2026-05-21T00:00:00Z",
    archived_at: null,
    cli_invocation: null,
    agent_status: "Idle",
    needs_attention: false,
    attention_kind: null,
    ...overrides,
  };
}

function makeBackgroundTask(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 10,
    workspace_id: "ws-1",
    title: "Task",
    kind: "agent_task",
    is_script_output: false,
    sort_order: 0,
    created_at: "2026-05-21T00:00:00Z",
    task_status: "running",
    ...overrides,
  };
}

describe("chat turn lifecycle", () => {
  beforeEach(() => {
    useAppStore.setState({
      workspaces: [makeWorkspace()],
      sessionsByWorkspace: { "ws-1": [makeSession()] },
      chatMessages: {},
      chatAttachments: {},
      promptStartTime: {},
      unreadCompletions: new Set(),
      agentBackgroundTasksBySessionId: {},
    });
  });

  it("marks a chat turn as running with a per-workspace timer anchor", () => {
    markChatTurnStarting({
      sessionId: "session-1",
      workspaceId: "ws-1",
      messageId: "message-1",
      content: "Please fix this",
      startedAt: 1_700_000_000_000,
    });

    const state = useAppStore.getState();
    expect(state.promptStartTime["ws-1"]).toBe(1_700_000_000_000);
    expect(state.workspaces[0]?.agent_status).toBe("Running");
    expect(state.sessionsByWorkspace["ws-1"]?.[0]?.agent_status).toBe(
      "Running",
    );
    expect(state.chatMessages["session-1"]?.[0]).toMatchObject({
      id: "message-1",
      role: "User",
      content: "Please fix this",
    });
  });

  it("keeps the workspace running and preserves the timer when rolling back one of two running sessions", () => {
    useAppStore.setState({
      promptStartTime: { "ws-1": 1_700_000_000_000 },
      workspaces: [makeWorkspace({ agent_status: "Running" })],
      sessionsByWorkspace: {
        "ws-1": [
          makeSession({ id: "session-1", agent_status: "Running" }),
          makeSession({ id: "session-2", agent_status: "Running" }),
        ],
      },
    });

    rollbackChatTurnStarting("session-1", "ws-1");

    const state = useAppStore.getState();
    expect(state.sessionsByWorkspace["ws-1"]?.[0]?.agent_status).toBe("Idle");
    expect(state.sessionsByWorkspace["ws-1"]?.[1]?.agent_status).toBe(
      "Running",
    );
    expect(state.workspaces[0]?.agent_status).toBe("Running");
    expect(state.promptStartTime["ws-1"]).toBe(1_700_000_000_000);
  });

  it("restores IdleWithBackground when rollback leaves only a running background task", () => {
    useAppStore.setState({
      promptStartTime: { "ws-1": 1_700_000_000_000 },
      workspaces: [makeWorkspace({ agent_status: "Running" })],
      sessionsByWorkspace: {
        "ws-1": [makeSession({ id: "session-1", agent_status: "Running" })],
      },
      agentBackgroundTasksBySessionId: {
        "session-1": [makeBackgroundTask()],
      },
    });

    rollbackChatTurnStarting("session-1", "ws-1");

    const state = useAppStore.getState();
    expect(state.sessionsByWorkspace["ws-1"]?.[0]?.agent_status).toBe("Idle");
    expect(state.workspaces[0]?.agent_status).toBe("IdleWithBackground");
    expect(state.promptStartTime["ws-1"]).toBeUndefined();
  });
});
