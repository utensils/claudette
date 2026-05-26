// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FileEditorViewState } from "../../stores/slices/fileTreeSlice";
import { MonacoEditor } from "./MonacoEditor";

const monacoMock = vi.hoisted(() => {
  const savedViewState = {
    cursorState: [],
    viewState: {
      scrollTop: 720,
      scrollTopWithoutViewZones: 720,
      scrollLeft: 0,
      firstPosition: { lineNumber: 24, column: 1 },
      firstPositionDeltaTop: 0,
    },
    contributionsState: {},
  } satisfies FileEditorViewState;

  const editor = {
    addCommand: vi.fn(),
    createDecorationsCollection: vi.fn(() => ({ clear: vi.fn(), set: vi.fn() })),
    restoreViewState: vi.fn(),
    saveViewState: vi.fn(() => savedViewState),
    updateOptions: vi.fn(),
  };

  const monaco = {
    KeyCode: {
      KeyP: 1,
      KeyS: 2,
      KeyT: 3,
      KeyW: 4,
    },
    KeyMod: {
      CtrlCmd: 1 << 8,
      Shift: 1 << 9,
    },
    editor: {
      OverviewRulerLane: { Center: 2 },
    },
  };

  return { editor, monaco, savedViewState };
});

vi.mock("./monacoSetup", () => ({}));
vi.mock("./monacoTheme", () => ({
  applyMonacoTheme: vi.fn(),
  initMonacoThemeSync: vi.fn(() => vi.fn()),
}));
vi.mock("./useGitGutter", () => ({
  useGitGutter: vi.fn(),
}));
vi.mock("../../hotkeys/contextActions", () => ({
  executeCloseTab: vi.fn(),
  executeNewTab: vi.fn(),
}));
vi.mock("@monaco-editor/react", () => ({
  default: ({
    beforeMount,
    onMount,
  }: {
    beforeMount?: (monaco: typeof monacoMock.monaco) => void;
    onMount?: (
      editor: typeof monacoMock.editor,
      monaco: typeof monacoMock.monaco,
    ) => void;
  }) => {
    beforeMount?.(monacoMock.monaco);
    onMount?.(monacoMock.editor, monacoMock.monaco);
    return <div data-testid="monaco-editor" />;
  },
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
const containers: HTMLElement[] = [];

async function render(node: ReactNode): Promise<Root> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  containers.push(container);
  await act(async () => {
    root.render(node);
  });
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) {
    await act(async () => root.unmount());
  }
  for (const container of containers.splice(0)) container.remove();
  vi.clearAllMocks();
});

describe("MonacoEditor view state", () => {
  it("restores saved view state on mount and captures the next state on unmount", async () => {
    const previousViewState = {
      cursorState: [],
      viewState: {
        scrollTop: 360,
        scrollTopWithoutViewZones: 360,
        scrollLeft: 0,
        firstPosition: { lineNumber: 12, column: 1 },
        firstPositionDeltaTop: 0,
      },
      contributionsState: {},
    } satisfies FileEditorViewState;
    const onEditorViewStateChange = vi.fn();

    const root = await render(
      <MonacoEditor
        workspaceId="ws-1"
        value={"one\ntwo\nthree"}
        filename="src/app.ts"
        isSymlink={false}
        readOnly={false}
        editorViewState={previousViewState}
        onChange={vi.fn()}
        onEditorViewStateChange={onEditorViewStateChange}
      />,
    );

    expect(monacoMock.editor.restoreViewState).toHaveBeenCalledWith(
      previousViewState,
    );

    await act(async () => root.unmount());
    roots.splice(roots.indexOf(root), 1);

    expect(monacoMock.editor.saveViewState).toHaveBeenCalled();
    expect(onEditorViewStateChange).toHaveBeenCalledWith(
      monacoMock.savedViewState,
    );
  });
});
