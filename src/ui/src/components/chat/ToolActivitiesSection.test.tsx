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
});
