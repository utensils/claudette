import { describe, expect, it, vi } from "vitest";

import type { PluginSettingsIntent } from "../../types/plugins";
import {
  CONFIG_SECTIONS,
  NATIVE_HANDLERS,
  describeSlashQuery,
  formatVersionMessage,
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
    usageInsightsEnabled: true,
    openPluginSettings: vi.fn<(intent: Partial<PluginSettingsIntent>) => void>(),
    repository: { name: "claudette", path: "/tmp/repos/claudette" },
    workspace: { branch: "feat/review-cmds", worktreePath: "/tmp/wt/review-cmds" },
    repoDefaultBranch: "origin/main",
    openSettings: vi.fn<(section?: string) => void>(),
    appVersion: "1.2.3",
    addLocalMessage: vi.fn<(text: string) => void>(),
    openUsageSettingsExternal: vi.fn<() => void>(),
    openReleaseNotes: vi.fn<() => void>(),
    workspaceId: "ws-1",
    agentStatus: "Idle",
    selectedModel: "opus",
    permissionLevel: "full",
    planMode: false,
    fastMode: false,
    thinkingEnabled: false,
    chromeEnabled: false,
    effortLevel: "auto",
    planFilePath: null,
    setSelectedModel: vi.fn(async () => {}),
    setPermissionLevel: vi.fn(async () => {}),
    setPlanMode: vi.fn(),
    clearConversation: vi.fn(async () => {}),
    readPlanFile: vi.fn(async () => "plan content"),
    ...overrides,
  };
}

describe("parseSlashInput", () => {
  it("returns null for non-slash input", async () => {
    expect(parseSlashInput("hello")).toBeNull();
    expect(parseSlashInput("")).toBeNull();
  });

  it("parses a bare token with no args", async () => {
    expect(parseSlashInput("/plugin")).toEqual({ token: "plugin", args: "" });
  });

  it("splits token from the remaining args", async () => {
    expect(parseSlashInput("/plugin install demo --scope user")).toEqual({
      token: "plugin",
      args: "install demo --scope user",
    });
  });

  it("preserves whitespace and quoted content in args", async () => {
    expect(parseSlashInput('/foo "one two" three')).toEqual({
      token: "foo",
      args: '"one two" three',
    });
  });

  it("ignores leading whitespace before the slash", async () => {
    expect(parseSlashInput("   /plugin install demo")).toEqual({
      token: "plugin",
      args: "install demo",
    });
  });
});

describe("resolveNativeHandler", () => {
  it("matches canonical names", async () => {
    expect(resolveNativeHandler("plugin")?.name).toBe("plugin");
    expect(resolveNativeHandler("marketplace")?.name).toBe("marketplace");
  });

  it("matches aliases", async () => {
    expect(resolveNativeHandler("plugins")?.name).toBe("plugin");
  });

  it("is case-insensitive", async () => {
    expect(resolveNativeHandler("PLUGIN")?.name).toBe("plugin");
    expect(resolveNativeHandler("Plugins")?.name).toBe("plugin");
    expect(resolveNativeHandler("MarketPlace")?.name).toBe("marketplace");
  });

  it("returns null for unknown tokens", async () => {
    expect(resolveNativeHandler("totally-unknown")).toBeNull();
    expect(resolveNativeHandler("")).toBeNull();
  });
});

describe("plugin native handler", () => {
  it("routes /plugin to the plugin settings intent with canonical 'plugin'", async () => {
    const ctx = makeCtx();
    const handler = resolveNativeHandler("plugin")!;
    const result = await handler.execute(ctx, "");
    expect(result).toEqual({ kind: "handled", canonicalName: "plugin" });
    expect(ctx.openPluginSettings).toHaveBeenCalledWith(
      expect.objectContaining({ tab: "available", action: null }),
    );
  });

  it("routes alias /plugins through the plugin handler", async () => {
    const ctx = makeCtx();
    const handler = resolveNativeHandler("plugins")!;
    expect(handler.name).toBe("plugin");
    const result = await handler.execute(ctx, "manage");
    expect(result).toEqual({ kind: "handled", canonicalName: "plugin" });
    expect(ctx.openPluginSettings).toHaveBeenCalledWith(
      expect.objectContaining({ tab: "installed" }),
    );
  });

  it("parses /plugin install <target> --scope project", async () => {
    const ctx = makeCtx();
    const handler = resolveNativeHandler("plugin")!;
    await handler.execute(ctx, "install demo@market --scope project");
    expect(ctx.openPluginSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "install",
        source: "demo@market",
        scope: "project",
        tab: "available",
      }),
    );
  });

  it("routes /marketplace add to canonical 'marketplace'", async () => {
    const ctx = makeCtx();
    const handler = resolveNativeHandler("marketplace")!;
    const result = await handler.execute(ctx, "add github:owner/repo --scope local");
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

  it("swallows /plugin when plugin management is disabled without opening settings", async () => {
    const ctx = makeCtx({ pluginManagementEnabled: false });
    const handler = resolveNativeHandler("plugin")!;
    const result = await handler.execute(ctx, "install demo");
    expect(result).toEqual({ kind: "handled", canonicalName: "plugin" });
    expect(ctx.openPluginSettings).not.toHaveBeenCalled();
  });
});

describe("dispatcher across native kinds", () => {
  it("handles local_action results without producing a prompt", async () => {
    const localAction: NativeHandler = {
      name: "clear-draft",
      aliases: [],
      kind: "local_action",
      execute: () => ({ kind: "handled", canonicalName: "clear-draft" }),
    };
    const resolved = resolveNativeHandler("clear-draft", [localAction]);
    expect(resolved).toBe(localAction);
    const result = await resolved!.execute(makeCtx(), "");
    expect(result).toEqual({ kind: "handled", canonicalName: "clear-draft" });
  });

  it("handles prompt_expansion results by returning seeded prompt text", async () => {
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
    const result = await resolved!.execute(makeCtx(), "what is 2+2");
    expect(result).toEqual({
      kind: "expand",
      canonicalName: "ask-clearly",
      prompt: "Please answer clearly: what is 2+2",
    });
  });
});

describe("describeSlashQuery", () => {
  it("returns null for non-slash input", async () => {
    expect(describeSlashQuery("hello")).toBeNull();
    expect(describeSlashQuery("")).toBeNull();
  });

  it("returns an empty token for a bare slash so the picker shows every command", async () => {
    expect(describeSlashQuery("/")).toEqual({ token: "", hasArgs: false });
  });

  it("returns just the token when no whitespace follows", async () => {
    expect(describeSlashQuery("/plug")).toEqual({ token: "plug", hasArgs: false });
    expect(describeSlashQuery("/plugin")).toEqual({ token: "plugin", hasArgs: false });
  });

  it("flags hasArgs once whitespace appears so the picker can preserve typed args", async () => {
    expect(describeSlashQuery("/plugin ")).toEqual({
      token: "plugin",
      hasArgs: true,
    });
    expect(describeSlashQuery("/plugin install demo")).toEqual({
      token: "plugin",
      hasArgs: true,
    });
  });

  it("does not consume a leading slash inside a longer prefix", async () => {
    expect(describeSlashQuery("  /plugin")).toBeNull();
    expect(describeSlashQuery("not/a/command")).toBeNull();
  });
});

describe("native handler table", () => {
  it("exposes plugin and marketplace canonical entries", async () => {
    const names = NATIVE_HANDLERS.map((h) => h.name);
    expect(names).toContain("plugin");
    expect(names).toContain("marketplace");
  });

  it("exposes review, security-review, and pr-comments as prompt_expansion handlers", async () => {
    for (const name of ["review", "security-review", "pr-comments"] as const) {
      const handler = NATIVE_HANDLERS.find((h) => h.name === name);
      expect(handler, `missing NATIVE_HANDLERS entry for ${name}`).toBeDefined();
      expect(handler!.kind).toBe("prompt_expansion");
      expect(handler!.aliases).toEqual([]);
    }
  });

  it("exposes config, usage, extra-usage, release-notes, and version entries", async () => {
    const names = NATIVE_HANDLERS.map((h) => h.name);
    expect(names).toContain("config");
    expect(names).toContain("usage");
    expect(names).toContain("extra-usage");
    expect(names).toContain("release-notes");
    expect(names).toContain("version");
  });

  it("declares the expected kinds for the settings/version handlers", async () => {
    const byName = new Map(NATIVE_HANDLERS.map((h) => [h.name, h]));
    expect(byName.get("config")?.kind).toBe("settings_route");
    expect(byName.get("usage")?.kind).toBe("settings_route");
    expect(byName.get("extra-usage")?.kind).toBe("settings_route");
    expect(byName.get("release-notes")?.kind).toBe("local_action");
    expect(byName.get("version")?.kind).toBe("local_action");
  });
});

describe("review workflow native handlers", () => {
  const REVIEW_NAMES = ["review", "security-review", "pr-comments"] as const;

  for (const name of REVIEW_NAMES) {
    describe(`/${name}`, () => {
      it("resolves by canonical name (case-insensitive)", async () => {
        expect(resolveNativeHandler(name)?.name).toBe(name);
        expect(resolveNativeHandler(name.toUpperCase())?.name).toBe(name);
      });

      it("expands with empty args into a seeded prompt grounded in workspace context", async () => {
        const ctx = makeCtx();
        const handler = resolveNativeHandler(name)!;
        const result = await handler.execute(ctx, "");
        expect(result.kind).toBe("expand");
        if (result.kind !== "expand") throw new Error("expected expand");
        expect(result.canonicalName).toBe(name);
        expect(result.prompt).toContain("claudette");
        expect(result.prompt).toContain("/tmp/repos/claudette");
        expect(result.prompt).toContain("/tmp/wt/review-cmds");
        expect(result.prompt).toContain("feat/review-cmds");
        expect(result.prompt).toContain("origin/main");
        // Must label the repo default as a hint, not as the guaranteed review base.
        expect(result.prompt).toContain("Repo default branch");
        expect(result.prompt).toContain("hint only");
        expect(result.prompt).not.toContain("Additional guidance from user");
        expect(result.prompt).not.toContain("undefined");
        expect(result.prompt).not.toContain("null");
      });

      it("expands with whitespace-only args the same as empty args", async () => {
        const ctx = makeCtx();
        const handler = resolveNativeHandler(name)!;
        const result = await handler.execute(ctx, "   \t\n  ");
        if (result.kind !== "expand") throw new Error("expected expand");
        expect(result.prompt).not.toContain("Additional guidance from user");
      });

      it("preserves user-supplied arguments verbatim in a guidance line", async () => {
        const ctx = makeCtx();
        const handler = resolveNativeHandler(name)!;
        const args = 'focus on "diff.rs" and the PTY bridge';
        const result = await handler.execute(ctx, args);
        if (result.kind !== "expand") throw new Error("expected expand");
        expect(result.prompt).toContain(`Additional guidance from user: ${args}`);
      });

      it("omits missing workspace/repo/repoDefaultBranch fields without leaking placeholders", async () => {
        const ctx = makeCtx({
          repository: null,
          workspace: null,
          repoDefaultBranch: null,
        });
        const handler = resolveNativeHandler(name)!;
        const result = await handler.execute(ctx, "");
        if (result.kind !== "expand") throw new Error("expected expand");
        expect(result.prompt).not.toContain("undefined");
        expect(result.prompt).not.toContain("null");
        expect(result.prompt).not.toMatch(/Repository:\s*$/m);
        expect(result.prompt).not.toMatch(/Repo default branch[^:]*:\s*$/m);
        expect(result.prompt).not.toMatch(/Current branch:\s*$/m);
        expect(result.prompt).not.toMatch(/Worktree:\s*$/m);
      });

      it("omits individual missing fields but keeps populated ones", async () => {
        const ctx = makeCtx({
          repository: { name: "claudette", path: "/tmp/repos/claudette" },
          workspace: { branch: "feat/x", worktreePath: null },
          repoDefaultBranch: null,
        });
        const handler = resolveNativeHandler(name)!;
        const result = await handler.execute(ctx, "");
        if (result.kind !== "expand") throw new Error("expected expand");
        expect(result.prompt).toContain("claudette");
        expect(result.prompt).toContain("feat/x");
        expect(result.prompt).not.toContain("Worktree:");
        expect(result.prompt).not.toContain("Repo default branch");
      });

      it("returns an expand result (not handled) so ChatPanel forwards the prompt to sendChatMessage", async () => {
        // The ChatPanel send path only falls through to sendChatMessage when
        // the native dispatcher returns `kind: "expand"`. A "handled" result
        // would short-circuit and swallow the command. These handlers must
        // therefore always return "expand" — they seed the prompt and let the
        // normal agent pipeline run it.
        const ctx = makeCtx();
        const handler = resolveNativeHandler(name)!;
        const empty = await handler.execute(ctx, "");
        const withArgs = await handler.execute(ctx, "hello");
        expect(empty.kind).toBe("expand");
        expect(withArgs.kind).toBe("expand");
      });

      it("does not pass the raw slash input through verbatim — the expansion differs from `/<name> …`", async () => {
        const ctx = makeCtx();
        const handler = resolveNativeHandler(name)!;
        const rawInput = `/${name} focus on perf`;
        const result = await handler.execute(ctx, "focus on perf");
        if (result.kind !== "expand") throw new Error("expected expand");
        expect(result.prompt).not.toBe(rawInput);
        expect(result.prompt.length).toBeGreaterThan(rawInput.length);
      });
    });
  }

  describe("review base resolution (P1/P2 fixes)", () => {
    it("/review instructs the agent to resolve the review base via gh/git, not to trust the repo default as the base", async () => {
      const handler = resolveNativeHandler("review")!;
      const result = await handler.execute(makeCtx(), "");
      if (result.kind !== "expand") throw new Error("expected expand");
      expect(result.prompt).toMatch(/Resolve the review base ref/);
      expect(result.prompt).toContain("gh pr view");
      expect(result.prompt).toContain("@{upstream}");
      // The repo default is surfaced only as a labeled hint/fallback.
      expect(result.prompt).toMatch(/hint only.*not guaranteed to be this branch's review base/);
    });

    it("/security-review uses the same resolve-base guidance", async () => {
      const handler = resolveNativeHandler("security-review")!;
      const result = await handler.execute(makeCtx(), "");
      if (result.kind !== "expand") throw new Error("expected expand");
      expect(result.prompt).toMatch(/Resolve the review base ref/);
      expect(result.prompt).toContain("gh pr view");
    });

    it("does not hardcode the `origin/` remote prefix in the base-resolution block", async () => {
      // Non-`origin` remotes (e.g. `upstream` in fork workflows) exist — the
      // Rust backend already handles this in `src/git.rs`. The prompt must not
      // instruct the agent to assume `origin/`.
      const prompt = await resolveNativeHandler("review")!.execute(makeCtx(), "");
      if (prompt.kind !== "expand") throw new Error("expected expand");
      expect(prompt.prompt).toMatch(/git remote/);
      expect(prompt.prompt).not.toMatch(/prefixed with ['"`]origin\//);
    });

    it("warns against treating `@{upstream}` as the review base when it just names the branch's own tracking ref", async () => {
      // The most common case of `@{upstream}` is the feature branch's remote
      // copy — diffing HEAD against that yields an empty diff. The prompt
      // must spell this out rather than treating upstream as authoritative.
      const prompt = await resolveNativeHandler("review")!.execute(makeCtx(), "");
      if (prompt.kind !== "expand") throw new Error("expected expand");
      expect(prompt.prompt).toMatch(/only use this when the upstream clearly names the review target/i);
    });

    it("prompt still instructs base-resolution when repoDefaultBranch is missing (remote-workspace case)", async () => {
      // On paired remote workspaces today, defaultBranch may not be in the
      // store. The prompt must still tell the agent to determine a base ref
      // itself rather than diffing against an unnamed / empty ref.
      const ctx = makeCtx({ repoDefaultBranch: null });
      for (const name of ["review", "security-review"] as const) {
        const result = await resolveNativeHandler(name)!.execute(ctx, "");
        if (result.kind !== "expand") throw new Error("expected expand");
        expect(result.prompt).toMatch(/Resolve the review base ref/);
        expect(result.prompt).toContain("gh pr view");
        expect(result.prompt).toContain("@{upstream}");
        // And must include an explicit instruction to ask the user if no base
        // can be resolved, so the agent never runs `git diff ...HEAD` with an
        // empty base.
        expect(result.prompt).toMatch(/stop and ask the user/);
      }
    });
  });

  it("each command produces a distinct seeded prompt", async () => {
    const ctx = makeCtx();
    const prompts = await Promise.all(
      REVIEW_NAMES.map(async (n) => {
        const r = await resolveNativeHandler(n)!.execute(ctx, "");
        if (r.kind !== "expand") throw new Error("expected expand");
        return r.prompt;
      }),
    );
    const unique = new Set(prompts);
    expect(unique.size).toBe(REVIEW_NAMES.length);
  });
});

describe("config native handler", () => {
  it("opens settings with the default general section when no args given", async () => {
    const ctx = makeCtx();
    const handler = resolveNativeHandler("config")!;
    const result = await handler.execute(ctx, "");
    expect(result).toEqual({ kind: "handled", canonicalName: "config" });
    expect(ctx.openSettings).toHaveBeenCalledTimes(1);
    expect(ctx.openSettings).toHaveBeenCalledWith("general");
  });

  it("resolves the /configure alias to the config handler", async () => {
    expect(resolveNativeHandler("configure")?.name).toBe("config");
    expect(resolveNativeHandler("CONFIGURE")?.name).toBe("config");
  });

  it("routes each valid section to openSettings with that section", async () => {
    const handler = resolveNativeHandler("config")!;
    for (const section of CONFIG_SECTIONS) {
      const ctx = makeCtx();
      const result = await handler.execute(ctx, section);
      expect(result).toEqual({ kind: "handled", canonicalName: "config" });
      expect(ctx.openSettings).toHaveBeenCalledTimes(1);
      expect(ctx.openSettings).toHaveBeenCalledWith(section);
    }
  });

  it("redirects /config usage to experimental when Usage Insights is disabled", async () => {
    const ctx = makeCtx({ usageInsightsEnabled: false });
    const handler = resolveNativeHandler("config")!;
    await handler.execute(ctx, "usage");
    expect(ctx.openSettings).toHaveBeenCalledWith("experimental");
  });

  it("is case-insensitive for section names", async () => {
    const ctx = makeCtx();
    const handler = resolveNativeHandler("config")!;
    await handler.execute(ctx, "APPEARANCE");
    expect(ctx.openSettings).toHaveBeenCalledWith("appearance");
  });

  it("ignores extra arguments after the section token", async () => {
    const ctx = makeCtx();
    const handler = resolveNativeHandler("config")!;
    await handler.execute(ctx, "models foo bar");
    expect(ctx.openSettings).toHaveBeenCalledWith("models");
  });

  it("falls back to general for an unknown section", async () => {
    const ctx = makeCtx();
    const handler = resolveNativeHandler("config")!;
    const result = await handler.execute(ctx, "bogus-section");
    expect(result).toEqual({ kind: "handled", canonicalName: "config" });
    expect(ctx.openSettings).toHaveBeenCalledWith("general");
  });
});

describe("usage native handler", () => {
  it("resolves /usage and opens the usage settings section when the gate is on", async () => {
    const ctx = makeCtx();
    const handler = resolveNativeHandler("usage")!;
    const result = await handler.execute(ctx, "");
    expect(result).toEqual({ kind: "handled", canonicalName: "usage" });
    expect(ctx.openSettings).toHaveBeenCalledWith("usage");
    expect(ctx.openUsageSettingsExternal).not.toHaveBeenCalled();
  });

  it("routes /usage to Experimental when Usage Insights is disabled", async () => {
    const ctx = makeCtx({ usageInsightsEnabled: false });
    const handler = resolveNativeHandler("usage")!;
    await handler.execute(ctx, "");
    expect(ctx.openSettings).toHaveBeenCalledWith("experimental");
  });
});

describe("extra-usage native handler", () => {
  it("reuses both the in-app and external usage paths when the gate is on", async () => {
    const ctx = makeCtx();
    const handler = resolveNativeHandler("extra-usage")!;
    const result = await handler.execute(ctx, "");
    expect(result).toEqual({ kind: "handled", canonicalName: "extra-usage" });
    expect(ctx.openSettings).toHaveBeenCalledWith("usage");
    expect(ctx.openUsageSettingsExternal).toHaveBeenCalledTimes(1);
  });

  it("routes /extra-usage to Experimental and does NOT launch claude.ai when gated off", async () => {
    const ctx = makeCtx({ usageInsightsEnabled: false });
    const handler = resolveNativeHandler("extra-usage")!;
    await handler.execute(ctx, "");
    expect(ctx.openSettings).toHaveBeenCalledWith("experimental");
    expect(ctx.openUsageSettingsExternal).not.toHaveBeenCalled();
  });
});

describe("release-notes native handler", () => {
  it("resolves /release-notes and routes through openReleaseNotes", async () => {
    const ctx = makeCtx();
    const handler = resolveNativeHandler("release-notes")!;
    const result = await handler.execute(ctx, "");
    expect(result).toEqual({
      kind: "handled",
      canonicalName: "release-notes",
    });
    expect(ctx.openReleaseNotes).toHaveBeenCalledTimes(1);
  });

  it("resolves the /changelog alias to the release-notes handler", async () => {
    expect(resolveNativeHandler("changelog")?.name).toBe("release-notes");
  });
});

describe("version native handler", () => {
  it("formats the version string with a v-prefix", async () => {
    expect(formatVersionMessage("1.2.3")).toBe("Claudette v1.2.3");
  });

  it("falls back to 'unknown' when no version is available", async () => {
    expect(formatVersionMessage(null)).toBe("Claudette vunknown");
  });

  it("posts a local message containing the provided app version", async () => {
    const ctx = makeCtx({ appVersion: "9.9.9" });
    const handler = resolveNativeHandler("version")!;
    const result = await handler.execute(ctx, "");
    expect(result).toEqual({ kind: "handled", canonicalName: "version" });
    expect(ctx.addLocalMessage).toHaveBeenCalledTimes(1);
    expect(ctx.addLocalMessage).toHaveBeenCalledWith("Claudette v9.9.9");
  });

  it("posts a local 'unknown' fallback when appVersion is null", async () => {
    const ctx = makeCtx({ appVersion: null });
    const handler = resolveNativeHandler("version")!;
    await handler.execute(ctx, "");
    expect(ctx.addLocalMessage).toHaveBeenCalledWith("Claudette vunknown");
  });

  it("resolves the /about alias to the version handler", async () => {
    expect(resolveNativeHandler("about")?.name).toBe("version");
  });
});

describe("/clear handler", () => {
  it("clears conversation when called with no args", async () => {
    const ctx = makeCtx();
    const handler = resolveNativeHandler("clear")!;
    const result = await handler.execute(ctx, "");
    expect(result).toEqual({ kind: "handled", canonicalName: "clear" });
    expect(ctx.clearConversation).toHaveBeenCalledWith(false);
    expect(ctx.addLocalMessage).toHaveBeenCalledWith("Conversation cleared.");
  });

  it("never passes restoreFiles=true — file restore belongs to the rollback modal, not to /clear", async () => {
    const ctx = makeCtx();
    const handler = resolveNativeHandler("clear")!;
    await handler.execute(ctx, "");
    expect(ctx.clearConversation).toHaveBeenCalledWith(false);
  });

  it("rejects any argument without calling clearConversation", async () => {
    const ctx = makeCtx();
    const handler = resolveNativeHandler("clear")!;
    await handler.execute(ctx, "files");
    expect(ctx.clearConversation).not.toHaveBeenCalled();
    expect(ctx.addLocalMessage).toHaveBeenCalledWith(
      expect.stringContaining("does not accept arguments"),
    );
  });

  it("surfaces errors from the clearConversation call as a local message", async () => {
    const ctx = makeCtx({
      clearConversation: vi.fn(async () => {
        throw new Error("agent running");
      }),
    });
    const handler = resolveNativeHandler("clear")!;
    await handler.execute(ctx, "");
    expect(ctx.addLocalMessage).toHaveBeenCalledWith(
      expect.stringContaining("agent running"),
    );
  });

  it("bails out gracefully if no workspace is selected", async () => {
    const ctx = makeCtx({ workspaceId: null });
    const handler = resolveNativeHandler("clear")!;
    await handler.execute(ctx, "");
    expect(ctx.clearConversation).not.toHaveBeenCalled();
    expect(ctx.addLocalMessage).toHaveBeenCalledWith(
      expect.stringContaining("no active workspace"),
    );
  });
});

describe("/plan handler", () => {
  it("toggles plan mode off when invoked with no args and plan mode is currently on", async () => {
    const ctx = makeCtx({ planMode: true });
    const handler = resolveNativeHandler("plan")!;
    await handler.execute(ctx, "");
    expect(ctx.setPlanMode).toHaveBeenCalledWith(false);
    expect(ctx.addLocalMessage).toHaveBeenCalledWith("Plan mode off.");
  });

  it("toggles plan mode on when invoked with no args and plan mode is currently off", async () => {
    const ctx = makeCtx({ planMode: false });
    const handler = resolveNativeHandler("plan")!;
    await handler.execute(ctx, "");
    expect(ctx.setPlanMode).toHaveBeenCalledWith(true);
    expect(ctx.addLocalMessage).toHaveBeenCalledWith("Plan mode on.");
  });

  it("enables plan mode via /plan on", async () => {
    const ctx = makeCtx({ planMode: false });
    const handler = resolveNativeHandler("plan")!;
    await handler.execute(ctx, "on");
    expect(ctx.setPlanMode).toHaveBeenCalledWith(true);
    expect(ctx.addLocalMessage).toHaveBeenCalledWith("Plan mode enabled.");
  });

  it("disables plan mode via /plan off", async () => {
    const ctx = makeCtx({ planMode: true });
    const handler = resolveNativeHandler("plan")!;
    await handler.execute(ctx, "off");
    expect(ctx.setPlanMode).toHaveBeenCalledWith(false);
    expect(ctx.addLocalMessage).toHaveBeenCalledWith("Plan mode disabled.");
  });

  it("toggles plan mode via /plan toggle", async () => {
    const ctx = makeCtx({ planMode: false });
    const handler = resolveNativeHandler("plan")!;
    await handler.execute(ctx, "toggle");
    expect(ctx.setPlanMode).toHaveBeenCalledWith(true);
    expect(ctx.addLocalMessage).toHaveBeenCalledWith("Plan mode on.");
  });

  it("opens the plan file resolved by ChatPanel regardless of pending-approval state", async () => {
    // The handler treats planFilePath as opaque — it reads whatever ChatPanel
    // resolved via findLatestPlanFilePath, which also scans chat history after
    // the approval card has been dismissed.
    const ctx = makeCtx({
      planFilePath: "/tmp/.claude/plans/draft.md",
      readPlanFile: vi.fn(async () => "# Draft plan"),
    });
    const handler = resolveNativeHandler("plan")!;
    await handler.execute(ctx, "open");
    expect(ctx.readPlanFile).toHaveBeenCalledWith(
      "/tmp/.claude/plans/draft.md",
    );
    const msg = (ctx.addLocalMessage as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    // Path header is markdown-formatted (italic + inline code) so the
    // System-message renderer treats it as metadata above the body.
    expect(msg).toContain("_Plan file — `/tmp/.claude/plans/draft.md`_");
    // A blank line separates the header from the plan body so the
    // markdown renderer sees them as distinct blocks.
    expect(msg).toContain(
      "_Plan file — `/tmp/.claude/plans/draft.md`_\n\n# Draft plan",
    );
    // The plan body itself is passed through verbatim so the renderer can
    // handle its internal headings, lists, and code blocks.
    expect(msg).toContain("# Draft plan");
  });

  it("preserves plan-body newlines so the markdown renderer sees distinct blocks", async () => {
    const planBody = [
      "# Plan: make it work",
      "",
      "## Context",
      "- one",
      "- two",
      "",
      "```bash",
      "cargo test",
      "```",
    ].join("\n");
    const ctx = makeCtx({
      planFilePath: "/tmp/.claude/plans/multi-block.md",
      readPlanFile: vi.fn(async () => planBody),
    });
    const handler = resolveNativeHandler("plan")!;
    await handler.execute(ctx, "open");
    const msg = (ctx.addLocalMessage as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    // All the original newlines survive — nothing is collapsed to one paragraph.
    expect(msg.split("\n").length).toBeGreaterThanOrEqual(
      planBody.split("\n").length,
    );
    // Each markdown block the renderer relies on is still intact.
    expect(msg).toContain("## Context");
    expect(msg).toContain("- one\n- two");
    expect(msg).toContain("```bash\ncargo test\n```");
  });

  it("reports when /plan open has no plan file to open", async () => {
    const ctx = makeCtx({ planFilePath: null });
    const handler = resolveNativeHandler("plan")!;
    await handler.execute(ctx, "open");
    expect(ctx.readPlanFile).not.toHaveBeenCalled();
    expect(ctx.addLocalMessage).toHaveBeenCalledWith(
      expect.stringContaining("no plan file found"),
    );
  });

  it("rejects unknown arguments without mutating plan mode", async () => {
    const ctx = makeCtx();
    const handler = resolveNativeHandler("plan")!;
    await handler.execute(ctx, "soon");
    expect(ctx.setPlanMode).not.toHaveBeenCalled();
    expect(ctx.addLocalMessage).toHaveBeenCalledWith(
      expect.stringContaining("unknown argument"),
    );
  });
});

describe("/model handler", () => {
  it("prints the current model and available options with no args", async () => {
    const ctx = makeCtx({ selectedModel: "sonnet" });
    const handler = resolveNativeHandler("model")!;
    await handler.execute(ctx, "");
    expect(ctx.setSelectedModel).not.toHaveBeenCalled();
    const msg = (ctx.addLocalMessage as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(msg).toContain("Current model: sonnet");
    expect(msg).toContain("opus");
    expect(msg).toContain("haiku");
  });

  it("updates the model when a valid id is supplied", async () => {
    const ctx = makeCtx({ selectedModel: "opus" });
    const handler = resolveNativeHandler("model")!;
    await handler.execute(ctx, "sonnet");
    expect(ctx.setSelectedModel).toHaveBeenCalledWith("sonnet");
    expect(ctx.addLocalMessage).toHaveBeenCalledWith("Model set to sonnet.");
  });

  it("resolves model ids case-insensitively to their canonical form", async () => {
    const ctx = makeCtx({ selectedModel: "opus" });
    const handler = resolveNativeHandler("model")!;
    await handler.execute(ctx, "SONNET");
    expect(ctx.setSelectedModel).toHaveBeenCalledWith("sonnet");
  });

  it("no-ops when the requested model equals the current one", async () => {
    const ctx = makeCtx({ selectedModel: "opus" });
    const handler = resolveNativeHandler("model")!;
    await handler.execute(ctx, "opus");
    expect(ctx.setSelectedModel).not.toHaveBeenCalled();
    expect(ctx.addLocalMessage).toHaveBeenCalledWith("Model is already opus.");
  });

  it("rejects unknown model ids with a list of valid options", async () => {
    const ctx = makeCtx();
    const handler = resolveNativeHandler("model")!;
    await handler.execute(ctx, "gpt-5");
    expect(ctx.setSelectedModel).not.toHaveBeenCalled();
    const msg = (ctx.addLocalMessage as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(msg).toContain("unknown model");
    expect(msg).toContain("opus");
    expect(msg).toContain("sonnet");
    expect(msg).toContain("haiku");
  });

  it("surfaces errors from setSelectedModel", async () => {
    const ctx = makeCtx({
      selectedModel: "opus",
      setSelectedModel: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const handler = resolveNativeHandler("model")!;
    await handler.execute(ctx, "sonnet");
    expect(ctx.addLocalMessage).toHaveBeenCalledWith(
      expect.stringContaining("boom"),
    );
  });
});

describe("/permissions handler", () => {
  it("reports current level when invoked with no args", async () => {
    const ctx = makeCtx({ permissionLevel: "standard" });
    const handler = resolveNativeHandler("permissions")!;
    await handler.execute(ctx, "");
    expect(ctx.setPermissionLevel).not.toHaveBeenCalled();
    expect(ctx.addLocalMessage).toHaveBeenCalledWith(
      expect.stringContaining("Permission mode: standard"),
    );
  });

  it("updates level when given a valid mode", async () => {
    const ctx = makeCtx({ permissionLevel: "full" });
    const handler = resolveNativeHandler("permissions")!;
    await handler.execute(ctx, "readonly");
    expect(ctx.setPermissionLevel).toHaveBeenCalledWith("readonly");
    expect(ctx.addLocalMessage).toHaveBeenCalledWith(
      "Permission mode set to readonly.",
    );
  });

  it("accepts the /allowed-tools alias and updates the same state", async () => {
    const ctx = makeCtx({ permissionLevel: "full" });
    const handler = resolveNativeHandler("allowed-tools")!;
    expect(handler.name).toBe("permissions");
    const result = await handler.execute(ctx, "standard");
    expect(result).toEqual({
      kind: "handled",
      canonicalName: "permissions",
    });
    expect(ctx.setPermissionLevel).toHaveBeenCalledWith("standard");
  });

  it("is case-insensitive on the mode argument", async () => {
    const ctx = makeCtx({ permissionLevel: "full" });
    const handler = resolveNativeHandler("permissions")!;
    await handler.execute(ctx, "READONLY");
    expect(ctx.setPermissionLevel).toHaveBeenCalledWith("readonly");
  });

  it("no-ops when the requested mode matches the current one", async () => {
    const ctx = makeCtx({ permissionLevel: "full" });
    const handler = resolveNativeHandler("permissions")!;
    await handler.execute(ctx, "full");
    expect(ctx.setPermissionLevel).not.toHaveBeenCalled();
    expect(ctx.addLocalMessage).toHaveBeenCalledWith(
      "Permission mode is already full.",
    );
  });

  it("rejects unknown modes with a list of valid options", async () => {
    const ctx = makeCtx();
    const handler = resolveNativeHandler("permissions")!;
    await handler.execute(ctx, "god");
    expect(ctx.setPermissionLevel).not.toHaveBeenCalled();
    const msg = (ctx.addLocalMessage as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(msg).toContain('unknown mode "god"');
    expect(msg).toContain("readonly");
    expect(msg).toContain("standard");
    expect(msg).toContain("full");
  });
});

describe("/status handler", () => {
  it("emits a single local message reporting the current workspace state", async () => {
    const ctx = makeCtx({
      repository: { name: "acme", path: "/tmp/repos/acme" },
      workspace: { branch: "feat/slashes", worktreePath: "/tmp/wt/slashes" },
      agentStatus: "Running",
      selectedModel: "sonnet",
      permissionLevel: "standard",
      planMode: true,
      fastMode: false,
      thinkingEnabled: true,
      chromeEnabled: false,
      effortLevel: "high",
    });
    const handler = resolveNativeHandler("status")!;
    const result = await handler.execute(ctx, "");
    expect(result).toEqual({ kind: "handled", canonicalName: "status" });
    expect(ctx.addLocalMessage).toHaveBeenCalledTimes(1);
    const msg = (ctx.addLocalMessage as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(msg).toContain("Repo: acme");
    expect(msg).toContain("Branch: feat/slashes");
    expect(msg).toContain("Agent: Running");
    expect(msg).toContain("Model: sonnet");
    expect(msg).toContain("Permission: standard");
    expect(msg).toContain("Plan mode: on");
    expect(msg).toContain("Fast: off");
    expect(msg).toContain("Thinking: on");
    expect(msg).toContain("Chrome: off");
    expect(msg).toContain("Effort: high");
  });

  it("does not mutate any workspace state", async () => {
    const ctx = makeCtx();
    const handler = resolveNativeHandler("status")!;
    await handler.execute(ctx, "");
    expect(ctx.setSelectedModel).not.toHaveBeenCalled();
    expect(ctx.setPermissionLevel).not.toHaveBeenCalled();
    expect(ctx.setPlanMode).not.toHaveBeenCalled();
    expect(ctx.clearConversation).not.toHaveBeenCalled();
  });

  it("falls back gracefully when workspace metadata is missing", async () => {
    const ctx = makeCtx({
      repository: null,
      workspace: null,
      agentStatus: null,
    });
    const handler = resolveNativeHandler("status")!;
    await handler.execute(ctx, "");
    const msg = (ctx.addLocalMessage as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as string;
    expect(msg).toContain("unknown repo");
    expect(msg).toContain("no branch");
  });
});

describe("workspace-control picker filtering", () => {
  it("exposes every workspace-control canonical entry from NATIVE_HANDLERS", () => {
    const names = NATIVE_HANDLERS.map((h) => h.name);
    expect(names).toContain("clear");
    expect(names).toContain("plan");
    expect(names).toContain("model");
    expect(names).toContain("permissions");
    expect(names).toContain("status");
  });

  it("resolves /allowed-tools as an alias to /permissions", () => {
    expect(resolveNativeHandler("allowed-tools")?.name).toBe("permissions");
    expect(resolveNativeHandler("Allowed-Tools")?.name).toBe("permissions");
  });
});
