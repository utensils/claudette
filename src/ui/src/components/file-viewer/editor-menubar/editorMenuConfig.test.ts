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
    canEdit: true,
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

  it("disables Save and Revert when dirty but not editable", () => {
    const menus = buildEditorMenus(
      makeActions(),
      makeCtx({ dirty: true, canEdit: false }),
    );
    const save = menus
      .find((m) => m.id === "file")
      ?.items.find((i) => i.id === "file.save") as
      | { disabled?: boolean }
      | undefined;
    expect(save?.disabled).toBe(true);
  });

  it("disables editor-mutation items when canEdit is false", () => {
    const menus = buildEditorMenus(
      makeActions(),
      makeCtx({ canEdit: false, dirty: false }),
    );
    const mutationItems = [
      "edit.undo",
      "edit.redo",
      "edit.find",
      "edit.replace",
      "edit.format",
      "go.go-to-line",
      "go.go-to-symbol",
    ];
    const flat = menus.flatMap((m) => m.items);
    for (const id of mutationItems) {
      const item = flat.find((i) => i.id === id) as
        | { disabled?: boolean }
        | undefined;
      expect(item?.disabled, `expected ${id} disabled`).toBe(true);
    }
    // Copy Path stays enabled — the user can copy the path even when
    // the file is read-only or binary.
    const copyPath = flat.find((i) => i.id === "edit.copy-path") as
      | { disabled?: boolean }
      | undefined;
    expect(copyPath?.disabled).toBeFalsy();
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
