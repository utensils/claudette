import { describe, it, expect } from "vitest";
import { cycleTabId, terminalKeyAction } from "./terminalShortcuts";

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
};

function mk(init: KeyInit): KeyboardEvent {
  return {
    type: init.type ?? "keydown",
    key: init.key ?? "",
    code: init.code ?? "",
    metaKey: init.metaKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    shiftKey: init.shiftKey ?? false,
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
      .toEqual({ kind: "zoom", direction: "in" });
  });

  it("recognizes Cmd+Shift+= (key='+') as zoom-in via code", () => {
    // On US keyboards Shift+= produces "+", but code stays "Equal"
    expect(terminalKeyAction(mk({ key: "+", code: "Equal", metaKey: true, shiftKey: true })))
      .toEqual({ kind: "zoom", direction: "in" });
  });

  it("recognizes Cmd+- as zoom-out (code-based)", () => {
    expect(terminalKeyAction(mk({ code: "Minus", metaKey: true })))
      .toEqual({ kind: "zoom", direction: "out" });
  });

  it("recognizes Ctrl+= as zoom-in (Linux)", () => {
    expect(terminalKeyAction(mk({ code: "Equal", ctrlKey: true })))
      .toEqual({ kind: "zoom", direction: "in" });
  });

  it("recognizes Ctrl+- as zoom-out (Linux)", () => {
    expect(terminalKeyAction(mk({ code: "Minus", ctrlKey: true })))
      .toEqual({ kind: "zoom", direction: "out" });
  });
});
