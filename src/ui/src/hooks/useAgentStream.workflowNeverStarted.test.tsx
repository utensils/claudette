// @vitest-environment happy-dom

/**
 * Regression tests for the one wedge PR 1023 could not reach: a `Workflow` tool
 * call that never launches a background task.
 *
 * All of PR 1023's machinery hangs off the terminal `task_notification`. A
 * `Workflow` call that errors, is rejected, or returns without starting
 * anything emits none — so nothing resolves it. The row is checkpointed with
 * no status and an empty tree, `isInFlightWorkflow` reads a missing status as
 * in-flight (correctly, for a run that is genuinely still starting), and the
 * pill sits at `· starting` with no fraction. Only `ProcessExited` or the next
 * boot sweep clears it, and the CLI process is persistent across turns, so in
 * practice that means "until the app restarts".
 *
 * The `tool_result` is the signal, because it is the only thing such a run
 * ever emits. The hazard is the mirror image: a *live* backgrounded run
 * announces its task id in that same result within a second of launch, and
 * resolving on every Workflow tool_result would kill every live pill on the
 * spot. The first test here is that guard.
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
import { findToolActivity } from "../stores/findToolActivity";
import { isInFlightWorkflow } from "../stores/inFlightWorkflows";

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

async function fireToolResult(
  text: string,
  opts: { isError?: boolean; toolUseId?: string } = {},
): Promise<void> {
  const handlers = registeredHandlers.get("agent-stream") ?? [];
  expect(handlers.length).toBeGreaterThan(0);
  await act(async () => {
    for (const handler of handlers) {
      handler({
        payload: {
          workspace_id: WS_ID,
          chat_session_id: SESSION_ID,
          event: {
            Stream: {
              type: "user",
              message: {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: opts.toolUseId ?? WF_ID,
                    content: text,
                    ...(opts.isError === undefined
                      ? {}
                      : { is_error: opts.isError }),
                  },
                ],
              },
            },
          },
        },
      });
    }
  });
}

function activity(overrides: Partial<ToolActivity> = {}): ToolActivity {
  return {
    toolUseId: WF_ID,
    toolName: "Workflow",
    inputJson: JSON.stringify({ script: "export const meta = {}" }),
    resultText: "",
    collapsed: false,
    summary: "async-activity-drawer-survey",
    ...overrides,
  };
}

function current(toolUseId = WF_ID): ToolActivity | undefined {
  return findToolActivity(useAppStore.getState(), SESSION_ID, toolUseId);
}

function stillInFlight(toolUseId = WF_ID): boolean {
  const found = current(toolUseId);
  return !!found && isInFlightWorkflow(found);
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

describe("useAgentStream — Workflow calls that never launched a task", () => {
  // THE regression guard. A backgrounded run's tool_result arrives ~1s after
  // launch while the run is very much alive; resolving on it would undo
  // PR 1023 entirely and kill every live pill on the spot.
  it("leaves a live backgrounded run alone when it announces a task id", async () => {
    useAppStore.setState({
      toolActivities: { [SESSION_ID]: [activity()] },
    });
    await mountHook();

    await fireToolResult(
      "Workflow launched in background. Task ID: w2lwlmfps\nSummary: investigate\nTranscript dir: /tmp/x",
    );

    expect(current()?.agentStatus).toBeUndefined();
    expect(stillInFlight()).toBe(true);
    expect(persistSpy).not.toHaveBeenCalled();
  });

  it("still leaves it alone when the announcement ends in a period", async () => {
    // The other shape the announcement takes in the wild.
    useAppStore.setState({ toolActivities: { [SESSION_ID]: [activity()] } });
    await mountHook();

    await fireToolResult("Workflow launched in background. Task ID: wf_abc123.");

    expect(stillInFlight()).toBe(true);
  });

  it("resolves a run that returned without launching anything", async () => {
    useAppStore.setState({ toolActivities: { [SESSION_ID]: [activity()] } });
    await mountHook();

    await fireToolResult("Workflow did not start: no agents were scheduled.");

    expect(current()?.agentStatus).toBe("stopped");
    expect(stillInFlight()).toBe(false);
  });

  it("records an errored tool call as failed rather than stopped", async () => {
    // `is_error` is the structural signal — a failure is not the user's doing
    // and should not read as a run they stopped.
    useAppStore.setState({ toolActivities: { [SESSION_ID]: [activity()] } });
    await mountHook();

    await fireToolResult("Error: script failed to parse", { isError: true });

    expect(current()?.agentStatus).toBe("failed");
    expect(stillInFlight()).toBe(false);
  });

  it("treats a missing is_error as no error", async () => {
    // `undefined` and `false` both mean "no error"; neither may be read as one.
    useAppStore.setState({ toolActivities: { [SESSION_ID]: [activity()] } });
    await mountHook();

    await fireToolResult("nothing to do", { isError: false });

    expect(current()?.agentStatus).toBe("stopped");
  });

  it("persists the status so a reload cannot resurrect the pill", async () => {
    // A no-op today (the turn has not checkpointed, so no row exists yet —
    // the status reaches disk through the checkpoint write). Covers the
    // replayed-result case, where the row is already there.
    useAppStore.setState({ toolActivities: { [SESSION_ID]: [activity()] } });
    await mountHook();

    await fireToolResult("Workflow could not start");

    expect(persistSpy).toHaveBeenCalledWith(WF_ID, null, "stopped", SESSION_ID);
  });

  it("never touches a non-Workflow tool result", async () => {
    useAppStore.setState({
      toolActivities: {
        [SESSION_ID]: [
          activity({ toolUseId: "toolu_bash", toolName: "Bash" }),
        ],
      },
    });
    await mountHook();

    await fireToolResult("total 24\ndrwxr-xr-x", { toolUseId: "toolu_bash" });

    expect(current("toolu_bash")?.agentStatus).toBeUndefined();
    expect(persistSpy).not.toHaveBeenCalled();
  });

  it("does not overwrite an outcome another path already recorded", async () => {
    // A replayed tool result must not relabel a run that completed.
    useAppStore.setState({
      toolActivities: {
        [SESSION_ID]: [activity({ agentStatus: "completed" })],
      },
    });
    await mountHook();

    await fireToolResult("Workflow could not start");

    expect(current()?.agentStatus).toBe("completed");
    expect(persistSpy).not.toHaveBeenCalled();
  });

  it("resolves an activity that has already moved into a completed turn", async () => {
    // Replay after the launching turn was finalized: the activity lives in
    // `completedTurns` by then, which `findToolActivity` also scans.
    useAppStore.setState({
      completedTurns: {
        [SESSION_ID]: [
          {
            id: "t1",
            activities: [activity()],
            messageCount: 1,
            collapsed: true,
            afterMessageIndex: 1,
          },
        ],
      },
    });
    await mountHook();

    await fireToolResult("Workflow could not start");

    expect(current()?.agentStatus).toBe("stopped");
    expect(stillInFlight()).toBe(false);
  });
});
