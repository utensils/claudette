import { describe, expect, it } from "vitest";
import {
  bindingMatchesEvent,
  buildRebindUpdates,
  eventToBinding,
  getEffectiveBindingById,
  resolveHotkeyAction,
  type KeybindingMap,
} from "./bindings";

type KeyInit = {
  key?: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
};

function macKey(init: KeyInit): KeyboardEvent {
  return {
    type: "keydown",
    key: init.key ?? "",
    code: init.code ?? "",
    metaKey: init.metaKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    shiftKey: init.shiftKey ?? false,
    altKey: init.altKey ?? false,
  } as unknown as KeyboardEvent;
}

describe("buildRebindUpdates", () => {
  it("disables a default owner when rebinding another action to its shortcut", () => {
    const updates = buildRebindUpdates(
      "global.toggle-sidebar",
      "mod+d",
      {},
      "mac",
    );

    expect(updates).toEqual({
      "global.toggle-sidebar": "mod+d",
      "global.toggle-right-sidebar": null,
    });
  });

  it("disables a custom owner when rebinding another action to its shortcut", () => {
    const overrides: KeybindingMap = {
      "global.toggle-fuzzy-finder": "mod+d",
      "global.toggle-right-sidebar": null,
    };

    const updates = buildRebindUpdates(
      "global.toggle-sidebar",
      "mod+d",
      overrides,
      "mac",
    );

    expect(updates).toEqual({
      "global.toggle-sidebar": "mod+d",
      "global.toggle-fuzzy-finder": null,
    });
  });

  it("does not re-disable actions that are already disabled", () => {
    const updates = buildRebindUpdates(
      "global.toggle-sidebar",
      "mod+d",
      { "global.toggle-right-sidebar": null },
      "mac",
    );

    expect(updates).toEqual({
      "global.toggle-sidebar": "mod+d",
    });
  });

  it("does not attempt to unbind fixed shortcuts", () => {
    const updates = buildRebindUpdates(
      "global.toggle-sidebar",
      "escape",
      {},
      "mac",
    );

    expect(updates).toEqual({
      "global.toggle-sidebar": "escape",
    });
  });

  it("does not look for conflicts when disabling an action", () => {
    const updates = buildRebindUpdates(
      "global.toggle-sidebar",
      null,
      { "global.toggle-fuzzy-finder": "mod+b" },
      "mac",
    );

    expect(updates).toEqual({
      "global.toggle-sidebar": null,
    });
  });

  it("keeps same shortcut bindings in different scopes", () => {
    // global.cycle-tab-prev (cycle workspace tabs) and
    // terminal.cycle-tab-prev (cycle terminal tabs) intentionally share the
    // same default shortcut — scope isolation routes the keypress to the
    // right action depending on which surface has focus.
    const updates = buildRebindUpdates(
      "global.cycle-tab-prev",
      "mod+shift+code:BracketLeft",
      {},
      "mac",
    );

    expect(updates).toEqual({
      "global.cycle-tab-prev": "mod+shift+code:BracketLeft",
    });
  });
});

describe("resolveHotkeyAction with conflict updates", () => {
  it("routes the duplicated shortcut to the new owner after applying updates", () => {
    const updates = buildRebindUpdates(
      "global.toggle-sidebar",
      "mod+d",
      {},
      "mac",
    );

    expect(
      resolveHotkeyAction(
        macKey({ key: "d", metaKey: true }),
        "global",
        updates,
        "mac",
      ),
    ).toBe("global.toggle-sidebar");
    expect(getEffectiveBindingById("global.toggle-right-sidebar", updates, "mac"))
      .toBeNull();
  });

  it("resolves the file viewer undo operation in file-viewer scope only", () => {
    const event = macKey({ key: "z", metaKey: true });
    expect(resolveHotkeyAction(event, "file-viewer", {}, "mac")).toBe(
      "file-viewer.undo-file-operation",
    );
    expect(resolveHotkeyAction(event, "global", {}, "mac")).toBeNull();
  });

  it("resolves close-tab with platform mod in global scope", () => {
    // Pre-rename, this binding lived in `file-viewer` scope and only
    // fired when focus was inside the file viewer. The `global.close-tab`
    // action moves the dispatch out so chat / diff close also work, and
    // a SQL migration carries existing user overrides forward.
    expect(
      resolveHotkeyAction(
        macKey({ key: "w", metaKey: true }),
        "global",
        {},
        "mac",
      ),
    ).toBe("global.close-tab");
    expect(
      resolveHotkeyAction(
        macKey({ key: "w", ctrlKey: true }),
        "global",
        {},
        "linux",
      ),
    ).toBe("global.close-tab");
  });

  it("doesn't shadow the file-viewer-scoped undo action with the new global close-tab", () => {
    // Sanity: undo (mod+z) lives in file-viewer scope and the new
    // global.close-tab (mod+w) shouldn't accidentally claim it.
    expect(
      resolveHotkeyAction(
        macKey({ key: "z", metaKey: true }),
        "file-viewer",
        {},
        "mac",
      ),
    ).toBe("file-viewer.undo-file-operation");
  });
});

describe("global.show-keyboard-shortcuts default binding", () => {
  // Locks the Help shortcut to Cmd/Ctrl+/ so the macOS Help-menu
  // accelerator (`CmdOrCtrl+Slash` in src-tauri/src/main.rs) and the
  // in-app hotkey can never silently drift apart.
  it("resolves Cmd+/ on macOS", () => {
    expect(
      resolveHotkeyAction(
        macKey({ key: "/", metaKey: true }),
        "global",
        {},
        "mac",
      ),
    ).toBe("global.show-keyboard-shortcuts");
  });

  it("resolves Ctrl+/ on Linux/Windows", () => {
    expect(
      resolveHotkeyAction(
        macKey({ key: "/", ctrlKey: true }),
        "global",
        {},
        "linux",
      ),
    ).toBe("global.show-keyboard-shortcuts");
  });
});

describe("global.new-tab default binding", () => {
  // Locks Cmd/Ctrl+T as the context-aware "new tab" shortcut. Pre-#???
  // this binding lived as a raw `window.addEventListener("keydown")` in
  // ChatToolbar/ComposerToolbar that toggled thinking mode — see the
  // CHANGELOG entry / PR description for the rationale on the rebind.
  // The terminal scope keeps its own `terminal.new-tab` on the same key
  // so typing Cmd+T inside a terminal pane still creates a terminal tab.
  it("resolves Cmd+T on macOS to global.new-tab", () => {
    expect(
      resolveHotkeyAction(
        macKey({ key: "t", metaKey: true }),
        "global",
        {},
        "mac",
      ),
    ).toBe("global.new-tab");
  });

  it("resolves Ctrl+T on Linux/Windows to global.new-tab", () => {
    expect(
      resolveHotkeyAction(
        macKey({ key: "t", ctrlKey: true }),
        "global",
        {},
        "linux",
      ),
    ).toBe("global.new-tab");
  });

  it("does not collide with terminal.new-tab in terminal scope on macOS", () => {
    // Both global.new-tab and terminal.new-tab default to mod+t on
    // macOS by design — the dispatcher routes by scope, not by the key
    // alone. Inside a terminal pane the resolver is called with scope
    // "terminal" and the terminal action wins.
    expect(
      resolveHotkeyAction(
        macKey({ key: "t", metaKey: true }),
        "terminal",
        {},
        "mac",
      ),
    ).toBe("terminal.new-tab");
  });
});

describe("command palette / quick-open default bindings", () => {
  // VS Code parity: Cmd+P opens Quick Open (file picker) and
  // Cmd+Shift+P opens the Command Palette. Cmd+O is kept as an
  // alternate binding so existing muscle memory keeps working
  // (`global.open-command-palette-file-mode-alt`).
  it("resolves Cmd+P to quick-open (file mode) on macOS", () => {
    expect(
      resolveHotkeyAction(
        macKey({ key: "p", metaKey: true }),
        "global",
        {},
        "mac",
      ),
    ).toBe("global.open-command-palette-file-mode");
  });

  it("resolves Ctrl+P to quick-open (file mode) on Linux/Windows", () => {
    expect(
      resolveHotkeyAction(
        macKey({ key: "p", ctrlKey: true }),
        "global",
        {},
        "linux",
      ),
    ).toBe("global.open-command-palette-file-mode");
    expect(
      resolveHotkeyAction(
        macKey({ key: "p", ctrlKey: true }),
        "global",
        {},
        "windows",
      ),
    ).toBe("global.open-command-palette-file-mode");
  });

  it("resolves Cmd+Shift+P to the command palette on macOS", () => {
    expect(
      resolveHotkeyAction(
        macKey({ key: "p", metaKey: true, shiftKey: true }),
        "global",
        {},
        "mac",
      ),
    ).toBe("global.toggle-command-palette");
  });

  it("resolves Ctrl+Shift+P to the command palette on Linux/Windows", () => {
    expect(
      resolveHotkeyAction(
        macKey({ key: "p", ctrlKey: true, shiftKey: true }),
        "global",
        {},
        "linux",
      ),
    ).toBe("global.toggle-command-palette");
  });

  it("resolves Cmd+O to the quick-open alias on macOS", () => {
    expect(
      resolveHotkeyAction(
        macKey({ key: "o", metaKey: true }),
        "global",
        {},
        "mac",
      ),
    ).toBe("global.open-command-palette-file-mode-alt");
  });

  it("resolves Ctrl+O to the quick-open alias on Linux/Windows", () => {
    expect(
      resolveHotkeyAction(
        macKey({ key: "o", ctrlKey: true }),
        "global",
        {},
        "linux",
      ),
    ).toBe("global.open-command-palette-file-mode-alt");
  });

  it("does not surface the palette swap inside file-viewer scope", () => {
    // Both palette actions live in `global` scope; the resolver must not
    // return them when called with `file-viewer` scope, otherwise the
    // file-viewer's local keyhandlers would silently shadow palette
    // dispatch.
    expect(
      resolveHotkeyAction(
        macKey({ key: "p", metaKey: true }),
        "file-viewer",
        {},
        "mac",
      ),
    ).toBeNull();
  });
});

describe("terminal font zoom default bindings", () => {
  it("resolves Shift+= and Shift+- to terminal font zoom in global scope", () => {
    expect(
      resolveHotkeyAction(
        macKey({ key: "+", code: "Equal", metaKey: true, shiftKey: true }),
        "global",
        {},
        "mac",
      ),
    ).toBe("global.increase-terminal-font");
    expect(
      resolveHotkeyAction(
        macKey({ key: "_", code: "Minus", ctrlKey: true, shiftKey: true }),
        "global",
        {},
        "linux",
      ),
    ).toBe("global.decrease-terminal-font");
  });

  it("keeps unshifted +/- bound to UI zoom in global and terminal scopes", () => {
    const event = macKey({ key: "=", code: "Equal", metaKey: true });
    expect(resolveHotkeyAction(event, "global", {}, "mac"))
      .toBe("global.increase-ui-font");
    expect(resolveHotkeyAction(event, "terminal", {}, "mac"))
      .toBe("terminal.zoom-in");
  });
});

describe("bindingMatchesEvent — modifier-only codes", () => {
  // Regression: hold-to-talk on Right Alt was bound to `code:AltRight`,
  // but pressing Alt asserts e.altKey, which the matcher used to reject
  // because the binding string had no explicit `alt+` prefix.
  it("matches code:AltRight when Right Alt is pressed alone", () => {
    expect(
      bindingMatchesEvent(
        "code:AltRight",
        macKey({ key: "Alt", code: "AltRight", altKey: true }),
        "mac",
      ),
    ).toBe(true);
  });

  it("matches code:ShiftRight when Right Shift is pressed alone", () => {
    expect(
      bindingMatchesEvent(
        "code:ShiftRight",
        macKey({ key: "Shift", code: "ShiftRight", shiftKey: true }),
        "mac",
      ),
    ).toBe(true);
  });

  it("does not match a different modifier code than the one bound", () => {
    expect(
      bindingMatchesEvent(
        "code:AltRight",
        macKey({ key: "Alt", code: "AltLeft", altKey: true }),
        "mac",
      ),
    ).toBe(false);
  });

  it("still requires bound modifiers when binding is compound", () => {
    expect(
      bindingMatchesEvent(
        "shift+code:KeyA",
        macKey({ key: "a", code: "KeyA", shiftKey: true }),
        "mac",
      ),
    ).toBe(true);
    expect(
      bindingMatchesEvent(
        "shift+code:KeyA",
        macKey({ key: "a", code: "KeyA" }),
        "mac",
      ),
    ).toBe(false);
  });
});

describe("eventToBinding", () => {
  it("captures platform mod only for the active platform", () => {
    expect(eventToBinding(macKey({ key: "d", metaKey: true }), "key", "mac"))
      .toBe("mod+d");
    expect(eventToBinding(macKey({ key: "d", ctrlKey: true }), "key", "mac"))
      .toBeNull();
    expect(eventToBinding(macKey({ key: "d", ctrlKey: true }), "key", "linux"))
      .toBe("mod+d");
    expect(eventToBinding(macKey({ key: "d", metaKey: true }), "key", "linux"))
      .toBeNull();
  });
});
