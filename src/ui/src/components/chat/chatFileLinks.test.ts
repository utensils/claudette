import { describe, expect, it } from "vitest";

import { monacoFileLinkPath } from "./chatFileLinks";

describe("monacoFileLinkPath", () => {
  it("keeps workspace-relative files for Monaco", () => {
    expect(monacoFileLinkPath("README.md", "/repo")).toBe("README.md");
    expect(monacoFileLinkPath("./src/main.rs", "/repo")).toBe("src/main.rs");
  });

  it("relativizes absolute paths inside the worktree", () => {
    expect(monacoFileLinkPath("/repo/src/main.rs", "/repo")).toBe("src/main.rs");
  });

  it("rejects absolute and home-relative paths so native fallback can handle them", () => {
    expect(monacoFileLinkPath("/tmp/report.md", "/repo")).toBeNull();
    expect(monacoFileLinkPath("C:\\Users\\me\\report.md", "/repo")).toBeNull();
    expect(monacoFileLinkPath("~/Downloads/report.md", "/repo")).toBeNull();
    expect(monacoFileLinkPath("~\\Downloads\\report.md", "/repo")).toBeNull();
    expect(monacoFileLinkPath("~", "/repo")).toBeNull();
  });

  it("rejects parent-directory traversal", () => {
    expect(monacoFileLinkPath("../README.md", "/repo")).toBeNull();
    expect(monacoFileLinkPath("..\\README.md", "/repo")).toBeNull();
  });
});
