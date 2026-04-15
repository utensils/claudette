import { describe, it, expect, vi } from "vitest";
import {
  focusChatPrompt,
  focusActiveTerminal,
  isTerminalFocused,
} from "./focusTargets";

/**
 * vitest runs in the Node environment (no `document`), so we hand-roll a
 * minimal Document shim with just the surface `focusTargets` touches. This
 * keeps the helpers testable without pulling in jsdom as a dependency.
 */

type FakeElement = {
  focus: () => void;
  offsetParent?: unknown;
  closest?: (sel: string) => FakeElement | null;
};

function makeDoc(options: {
  chat?: FakeElement | null;
  helpers?: FakeElement[];
  activeElement?: FakeElement | null;
}): Document {
  const { chat = null, helpers = [], activeElement = null } = options;
  return {
    querySelector: ((sel: string) => {
      if (sel === "textarea[data-chat-input]") return chat;
      if (sel === ".xterm-helper-textarea") return helpers[0] ?? null;
      return null;
    }) as Document["querySelector"],
    querySelectorAll: ((sel: string) => {
      if (sel === ".xterm-helper-textarea") {
        return helpers as unknown as NodeListOf<Element>;
      }
      return [] as unknown as NodeListOf<Element>;
    }) as Document["querySelectorAll"],
    activeElement: activeElement as Element | null,
  } as unknown as Document;
}

describe("focusChatPrompt", () => {
  it("focuses the chat textarea and returns true when present", () => {
    const focus = vi.fn();
    const doc = makeDoc({ chat: { focus } });
    expect(focusChatPrompt(doc)).toBe(true);
    expect(focus).toHaveBeenCalledOnce();
  });

  it("returns false when no chat textarea is in the DOM", () => {
    const doc = makeDoc({ chat: null });
    expect(focusChatPrompt(doc)).toBe(false);
  });
});

describe("focusActiveTerminal", () => {
  it("prefers the first helper whose offsetParent is non-null (visible tab)", () => {
    const hidden = { focus: vi.fn(), offsetParent: null };
    const visible = { focus: vi.fn(), offsetParent: {} };
    const doc = makeDoc({ helpers: [hidden, visible] });

    expect(focusActiveTerminal(doc)).toBe(true);
    expect(visible.focus).toHaveBeenCalledOnce();
    expect(hidden.focus).not.toHaveBeenCalled();
  });

  it("falls back to the first helper when none report layout (jsdom/node)", () => {
    const a = { focus: vi.fn(), offsetParent: null };
    const b = { focus: vi.fn(), offsetParent: null };
    const doc = makeDoc({ helpers: [a, b] });

    expect(focusActiveTerminal(doc)).toBe(true);
    expect(a.focus).toHaveBeenCalledOnce();
    expect(b.focus).not.toHaveBeenCalled();
  });

  it("returns false when no terminals exist", () => {
    const doc = makeDoc({ helpers: [] });
    expect(focusActiveTerminal(doc)).toBe(false);
  });
});

describe("isTerminalFocused", () => {
  it("returns true when activeElement is inside an .xterm ancestor", () => {
    const xtermWrapper = { focus: vi.fn() };
    const active: FakeElement = {
      focus: vi.fn(),
      closest: (sel) => (sel === ".xterm" ? xtermWrapper : null),
    };
    const doc = makeDoc({ activeElement: active });
    expect(isTerminalFocused(doc)).toBe(true);
  });

  it("returns false when activeElement is outside any xterm", () => {
    const active: FakeElement = {
      focus: vi.fn(),
      closest: () => null,
    };
    const doc = makeDoc({ activeElement: active });
    expect(isTerminalFocused(doc)).toBe(false);
  });

  it("returns false when activeElement is null", () => {
    const doc = makeDoc({ activeElement: null });
    expect(isTerminalFocused(doc)).toBe(false);
  });
});
