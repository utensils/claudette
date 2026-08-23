import { describe, expect, it } from "vitest";
import {
  isAgentTerminal,
  isWorkflowProgressEntry,
  phaseTitleOf,
  readOptionalNumber,
  readOptionalString,
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

  // A stray non-number would make `+=` concatenate or produce NaN — a
  // silently wrong total rather than a loud failure.
  it("ignores corrupt token and tool-call values instead of corrupting totals", () => {
    const summary = summarizeWorkflowProgress([
      agent(1, "done", { tokens: 100, toolCalls: 3 }),
      {
        type: "workflow_agent",
        index: 2,
        label: "b",
        state: "done",
        tokens: "abc",
        toolCalls: NaN,
      } as unknown as WorkflowAgentEntry,
    ]);
    expect(summary.totalTokens).toBe(100);
    expect(summary.totalToolCalls).toBe(3);
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

describe("isWorkflowProgressEntry", () => {
  it("accepts every kind the union models", () => {
    expect(isWorkflowProgressEntry(phase(1, "Review"))).toBe(true);
    expect(isWorkflowProgressEntry(agent(1, "done"))).toBe(true);
    // Rust writes this for any incoming kind it doesn't recognize, so it's
    // a legitimate stored value, not a parse failure.
    expect(isWorkflowProgressEntry({ type: "Unknown" })).toBe(true);
  });

  // The predicate asserts the union type, so admitting an unmodeled `type`
  // would be unsound — safe only while every consumer re-discriminates.
  it("rejects an object whose type is a string but not a known kind", () => {
    expect(isWorkflowProgressEntry({ type: "workflow_log" })).toBe(false);
    expect(isWorkflowProgressEntry({ type: "bogus", label: "x" })).toBe(false);
    expect(isWorkflowProgressEntry({ type: "" })).toBe(false);
  });

  it("rejects non-objects and objects without a string type", () => {
    for (const value of [null, undefined, 42, "workflow_agent", [], {}, { type: 1 }]) {
      expect(isWorkflowProgressEntry(value)).toBe(false);
    }
  });

  it("rejects a known kind that is missing or mistypes a required field", () => {
    // phase requires index:number + title:string
    expect(isWorkflowProgressEntry({ type: "workflow_phase" })).toBe(false);
    expect(
      isWorkflowProgressEntry({ type: "workflow_phase", index: "1", title: "R" }),
    ).toBe(false);
    expect(
      isWorkflowProgressEntry({ type: "workflow_phase", index: 1, title: 2 }),
    ).toBe(false);

    // agent requires index:number + label:string + state:string
    expect(isWorkflowProgressEntry({ type: "workflow_agent" })).toBe(false);
    expect(
      isWorkflowProgressEntry({ type: "workflow_agent", index: 1, label: "a" }),
    ).toBe(false);
    expect(
      isWorkflowProgressEntry({
        type: "workflow_agent",
        index: 1,
        label: "a",
        state: 3,
      }),
    ).toBe(false);
  });

  // Documents the deliberate limit of this guard: optional fields are not
  // type-checked, so a corrupt one survives. That is why accessors reaching
  // for string methods go through `readOptionalString` — see the
  // "tolerates a corrupt optional field" test below.
  it("admits a well-formed entry even when an optional field is corrupt", () => {
    expect(
      isWorkflowProgressEntry({
        type: "workflow_agent",
        index: 1,
        label: "a",
        state: "done",
        phaseTitle: 1,
      }),
    ).toBe(true);
  });
});

describe("readOptionalString / readOptionalNumber", () => {
  it("passes through valid values and nulls everything else", () => {
    expect(readOptionalString("x")).toBe("x");
    expect(readOptionalString("")).toBe("");
    for (const bad of [1, null, undefined, {}, [], true]) {
      expect(readOptionalString(bad)).toBeNull();
    }

    expect(readOptionalNumber(0)).toBe(0);
    expect(readOptionalNumber(42)).toBe(42);
    // NaN and infinities would poison a running total just as a string does.
    for (const bad of ["1", null, undefined, NaN, Infinity, -Infinity, {}]) {
      expect(readOptionalNumber(bad)).toBeNull();
    }
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

  // The guard admits this shape (optional fields go unchecked), so the
  // accessor is the layer that has to survive it. `.trim()` on a number
  // throws, which would take down the whole card render.
  it("tolerates a corrupt optional field instead of throwing", () => {
    const corrupt = {
      type: "workflow_agent",
      index: 1,
      label: "a",
      state: "done",
      phaseTitle: 1,
    } as unknown as WorkflowAgentEntry;
    expect(() => phaseTitleOf(corrupt)).not.toThrow();
    expect(phaseTitleOf(corrupt)).toBeNull();
  });
});

describe("isAgentTerminal", () => {
  it("treats done and error as terminal", () => {
    expect(isAgentTerminal(agent(1, "done"))).toBe(true);
    expect(isAgentTerminal(agent(1, "error"))).toBe(true);
  });

  // Stamped by `reconcile_tree_on_terminal` on a run that ended without
  // completing. If this did not read as terminal, reconciliation could not
  // close out the stragglers and the pill would keep advertising an
  // unfinished fraction for a run that is over — the bug it exists to fix.
  it("treats a reconciled stopped agent as terminal", () => {
    expect(isAgentTerminal(agent(1, "stopped"))).toBe(true);
  });

  // "stopped" is deliberately not "error": a cancelled run must not light
  // up the card's failure badge.
  it("does not count a stopped agent as a failure", () => {
    const summary = summarizeWorkflowProgress([
      agent(1, "stopped"),
      agent(2, "done"),
    ]);
    expect(summary.doneCount).toBe(2);
    expect(summary.errorCount).toBe(0);
    expect(summary.running).toBe(false);
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
