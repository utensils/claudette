// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../workers/highlight.worker?worker", () => ({
  default: class FakeWorker {
    postMessage(): void {}
    addEventListener(): void {}
    terminate(): void {}
  },
}));

import "../../i18n";
import {
  useAppStore,
  type AgentToolCall,
  type CompletedTurn,
  type ToolActivity,
} from "../../stores/useAppStore";
import styles from "./ChatPanel.module.css";
import { AgentRollupGroup } from "./AgentActivityGroups";
import { AGENT_VISIBLE_CALLS, AgentToolCallGroup } from "./AgentToolCallGroup";
import { ToolActivitiesSection } from "./ToolActivitiesSection";
import { TurnSummary } from "./TurnSummary";

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

function agent(id: string, overrides: Partial<ToolActivity> = {}): ToolActivity {
  return {
    toolUseId: id,
    toolName: "Agent",
    inputJson: JSON.stringify({ description: id, subagent_type: "Explore" }),
    resultText: "",
    collapsed: true,
    summary: id,
    ...overrides,
  };
}

function call(i: number): AgentToolCall {
  return {
    toolUseId: `call-${i}`,
    toolName: "Read",
    agentId: "a",
    input: { file_path: `/repo/file-${i}.ts` },
    status: "completed",
    startedAt: "2026-10-30T00:00:00Z",
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
  useAppStore.setState({ collapsedToolGroupsBySession: {} });
});

afterEach(async () => {
  for (const root of mountedRoots.splice(0).reverse()) {
    await act(async () => root.unmount());
  }
  for (const container of mountedContainers.splice(0)) container.remove();
});

describe("AgentToolCallGroup", () => {
  it("shows subagent type, state icon, and usage", async () => {
    const container = await render(
      <AgentToolCallGroup
        activity={agent("a1", {
          agentStatus: "completed",
          agentToolUseCount: 38,
          agentTotalTokens: 84_669,
          agentDurationMs: 180_027,
        })}
        searchQuery=""
      />,
    );
    expect(container.querySelector(`.${styles.agentTypeBadge}`)?.textContent).toBe(
      "Explore",
    );
    expect(container.querySelector('[role="img"][aria-label="completed"]')?.textContent).toBe(
      "●",
    );
    expect(container.textContent).toContain("38 agent tool calls");
    expect(container.textContent).toContain("84.6k tokens");
    expect(container.textContent).toContain("3m 0s");
  });

  it("shows only the latest calls until expanded", async () => {
    const calls = Array.from({ length: AGENT_VISIBLE_CALLS + 5 }, (_, i) => call(i));
    const container = await render(
      <AgentToolCallGroup activity={agent("a1", { agentToolCalls: calls })} searchQuery="" />,
    );
    const rows = () => container.querySelectorAll(`.${styles.agentToolCall}`).length;
    expect(rows()).toBe(AGENT_VISIBLE_CALLS);
    // Oldest calls are the ones hidden.
    expect(container.textContent).not.toContain("file-0.ts");
    expect(container.textContent).toContain(`file-${AGENT_VISIBLE_CALLS + 4}.ts`);

    const showAll = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes(`Show all ${calls.length}`),
    ) as HTMLButtonElement;
    await act(async () => showAll.click());
    expect(rows()).toBe(calls.length);
  });

  it("reveals hidden calls when a search query is active", async () => {
    const calls = Array.from({ length: AGENT_VISIBLE_CALLS + 2 }, (_, i) => call(i));
    const container = await render(
      <AgentToolCallGroup
        activity={agent("a1", { agentToolCalls: calls })}
        searchQuery="file-0"
      />,
    );
    expect(container.querySelectorAll(`.${styles.agentToolCall}`).length).toBe(
      calls.length,
    );
  });
});

describe("AgentRollupGroup", () => {
  it("summarizes member agents by state and total tokens", async () => {
    const container = await render(
      <AgentRollupGroup
        sessionId="s"
        activities={[
          agent("a1", { agentStatus: "running", agentTotalTokens: 1000 }),
          agent("a2", { agentStatus: "completed", agentTotalTokens: 2500 }),
          agent("a3", { agentStatus: "failed" }),
        ]}
        collapsed={false}
        onToggle={() => {}}
        searchQuery=""
      />,
    );
    const counts = container.querySelector(`.${styles.agentRollupCounts}`)?.textContent;
    expect(container.textContent).toContain("3 agents");
    expect(counts).toContain("1 running");
    expect(counts).toContain("1 done");
    expect(counts).toContain("1 failed");
    expect(counts).toContain("3.5k tokens");
    expect(container.querySelectorAll(`.${styles.agentToolGroup}`).length).toBe(3);
  });

  it("hides member agents when collapsed", async () => {
    const container = await render(
      <AgentRollupGroup
        sessionId="s"
        activities={[agent("a1"), agent("a2")]}
        collapsed
        onToggle={() => {}}
        searchQuery=""
      />,
    );
    expect(container.querySelectorAll(`.${styles.agentToolGroup}`).length).toBe(0);
  });

  it("is used for consecutive live Agent calls in grouped mode", async () => {
    const container = await render(
      <ToolActivitiesSection
        sessionId="s"
        toolDisplayMode="grouped"
        searchQuery=""
        activities={[agent("a1"), agent("a2")]}
      />,
    );
    expect(container.textContent).toContain("2 agents");
    // Expanded by default; each member starts individually collapsed.
    expect(container.querySelectorAll(`.${styles.agentToolGroup}`).length).toBe(2);
    expect(container.querySelectorAll(`.${styles.agentNestedChat}`).length).toBe(0);
  });

  it("renders the same rollup for a completed turn", async () => {
    const activities = [agent("a1"), agent("a2")];
    const turn: CompletedTurn = {
      id: "t",
      activities,
      messageCount: 1,
      collapsed: true,
      afterMessageIndex: 1,
    };
    const container = await render(
      <TurnSummary
        turn={turn}
        activities={activities}
        kind="agents"
        sessionId="s"
        label="2 agents"
        collapsed={false}
        onToggle={() => {}}
        assistantText=""
        searchQuery=""
      />,
    );
    expect(container.querySelector(`.${styles.agentRollupCounts}`)).toBeTruthy();
    expect(container.querySelectorAll(`.${styles.agentToolGroup}`).length).toBe(2);
  });
});
