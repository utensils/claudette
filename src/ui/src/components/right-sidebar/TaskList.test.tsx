// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceTaskHistoryResult } from "../../hooks/useWorkspaceTaskHistory";
import { TaskList } from "./TaskList";

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

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
});
