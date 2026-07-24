import { describe, expect, it } from "vitest";
import {
  isAgentTerminal,
  phaseTitleOf,
  summarizeWorkflowProgress,
  type WorkflowAgentEntry,
  type WorkflowProgressEntry,
} from "./workflow";

function agent(
  index: number,
  state: string,
  extra: Partial<WorkflowAgentEntry> = {},
): WorkflowAgentEntry {
  return {
    type: "workflow_agent",
    index,
    label: `agent-${index}`,
    state,
    ...extra,
  };
}

function phase(index: number, title: string): WorkflowProgressEntry {
  return { type: "workflow_phase", index, title };
}

describe("summarizeWorkflowProgress", () => {
  it("returns an empty, not-running summary for no entries", () => {
    for (const input of [undefined, [] as WorkflowProgressEntry[]]) {
      const summary = summarizeWorkflowProgress(input);
      expect(summary.totalCount).toBe(0);
      expect(summary.running).toBe(false);
      expect(summary.currentPhaseTitle).toBeNull();
    }
  });

  // The CLI re-emits a full entry per state transition, so one snapshot
  // routinely carries the same agent three times. Counting them separately
  // would report "5/3 agents".
  it("collapses repeated entries for the same agent index, last write winning", () => {
    const summary = summarizeWorkflowProgress([
      agent(1, "queued"),
      agent(1, "progress"),
      agent(1, "done", { tokens: 100, toolCalls: 4 }),
    ]);
    expect(summary.totalCount).toBe(1);
    expect(summary.doneCount).toBe(1);
    expect(summary.running).toBe(false);
    expect(summary.totalTokens).toBe(100);
    expect(summary.totalToolCalls).toBe(4);
  });

  it("keeps agents in first-seen order, not index order", () => {
    // A phase-2 agent can start before a slow phase-1 agent finishes; a
    // later tick for the slow one must not reorder the list under the user.
    const summary = summarizeWorkflowProgress([
      agent(2, "progress"),
      agent(1, "progress"),
      agent(2, "done"),
    ]);
    expect(summary.agents.map((a) => a.index)).toEqual([2, 1]);
  });

  it("sums tokens and tool calls across agents, tolerating missing values", () => {
    const summary = summarizeWorkflowProgress([
      agent(1, "done", { tokens: 100, toolCalls: 3 }),
      agent(2, "done", { tokens: 50 }),
      agent(3, "progress"),
    ]);
    expect(summary.totalTokens).toBe(150);
    expect(summary.totalToolCalls).toBe(3);
  });

  it("counts errors separately but still as terminal", () => {
    const summary = summarizeWorkflowProgress([
      agent(1, "done"),
      agent(2, "error", { error: "boom" }),
    ]);
    expect(summary.doneCount).toBe(2);
    expect(summary.errorCount).toBe(1);
    expect(summary.running).toBe(false);
  });

  it("is running while any agent is queued or in flight", () => {
    expect(
      summarizeWorkflowProgress([agent(1, "done"), agent(2, "queued")]).running,
    ).toBe(true);
    expect(
      summarizeWorkflowProgress([agent(1, "done"), agent(2, "progress")]).running,
    ).toBe(true);
  });

  it("reports the phase of the first non-terminal agent", () => {
    const summary = summarizeWorkflowProgress([
      phase(1, "Review"),
      phase(2, "Verify"),
      agent(1, "done", { phaseTitle: "Review" }),
      agent(2, "progress", { phaseTitle: "Verify" }),
    ]);
    expect(summary.currentPhaseTitle).toBe("Verify");
  });

  it("falls back to the last declared phase once everything is terminal", () => {
    const summary = summarizeWorkflowProgress([
      phase(1, "Review"),
      phase(2, "Synthesize"),
      agent(1, "done", { phaseTitle: "Review" }),
    ]);
    expect(summary.currentPhaseTitle).toBe("Synthesize");
  });

  // The fallback exists for "nothing is running"; firing it while an
  // unphased agent is in flight would name a phase nothing is working in.
  it("does not claim a declared phase while an unphased agent is in flight", () => {
    const summary = summarizeWorkflowProgress([
      phase(1, "Review"),
      phase(2, "Synthesize"),
      agent(1, "done", { phaseTitle: "Review" }),
      agent(2, "progress"), // launched before any phase() — no phaseTitle
    ]);
    expect(summary.currentPhaseTitle).toBeNull();
  });

  it("prefers a later in-flight agent that does declare a phase", () => {
    const summary = summarizeWorkflowProgress([
      phase(1, "Review"),
      agent(1, "progress"), // unphased
      agent(2, "progress", { phaseTitle: "Verify" }),
    ]);
    expect(summary.currentPhaseTitle).toBe("Verify");
  });

  it("treats an empty or whitespace phase title as no phase", () => {
    expect(
      summarizeWorkflowProgress([
        phase(1, "Review"),
        agent(1, "progress", { phaseTitle: "   " }),
      ]).currentPhaseTitle,
    ).toBeNull();

    // ...and it must not block a later, real phase title either.
    expect(
      summarizeWorkflowProgress([
        agent(1, "progress", { phaseTitle: "" }),
        agent(2, "progress", { phaseTitle: "Verify" }),
      ]).currentPhaseTitle,
    ).toBe("Verify");
  });

  it("ignores unknown entry kinds without disturbing the counts", () => {
    const summary = summarizeWorkflowProgress([
      { type: "Unknown" },
      agent(1, "done"),
      { type: "Unknown" },
    ]);
    expect(summary.totalCount).toBe(1);
    expect(summary.doneCount).toBe(1);
  });
});

describe("phaseTitleOf", () => {
  it("returns the trimmed title when present", () => {
    expect(phaseTitleOf(agent(1, "done", { phaseTitle: "  Review  " }))).toBe(
      "Review",
    );
  });

  // Three shapes mean "no phase": absent, an explicit null (how Rust
  // serializes `Option<String>`), and empty/whitespace.
  it("normalizes every no-phase shape to null", () => {
    expect(phaseTitleOf(agent(1, "done"))).toBeNull();
    expect(phaseTitleOf(agent(1, "done", { phaseTitle: null }))).toBeNull();
    expect(phaseTitleOf(agent(1, "done", { phaseTitle: "" }))).toBeNull();
    expect(phaseTitleOf(agent(1, "done", { phaseTitle: "  " }))).toBeNull();
  });
});

describe("isAgentTerminal", () => {
  it("treats done and error as terminal", () => {
    expect(isAgentTerminal(agent(1, "done"))).toBe(true);
    expect(isAgentTerminal(agent(1, "error"))).toBe(true);
  });

  // A state we've never seen must read as "still going", so a run can't
  // report itself finished on the strength of a value we don't understand.
  it("treats queued, progress, and unrecognized states as in-flight", () => {
    expect(isAgentTerminal(agent(1, "queued"))).toBe(false);
    expect(isAgentTerminal(agent(1, "progress"))).toBe(false);
    expect(isAgentTerminal(agent(1, "some_future_state"))).toBe(false);
    expect(isAgentTerminal(agent(1, ""))).toBe(false);
  });
});
