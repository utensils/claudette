import { describe, expect, it } from "vitest";
import type { CiCheck } from "../types/plugin";
import {
  ciCheckStatusLabel,
  deriveScmCiState,
  sortCiChecks,
  summarizeCiChecks,
} from "./scmChecks";

function check(name: string, status: CiCheck["status"]): CiCheck {
  return {
    name,
    status,
    url: null,
    started_at: null,
  };
}

describe("scmChecks", () => {
  it("summarizes failing checks first", () => {
    expect(
      summarizeCiChecks([
        check("Frontend", "success"),
        check("Lint", "failure"),
        check("Test", "pending"),
      ]),
    ).toMatchObject({
      title: "1 check failing",
      failed: 1,
      pending: 1,
      passed: 1,
      total: 3,
    });
  });

  it("uses passed wording when every check passed", () => {
    expect(summarizeCiChecks([check("Lint", "success"), check("Test", "success")]).title)
      .toBe("Checks passed");
  });

  it("sorts checks by actionable status and then name", () => {
    const sorted = sortCiChecks([
      check("Test", "success"),
      check("Build", "failure"),
      check("Lint", "failure"),
      check("Format", "pending"),
    ]);

    expect(sorted.map((item) => item.name)).toEqual(["Build", "Lint", "Format", "Test"]);
  });

  it("labels each check status for display", () => {
    expect(ciCheckStatusLabel("success")).toBe("Passed");
    expect(ciCheckStatusLabel("failure")).toBe("Failing");
    expect(ciCheckStatusLabel("pending")).toBe("Running");
    expect(ciCheckStatusLabel("cancelled")).toBe("Cancelled");
    expect(ciCheckStatusLabel("skipped")).toBe("Skipped");
  });

  it("does not label a skipped check as Running (regression)", () => {
    // Pre-fix, both the GitLab plugin (`skipped`/`manual`) and the
    // GitHub plugin (`SKIPPED`/`NEUTRAL`) fell through to "pending",
    // and `ciCheckStatusLabel` rendered "pending" as "Running" — so a
    // merged PR's skipped check displayed a phantom Running spinner.
    expect(ciCheckStatusLabel("skipped")).not.toBe("Running");
  });

  it("counts skipped checks separately in the summary", () => {
    const summary = summarizeCiChecks([
      check("Lint", "success"),
      check("Skip-on-path", "skipped"),
      check("Manual-deploy", "skipped"),
    ]);
    expect(summary.skipped).toBe(2);
    expect(summary.passed).toBe(1);
    expect(summary.title).toBe("Checks passed");
  });

  it("derives sidebar CI state from checks when the aggregate status is absent", () => {
    expect(deriveScmCiState(null, [check("Lint", "failure")])).toBe("failure");
    expect(deriveScmCiState(null, [check("Test", "pending")])).toBe("pending");
    expect(deriveScmCiState(null, [check("Build", "success")])).toBe("success");
    expect(deriveScmCiState(null, [check("Build", "cancelled")])).toBeNull();
    // Skipped-only counts as success at the aggregate level (the only
    // checks present "didn't run by design", which is not a failure).
    expect(deriveScmCiState(null, [check("Build", "skipped")])).toBe("success");
  });

  it("prefers the aggregate PR CI status over checks", () => {
    expect(deriveScmCiState("success", [check("Lint", "failure")])).toBe("success");
  });

  it("sorts skipped after cancelled but before success", () => {
    const sorted = sortCiChecks([
      check("Test", "success"),
      check("Skipped-job", "skipped"),
      check("Cancelled-job", "cancelled"),
      check("Build", "failure"),
      check("Format", "pending"),
    ]);
    expect(sorted.map((item) => item.name)).toEqual([
      "Build",
      "Format",
      "Cancelled-job",
      "Skipped-job",
      "Test",
    ]);
  });
});
