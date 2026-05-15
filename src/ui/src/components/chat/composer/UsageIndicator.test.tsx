// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeCodeUsage } from "../../../types/usage";

const appStore = vi.hoisted(() => ({
  usageInsightsEnabled: false,
  claudeCodeUsage: null as ClaudeCodeUsage | null,
}));

vi.mock("../../../stores/useAppStore", () => ({
  useAppStore: <T,>(selector: (state: typeof appStore) => T): T =>
    selector(appStore),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (!opts) return key;
      const args = Object.entries(opts)
        .map(([k, v]) => `${k}=${v}`)
        .join(",");
      return `${key}(${args})`;
    },
  }),
}));

import { UsageIndicator } from "./UsageIndicator";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

async function render(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  mountedContainers.push(container);
  await act(async () => {
    root.render(<UsageIndicator />);
  });
  return container;
}

function fakeUsage(
  partial: Partial<ClaudeCodeUsage["usage"]> = {},
): ClaudeCodeUsage {
  const futureIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  return {
    subscription_type: "pro",
    rate_limit_tier: "default_claude_pro",
    fetched_at: Date.now(),
    usage: {
      five_hour: { utilization: 35, resets_at: futureIso },
      seven_day: null,
      seven_day_sonnet: null,
      seven_day_opus: null,
      extra_usage: null,
      ...partial,
    },
  };
}

beforeEach(() => {
  appStore.usageInsightsEnabled = false;
  appStore.claudeCodeUsage = null;
});

afterEach(async () => {
  for (const root of mountedRoots.splice(0).reverse()) {
    await act(async () => {
      root.unmount();
    });
  }
  for (const container of mountedContainers.splice(0)) {
    container.remove();
  }
});

describe("UsageIndicator", () => {
  it("renders nothing when Usage Insights is disabled", async () => {
    appStore.usageInsightsEnabled = false;
    appStore.claudeCodeUsage = fakeUsage();
    const container = await render();
    expect(container.querySelector("button")).toBeNull();
  });

  it("renders nothing when no usage data has been fetched yet", async () => {
    appStore.usageInsightsEnabled = true;
    appStore.claudeCodeUsage = null;
    const container = await render();
    expect(container.querySelector("button")).toBeNull();
  });

  it("renders nothing when the API returned no populated buckets", async () => {
    appStore.usageInsightsEnabled = true;
    appStore.claudeCodeUsage = fakeUsage({ five_hour: null });
    const container = await render();
    expect(container.querySelector("button")).toBeNull();
  });

  it("renders the indicator with the picked bucket's used percent", async () => {
    appStore.usageInsightsEnabled = true;
    appStore.claudeCodeUsage = fakeUsage();
    const container = await render();
    const button = container.querySelector("button");
    expect(button).not.toBeNull();
    expect(button?.textContent).toContain("35%");
    expect(button?.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens the popover when clicked, closes it on a second click", async () => {
    appStore.usageInsightsEnabled = true;
    appStore.claudeCodeUsage = fakeUsage();
    const container = await render();
    const button = container.querySelector("button");
    expect(button).not.toBeNull();

    await act(async () => button!.click());
    expect(button!.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () => button!.click());
    expect(button!.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("closes the popover on Escape", async () => {
    appStore.usageInsightsEnabled = true;
    appStore.claudeCodeUsage = fakeUsage();
    const container = await render();
    const button = container.querySelector("button")!;

    await act(async () => button.click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes the popover on click outside (not on trigger)", async () => {
    appStore.usageInsightsEnabled = true;
    appStore.claudeCodeUsage = fakeUsage();
    const container = await render();
    const button = container.querySelector("button")!;

    await act(async () => button.click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    const outside = document.createElement("div");
    document.body.appendChild(outside);
    await act(async () => {
      outside.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, composed: true }),
      );
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    outside.remove();
  });
});
