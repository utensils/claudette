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
  listEnvProviderDisabled: vi.fn(),
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
import { useAppStore } from "../../../stores/useAppStore";

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
    envServices.listEnvProviderDisabled.mockResolvedValue([] as string[]);
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

describe("EnvPanel — toggle stays actionable mid-resolve", () => {
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
    envServices.listEnvProviderDisabled.mockResolvedValue([] as string[]);
    // Real Zustand store under test — reset to defaults so prior tests'
    // state can't leak in.
    useAppStore.setState({ workspaceEnvironment: {} });
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
    useAppStore.setState({ workspaceEnvironment: {} });
  });

  it("keeps the toggle clickable while the initial resolve is still in flight", async () => {
    // Before the squashed-commit change to lift `!resolvedOnce`, the
    // toggle was disabled until the first `get_env_sources` resolve
    // returned — which on cold direnv/Nix can take 60-120s. The user
    // can't cancel a slow provider that way. This test pins the new
    // behavior: the placeholder row from `listClaudettePlugins`
    // renders an actionable toggle, and clicking it fires the IPC
    // even though `getEnvSources` has not yet resolved.
    let resolveGetEnvSources: (value: EnvSourceInfo[]) => void;
    const getEnvSourcesPromise = new Promise<EnvSourceInfo[]>((resolve) => {
      resolveGetEnvSources = resolve;
    });
    claudettePluginServices.listClaudettePlugins.mockResolvedValue([
      envProvider({ name: "env-direnv", display_name: "direnv" }),
    ]);
    envServices.getEnvSources.mockReturnValue(getEnvSourcesPromise);

    const container = await renderEnvPanel();

    // Placeholder row should be visible; toggle should not be disabled.
    expect(container.textContent).toContain("direnv");
    const toggle = container.querySelector<HTMLButtonElement>(
      'button[role="switch"]',
    );
    expect(toggle).not.toBeNull();
    expect(toggle!.disabled).toBe(false);

    // Click while the resolve is still pending.
    await act(async () => {
      toggle!.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(envServices.setEnvProviderEnabled).toHaveBeenCalledWith(
      { kind: "repo", repo_id: "repo-1" },
      "env-direnv",
      false,
    );

    // Clean up the in-flight promise so the panel can unmount cleanly.
    resolveGetEnvSources!([
      envSource({
        plugin_name: "env-direnv",
        display_name: "direnv",
        enabled: false,
        detected: false,
        cached: false,
        error: "disabled",
      }),
    ]);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });

  it("clears the current_plugin spinner when the user disables the actively-resolving plugin", async () => {
    // Pins the optimistic-clear behavior: the EnvPanel surfaces an
    // inline "Resolving env-direnv… Ns elapsed" hint driven by the
    // workspaceEnvironment store. When the user disables the plugin
    // that's currently mid-flight, the hint must disappear
    // immediately rather than waiting on the backend's eventual
    // `Finished` event (which for `nix print-dev-env` can be a
    // minute away).
    claudettePluginServices.listClaudettePlugins.mockResolvedValue([
      envProvider({ name: "env-direnv", display_name: "direnv" }),
    ]);
    envServices.getEnvSources.mockResolvedValue([
      envSource({
        plugin_name: "env-direnv",
        display_name: "direnv",
        enabled: true,
      }),
    ]);
    // Seed the store as if `prepare_workspace_environment` is mid-resolve
    // on env-direnv. Key matches the EnvPanel's repo-target key
    // (`repo:{repo_id}`).
    useAppStore.setState({
      workspaceEnvironment: {
        "repo:repo-1": {
          status: "preparing",
          current_plugin: "env-direnv",
          started_at: Date.now() - 36_000,
        },
      },
    });

    const container = await renderEnvPanel();

    const toggle = container.querySelector<HTMLButtonElement>(
      'button[role="switch"]',
    );
    expect(toggle).not.toBeNull();
    await act(async () => {
      toggle!.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const env = useAppStore.getState().workspaceEnvironment["repo:repo-1"];
    expect(env?.current_plugin).toBeUndefined();
    // The aggregate `preparing` status is left in place — other
    // plugins downstream may still resolve, and the env-prep listener
    // owns the transition to "ready" / "error".
    expect(env?.status).toBe("preparing");
  });

  it("hydrates placeholder rows from listEnvProviderDisabled before the resolve returns", async () => {
    // Codex iter (post-squash) P2: with the toggle now actionable
    // mid-resolve, the placeholder rows from `listClaudettePlugins`
    // can't continue hard-coding `enabled: true` — a repo whose
    // env-direnv is already disabled but whose env-mise resolve is
    // slow would render env-direnv as enabled (incorrect) until the
    // slow resolve returned. Hydrate from `listEnvProviderDisabled`
    // (cheap DB read) so the placeholder reflects the persisted state.
    let resolveGetEnvSources: (value: EnvSourceInfo[]) => void;
    const getEnvSourcesPromise = new Promise<EnvSourceInfo[]>((resolve) => {
      resolveGetEnvSources = resolve;
    });
    claudettePluginServices.listClaudettePlugins.mockResolvedValue([
      envProvider({ name: "env-direnv", display_name: "direnv" }),
      envProvider({ name: "env-mise", display_name: "mise" }),
    ]);
    envServices.getEnvSources.mockReturnValue(getEnvSourcesPromise);
    envServices.listEnvProviderDisabled.mockResolvedValue(["env-direnv"]);

    const container = await renderEnvPanel();

    // Both rows visible, but the toggles reflect persisted state.
    const toggles = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[role="switch"]'),
    );
    expect(toggles).toHaveLength(2);
    // The row order tracks the listClaudettePlugins iteration; assert
    // by `aria-label` which embeds the display_name so the test
    // doesn't depend on render order.
    const direnvToggle = toggles.find((t) =>
      t.getAttribute("aria-label")?.includes("direnv"),
    );
    const miseToggle = toggles.find((t) =>
      t.getAttribute("aria-label")?.includes("mise"),
    );
    expect(direnvToggle!.getAttribute("aria-checked")).toBe("false");
    expect(miseToggle!.getAttribute("aria-checked")).toBe("true");

    // Clean up.
    resolveGetEnvSources!([]);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });

  it("rolls back the optimistic flip when setEnvProviderEnabled rejects", async () => {
    // Codex iter (post-squash) P3: a failed save must NOT leave the
    // panel showing the optimistic state — the user thinks they
    // disabled the provider, but the DB still has the old value, so
    // the next agent spawn picks up env from a provider the panel
    // claims is off. Capture the prior `enabled` flag and restore it
    // on rejection.
    claudettePluginServices.listClaudettePlugins.mockResolvedValue([
      envProvider({ name: "env-direnv", display_name: "direnv" }),
    ]);
    envServices.getEnvSources.mockResolvedValue([
      envSource({
        plugin_name: "env-direnv",
        display_name: "direnv",
        enabled: true,
      }),
    ]);
    envServices.setEnvProviderEnabled.mockRejectedValueOnce(
      new Error("simulated write failure"),
    );
    // Seed an in-flight resolve hint so we also exercise the
    // current_plugin restore branch.
    const startedAt = Date.now() - 5_000;
    useAppStore.setState({
      workspaceEnvironment: {
        "repo:repo-1": {
          status: "preparing",
          current_plugin: "env-direnv",
          started_at: startedAt,
        },
      },
    });

    const container = await renderEnvPanel();

    const toggle = container.querySelector<HTMLButtonElement>(
      'button[role="switch"]',
    );
    expect(toggle!.getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      toggle!.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Toggle reflects the pre-click state again — rollback succeeded.
    const after = container.querySelector<HTMLButtonElement>(
      'button[role="switch"]',
    );
    expect(after!.getAttribute("aria-checked")).toBe("true");
    // Spinner entry was restored to its prior shape.
    const env = useAppStore.getState().workspaceEnvironment["repo:repo-1"];
    expect(env?.status).toBe("preparing");
    expect(env?.current_plugin).toBe("env-direnv");
    expect(env?.started_at).toBe(startedAt);
  });

  it("does not touch unrelated workspaceEnvironment entries on disable", async () => {
    // The optimistic clear must be tightly scoped to the EnvPanel's
    // own target key. A user toggling a plugin off in repo-1's
    // settings while workspace-foo's resolve is in flight must NOT
    // wipe workspace-foo's progress entry.
    claudettePluginServices.listClaudettePlugins.mockResolvedValue([
      envProvider({ name: "env-direnv", display_name: "direnv" }),
    ]);
    envServices.getEnvSources.mockResolvedValue([
      envSource({
        plugin_name: "env-direnv",
        display_name: "direnv",
        enabled: true,
      }),
    ]);
    const otherStarted = Date.now() - 12_000;
    useAppStore.setState({
      workspaceEnvironment: {
        "workspace-foo": {
          status: "preparing",
          current_plugin: "env-direnv",
          started_at: otherStarted,
        },
      },
    });

    const container = await renderEnvPanel();

    const toggle = container.querySelector<HTMLButtonElement>(
      'button[role="switch"]',
    );
    await act(async () => {
      toggle!.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const other = useAppStore.getState().workspaceEnvironment["workspace-foo"];
    expect(other?.current_plugin).toBe("env-direnv");
    expect(other?.started_at).toBe(otherStarted);
  });
});
