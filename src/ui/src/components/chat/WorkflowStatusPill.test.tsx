// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAppStore } from "../../stores/useAppStore";
import type { CompletedTurn, ToolActivity } from "../../stores/useAppStore";
import type { WorkflowProgressEntry } from "../../types/workflow";
import { WORKFLOW_CARD_ANCHOR_ATTR } from "./workflowAnchor";
import { WorkflowStatusPill } from "./WorkflowStatusPill";

const SESSION = "session-1";

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

async function render(node: ReactNode): Promise<HTMLElement> {
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

beforeEach(() => {
  useAppStore.setState({ toolActivities: {}, completedTurns: {} });
});

afterEach(async () => {
  await act(async () => {
    for (const root of mountedRoots.splice(0)) root.unmount();
  });
  for (const container of mountedContainers.splice(0)) container.remove();
});

function tree(done: number, total: number): WorkflowProgressEntry[] {
  const entries: WorkflowProgressEntry[] = [
    { type: "workflow_phase", index: 1, title: "Review" },
  ];
  for (let i = 0; i < total; i++) {
    entries.push({
      type: "workflow_agent",
      index: i + 1,
      label: `agent-${i + 1}`,
      state: i < done ? "done" : "progress",
      phaseTitle: "Review",
    });
  }
  return entries;
}

function workflowActivity(
  toolUseId = "toolu_wf1",
  overrides: Partial<ToolActivity> = {},
): ToolActivity {
  return {
    toolUseId,
    toolName: "Workflow",
    inputJson: JSON.stringify({
      script: "export const meta = { name: 'review-changes' }",
    }),
    resultText: "Workflow launched in background. Task ID: w4stpeffj",
    collapsed: false,
    summary: "review-changes",
    agentStatus: "running",
    workflowProgress: tree(1, 3),
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

describe("WorkflowStatusPill", () => {
  it("renders nothing when no workflow is running", async () => {
    const container = await render(<WorkflowStatusPill sessionId={SESSION} />);
    expect(container.textContent).toBe("");
  });

  it("shows name, phase, and agent counts for a live workflow", async () => {
    useAppStore.setState({
      toolActivities: { [SESSION]: [workflowActivity()] },
    });
    const container = await render(<WorkflowStatusPill sessionId={SESSION} />);
    const text = container.textContent ?? "";
    expect(text).toContain("review-changes");
    expect(text).toContain("Review");
    expect(text).toContain("1/3");
  });

  // The reason the pill exists: a workflow's launching turn ends within
  // seconds, so for nearly the whole run the activity lives in
  // `completedTurns`, not `toolActivities`.
  it("shows a workflow whose launching turn has already ended", async () => {
    useAppStore.setState({
      completedTurns: { [SESSION]: [turn("turn-1", [workflowActivity()])] },
    });
    const container = await render(<WorkflowStatusPill sessionId={SESSION} />);
    expect(container.textContent).toContain("review-changes");
  });

  it("hides once the run reaches a terminal status", async () => {
    useAppStore.setState({
      completedTurns: {
        [SESSION]: [
          turn("turn-1", [
            workflowActivity("toolu_wf1", { agentStatus: "completed" }),
          ]),
        ],
      },
    });
    const container = await render(<WorkflowStatusPill sessionId={SESSION} />);
    expect(container.textContent).toBe("");
  });

  // The regression this file exists to pin. `"stopped"` is what the CLI's
  // `task_notification` reports for a *terminated* run — its status enum is
  // exactly `["completed", "failed", "stopped"]` — but the terminal set
  // here was hand-written and omitted it, so killing a workflow left its
  // pill above the composer for the rest of the session. Worse, the status
  // is persisted, so it came back on every reload.
  it.each(["stopped", "failed", "completed", "killed"])(
    "hides a run that ended with status %s",
    async (agentStatus) => {
      useAppStore.setState({
        completedTurns: {
          [SESSION]: [
            turn("turn-1", [workflowActivity("toolu_wf1", { agentStatus })]),
          ],
        },
      });
      const container = await render(<WorkflowStatusPill sessionId={SESSION} />);
      expect(container.textContent).toBe("");
    },
  );

  // Case-insensitive, so an upper/mixed-case value from a future CLI build
  // degrades to "finished" rather than to a pill that never leaves.
  it("hides a run whose terminal status is differently cased", async () => {
    useAppStore.setState({
      completedTurns: {
        [SESSION]: [
          turn("turn-1", [
            workflowActivity("toolu_wf1", { agentStatus: "Stopped" }),
          ]),
        ],
      },
    });
    const container = await render(<WorkflowStatusPill sessionId={SESSION} />);
    expect(container.textContent).toBe("");
  });

  // A workflow checkpointed before its first `task_progress` tick has no
  // status yet and is genuinely still starting — absence must NOT read as
  // an ending, or a just-launched run would never show a pill at all.
  it("still shows a run that has not reported a status yet", async () => {
    useAppStore.setState({
      toolActivities: {
        [SESSION]: [
          workflowActivity("toolu_wf1", {
            agentStatus: undefined,
            workflowProgress: undefined,
          }),
        ],
      },
    });
    const container = await render(<WorkflowStatusPill sessionId={SESSION} />);
    expect(container.textContent).toContain("review-changes");
  });

  it("does not double-count a workflow present in both lanes", async () => {
    useAppStore.setState({
      toolActivities: { [SESSION]: [workflowActivity()] },
      completedTurns: { [SESSION]: [turn("turn-1", [workflowActivity()])] },
    });
    const container = await render(<WorkflowStatusPill sessionId={SESSION} />);
    expect(container.querySelectorAll("button")).toHaveLength(1);
  });

  it("renders one pill per concurrent workflow", async () => {
    useAppStore.setState({
      toolActivities: {
        [SESSION]: [
          workflowActivity("toolu_wf1"),
          workflowActivity("toolu_wf2", {
            inputJson: JSON.stringify({ name: "second-flow" }),
          }),
        ],
      },
    });
    const container = await render(<WorkflowStatusPill sessionId={SESSION} />);
    expect(container.querySelectorAll("button")).toHaveLength(2);
    expect(container.textContent).toContain("second-flow");
  });

  it("reports a starting run that has no agents yet", async () => {
    useAppStore.setState({
      toolActivities: {
        [SESSION]: [workflowActivity("toolu_wf1", { workflowProgress: undefined })],
      },
    });
    const container = await render(<WorkflowStatusPill sessionId={SESSION} />);
    expect(container.textContent).toContain("starting");
  });

  describe("accessible name", () => {
    // The visual counts string is shorthand tuned for the pill's width;
    // reusing it verbatim produced "starting agents complete" and spoke
    // "1/3" as a fraction.
    it("spells out progress rather than reusing the visual shorthand", async () => {
      useAppStore.setState({
        toolActivities: { [SESSION]: [workflowActivity()] },
      });
      const container = await render(<WorkflowStatusPill sessionId={SESSION} />);
      const label = container.querySelector("button")?.getAttribute("aria-label");
      expect(label).toBe(
        "Workflow review-changes, 1 of 3 agents complete. Jump to details.",
      );
    });

    it("reads naturally before any agent has been reported", async () => {
      useAppStore.setState({
        toolActivities: {
          [SESSION]: [
            workflowActivity("toolu_wf1", { workflowProgress: undefined }),
          ],
        },
      });
      const container = await render(<WorkflowStatusPill sessionId={SESSION} />);
      const label = container.querySelector("button")?.getAttribute("aria-label");
      expect(label).toBe("Workflow review-changes, starting. Jump to details.");
      expect(label).not.toContain("agents complete");
    });

    // `aria-label` replaces the button's accessible name, so the visual
    // failure badge is not announced unless it's folded into the label.
    it("includes the failure count", async () => {
      useAppStore.setState({
        toolActivities: {
          [SESSION]: [
            workflowActivity("toolu_wf1", {
              workflowProgress: [
                { type: "workflow_agent", index: 1, label: "a", state: "error" },
                { type: "workflow_agent", index: 2, label: "b", state: "done" },
              ],
            }),
          ],
        },
      });
      const container = await render(<WorkflowStatusPill sessionId={SESSION} />);
      expect(
        container.querySelector("button")?.getAttribute("aria-label"),
      ).toBe(
        "Workflow review-changes, 2 of 2 agents complete, 1 failed. Jump to details.",
      );
    });
  });

  it("scrolls the matching card into view when clicked", async () => {
    useAppStore.setState({
      toolActivities: { [SESSION]: [workflowActivity()] },
    });

    const card = document.createElement("div");
    card.setAttribute(WORKFLOW_CARD_ANCHOR_ATTR, "toolu_wf1");
    const scrollIntoView = vi.fn();
    card.scrollIntoView = scrollIntoView;
    document.body.appendChild(card);

    const container = await render(<WorkflowStatusPill sessionId={SESSION} />);
    await act(async () => {
      container.querySelector("button")?.click();
    });

    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    });
    card.remove();
  });

  it("surfaces failed agents", async () => {
    useAppStore.setState({
      toolActivities: {
        [SESSION]: [
          workflowActivity("toolu_wf1", {
            workflowProgress: [
              {
                type: "workflow_agent",
                index: 1,
                label: "a",
                state: "error",
                error: "boom",
              },
              { type: "workflow_agent", index: 2, label: "b", state: "progress" },
            ],
          }),
        ],
      },
    });
    const container = await render(<WorkflowStatusPill sessionId={SESSION} />);
    expect(container.textContent).toContain("1 failed");
  });
});
