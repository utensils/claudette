// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DetectedApp } from "../../../types/apps";

const appStore = vi.hoisted(() => ({
  detectedApps: [] as DetectedApp[],
  workspaceAppsMenuShown: null as string[] | null,
  setWorkspaceAppsMenuShown: vi.fn((ids: string[] | null) => {
    appStore.workspaceAppsMenuShown = ids;
  }),
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

vi.mock("./DefaultTerminalSetting", () => ({
  DefaultTerminalSetting: () => <div data-testid="default-terminal-setting" />,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) =>
      values?.app ? `${key}:${values.app}` : key,
  }),
}));

import { AppsSettings } from "./AppsSettings";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

function app(
  id: string,
  name: string,
  category: DetectedApp["category"],
): DetectedApp {
  return { id, name, category, detected_path: `/usr/bin/${id}` };
}

async function renderSettings(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  mountedContainers.push(container);
  await act(async () => {
    root.render(<AppsSettings />);
  });
  return container;
}

function clickButton(container: HTMLElement, label: string) {
  const button = Array.from(container.querySelectorAll("button")).find(
    (b) => b.getAttribute("aria-label") === label || b.textContent === label,
  );
  if (!button) throw new Error(`button not found: ${label}`);
  return act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("AppsSettings", () => {
  beforeEach(() => {
    appStore.detectedApps = [
      app("vscode", "VS Code", "editor"),
      app("zed", "Zed", "editor"),
      app("ghostty", "Ghostty", "terminal"),
    ];
    appStore.workspaceAppsMenuShown = null;
    appStore.setWorkspaceAppsMenuShown.mockClear();
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

  it("removing an app persists the remaining IDs as the allowlist", async () => {
    const container = await renderSettings();
    await clickButton(container, "apps_menu_remove:Zed");

    expect(appStore.setWorkspaceAppsMenuShown).toHaveBeenCalledWith([
      "vscode",
      "ghostty",
    ]);
    expect(serviceMocks.setAppSetting).toHaveBeenCalledWith(
      "workspace_apps_menu",
      JSON.stringify({ shown: ["vscode", "ghostty"] }),
    );
  });

  it("adding an app appends it to the shown list", async () => {
    appStore.workspaceAppsMenuShown = ["vscode"];
    const container = await renderSettings();
    await clickButton(container, "apps_menu_add:Ghostty");

    expect(serviceMocks.setAppSetting).toHaveBeenCalledWith(
      "workspace_apps_menu",
      JSON.stringify({ shown: ["vscode", "ghostty"] }),
    );
  });

  it("move down reorders the shown list", async () => {
    appStore.workspaceAppsMenuShown = ["vscode", "zed", "ghostty"];
    const container = await renderSettings();
    await clickButton(container, "apps_menu_move_down:VS Code");

    expect(serviceMocks.setAppSetting).toHaveBeenCalledWith(
      "workspace_apps_menu",
      JSON.stringify({ shown: ["zed", "vscode", "ghostty"] }),
    );
  });

  it("reset clears the persisted setting", async () => {
    appStore.workspaceAppsMenuShown = ["vscode"];
    const container = await renderSettings();
    await clickButton(container, "apps_menu_reset");

    expect(appStore.setWorkspaceAppsMenuShown).toHaveBeenCalledWith(null);
    expect(serviceMocks.deleteAppSetting).toHaveBeenCalledWith(
      "workspace_apps_menu",
    );
  });

  it("disables reset until the menu is customized", async () => {
    const container = await renderSettings();
    const reset = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "apps_menu_reset",
    ) as HTMLButtonElement;
    expect(reset.disabled).toBe(true);
  });

  it("shows an empty state when no apps are detected", async () => {
    appStore.detectedApps = [];
    const container = await renderSettings();
    expect(container.textContent).toContain("apps_menu_empty");
  });
});
