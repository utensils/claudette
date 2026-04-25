import { describe, expect, it } from "vitest";

import {
  hasUltrathink,
  resolveUltrathinkEffort,
  splitUltrathinkText,
} from "./ultrathink";

describe("hasUltrathink", () => {
  it("matches the keyword case-insensitively as a whole word", () => {
    expect(hasUltrathink("please ultrathink this")).toBe(true);
    expect(hasUltrathink("please ULTRATHINK.")).toBe(true);
    expect(hasUltrathink("(ultrathink)")).toBe(true);
  });

  it("does not match the keyword inside a larger word", () => {
    expect(hasUltrathink("notultrathink")).toBe(false);
    expect(hasUltrathink("ultrathinking")).toBe(false);
  });
});

describe("splitUltrathinkText", () => {
  it("keeps surrounding text around multiple keyword occurrences", () => {
    expect(splitUltrathinkText("a ultrathink b ULTRATHINK c")).toEqual([
      { kind: "text", text: "a " },
      { kind: "ultrathink", text: "ultrathink" },
      { kind: "text", text: " b " },
      { kind: "ultrathink", text: "ULTRATHINK" },
      { kind: "text", text: " c" },
    ]);
  });

  it("returns a single plain part when the keyword is absent", () => {
    expect(splitUltrathinkText("plain prompt")).toEqual([
      { kind: "text", text: "plain prompt" },
    ]);
  });
});

describe("resolveUltrathinkEffort", () => {
  it("upgrades unset, auto, low, and medium effort to high for the current turn", () => {
    expect(resolveUltrathinkEffort("ultrathink", undefined)).toBe("high");
    expect(resolveUltrathinkEffort("ultrathink", "auto")).toBe("high");
    expect(resolveUltrathinkEffort("ultrathink", "low")).toBe("high");
    expect(resolveUltrathinkEffort("ultrathink", "medium")).toBe("high");
  });

  it("does not downgrade stronger effort settings", () => {
    expect(resolveUltrathinkEffort("ultrathink", "high")).toBe("high");
    expect(resolveUltrathinkEffort("ultrathink", "xhigh")).toBe("xhigh");
    expect(resolveUltrathinkEffort("ultrathink", "max")).toBe("max");
  });

  it("leaves effort unchanged when the keyword is absent", () => {
    expect(resolveUltrathinkEffort("ordinary prompt", undefined)).toBeUndefined();
    expect(resolveUltrathinkEffort("ordinary prompt", "low")).toBe("low");
  });
});
