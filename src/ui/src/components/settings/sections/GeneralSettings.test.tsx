// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DetectedApp } from "../../../types/apps";

type MockAuthStatus = {
  state: "signed_in" | "signed_out" | "unknown";
  loggedIn: boolean;
  verified: boolean;
  authMethod: string | null;
  apiProvider: string | null;
  message: string | null;
};

const appStore = vi.hoisted(() => ({
  worktreeBaseDir: "/tmp/workspaces",
  setWorktreeBaseDir: vi.fn(),
  settingsFocus: null as string | null,
  clearSettingsFocus: vi.fn(),
  claudeAuthFailure: null as { messageId: string | null; error: string } | null,
  setClaudeAuthFailure: vi.fn(),
  setResolvedClaudeAuthFailureMessageId: vi.fn(),
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

const serviceMocks = vi.hoisted(() => ({
  getAppSetting: vi.fn(() => Promise.resolve(null)),
  setAppSetting: vi.fn(() => Promise.resolve()),
  deleteAppSetting: vi.fn(() => Promise.resolve()),
  getClaudeAuthStatus: vi.fn<() => Promise<MockAuthStatus>>(() =>
    Promise.resolve({
      state: "signed_out",
      loggedIn: false,
      verified: false,
      authMethod: null,
      apiProvider: null,
      message: null,
    }),
  ),
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
    appStore.settingsFocus = null;
    appStore.clearSettingsFocus.mockClear();
    appStore.claudeAuthFailure = null;
    appStore.setClaudeAuthFailure.mockClear();
    appStore.setResolvedClaudeAuthFailureMessageId.mockClear();
    serviceMocks.getClaudeAuthStatus.mockClear();
    serviceMocks.getClaudeAuthStatus.mockResolvedValue({
      state: "signed_out",
      loggedIn: false,
      verified: false,
      authMethod: null,
      apiProvider: null,
      message: null,
    });
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

  it("checks Claude Code auth status in General", async () => {
    serviceMocks.getClaudeAuthStatus.mockResolvedValue({
      state: "signed_in",
      loggedIn: true,
      verified: false,
      authMethod: "oauth_token",
      apiProvider: "firstParty",
      message: null,
    });

    const container = await renderGeneralSettings();
    await act(async () => {
      await Promise.resolve();
    });

    expect(serviceMocks.getClaudeAuthStatus).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("auth_setting_label");
    expect(container.textContent).toContain("auth_status_signed_in");
  });

  it("surfaces a chat auth failure over local credential status", async () => {
    appStore.claudeAuthFailure = {
      messageId: "assistant-1",
      error: "Failed to authenticate. API Error: 401 Invalid authentication credentials",
    };
    serviceMocks.getClaudeAuthStatus.mockResolvedValue({
      state: "signed_in",
      loggedIn: true,
      verified: false,
      authMethod: "oauth_token",
      apiProvider: "firstParty",
      message: null,
    });

    const container = await renderGeneralSettings();
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain("auth_status_last_failure");
    expect(container.textContent).toContain(
      "Invalid authentication credentials (401)",
    );
    expect(container.textContent).not.toContain("auth_status_signed_in");
  });
});
