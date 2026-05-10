// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appStore = vi.hoisted(() => ({
  claudeCodeUsage: null,
  setClaudeCodeUsage: vi.fn(),
}));

const serviceMocks = vi.hoisted(() => ({
  getClaudeCodeUsage: vi.fn(),
  openUsageSettings: vi.fn(() => Promise.resolve()),
  claudeAuthLogin: vi.fn(() => Promise.resolve()),
  cancelClaudeAuthLogin: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../../stores/useAppStore", () => ({
  useAppStore: <T,>(selector: (state: typeof appStore) => T): T =>
    selector(appStore),
}));

vi.mock("../../../services/tauri", () => serviceMocks);

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

import { UsageSettings } from "./UsageSettings";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

async function renderUsageSettings(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  mountedContainers.push(container);
  await act(async () => {
    root.render(<UsageSettings />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

describe("UsageSettings auth failures", () => {
  beforeEach(() => {
    appStore.claudeCodeUsage = null;
    appStore.setClaudeCodeUsage.mockClear();
    serviceMocks.getClaudeCodeUsage.mockReset();
    document.body.innerHTML = "";
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

  it("renders the shared auth panel for Claude Code auth errors", async () => {
    serviceMocks.getClaudeCodeUsage.mockRejectedValue(
      new Error("Token refresh failed: HTTP 401"),
    );

    const container = await renderUsageSettings();

    expect(container.textContent).toContain("auth_panel_title");
    expect(container.textContent).toContain("Token refresh failed: HTTP 401");
  });
});
