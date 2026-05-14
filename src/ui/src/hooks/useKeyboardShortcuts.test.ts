// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { shouldDeferSettingsEscapeForElement } from "./useKeyboardShortcuts";

describe("shouldDeferSettingsEscapeForElement", () => {
  it("defers Settings Escape for native selects only", () => {
    expect(shouldDeferSettingsEscapeForElement(document.createElement("select")))
      .toBe(true);
    expect(shouldDeferSettingsEscapeForElement(document.createElement("input")))
      .toBe(false);
    expect(shouldDeferSettingsEscapeForElement(document.createElement("textarea")))
      .toBe(false);
    expect(shouldDeferSettingsEscapeForElement(document.createElement("button")))
      .toBe(false);
    expect(shouldDeferSettingsEscapeForElement(null)).toBe(false);
  });
});
