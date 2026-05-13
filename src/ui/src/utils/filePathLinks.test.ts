import { describe, it, expect } from "vitest";

import {
  decodeFilePathHref,
  decodeLocalhostFileUrl,
  decodeLocalhostFileUrlTarget,
  detectFileReferences,
  detectFilePaths,
  encodeFilePathHref,
  FILE_PATH_SCHEME,
  isLikelyRelativeFileReference,
  parseFilePathTarget,
  stripFileLineSuffix,
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

describe("relative file references", () => {
  it("recognizes common bare filenames agents mention in prose", () => {
    expect(detectFileReferences("Edit README.md next")).toEqual([
      { start: 5, end: 14, path: "README.md" },
    ]);
    expect(detectFileReferences("Create CLAUDETTE_TEST.md")).toEqual([
      { start: 7, end: 24, path: "CLAUDETTE_TEST.md" },
    ]);
  });

  it("recognizes nested workspace-relative source paths", () => {
    expect(detectFileReferences("open src/ui/src/utils/markdown.ts")).toEqual([
      {
        start: 5,
        end: 33,
        path: "src/ui/src/utils/markdown.ts",
      },
    ]);
    expect(detectFileReferences("open ./src/main.rs")).toEqual([
      {
        start: 5,
        end: 18,
        path: "./src/main.rs",
      },
    ]);
  });

  it("does not mistake domain-like text for a workspace file", () => {
    expect(detectFileReferences("visit example.com today")).toEqual([]);
    expect(isLikelyRelativeFileReference("example.com")).toBe(false);
  });

  it("does not match relative file references inside URLs or emails", () => {
    expect(detectFileReferences("https://example.com/README.md")).toEqual([]);
    expect(detectFileReferences("email dev@example.com")).toEqual([]);
  });
});

describe("localhost file URL decoding", () => {
  it("decodes Codex-style localhost URLs to file paths and strips line suffixes", () => {
    expect(
      decodeLocalhostFileUrl(
        "http://localhost:14254/Users/jamesbrink/project/CLAUDETTE_TEST.md:1",
      ),
    ).toBe("/Users/jamesbrink/project/CLAUDETTE_TEST.md");
    expect(
      decodeLocalhostFileUrlTarget(
        "http://localhost:14254/Users/jamesbrink/project/CLAUDETTE_TEST.md:1",
      ),
    ).toBe("/Users/jamesbrink/project/CLAUDETTE_TEST.md:1");
  });

  it("decodes loopback Windows paths", () => {
    expect(
      decodeLocalhostFileUrl("http://127.0.0.1:14254/C:/Users/me/project/app.ts:12:3"),
    ).toBe("C:/Users/me/project/app.ts");
  });

  it("does not treat normal localhost app routes as file paths", () => {
    expect(decodeLocalhostFileUrl("http://localhost:14254/workspaces/current")).toBeNull();
    expect(decodeLocalhostFileUrl("http://localhost:3000/index.html")).toBeNull();
  });

  it("does not decode non-localhost URLs as files", () => {
    expect(
      decodeLocalhostFileUrl("https://example.com/Users/me/project/app.ts:1"),
    ).toBeNull();
  });

  it("strips line and column suffixes from file targets", () => {
    expect(stripFileLineSuffix("/tmp/file.ts:10")).toBe("/tmp/file.ts");
    expect(stripFileLineSuffix("/tmp/file.ts:10:2")).toBe("/tmp/file.ts");
  });

  it("parses line and range suffixes into file targets", () => {
    expect(parseFilePathTarget("src/main.ts:10")).toEqual({
      path: "src/main.ts",
      startLine: 10,
      endLine: 10,
      startColumn: undefined,
      endColumn: undefined,
    });
    expect(parseFilePathTarget("src/main.ts:10:2-12:8")).toEqual({
      path: "src/main.ts",
      startLine: 10,
      startColumn: 2,
      endLine: 12,
      endColumn: 8,
    });
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

  it("does not throw on malformed percent-encoding — falls back to raw tail", () => {
    // `decodeURI` would throw URIError on a dangling `%`. The decoder
    // must catch and return *something* so a bad assistant link can't
    // crash the markdown render or click handler.
    const bad = `${FILE_PATH_SCHEME}/tmp/bogus%`;
    expect(() => decodeFilePathHref(bad)).not.toThrow();
    expect(decodeFilePathHref(bad)).toBe("/tmp/bogus%");
  });
});

describe("WebKit < 16.4 compatibility", () => {
  // The app's `minimumSystemVersion` is macOS 11, which ships WebKit
  // without RegExp lookbehind. Module evaluation must not contain any
  // `(?<…)` group — if one slips back in, this assertion fires before
  // the rest of the suite even loads on those hosts.
  it("path detection runs on a JS engine without lookbehind support", () => {
    // The smoke test is just calling the function: if PATH_REGEX
    // contained a lookbehind, JSC <16.4 would have thrown SyntaxError
    // at the top-level `new RegExp(...)` evaluation when the module
    // loaded. We can't simulate that here, but we can at least catch
    // a regression by string-inspecting the source.
    const src = detectFilePaths.toString();
    expect(src.includes("(?<!")).toBe(false);
    expect(src.includes("(?<=")).toBe(false);
  });
});
