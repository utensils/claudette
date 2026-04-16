import { describe, expect, it, vi } from "vitest";

import type { PluginSettingsIntent } from "../../types/plugins";
import {
  NATIVE_HANDLERS,
  describeSlashQuery,
  parseSlashInput,
  resolveNativeHandler,
  type NativeCommandContext,
  type NativeCommandResult,
  type NativeHandler,
} from "./nativeSlashCommands";

function makeCtx(overrides: Partial<NativeCommandContext> = {}): NativeCommandContext {
  return {
    repoId: "repo-1",
    pluginManagementEnabled: true,
    openPluginSettings: vi.fn<(intent: Partial<PluginSettingsIntent>) => void>(),
    ...overrides,
  };
}

describe("parseSlashInput", () => {
  it("returns null for non-slash input", () => {
    expect(parseSlashInput("hello")).toBeNull();
    expect(parseSlashInput("")).toBeNull();
  });

  it("parses a bare token with no args", () => {
    expect(parseSlashInput("/plugin")).toEqual({ token: "plugin", args: "" });
  });

  it("splits token from the remaining args", () => {
    expect(parseSlashInput("/plugin install demo --scope user")).toEqual({
      token: "plugin",
      args: "install demo --scope user",
    });
  });

  it("preserves whitespace and quoted content in args", () => {
    expect(parseSlashInput('/foo "one two" three')).toEqual({
      token: "foo",
      args: '"one two" three',
    });
  });

  it("ignores leading whitespace before the slash", () => {
    expect(parseSlashInput("   /plugin install demo")).toEqual({
      token: "plugin",
      args: "install demo",
    });
  });
});

describe("resolveNativeHandler", () => {
  it("matches canonical names", () => {
    expect(resolveNativeHandler("plugin")?.name).toBe("plugin");
    expect(resolveNativeHandler("marketplace")?.name).toBe("marketplace");
  });

  it("matches aliases", () => {
    expect(resolveNativeHandler("plugins")?.name).toBe("plugin");
  });

  it("is case-insensitive", () => {
    expect(resolveNativeHandler("PLUGIN")?.name).toBe("plugin");
    expect(resolveNativeHandler("Plugins")?.name).toBe("plugin");
    expect(resolveNativeHandler("MarketPlace")?.name).toBe("marketplace");
  });

  it("returns null for unknown tokens", () => {
    expect(resolveNativeHandler("totally-unknown")).toBeNull();
    expect(resolveNativeHandler("")).toBeNull();
  });
});

describe("plugin native handler", () => {
  it("routes /plugin to the plugin settings intent with canonical 'plugin'", () => {
    const ctx = makeCtx();
    const handler = resolveNativeHandler("plugin")!;
    const result = handler.execute(ctx, "");
    expect(result).toEqual({ kind: "handled", canonicalName: "plugin" });
    expect(ctx.openPluginSettings).toHaveBeenCalledWith(
      expect.objectContaining({ tab: "available", action: null }),
    );
  });

  it("routes alias /plugins through the plugin handler", () => {
    const ctx = makeCtx();
    const handler = resolveNativeHandler("plugins")!;
    expect(handler.name).toBe("plugin");
    const result = handler.execute(ctx, "manage");
    expect(result).toEqual({ kind: "handled", canonicalName: "plugin" });
    expect(ctx.openPluginSettings).toHaveBeenCalledWith(
      expect.objectContaining({ tab: "installed" }),
    );
  });

  it("parses /plugin install <target> --scope project", () => {
    const ctx = makeCtx();
    const handler = resolveNativeHandler("plugin")!;
    handler.execute(ctx, "install demo@market --scope project");
    expect(ctx.openPluginSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "install",
        source: "demo@market",
        scope: "project",
        tab: "available",
      }),
    );
  });

  it("routes /marketplace add to canonical 'marketplace'", () => {
    const ctx = makeCtx();
    const handler = resolveNativeHandler("marketplace")!;
    const result = handler.execute(ctx, "add github:owner/repo --scope local");
    expect(result).toEqual({ kind: "handled", canonicalName: "marketplace" });
    expect(ctx.openPluginSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "marketplace-add",
        source: "github:owner/repo",
        scope: "local",
        tab: "marketplaces",
      }),
    );
  });

  it("swallows /plugin when plugin management is disabled without opening settings", () => {
    const ctx = makeCtx({ pluginManagementEnabled: false });
    const handler = resolveNativeHandler("plugin")!;
    const result = handler.execute(ctx, "install demo");
    expect(result).toEqual({ kind: "handled", canonicalName: "plugin" });
    expect(ctx.openPluginSettings).not.toHaveBeenCalled();
  });
});

describe("dispatcher across native kinds", () => {
  it("handles local_action results without producing a prompt", () => {
    const localAction: NativeHandler = {
      name: "clear-draft",
      aliases: [],
      kind: "local_action",
      execute: () => ({ kind: "handled", canonicalName: "clear-draft" }),
    };
    const resolved = resolveNativeHandler("clear-draft", [localAction]);
    expect(resolved).toBe(localAction);
    const result = resolved!.execute(makeCtx(), "");
    expect(result).toEqual({ kind: "handled", canonicalName: "clear-draft" });
  });

  it("handles prompt_expansion results by returning seeded prompt text", () => {
    const expander: NativeHandler = {
      name: "ask-clearly",
      aliases: ["ac"],
      kind: "prompt_expansion",
      execute: (_ctx, args): NativeCommandResult => ({
        kind: "expand",
        canonicalName: "ask-clearly",
        prompt: `Please answer clearly: ${args}`,
      }),
    };
    const resolved = resolveNativeHandler("ac", [expander]);
    expect(resolved).toBe(expander);
    const result = resolved!.execute(makeCtx(), "what is 2+2");
    expect(result).toEqual({
      kind: "expand",
      canonicalName: "ask-clearly",
      prompt: "Please answer clearly: what is 2+2",
    });
  });
});

describe("describeSlashQuery", () => {
  it("returns null for non-slash input", () => {
    expect(describeSlashQuery("hello")).toBeNull();
    expect(describeSlashQuery("")).toBeNull();
  });

  it("returns an empty token for a bare slash so the picker shows every command", () => {
    expect(describeSlashQuery("/")).toEqual({ token: "", hasArgs: false });
  });

  it("returns just the token when no whitespace follows", () => {
    expect(describeSlashQuery("/plug")).toEqual({ token: "plug", hasArgs: false });
    expect(describeSlashQuery("/plugin")).toEqual({ token: "plugin", hasArgs: false });
  });

  it("flags hasArgs once whitespace appears so the picker can preserve typed args", () => {
    expect(describeSlashQuery("/plugin ")).toEqual({
      token: "plugin",
      hasArgs: true,
    });
    expect(describeSlashQuery("/plugin install demo")).toEqual({
      token: "plugin",
      hasArgs: true,
    });
  });

  it("does not consume a leading slash inside a longer prefix", () => {
    expect(describeSlashQuery("  /plugin")).toBeNull();
    expect(describeSlashQuery("not/a/command")).toBeNull();
  });
});

describe("native handler table", () => {
  it("exposes plugin and marketplace canonical entries", () => {
    const names = NATIVE_HANDLERS.map((h) => h.name);
    expect(names).toContain("plugin");
    expect(names).toContain("marketplace");
  });
});
