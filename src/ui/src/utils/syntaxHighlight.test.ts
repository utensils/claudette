import { describe, expect, it } from "vitest";
import { highlightLine, languageForFile } from "./syntaxHighlight";

describe("languageForFile", () => {
  it("returns null for null/undefined/empty", () => {
    expect(languageForFile(null)).toBeNull();
    expect(languageForFile(undefined)).toBeNull();
    expect(languageForFile("")).toBeNull();
  });

  it("detects by full filename (case-insensitive)", () => {
    expect(languageForFile("Dockerfile")).toBe("dockerfile");
    expect(languageForFile("dockerfile")).toBe("dockerfile");
    expect(languageForFile("Makefile")).toBe("makefile");
    expect(languageForFile("CMakeLists.txt")).toBe("cmake");
    expect(languageForFile("cmakelists.txt")).toBe("cmake");
  });

  it("detects by extension", () => {
    expect(languageForFile("foo.rs")).toBe("rust");
    expect(languageForFile("foo.ts")).toBe("typescript");
    expect(languageForFile("foo.tsx")).toBe("typescript");
    expect(languageForFile("foo.py")).toBe("python");
    expect(languageForFile("foo.go")).toBe("go");
    expect(languageForFile("foo.js")).toBe("javascript");
    expect(languageForFile("foo.json")).toBe("json");
    expect(languageForFile("foo.toml")).toBe("ini");
    expect(languageForFile("foo.yaml")).toBe("yaml");
    expect(languageForFile("foo.yml")).toBe("yaml");
    expect(languageForFile("foo.sh")).toBe("bash");
    expect(languageForFile("foo.css")).toBe("css");
    expect(languageForFile("foo.html")).toBe("xml");
  });

  it("uses the basename from a full path", () => {
    expect(languageForFile("src/lib/main.rs")).toBe("rust");
    expect(languageForFile("/home/user/project/Dockerfile")).toBe("dockerfile");
  });

  it("returns null for unknown extensions", () => {
    expect(languageForFile("foo.unknown")).toBeNull();
    expect(languageForFile("foo.xyz123")).toBeNull();
    expect(languageForFile("noextension")).toBeNull();
  });
});

describe("highlightLine", () => {
  it("returns null when language is null", () => {
    expect(highlightLine("const x = 1;", null)).toBeNull();
  });

  it("returns null for empty content", () => {
    expect(highlightLine("", "typescript")).toBeNull();
  });

  it("returns null for an unknown language", () => {
    expect(highlightLine("hello", "notareallanguage")).toBeNull();
  });

  it("returns highlighted HTML for a known language", () => {
    const result = highlightLine("const x = 1;", "typescript");
    expect(result).not.toBeNull();
    expect(result).toContain("hljs");
  });
});
