// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DetectedApp } from "../../../types/apps";

const appStore = vi.hoisted(() => ({
  detectedApps: [] as DetectedApp[],
  defaultTerminalAppId: null as string | null,
  setDefaultTerminalAppId: vi.fn((appId: string | null) => {
    appStore.defaultTerminalAppId = appId;
  }),
  pushSettingsOverlay: vi.fn(),
  popSettingsOverlay: vi.fn(),
}));

const serviceMocks = vi.hoisted(() => ({
  setAppSetting: vi.fn(() => Promise.resolve()),
  deleteAppSetting: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../../stores/useAppStore", () => ({
  useAppStore: <T,>(selector: (state: typeof appStore) => T): T =>
    selector(appStore),
}));

vi.mock("../../../services/tauri", () => ({
  setAppSetting: serviceMocks.setAppSetting,
  deleteAppSetting: serviceMocks.deleteAppSetting,
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

import {
  DefaultTerminalSetting,
  terminalAppsFrom,
} from "./DefaultTerminalSetting";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

function app(id: string, name: string, category: DetectedApp["category"]): DetectedApp {
  return {
    id,
    name,
    category,
    detected_path: `/usr/bin/${id}`,
  };
}

async function renderSettings(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  mountedContainers.push(container);
  await act(async () => {
    root.render(<DefaultTerminalSetting />);
  });
  return container;
}

describe("DefaultTerminalSetting", () => {
  beforeEach(() => {
    appStore.detectedApps = [];
    appStore.defaultTerminalAppId = null;
    appStore.setDefaultTerminalAppId.mockClear();
    serviceMocks.setAppSetting.mockClear();
    serviceMocks.deleteAppSetting.mockClear();
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

  it("lists only detected terminal apps in the picker", async () => {
    appStore.detectedApps = [
      app("vscode", "VS Code", "editor"),
      app("ghostty", "Ghostty", "terminal"),
      app("finder", "Finder", "file_manager"),
    ];

    const container = await renderSettings();
    const button = container.querySelector("button[aria-haspopup='listbox']");

    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const options = Array.from(container.querySelectorAll("[role='option']")).map(
      (option) => option.textContent,
    );
    expect(options.join(" ")).toContain("workspace_apps_terminal_auto");
    expect(options.join(" ")).toContain("Ghostty");
    expect(options.join(" ")).not.toContain("VS Code");
    expect(options.join(" ")).not.toContain("Finder");
  });

  it("persists an explicit terminal selection", async () => {
    appStore.detectedApps = [app("ghostty", "Ghostty", "terminal")];

    const container = await renderSettings();
    const button = container.querySelector("button[aria-haspopup='listbox']");

    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const ghostty = Array.from(container.querySelectorAll("[role='option']")).find(
      (option) => option.textContent?.includes("Ghostty"),
    );
    await act(async () => {
      ghostty?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(appStore.setDefaultTerminalAppId).toHaveBeenCalledWith("ghostty");
    expect(serviceMocks.setAppSetting).toHaveBeenCalledWith(
      "default_terminal_app_id",
      "ghostty",
    );
  });

  it("deletes the persisted setting when Auto is selected", async () => {
    appStore.detectedApps = [app("ghostty", "Ghostty", "terminal")];
    appStore.defaultTerminalAppId = "ghostty";

    const container = await renderSettings();
    const button = container.querySelector("button[aria-haspopup='listbox']");

    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const auto = Array.from(container.querySelectorAll("[role='option']")).find(
      (option) => option.textContent?.includes("workspace_apps_terminal_auto"),
    );
    await act(async () => {
      auto?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(appStore.setDefaultTerminalAppId).toHaveBeenCalledWith(null);
    expect(serviceMocks.deleteAppSetting).toHaveBeenCalledWith(
      "default_terminal_app_id",
    );
  });
});

describe("terminalAppsFrom", () => {
  it("keeps terminal apps in detected order", () => {
    expect(
      terminalAppsFrom([
        app("vscode", "VS Code", "editor"),
        app("iterm2", "iTerm2", "terminal"),
        app("ghostty", "Ghostty", "terminal"),
      ]).map((terminal) => terminal.id),
    ).toEqual(["iterm2", "ghostty"]);
  });
});
