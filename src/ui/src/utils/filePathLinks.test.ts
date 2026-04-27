import { describe, it, expect } from "vitest";

import {
  decodeFilePathHref,
  detectFilePaths,
  encodeFilePathHref,
  FILE_PATH_SCHEME,
} from "./filePathLinks";

describe("detectFilePaths — POSIX", () => {
  it("matches a bare absolute path", () => {
    expect(detectFilePaths("see /tmp/people.csv next")).toEqual([
      { start: 4, end: 19, path: "/tmp/people.csv" },
    ]);
  });

  it("matches a home-relative path", () => {
    expect(detectFilePaths("opened ~/Downloads/foo.csv earlier")).toEqual([
      { start: 7, end: 26, path: "~/Downloads/foo.csv" },
    ]);
  });

  it("strips a trailing period from a sentence-ending path", () => {
    const matches = detectFilePaths("Saved to /tmp/people.csv.");
    expect(matches).toEqual([
      { start: 9, end: 24, path: "/tmp/people.csv" },
    ]);
  });

  it("strips trailing parens/brackets/quotes", () => {
    expect(detectFilePaths("(see /tmp/foo)")).toEqual([
      { start: 5, end: 13, path: "/tmp/foo" },
    ]);
    expect(detectFilePaths("'/tmp/bar'")).toEqual([
      { start: 1, end: 9, path: "/tmp/bar" },
    ]);
  });
});

describe("detectFilePaths — Windows", () => {
  it("matches a backslash drive path", () => {
    expect(detectFilePaths("open C:\\Users\\foo\\bar.csv now")).toEqual([
      { start: 5, end: 25, path: "C:\\Users\\foo\\bar.csv" },
    ]);
  });

  it("matches a forward-slash drive path", () => {
    expect(detectFilePaths("open C:/Users/foo/bar.csv now")).toEqual([
      { start: 5, end: 25, path: "C:/Users/foo/bar.csv" },
    ]);
  });

  it("matches a UNC share", () => {
    const matches = detectFilePaths("see \\\\server\\share\\file.txt later");
    expect(matches).toEqual([
      { start: 4, end: 27, path: "\\\\server\\share\\file.txt" },
    ]);
  });

  it("does not match a single backslash sequence", () => {
    expect(detectFilePaths("escaped \\n inside")).toEqual([]);
  });
});

describe("detectFilePaths — non-matches and false-positive guards", () => {
  it("ignores URLs", () => {
    expect(detectFilePaths("see https://example.com/path/to/foo here")).toEqual(
      [],
    );
  });

  it("ignores ssh-style and other scheme paths", () => {
    expect(detectFilePaths("git@github.com:owner/repo.git")).toEqual([]);
  });

  it("ignores relative paths inside prose", () => {
    expect(detectFilePaths("touch the foo/bar.csv file")).toEqual([]);
  });

  it("ignores too-short matches like '/a'", () => {
    expect(detectFilePaths("path is /a end")).toEqual([]);
  });

  it("returns multiple matches in a single string", () => {
    const text = "from /tmp/in.csv to C:\\out\\file.csv done";
    expect(detectFilePaths(text)).toEqual([
      { start: 5, end: 16, path: "/tmp/in.csv" },
      { start: 20, end: 35, path: "C:\\out\\file.csv" },
    ]);
  });

  it("ignores leading char that suggests middle-of-token", () => {
    // Preceded by a word char → not a path start
    expect(detectFilePaths("abc/def/ghi")).toEqual([]);
  });
});

describe("encode/decode round trip", () => {
  it("encodes spaces and decodes back", () => {
    const path = "/tmp/some path/file with spaces.csv";
    const href = encodeFilePathHref(path);
    expect(href.startsWith(FILE_PATH_SCHEME)).toBe(true);
    expect(decodeFilePathHref(href)).toBe(path);
  });

  it("encodes a Windows path losslessly", () => {
    const path = "C:\\Users\\jamesbrink\\Downloads\\foo.csv";
    expect(decodeFilePathHref(encodeFilePathHref(path))).toBe(path);
  });

  it("returns null for non-matching href", () => {
    expect(decodeFilePathHref("https://example.com")).toBeNull();
  });
});
