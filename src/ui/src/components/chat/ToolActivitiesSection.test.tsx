// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type { ToolActivity } from "../../stores/useAppStore";
import { AgentToolCallGroup } from "./AgentToolCallGroup";
import { ToolActivitiesSection } from "./ToolActivitiesSection";

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

function activity(
  toolName: string,
  overrides: Partial<ToolActivity> = {},
): ToolActivity {
  return {
    toolUseId: `${toolName}-1`,
    toolName,
    inputJson: "{}",
    resultText: "done",
    collapsed: true,
    summary: "",
    ...overrides,
  };
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

describe("AgentToolCallGroup", () => {
  it("colors only the Agent tool name and leaves the agent description in summary styling", async () => {
    const container = await render(
      <AgentToolCallGroup
        activity={activity("Agent", {
          summary: "AgentRandom",
          agentDescription: "AgentRandom",
        })}
        searchQuery=""
      />,
    );

    const coloredName = container.querySelector("span[style]");
    expect(coloredName?.textContent).toBe("Agent");
    expect(coloredName?.getAttribute("style") ?? "").toContain("color:");

    const summary = Array.from(container.querySelectorAll("span")).find(
      (span) => span.textContent === "AgentRandom",
    );
    expect(summary).toBeTruthy();
    expect(summary?.getAttribute("style")).toBeNull();
  });
});

describe("ToolActivitiesSection", () => {
  it("expands grouped live calls while running and collapses when the group is done", async () => {
    const container = await render(
      <ToolActivitiesSection
        sessionId="session-1"
        toolDisplayMode="grouped"
        searchQuery=""
        activities={[
          activity("Bash", { resultText: "" }),
          activity("Read", { resultText: "done" }),
        ]}
      />,
    );

    expect(container.textContent).toContain("2 tool calls");
    expect(container.textContent).toContain("Bash");
    expect(container.textContent).toContain("Read");

    await act(async () => {
      mountedRoots[0].render(
        <ToolActivitiesSection
          sessionId="session-1"
          toolDisplayMode="grouped"
          searchQuery=""
          activities={[
            activity("Bash", { resultText: "done" }),
            activity("Read", { resultText: "done" }),
          ]}
        />,
      );
    });

    expect(container.textContent).toContain("2 tool calls");
    expect(container.textContent).not.toContain("Bash");
    expect(container.textContent).not.toContain("Read");
  });

  it("renders a chevron + clickable header on grouped running activities", async () => {
    // Pin the chevron decoration that PR 696 dropped. Without it,
    // users had no affordance for expanding/collapsing the live tool
    // group while the agent was running.
    const container = await render(
      <ToolActivitiesSection
        sessionId="session-1"
        toolDisplayMode="grouped"
        searchQuery=""
        activities={[
          activity("Bash", { resultText: "" }),
          activity("Read", { resultText: "" }),
        ]}
      />,
    );

    const header = container.querySelector('[role="button"][aria-expanded]');
    expect(header).toBeTruthy();
    expect(header?.getAttribute("aria-expanded")).toBe("true");
    // Chevron is the first child of the header — open glyph while
    // expanded, closed glyph when collapsed.
    expect(header?.textContent).toMatch(/^⌄/);
  });

  it("lets the user collapse a still-running group via header click", async () => {
    const runningActivities = [
      activity("Bash", { resultText: "" }),
      activity("Read", { resultText: "" }),
    ];
    const container = await render(
      <ToolActivitiesSection
        sessionId="session-1"
        toolDisplayMode="grouped"
        searchQuery=""
        activities={runningActivities}
      />,
    );

    expect(container.textContent).toContain("Bash");
    expect(container.textContent).toContain("Read");

    const header = container.querySelector(
      '[role="button"][aria-expanded]',
    ) as HTMLElement;
    expect(header).toBeTruthy();

    await act(async () => {
      header.click();
    });

    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(header.textContent).toMatch(/^›/);
    expect(container.textContent).not.toContain("Bash");
    expect(container.textContent).not.toContain("Read");
  });

  it("lets the user expand a finished group via header click", async () => {
    // Default for a finished group is collapsed (matches post-PR-696
    // default). The user-click override should re-open it.
    const container = await render(
      <ToolActivitiesSection
        sessionId="session-1"
        toolDisplayMode="grouped"
        searchQuery=""
        activities={[
          activity("Bash", { resultText: "done" }),
          activity("Read", { resultText: "done" }),
        ]}
      />,
    );

    // Sanity: the "2 tool calls" header is visible but children aren't.
    expect(container.textContent).toContain("2 tool calls");
    expect(container.textContent).not.toContain("Bash");

    const header = container.querySelector(
      '[role="button"][aria-expanded]',
    ) as HTMLElement;
    expect(header.getAttribute("aria-expanded")).toBe("false");

    await act(async () => {
      header.click();
    });

    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("Bash");
    expect(container.textContent).toContain("Read");
  });

  it("force-expands a user-collapsed group when a search match lands inside", async () => {
    // Regression: prior to this fix, a user-collapsed group with
    // `userOverride === false` won the precedence check and the
    // search-match-driven expand never fired — search would tick up
    // its hit counter but the matching activity was hidden.
    //
    // Setup: a *running* group (defaults to expanded), user clicks
    // once to collapse it. Then a search query that matches the
    // group's content must override the user's collapse and
    // re-expand.
    const runningActivity = activity("Bash", {
      resultText: "",
      summary: "secret-token-payload",
    });
    const container = await render(
      <ToolActivitiesSection
        sessionId="session-1"
        toolDisplayMode="grouped"
        searchQuery=""
        activities={[runningActivity]}
      />,
    );
    const header = container.querySelector(
      '[role="button"][aria-expanded]',
    ) as HTMLElement;
    expect(header).toBeTruthy();
    // Sanity: running groups default to expanded.
    expect(header.getAttribute("aria-expanded")).toBe("true");
    // User explicitly collapses the running group.
    await act(async () => {
      header.click();
    });
    expect(header.getAttribute("aria-expanded")).toBe("false");

    await act(async () => {
      mountedRoots[0].render(
        <ToolActivitiesSection
          sessionId="session-1"
          toolDisplayMode="grouped"
          searchQuery="secret-token"
          activities={[runningActivity]}
        />,
      );
    });

    const headerAfter = container.querySelector(
      '[role="button"][aria-expanded]',
    ) as HTMLElement;
    // Search match wins: the user-collapsed override is overridden in
    // turn so the matching activity is visible.
    expect(headerAfter.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("Bash");
  });

  it("persists collapse state via the chatSlice so it survives running→completed transition", async () => {
    // The unified slice key (`tools:${first toolUseId}`) is shared
    // with `MessagesWithTurns`'s `TurnSummary` rendering, so a user's
    // explicit collapse on a running group remains in effect when the
    // turn ends and the same activities migrate into a CompletedTurn.
    // Pin the write-through here; the read path is covered by the
    // useAppStore.collapsedToolGroups.test.ts slice tests.
    const { useAppStore } = await import("../../stores/useAppStore");
    useAppStore.setState({ collapsedToolGroupsBySession: {} });

    const runningActivities = [
      activity("Bash", { toolUseId: "stable-1", resultText: "" }),
    ];
    const container = await render(
      <ToolActivitiesSection
        sessionId="session-xform"
        toolDisplayMode="grouped"
        searchQuery=""
        activities={runningActivities}
      />,
    );
    const header = container.querySelector(
      '[role="button"][aria-expanded]',
    ) as HTMLElement;
    expect(header.getAttribute("aria-expanded")).toBe("true");

    await act(async () => {
      header.click();
    });

    expect(header.getAttribute("aria-expanded")).toBe("false");
    // The slice now holds the user's explicit collapse for this
    // group's stable key — `MessagesWithTurns` will pick this up after
    // the turn ends because it computes the same key.
    expect(
      useAppStore.getState().collapsedToolGroupsBySession["session-xform"]?.[
        "tools:stable-1"
      ],
    ).toBe(true);
  });

  it("preserves the user override across appended tool activities", async () => {
    // Two tools running, user collapses; a third tool joins the same
    // direct-tools run. The component is keyed by the first activity's
    // toolUseId so React keeps the same instance and the user's
    // collapse decision sticks.
    const container = await render(
      <ToolActivitiesSection
        sessionId="session-1"
        toolDisplayMode="grouped"
        searchQuery=""
        activities={[
          activity("Bash", { toolUseId: "a", resultText: "" }),
          activity("Read", { toolUseId: "b", resultText: "" }),
        ]}
      />,
    );
    const header = container.querySelector(
      '[role="button"][aria-expanded]',
    ) as HTMLElement;

    await act(async () => {
      header.click();
    });
    expect(header.getAttribute("aria-expanded")).toBe("false");

    await act(async () => {
      mountedRoots[0].render(
        <ToolActivitiesSection
          sessionId="session-1"
          toolDisplayMode="grouped"
          searchQuery=""
          activities={[
            activity("Bash", { toolUseId: "a", resultText: "" }),
            activity("Read", { toolUseId: "b", resultText: "" }),
            activity("Edit", { toolUseId: "c", resultText: "" }),
          ]}
        />,
      );
    });

    const headerAfter = container.querySelector(
      '[role="button"][aria-expanded]',
    ) as HTMLElement;
    expect(headerAfter.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).toContain("3 tool calls");
    expect(container.textContent).not.toContain("Edit");
  });
});
