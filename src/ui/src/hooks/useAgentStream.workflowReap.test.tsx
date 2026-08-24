// @vitest-environment happy-dom

/**
 * Regression tests for resolving workflows whose CLI process went away
 * without ever reporting an outcome.
 *
 * A `Workflow` run lives inside the Claude CLI process. On the happy path
 * it ends with a `task_notification` carrying `status: "completed"`, and
 * everything downstream reads it as finished. But nothing emits that
 * notification when the process is killed — the user hitting stop, a
 * crash, a session reset — and the activity was left pinned at
 * `agentStatus: "running"` (or at no status at all, for a run checkpointed
 * before its first progress tick).
 *
 * The visible symptom: the status pill above the composer never went away.
 * Because `agentStatus` is persisted to `turn_tool_activities`, it also
 * came back on every reload of the session, accumulating one dead pill per
 * abandoned run.
 *
 * `ProcessExited` is the authoritative signal here — `AgentSessionState`
 * holds a single `active_pid` per chat session, so a session's process
 * exiting means every background task it owned is gone.
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
import {
  useAppStore,
  type CompletedTurn,
  type ToolActivity,
} from "../stores/useAppStore";
import { findToolActivity } from "../stores/findToolActivity";
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

async function fireProcessExited(): Promise<void> {
  const handlers = registeredHandlers.get("agent-stream") ?? [];
  expect(handlers.length).toBeGreaterThan(0);
  await act(async () => {
    for (const handler of handlers) {
      handler({
        payload: {
          workspace_id: WS_ID,
          chat_session_id: SESSION_ID,
          event: { ProcessExited: { exit_code: 0 } },
        },
      });
    }
  });
}

const TREE: WorkflowProgressEntry[] = [
  { type: "workflow_phase", index: 1, title: "Investigate" },
  {
    type: "workflow_agent",
    index: 1,
    label: "investigate:a",
    state: "progress",
    phaseTitle: "Investigate",
  },
];

function workflowActivity(overrides: Partial<ToolActivity> = {}): ToolActivity {
  return {
    toolUseId: WF_ID,
    toolName: "Workflow",
    inputJson: JSON.stringify({ script: "export const meta = {}" }),
    resultText: "Workflow launched in background. Task ID: w4stpeffj",
    collapsed: false,
    summary: "trner-labs-fifo-violation",
    agentStatus: "running",
    workflowProgress: TREE,
    ...overrides,
  };
}

function turn(id: string, activities: ToolActivity[]): CompletedTurn {
  return {
    id,
    activities,
    messageCount: 1,
    collapsed: true,
    afterMessageIndex: 1,
  };
}

function statusOf(toolUseId: string): string | null | undefined {
  return findToolActivity(useAppStore.getState(), SESSION_ID, toolUseId)
    ?.agentStatus;
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
  for (const root of mountedRoots.splice(0).reverse()) {
    await act(async () => {
      root.unmount();
    });
  }
  for (const container of mountedContainers.splice(0)) {
    container.remove();
  }
});

describe("useAgentStream — reaping orphaned workflows on ProcessExited", () => {
  // The common shape: the workflow's launching turn ended minutes ago, so
  // the activity lives in `completedTurns`, and the run was still going
  // when the process died.
  it("resolves a running workflow held in a completed turn", async () => {
    useAppStore.setState({
      completedTurns: { [SESSION_ID]: [turn("turn-1", [workflowActivity()])] },
    });
    await mountHook();

    await fireProcessExited();

    expect(statusOf(WF_ID)).toBe("stopped");
  });

  // Persisted as well as applied in-store: the store copy dies with the
  // session view, and it is the stale DB row that resurrects the pill on
  // the next load. `null` for the tree so the COALESCE keeps whatever the
  // last progress tick stored.
  it("persists the resolved status so a reload cannot resurrect the pill", async () => {
    useAppStore.setState({
      completedTurns: { [SESSION_ID]: [turn("turn-1", [workflowActivity()])] },
    });
    await mountHook();

    await fireProcessExited();

    expect(persistSpy).toHaveBeenCalledTimes(1);
    // The session id scopes the write: forking copies `tool_use_id` into the
    // fork's own rows, so an unscoped update would reach every fork's copy.
    expect(persistSpy).toHaveBeenCalledWith(WF_ID, null, "stopped", SESSION_ID);
  });

  // A run checkpointed before its first `task_progress` tick has no status
  // at all. That reads as in-flight everywhere (correctly, while live), so
  // it needs resolving too or it wedges exactly the same way.
  it("resolves a workflow that never reported a status", async () => {
    useAppStore.setState({
      completedTurns: {
        [SESSION_ID]: [
          turn("turn-1", [
            workflowActivity({
              agentStatus: undefined,
              workflowProgress: undefined,
            }),
          ]),
        ],
      },
    });
    await mountHook();

    await fireProcessExited();

    expect(statusOf(WF_ID)).toBe("stopped");
  });

  // The happy path must be untouched: the terminal notification landed
  // minutes ago and already says how the run ended. Overwriting that with
  // "stopped" would misreport every successful run.
  it.each(["completed", "failed", "stopped"])(
    "leaves a run that already ended with status %s alone",
    async (agentStatus) => {
      useAppStore.setState({
        completedTurns: {
          [SESSION_ID]: [turn("turn-1", [workflowActivity({ agentStatus })])],
        },
      });
      await mountHook();

      await fireProcessExited();

      expect(statusOf(WF_ID)).toBe(agentStatus);
      expect(persistSpy).not.toHaveBeenCalled();
    },
  );

  // Scoped to workflows. `Task` / `Agent` activities carry `agentStatus`
  // too, but they are not what pins a pill above the composer, and
  // rewriting their status here would be an unrelated behavior change.
  it("does not touch non-workflow activities", async () => {
    useAppStore.setState({
      completedTurns: {
        [SESSION_ID]: [
          turn("turn-1", [
            workflowActivity({
              toolUseId: "toolu_task1",
              toolName: "Task",
            }),
          ]),
        ],
      },
    });
    await mountHook();

    await fireProcessExited();

    expect(statusOf("toolu_task1")).toBe("running");
    expect(persistSpy).not.toHaveBeenCalled();
  });

  // Another session's workflow is owned by a different CLI process and
  // must survive this one exiting.
  it("does not reap workflows belonging to another session", async () => {
    useAppStore.setState({
      completedTurns: {
        "session-2": [turn("turn-1", [workflowActivity()])],
      },
    });
    await mountHook();

    await fireProcessExited();

    expect(
      findToolActivity(useAppStore.getState(), "session-2", WF_ID)?.agentStatus,
    ).toBe("running");
    expect(persistSpy).not.toHaveBeenCalled();
  });

  // Concurrent runs each get resolved — the pill stack renders one entry
  // per workflow, so missing any one of them leaves a stuck pill behind.
  it("resolves every in-flight workflow in the session", async () => {
    useAppStore.setState({
      completedTurns: {
        [SESSION_ID]: [
          turn("turn-1", [
            workflowActivity(),
            workflowActivity({ toolUseId: "toolu_wf2" }),
          ]),
        ],
      },
    });
    await mountHook();

    await fireProcessExited();

    expect(statusOf(WF_ID)).toBe("stopped");
    expect(statusOf("toolu_wf2")).toBe("stopped");
    expect(persistSpy).toHaveBeenCalledTimes(2);
  });
});
