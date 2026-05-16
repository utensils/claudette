import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  ancestorDirs,
  buildEditorActions,
  joinWorktreePath,
  type EditorActionsDeps,
} from "./useEditorActions";

interface FakeEditor {
  getAction: ReturnType<typeof vi.fn>;
  trigger: ReturnType<typeof vi.fn>;
}

function makeFakeEditor(): FakeEditor {
  const action = {
    run: vi.fn().mockResolvedValue(undefined),
  };
  return {
    getAction: vi.fn().mockReturnValue(action),
    trigger: vi.fn(),
  };
}

function makeDeps(overrides: Partial<EditorActionsDeps> = {}): EditorActionsDeps {
  const fake = makeFakeEditor();
  return {
    workspaceId: "ws-1",
    path: "src/components/Foo.tsx",
    // The pure builder accepts `IStandaloneCodeEditor | null` but only
    // ever touches `getAction` and `trigger`. Casting through `unknown`
    // gives us a minimal fake without dragging in a real Monaco type.
    editor: fake as unknown as EditorActionsDeps["editor"],
    onSave: vi.fn(),
    onCloseTab: vi.fn(),
    getBaseline: vi.fn().mockReturnValue("// baseline"),
    setFileBufferContent: vi.fn(),
    // Below, the fake editor's getAction is used for Monaco-action
    // dispatches. Copy-Contents reads getModel().getValue() instead, so
    // we override `editor` in the dedicated copy-contents test.
    setAllFilesSelectedPath: vi.fn(),
    setAllFilesDirExpanded: vi.fn(),
    rightSidebarVisible: false,
    showRightSidebar: vi.fn(),
    setRightSidebarTab: vi.fn(),
    openCommandPaletteFileMode: vi.fn(),
    wordWrap: true,
    setWordWrap: vi.fn(),
    minimap: false,
    setMinimap: vi.fn(),
    lineNumbers: true,
    setLineNumbers: vi.fn(),
    fontZoom: 1,
    setFontZoom: vi.fn(),
    persistSetting: vi.fn().mockResolvedValue(undefined),
    worktreePath: "/Users/jane/repos/myproj/.worktrees/feature",
    writeToClipboard: vi.fn().mockResolvedValue(undefined),
    addToast: vi.fn(),
    ...overrides,
  };
}

describe("joinWorktreePath", () => {
  it("joins a workspace root with a relative path", () => {
    expect(joinWorktreePath("/a/b", "src/x.ts")).toBe("/a/b/src/x.ts");
  });
  it("strips a trailing slash off the root", () => {
    expect(joinWorktreePath("/a/b/", "src/x.ts")).toBe("/a/b/src/x.ts");
  });
  it("returns the relative path verbatim when it's already absolute", () => {
    expect(joinWorktreePath("/a/b", "/already/abs")).toBe("/already/abs");
  });
});

describe("ancestorDirs", () => {
  // Trailing slash matters — buildFileTree stores dir nodes as
  // `src/components/`, so the expansion keys we write must match.
  it("returns parent directories outer-to-inner with trailing slashes", () => {
    expect(ancestorDirs("a/b/c/file.ts")).toEqual(["a/", "a/b/", "a/b/c/"]);
  });
  it("is empty for files at the root", () => {
    expect(ancestorDirs("README.md")).toEqual([]);
  });
  it("ignores stray leading slashes", () => {
    expect(ancestorDirs("/a/b.ts")).toEqual(["a/"]);
  });
});

describe("buildEditorActions — file menu", () => {
  it("onSave / onCloseTab forward to the supplied callbacks", () => {
    const deps = makeDeps();
    const actions = buildEditorActions(deps);
    actions.onSave();
    actions.onCloseTab();
    expect(deps.onSave).toHaveBeenCalledTimes(1);
    expect(deps.onCloseTab).toHaveBeenCalledTimes(1);
  });

  it("onRevert writes the saved baseline back into the buffer", () => {
    const deps = makeDeps({
      getBaseline: vi.fn().mockReturnValue("// pristine"),
    });
    buildEditorActions(deps).onRevert();
    expect(deps.setFileBufferContent).toHaveBeenCalledWith(
      "ws-1",
      "src/components/Foo.tsx",
      "// pristine",
    );
  });

  it("onRevert is a no-op when the baseline isn't loaded yet", () => {
    const deps = makeDeps({ getBaseline: vi.fn().mockReturnValue(null) });
    buildEditorActions(deps).onRevert();
    expect(deps.setFileBufferContent).not.toHaveBeenCalled();
  });

  it("onRevealInFiles opens the panel, switches tab, expands parents (trailing-slashed), selects file", () => {
    const deps = makeDeps({ rightSidebarVisible: false });
    buildEditorActions(deps).onRevealInFiles();
    expect(deps.showRightSidebar).toHaveBeenCalledTimes(1);
    expect(deps.setRightSidebarTab).toHaveBeenCalledWith("files");
    expect(deps.setAllFilesDirExpanded).toHaveBeenCalledWith(
      "ws-1",
      "src/",
      true,
    );
    expect(deps.setAllFilesDirExpanded).toHaveBeenCalledWith(
      "ws-1",
      "src/components/",
      true,
    );
    expect(deps.setAllFilesSelectedPath).toHaveBeenLastCalledWith(
      "ws-1",
      "src/components/Foo.tsx",
    );
  });

  it("onRevealInFiles skips showRightSidebar when it's already visible", () => {
    const deps = makeDeps({ rightSidebarVisible: true });
    buildEditorActions(deps).onRevealInFiles();
    expect(deps.showRightSidebar).not.toHaveBeenCalled();
    expect(deps.setRightSidebarTab).toHaveBeenCalledWith("files");
  });
});

describe("buildEditorActions — edit menu monaco actions", () => {
  let deps: EditorActionsDeps;
  let editor: FakeEditor;

  beforeEach(() => {
    editor = makeFakeEditor();
    deps = makeDeps({ editor: editor as unknown as EditorActionsDeps["editor"] });
  });

  it("onUndo / onRedo route through editor.trigger", () => {
    const actions = buildEditorActions(deps);
    actions.onUndo();
    actions.onRedo();
    expect(editor.trigger).toHaveBeenCalledWith("editor-menubar", "undo", null);
    expect(editor.trigger).toHaveBeenCalledWith("editor-menubar", "redo", null);
  });

  it("onFind / onReplace / onFormat run the matching Monaco action", () => {
    const actions = buildEditorActions(deps);
    actions.onFind();
    actions.onReplace();
    actions.onFormat();
    expect(editor.getAction).toHaveBeenCalledWith("actions.find");
    expect(editor.getAction).toHaveBeenCalledWith(
      "editor.action.startFindReplaceAction",
    );
    expect(editor.getAction).toHaveBeenCalledWith(
      "editor.action.formatDocument",
    );
  });

  it("editor null-guards are safe (no editor mounted)", () => {
    deps = makeDeps({ editor: null });
    const actions = buildEditorActions(deps);
    expect(() => actions.onUndo()).not.toThrow();
    expect(() => actions.onFind()).not.toThrow();
  });
});

describe("buildEditorActions — view toggles + zoom", () => {
  it("flips word wrap, persists the new value, no-ops without errors when persist rejects", async () => {
    const persist = vi.fn().mockRejectedValue(new Error("disk full"));
    const deps = makeDeps({ wordWrap: true, persistSetting: persist });
    buildEditorActions(deps).onToggleWordWrap();
    expect(deps.setWordWrap).toHaveBeenCalledWith(false);
    expect(persist).toHaveBeenCalledWith("editor_word_wrap", "false");
    // The promise rejection should be caught — wait a microtask to
    // surface the catch handler.
    await Promise.resolve();
  });

  it("flips minimap and line numbers symmetrically", () => {
    const deps = makeDeps({ minimap: false, lineNumbers: true });
    const actions = buildEditorActions(deps);
    actions.onToggleMinimap();
    actions.onToggleLineNumbers();
    expect(deps.setMinimap).toHaveBeenCalledWith(true);
    expect(deps.persistSetting).toHaveBeenCalledWith(
      "editor_minimap_enabled",
      "true",
    );
    expect(deps.setLineNumbers).toHaveBeenCalledWith(false);
    expect(deps.persistSetting).toHaveBeenCalledWith(
      "editor_line_numbers",
      "false",
    );
  });

  it("zoom in / out / reset clamp into [0.7, 2] and persist", () => {
    const deps = makeDeps({ fontZoom: 1.95 });
    const actions = buildEditorActions(deps);
    actions.onZoomIn();
    expect(deps.setFontZoom).toHaveBeenLastCalledWith(2);
    expect(deps.persistSetting).toHaveBeenLastCalledWith(
      "editor_font_zoom",
      "2.00",
    );

    const depsLow = makeDeps({ fontZoom: 0.75 });
    buildEditorActions(depsLow).onZoomOut();
    expect(depsLow.setFontZoom).toHaveBeenLastCalledWith(0.7);

    const depsReset = makeDeps({ fontZoom: 1.5 });
    buildEditorActions(depsReset).onZoomReset();
    expect(depsReset.setFontZoom).toHaveBeenLastCalledWith(1);
    expect(depsReset.persistSetting).toHaveBeenLastCalledWith(
      "editor_font_zoom",
      "1.00",
    );
  });
});

describe("buildEditorActions — copy contents / path", () => {
  it("Copy File Contents reads the model and copies its full text", async () => {
    const editor = {
      getAction: vi.fn(),
      trigger: vi.fn(),
      getModel: () => ({ getValue: () => "hello world\n" }),
    } as unknown as EditorActionsDeps["editor"];
    const deps = makeDeps({ editor });
    await buildEditorActions(deps).onCopyContents();
    expect(deps.writeToClipboard).toHaveBeenCalledWith("hello world\n");
    expect(deps.addToast).toHaveBeenCalledWith("Copied file contents");
  });

  it("Copy File Contents is a no-op when the editor isn't mounted", async () => {
    const deps = makeDeps({ editor: null });
    await buildEditorActions(deps).onCopyContents();
    expect(deps.writeToClipboard).not.toHaveBeenCalled();
  });

  it("Copy Path writes the joined absolute path", async () => {
    const deps = makeDeps({
      worktreePath: "/Users/jane/repos/myproj/.worktrees/feature",
      path: "src/Foo.tsx",
    });
    await buildEditorActions(deps).onCopyPath();
    expect(deps.writeToClipboard).toHaveBeenCalledWith(
      "/Users/jane/repos/myproj/.worktrees/feature/src/Foo.tsx",
    );
    expect(deps.addToast).toHaveBeenCalledWith("Copied path");
  });

  it("Copy Path falls back to the relative path when no worktree is set", async () => {
    const deps = makeDeps({ worktreePath: null, path: "Foo.tsx" });
    await buildEditorActions(deps).onCopyPath();
    expect(deps.writeToClipboard).toHaveBeenCalledWith("Foo.tsx");
  });

  it("Copy Relative Path writes the workspace-relative path verbatim", async () => {
    const deps = makeDeps({ path: "src/lib/x.ts" });
    await buildEditorActions(deps).onCopyRelativePath();
    expect(deps.writeToClipboard).toHaveBeenCalledWith("src/lib/x.ts");
    expect(deps.addToast).toHaveBeenCalledWith("Copied relative path");
  });

  it("clipboard failure surfaces a toast with the error string", async () => {
    const deps = makeDeps({
      writeToClipboard: vi.fn().mockRejectedValue(new Error("nope")),
    });
    await buildEditorActions(deps).onCopyPath();
    expect(deps.addToast).toHaveBeenCalledWith("Copy failed: Error: nope");
  });
});

describe("buildEditorActions — go menu", () => {
  it("Go to File invokes openCommandPaletteFileMode", () => {
    const deps = makeDeps();
    buildEditorActions(deps).onGoToFile();
    expect(deps.openCommandPaletteFileMode).toHaveBeenCalledTimes(1);
  });

  it("Go to Line / Symbol route through Monaco actions", () => {
    const deps = makeDeps();
    const editor = deps.editor as unknown as FakeEditor;
    buildEditorActions(deps).onGoToLine();
    buildEditorActions(deps).onGoToSymbol();
    expect(editor.getAction).toHaveBeenCalledWith("editor.action.gotoLine");
    expect(editor.getAction).toHaveBeenCalledWith(
      "editor.action.quickOutline",
    );
  });
});
