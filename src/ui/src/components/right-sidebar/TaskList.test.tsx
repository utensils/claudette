// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskStatus, TrackedTask } from "../../hooks/useTaskTracker";
import type { WorkspaceTaskHistoryResult } from "../../hooks/useWorkspaceTaskHistory";
import { TaskList } from "./TaskList";

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

// `useActiveTaskScroll` reaches for browser APIs happy-dom doesn't fully
// implement. Stub them deterministically: a `scrollIntoView` spy lets the
// auto-scroll tests assert on calls, and the observers are no-ops so DOM
// churn never drives the pill on its own during a test.
let scrollIntoView: ReturnType<typeof vi.fn>;

/** A constructable no-op standing in for ResizeObserver / MutationObserver. */
class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

function installDomStubs() {
  scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView =
    scrollIntoView as unknown as Element["scrollIntoView"];
  globalThis.ResizeObserver =
    NoopObserver as unknown as typeof globalThis.ResizeObserver;
  globalThis.MutationObserver =
    NoopObserver as unknown as typeof globalThis.MutationObserver;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  }) as typeof globalThis.requestAnimationFrame;
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

/** Mount a `TaskList` and return its container plus a `rerender` that swaps
 *  the `taskHistory` prop on the same root — used to drive task transitions. */
async function renderTaskList(history: WorkspaceTaskHistoryResult) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  mountedContainers.push(container);
  await act(async () => {
    root.render(<TaskList taskHistory={history} />);
  });
  const rerender = (next: WorkspaceTaskHistoryResult) =>
    act(async () => {
      root.render(<TaskList taskHistory={next} />);
    });
  return { container, rerender };
}

beforeEach(() => {
  installDomStubs();
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
  vi.restoreAllMocks();
});

function makeTask(
  id: string,
  status: TaskStatus,
  description = `Task ${id}`,
): TrackedTask {
  return { id, description, status, source: "task" };
}

/** A history result with only a Current section — enough to exercise the
 *  active-task auto-scroll without the History / subagent machinery. */
function historyWith(tasks: TrackedTask[]): WorkspaceTaskHistoryResult {
  return {
    current: {
      tasks,
      completedCount: tasks.filter((t) => t.status === "completed").length,
      totalCount: tasks.length,
    },
    sessions: [],
    siblings: [],
    subagents: [],
    historyRunCount: 0,
    totalBadgeCount: tasks.length,
    loading: false,
  };
}

/** Dispatch a manual scroll gesture inside the list. A `keydown` bubbles to
 *  the scroll container's listener and is never produced by `scrollIntoView`,
 *  so it is the cleanest way to simulate the user taking scroll control. */
function dispatchManualScroll(container: HTMLElement) {
  const surface = container.querySelector("[aria-label='Current tasks']");
  surface?.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }),
  );
}

function jumpToCurrentPill(container: HTMLElement): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(
    "button[aria-label='Jump to current task']",
  );
}

function taskHistory(): WorkspaceTaskHistoryResult {
  return {
    current: {
      tasks: [
        {
          id: "current-1",
          description: "Ship the current fix",
          status: "in_progress",
          source: "todo",
        },
      ],
      completedCount: 0,
      totalCount: 1,
    },
    sessions: [
      {
        session: {
          id: "session-1",
          workspace_id: "ws-1",
          session_id: "claude-session-1",
          name: "Previous run",
          name_edited: false,
          turn_count: 3,
          sort_order: 0,
          status: "Archived",
          created_at: "2026-05-12T00:00:00Z",
          archived_at: "2026-05-12T01:00:00Z",
          cli_invocation: null,
          agent_status: "Idle",
          needs_attention: false,
          attention_kind: null,
        },
        runs: [
          {
            id: "run-1",
            sequence: 1,
            tasks: [
              {
                id: "old-1",
                description: "Preserve old checklist",
                status: "completed",
                source: "todo",
              },
            ],
            completedCount: 1,
            totalCount: 1,
          },
        ],
      },
    ],
    siblings: [],
    subagents: [],
    historyRunCount: 1,
    totalBadgeCount: 2,
    loading: false,
  };
}

describe("TaskList", () => {
  it("renders current tasks and collapsed session history", async () => {
    const container = await render(<TaskList taskHistory={taskHistory()} />);

    expect(container.textContent).toContain("Current");
    expect(container.textContent).toContain("Ship the current fix");
    expect(container.textContent).toContain("History");
    expect(container.textContent).toContain("Previous run");
    expect(container.textContent).toContain("Archived");
    expect(container.textContent).toContain("Run 1");
    expect(container.textContent).not.toContain("Preserve old checklist");
  });

  it("renders subagent buckets under their agent label", async () => {
    const history = taskHistory();
    history.subagents = [
      {
        id: "toolu-parent-A",
        label: "Agent A: build pagination",
        tasks: [
          {
            id: "9",
            description: "Add pagination to /api/sessions",
            status: "completed",
            source: "task",
          },
          {
            id: "11",
            description: "Fix Opus pricing tier",
            status: "in_progress",
            source: "task",
          },
        ],
        completedCount: 1,
        totalCount: 2,
        status: "running",
      },
    ];
    const container = await render(<TaskList taskHistory={history} />);
    expect(container.textContent).toContain("Agent A: build pagination");
    expect(container.textContent).toContain("Add pagination to /api/sessions");
    expect(container.textContent).toContain("Fix Opus pricing tier");
    expect(container.textContent).toContain("1/2");
  });

  it("renders a live sibling-session lane with its session name and tasks", async () => {
    const history = taskHistory();
    history.siblings = [
      {
        session: {
          id: "sib-1",
          workspace_id: "ws-1",
          session_id: null,
          name: "alpha",
          name_edited: false,
          turn_count: 0,
          sort_order: 1,
          status: "Active",
          created_at: "2026-05-15T00:00:00Z",
          archived_at: null,
          cli_invocation: null,
          agent_status: "Running",
          needs_attention: false,
          attention_kind: null,
        },
        current: {
          tasks: [
            {
              id: "alpha-1",
              description: "Implement endpoint",
              status: "in_progress",
              source: "task",
            },
          ],
          completedCount: 0,
          totalCount: 1,
        },
        subagents: [],
      },
    ];
    const container = await render(<TaskList taskHistory={history} />);
    expect(container.textContent).toContain("alpha");
    expect(container.textContent).toContain("Implement endpoint");
    // Sibling lane must NOT be folded under "History" while live.
    const siblingSection = container.querySelector(
      "[aria-label='Sibling session: alpha']",
    );
    expect(siblingSection).not.toBeNull();
  });

  it("expands a historical run to show its preserved tasks", async () => {
    const container = await render(<TaskList taskHistory={taskHistory()} />);
    const runButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Run 1"),
    ) as HTMLButtonElement;

    await act(async () => {
      runButton.click();
    });

    expect(container.textContent).toContain("Preserve old checklist");
  });

  it("renders Codex plan explanations for current and historical runs", async () => {
    const history = taskHistory();
    history.current = {
      explanation: "Working through the issue in order.",
      tasks: [
        {
          id: "plan-1",
          description: "Patch the bridge",
          status: "in_progress",
          source: "plan",
        },
      ],
      completedCount: 0,
      totalCount: 1,
    };
    history.sessions[0].runs[0] = {
      ...history.sessions[0].runs[0],
      explanation: "Initial plan snapshot.",
      tasks: [
        {
          id: "plan-old-1",
          description: "Read the issue",
          status: "completed",
          source: "plan",
        },
      ],
    };

    const container = await render(<TaskList taskHistory={history} />);
    expect(container.textContent).toContain(
      "Working through the issue in order.",
    );

    const runButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Run 1"),
    ) as HTMLButtonElement;
    await act(async () => {
      runButton.click();
    });

    expect(container.textContent).toContain("Initial plan snapshot.");
  });

  it("scrolls the active task into view when the active task changes", async () => {
    const { rerender } = await renderTaskList(
      historyWith([
        makeTask("t1", "in_progress"),
        makeTask("t2", "pending"),
      ]),
    );
    // Isolate the transition from the initial mount auto-scroll.
    scrollIntoView.mockClear();

    // t1 completes, t2 becomes in_progress → the active task changes.
    await rerender(
      historyWith([
        makeTask("t1", "completed"),
        makeTask("t2", "in_progress"),
      ]),
    );

    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("stops auto-scrolling once the user scrolls the list manually", async () => {
    const { container, rerender } = await renderTaskList(
      historyWith([
        makeTask("t1", "in_progress"),
        makeTask("t2", "pending"),
      ]),
    );
    scrollIntoView.mockClear();

    // The user takes scroll control.
    await act(async () => {
      dispatchManualScroll(container);
    });

    // A task transition arrives — auto-follow must stay yielded.
    await rerender(
      historyWith([
        makeTask("t1", "completed"),
        makeTask("t2", "in_progress"),
      ]),
    );

    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("shows a 'Jump to current' pill after a manual scroll and hides it on click", async () => {
    const { container } = await renderTaskList(
      historyWith([
        makeTask("t1", "in_progress"),
        makeTask("t2", "pending"),
      ]),
    );
    // While auto-follow is armed the active row is kept in view — no pill.
    expect(jumpToCurrentPill(container)).toBeNull();

    // User scrolls away → active row off-screen → pill appears.
    await act(async () => {
      dispatchManualScroll(container);
    });
    const pill = jumpToCurrentPill(container);
    expect(pill).not.toBeNull();

    // Clicking it re-arms auto-follow, scrolls back, and dismisses the pill.
    scrollIntoView.mockClear();
    await act(async () => {
      pill!.click();
    });
    expect(scrollIntoView).toHaveBeenCalled();
    expect(jumpToCurrentPill(container)).toBeNull();
  });
});
