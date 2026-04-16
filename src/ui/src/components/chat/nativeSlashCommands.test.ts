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

  it("exposes review, security-review, and pr-comments as prompt_expansion handlers", () => {
    for (const name of ["review", "security-review", "pr-comments"] as const) {
      const handler = NATIVE_HANDLERS.find((h) => h.name === name);
      expect(handler, `missing NATIVE_HANDLERS entry for ${name}`).toBeDefined();
      expect(handler!.kind).toBe("prompt_expansion");
      expect(handler!.aliases).toEqual([]);
    }
  });

  it("exposes config, usage, extra-usage, release-notes, and version entries", () => {
    const names = NATIVE_HANDLERS.map((h) => h.name);
    expect(names).toContain("config");
    expect(names).toContain("usage");
    expect(names).toContain("extra-usage");
    expect(names).toContain("release-notes");
    expect(names).toContain("version");
  });

  it("declares the expected kinds for the settings/version handlers", () => {
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
      it("resolves by canonical name (case-insensitive)", () => {
        expect(resolveNativeHandler(name)?.name).toBe(name);
        expect(resolveNativeHandler(name.toUpperCase())?.name).toBe(name);
      });

      it("expands with empty args into a seeded prompt grounded in workspace context", () => {
        const ctx = makeCtx();
        const handler = resolveNativeHandler(name)!;
        const result = handler.execute(ctx, "");
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

      it("expands with whitespace-only args the same as empty args", () => {
        const ctx = makeCtx();
        const handler = resolveNativeHandler(name)!;
        const result = handler.execute(ctx, "   \t\n  ");
        if (result.kind !== "expand") throw new Error("expected expand");
        expect(result.prompt).not.toContain("Additional guidance from user");
      });

      it("preserves user-supplied arguments verbatim in a guidance line", () => {
        const ctx = makeCtx();
        const handler = resolveNativeHandler(name)!;
        const args = 'focus on "diff.rs" and the PTY bridge';
        const result = handler.execute(ctx, args);
        if (result.kind !== "expand") throw new Error("expected expand");
        expect(result.prompt).toContain(`Additional guidance from user: ${args}`);
      });

      it("omits missing workspace/repo/repoDefaultBranch fields without leaking placeholders", () => {
        const ctx = makeCtx({
          repository: null,
          workspace: null,
          repoDefaultBranch: null,
        });
        const handler = resolveNativeHandler(name)!;
        const result = handler.execute(ctx, "");
        if (result.kind !== "expand") throw new Error("expected expand");
        expect(result.prompt).not.toContain("undefined");
        expect(result.prompt).not.toContain("null");
        expect(result.prompt).not.toMatch(/Repository:\s*$/m);
        expect(result.prompt).not.toMatch(/Repo default branch[^:]*:\s*$/m);
        expect(result.prompt).not.toMatch(/Current branch:\s*$/m);
        expect(result.prompt).not.toMatch(/Worktree:\s*$/m);
      });

      it("omits individual missing fields but keeps populated ones", () => {
        const ctx = makeCtx({
          repository: { name: "claudette", path: "/tmp/repos/claudette" },
          workspace: { branch: "feat/x", worktreePath: null },
          repoDefaultBranch: null,
        });
        const handler = resolveNativeHandler(name)!;
        const result = handler.execute(ctx, "");
        if (result.kind !== "expand") throw new Error("expected expand");
        expect(result.prompt).toContain("claudette");
        expect(result.prompt).toContain("feat/x");
        expect(result.prompt).not.toContain("Worktree:");
        expect(result.prompt).not.toContain("Repo default branch");
      });

      it("returns an expand result (not handled) so ChatPanel forwards the prompt to sendChatMessage", () => {
        // The ChatPanel send path only falls through to sendChatMessage when
        // the native dispatcher returns `kind: "expand"`. A "handled" result
        // would short-circuit and swallow the command. These handlers must
        // therefore always return "expand" — they seed the prompt and let the
        // normal agent pipeline run it.
        const ctx = makeCtx();
        const handler = resolveNativeHandler(name)!;
        const empty = handler.execute(ctx, "");
        const withArgs = handler.execute(ctx, "hello");
        expect(empty.kind).toBe("expand");
        expect(withArgs.kind).toBe("expand");
      });

      it("does not pass the raw slash input through verbatim — the expansion differs from `/<name> …`", () => {
        const ctx = makeCtx();
        const handler = resolveNativeHandler(name)!;
        const rawInput = `/${name} focus on perf`;
        const result = handler.execute(ctx, "focus on perf");
        if (result.kind !== "expand") throw new Error("expected expand");
        expect(result.prompt).not.toBe(rawInput);
        expect(result.prompt.length).toBeGreaterThan(rawInput.length);
      });
    });
  }

  describe("review base resolution (P1/P2 fixes)", () => {
    it("/review instructs the agent to resolve the review base via gh/git, not to trust the repo default as the base", () => {
      const handler = resolveNativeHandler("review")!;
      const result = handler.execute(makeCtx(), "");
      if (result.kind !== "expand") throw new Error("expected expand");
      expect(result.prompt).toMatch(/Resolve the review base ref/);
      expect(result.prompt).toContain("gh pr view");
      expect(result.prompt).toContain("@{upstream}");
      // The repo default is surfaced only as a labeled hint/fallback.
      expect(result.prompt).toMatch(/hint only.*not guaranteed to be this branch's review base/);
    });

    it("/security-review uses the same resolve-base guidance", () => {
      const handler = resolveNativeHandler("security-review")!;
      const result = handler.execute(makeCtx(), "");
      if (result.kind !== "expand") throw new Error("expected expand");
      expect(result.prompt).toMatch(/Resolve the review base ref/);
      expect(result.prompt).toContain("gh pr view");
    });

    it("does not hardcode the `origin/` remote prefix in the base-resolution block", () => {
      // Non-`origin` remotes (e.g. `upstream` in fork workflows) exist — the
      // Rust backend already handles this in `src/git.rs`. The prompt must not
      // instruct the agent to assume `origin/`.
      const prompt = resolveNativeHandler("review")!.execute(makeCtx(), "");
      if (prompt.kind !== "expand") throw new Error("expected expand");
      expect(prompt.prompt).toMatch(/git remote/);
      expect(prompt.prompt).not.toMatch(/prefixed with ['"`]origin\//);
    });

    it("warns against treating `@{upstream}` as the review base when it just names the branch's own tracking ref", () => {
      // The most common case of `@{upstream}` is the feature branch's remote
      // copy — diffing HEAD against that yields an empty diff. The prompt
      // must spell this out rather than treating upstream as authoritative.
      const prompt = resolveNativeHandler("review")!.execute(makeCtx(), "");
      if (prompt.kind !== "expand") throw new Error("expected expand");
      expect(prompt.prompt).toMatch(/only use this when the upstream clearly names the review target/i);
    });

    it("prompt still instructs base-resolution when repoDefaultBranch is missing (remote-workspace case)", () => {
      // On paired remote workspaces today, defaultBranch may not be in the
      // store. The prompt must still tell the agent to determine a base ref
      // itself rather than diffing against an unnamed / empty ref.
      const ctx = makeCtx({ repoDefaultBranch: null });
      for (const name of ["review", "security-review"] as const) {
        const result = resolveNativeHandler(name)!.execute(ctx, "");
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

  it("each command produces a distinct seeded prompt", () => {
    const ctx = makeCtx();
    const prompts = REVIEW_NAMES.map((n) => {
      const r = resolveNativeHandler(n)!.execute(ctx, "");
      if (r.kind !== "expand") throw new Error("expected expand");
      return r.prompt;
    });
    const unique = new Set(prompts);
    expect(unique.size).toBe(REVIEW_NAMES.length);
  });
});

describe("config native handler", () => {
  it("opens settings with the default general section when no args given", () => {
    const ctx = makeCtx();
    const handler = resolveNativeHandler("config")!;
    const result = handler.execute(ctx, "");
    expect(result).toEqual({ kind: "handled", canonicalName: "config" });
    expect(ctx.openSettings).toHaveBeenCalledTimes(1);
    expect(ctx.openSettings).toHaveBeenCalledWith("general");
  });

  it("resolves the /configure alias to the config handler", () => {
    expect(resolveNativeHandler("configure")?.name).toBe("config");
    expect(resolveNativeHandler("CONFIGURE")?.name).toBe("config");
  });

  it("routes each valid section to openSettings with that section", () => {
    const handler = resolveNativeHandler("config")!;
    for (const section of CONFIG_SECTIONS) {
      const ctx = makeCtx();
      const result = handler.execute(ctx, section);
      expect(result).toEqual({ kind: "handled", canonicalName: "config" });
      expect(ctx.openSettings).toHaveBeenCalledTimes(1);
      expect(ctx.openSettings).toHaveBeenCalledWith(section);
    }
  });

  it("redirects /config usage to experimental when Usage Insights is disabled", () => {
    const ctx = makeCtx({ usageInsightsEnabled: false });
    const handler = resolveNativeHandler("config")!;
    handler.execute(ctx, "usage");
    expect(ctx.openSettings).toHaveBeenCalledWith("experimental");
  });

  it("is case-insensitive for section names", () => {
    const ctx = makeCtx();
    const handler = resolveNativeHandler("config")!;
    handler.execute(ctx, "APPEARANCE");
    expect(ctx.openSettings).toHaveBeenCalledWith("appearance");
  });

  it("ignores extra arguments after the section token", () => {
    const ctx = makeCtx();
    const handler = resolveNativeHandler("config")!;
    handler.execute(ctx, "models foo bar");
    expect(ctx.openSettings).toHaveBeenCalledWith("models");
  });

  it("falls back to general for an unknown section", () => {
    const ctx = makeCtx();
    const handler = resolveNativeHandler("config")!;
    const result = handler.execute(ctx, "bogus-section");
    expect(result).toEqual({ kind: "handled", canonicalName: "config" });
    expect(ctx.openSettings).toHaveBeenCalledWith("general");
  });
});

describe("usage native handler", () => {
  it("resolves /usage and opens the usage settings section when the gate is on", () => {
    const ctx = makeCtx();
    const handler = resolveNativeHandler("usage")!;
    const result = handler.execute(ctx, "");
    expect(result).toEqual({ kind: "handled", canonicalName: "usage" });
    expect(ctx.openSettings).toHaveBeenCalledWith("usage");
    expect(ctx.openUsageSettingsExternal).not.toHaveBeenCalled();
  });

  it("routes /usage to Experimental when Usage Insights is disabled", () => {
    const ctx = makeCtx({ usageInsightsEnabled: false });
    const handler = resolveNativeHandler("usage")!;
    handler.execute(ctx, "");
    expect(ctx.openSettings).toHaveBeenCalledWith("experimental");
  });
});

describe("extra-usage native handler", () => {
  it("reuses both the in-app and external usage paths when the gate is on", () => {
    const ctx = makeCtx();
    const handler = resolveNativeHandler("extra-usage")!;
    const result = handler.execute(ctx, "");
    expect(result).toEqual({ kind: "handled", canonicalName: "extra-usage" });
    expect(ctx.openSettings).toHaveBeenCalledWith("usage");
    expect(ctx.openUsageSettingsExternal).toHaveBeenCalledTimes(1);
  });

  it("routes /extra-usage to Experimental and does NOT launch claude.ai when gated off", () => {
    const ctx = makeCtx({ usageInsightsEnabled: false });
    const handler = resolveNativeHandler("extra-usage")!;
    handler.execute(ctx, "");
    expect(ctx.openSettings).toHaveBeenCalledWith("experimental");
    expect(ctx.openUsageSettingsExternal).not.toHaveBeenCalled();
  });
});

describe("release-notes native handler", () => {
  it("resolves /release-notes and routes through openReleaseNotes", () => {
    const ctx = makeCtx();
    const handler = resolveNativeHandler("release-notes")!;
    const result = handler.execute(ctx, "");
    expect(result).toEqual({
      kind: "handled",
      canonicalName: "release-notes",
    });
    expect(ctx.openReleaseNotes).toHaveBeenCalledTimes(1);
  });

  it("resolves the /changelog alias to the release-notes handler", () => {
    expect(resolveNativeHandler("changelog")?.name).toBe("release-notes");
  });
});

describe("version native handler", () => {
  it("formats the version string with a v-prefix", () => {
    expect(formatVersionMessage("1.2.3")).toBe("Claudette v1.2.3");
  });

  it("falls back to 'unknown' when no version is available", () => {
    expect(formatVersionMessage(null)).toBe("Claudette vunknown");
  });

  it("posts a local message containing the provided app version", () => {
    const ctx = makeCtx({ appVersion: "9.9.9" });
    const handler = resolveNativeHandler("version")!;
    const result = handler.execute(ctx, "");
    expect(result).toEqual({ kind: "handled", canonicalName: "version" });
    expect(ctx.addLocalMessage).toHaveBeenCalledTimes(1);
    expect(ctx.addLocalMessage).toHaveBeenCalledWith("Claudette v9.9.9");
  });

  it("posts a local 'unknown' fallback when appVersion is null", () => {
    const ctx = makeCtx({ appVersion: null });
    const handler = resolveNativeHandler("version")!;
    handler.execute(ctx, "");
    expect(ctx.addLocalMessage).toHaveBeenCalledWith("Claudette vunknown");
  });

  it("resolves the /about alias to the version handler", () => {
    expect(resolveNativeHandler("about")?.name).toBe("version");
  });
});
