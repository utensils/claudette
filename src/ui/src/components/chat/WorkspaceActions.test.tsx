// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DetectedApp } from "../../types/apps";

const appStore = vi.hoisted(() => ({
  addToast: vi.fn(),
  detectedApps: [] as DetectedApp[],
}));

vi.mock("../../stores/useAppStore", () => ({
  useAppStore: <T,>(selector: (state: typeof appStore) => T): T =>
    selector(appStore),
}));

vi.mock("../../services/tauri", () => ({
  openWorkspaceInApp: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) =>
      values?.app ? `${key}:${values.app}` : key,
  }),
}));

import { WorkspaceActions } from "./WorkspaceActions";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

async function renderWorkspaceActions(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  mountedContainers.push(container);
  await act(async () => {
    root.render(<WorkspaceActions worktreePath="/tmp/project" />);
  });
  return container;
}

describe("WorkspaceActions", () => {
  beforeEach(() => {
    appStore.addToast.mockReset();
    appStore.detectedApps = [];
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

  it("renders native app icon data when the detector provides it", async () => {
    appStore.detectedApps = [
      {
        id: "vscode",
        name: "VS Code",
        category: "editor",
        detected_path: "/Applications/Visual Studio Code.app",
        icon_data_url: "data:image/png;base64,abc123",
      },
    ];

    const container = await renderWorkspaceActions();

    const primaryButton = container.querySelector(
      'button[aria-label="workspace_actions_open_in:VS Code"]',
    );
    const image = primaryButton?.querySelector("[aria-hidden='true']");
    expect(image).not.toBeNull();
    expect((image as HTMLElement | null)?.style.backgroundImage).toBe(
      'url("data:image/png;base64,abc123")',
    );
    expect(primaryButton?.querySelector("svg")).toBeNull();
  });

  it("falls back to the generic category icon when native icon data is unavailable", async () => {
    appStore.detectedApps = [
      {
        id: "ghostty",
        name: "Ghostty",
        category: "terminal",
        detected_path: "/usr/bin/ghostty",
      },
    ];

    const container = await renderWorkspaceActions();

    const primaryButton = container.querySelector(
      'button[aria-label="workspace_actions_open_in:Ghostty"]',
    );
    expect(primaryButton?.querySelector("img")).toBeNull();
    expect(primaryButton?.querySelector("svg")).not.toBeNull();
  });
});
