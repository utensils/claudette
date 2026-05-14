// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  shouldDeferSettingsEscapeForElement,
  useKeyboardShortcuts,
} from "./useKeyboardShortcuts";
import { useAppStore } from "../stores/useAppStore";

function Harness() {
  useKeyboardShortcuts();
  return null;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderHarness() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(Harness));
  });
}

async function pressEscape() {
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
}

describe("shouldDeferSettingsEscapeForElement", () => {
  it("keeps Settings Escape local to focused native fields", () => {
    expect(shouldDeferSettingsEscapeForElement(document.createElement("input")))
      .toBe(true);
    const searchInput = document.createElement("input");
    searchInput.type = "search";
    expect(shouldDeferSettingsEscapeForElement(searchInput)).toBe(true);
    const numberInput = document.createElement("input");
    numberInput.type = "number";
    expect(shouldDeferSettingsEscapeForElement(numberInput)).toBe(true);
    expect(shouldDeferSettingsEscapeForElement(document.createElement("textarea")))
      .toBe(true);
    expect(shouldDeferSettingsEscapeForElement(document.createElement("select")))
      .toBe(true);
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    expect(shouldDeferSettingsEscapeForElement(checkbox)).toBe(false);
    const radio = document.createElement("input");
    radio.type = "radio";
    expect(shouldDeferSettingsEscapeForElement(radio)).toBe(false);
    expect(shouldDeferSettingsEscapeForElement(document.createElement("button")))
      .toBe(false);
    expect(shouldDeferSettingsEscapeForElement(null)).toBe(false);
  });
});

describe("useKeyboardShortcuts Settings Escape", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    useAppStore.setState({
      activeModal: null,
      commandPaletteOpen: false,
      fuzzyFinderOpen: false,
      settingsOpen: true,
      settingsOverlayCount: 0,
    });
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
    }
    root = null;
    container = null;
    document.body.innerHTML = "";
    useAppStore.setState({
      settingsOpen: false,
      settingsOverlayCount: 0,
    });
  });

  it("blurs a focused Settings text input before closing Settings", async () => {
    await renderHarness();
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);

    await pressEscape();
    expect(document.activeElement).not.toBe(input);
    expect(useAppStore.getState().settingsOpen).toBe(true);

    await pressEscape();
    expect(useAppStore.getState().settingsOpen).toBe(false);
  });
});
