import { describe, expect, it } from "vitest";
import { selectGutterRevision, shouldFetchMergeBase } from "./useGitGutter";

const SHA = "a".repeat(40);

describe("selectGutterRevision", () => {
  it("returns 'HEAD' when the setting is 'head'", () => {
    expect(selectGutterRevision("head", null)).toBe("HEAD");
    expect(selectGutterRevision("head", SHA)).toBe("HEAD");
  });

  it("returns the cached merge-base SHA when the setting is 'merge_base' and one is cached", () => {
    expect(selectGutterRevision("merge_base", SHA)).toBe(SHA);
  });

  it("returns null when the setting is 'merge_base' and no SHA is cached (caller waits)", () => {
    expect(selectGutterRevision("merge_base", null)).toBeNull();
  });
});

describe("shouldFetchMergeBase", () => {
  it("does not fire when the setting is 'head'", () => {
    expect(shouldFetchMergeBase("head", null)).toBe(false);
    expect(shouldFetchMergeBase("head", SHA)).toBe(false);
  });

  it("fires only when 'merge_base' is selected and no SHA is cached", () => {
    expect(shouldFetchMergeBase("merge_base", null)).toBe(true);
    expect(shouldFetchMergeBase("merge_base", SHA)).toBe(false);
  });
});
