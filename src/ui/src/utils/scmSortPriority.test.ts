import { describe, it, expect } from "vitest";
import { getScmSortPriority } from "./scmSortPriority";
import type { ScmSummary } from "../types/plugin";

function makeSummary(
  prState: ScmSummary["prState"],
  ciState: ScmSummary["ciState"],
  hasPr = true,
): ScmSummary {
  return { hasPr, prState, ciState, lastUpdated: Date.now() };
}

describe("getScmSortPriority", () => {
  it("returns 0 for open PR with CI passing", () => {
    expect(getScmSortPriority(makeSummary("open", "success"))).toBe(0);
  });

  it("returns 1 for open PR with CI pending", () => {
    expect(getScmSortPriority(makeSummary("open", "pending"))).toBe(1);
  });

  it("returns 2 for open PR with CI failing", () => {
    expect(getScmSortPriority(makeSummary("open", "failure"))).toBe(2);
  });

  it("returns 3 for open PR with no CI data", () => {
    expect(getScmSortPriority(makeSummary("open", null))).toBe(3);
  });

  it("returns 4 for draft PR", () => {
    expect(getScmSortPriority(makeSummary("draft", null))).toBe(4);
  });

  it("returns 5 for no PR (hasPr false)", () => {
    expect(getScmSortPriority(makeSummary(null, null, false))).toBe(5);
  });

  it("returns 5 for undefined summary", () => {
    expect(getScmSortPriority(undefined)).toBe(5);
  });

  it("returns 5 for null prState with hasPr true", () => {
    expect(getScmSortPriority(makeSummary(null, null, true))).toBe(5);
  });

  it("returns 6 for merged PR", () => {
    expect(getScmSortPriority(makeSummary("merged", null))).toBe(6);
  });

  it("returns 7 for closed PR", () => {
    expect(getScmSortPriority(makeSummary("closed", null))).toBe(7);
  });

  it("sorts workspaces in correct priority order", () => {
    const summaries: ScmSummary[] = [
      makeSummary(null, null, false),
      makeSummary("closed", null),
      makeSummary("open", "success"),
      makeSummary("draft", null),
      makeSummary("open", "failure"),
      makeSummary("merged", null),
      makeSummary("open", "pending"),
      makeSummary("open", null),
    ];

    const sorted = [...summaries].sort(
      (a, b) => getScmSortPriority(a) - getScmSortPriority(b),
    );

    expect(sorted.map(getScmSortPriority)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});
