// @vitest-environment happy-dom
//
// Regression coverage for the per-repo Environment Provider Overrides
// panel. The original bug: a globally-disabled env-provider (e.g.
// `mise` toggled off in Settings → Plugins) still showed up in the
// per-repo "Environment provider overrides" form, and any saved
// per-repo setting (`auto_trust = true`) appeared as if it would take
// effect. The runtime short-circuits with `PluginDisabled` regardless
// of per-repo overrides, so the panel was misleading the user about
// what would actually run.
//
// Fix: filter out plugins where `enabled === false` before rendering.
// These tests pin the contract so a future refactor that drops the
// filter (or reorders it past the override-loader) fails fast.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudettePluginInfo } from "../../../types/claudettePlugins";

const claudettePluginServices = vi.hoisted(() => ({
  listClaudettePlugins: vi.fn(),
  setClaudettePluginRepoSetting: vi.fn(),
  getClaudettePluginRepoSettings: vi.fn(),
}));

vi.mock("../../../services/claudettePlugins", () => claudettePluginServices);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallbackOrValues?: string | Record<string, unknown>) =>
      typeof fallbackOrValues === "string" ? fallbackOrValues : key,
  }),
}));

import { RepoEnvProviderSettings } from "./RepoEnvProviderSettings";

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
        type: "boolean",
        key: "auto_trust",
        label: "Always trust mise config",
        description: null,
        default: false,
      },
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
    setting_values: { auto_trust: false, timeout_seconds: 120 },
    ...overrides,
  };
}

async function renderPanel(repoId = "repo-1"): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  mountedContainers.push(container);
  await act(async () => {
    root.render(<RepoEnvProviderSettings repoId={repoId} />);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return container;
}

describe("RepoEnvProviderSettings", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    Object.values(claudettePluginServices).forEach((mock) => mock.mockReset());
    claudettePluginServices.getClaudettePluginRepoSettings.mockResolvedValue({});
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

  it("hides globally-disabled env-providers from the per-repo overrides", async () => {
    // Two env-providers: direnv globally enabled, mise globally
    // disabled. The disabled one must NOT appear in the per-repo
    // panel, otherwise the user would see (and try to configure)
    // settings for a plugin that the runtime won't run.
    claudettePluginServices.listClaudettePlugins.mockResolvedValue([
      envProvider({
        name: "env-direnv",
        display_name: "direnv",
        enabled: true,
        settings_schema: [
          {
            type: "boolean",
            key: "auto_allow",
            label: "Always allow .envrc",
            description: null,
            default: false,
          },
        ],
        setting_values: { auto_allow: false },
      }),
      envProvider({
        name: "env-mise",
        display_name: "mise",
        enabled: false,
      }),
    ]);

    const container = await renderPanel();

    expect(container.textContent).toContain("direnv");
    expect(container.textContent).not.toContain("mise");
    // The internal-name chip is the most reliable sentinel — display
    // names sometimes overlap (e.g. multiple plugins could ship a
    // "mise" provider in the future), but `env-mise` is unique.
    expect(container.textContent).not.toContain("env-mise");
  });

  it("does not request per-repo settings for globally-disabled env-providers", async () => {
    // Loading per-repo overrides for a hidden plugin would be wasted
    // I/O and would also leak the disabled plugin's configured
    // overrides into the form state. Pinning this asserts the
    // filter happens BEFORE the override-loader, not after.
    claudettePluginServices.listClaudettePlugins.mockResolvedValue([
      envProvider({ name: "env-direnv", display_name: "direnv", enabled: true }),
      envProvider({ name: "env-mise", display_name: "mise", enabled: false }),
    ]);

    await renderPanel("repo-7");

    const calls =
      claudettePluginServices.getClaudettePluginRepoSettings.mock.calls;
    const requestedPlugins = calls.map(([, plugin]) => plugin);
    expect(requestedPlugins).toContain("env-direnv");
    expect(requestedPlugins).not.toContain("env-mise");
  });

  it("returns nothing to render when every env-provider is globally disabled", async () => {
    // Edge case: user has globally disabled all env-providers. The
    // panel should render no list at all (the component returns
    // null) so the Repo Settings page doesn't display an empty
    // "Env provider overrides" header with no fields under it.
    claudettePluginServices.listClaudettePlugins.mockResolvedValue([
      envProvider({ name: "env-direnv", enabled: false }),
      envProvider({ name: "env-mise", enabled: false }),
      envProvider({ name: "env-dotenv", enabled: false }),
      envProvider({ name: "env-nix-devshell", enabled: false }),
    ]);

    const container = await renderPanel();

    // No header text should render. The component short-circuits on
    // `plugins.length === 0` after filtering.
    expect(container.textContent).toBe("");
  });

  it("hides env-providers that have no manifest settings, regardless of enabled state", async () => {
    // Existing behavior: providers with empty settings_schema are
    // already filtered out (no per-repo knobs to expose). Pinning
    // this so the new `enabled` filter doesn't accidentally
    // re-introduce them.
    claudettePluginServices.listClaudettePlugins.mockResolvedValue([
      envProvider({
        name: "env-direnv",
        enabled: true,
        settings_schema: [],
        setting_values: {},
      }),
      envProvider({
        name: "env-mise",
        display_name: "mise",
        enabled: true,
      }),
    ]);

    const container = await renderPanel();

    // mise has settings → renders. direnv has none → hidden.
    expect(container.textContent).toContain("mise");
    expect(container.textContent).not.toContain("env-direnv");
  });
});
