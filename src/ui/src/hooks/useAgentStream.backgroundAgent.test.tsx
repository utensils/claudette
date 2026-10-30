// @vitest-environment happy-dom

/**
 * Regression tests for subagents that outlive the turn that launched them.
 *
 * An `Agent` started with `run_in_background` returns immediately, the
 * launching turn finalizes, and the activity migrates into `completedTurns`.
 * The subagent's hook events (nested tool calls, `SubagentStop`) arrive
 * afterwards. The handlers used to search only the live `toolActivities`
 * lane, so the final status and result were silently dropped and the agent
 * read "running" forever.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type HandlerRecord = (event: { payload: unknown }) => void;
const registeredHandlers = new Map<string, HandlerRecord[]>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: (eventName: string, handler: HandlerRecord) => {
    const list = registeredHandlers.get(eventName) ?? [];
    list.push(handler);
    registeredHandlers.set(eventName, list);
    return Promise.resolve(() => {
      const after =
        registeredHandlers.get(eventName)?.filter((h) => h !== handler) ?? [];
      registeredHandlers.set(eventName, after);
    });
  },
}));

const persistAgentSpy = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../services/tauri", async () => {
  const actual = await vi.importActual<typeof import("../services/tauri")>(
    "../services/tauri",
  );
  return {
    ...actual,
    loadChatHistory: vi.fn().mockResolvedValue([]),
    saveTurnToolActivities: vi.fn().mockResolvedValue(undefined),
    setSessionCliInvocation: vi.fn().mockResolvedValue(undefined),
    updateTurnToolActivityProgress: vi.fn().mockResolvedValue(undefined),
    updateTurnAgentActivity: persistAgentSpy,
  };
});

import { useAgentStream } from "./useAgentStream";
import {
  useAppStore,
  type CompletedTurn,
  type ToolActivity,
} from "../stores/useAppStore";
import { findToolActivity } from "../stores/findToolActivity";

const WS_ID = "ws-1";
const SESSION_ID = "session-1";
const AGENT_TOOL_USE_ID = "toolu_agent1";
const AGENT_ID = "agent-abc";

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

async function mountHook(): Promise<void> {
  function Probe() {
    useAgentStream();
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  mountedContainers.push(container);
  await act(async () => {
    root.render(<Probe />);
  });
}

async function fire(eventName: string, payload: unknown): Promise<void> {
  const handlers = registeredHandlers.get(eventName) ?? [];
  expect(handlers.length).toBeGreaterThan(0);
  await act(async () => {
    for (const handler of handlers) handler({ payload });
  });
}

function hook(input: Record<string, unknown>) {
  return fire("agent-hook-event", {
    chat_session_id: SESSION_ID,
    input: { agent_id: AGENT_ID, ...input },
  });
}

function agentActivity(overrides: Partial<ToolActivity> = {}): ToolActivity {
  return {
    toolUseId: AGENT_TOOL_USE_ID,
    toolName: "Agent",
    inputJson: JSON.stringify({ description: "scan", run_in_background: true }),
    resultText: "Async agent launched successfully.",
    collapsed: true,
    summary: "scan",
    agentTaskId: AGENT_ID,
    agentStatus: "running",
    ...overrides,
  };
}

function turn(activities: ToolActivity[]): CompletedTurn {
  return {
    id: "turn-1",
    activities,
    messageCount: 1,
    collapsed: true,
    afterMessageIndex: 1,
  };
}

function agent(): ToolActivity | undefined {
  return findToolActivity(useAppStore.getState(), SESSION_ID, AGENT_TOOL_USE_ID);
}

beforeEach(() => {
  registeredHandlers.clear();
  persistAgentSpy.mockClear();
  useAppStore.setState({
    agentQuestions: {},
    toolActivities: {},
    completedTurns: { [SESSION_ID]: [turn([agentActivity()])] },
    streamingContent: {},
    streamingThinking: {},
    promptStartTime: {},
    sessionsByWorkspace: {},
  });
});

afterEach(async () => {
  for (const root of mountedRoots.splice(0).reverse()) {
    await act(async () => {
      root.unmount();
    });
  }
  for (const container of mountedContainers.splice(0)) {
    container.remove();
  }
});

describe("useAgentStream — background subagents in completed turns", () => {
  it("records nested tool calls on an agent whose turn already finalized", async () => {
    await mountHook();
    await hook({
      hook_event_name: "PreToolUse",
      tool_use_id: "toolu_read1",
      tool_name: "Read",
      tool_input: { file_path: "/tmp/x" },
    });
    expect(agent()?.agentToolCalls?.map((c) => c.toolUseId)).toEqual([
      "toolu_read1",
    ]);
  });

  it("applies SubagentStop and persists the outcome to the saved row", async () => {
    await mountHook();
    await hook({
      hook_event_name: "SubagentStop",
      tool_use_id: AGENT_TOOL_USE_ID,
      last_assistant_message: "Found 3 issues.",
    });
    expect(agent()?.agentStatus).toBe("completed");
    expect(agent()?.agentResultText).toBe("Found 3 issues.");
    expect(persistAgentSpy).toHaveBeenCalledWith(
      SESSION_ID,
      AGENT_TOOL_USE_ID,
      expect.objectContaining({
        agentStatus: "completed",
        agentResultText: "Found 3 issues.",
      }),
    );
  });

  it("does not persist while the agent is still in the live lane", async () => {
    useAppStore.setState({
      completedTurns: {},
      toolActivities: { [SESSION_ID]: [agentActivity()] },
    });
    await mountHook();
    await hook({
      hook_event_name: "SubagentStop",
      tool_use_id: AGENT_TOOL_USE_ID,
      last_assistant_message: "done",
    });
    expect(agent()?.agentStatus).toBe("completed");
    expect(persistAgentSpy).not.toHaveBeenCalled();
  });

  it("reaps a still-running agent when the process exits", async () => {
    await mountHook();
    await fire("agent-stream", {
      workspace_id: WS_ID,
      chat_session_id: SESSION_ID,
      event: { ProcessExited: { exit_code: 0 } },
    });
    expect(agent()?.agentStatus).toBe("stopped");
    expect(persistAgentSpy).toHaveBeenCalledWith(
      SESSION_ID,
      AGENT_TOOL_USE_ID,
      expect.objectContaining({ agentStatus: "stopped" }),
    );
  });

  it("does not reap an agent with no recorded status", async () => {
    useAppStore.setState({
      completedTurns: {
        [SESSION_ID]: [turn([agentActivity({ agentStatus: null })])],
      },
    });
    await mountHook();
    await fire("agent-stream", {
      workspace_id: WS_ID,
      chat_session_id: SESSION_ID,
      event: { ProcessExited: { exit_code: 0 } },
    });
    expect(agent()?.agentStatus).toBeNull();
    expect(persistAgentSpy).not.toHaveBeenCalled();
  });
});
