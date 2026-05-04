import { describe, expect, it } from "vitest";
import { selectGutterRevision } from "./useGitGutter";

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
