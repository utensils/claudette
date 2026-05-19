// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../stores/useAppStore";
import type { FileEntry } from "../../services/tauri";
import { FileTree } from "./FileTree";

const WS = "file-tree-active-ws";

const entries: FileEntry[] = [
  { path: "src/foo/bar.rs", is_directory: false },
  { path: "src/foo/baz.rs", is_directory: false },
];

const roots: Root[] = [];
const containers: HTMLElement[] = [];
const scrolledRows: string[] = [];
const originalScrollIntoView = Element.prototype.scrollIntoView;

function treeNode(activeFilePath: string | null, treeEntries = entries) {
  return (
    <FileTree
      workspaceId={WS}
      entries={treeEntries}
      activeFilePath={activeFilePath}
      onActivateFile={() => {}}
      onActivateDiff={() => {}}
      onContextMenu={() => {}}
      creatingParentPath={null}
      onCreateCommit={() => Promise.resolve(true)}
      onCreateCancel={() => {}}
      focusRequest={0}
      renamingPath={null}
      onRenameCommit={() => Promise.resolve(true)}
      onRenameCancel={() => {}}
    />
  );
}

async function renderTree(activeFilePath: string | null): Promise<{
  container: HTMLElement;
  root: Root;
}> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  containers.push(container);

  await act(async () => {
    root.render(treeNode(activeFilePath));
  });

  return { container, root };
}

beforeEach(() => {
  scrolledRows.length = 0;
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(function (this: Element, _options?: ScrollIntoViewOptions) {
      scrolledRows.push(this.textContent ?? "");
    }),
  });
  useAppStore.setState({
    allFilesExpandedDirsByWorkspace: {
      [WS]: { "src/": true, "src/foo/": true },
    },
    allFilesSelectedPathByWorkspace: {},
  });
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) {
    await act(async () => root.unmount());
  }
  for (const container of containers.splice(0)) container.remove();
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: originalScrollIntoView,
  });
});

describe("FileTree active file reveal", () => {
  it("marks the active file row and scrolls it into view", async () => {
    const { container } = await renderTree("src/foo/bar.rs");

    const activeRow = container.querySelector('[aria-current="true"]');
    expect(activeRow?.textContent).toContain("bar.rs");
    expect(scrolledRows.some((row) => row.includes("bar.rs"))).toBe(true);

    const expandedRows = Array.from(
      container.querySelectorAll('[aria-expanded="true"]'),
    ).map((row) => row.textContent ?? "");
    expect(expandedRows.some((row) => row.includes("src"))).toBe(true);
    expect(expandedRows.some((row) => row.includes("foo"))).toBe(true);
  });

  it("does not re-scroll the same active file on routine tree refreshes", async () => {
    const { root } = await renderTree("src/foo/bar.rs");
    expect(scrolledRows.some((row) => row.includes("bar.rs"))).toBe(true);
    scrolledRows.length = 0;

    await act(async () => {
      root.render(
        treeNode("src/foo/bar.rs", [
          ...entries,
          { path: "src/foo/qux.rs", is_directory: false },
        ]),
      );
    });

    expect(scrolledRows).toEqual([]);
  });
});
