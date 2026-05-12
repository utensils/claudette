import { describe, expect, it } from "vitest";
import type { ToolActivity } from "../../stores/useAppStore";
import {
  groupHasRunningActivity,
  groupToolActivitiesForDisplay,
  skillActivationName,
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

  it("breaks a run of direct tools out around a skill, like an agent", () => {
    const groups = groupToolActivitiesForDisplay([
      activity("Bash"),
      activity("Skill", {
        inputJson: JSON.stringify({ skill: "commit-changes" }),
      }),
      activity("Read"),
    ]);

    expect(groups.map((g) => g.kind)).toEqual(["tools", "skill", "tools"]);
    expect(groups.map((g) => g.label)).toEqual([
      "1 tool call",
      "commit-changes",
      "1 tool call",
    ]);
    expect(groups[1]?.activities.map((a) => a.toolName)).toEqual(["Skill"]);
  });

  it("gives each skill its own group in inline mode", () => {
    const groups = groupToolActivitiesForDisplay(
      [
        activity("Skill", { inputJson: JSON.stringify({ skill: "rebase-on-main" }) }),
      ],
      "inline",
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.kind).toBe("skill");
    expect(groups[0]?.label).toBe("rebase-on-main");
  });

  it("derives the skill name from input, then summary, then a default", () => {
    expect(
      skillActivationName(
        activity("Skill", { inputJson: JSON.stringify({ skill: "  pull-request  " }) }),
      ),
    ).toBe("pull-request");
    expect(
      skillActivationName(activity("Skill", { inputJson: "{}", summary: "commit-changes wip" })),
    ).toBe("commit-changes");
    expect(skillActivationName(activity("Skill", { inputJson: "not json", summary: "" }))).toBe(
      "Skill",
    );
  });
});
