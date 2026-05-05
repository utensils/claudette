import { describe, expect, it } from "vitest";
import { shortcutMatchesQuery } from "./keyboardSearch";

const mk = (description: string, category = "Navigation", bindingLabel = "") => ({
  description,
  category,
  bindingLabel,
});

describe("shortcutMatchesQuery", () => {
  it("returns every shortcut when the query is empty or whitespace", () => {
    expect(shortcutMatchesQuery(mk("Toggle left sidebar"), "")).toBe(true);
    expect(shortcutMatchesQuery(mk("Toggle left sidebar"), "   ")).toBe(true);
  });

  it("matches the action description case-insensitively", () => {
    expect(shortcutMatchesQuery(mk("Open fuzzy finder"), "FUZZY")).toBe(true);
    expect(shortcutMatchesQuery(mk("Open fuzzy finder"), "fuz")).toBe(true);
    expect(shortcutMatchesQuery(mk("Open fuzzy finder"), "settings")).toBe(false);
  });

  it("matches against the category name", () => {
    expect(
      shortcutMatchesQuery(mk("Push to talk", "Voice"), "voice"),
    ).toBe(true);
  });

  it("matches against the formatted binding label", () => {
    expect(
      shortcutMatchesQuery(mk("Toggle left sidebar", "Navigation", "⌘ B"), "⌘"),
    ).toBe(true);
    expect(
      shortcutMatchesQuery(mk("Toggle left sidebar", "Navigation", "⌘ B"), "ctrl"),
    ).toBe(false);
  });

  it("matches the binding regardless of separator style", () => {
    // KeyboardSettings.tsx includes three forms in the haystack so users
    // can type the binding however they think of it — see the comment at
    // the bindingLabel construction site.
    const action = mk(
      "Toggle left sidebar",
      "Navigation",
      "⌘ B ⌘B ⌘+B",
    );
    expect(shortcutMatchesQuery(action, "⌘B")).toBe(true);
    expect(shortcutMatchesQuery(action, "⌘+B")).toBe(true);
    expect(shortcutMatchesQuery(action, "⌘ B")).toBe(true);
  });

  it("ANDs whitespace-separated tokens — order doesn't matter", () => {
    const action = mk("Split terminal side by side", "Terminal");
    expect(shortcutMatchesQuery(action, "terminal split")).toBe(true);
    expect(shortcutMatchesQuery(action, "split terminal")).toBe(true);
    expect(shortcutMatchesQuery(action, "terminal panel")).toBe(false);
  });

  it("finds the push-to-talk shortcut by `talk` or `push`", () => {
    const action = mk("Push to talk", "Voice", "Right ⌥");
    expect(shortcutMatchesQuery(action, "talk")).toBe(true);
    expect(shortcutMatchesQuery(action, "push")).toBe(true);
    expect(shortcutMatchesQuery(action, "push to talk")).toBe(true);
    expect(shortcutMatchesQuery(action, "hold")).toBe(false);
  });
});
