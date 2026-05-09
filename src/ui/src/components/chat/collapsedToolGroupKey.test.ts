import { describe, expect, it } from "vitest";
import type { ToolActivity } from "../../stores/useAppStore";
import { collapsedToolGroupKey } from "./collapsedToolGroupKey";

function activity(
  toolUseId: string,
  toolName = "Bash",
  overrides: Partial<ToolActivity> = {},
): ToolActivity {
  return {
    toolUseId,
    toolName,
    inputJson: "{}",
    resultText: "",
    collapsed: true,
    summary: "",
    ...overrides,
  };
}

describe("collapsedToolGroupKey", () => {
  it("uses the first activity's toolUseId, prefixed by tools:", () => {
    expect(collapsedToolGroupKey([activity("a"), activity("b")])).toBe("tools:a");
  });

  it("prefixes Agent activities with agent: instead of tools:", () => {
    expect(collapsedToolGroupKey([activity("a", "Agent")])).toBe("agent:a");
  });

  it("returns null for an empty group", () => {
    expect(collapsedToolGroupKey([])).toBeNull();
  });

  it("ignores later activities when computing the key", () => {
    // The first toolUseId is stable across activity-append rerenders;
    // any later activity getting added to the same group must NOT
    // change the key (otherwise the slice override would be 'lost'
    // every time the agent emitted another tool call).
    const firstKey = collapsedToolGroupKey([activity("first-id")]);
    const laterKey = collapsedToolGroupKey([
      activity("first-id"),
      activity("second-id"),
      activity("third-id"),
    ]);
    expect(firstKey).toBe(laterKey);
  });

  it("agrees on a group's key whether it's still running or completed", () => {
    // The same activity object — same toolUseId — produces the same
    // key whether it's pulled from `toolActivities[sessionId]` (still
    // running) or `completedTurns[sessionId][N].activities`. That's
    // the whole point: the running→completed transition preserves the
    // user's expand/collapse choice because both sides hash to the
    // same slice key.
    const runningActivity = activity("ttt", "Edit", { resultText: "" });
    const completedActivity: ToolActivity = {
      ...runningActivity,
      resultText: "edit applied",
    };
    expect(collapsedToolGroupKey([runningActivity])).toBe(
      collapsedToolGroupKey([completedActivity]),
    );
  });
});
