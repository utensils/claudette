import { describe, expect, it } from "vitest";
import { shouldShowBanner } from "./cliInvocationBannerLogic";

describe("shouldShowBanner", () => {
  it("returns false when invocation is null", () => {
    expect(shouldShowBanner(null)).toBe(false);
  });

  it("returns false when invocation is an empty string", () => {
    expect(shouldShowBanner("")).toBe(false);
  });

  it("returns false when invocation is whitespace only", () => {
    expect(shouldShowBanner("   ")).toBe(false);
  });

  it("returns true on a real invocation string", () => {
    expect(
      shouldShowBanner("/bin/claude --print --session-id abc <prompt>"),
    ).toBe(true);
  });
});
