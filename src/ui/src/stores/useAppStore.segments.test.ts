import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "./useAppStore";

const WS_ID = "ws-segments";

function resetSegmentState() {
  useAppStore.setState({
    toolActivities: { [WS_ID]: [] },
    turnSegments: { [WS_ID]: [] },
    segmentBreakPending: { [WS_ID]: false },
    chatMessages: { [WS_ID]: [] },
    completedTurns: { [WS_ID]: [] },
  });
}

/** Helper: register a tool activity in the store the way useAgentStream does
 *  — needed because finalizeTurn is a no-op when `toolActivities` is empty. */
function registerTool(toolUseId: string, toolName: string) {
  useAppStore.setState((s) => ({
    toolActivities: {
      ...s.toolActivities,
      [WS_ID]: [
        ...(s.toolActivities[WS_ID] ?? []),
        {
          toolUseId,
          toolName,
          inputJson: "{}",
          resultText: "",
          collapsed: true,
          summary: "",
        },
      ],
    },
  }));
}

describe("appendToolSegment / markSegmentBreak", () => {
  beforeEach(() => {
    resetSegmentState();
  });

  it("consecutive tools without a break merge into one tool-group", () => {
    const { appendToolSegment } = useAppStore.getState();
    appendToolSegment(WS_ID, "t1", false);
    appendToolSegment(WS_ID, "t2", false);
    appendToolSegment(WS_ID, "t3", false);

    const segs = useAppStore.getState().turnSegments[WS_ID];
    expect(segs).toHaveLength(1);
    expect(segs[0]).toMatchObject({
      kind: "tool-group",
      toolUseIds: ["t1", "t2", "t3"],
    });
  });

  it("text/thinking between tools breaks the group", () => {
    const { appendToolSegment, markSegmentBreak } = useAppStore.getState();
    appendToolSegment(WS_ID, "t1", false);
    appendToolSegment(WS_ID, "t2", false);
    markSegmentBreak(WS_ID);
    appendToolSegment(WS_ID, "t3", false);

    const segs = useAppStore.getState().turnSegments[WS_ID];
    expect(segs).toHaveLength(2);
    expect(segs[0]).toMatchObject({
      kind: "tool-group",
      toolUseIds: ["t1", "t2"],
    });
    expect(segs[1]).toMatchObject({
      kind: "tool-group",
      toolUseIds: ["t3"],
    });
  });

  it("subagent calls always get their own segment, never merged", () => {
    const { appendToolSegment } = useAppStore.getState();
    appendToolSegment(WS_ID, "t1", false);
    appendToolSegment(WS_ID, "sub1", true);
    appendToolSegment(WS_ID, "t2", false);

    const segs = useAppStore.getState().turnSegments[WS_ID];
    expect(segs).toHaveLength(3);
    expect(segs[0]).toMatchObject({ kind: "tool-group", toolUseIds: ["t1"] });
    expect(segs[1]).toMatchObject({ kind: "subagent", toolUseId: "sub1" });
    expect(segs[2]).toMatchObject({ kind: "tool-group", toolUseIds: ["t2"] });
  });

  it("a non-subagent tool after a subagent opens a new tool-group", () => {
    // Because the trailing segment is `subagent`, the merging rule's
    // "append to last tool-group" branch doesn't apply.
    const { appendToolSegment } = useAppStore.getState();
    appendToolSegment(WS_ID, "sub1", true);
    appendToolSegment(WS_ID, "t1", false);

    const segs = useAppStore.getState().turnSegments[WS_ID];
    expect(segs).toHaveLength(2);
    expect(segs[0].kind).toBe("subagent");
    expect(segs[1]).toMatchObject({ kind: "tool-group", toolUseIds: ["t1"] });
  });

  it("markSegmentBreak is idempotent — repeated breaks before any tool only break once", () => {
    const { appendToolSegment, markSegmentBreak } = useAppStore.getState();
    appendToolSegment(WS_ID, "t1", false);
    markSegmentBreak(WS_ID);
    markSegmentBreak(WS_ID);
    markSegmentBreak(WS_ID);
    appendToolSegment(WS_ID, "t2", false);

    const segs = useAppStore.getState().turnSegments[WS_ID];
    expect(segs).toHaveLength(2);
    expect(segs[0]).toMatchObject({ kind: "tool-group", toolUseIds: ["t1"] });
  });

  it("appending a tool clears the pending break flag", () => {
    const { appendToolSegment, markSegmentBreak } = useAppStore.getState();
    markSegmentBreak(WS_ID);
    appendToolSegment(WS_ID, "t1", false);

    expect(useAppStore.getState().segmentBreakPending[WS_ID]).toBe(false);
  });
});

describe("finalizeTurn snapshots segments", () => {
  beforeEach(() => {
    resetSegmentState();
  });

  it("copies live segments onto the CompletedTurn and clears the slice", () => {
    const { appendToolSegment, markSegmentBreak, finalizeTurn } =
      useAppStore.getState();
    registerTool("t1", "Read");
    appendToolSegment(WS_ID, "t1", false);
    registerTool("t2", "Read");
    appendToolSegment(WS_ID, "t2", false);
    markSegmentBreak(WS_ID);
    registerTool("t3", "Bash");
    appendToolSegment(WS_ID, "t3", false);

    finalizeTurn(WS_ID, 1);

    const turn = useAppStore.getState().completedTurns[WS_ID][0];
    expect(turn.segments).toHaveLength(2);
    expect(turn.segments![0]).toMatchObject({
      kind: "tool-group",
      toolUseIds: ["t1", "t2"],
    });
    expect(turn.segments![1]).toMatchObject({
      kind: "tool-group",
      toolUseIds: ["t3"],
    });
    // Slice is cleared after finalization.
    expect(useAppStore.getState().turnSegments[WS_ID]).toEqual([]);
    expect(useAppStore.getState().segmentBreakPending[WS_ID]).toBe(false);
  });

  it("falls back to a single tool-group when no live segments were captured", () => {
    // Simulates a hydration / stream-bypass path where toolActivities exist
    // but the stream handler never invoked appendToolSegment.
    const { finalizeTurn } = useAppStore.getState();
    registerTool("t1", "Read");
    registerTool("t2", "Read");

    finalizeTurn(WS_ID, 1);

    const turn = useAppStore.getState().completedTurns[WS_ID][0];
    expect(turn.segments).toHaveLength(1);
    expect(turn.segments![0]).toMatchObject({
      kind: "tool-group",
      toolUseIds: ["t1", "t2"],
    });
  });
});
