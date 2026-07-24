// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ToolActivity } from "../../stores/useAppStore";
import type { WorkflowProgressEntry } from "../../types/workflow";
import { WorkflowCard } from "./WorkflowCard";

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

afterEach(async () => {
  await act(async () => {
    for (const root of mountedRoots.splice(0)) root.unmount();
  });
  for (const container of mountedContainers.splice(0)) container.remove();
  vi.useRealTimers();
});

const SCRIPT = `export const meta = {
  name: 'review-changes',
  description: 'Review the diff across dimensions',
  phases: [{ title: 'Review' }, { title: 'Verify' }],
}
phase('Review')`;

function makeActivity(overrides: Partial<ToolActivity> = {}): ToolActivity {
  return {
    toolUseId: "toolu_wf1",
    toolName: "Workflow",
    inputJson: JSON.stringify({ script: SCRIPT }),
    // A workflow's tool_result lands at LAUNCH, not completion — the real
    // text the CLI returns. Several assertions below depend on the card
    // not treating this as "finished".
    resultText: "Workflow launched in background. Task ID: w4stpeffj",
    collapsed: false,
    summary: "review-changes",
    agentStatus: "running",
    ...overrides,
  };
}

function agent(
  index: number,
  state: string,
  extra: Record<string, unknown> = {},
): WorkflowProgressEntry {
  return {
    type: "workflow_agent",
    index,
    label: `agent-${index}`,
    state,
    ...extra,
  } as WorkflowProgressEntry;
}

describe("WorkflowCard", () => {
  it("shows the meta name and description instead of the script", async () => {
    const container = await render(<WorkflowCard activity={makeActivity()} />);
    expect(container.textContent).toContain("review-changes");
    expect(container.textContent).toContain("Review the diff across dimensions");
    // The script is behind a disclosure, but must never be the headline.
    expect(container.querySelector("[class*=name]")?.textContent).toBe(
      "review-changes",
    );
  });

  it("renders agents grouped under their phase headings", async () => {
    const container = await render(
      <WorkflowCard
        activity={makeActivity({
          workflowProgress: [
            { type: "workflow_phase", index: 1, title: "Review" },
            { type: "workflow_phase", index: 2, title: "Verify" },
            agent(1, "done", { phaseTitle: "Review", label: "review:bugs" }),
            agent(2, "progress", { phaseTitle: "Verify", label: "verify:bugs" }),
          ],
        })}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("Review");
    expect(text).toContain("Verify");
    expect(text).toContain("review:bugs");
    expect(text).toContain("verify:bugs");
    expect(text).toContain("1/2 agents");
  });

  // Under a pipeline, a later phase's agent can be reported before an
  // earlier phase's slow agent — so first-seen order would render Verify
  // above Review. Sections must follow declaration order from the
  // `workflow_phase` entries instead.
  it("orders phase sections by declaration, not by first-seen agent", async () => {
    const container = await render(
      <WorkflowCard
        activity={makeActivity({
          workflowProgress: [
            { type: "workflow_phase", index: 1, title: "Review" },
            { type: "workflow_phase", index: 2, title: "Verify" },
            // Verify's agent arrives first; Review's slow agent lands later.
            agent(2, "done", { phaseTitle: "Verify", label: "verify:bugs" }),
            agent(1, "progress", { phaseTitle: "Review", label: "review:bugs" }),
          ],
        })}
      />,
    );
    const headings = [
      ...container.querySelectorAll("[class*=phaseTitle]"),
    ].map((el) => el.textContent);
    expect(headings).toEqual(["Review", "Verify"]);
  });

  it("appends an undeclared phase after the declared ones", async () => {
    const container = await render(
      <WorkflowCard
        activity={makeActivity({
          workflowProgress: [
            { type: "workflow_phase", index: 1, title: "Review" },
            agent(1, "progress", { phaseTitle: "Improvised", label: "a" }),
            agent(2, "done", { phaseTitle: "Review", label: "b" }),
          ],
        })}
      />,
    );
    const headings = [
      ...container.querySelectorAll("[class*=phaseTitle]"),
    ].map((el) => el.textContent);
    expect(headings).toEqual(["Review", "Improvised"]);
  });

  it("reports progress on the rail with accessible bounds", async () => {
    const container = await render(
      <WorkflowCard
        activity={makeActivity({
          workflowProgress: [agent(1, "done"), agent(2, "done"), agent(3, "queued")],
        })}
      />,
    );
    const rail = container.querySelector("[role=progressbar]");
    expect(rail?.getAttribute("aria-valuenow")).toBe("2");
    expect(rail?.getAttribute("aria-valuemax")).toBe("3");
  });

  // Regression guard for the trap this component sits on: every other tool
  // treats a non-empty resultText as "finished", but a workflow's result
  // arrives seconds after launch while the run continues for minutes.
  it("does not treat the launch tool_result as completion", async () => {
    const container = await render(
      <WorkflowCard
        activity={makeActivity({
          agentStatus: "running",
          workflowProgress: [agent(1, "progress")],
        })}
      />,
    );
    expect(container.textContent).not.toContain("No agent activity");
    // Rail must not be in its completed styling while the run is live.
    const fill = container.querySelector("[role=progressbar] > div");
    expect(fill?.className).not.toContain("railFillDone");
  });

  it("marks the run complete once a terminal task status arrives", async () => {
    const container = await render(
      <WorkflowCard
        activity={makeActivity({
          agentStatus: "completed",
          workflowProgress: [agent(1, "done"), agent(2, "done")],
        })}
      />,
    );
    const fill = container.querySelector("[role=progressbar] > div");
    expect(fill?.className).toContain("railFillDone");
    expect(container.textContent).toContain("2/2 agents");
  });

  it("surfaces a failed agent's error and counts it", async () => {
    const container = await render(
      <WorkflowCard
        activity={makeActivity({
          agentStatus: "completed",
          workflowProgress: [
            agent(1, "done"),
            agent(2, "error", { error: "schema validation failed" }),
          ],
        })}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("1 failed");
    expect(text).toContain("schema validation failed");
  });

  it("collapses the agent tree but keeps the header readable", async () => {
    const container = await render(
      <WorkflowCard
        activity={makeActivity({
          workflowProgress: [agent(1, "progress", { label: "review:bugs" })],
        })}
        collapsed
        onToggle={() => {}}
      />,
    );
    expect(container.textContent).toContain("review-changes");
    expect(container.textContent).toContain("0/1 agents");
    expect(container.textContent).not.toContain("review:bugs");
  });

  // The CSS scopes cursor/hover/focus affordances to `[role="button"]`, so
  // the role must be present exactly when the header is really clickable —
  // otherwise the inline card advertises a click that does nothing.
  it("marks the header interactive only when a toggle is wired", async () => {
    const collapsible = await render(
      <WorkflowCard activity={makeActivity()} collapsed={false} onToggle={() => {}} />,
    );
    expect(
      collapsible.querySelector("[class*=header]")?.getAttribute("role"),
    ).toBe("button");

    const inline = await render(<WorkflowCard activity={makeActivity()} inline />);
    expect(
      inline.querySelector("[class*=header]")?.getAttribute("role"),
    ).toBeNull();
  });

  it("shows a starting state before the first progress tick", async () => {
    const container = await render(
      <WorkflowCard activity={makeActivity({ workflowProgress: undefined })} />,
    );
    expect(container.textContent).toContain("Starting workflow");
    expect(container.querySelector("[role=progressbar]")).toBeNull();
  });

  it("keeps the script reachable behind a disclosure", async () => {
    const container = await render(<WorkflowCard activity={makeActivity()} />);
    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    expect(details?.hasAttribute("open")).toBe(false);
    expect(details?.textContent).toContain("export const meta");
    expect(details?.querySelector("summary")?.textContent).toContain("6 lines");
  });

  it("omits the script disclosure for a workflow launched by name", async () => {
    const container = await render(
      <WorkflowCard
        activity={makeActivity({
          inputJson: JSON.stringify({ name: "saved-review" }),
        })}
      />,
    );
    expect(container.querySelector("details")).toBeNull();
    expect(container.textContent).toContain("saved-review");
  });

  // A run interrupted by an app restart replays with agents still marked
  // `progress` and a `startedAt` from whenever it happened. Interpolating
  // against the current clock would report days of elapsed work, and would
  // keep climbing on every reload.
  it("shows no fabricated elapsed time for a replayed (non-live) agent", async () => {
    const sixDaysAgo = Date.now() - 6 * 24 * 60 * 60 * 1000;
    const container = await render(
      <WorkflowCard
        activity={makeActivity({
          workflowProgress: [agent(1, "progress", { startedAt: sixDaysAgo })],
        })}
      />,
    );
    expect(container.textContent).not.toMatch(/\d+[dhm]/);
  });

  it("still shows a recorded duration when replayed", async () => {
    const container = await render(
      <WorkflowCard
        activity={makeActivity({
          agentStatus: "completed",
          workflowProgress: [agent(1, "done", { durationMs: 180_027 })],
        })}
      />,
    );
    expect(container.textContent).toContain("3m 0s");
  });

  it("does not run the clock for a replayed (non-live) card", async () => {
    vi.useFakeTimers();
    const container = await render(
      <WorkflowCard
        activity={makeActivity({
          workflowProgress: [agent(1, "progress", { startedAt: Date.now() })],
        })}
      />,
    );
    const before = container.textContent ?? "";
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(container.textContent).toBe(before);
  });

  it("interpolates elapsed time for a live in-flight agent", async () => {
    const container = await render(
      <WorkflowCard
        live
        activity={makeActivity({
          workflowProgress: [
            agent(1, "progress", { startedAt: Date.now() - 42_000 }),
          ],
        })}
      />,
    );
    expect(container.textContent).toContain("42s");
  });
});
