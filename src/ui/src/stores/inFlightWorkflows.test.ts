import { describe, expect, it } from "vitest";

import { collectInFlightWorkflows } from "./inFlightWorkflows";
import type { CompletedTurn, ToolActivity } from "./useAppStore";

function activity(
  toolUseId: string,
  overrides: Partial<ToolActivity> = {},
): ToolActivity {
  return {
    toolUseId,
    toolName: "Workflow",
    inputJson: "{}",
    resultText: "Workflow launched in background.",
    collapsed: false,
    summary: toolUseId,
    agentStatus: "running",
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

describe("collectInFlightWorkflows", () => {
  it("finds workflows in both lanes", () => {
    const found = collectInFlightWorkflows(
      [activity("live")],
      [turn("t1", [activity("done-turn")])],
    );
    expect(found.map((a) => a.toolUseId)).toEqual(["done-turn", "live"]);
  });

  it("skips runs that already reported an ending", () => {
    const found = collectInFlightWorkflows(
      [],
      [
        turn("t1", [
          activity("finished", { agentStatus: "completed" }),
          activity("terminated", { agentStatus: "stopped" }),
          activity("still-going"),
        ]),
      ],
    );
    expect(found.map((a) => a.toolUseId)).toEqual(["still-going"]);
  });

  it("ignores non-workflow activities", () => {
    const found = collectInFlightWorkflows(
      [activity("task", { toolName: "Task" }), activity("bash", { toolName: "Bash" })],
      [],
    );
    expect(found).toEqual([]);
  });

  // An activity is briefly in both lanes around the turn boundary. The live
  // copy is the fresher one and must win, but the entry keeps the position
  // it had in transcript order — `Map.set` on an existing key updates in
  // place rather than moving it to the end.
  it("prefers the live copy without disturbing transcript order", () => {
    const found = collectInFlightWorkflows(
      [activity("wf1", { summary: "fresh" })],
      [
        turn("t1", [activity("wf1", { summary: "stale" })]),
        turn("t2", [activity("wf2")]),
      ],
    );
    expect(found.map((a) => a.toolUseId)).toEqual(["wf1", "wf2"]);
    expect(found[0].summary).toBe("fresh");
  });

  it("returns nothing when every run has ended", () => {
    const found = collectInFlightWorkflows(
      [activity("wf1", { agentStatus: "stopped" })],
      [turn("t1", [activity("wf2", { agentStatus: "completed" })])],
    );
    expect(found).toEqual([]);
  });
});
