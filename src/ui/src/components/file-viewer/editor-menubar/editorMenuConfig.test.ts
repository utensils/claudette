import { describe, expect, it, vi } from "vitest";
import {
  buildEditorMenus,
  type EditorActions,
  type EditorMenuContext,
} from "./editorMenuConfig";

function makeActions(): EditorActions {
  return {
    onSave: vi.fn(),
    onRevert: vi.fn(),
    onRevealInFiles: vi.fn(),
    onCloseTab: vi.fn(),
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    onFind: vi.fn(),
    onReplace: vi.fn(),
    onFormat: vi.fn(),
    onCopyContents: vi.fn(),
    onCopyPath: vi.fn(),
    onCopyRelativePath: vi.fn(),
    onToggleWordWrap: vi.fn(),
    onToggleMinimap: vi.fn(),
    onToggleLineNumbers: vi.fn(),
    onZoomIn: vi.fn(),
    onZoomOut: vi.fn(),
    onZoomReset: vi.fn(),
    onGoToFile: vi.fn(),
    onGoToLine: vi.fn(),
    onGoToSymbol: vi.fn(),
  };
}

function makeCtx(overrides: Partial<EditorMenuContext> = {}): EditorMenuContext {
  return {
    isMac: true,
    hasEditor: true,
    canMutate: true,
    dirty: false,
    wordWrap: true,
    lineNumbers: true,
    minimap: false,
    getHotkeyHint: () => null,
    ...overrides,
  };
}

describe("buildEditorMenus", () => {
  it("returns the four canonical menus in order", () => {
    const menus = buildEditorMenus(makeActions(), makeCtx());
    expect(menus.map((m) => m.id)).toEqual(["file", "edit", "view", "go"]);
  });

  it("emits unique ids across every entry (items + separators)", () => {
    const menus = buildEditorMenus(makeActions(), makeCtx());
    const ids = menus.flatMap((m) => m.items.map((i) => i.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every non-separator entry has a labelKey + onSelect", () => {
    const menus = buildEditorMenus(makeActions(), makeCtx());
    for (const menu of menus) {
      for (const item of menu.items) {
        if ("type" in item && item.type === "separator") continue;
        expect(item.labelKey).toMatch(/^editor_menu_/);
        expect(typeof item.onSelect).toBe("function");
      }
    }
  });

  it("renders mac shortcuts with the ⌘ glyph and PC shortcuts with Ctrl/Shift", () => {
    const macMenus = buildEditorMenus(makeActions(), makeCtx({ isMac: true }));
    const macFind = macMenus
      .find((m) => m.id === "edit")
      ?.items.find((i) => i.id === "edit.find") as
      | { shortcut?: string }
      | undefined;
    expect(macFind?.shortcut).toBe("⌘F");

    const pcMenus = buildEditorMenus(makeActions(), makeCtx({ isMac: false }));
    const pcFind = pcMenus
      .find((m) => m.id === "edit")
      ?.items.find((i) => i.id === "edit.find") as
      | { shortcut?: string }
      | undefined;
    expect(pcFind?.shortcut).toBe("Ctrl+F");
  });

  it("uses the resolved hotkey hint when available for Go to File and Close", () => {
    const hints: Record<string, string> = {
      "global.open-command-palette-file-mode": "⌘P",
      "global.close-tab": "⌘W",
    };
    const menus = buildEditorMenus(
      makeActions(),
      makeCtx({ getHotkeyHint: (id) => hints[id] ?? null }),
    );
    const goToFile = menus
      .find((m) => m.id === "go")
      ?.items.find((i) => i.id === "go.go-to-file") as
      | { shortcut?: string }
      | undefined;
    const close = menus
      .find((m) => m.id === "file")
      ?.items.find((i) => i.id === "file.close") as
      | { shortcut?: string }
      | undefined;
    expect(goToFile?.shortcut).toBe("⌘P");
    expect(close?.shortcut).toBe("⌘W");
  });

  it("disables Save when the buffer is clean", () => {
    const menus = buildEditorMenus(makeActions(), makeCtx({ dirty: false }));
    const save = menus
      .find((m) => m.id === "file")
      ?.items.find((i) => i.id === "file.save") as
      | { disabled?: boolean }
      | undefined;
    expect(save?.disabled).toBe(true);
  });

  it("disables Save when dirty but Monaco can't mutate (read-only)", () => {
    const menus = buildEditorMenus(
      makeActions(),
      makeCtx({ dirty: true, canMutate: false }),
    );
    const save = menus
      .find((m) => m.id === "file")
      ?.items.find((i) => i.id === "file.save") as
      | { disabled?: boolean }
      | undefined;
    expect(save?.disabled).toBe(true);
  });

  it("disables only mutation items when canMutate is false but hasEditor is true (read-only Monaco)", () => {
    // Oversize / truncated file: Monaco renders read-only. Find /
    // Go to Line / Copy Contents stay reachable; Save / Undo / Redo /
    // Replace / Format are gated.
    const menus = buildEditorMenus(
      makeActions(),
      makeCtx({ hasEditor: true, canMutate: false, dirty: false }),
    );
    const flat = menus.flatMap((m) => m.items);
    const disabledOf = (id: string) =>
      (flat.find((i) => i.id === id) as { disabled?: boolean } | undefined)
        ?.disabled;

    // Mutation gated.
    for (const id of ["edit.undo", "edit.redo", "edit.replace", "edit.format"]) {
      expect(disabledOf(id), `expected ${id} disabled`).toBe(true);
    }
    // Read-only navigation / copy stays available.
    for (const id of [
      "edit.find",
      "edit.copy-contents",
      "edit.copy-path",
      "edit.copy-relative-path",
      "go.go-to-line",
      "go.go-to-symbol",
    ]) {
      expect(disabledOf(id), `expected ${id} enabled`).toBeFalsy();
    }
  });

  it("disables both navigation and mutation when hasEditor is false", () => {
    // Image / binary preview: Monaco isn't rendered at all.
    const menus = buildEditorMenus(
      makeActions(),
      makeCtx({ hasEditor: false, canMutate: false, dirty: false }),
    );
    const flat = menus.flatMap((m) => m.items);
    const disabledOf = (id: string) =>
      (flat.find((i) => i.id === id) as { disabled?: boolean } | undefined)
        ?.disabled;

    for (const id of [
      "edit.undo",
      "edit.redo",
      "edit.find",
      "edit.replace",
      "edit.format",
      "edit.copy-contents",
      "go.go-to-line",
      "go.go-to-symbol",
    ]) {
      expect(disabledOf(id), `expected ${id} disabled`).toBe(true);
    }
    // Copy Path / Copy Relative Path stay enabled — they don't need
    // Monaco to be mounted, they just need a workspace-relative path.
    expect(disabledOf("edit.copy-path")).toBeFalsy();
    expect(disabledOf("edit.copy-relative-path")).toBeFalsy();
  });

  it("swaps view toggle labels when the underlying flag is on/off", () => {
    const on = buildEditorMenus(
      makeActions(),
      makeCtx({ wordWrap: true, minimap: true, lineNumbers: true }),
    );
    const off = buildEditorMenus(
      makeActions(),
      makeCtx({ wordWrap: false, minimap: false, lineNumbers: false }),
    );

    const labels = (menus: ReturnType<typeof buildEditorMenus>) =>
      Object.fromEntries(
        menus
          .find((m) => m.id === "view")!
          .items.filter(
            (i): i is Extract<typeof i, { labelKey: string }> =>
              !("type" in i && i.type === "separator"),
          )
          .map((i) => [i.id, i.labelKey]),
      );

    const onLabels = labels(on);
    const offLabels = labels(off);
    expect(onLabels["view.toggle-word-wrap"]).toBe("editor_menu_view_word_wrap_off");
    expect(offLabels["view.toggle-word-wrap"]).toBe("editor_menu_view_word_wrap_on");
    expect(onLabels["view.toggle-minimap"]).toBe("editor_menu_view_minimap_off");
    expect(offLabels["view.toggle-minimap"]).toBe("editor_menu_view_minimap_on");
  });

  it("wires onSelect callbacks back to the supplied actions object", () => {
    const actions = makeActions();
    const menus = buildEditorMenus(actions, makeCtx({ dirty: true }));
    const flat = menus.flatMap((m) => m.items);
    const fire = (id: string) => {
      const item = flat.find((i) => i.id === id);
      if (!item || ("type" in item && item.type === "separator")) {
        throw new Error(`missing item ${id}`);
      }
      item.onSelect();
    };

    fire("file.save");
    expect(actions.onSave).toHaveBeenCalledTimes(1);
    fire("edit.format");
    expect(actions.onFormat).toHaveBeenCalledTimes(1);
    fire("view.toggle-word-wrap");
    expect(actions.onToggleWordWrap).toHaveBeenCalledTimes(1);
    fire("go.go-to-file");
    expect(actions.onGoToFile).toHaveBeenCalledTimes(1);
  });
});
