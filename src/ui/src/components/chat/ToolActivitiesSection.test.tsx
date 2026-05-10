// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../stores/useAppStore";

// Stub the Shiki highlight worker so EditChangeSummary's highlightCode calls
// don't crash with "Worker is not defined" in the happy-dom environment.
vi.mock("../../workers/highlight.worker?worker", () => ({
  default: class FakeWorker {
    postMessage(): void {}
    addEventListener(): void {}
    terminate(): void {}
  },
}));

import type { CompletedTurn, ToolActivity } from "../../stores/useAppStore";
import { AgentToolCallGroup } from "./AgentToolCallGroup";
import styles from "./ChatPanel.module.css";
import { ToolActivitiesSection } from "./ToolActivitiesSection";
import { TurnSummary } from "./TurnSummary";

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

function completedTurn(activities: ToolActivity[]): CompletedTurn {
  return {
    id: "turn-1",
    activities,
    messageCount: 1,
    collapsed: true,
    afterMessageIndex: 2,
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

beforeEach(() => {
  // Reset cross-test slice state. Several tests in this file click
  // chevrons that write to `collapsedToolGroupsBySession` keyed by
  // the activity helper's stable `toolUseId` (e.g. `tools:Bash-1`),
  // and stale overrides bled into later tests' default-collapsed
  // assumptions before this hook existed.
  useAppStore.setState({
    collapsedToolGroupsBySession: {},
    expandedToolUseIds: {},
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

  it("uses the unbordered inline variant when grouping is disabled", async () => {
    const container = await render(
      <AgentToolCallGroup
        activity={activity("Agent", { agentDescription: "Audit UI" })}
        searchQuery=""
        inline
      />,
    );

    expect(
      container.querySelector(`.${styles.agentToolGroupInline}`),
    ).toBeTruthy();
    expect(container.querySelector(`.${styles.agentToolGroup}`)).toBeNull();
  });

  it("ignores collapsed/onToggle props when rendering inline (legacy contract)", async () => {
    // Inline mode must not grow a chevron or hide its tool-call list,
    // even if a caller accidentally forwards collapse props. Pinning
    // this protects the "grouping OFF = always expanded" contract that
    // users opt into when they disable the setting.
    const container = await render(
      <AgentToolCallGroup
        activity={activity("Agent", {
          agentDescription: "Audit UI",
          agentToolCalls: [
            {
              toolUseId: "nested-inline-1",
              toolName: "Read",
              agentId: "a",
              status: "completed",
              startedAt: "2026-05-08T00:00:00Z",
            },
          ],
        })}
        searchQuery=""
        inline
        collapsed
        onToggle={() => {}}
      />,
    );

    expect(container.querySelector('[role="button"][aria-expanded]')).toBeNull();
    expect(container.querySelector(`.${styles.toolChevron}`)).toBeNull();
    // Nested tool call still rendered — collapse semantics ignored.
    expect(container.textContent).toContain("Read");
  });

  it("renders nested edit calls as editing rows with churn stats", async () => {
    const container = await render(
      <AgentToolCallGroup
        activity={activity("Agent", {
          agentToolCalls: [
            {
              toolUseId: "edit-1",
              toolName: "Edit",
              agentId: "agent-1",
              input: {
                file_path: "/repo/src/app.ts",
                old_string: "one\ntwo",
                new_string: "one\nthree\nfour",
              },
              status: "completed",
              startedAt: "2026-05-08T00:00:00.000Z",
            },
          ],
        })}
        searchQuery=""
        worktreePath="/repo"
      />,
    );

    expect(container.textContent).toContain("Editing");
    expect(container.textContent).toContain("src/app.ts");
    expect(container.textContent).toContain("+3");
    expect(container.textContent).toContain("-2");
  });
});

describe("ToolActivitiesSection", () => {
  it("renders inline Agent calls without a collapsible summary block", async () => {
    const container = await render(
      <ToolActivitiesSection
        sessionId="session-1"
        toolDisplayMode="inline"
        searchQuery=""
        activities={[
          activity("Agent", {
            agentDescription: "Audit UI",
            agentToolUseCount: 2,
            agentLastToolName: "Read",
            agentToolCalls: [
              {
                toolUseId: "nested-1",
                toolName: "Read",
                agentId: "agent-1",
                status: "completed",
                startedAt: "2026-05-08T00:00:00Z",
              },
            ],
          }),
        ]}
      />,
    );

    expect(container.querySelector('[role="button"][aria-expanded]')).toBeNull();
    expect(
      container.querySelector(`.${styles.agentToolGroupInline}`),
    ).toBeTruthy();
    expect(container.querySelector(`.${styles.agentToolGroup}`)).toBeNull();
    expect(container.textContent).toContain("Agent");
    expect(container.textContent).toContain("Read");
  });

  it("collapses grouped live calls by default — even while still running", async () => {
    // Intentional behavior change: with grouped tool calls on (the
    // default for new users), live tool groups start collapsed
    // regardless of whether any activity is still running. This keeps
    // the chat surface quiet during long runs and removes the visual
    // "pop-closed" jolt that previously fired at turn end.
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
    expect(container.textContent).not.toContain("Bash");
    expect(container.textContent).not.toContain("Read");

    // After the group finishes, it must still be collapsed (no flicker).
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
    // Default-collapsed even while running.
    expect(header?.getAttribute("aria-expanded")).toBe("false");
    // Chevron is the first child of the header — closed glyph while
    // collapsed, open glyph when expanded.
    expect(header?.textContent).toMatch(/^›/);
  });

  it("lets the user expand a still-running group via header click", async () => {
    // After PR 743 flipped the default to collapsed-while-running,
    // the click affordance now opens (instead of closes) a live group.
    // (Bare number, no `#`, mirrors the `PR 696` reference above —
    // the design-token check treats `#NNN` like a 3-digit hex color.)
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

    // Sanity: starts collapsed, child activities not in the DOM.
    expect(container.textContent).not.toContain("Bash");
    expect(container.textContent).not.toContain("Read");

    const header = container.querySelector(
      '[role="button"][aria-expanded]',
    ) as HTMLElement;
    expect(header).toBeTruthy();
    expect(header.getAttribute("aria-expanded")).toBe("false");

    await act(async () => {
      header.click();
    });

    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(header.textContent).toMatch(/^⌄/);
    expect(container.textContent).toContain("Bash");
    expect(container.textContent).toContain("Read");
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

  it("force-expands a default-collapsed group when a search match lands inside", async () => {
    // Regression: a collapsed group must yield to an active search
    // query, otherwise marks land in detached DOM and the search
    // bar's hit counter ticks up while nothing visible changes.
    //
    // After the default-collapsed-while-running change there is no
    // way for the *user* to ever land at a state where override beats
    // search without first manually expanding then re-collapsing — so
    // this test exercises the simpler default-collapsed path. The
    // "user override true" path is structurally identical: same
    // `collapsed` boolean enters the `isExpanded = queryHasMatch ||
    // !collapsed` precedence check.
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
    // Search match wins over the default-collapsed state.
    expect(headerAfter.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("Bash");
  });

  it("persists collapse state via the chatSlice so it survives running→completed transition", async () => {
    // The unified slice key (`tools:${first toolUseId}`) is shared
    // with `MessagesWithTurns`'s `TurnSummary` rendering, so a user's
    // explicit toggle on a running group remains in effect when the
    // turn ends and the same activities migrate into a CompletedTurn.
    // Pin the write-through here; the read path is covered by the
    // useAppStore.collapsedToolGroups.test.ts slice tests.
    //
    // Default is now collapsed-while-running, so the user's first
    // click *expands* the group and the slice records `false` (=
    // expanded). Same write path, different boolean — the round-trip
    // is what matters for the running→completed handoff.
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
    expect(header.getAttribute("aria-expanded")).toBe("false");

    await act(async () => {
      header.click();
    });

    expect(header.getAttribute("aria-expanded")).toBe("true");
    // The slice now holds the user's explicit expand for this group's
    // stable key — `MessagesWithTurns` will pick this up after the
    // turn ends because it computes the same key.
    expect(
      useAppStore.getState().collapsedToolGroupsBySession["session-xform"]?.[
        "tools:stable-1"
      ],
    ).toBe(false);
  });

  it("preserves the user expand override across appended tool activities", async () => {
    // Two tools running, user expands; a third tool joins the same
    // direct-tools run. The component is keyed by the first activity's
    // toolUseId so React keeps the same instance and the user's
    // expand decision sticks despite the new default-collapsed stance.
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

    // Start collapsed by default; click expands.
    expect(header.getAttribute("aria-expanded")).toBe("false");
    await act(async () => {
      header.click();
    });
    expect(header.getAttribute("aria-expanded")).toBe("true");

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
    expect(headerAfter.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("3 tool calls");
    expect(container.textContent).toContain("Edit");
  });

  it("clicking a search-force-expanded tool group persists 'collapse' (not the underlying inverse)", async () => {
    // Regression for a latent bug where `toggle()` flipped the
    // persisted override based on the raw `collapsed` boolean instead
    // of the *visible* state. A search query forces the group open;
    // clicking the header should be interpreted as "hide this", not
    // silently flip the underlying override behind the search and
    // surprise the user when they clear the query.
    const runningActivity = activity("Bash", {
      toolUseId: "search-toggle-1",
      resultText: "",
      summary: "secret-token-payload",
    });
    const container = await render(
      <ToolActivitiesSection
        sessionId="session-search-toggle"
        toolDisplayMode="grouped"
        searchQuery="secret-token"
        activities={[runningActivity]}
      />,
    );

    const header = container.querySelector(
      '[role="button"][aria-expanded]',
    ) as HTMLElement;
    // Search match force-expands the default-collapsed group.
    expect(header.getAttribute("aria-expanded")).toBe("true");

    // User clicks the visible header — intent is "hide this".
    await act(async () => {
      header.click();
    });

    // Slice now records `true` (collapsed) — matching the click intent.
    expect(
      useAppStore.getState().collapsedToolGroupsBySession[
        "session-search-toggle"
      ]?.["tools:search-toggle-1"],
    ).toBe(true);

    // Clearing the search should leave the group collapsed (not
    // unexpectedly springing open as the pre-fix code would have done).
    await act(async () => {
      mountedRoots[0].render(
        <ToolActivitiesSection
          sessionId="session-search-toggle"
          toolDisplayMode="grouped"
          searchQuery=""
          activities={[runningActivity]}
        />,
      );
    });

    const headerAfter = container.querySelector(
      '[role="button"][aria-expanded]',
    ) as HTMLElement;
    expect(headerAfter.getAttribute("aria-expanded")).toBe("false");
  });

  it("collapses live Agent groups by default in grouped mode while keeping progress visible", async () => {
    // Pinning the new live-Agent UX: header label + status / count /
    // latest-tool progress row stays visible while collapsed; only
    // the per-tool-call list is hidden. Agents run for minutes and a
    // fully-hidden live agent would feel dead.
    const { useAppStore } = await import("../../stores/useAppStore");
    useAppStore.setState({ collapsedToolGroupsBySession: {} });

    const container = await render(
      <ToolActivitiesSection
        sessionId="session-1"
        toolDisplayMode="grouped"
        searchQuery=""
        activities={[
          activity("Agent", {
            toolUseId: "agent-1",
            agentDescription: "Audit UI",
            agentStatus: "running",
            agentToolUseCount: 3,
            agentLastToolName: "Read",
            agentToolCalls: [
              {
                toolUseId: "nested-1",
                toolName: "Bash",
                agentId: "a",
                status: "completed",
                startedAt: "2026-05-08T00:00:00Z",
              },
            ],
          }),
        ]}
      />,
    );

    const header = container.querySelector('[role="button"][aria-expanded]');
    expect(header).toBeTruthy();
    expect(header?.getAttribute("aria-expanded")).toBe("false");
    expect(header?.textContent).toMatch(/^›/);
    // Header label + progress row visible while collapsed.
    expect(container.textContent).toContain("Agent");
    expect(container.textContent).toContain("Audit UI");
    expect(container.textContent).toContain("running");
    expect(container.textContent).toContain("3 agent tool calls");
    expect(container.textContent).toContain("latest: Read");
    // Per-tool-call list hidden while collapsed.
    expect(container.textContent).not.toContain("Bash");
  });

  it("expands a live Agent group on header click and reveals nested tool calls", async () => {
    const { useAppStore } = await import("../../stores/useAppStore");
    useAppStore.setState({ collapsedToolGroupsBySession: {} });

    const container = await render(
      <ToolActivitiesSection
        sessionId="session-agent-toggle"
        toolDisplayMode="grouped"
        searchQuery=""
        activities={[
          activity("Agent", {
            toolUseId: "agent-2",
            agentDescription: "Survey UI",
            agentToolCalls: [
              {
                toolUseId: "nested-2",
                toolName: "Read",
                agentId: "a",
                status: "completed",
                startedAt: "2026-05-08T00:00:00Z",
              },
            ],
          }),
        ]}
      />,
    );

    const header = container.querySelector(
      '[role="button"][aria-expanded]',
    ) as HTMLElement;
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("Read");

    await act(async () => {
      header.click();
    });

    expect(header.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("Read");
    // Persisted under the `agent:` key so the user choice survives the
    // running→completed transition into TurnSummary's read.
    expect(
      useAppStore.getState().collapsedToolGroupsBySession[
        "session-agent-toggle"
      ]?.["agent:agent-2"],
    ).toBe(false);
  });

  it("force-expands a default-collapsed live Agent when search matches a nested call", async () => {
    // Regression for the cross-cutting "search must always reach
    // matched DOM" rule applied to the new live Agent collapse.
    // `activityMatchesSearch` walks `agentToolCalls`, so a query that
    // hits a nested call must pop the parent open even though the
    // default is collapsed.
    const agentActivity = activity("Agent", {
      toolUseId: "agent-search-1",
      agentDescription: "Survey UI",
      agentToolCalls: [
        {
          toolUseId: "nested-search-1",
          toolName: "Read",
          agentId: "a",
          status: "completed",
          startedAt: "2026-05-08T00:00:00Z",
          input: { file_path: "/repo/src/secret-token-target.ts" },
        },
      ],
    });
    const container = await render(
      <ToolActivitiesSection
        sessionId="session-search-agent"
        toolDisplayMode="grouped"
        searchQuery=""
        activities={[agentActivity]}
      />,
    );

    const header = container.querySelector(
      '[role="button"][aria-expanded]',
    ) as HTMLElement;
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("Read");

    await act(async () => {
      mountedRoots[0].render(
        <ToolActivitiesSection
          sessionId="session-search-agent"
          toolDisplayMode="grouped"
          searchQuery="secret-token"
          activities={[agentActivity]}
        />,
      );
    });

    const headerAfter = container.querySelector(
      '[role="button"][aria-expanded]',
    ) as HTMLElement;
    expect(headerAfter.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("Read");
  });

  it("clicking a search-force-expanded live Agent persists 'collapse' (matches visible intent)", async () => {
    // Same regression as the tool-group toggle-during-search test, on
    // the agent code path. Without the visible-state fix in
    // `GroupedAgentActivity`, clicking a search-force-expanded agent
    // header silently flips the persisted override (`!collapsed` =
    // `false`, expanded) so the agent springs open the moment the
    // user clears the query.
    const { useAppStore } = await import("../../stores/useAppStore");
    useAppStore.setState({ collapsedToolGroupsBySession: {} });

    const agentActivity = activity("Agent", {
      toolUseId: "agent-search-toggle-1",
      agentDescription: "Survey UI",
      agentToolCalls: [
        {
          toolUseId: "nested-search-toggle-1",
          toolName: "Read",
          agentId: "a",
          status: "completed",
          startedAt: "2026-05-08T00:00:00Z",
          input: { file_path: "/repo/src/secret-token-target.ts" },
        },
      ],
    });
    const container = await render(
      <ToolActivitiesSection
        sessionId="session-agent-search-toggle"
        toolDisplayMode="grouped"
        searchQuery="secret-token"
        activities={[agentActivity]}
      />,
    );

    const header = container.querySelector(
      '[role="button"][aria-expanded]',
    ) as HTMLElement;
    // Search match force-expands the default-collapsed agent.
    expect(header.getAttribute("aria-expanded")).toBe("true");

    // User clicks the visible header — intent is "hide this".
    await act(async () => {
      header.click();
    });

    // Slice records `true` (collapsed), matching the click intent.
    expect(
      useAppStore.getState().collapsedToolGroupsBySession[
        "session-agent-search-toggle"
      ]?.["agent:agent-search-toggle-1"],
    ).toBe(true);

    // Clearing the search must leave the agent collapsed.
    await act(async () => {
      mountedRoots[0].render(
        <ToolActivitiesSection
          sessionId="session-agent-search-toggle"
          toolDisplayMode="grouped"
          searchQuery=""
          activities={[agentActivity]}
        />,
      );
    });

    const headerAfter = container.querySelector(
      '[role="button"][aria-expanded]',
    ) as HTMLElement;
    expect(headerAfter.getAttribute("aria-expanded")).toBe("false");
  });

  it("does not wrap inline-mode Agent groups in a collapsible header", async () => {
    // The collapse-by-default stance only applies when the grouped
    // tool calls setting is ON. Inline mode (setting OFF) preserves
    // the legacy always-expanded Agent rendering with no chevron.
    const container = await render(
      <ToolActivitiesSection
        sessionId="session-inline-agent"
        toolDisplayMode="inline"
        searchQuery=""
        activities={[
          activity("Agent", {
            toolUseId: "agent-3",
            agentDescription: "Inline run",
            agentToolCalls: [
              {
                toolUseId: "nested-3",
                toolName: "Bash",
                agentId: "a",
                status: "completed",
                startedAt: "2026-05-08T00:00:00Z",
              },
            ],
          }),
        ]}
      />,
    );

    expect(container.querySelector('[role="button"][aria-expanded]')).toBeNull();
    expect(container.textContent).toContain("Agent");
    expect(container.textContent).toContain("Bash");
  });

  it("renders completed-turn edit summary card", async () => {
    const editActivity = activity("Edit", {
      inputJson: JSON.stringify({
        file_path: "/repo/src/app.ts",
        old_string: "old",
        new_string: "new\nnext",
      }),
    });

    const container = await render(
      <TurnSummary
        turn={{
          id: "turn-1",
          activities: [editActivity],
          messageCount: 1,
          collapsed: false,
          afterMessageIndex: 1,
        }}
        collapsed={false}
        onToggle={() => {}}
        assistantText=""
        searchQuery=""
        worktreePath="/repo"
      />,
    );

    expect(container.textContent).toContain("1 file changed");

    // File list is collapsed by default — expand it first.
    const summaryHeader = container.querySelector(
      `button.${styles.turnEditSummaryHeader}`,
    ) as HTMLButtonElement;
    await act(async () => { summaryHeader.click(); });

    expect(container.textContent).toContain("src/app.ts");
    expect(container.textContent).toContain("+2");
    expect(container.textContent).toContain("-1");
    expect(container.textContent).not.toContain("old");

    const row = container.querySelector(
      `button.${styles.turnEditFileRow}`,
    ) as HTMLButtonElement;
    expect(row).toBeTruthy();
    expect(row.getAttribute("aria-expanded")).toBe("false");

    await act(async () => {
      row.click();
    });

    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("old");
    expect(container.textContent).toContain("new");
    expect(container.textContent).toContain("next");
  });

  it("renders completed-turn workspace diff fallback when activities have no edit payload", async () => {
    const container = await render(
      <TurnSummary
        turn={{
          id: "turn-1",
          activities: [],
          messageCount: 1,
          collapsed: false,
          afterMessageIndex: 1,
        }}
        collapsed={false}
        onToggle={() => {}}
        assistantText=""
        searchQuery=""
        worktreePath="/repo"
        editSummaryFallback={{
          added: 9,
          removed: 2,
          files: [
            {
              filePath: "/repo/src/app.ts",
              added: 9,
              removed: 2,
              previewLines: [],
            },
          ],
        }}
        onLoadEditPreview={async () => [
          {
            type: "added",
            oldLineNumber: null,
            newLineNumber: 12,
            content: "const next = true;",
          },
        ]}
      />,
    );

    expect(container.textContent).toContain("1 file changed");

    // File list is collapsed by default — expand it first.
    const summaryHeader = container.querySelector(
      `button.${styles.turnEditSummaryHeader}`,
    ) as HTMLButtonElement;
    await act(async () => { summaryHeader.click(); });

    expect(container.textContent).toContain("src/app.ts");
    expect(container.textContent).toContain("+9");
    expect(container.textContent).toContain("-2");

    const row = container.querySelector(
      `button.${styles.turnEditFileRow}`,
    ) as HTMLButtonElement;
    expect(row).toBeTruthy();

    await act(async () => {
      row.click();
    });

    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("const next = true;");
  });

  it("prefers turn-scoped activity edits over the workspace-diff fallback", async () => {
    // Regression for the bug fixed alongside `editSummaryFallback`:
    // before this, the workspace-diff override always won, so the
    // latest turn's card listed *every* file with worktree changes
    // even if the turn itself only touched a subset. The activity
    // parser is the source of truth for "files THIS turn touched";
    // the workspace diff is just a rescue when no edit tools matched.
    const editActivity = activity("Edit", {
      inputJson: JSON.stringify({
        file_path: "/repo/src/app.ts",
        old_string: "old",
        new_string: "new",
      }),
    });

    const container = await render(
      <TurnSummary
        turn={{
          id: "turn-1",
          activities: [editActivity],
          messageCount: 1,
          collapsed: false,
          afterMessageIndex: 1,
        }}
        collapsed={false}
        onToggle={() => {}}
        assistantText=""
        searchQuery=""
        worktreePath="/repo"
        editSummaryFallback={{
          added: 99,
          removed: 99,
          files: [
            {
              filePath: "/repo/src/app.ts",
              added: 50,
              removed: 50,
              previewLines: [],
            },
            {
              filePath: "/repo/src/other.ts",
              added: 49,
              removed: 49,
              previewLines: [],
            },
          ],
        }}
      />,
    );

    // Turn-scoped: 1 file (the Edit's file_path), +1 -1 (one new line,
    // one old line). The fallback's 2-file / +99 -99 view must NOT win.
    expect(container.textContent).toContain("1 file changed");
    expect(container.textContent).toContain("src/app.ts");
    expect(container.textContent).not.toContain("other.ts");
    expect(container.textContent).toContain("+1");
    expect(container.textContent).toContain("-1");
    expect(container.textContent).not.toContain("+99");
    expect(container.textContent).not.toContain("-99");
  });
});

describe("TurnSummary", () => {
  it("renders completed inline Agent calls without the summary card chrome", async () => {
    const agent = activity("Agent", {
      agentDescription: "Review changes",
      agentToolCalls: [
        {
          toolUseId: "nested-1",
          toolName: "Bash",
          agentId: "agent-1",
          status: "completed",
          startedAt: "2026-05-08T00:00:00Z",
        },
      ],
    });

    const container = await render(
      <TurnSummary
        turn={completedTurn([agent])}
        collapsed
        onToggle={() => {}}
        assistantText=""
        searchQuery=""
        inline
      />,
    );

    expect(container.querySelector('[role="button"][aria-expanded]')).toBeNull();
    expect(
      container.querySelector(`.${styles.agentToolGroupInline}`),
    ).toBeTruthy();
    expect(container.querySelector(`.${styles.agentToolGroup}`)).toBeNull();
    expect(container.textContent).toContain("Agent");
    expect(container.textContent).toContain("Bash");
  });
});
