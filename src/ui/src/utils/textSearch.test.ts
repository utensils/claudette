import { describe, it, expect } from "vitest";
import { findAllRanges, splitByRanges } from "./textSearch";

describe("findAllRanges", () => {
  it("returns no matches for an empty needle", () => {
    expect(findAllRanges("hello world", "")).toEqual([]);
  });

  it("returns no matches for an empty haystack", () => {
    expect(findAllRanges("", "x")).toEqual([]);
  });

  it("finds a single occurrence", () => {
    expect(findAllRanges("hello world", "world")).toEqual([
      { start: 6, end: 11 },
    ]);
  });

  it("finds multiple occurrences", () => {
    expect(findAllRanges("foo bar foo bar foo", "foo")).toEqual([
      { start: 0, end: 3 },
      { start: 8, end: 11 },
      { start: 16, end: 19 },
    ]);
  });

  it("is case-insensitive", () => {
    expect(findAllRanges("Hello HELLO hello", "HeLLo")).toEqual([
      { start: 0, end: 5 },
      { start: 6, end: 11 },
      { start: 12, end: 17 },
    ]);
  });

  it("does not double-count overlapping matches", () => {
    // 'aa' inside 'aaaa' produces hits at 0 and 2, not 0/1/2.
    expect(findAllRanges("aaaa", "aa")).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });

  it("handles needle longer than haystack", () => {
    expect(findAllRanges("hi", "hello")).toEqual([]);
  });

  it("handles unicode characters", () => {
    expect(findAllRanges("café CAFÉ café", "café")).toEqual([
      { start: 0, end: 4 },
      // 'CAFÉ' lowercases to 'café' so the middle hit lands too.
      { start: 5, end: 9 },
      { start: 10, end: 14 },
    ]);
  });
});

describe("splitByRanges", () => {
  it("returns empty array for empty input", () => {
    expect(splitByRanges("", [])).toEqual([]);
  });

  it("returns a single text segment when there are no ranges", () => {
    expect(splitByRanges("hello world", [])).toEqual([
      { kind: "text", text: "hello world" },
    ]);
  });

  it("splits into text + match + text", () => {
    expect(
      splitByRanges("hello world", [{ start: 6, end: 11 }]),
    ).toEqual([
      { kind: "text", text: "hello " },
      { kind: "match", text: "world", rangeIndex: 0 },
    ]);
  });

  it("emits a leading match without an empty text segment", () => {
    expect(splitByRanges("hello", [{ start: 0, end: 5 }])).toEqual([
      { kind: "match", text: "hello", rangeIndex: 0 },
    ]);
  });

  it("interleaves multiple matches", () => {
    expect(
      splitByRanges("foo bar foo bar foo", [
        { start: 0, end: 3 },
        { start: 8, end: 11 },
        { start: 16, end: 19 },
      ]),
    ).toEqual([
      { kind: "match", text: "foo", rangeIndex: 0 },
      { kind: "text", text: " bar " },
      { kind: "match", text: "foo", rangeIndex: 1 },
      { kind: "text", text: " bar " },
      { kind: "match", text: "foo", rangeIndex: 2 },
    ]);
  });

  it("preserves rangeIndex even when ranges are passed in order", () => {
    const segments = splitByRanges("ab cd ef", [
      { start: 0, end: 2 },
      { start: 6, end: 8 },
    ]);
    const matches = segments.filter((s) => s.kind === "match");
    expect(matches).toEqual([
      { kind: "match", text: "ab", rangeIndex: 0 },
      { kind: "match", text: "ef", rangeIndex: 1 },
    ]);
  });
});
