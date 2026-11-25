// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import i18n from "../../i18n";
import type { CompactionEvent } from "../../utils/compactionSentinel";
import { CompactionDivider } from "./CompactionDivider";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  await i18n.changeLanguage("en");
});

const event = (over: Partial<CompactionEvent> = {}): CompactionEvent => ({
  timestamp: "2026-11-25T00:00:00Z",
  trigger: "manual",
  preTokens: 151_234,
  postTokens: 1_000,
  durationMs: 75_000,
  afterMessageIndex: 0,
  ...over,
});

async function tooltip(ev: CompactionEvent): Promise<string | null> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(<CompactionDivider event={ev} />);
  });
  return container.firstElementChild?.getAttribute("title") ?? null;
}

describe("CompactionDivider tooltip", () => {
  it("renders the English breakdown unchanged", async () => {
    expect(await tooltip(event())).toBe(
      [
        "Context compacted (manual, 1m 15s)",
        "",
        "Before: 151,234 tokens",
        "After:  1,000 tokens",
        "Freed:  150,234 tokens",
      ].join("\n"),
    );
    expect(await tooltip(event({ durationMs: 9_400 }))).toContain("(manual, 9s)");
  });

  it("localizes the duration units", async () => {
    await i18n.changeLanguage("fr");
    const title = await tooltip(event());
    expect(title).toContain("1 min 15 s");
    expect(title).toContain("Avant : 151,234 tokens");
  });
});
