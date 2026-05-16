// @vitest-environment happy-dom

// Integration test for `useTaskTrackerWithHistory` — the hook the
// right-sidebar Tasks panel actually consumes. Pinned because the unit
// tests for `deriveTaskState` exercise the pure derivation only;
// regressions in the store-subscription path (stale selector caches,
// missing reactivity on append, wrong sessionId scoping) would slip past
// them. Mounts a real React tree, mutates the Zustand store the way
// `useAgentStream` does at runtime, and asserts the rendered counts
// update live without a full re-mount.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useTaskTrackerWithHistory } from "./useTaskTracker";
import {
  useAppStore,
  type CompletedTurn,
  type ToolActivity,
} from "../stores/useAppStore";

const SESSION_ID = "session-under-test";
const OTHER_SESSION_ID = "other-session";

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

function todoActivity(
  toolUseId: string,
  todos: Array<{ content: string; status: string; activeForm?: string }>,
): ToolActivity {
  return {
    toolUseId,
    toolName: "TodoWrite",
    inputJson: JSON.stringify({
      todos: todos.map((t) => ({
        content: t.content,
        status: t.status,
        activeForm: t.activeForm ?? t.content,
      })),
    }),
    resultText: "",
    collapsed: true,
    summary: "",
  };
}

function completedTurn(activities: ToolActivity[]): CompletedTurn {
  return {
    id: `turn-${Math.random()}`,
    activities,
    messageCount: 1,
    collapsed: false,
    afterMessageIndex: 0,
  };
}

function Harness({ sessionId }: { sessionId: string | null }) {
  const state = useTaskTrackerWithHistory(sessionId);
  return (
    <>
      <span data-testid="completed">{state.current.completedCount}</span>
      <span data-testid="total">{state.current.totalCount}</span>
      <span data-testid="history">{state.history.length}</span>
      <span data-testid="statuses">
        {state.current.tasks.map((t) => t.status).join(",")}
      </span>
    </>
  );
}

async function render(node: React.ReactNode): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  mountedContainers.push(container);
  await act(async () => {
    root.render(node);
  });
  return container;
}

function readCounts(container: HTMLElement) {
  return {
    completed: container.querySelector("[data-testid=completed]")?.textContent,
    total: container.querySelector("[data-testid=total]")?.textContent,
    history: container.querySelector("[data-testid=history]")?.textContent,
    statuses: container.querySelector("[data-testid=statuses]")?.textContent,
  };
}

beforeEach(() => {
  useAppStore.setState({
    toolActivities: {},
    completedTurns: {},
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
  useAppStore.setState({
    toolActivities: {},
    completedTurns: {},
  });
});

describe("useTaskTrackerWithHistory — store-driven reactivity", () => {
  it("renders zero state when no activities or turns exist for the session", async () => {
    const container = await render(<Harness sessionId={SESSION_ID} />);
    expect(readCounts(container)).toEqual({
      completed: "0",
      total: "0",
      history: "0",
      statuses: "",
    });
  });

  it("reflects an initial TodoWrite added to toolActivities", async () => {
    useAppStore.setState({
      toolActivities: {
        [SESSION_ID]: [
          todoActivity("tu-1", [
            { content: "A", status: "pending" },
            { content: "B", status: "pending" },
            { content: "C", status: "pending" },
          ]),
        ],
      },
    });

    const container = await render(<Harness sessionId={SESSION_ID} />);
    expect(readCounts(container)).toMatchObject({
      completed: "0",
      total: "3",
      statuses: "pending,pending,pending",
    });
  });

  it("re-renders with updated completion count when a follow-up TodoWrite appends", async () => {
    // Initial: 3 pending tasks.
    useAppStore.setState({
      toolActivities: {
        [SESSION_ID]: [
          todoActivity("tu-1", [
            { content: "A", status: "pending" },
            { content: "B", status: "pending" },
            { content: "C", status: "pending" },
          ]),
        ],
      },
    });
    const container = await render(<Harness sessionId={SESSION_ID} />);
    expect(readCounts(container).completed).toBe("0");

    // Simulate the agent emitting a second TodoWrite that marks A as
    // completed. This is the exact pattern `useAgentStream` produces
    // via `addToolActivity`: a NEW ToolActivity entry appended onto the
    // existing array. The hook must re-derive and bump completedCount.
    await act(async () => {
      const cur = useAppStore.getState().toolActivities[SESSION_ID] ?? [];
      useAppStore.setState({
        toolActivities: {
          ...useAppStore.getState().toolActivities,
          [SESSION_ID]: [
            ...cur,
            todoActivity("tu-2", [
              { content: "A", status: "completed" },
              { content: "B", status: "in_progress" },
              { content: "C", status: "pending" },
            ]),
          ],
        },
      });
    });

    expect(readCounts(container)).toMatchObject({
      completed: "1",
      total: "3",
      statuses: "completed,in_progress,pending",
    });
  });

  it("rolls completed-turn state forward into current activities", async () => {
    // A persisted completed turn established the plan with phase 1 done.
    useAppStore.setState({
      completedTurns: {
        [SESSION_ID]: [
          completedTurn([
            todoActivity("tu-1", [
              { content: "Phase 1", status: "completed" },
              { content: "Phase 2", status: "in_progress" },
              { content: "Phase 3", status: "pending" },
            ]),
          ]),
        ],
      },
      toolActivities: {
        [SESSION_ID]: [],
      },
    });

    const container = await render(<Harness sessionId={SESSION_ID} />);
    expect(readCounts(container)).toMatchObject({
      completed: "1",
      total: "3",
      history: "0",
      statuses: "completed,in_progress,pending",
    });

    // Agent starts a new turn: phase 2 finishes, phase 3 picks up.
    await act(async () => {
      useAppStore.setState({
        toolActivities: {
          ...useAppStore.getState().toolActivities,
          [SESSION_ID]: [
            todoActivity("tu-2", [
              { content: "Phase 1", status: "completed" },
              { content: "Phase 2", status: "completed" },
              { content: "Phase 3", status: "in_progress" },
            ]),
          ],
        },
      });
    });

    expect(readCounts(container)).toMatchObject({
      completed: "2",
      total: "3",
      history: "0",
      statuses: "completed,completed,in_progress",
    });
  });

  it("does not leak task state across sessions when sessionId is scoped", async () => {
    useAppStore.setState({
      toolActivities: {
        [SESSION_ID]: [
          todoActivity("tu-1", [
            { content: "Visible task", status: "completed" },
          ]),
        ],
        [OTHER_SESSION_ID]: [
          todoActivity("tu-2", [
            { content: "Hidden task A", status: "pending" },
            { content: "Hidden task B", status: "pending" },
          ]),
        ],
      },
    });

    const container = await render(<Harness sessionId={SESSION_ID} />);
    expect(readCounts(container)).toMatchObject({
      completed: "1",
      total: "1",
    });
  });

  it("renders the EMPTY_WITH_HISTORY shape when sessionId is null", async () => {
    useAppStore.setState({
      toolActivities: {
        [SESSION_ID]: [
          todoActivity("tu-1", [
            { content: "Stale task", status: "pending" },
          ]),
        ],
      },
    });

    const container = await render(<Harness sessionId={null} />);
    expect(readCounts(container)).toMatchObject({
      completed: "0",
      total: "0",
      history: "0",
      statuses: "",
    });
  });
});
