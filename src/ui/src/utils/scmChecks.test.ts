import { describe, expect, it } from "vitest";
import type { CiCheck } from "../types/plugin";
import { ciCheckStatusLabel, sortCiChecks, summarizeCiChecks } from "./scmChecks";

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
  });
});
