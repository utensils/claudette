import { describe, expect, it } from "vitest";
import { tooltipForBoundHotkey, tooltipWithHotkey } from "./display";
import type { KeybindingMap } from "./bindings";

const bound: KeybindingMap = {
  "global.jump-to-project-1": "mod+1",
};
// An explicit null override unbinds an action — an absent key falls back to
// the registered default binding, which is what users get out of the box.
const unbound: KeybindingMap = {
  "global.jump-to-project-1": null,
  "global.open-settings": null,
};

describe("tooltipForBoundHotkey", () => {
  it("returns the tooltip with the shortcut suffix when the action is bound", () => {
    expect(
      tooltipForBoundHotkey(
        "Jump to project 1",
        "global.jump-to-project-1",
        bound,
        false,
      ),
    ).toBe("Jump to project 1 (Ctrl+1)");
  });

  it("returns undefined when the action is unbound — the row shouldn't advertise a missing hotkey", () => {
    expect(
      tooltipForBoundHotkey(
        "Jump to project 1",
        "global.jump-to-project-1",
        unbound,
        false,
      ),
    ).toBeUndefined();
  });
});

describe("tooltipWithHotkey", () => {
  it("falls back to the bare tooltip when unbound (use this when the tooltip carries info beyond the shortcut)", () => {
    expect(
      tooltipWithHotkey(
        "Settings",
        "global.open-settings",
        unbound,
        false,
      ),
    ).toBe("Settings");
  });
});
