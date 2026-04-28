import { describe, it, expect } from "vitest";
import { relativizePath } from "./toolSummary";

describe("relativizePath", () => {
  it("returns the original text when root is null/undefined/empty", () => {
    expect(relativizePath("/abs/path/file.ts", null)).toBe("/abs/path/file.ts");
    expect(relativizePath("/abs/path/file.ts", undefined)).toBe("/abs/path/file.ts");
    expect(relativizePath("/abs/path/file.ts", "")).toBe("/abs/path/file.ts");
  });

  it("returns the original text when text is empty", () => {
    expect(relativizePath("", "/abs/path")).toBe("");
  });

  it("strips a POSIX root prefix", () => {
    expect(
      relativizePath("/Users/me/project/src/app.tsx", "/Users/me/project")
    ).toBe("src/app.tsx");
  });

  it("strips a POSIX root prefix even when root has a trailing slash", () => {
    expect(
      relativizePath("/Users/me/project/src/app.tsx", "/Users/me/project/")
    ).toBe("src/app.tsx");
  });

  it("strips a Windows root prefix with backslashes", () => {
    expect(
      relativizePath("C:\\Users\\me\\project\\src\\app.tsx", "C:\\Users\\me\\project")
    ).toBe("src\\app.tsx");
  });

  it("strips a Windows root prefix with trailing backslash", () => {
    expect(
      relativizePath("C:\\Users\\me\\project\\src\\app.tsx", "C:\\Users\\me\\project\\")
    ).toBe("src\\app.tsx");
  });

  it("relativizes paths embedded mid-string (Grep `pattern in <path>` form)", () => {
    expect(
      relativizePath(
        "sortBy|orderBy in /Users/me/project/src",
        "/Users/me/project"
      )
    ).toBe("sortBy|orderBy in src");
  });

  it("leaves text unchanged when the root does not appear", () => {
    expect(
      relativizePath("/some/other/path/file.ts", "/Users/me/project")
    ).toBe("/some/other/path/file.ts");
  });

  it("strips multiple occurrences of the root prefix", () => {
    expect(
      relativizePath(
        "moved /Users/me/project/a.ts to /Users/me/project/b.ts",
        "/Users/me/project"
      )
    ).toBe("moved a.ts to b.ts");
  });

  it("does not strip everything when root is just a separator", () => {
    expect(relativizePath("/a/b/c", "/")).toBe("/a/b/c");
    expect(relativizePath("\\a\\b\\c", "\\")).toBe("\\a\\b\\c");
  });
});
