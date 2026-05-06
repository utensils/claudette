import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "./useAppStore";
import { snapshotRemovedFilePath } from "./slices/fileTreeSlice";

const WS = "workspace-a";

function reset() {
  useAppStore.setState({
    fileTabsByWorkspace: {},
    activeFileTabByWorkspace: {},
    fileBuffers: {},
    allFilesExpandedDirsByWorkspace: {},
    allFilesSelectedPathByWorkspace: {},
    tabOrderByWorkspace: {},
    filePathUndoStackByWorkspace: {},
  });
}

function openLoadedFile(path: string, content = "saved") {
  useAppStore.getState().openFileTab(WS, path);
  useAppStore.getState().setFileBufferLoaded(WS, path, {
    baseline: content,
    isBinary: false,
    sizeBytes: content.length,
    truncated: false,
    imageBytesB64: null,
  });
}

describe("file path store updates", () => {
  beforeEach(reset);

  it("renames an open file tab and preserves its buffer", () => {
    openLoadedFile("src/app.ts");
    useAppStore.getState().setFileBufferContent(WS, "src/app.ts", "dirty");
    useAppStore.setState({
      tabOrderByWorkspace: { [WS]: [{ kind: "file", path: "src/app.ts" }] },
    });

    useAppStore
      .getState()
      .renameFilePathInWorkspace(WS, "src/app.ts", "src/main.ts", false);

    const state = useAppStore.getState();
    expect(state.fileTabsByWorkspace[WS]).toEqual(["src/main.ts"]);
    expect(state.activeFileTabByWorkspace[WS]).toBe("src/main.ts");
    expect(state.fileBuffers[`${WS}:src/app.ts`]).toBeUndefined();
    expect(state.fileBuffers[`${WS}:src/main.ts`].buffer).toBe("dirty");
    expect(state.tabOrderByWorkspace[WS]).toEqual([
      { kind: "file", path: "src/main.ts" },
    ]);
  });

  it("renames child file tabs when a folder is renamed", () => {
    openLoadedFile("src/components/Button.tsx");
    openLoadedFile("src/components/Card.tsx");
    openLoadedFile("src/App.tsx");
    useAppStore.setState({
      allFilesExpandedDirsByWorkspace: { [WS]: { "src/components/": true } },
      allFilesSelectedPathByWorkspace: { [WS]: "src/components/" },
    });

    useAppStore
      .getState()
      .renameFilePathInWorkspace(WS, "src/components", "src/widgets", true);

    const state = useAppStore.getState();
    expect(state.fileTabsByWorkspace[WS]).toEqual([
      "src/widgets/Button.tsx",
      "src/widgets/Card.tsx",
      "src/App.tsx",
    ]);
    expect(state.fileBuffers[`${WS}:src/widgets/Button.tsx`]).toBeDefined();
    expect(state.fileBuffers[`${WS}:src/components/Button.tsx`]).toBeUndefined();
    expect(state.allFilesExpandedDirsByWorkspace[WS]).toEqual({
      "src/widgets/": true,
    });
    expect(state.allFilesSelectedPathByWorkspace[WS]).toBe("src/widgets/");
  });

  it("removes an open file tab and picks an adjacent active tab", () => {
    openLoadedFile("a.ts");
    openLoadedFile("b.ts");
    openLoadedFile("c.ts");
    useAppStore.getState().selectFileTab(WS, "b.ts");

    useAppStore.getState().removeFilePathFromWorkspace(WS, "b.ts", false);

    const state = useAppStore.getState();
    expect(state.fileTabsByWorkspace[WS]).toEqual(["a.ts", "c.ts"]);
    expect(state.activeFileTabByWorkspace[WS]).toBe("a.ts");
    expect(state.fileBuffers[`${WS}:b.ts`]).toBeUndefined();
  });

  it("removes all child file tabs when a folder is deleted", () => {
    openLoadedFile("src/components/Button.tsx");
    openLoadedFile("src/components/Card.tsx");
    openLoadedFile("src/App.tsx");
    useAppStore.setState({
      tabOrderByWorkspace: {
        [WS]: [
          { kind: "file", path: "src/components/Button.tsx" },
          { kind: "file", path: "src/App.tsx" },
        ],
      },
    });

    useAppStore.getState().removeFilePathFromWorkspace(WS, "src/components", true);

    const state = useAppStore.getState();
    expect(state.fileTabsByWorkspace[WS]).toEqual(["src/App.tsx"]);
    expect(state.fileBuffers[`${WS}:src/components/Button.tsx`]).toBeUndefined();
    expect(state.fileBuffers[`${WS}:src/App.tsx`]).toBeDefined();
    expect(state.tabOrderByWorkspace[WS]).toEqual([
      { kind: "file", path: "src/App.tsx" },
    ]);
  });

  it("restores removed file tabs and buffers from a delete snapshot", () => {
    openLoadedFile("src/components/Button.tsx", "button");
    openLoadedFile("src/components/Card.tsx", "card");
    openLoadedFile("src/App.tsx", "app");
    useAppStore.getState().setFileBufferContent(
      WS,
      "src/components/Button.tsx",
      "dirty button",
    );
    useAppStore.setState({
      allFilesExpandedDirsByWorkspace: { [WS]: { "src/components/": true } },
      allFilesSelectedPathByWorkspace: { [WS]: "src/components/Button.tsx" },
      tabOrderByWorkspace: {
        [WS]: [
          { kind: "file", path: "src/components/Button.tsx" },
          { kind: "file", path: "src/App.tsx" },
        ],
      },
    });
    const snapshot = snapshotRemovedFilePath(
      useAppStore.getState(),
      WS,
      "src/components",
      true,
    );

    useAppStore.getState().removeFilePathFromWorkspace(WS, "src/components", true);
    useAppStore.getState().restoreRemovedFilePathInWorkspace(WS, snapshot);

    const state = useAppStore.getState();
    expect(state.fileTabsByWorkspace[WS]).toEqual([
      "src/App.tsx",
      "src/components/Button.tsx",
      "src/components/Card.tsx",
    ]);
    expect(state.activeFileTabByWorkspace[WS]).toBe("src/App.tsx");
    expect(state.fileBuffers[`${WS}:src/components/Button.tsx`].buffer).toBe(
      "dirty button",
    );
    expect(state.allFilesSelectedPathByWorkspace[WS]).toBe(
      "src/components/Button.tsx",
    );
    expect(state.allFilesExpandedDirsByWorkspace[WS]).toEqual({
      "src/components/": true,
    });
    expect(state.tabOrderByWorkspace[WS]).toEqual([
      { kind: "file", path: "src/App.tsx" },
      { kind: "file", path: "src/components/Button.tsx" },
    ]);
  });

  it("pushes and pops file operation undo entries", () => {
    useAppStore.getState().pushFilePathUndoOperation(WS, {
      kind: "rename",
      oldPath: "a.ts",
      newPath: "b.ts",
      isDirectory: false,
    });

    expect(useAppStore.getState().filePathUndoStackByWorkspace[WS]).toHaveLength(1);
    useAppStore.getState().popFilePathUndoOperation(WS);
    expect(useAppStore.getState().filePathUndoStackByWorkspace[WS]).toEqual([]);
  });
});
