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

  it("groups consecutive same-server MCP calls into one server-labeled group", () => {
    const groups = groupToolActivitiesForDisplay([
      activity("mcp__datadog__load_datadog_skill"),
      activity("mcp__datadog__list_datadog_skills"),
      activity("mcp__datadog__search_datadog_dashboards"),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.kind).toBe("mcp");
    expect(groups[0]?.label).toBe("datadog");
    expect(groups[0]?.activities).toHaveLength(3);
  });

  it("splits different MCP servers into separate groups in order", () => {
    const groups = groupToolActivitiesForDisplay([
      activity("mcp__datadog__search_datadog_dashboards"),
      activity("mcp__github__create_issue"),
      activity("mcp__github__list_issues"),
    ]);

    expect(groups.map((g) => g.kind)).toEqual(["mcp", "mcp"]);
    expect(groups.map((g) => g.label)).toEqual(["datadog", "github"]);
    expect(groups.map((g) => g.activities.length)).toEqual([1, 2]);
  });

  it("pulls MCP calls out of the generic tool pill, preserving transcript order", () => {
    const groups = groupToolActivitiesForDisplay([
      activity("Read"),
      activity("mcp__datadog__search_datadog_dashboards"),
      activity("mcp__datadog__list_datadog_skills"),
      activity("Write"),
    ]);

    expect(groups.map((g) => g.kind)).toEqual(["tools", "mcp", "tools"]);
    expect(groups.map((g) => g.label)).toEqual([
      "1 tool call",
      "datadog",
      "1 tool call",
    ]);
  });

  it("breaks an MCP run around an agent or skill, like direct tools", () => {
    const groups = groupToolActivitiesForDisplay([
      activity("mcp__datadog__search_datadog_dashboards"),
      activity("Skill", { inputJson: JSON.stringify({ skill: "commit-changes" }) }),
      activity("mcp__datadog__list_datadog_skills"),
    ]);

    expect(groups.map((g) => g.kind)).toEqual(["mcp", "skill", "mcp"]);
    expect(groups.map((g) => g.label)).toEqual([
      "datadog",
      "commit-changes",
      "datadog",
    ]);
  });

  it("does not form MCP groups in inline mode", () => {
    const groups = groupToolActivitiesForDisplay(
      [
        activity("mcp__datadog__search_datadog_dashboards"),
        activity("mcp__datadog__list_datadog_skills"),
      ],
      "inline",
    );

    // Inline mode is the legacy "show everything flat" rendering: one group
    // per activity, no per-server container.
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.kind !== "mcp")).toBe(true);
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
