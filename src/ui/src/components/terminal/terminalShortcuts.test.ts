import { describe, it, expect } from "vitest";
import {
  cycleTabId,
  shouldStopTerminalEventPropagation,
  terminalKeyAction,
} from "./terminalShortcuts";

describe("cycleTabId", () => {
  it("returns null for an empty list", () => {
    expect(cycleTabId([], null, 1)).toBeNull();
    expect(cycleTabId([], 5, -1)).toBeNull();
  });

  it("returns the sole id for a single-tab list (no-op)", () => {
    expect(cycleTabId([7], 7, 1)).toBe(7);
    expect(cycleTabId([7], 7, -1)).toBe(7);
    expect(cycleTabId([7], null, 1)).toBe(7);
  });

  it("advances forward with wrap-around", () => {
    expect(cycleTabId([1, 2, 3], 1, 1)).toBe(2);
    expect(cycleTabId([1, 2, 3], 2, 1)).toBe(3);
    expect(cycleTabId([1, 2, 3], 3, 1)).toBe(1);
  });

  it("advances backward with wrap-around", () => {
    expect(cycleTabId([1, 2, 3], 1, -1)).toBe(3);
    expect(cycleTabId([1, 2, 3], 2, -1)).toBe(1);
    expect(cycleTabId([1, 2, 3], 3, -1)).toBe(2);
  });

  it("when activeId is null, starts from index 0", () => {
    expect(cycleTabId([1, 2, 3], null, 1)).toBe(2);
    expect(cycleTabId([1, 2, 3], null, -1)).toBe(3);
  });

  it("when activeId is not in the list, treats cursor as index 0", () => {
    expect(cycleTabId([10, 20, 30], 999, 1)).toBe(20);
    expect(cycleTabId([10, 20, 30], 999, -1)).toBe(30);
  });
});

// Minimal KeyboardEvent-like object so we can exercise the action logic
// without a DOM. Fields match what `terminalKeyAction` reads.
type KeyInit = {
  type?: string;
  key?: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
};

function mk(init: KeyInit): KeyboardEvent {
  return {
    type: init.type ?? "keydown",
    key: init.key ?? "",
    code: init.code ?? "",
    metaKey: init.metaKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    shiftKey: init.shiftKey ?? false,
    altKey: init.altKey ?? false,
  } as unknown as KeyboardEvent;
}

describe("terminalKeyAction", () => {
  it("returns null for events without a modifier", () => {
    expect(terminalKeyAction(mk({ key: "t" }))).toBeNull();
    expect(terminalKeyAction(mk({ key: "]", shiftKey: true }))).toBeNull();
  });

  it("returns null for non-keydown events", () => {
    expect(
      terminalKeyAction(mk({ type: "keyup", key: "t", metaKey: true })),
    ).toBeNull();
  });

  it("returns null for unrelated keys", () => {
    expect(terminalKeyAction(mk({ key: "a", metaKey: true }))).toBeNull();
    expect(terminalKeyAction(mk({ key: "Enter", metaKey: true }))).toBeNull();
  });

  it("recognizes Cmd+Shift+[ (prev tab) via key and via code", () => {
    expect(terminalKeyAction(mk({ key: "[", metaKey: true, shiftKey: true })))
      .toEqual({ kind: "cycle", direction: "prev" });
    expect(terminalKeyAction(mk({ key: "{", metaKey: true, shiftKey: true })))
      .toEqual({ kind: "cycle", direction: "prev" });
    expect(
      terminalKeyAction(mk({ code: "BracketLeft", metaKey: true, shiftKey: true })),
    ).toEqual({ kind: "cycle", direction: "prev" });
  });

  it("recognizes Cmd+Shift+] (next tab) via key and via code", () => {
    expect(terminalKeyAction(mk({ key: "]", metaKey: true, shiftKey: true })))
      .toEqual({ kind: "cycle", direction: "next" });
    expect(terminalKeyAction(mk({ key: "}", metaKey: true, shiftKey: true })))
      .toEqual({ kind: "cycle", direction: "next" });
    expect(
      terminalKeyAction(mk({ code: "BracketRight", metaKey: true, shiftKey: true })),
    ).toEqual({ kind: "cycle", direction: "next" });
  });

  it("recognizes Ctrl+Shift+[/] for Linux/Windows", () => {
    expect(terminalKeyAction(mk({ key: "[", ctrlKey: true, shiftKey: true })))
      .toEqual({ kind: "cycle", direction: "prev" });
    expect(terminalKeyAction(mk({ key: "]", ctrlKey: true, shiftKey: true })))
      .toEqual({ kind: "cycle", direction: "next" });
  });

  it("recognizes Cmd+T (macOS) as new-tab (upper and lower case)", () => {
    expect(terminalKeyAction(mk({ key: "t", metaKey: true })))
      .toEqual({ kind: "new-tab" });
    expect(terminalKeyAction(mk({ key: "T", metaKey: true })))
      .toEqual({ kind: "new-tab" });
  });

  it("recognizes Ctrl+Shift+T (Linux/Windows) as new-tab", () => {
    expect(terminalKeyAction(mk({ key: "t", ctrlKey: true, shiftKey: true })))
      .toEqual({ kind: "new-tab" });
    expect(terminalKeyAction(mk({ key: "T", ctrlKey: true, shiftKey: true })))
      .toEqual({ kind: "new-tab" });
  });

  it("does NOT intercept bare Ctrl+T — readline uses it for transpose-chars", () => {
    // This is the regression Codex caught. Hijacking Ctrl+T would break a
    // standard shell shortcut inside the terminal.
    expect(terminalKeyAction(mk({ key: "t", ctrlKey: true }))).toBeNull();
    expect(terminalKeyAction(mk({ key: "T", ctrlKey: true }))).toBeNull();
  });

  it("does NOT treat Cmd+Shift+T as new-tab on macOS (that's a Linux combo)", () => {
    // On macOS users type Cmd+T; Cmd+Shift+T would leak the "reopen closed tab"
    // muscle memory from browsers — keep it available for future use.
    expect(terminalKeyAction(mk({ key: "T", metaKey: true, shiftKey: true })))
      .toBeNull();
  });

  it("recognizes Cmd+` as toggle-panel (so xterm doesn't forward the backtick)", () => {
    expect(terminalKeyAction(mk({ key: "`", metaKey: true })))
      .toEqual({ kind: "toggle-panel" });
    expect(terminalKeyAction(mk({ key: "`", ctrlKey: true })))
      .toEqual({ kind: "toggle-panel" });
  });

  it("does NOT treat Cmd+Shift+` as toggle-panel (Shift must be absent)", () => {
    expect(
      terminalKeyAction(mk({ key: "`", metaKey: true, shiftKey: true })),
    ).toBeNull();
  });

  it("recognizes Cmd+0 as focus-chat", () => {
    expect(terminalKeyAction(mk({ key: "0", metaKey: true })))
      .toEqual({ kind: "focus-chat" });
    expect(terminalKeyAction(mk({ key: "0", ctrlKey: true })))
      .toEqual({ kind: "focus-chat" });
  });

  it("does NOT treat Cmd+Shift+0 as focus-chat", () => {
    expect(
      terminalKeyAction(mk({ key: "0", metaKey: true, shiftKey: true })),
    ).toBeNull();
  });

  it("recognizes Cmd+= as zoom-in (code-based)", () => {
    expect(terminalKeyAction(mk({ code: "Equal", metaKey: true })))
      .toEqual({ kind: "zoom", direction: "in", scope: "ui" });
  });

  it("recognizes Cmd+Shift+= (key='+') as terminal zoom-in via code", () => {
    // On US keyboards Shift+= produces "+", but code stays "Equal"
    expect(terminalKeyAction(mk({ key: "+", code: "Equal", metaKey: true, shiftKey: true })))
      .toEqual({ kind: "zoom", direction: "in", scope: "terminal" });
  });

  it("recognizes Cmd+- as zoom-out (code-based)", () => {
    expect(terminalKeyAction(mk({ code: "Minus", metaKey: true })))
      .toEqual({ kind: "zoom", direction: "out", scope: "ui" });
  });

  it("recognizes Ctrl+= as zoom-in (Linux)", () => {
    expect(terminalKeyAction(mk({ code: "Equal", ctrlKey: true })))
      .toEqual({ kind: "zoom", direction: "in", scope: "ui" });
  });

  it("recognizes Ctrl+- as zoom-out (Linux)", () => {
    expect(terminalKeyAction(mk({ code: "Minus", ctrlKey: true })))
      .toEqual({ kind: "zoom", direction: "out", scope: "ui" });
  });

  it("recognizes Ctrl+Shift+- as terminal zoom-out (Linux)", () => {
    expect(terminalKeyAction(mk({ code: "Minus", ctrlKey: true, shiftKey: true })))
      .toEqual({ kind: "zoom", direction: "out", scope: "terminal" });
  });

  it("recognizes terminal font zoom with customized keybindings", () => {
    expect(
      terminalKeyAction(
        mk({ code: "Period", metaKey: true, shiftKey: true }),
        { "global.increase-terminal-font": "mod+shift+code:Period" },
      ),
    ).toEqual({ kind: "zoom", direction: "in", scope: "terminal" });
  });

  describe("split-pane", () => {
    it("Cmd+D splits side-by-side (horizontal layout) on macOS", () => {
      expect(terminalKeyAction(mk({ code: "KeyD", key: "d", metaKey: true })))
        .toEqual({ kind: "split-pane", direction: "horizontal" });
    });

    it("Cmd+Shift+D splits stacked (vertical layout) on macOS", () => {
      expect(
        terminalKeyAction(
          mk({ code: "KeyD", key: "D", metaKey: true, shiftKey: true }),
        ),
      ).toEqual({ kind: "split-pane", direction: "vertical" });
    });

    it("does NOT intercept bare Ctrl+D — shell EOF must reach the PTY", () => {
      expect(terminalKeyAction(mk({ code: "KeyD", key: "d", ctrlKey: true })))
        .toBeNull();
    });

    it("Ctrl+Shift+D splits side-by-side on Linux/Windows", () => {
      expect(
        terminalKeyAction(
          mk({ code: "KeyD", key: "D", ctrlKey: true, shiftKey: true }),
        ),
      ).toEqual({ kind: "split-pane", direction: "horizontal" });
    });

    it("Ctrl+Shift+Alt+D splits stacked on Linux/Windows", () => {
      expect(
        terminalKeyAction(
          mk({
            code: "KeyD",
            key: "D",
            ctrlKey: true,
            shiftKey: true,
            altKey: true,
          }),
        ),
      ).toEqual({ kind: "split-pane", direction: "vertical" });
    });

    it("works with Dvorak-style layouts via ev.code even when ev.key differs", () => {
      expect(
        terminalKeyAction(mk({ code: "KeyD", key: "e", metaKey: true })),
      ).toEqual({ kind: "split-pane", direction: "horizontal" });
    });
  });

  describe("close-pane", () => {
    it("Cmd+W closes the pane on macOS", () => {
      expect(terminalKeyAction(mk({ key: "w", metaKey: true })))
        .toEqual({ kind: "close-pane" });
    });

    it("does NOT intercept bare Ctrl+W — readline word-rubout must reach the PTY", () => {
      expect(terminalKeyAction(mk({ key: "w", ctrlKey: true }))).toBeNull();
    });

    it("Ctrl+Shift+W closes the pane on Linux/Windows", () => {
      expect(
        terminalKeyAction(mk({ key: "w", ctrlKey: true, shiftKey: true })),
      ).toEqual({ kind: "close-pane" });
    });
  });

  describe("focus-pane", () => {
    it("Cmd+Option+Arrow navigates between panes", () => {
      expect(
        terminalKeyAction(
          mk({ key: "ArrowLeft", metaKey: true, altKey: true }),
        ),
      ).toEqual({ kind: "focus-pane", direction: "left" });
      expect(
        terminalKeyAction(
          mk({ key: "ArrowRight", metaKey: true, altKey: true }),
        ),
      ).toEqual({ kind: "focus-pane", direction: "right" });
      expect(
        terminalKeyAction(
          mk({ key: "ArrowUp", metaKey: true, altKey: true }),
        ),
      ).toEqual({ kind: "focus-pane", direction: "up" });
      expect(
        terminalKeyAction(
          mk({ key: "ArrowDown", metaKey: true, altKey: true }),
        ),
      ).toEqual({ kind: "focus-pane", direction: "down" });
    });

    it("Ctrl+Alt+Arrow also navigates (Linux convention)", () => {
      expect(
        terminalKeyAction(
          mk({ key: "ArrowLeft", ctrlKey: true, altKey: true }),
        ),
      ).toEqual({ kind: "focus-pane", direction: "left" });
    });

    it("bare Option+Arrow is NOT intercepted — word-motion belongs to readline", () => {
      expect(terminalKeyAction(mk({ key: "ArrowLeft", altKey: true })))
        .toBeNull();
    });

    it("Cmd+Arrow without Alt is NOT intercepted — line-motion on macOS", () => {
      expect(terminalKeyAction(mk({ key: "ArrowLeft", metaKey: true })))
        .toBeNull();
    });
  });

  describe("copy-selection", () => {
    it("macOS: Cmd+C (physical KeyC) returns copy", () => {
      expect(terminalKeyAction(mk({ code: "KeyC", key: "c", metaKey: true })))
        .toEqual({ kind: "copy" });
      expect(terminalKeyAction(mk({ code: "KeyC", key: "C", metaKey: true })))
        .toEqual({ kind: "copy" });
    });

    it("macOS: Cmd+C with Shift does NOT return copy", () => {
      expect(terminalKeyAction(mk({ code: "KeyC", key: "c", metaKey: true, shiftKey: true })))
        .toBeNull();
    });

    it("does NOT intercept bare Ctrl+C — shell SIGINT must reach the PTY", () => {
      expect(terminalKeyAction(mk({ code: "KeyC", key: "c", ctrlKey: true }))).toBeNull();
      expect(terminalKeyAction(mk({ code: "KeyC", key: "C", ctrlKey: true }))).toBeNull();
    });

    it("Linux/Windows: Ctrl+Shift+C (physical KeyC) returns copy", () => {
      expect(terminalKeyAction(mk({ code: "KeyC", key: "c", ctrlKey: true, shiftKey: true })))
        .toEqual({ kind: "copy" });
      expect(terminalKeyAction(mk({ code: "KeyC", key: "C", ctrlKey: true, shiftKey: true })))
        .toEqual({ kind: "copy" });
    });

    it("works via code even when key differs (Dvorak layout: physical C = 'j')", () => {
      expect(terminalKeyAction(mk({ code: "KeyC", key: "j", metaKey: true })))
        .toEqual({ kind: "copy" });
    });
  });

  describe("paste", () => {
    it("macOS: Cmd+V (physical KeyV) returns paste", () => {
      expect(terminalKeyAction(mk({ code: "KeyV", key: "v", metaKey: true })))
        .toEqual({ kind: "paste" });
      expect(terminalKeyAction(mk({ code: "KeyV", key: "V", metaKey: true })))
        .toEqual({ kind: "paste" });
    });

    it("macOS: Cmd+V with Shift does NOT return paste", () => {
      expect(terminalKeyAction(mk({ code: "KeyV", key: "v", metaKey: true, shiftKey: true })))
        .toBeNull();
    });

    it("does NOT intercept bare Ctrl+V — may be used by shell", () => {
      expect(terminalKeyAction(mk({ code: "KeyV", key: "v", ctrlKey: true }))).toBeNull();
    });

    it("Linux/Windows: Ctrl+Shift+V (physical KeyV) returns paste", () => {
      expect(terminalKeyAction(mk({ code: "KeyV", key: "v", ctrlKey: true, shiftKey: true })))
        .toEqual({ kind: "paste" });
      expect(terminalKeyAction(mk({ code: "KeyV", key: "V", ctrlKey: true, shiftKey: true })))
        .toEqual({ kind: "paste" });
    });
  });
});

describe("shouldStopTerminalEventPropagation", () => {
  it("stops bare Ctrl+D from reaching window-level shortcuts", () => {
    expect(
      shouldStopTerminalEventPropagation(
        mk({ code: "KeyD", key: "d", ctrlKey: true }),
      ),
    ).toBe(true);
  });

  it("does not stop actual terminal shortcuts or unrelated keys", () => {
    expect(
      shouldStopTerminalEventPropagation(
        mk({ code: "KeyD", key: "D", ctrlKey: true, shiftKey: true }),
      ),
    ).toBe(false);
    expect(
      shouldStopTerminalEventPropagation(
        mk({ code: "KeyD", key: "d", metaKey: true }),
      ),
    ).toBe(false);
    expect(
      shouldStopTerminalEventPropagation(
        mk({ code: "KeyW", key: "w", ctrlKey: true }),
      ),
    ).toBe(false);
  });
});
