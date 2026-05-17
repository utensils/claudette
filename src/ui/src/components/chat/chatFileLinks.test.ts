import { describe, expect, it } from "vitest";

import { monacoFileLinkPath, monacoFileLinkTarget } from "./chatFileLinks";

describe("monacoFileLinkPath", () => {
  it("keeps workspace-relative files for Monaco", () => {
    expect(monacoFileLinkPath("README.md", "/repo")).toBe("README.md");
    expect(monacoFileLinkPath("./src/main.rs", "/repo")).toBe("src/main.rs");
  });

  it("relativizes absolute paths inside the worktree", () => {
    expect(monacoFileLinkPath("/repo/src/main.rs", "/repo")).toBe("src/main.rs");
    expect(monacoFileLinkPath("C:\\repo\\src\\main.rs", "C:\\repo")).toBe(
      "src/main.rs",
    );
  });

  it("preserves line and range targets separately from the file tab path", () => {
    expect(monacoFileLinkTarget("/repo/src/main.rs:7:2-9:4", "/repo")).toEqual({
      path: "src/main.rs",
      revealTarget: {
        startLine: 7,
        startColumn: 2,
        endLine: 9,
        endColumn: 4,
      },
    });
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

  it("resolves cross-worktree Claudette paths to the equivalent file in the current worktree", () => {
    // Plan / chat authored under one workspace mentions an absolute path
    // that points into a sibling worktree of the same repo. The current
    // worktree prefix doesn't match, so relativizePath alone leaves the
    // path absolute — we'd previously bail and let the OS opener take
    // over. Same project ⇒ identical file layout ⇒ the workspace-relative
    // tail opens the same logical file in this worktree's Monaco.
    expect(
      monacoFileLinkPath(
        "/Users/me/.claudette/workspaces/Claudette/cosmic-birch/src/main.rs",
        "/Users/me/.claudette/workspaces/Claudette/jolly-ranunculus",
      ),
    ).toBe("src/main.rs");
    expect(
      monacoFileLinkTarget(
        "/Users/me/.claudette/workspaces/Claudette/cosmic-birch/src/ui/src/components/chat/composer/OverflowMenu.tsx:42:5",
        "/Users/me/.claudette/workspaces/Claudette/jolly-ranunculus",
      ),
    ).toEqual({
      path: "src/ui/src/components/chat/composer/OverflowMenu.tsx",
      revealTarget: {
        startLine: 42,
        startColumn: 5,
        endLine: 42,
        endColumn: undefined,
      },
    });
  });

  it("does not match absolute paths outside any Claudette worktree", () => {
    // Genuine out-of-project absolute paths still bail so the OS opener
    // handles them. The Claudette-pattern shortcut must not turn random
    // absolute paths into in-workspace links.
    expect(
      monacoFileLinkPath(
        "/Users/me/Documents/notes.md",
        "/Users/me/.claudette/workspaces/Claudette/jolly-ranunculus",
      ),
    ).toBeNull();
    expect(
      monacoFileLinkPath(
        "/var/log/system.log",
        "/Users/me/.claudette/workspaces/Claudette/jolly-ranunculus",
      ),
    ).toBeNull();
  });

  it("rejects cross-worktree paths whose tail contains parent traversal", () => {
    // A traversal-shaped path under the Claudette workspaces dir would
    // otherwise extract to `../other.rs` and bypass the existing
    // `..`/`../` guard on the non-cross-worktree branch.
    expect(
      monacoFileLinkPath(
        "/Users/me/.claudette/workspaces/Claudette/cosmic-birch/../etc/passwd",
        "/Users/me/.claudette/workspaces/Claudette/jolly-ranunculus",
      ),
    ).toBeNull();
  });
});
