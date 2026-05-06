import { describe, expect, it, vi } from "vitest";
import {
  buildFileContextMenuItems,
  displayNameForPath,
  validatePathName,
  type FileContextTarget,
} from "./fileContextMenu";

function labelsFor(target: FileContextTarget): string[] {
  const noop = vi.fn();
  return buildFileContextMenuItems(target, {
    open: noop,
    reveal: noop,
    copyPath: noop,
    copyRelativePath: noop,
    rename: noop,
    delete: noop,
  }).flatMap((item) => (item.type === "separator" ? [] : [item.label]));
}

describe("displayNameForPath", () => {
  it("uses the final segment for files and directories", () => {
    expect(displayNameForPath("src/app.ts")).toBe("app.ts");
    expect(displayNameForPath("src/components/")).toBe("components");
  });
});

describe("buildFileContextMenuItems", () => {
  it("builds core file actions", () => {
    expect(
      labelsFor({ path: "src/app.ts", isDirectory: false, exists: true }),
    ).toEqual([
      "Open",
      "Reveal in File Manager",
      "Copy Path",
      "Copy Relative Path",
      "Rename…",
      "Delete",
    ]);
  });

  it("includes new file when the caller supports creation", () => {
    const noop = vi.fn();
    const labels = buildFileContextMenuItems(
      { path: "src/app.ts", isDirectory: false, exists: true },
      {
        newFile: noop,
        open: noop,
        reveal: noop,
        copyPath: noop,
        copyRelativePath: noop,
        rename: noop,
        delete: noop,
      },
    ).flatMap((item) => (item.type === "separator" ? [] : [item.label]));

    expect(labels[0]).toBe("New File");
  });

  it("labels directory open distinctly", () => {
    expect(
      labelsFor({ path: "src/components/", isDirectory: true, exists: true })[0],
    ).toBe("Open Folder");
  });

  it("keeps relative-path copy enabled for missing targets", () => {
    const items = buildFileContextMenuItems(
      { path: "src/deleted.ts", isDirectory: false, exists: false },
      {
        open: vi.fn(),
        reveal: vi.fn(),
        copyPath: vi.fn(),
        copyRelativePath: vi.fn(),
        rename: vi.fn(),
        delete: vi.fn(),
      },
    ).filter((item) => item.type !== "separator");

    expect(items.find((item) => item.label === "Open")?.disabled).toBe(true);
    expect(items.find((item) => item.label === "Copy Path")?.disabled).toBe(true);
    expect(items.find((item) => item.label === "Copy Relative Path")?.disabled).toBeFalsy();
    expect(items.find((item) => item.label === "Rename…")?.disabled).toBe(true);
    expect(items.find((item) => item.label === "Delete")?.disabled).toBe(true);
  });
});

describe("validatePathName", () => {
  it("accepts simple file and folder names", () => {
    expect(validatePathName("app.ts")).toBeNull();
    expect(validatePathName("components")).toBeNull();
  });

  it("rejects empty, reserved, and nested names", () => {
    expect(validatePathName("")).toBe("Name is required.");
    expect(validatePathName("   ")).toBe("Name is required.");
    expect(validatePathName(".")).toBe("That name is reserved.");
    expect(validatePathName("..")).toBe("That name is reserved.");
    expect(validatePathName("src/app.ts")).toBe(
      "Name cannot contain path separators.",
    );
    expect(validatePathName("src\\app.ts")).toBe(
      "Name cannot contain path separators.",
    );
    expect(validatePathName("bad\0name")).toBe(
      "Name cannot contain null bytes.",
    );
  });
});
