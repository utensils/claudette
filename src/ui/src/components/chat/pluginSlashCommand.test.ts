import { describe, expect, it } from "vitest";

import { isPluginSlashCommandInput, parsePluginSlashCommand } from "./pluginSlashCommand";

describe("parsePluginSlashCommand", () => {
  it("routes bare plugin command to the available plugin browser", () => {
    expect(parsePluginSlashCommand("/plugin", "repo-1")).toEqual({
      usageCommandName: "plugin",
      intent: {
        action: null,
        repoId: "repo-1",
        scope: "user",
        source: null,
        tab: "available",
        target: null,
      },
    });
  });

  it("captures install target and scope", () => {
    expect(parsePluginSlashCommand("/plugin install demo@market --scope project", "repo-1")).toEqual({
      usageCommandName: "plugin",
      intent: {
        action: "install",
        repoId: "repo-1",
        scope: "project",
        source: "demo@market",
        tab: "available",
        target: null,
      },
    });
  });

  it("supports explicit browse aliases", () => {
    expect(parsePluginSlashCommand("/plugin discover telemetry --scope local", "repo-1")).toEqual({
      usageCommandName: "plugin",
      intent: {
        action: null,
        repoId: "repo-1",
        scope: "local",
        source: null,
        tab: "available",
        target: "telemetry",
      },
    });
  });

  it("supports marketplace alias commands", () => {
    expect(parsePluginSlashCommand("/marketplace add github:owner/repo --scope local", "repo-1")).toEqual({
      usageCommandName: "marketplace",
      intent: {
        action: "marketplace-add",
        repoId: "repo-1",
        scope: "local",
        source: "github:owner/repo",
        tab: "marketplaces",
        target: null,
      },
    });
  });

  it("maps plugin marketplace remove to marketplace settings", () => {
    expect(parsePluginSlashCommand("/plugin marketplace remove official", "repo-1")).toEqual({
      usageCommandName: "plugin",
      intent: {
        action: "marketplace-remove",
        repoId: "repo-1",
        scope: "user",
        source: null,
        tab: "marketplaces",
        target: "official",
      },
    });
  });

  it("returns null when plugin management is disabled", () => {
    expect(parsePluginSlashCommand("/plugin", "repo-1", false)).toBeNull();
    expect(parsePluginSlashCommand("/plugins install demo", "repo-1", false)).toBeNull();
    expect(parsePluginSlashCommand("/marketplace add github:owner/repo", "repo-1", false)).toBeNull();
  });

  it("detects plugin-related slash inputs for disabled-mode suppression", () => {
    expect(isPluginSlashCommandInput("/plugin")).toBe(true);
    expect(isPluginSlashCommandInput("/plugins install demo")).toBe(true);
    expect(isPluginSlashCommandInput("/marketplace add official")).toBe(true);
    expect(isPluginSlashCommandInput("/help")).toBe(false);
  });
});
