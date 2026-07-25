// @vitest-environment happy-dom

/**
 * Regression tests for persisting a backgrounded `Workflow` run's final
 * state at its activity row.
 *
 * A workflow's `tool_result` ("launched in background") lands within a
 * second of launch, so `save_turn_tool_activities` checkpoints the turn
 * with `workflow_progress_json: "[]"` and a null status long before any
 * agent has run. The completed tree therefore has to be written later,
 * when the terminal `task_notification` arrives — `update_turn_tool_
 * activity_progress` is the only UPDATE path in the schema.
 *
 * The bug these pin: that write used to be gated on the notification
 * itself carrying `workflow_progress`. The CLI attaches that field to
 * `task_progress` events ONLY — its `task_notification` payload is
 * `{task_id, tool_use_id, status, output_file, summary, usage}` with no
 * tree on any code path — so the gate never opened and the write never
 * happened. Every finished run replayed from the DB as "Starting
 * workflow…" behind a status pill that spun forever, because the stale
 * row still said the run was going.
 *
 * Strategy matches `useAgentStream.sessionRenamed.test.tsx`: mock
 * `listen()` to capture the `agent-stream` handler, mount the hook, and
 * push raw stream payloads through it.
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

const persistSpy = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock("../services/tauri", async () => {
  const actual = await vi.importActual<typeof import("../services/tauri")>(
    "../services/tauri",
  );
  return {
    ...actual,
    loadChatHistory: vi.fn().mockResolvedValue([]),
    saveTurnToolActivities: vi.fn().mockResolvedValue(undefined),
    setSessionCliInvocation: vi.fn().mockResolvedValue(undefined),
    updateTurnToolActivityProgress: persistSpy,
  };
});

import { useAgentStream } from "./useAgentStream";
import { useAppStore, type ToolActivity } from "../stores/useAppStore";
import type { WorkflowProgressEntry } from "../types/workflow";

const WS_ID = "ws-1";
const SESSION_ID = "session-1";
const WF_ID = "toolu_wf1";

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

async function fireStream(streamEvent: Record<string, unknown>): Promise<void> {
  const handlers = registeredHandlers.get("agent-stream") ?? [];
  expect(handlers.length).toBeGreaterThan(0);
  await act(async () => {
    for (const handler of handlers) {
      handler({
        payload: {
          workspace_id: WS_ID,
          chat_session_id: SESSION_ID,
          event: { Stream: streamEvent },
        },
      });
    }
  });
}

const TREE: WorkflowProgressEntry[] = [
  { type: "workflow_phase", index: 1, title: "Review" },
  {
    type: "workflow_agent",
    index: 1,
    label: "review:bugs",
    state: "done",
    phaseTitle: "Review",
  },
];

function workflowActivity(
  overrides: Partial<ToolActivity> = {},
): ToolActivity {
  return {
    toolUseId: WF_ID,
    toolName: "Workflow",
    inputJson: JSON.stringify({ script: "export const meta = {}" }),
    resultText: "Workflow launched in background. Task ID: w4stpeffj",
    collapsed: false,
    summary: "review-changes",
    agentStatus: "running",
    workflowProgress: TREE,
    ...overrides,
  };
}

/** The terminal event the CLI actually emits — note the absent tree. */
function terminalNotification(): Record<string, unknown> {
  return {
    type: "system",
    subtype: "task_notification",
    task_id: "wf_1",
    tool_use_id: WF_ID,
    status: "completed",
    output_file: "",
    summary: "Workflow completed",
  };
}

beforeEach(() => {
  registeredHandlers.clear();
  persistSpy.mockClear();
  useAppStore.setState({
    agentQuestions: {},
    toolActivities: {},
    completedTurns: {},
    streamingContent: {},
    streamingThinking: {},
    promptStartTime: {},
    sessionsByWorkspace: {},
  });
});

afterEach(async () => {
  vi.useRealTimers();
  for (const root of mountedRoots.splice(0).reverse()) {
    await act(async () => {
      root.unmount();
    });
  }
  for (const container of mountedContainers.splice(0)) {
    container.remove();
  }
});

describe("useAgentStream — workflow progress persistence", () => {
  it("persists the last-known tree when the terminal notification omits it", async () => {
    useAppStore.setState({
      toolActivities: { [SESSION_ID]: [workflowActivity()] },
    });
    await mountHook();

    await fireStream(terminalNotification());

    expect(persistSpy).toHaveBeenCalledTimes(1);
    const [toolUseId, treeJson, status] = persistSpy.mock.calls[0];
    expect(toolUseId).toBe(WF_ID);
    expect(JSON.parse(treeJson)).toEqual(TREE);
    expect(status).toBe("completed");
  });

  it("finds the activity after its turn has already been checkpointed", async () => {
    // The normal case for a backgrounded run: the launching turn ended
    // minutes before the workflow did, so the activity now lives in
    // `completedTurns`, not `toolActivities`.
    useAppStore.setState({
      toolActivities: { [SESSION_ID]: [] },
      completedTurns: {
        [SESSION_ID]: [
          {
            id: "turn-1",
            activities: [workflowActivity()],
            messageCount: 2,
            collapsed: false,
            afterMessageIndex: 2,
          },
        ],
      },
    });
    await mountHook();

    await fireStream(terminalNotification());

    expect(persistSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(persistSpy.mock.calls[0][1])).toEqual(TREE);
    expect(persistSpy.mock.calls[0][2]).toBe("completed");
  });

  it("writes the terminal status without blanking the tree when none is known", async () => {
    // A run that failed before its first `task_progress`. The status has
    // to land or the pill spins forever against a stale "running" row —
    // but the tree must go as `null`, not `"[]"`, so the COALESCE leaves
    // whatever is stored intact instead of overwriting a good row.
    useAppStore.setState({
      toolActivities: {
        [SESSION_ID]: [
          workflowActivity({ workflowProgress: undefined, agentStatus: undefined }),
        ],
      },
    });
    await mountHook();

    await fireStream({ ...terminalNotification(), status: "failed" });

    expect(persistSpy).toHaveBeenCalledTimes(1);
    expect(persistSpy.mock.calls[0][1]).toBeNull();
    expect(persistSpy.mock.calls[0][2]).toBe("failed");
  });

  it("does not persist on progress ticks — one write per run", async () => {
    useAppStore.setState({
      toolActivities: { [SESSION_ID]: [workflowActivity()] },
    });
    await mountHook();

    await fireStream({
      type: "system",
      subtype: "task_progress",
      task_id: "wf_1",
      tool_use_id: WF_ID,
      workflow_progress: TREE,
    });

    expect(persistSpy).not.toHaveBeenCalled();
  });

  it("ignores terminal notifications for non-workflow activities", async () => {
    // Backgrounded Bash and Agent tasks emit the same notification; only
    // Workflow rows carry a progress tree worth writing back.
    useAppStore.setState({
      toolActivities: {
        [SESSION_ID]: [
          workflowActivity({
            toolName: "Agent",
            workflowProgress: undefined,
          }),
        ],
      },
    });
    await mountHook();

    await fireStream(terminalNotification());

    expect(persistSpy).not.toHaveBeenCalled();
  });
});
