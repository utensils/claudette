import { describe, expect, it } from "vitest";

import type { AvailablePlugin, InstalledPlugin, PluginMarketplace } from "../../../types/plugins";
import {
  availablePluginLinks,
  canInstallAvailablePluginAtScope,
  formatInstallCount,
  hasGlobalInstallation,
  marketplaceSourceLink,
  matchesAvailablePlugin,
  matchesInstalledPlugin,
  matchesMarketplace,
  primaryInstalledScope,
  sortAvailablePlugins,
  summarizeAvailablePlugins,
  summarizeInstalledPlugins,
} from "./pluginCatalog";

function makeInstalledPlugin(overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return {
    channels: [],
    command_count: 0,
    description: "Development workflow",
    enabled: true,
    install_path: "/tmp/demo",
    installed_at: null,
    last_updated: null,
    latest_known_version: "1.2.0",
    marketplace: "official",
    mcp_servers: [],
    name: "demo",
    plugin_id: "demo@official",
    scope: "user",
    skill_count: 0,
    update_available: false,
    user_config_schema: {},
    version: "1.0.0",
    ...overrides,
  };
}

function makeAvailablePlugin(overrides: Partial<AvailablePlugin> = {}): AvailablePlugin {
  return {
    category: "development",
    current_version: null,
    description: "Development workflow",
    enabled: false,
    enabled_scopes: [],
    homepage: "https://example.com/demo",
    install_count: 1200,
    installed: false,
    installed_scopes: [],
    marketplace: "official",
    name: "demo",
    plugin_id: "demo@official",
    source_label: "https://example.com/demo.git",
    update_available: false,
    version: "1.2.0",
    ...overrides,
  };
}

describe("plugin catalog helpers", () => {
  it("summarizes installed plugins with update and unknown-version counts", () => {
    const summary = summarizeInstalledPlugins([
      makeInstalledPlugin({ update_available: true }),
      makeInstalledPlugin({
        latest_known_version: null,
        plugin_id: "ops@official",
        version: "unknown",
      }),
    ]);

    expect(summary).toEqual({
      installationCount: 2,
      pluginCount: 2,
      unknownVersionCount: 1,
      updatesAvailable: 1,
    });
  });

  it("summarizes available plugins by discoverable vs installed", () => {
    const summary = summarizeAvailablePlugins([
      makeAvailablePlugin({ installed: true, update_available: true }),
      makeAvailablePlugin({ plugin_id: "fresh@official", name: "fresh" }),
    ]);

    expect(summary).toEqual({
      total: 2,
      installed: 1,
      discoverable: 1,
      updatesAvailable: 1,
    });
  });

  it("matches installed plugins by version, id, and description", () => {
    const plugin = makeInstalledPlugin();
    expect(matchesInstalledPlugin(plugin, "1.2.0")).toBe(true);
    expect(matchesInstalledPlugin(plugin, "workflow")).toBe(true);
    expect(matchesInstalledPlugin(plugin, "missing")).toBe(false);
  });

  it("matches available plugins by category and source metadata", () => {
    const plugin = makeAvailablePlugin();
    expect(matchesAvailablePlugin(plugin, "development")).toBe(true);
    expect(matchesAvailablePlugin(plugin, "demo.git")).toBe(true);
    expect(matchesAvailablePlugin(plugin, "missing")).toBe(false);
  });

  it("sorts updates first, then discoverable, then installed", () => {
    const sorted = sortAvailablePlugins([
      makeAvailablePlugin({
        installed: true,
        install_count: 5000,
        plugin_id: "installed@official",
        name: "installed",
      }),
      makeAvailablePlugin({
        install_count: 100,
        plugin_id: "discover@official",
        name: "discover",
      }),
      makeAvailablePlugin({
        installed: true,
        update_available: true,
        install_count: 10,
        plugin_id: "update@official",
        name: "update",
      }),
    ]);

    expect(sorted.map((plugin) => plugin.plugin_id)).toEqual([
      "update@official",
      "discover@official",
      "installed@official",
    ]);
  });

  it("matches marketplaces by source and name", () => {
    const marketplace: PluginMarketplace = {
      install_location: "/tmp/official",
      name: "official",
      scope: "user",
      source_kind: "git",
      source_label: "github:anthropic/plugins",
    };

    expect(matchesMarketplace(marketplace, "anthropic")).toBe(true);
    expect(matchesMarketplace(marketplace, "official")).toBe(true);
    expect(matchesMarketplace(marketplace, "missing")).toBe(false);
  });

  it("formats install counts compactly", () => {
    expect(formatInstallCount(null)).toBeNull();
    expect(formatInstallCount(999)).toBe("999 installs");
    expect(formatInstallCount(1200)).toBe("1.2k installs");
    expect(formatInstallCount(15200)).toBe("15k installs");
  });

  it("builds homepage and source links from explicit URLs", () => {
    const plugin = makeAvailablePlugin({
      homepage: "https://www.example.com/demo",
      source_label: "https://github.com/example/demo.git",
    });

    expect(availablePluginLinks(plugin)).toEqual([
      {
        detail: "example.com/demo",
        label: "Homepage",
        meta: null,
        url: "https://www.example.com/demo",
      },
      {
        detail: "example/demo",
        label: "Source",
        meta: null,
        url: "https://github.com/example/demo.git",
      },
    ]);
  });

  it("normalizes GitHub shorthand sources and preserves path metadata", () => {
    const plugin = makeAvailablePlugin({
      homepage: null,
      source_label: "techwolf-ai/ai-first-toolkit (plugins/ai-firstify)",
    });

    expect(availablePluginLinks(plugin)).toEqual([
      {
        detail: "techwolf-ai/ai-first-toolkit",
        label: "Source",
        meta: "plugins/ai-firstify",
        url: "https://github.com/techwolf-ai/ai-first-toolkit",
      },
    ]);
  });

  it("deduplicates homepage and source when they point at the same URL", () => {
    const plugin = makeAvailablePlugin({
      homepage: "https://github.com/example/demo",
      source_label: "github:example/demo",
    });

    expect(availablePluginLinks(plugin)).toEqual([
      {
        detail: "example/demo",
        label: "Homepage",
        meta: null,
        url: "https://github.com/example/demo",
      },
    ]);
  });

  it("deduplicates homepage and source when one uses a .git URL", () => {
    const plugin = makeAvailablePlugin({
      homepage: "https://github.com/SalesforceAIResearch/agentforce-adlc",
      source_label: "https://github.com/SalesforceAIResearch/agentforce-adlc.git",
    });

    expect(availablePluginLinks(plugin)).toEqual([
      {
        detail: "SalesforceAIResearch/agentforce-adlc",
        label: "Homepage",
        meta: null,
        url: "https://github.com/SalesforceAIResearch/agentforce-adlc",
      },
    ]);
  });

  it("builds marketplace source links from GitHub shorthand", () => {
    const marketplace: PluginMarketplace = {
      install_location: "/tmp/marketplace",
      name: "official",
      scope: "user",
      source_kind: "git",
      source_label: "github:anthropic/claude-plugins-public",
    };

    expect(marketplaceSourceLink(marketplace)).toEqual({
      detail: "anthropic/claude-plugins-public",
      label: "Source",
      meta: null,
      url: "https://github.com/anthropic/claude-plugins-public",
    });
  });

  it("skips marketplace source links for local paths", () => {
    const marketplace: PluginMarketplace = {
      install_location: "/tmp/marketplace",
      name: "local",
      scope: "project",
      source_kind: "directory",
      source_label: "/Users/demo/marketplace",
    };

    expect(marketplaceSourceLink(marketplace)).toBeNull();
  });

  it("treats user and managed installs as globally available", () => {
    expect(hasGlobalInstallation(["user"])).toBe(true);
    expect(hasGlobalInstallation(["managed"])).toBe(true);
    expect(hasGlobalInstallation(["project"])).toBe(false);
    expect(hasGlobalInstallation(["local"])).toBe(false);
  });

  it("picks the broadest installed scope as the primary one", () => {
    expect(primaryInstalledScope(["local", "project"])).toBe("project");
    expect(primaryInstalledScope(["project", "user"])).toBe("user");
    expect(primaryInstalledScope([])).toBeNull();
  });

  it("blocks redundant scope installs once a plugin is global", () => {
    const globalPlugin = makeAvailablePlugin({
      installed: true,
      installed_scopes: ["user"],
    });
    const projectPlugin = makeAvailablePlugin({
      installed: true,
      installed_scopes: ["project"],
    });

    expect(canInstallAvailablePluginAtScope(globalPlugin, "project")).toBe(false);
    expect(canInstallAvailablePluginAtScope(globalPlugin, "local")).toBe(false);
    expect(canInstallAvailablePluginAtScope(projectPlugin, "user")).toBe(true);
    expect(canInstallAvailablePluginAtScope(projectPlugin, "project")).toBe(false);
  });
});
