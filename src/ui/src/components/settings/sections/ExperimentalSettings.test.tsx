// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appStore = vi.hoisted(() => ({
  usageInsightsEnabled: false,
  setUsageInsightsEnabled: vi.fn((next: boolean) => {
    appStore.usageInsightsEnabled = next;
  }),
  showOpenRouterBalanceInUsageMeter: true,
  setShowOpenRouterBalanceInUsageMeter: vi.fn((next: boolean) => {
    appStore.showOpenRouterBalanceInUsageMeter = next;
  }),
  settingsFocus: null as string | null,
  clearSettingsFocus: vi.fn(),
}));

const serviceMocks = vi.hoisted(() => ({
  setAppSetting: vi.fn(() => Promise.resolve()),
  openUrl: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../../stores/useAppStore", () => ({
  useAppStore: <T,>(selector: (state: typeof appStore) => T): T =>
    selector(appStore),
}));

vi.mock("../../../services/tauri", () => ({
  setAppSetting: serviceMocks.setAppSetting,
  openUrl: serviceMocks.openUrl,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// Modal renders a portal — for the test we just need its children to be
// in the DOM so we can find/click the confirm button.
vi.mock("../../modals/Modal", () => ({
  Modal: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="modal">{children}</div>
  ),
}));

import { ExperimentalSettings } from "./ExperimentalSettings";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

async function renderSettings(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  mountedContainers.push(container);
  await act(async () => {
    root.render(<ExperimentalSettings />);
  });
  return container;
}

function findUsageToggle(container: HTMLElement): HTMLButtonElement {
  const toggle = container.querySelector(
    'button[aria-label="experimental_claude_code_usage_aria"]',
  );
  if (!toggle) throw new Error("Claude Code Usage toggle not found");
  return toggle as HTMLButtonElement;
}

function findOpenRouterBalanceToggle(container: HTMLElement): HTMLButtonElement {
  const toggle = container.querySelector(
    'button[aria-label="experimental_openrouter_balance_aria"]',
  );
  if (!toggle) throw new Error("OpenRouter balance toggle not found");
  return toggle as HTMLButtonElement;
}

function findConfirmButton(container: HTMLElement): HTMLButtonElement | null {
  const modal = container.querySelector('[data-testid="modal"]');
  if (!modal) return null;
  const buttons = Array.from(modal.querySelectorAll("button"));
  return (
    buttons.find(
      (b) => b.textContent?.trim() === "usage_insights_confirm_enable",
    ) ?? null
  );
}

beforeEach(() => {
  appStore.usageInsightsEnabled = false;
  appStore.showOpenRouterBalanceInUsageMeter = true;
  appStore.settingsFocus = null;
  appStore.setUsageInsightsEnabled.mockClear();
  appStore.setShowOpenRouterBalanceInUsageMeter.mockClear();
  appStore.clearSettingsFocus.mockClear();
  serviceMocks.setAppSetting.mockClear();
  serviceMocks.setAppSetting.mockResolvedValue(undefined);
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

describe("ExperimentalSettings — Usage Insights consent gate", () => {
  it("opens the confirmation modal on OFF→ON without persisting", async () => {
    const container = await renderSettings();

    await act(async () => {
      findUsageToggle(container).click();
    });

    expect(container.querySelector('[data-testid="modal"]')).not.toBeNull();
    expect(serviceMocks.setAppSetting).not.toHaveBeenCalled();
    expect(appStore.setUsageInsightsEnabled).not.toHaveBeenCalled();
  });

  it("persists usage_insights_enabled=true after the user confirms", async () => {
    const container = await renderSettings();

    await act(async () => {
      findUsageToggle(container).click();
    });

    const confirm = findConfirmButton(container);
    expect(confirm).not.toBeNull();

    await act(async () => {
      confirm!.click();
      await Promise.resolve();
    });

    expect(serviceMocks.setAppSetting).toHaveBeenCalledWith(
      "usage_insights_enabled",
      "true",
    );
    expect(container.querySelector('[data-testid="modal"]')).toBeNull();
  });

  it("disables without prompting when already ON", async () => {
    appStore.usageInsightsEnabled = true;
    const container = await renderSettings();

    await act(async () => {
      findUsageToggle(container).click();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="modal"]')).toBeNull();
    expect(serviceMocks.setAppSetting).toHaveBeenCalledWith(
      "usage_insights_enabled",
      "false",
    );
  });
});

describe("ExperimentalSettings — OpenRouter balance toggle", () => {
  it("persists openrouter_balance_in_usage_meter=false when disabled", async () => {
    const container = await renderSettings();

    await act(async () => {
      findOpenRouterBalanceToggle(container).click();
      await Promise.resolve();
    });

    expect(appStore.setShowOpenRouterBalanceInUsageMeter).toHaveBeenCalledWith(
      false,
    );
    expect(serviceMocks.setAppSetting).toHaveBeenCalledWith(
      "openrouter_balance_in_usage_meter",
      "false",
    );
  });

  it("rolls back the OpenRouter toggle when persistence fails", async () => {
    serviceMocks.setAppSetting.mockRejectedValueOnce(new Error("disk full"));
    const container = await renderSettings();

    await act(async () => {
      findOpenRouterBalanceToggle(container).click();
      await Promise.resolve();
    });

    expect(appStore.setShowOpenRouterBalanceInUsageMeter).toHaveBeenNthCalledWith(
      1,
      false,
    );
    expect(appStore.setShowOpenRouterBalanceInUsageMeter).toHaveBeenNthCalledWith(
      2,
      true,
    );
  });
});
