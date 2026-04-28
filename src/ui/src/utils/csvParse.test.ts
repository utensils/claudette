import { describe, it, expect } from "vitest";

import { countCsvRows, parseCsv } from "./csvParse";

describe("parseCsv", () => {
  it("splits a simple comma-separated row", () => {
    expect(parseCsv("a,b,c\n1,2,3\n")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("handles CRLF line endings", () => {
    expect(parseCsv("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("respects quoted fields containing commas", () => {
    expect(parseCsv('name,note\n"Smith, J.",hi\n')).toEqual([
      ["name", "note"],
      ["Smith, J.", "hi"],
    ]);
  });

  it("handles escaped quotes inside a quoted field", () => {
    expect(parseCsv('a,b\n"he said ""hi""",x\n')).toEqual([
      ["a", "b"],
      ['he said "hi"', "x"],
    ]);
  });

  it("preserves newlines inside quoted fields", () => {
    expect(parseCsv('a,b\n"line1\nline2",x\n')).toEqual([
      ["a", "b"],
      ["line1\nline2", "x"],
    ]);
  });

  it("flushes a trailing row without a newline", () => {
    expect(parseCsv("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("respects maxRows", () => {
    const text = "a\n1\n2\n3\n4\n5\n";
    const got = parseCsv(text, 3);
    expect(got).toEqual([["a"], ["1"], ["2"]]);
  });

  it("ignores blank physical lines anywhere in the input", () => {
    // Documented contract: blank lines (no commas, no content) are
    // skipped wherever they appear, not just at EOF.
    expect(parseCsv("a\n\n1\n\n2\n")).toEqual([["a"], ["1"], ["2"]]);
  });
});

describe("countCsvRows", () => {
  it("counts rows without a trailing newline", () => {
    expect(countCsvRows("a\n1\n2")).toBe(3);
  });

  it("counts rows with a trailing newline", () => {
    expect(countCsvRows("a\n1\n2\n")).toBe(3);
  });

  it("treats CRLF as one row terminator", () => {
    expect(countCsvRows("a\r\n1\r\n2\r\n")).toBe(3);
  });

  it("returns 0 for empty input", () => {
    expect(countCsvRows("")).toBe(0);
  });

  it("does not treat newlines inside quoted fields as row terminators", () => {
    const text = 'a,b\n"line1\nline2",x\n3,4\n';
    expect(countCsvRows(text)).toBe(3);
    expect(parseCsv(text)).toEqual([
      ["a", "b"],
      ["line1\nline2", "x"],
      ["3", "4"],
    ]);
  });

  it("skips blank physical lines wherever they appear (mirrors parseCsv)", () => {
    const text = "a\n\n1\n\n\n2\n";
    expect(countCsvRows(text)).toBe(3);
    expect(parseCsv(text)).toEqual([["a"], ["1"], ["2"]]);
  });

  it("counts a row with only commas as non-blank", () => {
    expect(countCsvRows(",,\n")).toBe(1);
    expect(parseCsv(",,\n")).toEqual([["", "", ""]]);
  });

  it("handles escaped quotes inside a quoted field without overcounting", () => {
    const text = 'a\n"he said ""hi""\nstill quoted",b\n';
    expect(countCsvRows(text)).toBe(2);
    expect(parseCsv(text)).toEqual([
      ["a"],
      ['he said "hi"\nstill quoted', "b"],
    ]);
  });
});
