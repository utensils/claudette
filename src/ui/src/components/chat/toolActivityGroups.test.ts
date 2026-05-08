import { describe, expect, it } from "vitest";
import type { ToolActivity } from "../../stores/useAppStore";
import {
  groupHasRunningActivity,
  groupToolActivitiesForDisplay,
} from "./toolActivityGroups";

function activity(
  toolName: string,
  overrides: Partial<ToolActivity> = {},
): ToolActivity {
  return {
    toolUseId: `${toolName}-${Math.random()}`,
    toolName,
    inputJson: "{}",
    resultText: "done",
    collapsed: true,
    summary: "",
    ...overrides,
  };
}

describe("toolActivityGroups", () => {
  it("groups adjacent regular tools and preserves chronological agent positions", () => {
    const groups = groupToolActivitiesForDisplay([
      activity("Bash"),
      activity("Glob"),
      activity("Agent", { agentDescription: "Survey UI" }),
      activity("Read"),
      activity("Agent", { agentDescription: "Agent Website audit" }),
    ]);

    expect(groups.map((group) => group.label)).toEqual([
      "2 tool calls",
      "Agent Survey UI",
      "1 tool call",
      "Agent Website audit",
    ]);
    expect(groups.map((group) => group.activities.map((item) => item.toolName))).toEqual([
      ["Bash", "Glob"],
      ["Agent"],
      ["Read"],
      ["Agent"],
    ]);
  });

  it("renders one item per top-level activity in inline mode", () => {
    const groups = groupToolActivitiesForDisplay(
      [
        activity("Bash"),
        activity("Agent", { agentDescription: "Survey UI" }),
        activity("Glob"),
      ],
      "inline",
    );

    expect(groups.map((group) => group.label)).toEqual([
      "Bash",
      "Agent Survey UI",
      "Glob",
    ]);
    expect(groups.map((group) => group.activities.map((item) => item.toolName))).toEqual([
      ["Bash"],
      ["Agent"],
      ["Glob"],
    ]);
  });

  it("only marks unfinished groups as running", () => {
    expect(
      groupHasRunningActivity([
        activity("Agent", {
          resultText: "",
          agentStatus: "running",
        }),
      ]),
    ).toBe(true);
    expect(
      groupHasRunningActivity([
        activity("Agent", {
          resultText: "finished",
          agentStatus: "running",
        }),
      ]),
    ).toBe(false);
  });

  it("labels unnamed agents without a duplicated fallback", () => {
    expect(groupToolActivitiesForDisplay([activity("Agent")])[0]?.label).toBe(
      "Agent",
    );
  });
});
