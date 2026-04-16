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
    repository: { name: "claudette", path: "/tmp/repos/claudette" },
    workspace: { branch: "feat/review-cmds", worktreePath: "/tmp/wt/review-cmds" },
    defaultBranch: "origin/main",
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

      it("omits missing workspace/repo/defaultBranch fields without leaking placeholders", () => {
        const ctx = makeCtx({
          repository: null,
          workspace: null,
          defaultBranch: null,
        });
        const handler = resolveNativeHandler(name)!;
        const result = handler.execute(ctx, "");
        if (result.kind !== "expand") throw new Error("expected expand");
        expect(result.prompt).not.toContain("undefined");
        expect(result.prompt).not.toContain("null");
        expect(result.prompt).not.toMatch(/Repository:\s*$/m);
        expect(result.prompt).not.toMatch(/Base branch:\s*$/m);
        expect(result.prompt).not.toMatch(/Current branch:\s*$/m);
        expect(result.prompt).not.toMatch(/Worktree:\s*$/m);
      });

      it("omits individual missing fields but keeps populated ones", () => {
        const ctx = makeCtx({
          repository: { name: "claudette", path: "/tmp/repos/claudette" },
          workspace: { branch: "feat/x", worktreePath: null },
          defaultBranch: null,
        });
        const handler = resolveNativeHandler(name)!;
        const result = handler.execute(ctx, "");
        if (result.kind !== "expand") throw new Error("expected expand");
        expect(result.prompt).toContain("claudette");
        expect(result.prompt).toContain("feat/x");
        expect(result.prompt).not.toContain("Worktree:");
        expect(result.prompt).not.toContain("Base branch:");
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
