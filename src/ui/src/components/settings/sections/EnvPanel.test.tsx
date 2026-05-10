// @vitest-environment happy-dom
//
// Coverage for the per-repo settings drawer that EnvPanel renders
// inline below each provider row. Replaces the standalone
// RepoEnvProviderSettings.test.tsx contract — same invariants, new
// home now that the form lives next to the row it configures.
//
// Pinned behaviors:
//   - A globally-disabled env-provider (e.g. mise toggled off in
//     Settings → Plugins) gets NO "Settings" button, so the user
//     can't try to configure overrides for a plugin the runtime
//     won't run.
//   - Workspace-mode targets (target.kind === "workspace") never
//     show the Settings button — per-repo overrides are scoped to
//     repos, not individual workspaces.
//   - Clicking "Settings" opens the drawer and lazy-loads
//     `getClaudettePluginRepoSettings` exactly once for that plugin.
//   - The drawer never loads overrides for disabled plugins — pins
//     the filter ordering so we don't waste an IPC round-trip on a
//     row we'll never render.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudettePluginInfo } from "../../../types/claudettePlugins";
import type { EnvSourceInfo } from "../../../types/env";

const claudettePluginServices = vi.hoisted(() => ({
  listClaudettePlugins: vi.fn(),
  getClaudettePluginRepoSettings: vi.fn(),
  setClaudettePluginRepoSetting: vi.fn(),
}));

const envServices = vi.hoisted(() => ({
  getEnvSources: vi.fn(),
  getEnvTargetWorktree: vi.fn(),
  reloadEnv: vi.fn(),
  runEnvTrust: vi.fn(),
  setEnvProviderEnabled: vi.fn(),
}));

vi.mock("../../../services/claudettePlugins", () => claudettePluginServices);
vi.mock("../../../services/env", () => envServices);

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));

vi.mock("../../../hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => [false, vi.fn()],
}));

import { EnvPanel } from "./EnvPanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

function envProvider(
  overrides: Partial<ClaudettePluginInfo> = {},
): ClaudettePluginInfo {
  return {
    name: "env-mise",
    display_name: "mise",
    version: "1.0.0",
    description: "mise env provider",
    kind: "env-provider",
    required_clis: ["mise"],
    cli_available: true,
    enabled: true,
    settings_schema: [
      {
        type: "number",
        key: "timeout_seconds",
        label: "Timeout (seconds)",
        description: null,
        default: 120,
        min: 5,
        max: 600,
        step: 5,
        unit: "seconds",
      },
    ],
    setting_values: { timeout_seconds: 120 },
    ...overrides,
  };
}

function envSource(overrides: Partial<EnvSourceInfo> = {}): EnvSourceInfo {
  return {
    plugin_name: "env-mise",
    display_name: "mise",
    detected: true,
    enabled: true,
    unavailable: false,
    vars_contributed: 3,
    cached: true,
    evaluated_at_ms: Date.now(),
    error: null,
    ...overrides,
  };
}

async function renderEnvPanel(repoId = "repo-1"): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  mountedContainers.push(container);
  await act(async () => {
    root.render(
      <EnvPanel target={{ kind: "repo", repo_id: repoId }} />,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container;
}

describe("EnvPanel — per-repo settings drawer", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    Object.values(claudettePluginServices).forEach((mock) => mock.mockReset());
    Object.values(envServices).forEach((mock) => mock.mockReset());
    claudettePluginServices.getClaudettePluginRepoSettings.mockResolvedValue(
      {},
    );
    envServices.getEnvTargetWorktree.mockResolvedValue("/tmp/repo-1");
    envServices.runEnvTrust.mockResolvedValue(undefined);
    envServices.setEnvProviderEnabled.mockResolvedValue(undefined);
    envServices.reloadEnv.mockResolvedValue(undefined);
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

  it("hides the Settings button for globally-disabled plugins", async () => {
    // Both providers come back from the resolve, but mise is globally
    // disabled in Plugins settings (`enabled: false`). The UI still
    // shows mise's row (so the user can re-enable it via the per-repo
    // toggle), but the Settings drawer must NOT be reachable for it
    // — the runtime won't run a globally-disabled plugin no matter
    // what per-repo overrides say.
    claudettePluginServices.listClaudettePlugins.mockResolvedValue([
      envProvider({
        name: "env-direnv",
        display_name: "direnv",
        enabled: true,
      }),
      envProvider({ name: "env-mise", display_name: "mise", enabled: false }),
    ]);
    envServices.getEnvSources.mockResolvedValue([
      envSource({ plugin_name: "env-direnv", display_name: "direnv" }),
      envSource({ plugin_name: "env-mise", display_name: "mise" }),
    ]);

    const container = await renderEnvPanel();

    // Both rows render (the toggle on the mise row lets the user
    // re-enable it later if they install mise).
    expect(container.textContent).toContain("direnv");
    expect(container.textContent).toContain("mise");

    // direnv has settings + is enabled → Settings button visible.
    // mise is disabled → no Settings button.
    const settingsButtons = Array.from(
      container.querySelectorAll("button"),
    ).filter((btn) => btn.textContent?.trim() === "Settings");
    expect(settingsButtons).toHaveLength(1);
  });

  it("never shows the Settings button in workspace-mode targets", async () => {
    // Per-repo overrides are scoped to the repository, not to
    // individual workspaces. EnvPanel still shows the live status
    // for a workspace target, but the Settings drawer would be
    // misleading there — there's no per-workspace override layer.
    claudettePluginServices.listClaudettePlugins.mockResolvedValue([
      envProvider(),
    ]);
    envServices.getEnvSources.mockResolvedValue([envSource()]);

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    mountedContainers.push(container);
    await act(async () => {
      root.render(
        <EnvPanel target={{ kind: "workspace", workspace_id: "ws-7" }} />,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const settingsButtons = Array.from(
      container.querySelectorAll("button"),
    ).filter((btn) => btn.textContent?.trim() === "Settings");
    expect(settingsButtons).toHaveLength(0);
  });

  it("lazy-loads per-repo overrides only when the user opens the drawer", async () => {
    // Mounting the panel should NOT preemptively fetch every
    // plugin's repo overrides — that would balloon to N round-trips
    // on a fresh repo. Only the first click on a row's Settings
    // button should fetch, and a second click on the same row must
    // NOT re-fetch (we already have the values).
    claudettePluginServices.listClaudettePlugins.mockResolvedValue([
      envProvider(),
    ]);
    envServices.getEnvSources.mockResolvedValue([envSource()]);

    const container = await renderEnvPanel("repo-42");

    // Mount alone: zero fetches.
    expect(
      claudettePluginServices.getClaudettePluginRepoSettings,
    ).not.toHaveBeenCalled();

    // Click "Settings" on mise.
    const settingsBtn = Array.from(
      container.querySelectorAll("button"),
    ).find((btn) => btn.textContent?.trim() === "Settings");
    expect(settingsBtn).toBeDefined();
    await act(async () => {
      settingsBtn!.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(
      claudettePluginServices.getClaudettePluginRepoSettings,
    ).toHaveBeenCalledTimes(1);
    expect(
      claudettePluginServices.getClaudettePluginRepoSettings,
    ).toHaveBeenCalledWith("repo-42", "env-mise");

    // Toggle closed then re-open — should NOT re-fetch (cached).
    await act(async () => {
      settingsBtn!.click();
    });
    await act(async () => {
      settingsBtn!.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(
      claudettePluginServices.getClaudettePluginRepoSettings,
    ).toHaveBeenCalledTimes(1);
  });

  it("does not load per-repo overrides for disabled plugins", async () => {
    // Pins the filter ordering: even if the user somehow triggered a
    // load (they can't via the UI — there's no Settings button — but
    // a future refactor might wire one in), the plugin must remain
    // hidden from the drawer. Verified indirectly by asserting NO
    // call ever lands for `env-mise` while the panel is rendered.
    claudettePluginServices.listClaudettePlugins.mockResolvedValue([
      envProvider({ name: "env-mise", enabled: false }),
    ]);
    envServices.getEnvSources.mockResolvedValue([
      envSource({ plugin_name: "env-mise" }),
    ]);

    await renderEnvPanel();

    const calls =
      claudettePluginServices.getClaudettePluginRepoSettings.mock.calls;
    expect(calls.map(([, plugin]) => plugin)).not.toContain("env-mise");
  });
});
