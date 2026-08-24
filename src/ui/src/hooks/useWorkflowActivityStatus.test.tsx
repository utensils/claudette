// @vitest-environment happy-dom

/**
 * Regression tests for the status pill that never went away.
 *
 * A backgrounded `Workflow` outlives the turn that launched it, and the
 * `agent-stream` feed the webview listens on is torn down at every turn's
 * `Result` (`src/agent/session.rs`). The run's terminal `task_notification`
 * therefore arrived when no per-turn forwarder was attached — nothing carried
 * it to the webview, `agentStatus` stayed `"running"`, and because that status
 * is persisted the pill came back on every reload, forever. The counts froze
 * with it: the tree's last delivered snapshot still showed agents in flight,
 * so a finished run kept advertising "0/5" or "48/49".
 *
 * The fix persists and reconciles on the Rust side, where the notification
 * actually lands, then emits `workflow-activity-status` purely so an open
 * window settles without a reload. These tests pin the consumer half: the
 * event must resolve a run whose turn was finalized long ago, and it must
 * never be able to make things worse when the payload is partial.
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

import { useWorkflowActivityStatus } from "./useWorkflowActivityStatus";
import {
  useAppStore,
  type CompletedTurn,
  type ToolActivity,
} from "../stores/useAppStore";
import { findToolActivity } from "../stores/findToolActivity";
import { collectInFlightWorkflows } from "../stores/inFlightWorkflows";
import {
  summarizeWorkflowProgress,
  type WorkflowProgressEntry,
} from "../types/workflow";

const WS_ID = "ws-1";
const SESSION_ID = "session-1";
const WF_ID = "toolu_wf1";

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

async function mountHook(): Promise<void> {
  function Probe() {
    useWorkflowActivityStatus();
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

async function fireStatus(
  payload: Partial<{
    workspace_id: string;
    chat_session_id: string;
    tool_use_id: string;
    status: string;
    workflow_progress: unknown;
  }>,
): Promise<void> {
  const handlers = registeredHandlers.get("workflow-activity-status") ?? [];
  expect(handlers.length).toBeGreaterThan(0);
  await act(async () => {
    for (const handler of handlers) {
      handler({
        payload: {
          workspace_id: WS_ID,
          chat_session_id: SESSION_ID,
          tool_use_id: WF_ID,
          status: "completed",
          workflow_progress: null,
          ...payload,
        },
      });
    }
  });
}

/** The wedged shape from the field: five agents, none of them terminal. */
const STALE_TREE: WorkflowProgressEntry[] = [
  { type: "workflow_phase", index: 0, title: "Investigate" },
  ...[1, 2, 3, 4, 5].map<WorkflowProgressEntry>((index) => ({
    type: "workflow_agent",
    index,
    label: `probe-${index}`,
    state: "progress",
    phaseTitle: "Investigate",
  })),
];

/** What Rust sends back after reconciling it against `completed`. */
const RECONCILED_TREE: WorkflowProgressEntry[] = STALE_TREE.map((entry) =>
  entry.type === "workflow_agent" ? { ...entry, state: "done" } : entry,
);

function workflowActivity(overrides: Partial<ToolActivity> = {}): ToolActivity {
  return {
    toolUseId: WF_ID,
    toolName: "Workflow",
    inputJson: JSON.stringify({ script: "export const meta = {}" }),
    resultText: "Workflow launched in background. Task ID: w2lwlmfps",
    collapsed: false,
    summary: "nightly-publish-investigation",
    agentStatus: "running",
    workflowProgress: STALE_TREE,
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

function activityNow(): ToolActivity | undefined {
  return findToolActivity(useAppStore.getState(), SESSION_ID, WF_ID);
}

function pillWouldRender(): boolean {
  const state = useAppStore.getState();
  return (
    collectInFlightWorkflows(
      state.toolActivities[SESSION_ID] ?? [],
      state.completedTurns[SESSION_ID] ?? [],
    ).length > 0
  );
}

beforeEach(() => {
  registeredHandlers.clear();
  useAppStore.setState({ toolActivities: {}, completedTurns: {} });
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

describe("useWorkflowActivityStatus", () => {
  it("clears the pill for a run whose launching turn was finalized long ago", async () => {
    // The normal case, not an edge one: a workflow's launching turn ends
    // seconds after launch, so by the time the run finishes its activity has
    // migrated out of the live lane into `completedTurns`.
    useAppStore.setState({
      completedTurns: { [SESSION_ID]: [turn("t1", [workflowActivity()])] },
    });
    await mountHook();
    expect(pillWouldRender()).toBe(true);

    await fireStatus({ status: "completed" });

    expect(activityNow()?.agentStatus).toBe("completed");
    expect(pillWouldRender()).toBe(false);
  });

  it("applies the reconciled tree so the count stops reading 0/5", async () => {
    // Status alone is not enough. The card and pill derive their fraction
    // purely from the tree, so a finished run whose last snapshot showed
    // agents in flight kept advertising an unfinished fraction.
    useAppStore.setState({
      completedTurns: { [SESSION_ID]: [turn("t1", [workflowActivity()])] },
    });
    await mountHook();
    expect(summarizeWorkflowProgress(STALE_TREE)).toMatchObject({
      doneCount: 0,
      totalCount: 5,
      running: true,
    });

    await fireStatus({
      status: "completed",
      workflow_progress: RECONCILED_TREE,
    });

    const summary = summarizeWorkflowProgress(activityNow()?.workflowProgress);
    expect(summary.doneCount).toBe(5);
    expect(summary.totalCount).toBe(5);
    expect(summary.running).toBe(false);
    expect(summary.errorCount).toBe(0);
  });

  it("reconciles the live tree instead of taking the payload's older one", async () => {
    // Rust reconciles the *checkpointed* row, which is a snapshot from seconds
    // after launch — commonly `[]`, since a workflow's tool_result lands within
    // a second of the turn being saved. Every tick since went only to this
    // store. Taking the payload verbatim would blank a rich card, and
    // `useAgentStream`'s handler for the same notification would then persist
    // the downgraded copy back to the row.
    useAppStore.setState({
      completedTurns: { [SESSION_ID]: [turn("t1", [workflowActivity()])] },
    });
    await mountHook();

    await fireStatus({ status: "completed", workflow_progress: [] });

    const tree = activityNow()?.workflowProgress;
    expect(tree).toHaveLength(STALE_TREE.length);
    const summary = summarizeWorkflowProgress(tree);
    expect(summary.totalCount).toBe(5);
    expect(summary.doneCount).toBe(5);
    expect(summary.running).toBe(false);
  });

  it("preserves per-agent detail the payload's snapshot would have dropped", async () => {
    // The live tree carries tokens / tool counts / labels accumulated over the
    // run. Rust's checkpoint snapshot has none of it.
    const rich = STALE_TREE.map((entry) =>
      entry.type === "workflow_agent"
        ? { ...entry, tokens: 1234, toolCalls: 7 }
        : entry,
    );
    useAppStore.setState({
      completedTurns: {
        [SESSION_ID]: [turn("t1", [workflowActivity({ workflowProgress: rich })])],
      },
    });
    await mountHook();

    await fireStatus({ status: "completed", workflow_progress: RECONCILED_TREE });

    const summary = summarizeWorkflowProgress(activityNow()?.workflowProgress);
    expect(summary.totalTokens).toBe(5 * 1234);
    expect(summary.totalToolCalls).toBe(5 * 7);
    expect(summary.doneCount).toBe(5);
  });

  it("falls back to the payload's tree when this window never saw the run", async () => {
    // A session hydrated from disk after the launching turn was saved has the
    // checkpoint's empty tree; the payload is the only tree available.
    useAppStore.setState({
      completedTurns: {
        [SESSION_ID]: [turn("t1", [workflowActivity({ workflowProgress: [] })])],
      },
    });
    await mountHook();

    await fireStatus({
      status: "completed",
      workflow_progress: RECONCILED_TREE,
    });

    expect(summarizeWorkflowProgress(activityNow()?.workflowProgress)).toMatchObject({
      doneCount: 5,
      totalCount: 5,
      running: false,
    });
  });

  it("resolves a run that is still in the live lane", async () => {
    // The other ordering: the notification arrives while the launching turn
    // is somehow still open.
    useAppStore.setState({
      toolActivities: { [SESSION_ID]: [workflowActivity()] },
    });
    await mountHook();

    await fireStatus({ status: "failed" });

    expect(activityNow()?.agentStatus).toBe("failed");
    expect(pillWouldRender()).toBe(false);
  });

  it("reconciles the live tree when the payload carries none", async () => {
    // `null` means "the row had no readable tree", which must not be confused
    // with "the tree is empty" — blanking it would turn a stale card into a
    // permanently empty one. The live tree still gets closed out.
    useAppStore.setState({
      completedTurns: { [SESSION_ID]: [turn("t1", [workflowActivity()])] },
    });
    await mountHook();

    await fireStatus({ status: "completed", workflow_progress: null });

    expect(activityNow()?.workflowProgress).toHaveLength(STALE_TREE.length);
    expect(summarizeWorkflowProgress(activityNow()?.workflowProgress).doneCount).toBe(5);
    expect(activityNow()?.agentStatus).toBe("completed");
  });

  it("leaves the tree untouched when there is nothing anywhere to reconcile", async () => {
    useAppStore.setState({
      completedTurns: {
        [SESSION_ID]: [turn("t1", [workflowActivity({ workflowProgress: undefined })])],
      },
    });
    await mountHook();

    await fireStatus({ status: "completed", workflow_progress: null });

    expect(activityNow()?.workflowProgress).toBeUndefined();
    expect(activityNow()?.agentStatus).toBe("completed");
  });

  it("drops a malformed payload tree but still applies the status", async () => {
    // Degrade to "status applied, live tree reconciled" rather than writing
    // garbage the summarizer would then have to defend against.
    useAppStore.setState({
      completedTurns: {
        [SESSION_ID]: [turn("t1", [workflowActivity({ workflowProgress: undefined })])],
      },
    });
    await mountHook();

    await fireStatus({
      status: "completed",
      workflow_progress: [{ type: "workflow_agent", index: 1 }],
    });

    expect(activityNow()?.workflowProgress).toBeUndefined();
    expect(activityNow()?.agentStatus).toBe("completed");
  });

  it("is a no-op for a session whose transcript was never hydrated", async () => {
    // Persistence deliberately does not depend on this event: Rust has
    // already written the row. Applying it here must not throw or invent
    // store entries for a session the user never opened — the next hydrate
    // reads the correct row from disk.
    await mountHook();

    await expect(fireStatus({ status: "completed" })).resolves.toBeUndefined();

    expect(useAppStore.getState().toolActivities[SESSION_ID]).toBeUndefined();
    expect(useAppStore.getState().completedTurns[SESSION_ID]).toBeUndefined();
  });

  it("ignores a payload with no session or tool id", async () => {
    useAppStore.setState({
      completedTurns: { [SESSION_ID]: [turn("t1", [workflowActivity()])] },
    });
    await mountHook();

    await fireStatus({ chat_session_id: "", status: "completed" });
    await fireStatus({ tool_use_id: "", status: "completed" });

    expect(activityNow()?.agentStatus).toBe("running");
  });
});
