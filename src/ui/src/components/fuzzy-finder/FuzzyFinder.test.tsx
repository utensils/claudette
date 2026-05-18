// @vitest-environment happy-dom

// Regression test: pressing Escape inside the fuzzy finder used to bubble
// through to the global `dismiss-or-stop` handler in `useKeyboardShortcuts`.
// Because that listener captured `fuzzyFinderOpen` in a closure that didn't
// update until React re-rendered, the global branch fell through to the
// agent-stop path and cancelled the running workspace. The component now
// calls preventDefault + stopImmediatePropagation so the global listener
// never sees the event.

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FuzzyFinder } from "./FuzzyFinder";
import { useAppStore } from "../../stores/useAppStore";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(FuzzyFinder));
  });
}

describe("FuzzyFinder Escape handling", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    useAppStore.setState({
      workspaces: [],
      repositories: [],
      fuzzyFinderOpen: true,
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
    useAppStore.setState({ fuzzyFinderOpen: false });
  });

  it("closes the finder and stops the native event from bubbling to window", async () => {
    await mount();

    const input = container!.querySelector("input");
    expect(input).toBeTruthy();

    // Listen at the window so we can assert the event never reaches the
    // global keyboard handler — `stopImmediatePropagation()` should prevent
    // any window-level listener from firing.
    let windowSawEscape = false;
    const windowListener = (e: KeyboardEvent) => {
      if (e.key === "Escape") windowSawEscape = true;
    };
    window.addEventListener("keydown", windowListener);

    await act(async () => {
      input!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    window.removeEventListener("keydown", windowListener);

    expect(useAppStore.getState().fuzzyFinderOpen).toBe(false);
    expect(windowSawEscape).toBe(false);
  });
});
