// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DetectedApp } from "../../types/apps";

const appStore = vi.hoisted(() => ({
  addToast: vi.fn(),
  detectedApps: [] as DetectedApp[],
  workspaceAppsMenuShown: null as string[] | null,
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

import { WorkspaceActions, splitMenuApps } from "./WorkspaceActions";

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
    appStore.workspaceAppsMenuShown = null;
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

  it("shows no More row when the menu is uncurated", async () => {
    appStore.detectedApps = [
      app("vscode", "VS Code", "editor"),
      app("zed", "Zed", "editor"),
    ];

    const container = await renderWorkspaceActions();
    await act(async () => {
      container
        .querySelector('button[aria-label="workspace_actions_menu"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const labels = Array.from(
      container.querySelectorAll('[role="menuitem"]'),
    ).map((el) => el.textContent);
    expect(labels).toContain("VS Code");
    expect(labels).toContain("Zed");
    expect(labels.some((l) => l?.includes("workspace_actions_more"))).toBe(
      false,
    );
  });

  it("surfaces hidden apps under the More flyout when curated", async () => {
    appStore.detectedApps = [
      app("vscode", "VS Code", "editor"),
      app("zed", "Zed", "editor"),
      app("ghostty", "Ghostty", "terminal"),
    ];
    appStore.workspaceAppsMenuShown = ["vscode"];

    const container = await renderWorkspaceActions();
    await act(async () => {
      container
        .querySelector('button[aria-label="workspace_actions_menu"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const more = Array.from(
      container.querySelectorAll('[role="menuitem"]'),
    ).find((el) =>
      el.textContent?.includes("workspace_actions_more"),
    ) as HTMLButtonElement | undefined;
    expect(more).toBeTruthy();

    // Flyout is closed until the More row is activated.
    expect(container.textContent).not.toContain("Ghostty");
    await act(async () => {
      more?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const labels = Array.from(
      container.querySelectorAll('[role="menuitem"]'),
    ).map((el) => el.textContent);
    // Hidden apps are now reachable; the curated app stays at the top level.
    expect(labels).toContain("Ghostty");
    expect(labels).toContain("Zed");
    expect(labels).toContain("VS Code");
  });
});

describe("splitMenuApps", () => {
  const apps = [
    app("vscode", "VS Code", "editor"),
    app("zed", "Zed", "editor"),
    app("finder", "Finder", "file_manager"),
    app("ghostty", "Ghostty", "terminal"),
  ];

  it("shows everything in category order when uncurated", () => {
    const { shown, more } = splitMenuApps(apps, null);
    expect(shown.map((a) => a.id)).toEqual([
      "vscode",
      "zed",
      "finder",
      "ghostty",
    ]);
    expect(more).toEqual([]);
  });

  it("respects the curated order and folds the rest into More", () => {
    const { shown, more } = splitMenuApps(apps, ["ghostty", "vscode"]);
    expect(shown.map((a) => a.id)).toEqual(["ghostty", "vscode"]);
    // "More" stays in category order regardless of the curated order.
    expect(more.map((a) => a.id)).toEqual(["zed", "finder"]);
  });

  it("drops stale IDs and never duplicates", () => {
    const { shown, more } = splitMenuApps(apps, [
      "missing",
      "zed",
      "zed",
      "ghostty",
    ]);
    expect(shown.map((a) => a.id)).toEqual(["zed", "ghostty"]);
    expect(more.map((a) => a.id)).toEqual(["vscode", "finder"]);
  });

  it("allows an empty top level (everything under More)", () => {
    const { shown, more } = splitMenuApps(apps, []);
    expect(shown).toEqual([]);
    expect(more.map((a) => a.id)).toEqual([
      "vscode",
      "zed",
      "finder",
      "ghostty",
    ]);
  });
});
