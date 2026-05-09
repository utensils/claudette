// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DetectedApp } from "../../../types/apps";

const appStore = vi.hoisted(() => ({
  worktreeBaseDir: "/tmp/workspaces",
  setWorktreeBaseDir: vi.fn(),
  updateAvailable: false,
  updateVersion: null as string | null,
  updateChannel: "stable" as const,
  updateDownloading: false,
  updateProgress: 0,
  updateInstallWhenIdle: false,
  openModal: vi.fn(),
  detectedApps: [] as DetectedApp[],
  defaultTerminalAppId: null as string | null,
  setDefaultTerminalAppId: vi.fn(),
}));

vi.mock("../../../stores/useAppStore", () => ({
  useAppStore: <T,>(selector: (state: typeof appStore) => T): T =>
    selector(appStore),
}));

vi.mock("../../../services/tauri", () => ({
  getAppSetting: vi.fn(() => Promise.resolve(null)),
  setAppSetting: vi.fn(() => Promise.resolve()),
  deleteAppSetting: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../../hooks/useAutoUpdater", () => ({
  applyUpdateChannel: vi.fn(() => Promise.resolve()),
  checkForUpdate: vi.fn(() => Promise.resolve("up-to-date")),
  installNow: vi.fn(),
  installWhenIdle: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn(() => Promise.resolve("0.0.0-test")),
}));

vi.mock("../../../i18n", () => ({
  default: { changeLanguage: vi.fn(() => Promise.resolve()) },
  isSupportedLanguage: vi.fn(() => true),
}));

vi.mock("../../chat/WorkspaceActions", () => ({
  AppIcon: ({ app }: { app: DetectedApp }) => (
    <span data-testid={`app-icon-${app.id}`} />
  ),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

import { GeneralSettings } from "./GeneralSettings";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

async function renderGeneralSettings(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  mountedContainers.push(container);
  await act(async () => {
    root.render(<GeneralSettings />);
  });
  return container;
}

describe("GeneralSettings", () => {
  beforeEach(() => {
    appStore.detectedApps = [];
    appStore.defaultTerminalAppId = null;
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

  it("renders the default terminal picker in General", async () => {
    appStore.detectedApps = [
      {
        id: "ghostty",
        name: "Ghostty",
        category: "terminal",
        detected_path: "/usr/bin/ghostty",
      },
    ];

    const container = await renderGeneralSettings();

    expect(container.textContent).toContain("general_title");
    expect(container.textContent).toContain("workspace_apps_default_terminal");
    expect(container.textContent).toContain(
      "workspace_apps_default_terminal_desc",
    );
    expect(
      container.querySelector(
        'button[aria-label="workspace_apps_default_terminal"]',
      ),
    ).not.toBeNull();
  });
});
