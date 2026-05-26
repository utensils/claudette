import { describe, it, expect, vi } from "vitest";
import type { CommandContext } from "./commands";
import { scoreCommand } from "./searchScore";

import { afterAll } from "vitest";

// buildCommands reads navigator.platform via isMacHotkeyPlatform() to pick
// between `⌘⇧B`-style symbols and `Ctrl+Shift+B`-style labels for command
// shortcuts. The shortcut assertions below pin the macOS rendering, so we
// must force a Mac-shaped navigator regardless of the host OS or the test
// environment's default. happy-dom defines `navigator` (so the previous
// `typeof navigator === "undefined"` guard left the real platform in place
// on Windows, producing `Ctrl+Shift+B` and a test failure); always stub.
vi.stubGlobal("navigator", { platform: "MacIntel", userAgentData: undefined });
afterAll(() => { vi.unstubAllGlobals(); });

const { buildCommands, buildModelCommands, buildEffortCommands, buildFileCommands, groupCommandsByCategory, CATEGORY_ORDER, CATEGORY_LABELS } = await import("./commands");
const { Search: stubIcon } = await import("lucide-react");
type Command = ReturnType<typeof buildCommands>[number];

/** Minimal CommandContext stub — only the fields buildCommands needs. */
function makeContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    toggleSidebar: vi.fn(),
    toggleTerminalPanel: vi.fn(),
    toggleRightSidebar: vi.fn(),
    toggleFuzzyFinder: vi.fn(),
    openModal: vi.fn(),
    openSettings: vi.fn(),
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    resetZoom: vi.fn(),
    terminalZoomIn: vi.fn(),
    terminalZoomOut: vi.fn(),
    resetTerminalZoom: vi.fn(),
    close: vi.fn(),
    keybindings: {},
    themes: [],
    applyThemeById: vi.fn(),
    enterThemeMode: vi.fn(),
    enterModelMode: vi.fn(),
    enterEffortMode: vi.fn(),
    enterFileMode: vi.fn(),
    selectedWorkspaceId: null,
    selectedSessionId: null,
    currentRepoId: null,
    createWorkspace: vi.fn(),
    thinkingEnabled: false,
    setThinkingEnabled: vi.fn(),
    planMode: false,
    setPlanMode: vi.fn(),
    fastMode: false,
    setFastMode: vi.fn(),
    effortLevel: "auto",
    setEffortLevel: vi.fn(),
    selectedModel: "opus",
    selectedModelProvider: "anthropic",
    persistSetting: vi.fn(),
    stopAgent: vi.fn(),
    resetAgentSession: vi.fn(),
    clearAgentQuestion: vi.fn(),
    clearPlanApproval: vi.fn(),
    clearAgentApproval: vi.fn(),
    updateWorkspace: vi.fn(),
    ...overrides,
  };
}

describe("buildCommands — zoom commands", () => {
  const ctx = makeContext();
  const cmds = buildCommands(ctx);

  it("includes zoom-in command", () => {
    const cmd = cmds.find((c) => c.id === "zoom-in");
    expect(cmd).toBeDefined();
    expect(cmd!.name).toBe("Zoom In");
    expect(cmd!.category).toBe("ui");
    expect(cmd!.keywords).toContain("zoom");
    expect(cmd!.keywords).toContain("font");
  });

  it("includes zoom-out command", () => {
    const cmd = cmds.find((c) => c.id === "zoom-out");
    expect(cmd).toBeDefined();
    expect(cmd!.name).toBe("Zoom Out");
    expect(cmd!.keywords).toContain("smaller");
  });

  it("includes reset-zoom command", () => {
    const cmd = cmds.find((c) => c.id === "reset-zoom");
    expect(cmd).toBeDefined();
    expect(cmd!.name).toBe("Reset Zoom");
    expect(cmd!.keywords).toContain("reset");
    expect(cmd!.keywords).toContain("default");
  });

  it("zoom-in execute calls ctx.zoomIn and ctx.close", () => {
    const testCtx = makeContext();
    const testCmds = buildCommands(testCtx);
    testCmds.find((c) => c.id === "zoom-in")!.execute();
    expect(testCtx.zoomIn).toHaveBeenCalled();
    expect(testCtx.close).toHaveBeenCalled();
  });

  it("zoom-out execute calls ctx.zoomOut and ctx.close", () => {
    const testCtx = makeContext();
    const testCmds = buildCommands(testCtx);
    testCmds.find((c) => c.id === "zoom-out")!.execute();
    expect(testCtx.zoomOut).toHaveBeenCalled();
    expect(testCtx.close).toHaveBeenCalled();
  });

  it("reset-zoom execute calls ctx.resetZoom and ctx.close", () => {
    const testCtx = makeContext();
    const testCmds = buildCommands(testCtx);
    testCmds.find((c) => c.id === "reset-zoom")!.execute();
    expect(testCtx.resetZoom).toHaveBeenCalled();
    expect(testCtx.close).toHaveBeenCalled();
  });

  it("zoom commands have shortcut labels", () => {
    const zoomIn = cmds.find((c) => c.id === "zoom-in");
    const zoomOut = cmds.find((c) => c.id === "zoom-out");
    expect(zoomIn!.shortcut).toContain("=");
    expect(zoomOut!.shortcut).toContain("-");
  });

  it("includes terminal zoom commands", () => {
    const zoomIn = cmds.find((c) => c.id === "terminal-zoom-in");
    const zoomOut = cmds.find((c) => c.id === "terminal-zoom-out");
    const reset = cmds.find((c) => c.id === "terminal-reset-zoom");

    expect(zoomIn).toBeDefined();
    expect(zoomIn!.name).toBe("Terminal: Zoom In");
    expect(zoomIn!.shortcut).toContain("⇧");
    expect(zoomIn!.shortcut).toContain("=");
    expect(zoomIn!.keywords).toContain("terminal");
    expect(zoomOut).toBeDefined();
    expect(zoomOut!.shortcut).toContain("-");
    expect(reset).toBeDefined();
    expect(reset!.keywords).toContain("reset");
  });

  it("terminal zoom execute calls terminal zoom handlers and ctx.close", () => {
    const testCtx = makeContext();
    const testCmds = buildCommands(testCtx);

    testCmds.find((c) => c.id === "terminal-zoom-in")!.execute();
    expect(testCtx.terminalZoomIn).toHaveBeenCalled();
    expect(testCtx.close).toHaveBeenCalledTimes(1);

    testCmds.find((c) => c.id === "terminal-zoom-out")!.execute();
    expect(testCtx.terminalZoomOut).toHaveBeenCalled();
    expect(testCtx.close).toHaveBeenCalledTimes(2);

    testCmds.find((c) => c.id === "terminal-reset-zoom")!.execute();
    expect(testCtx.resetTerminalZoom).toHaveBeenCalled();
    expect(testCtx.close).toHaveBeenCalledTimes(3);
  });

  it("uses customized shortcut labels", () => {
    const testCtx = makeContext({
      keybindings: {
        "global.toggle-sidebar": "mod+shift+b",
        "global.toggle-terminal-panel": null,
      },
    });
    const testCmds = buildCommands(testCtx);
    expect(testCmds.find((c) => c.id === "toggle-sidebar")!.shortcut).toBe("⌘⇧B");
    expect(testCmds.find((c) => c.id === "toggle-terminal")!.shortcut).toBeUndefined();
  });
});

describe("buildCommands — provider-specific reasoning commands", () => {
  it("hides the thinking toggle for Codex sessions", () => {
    const cmds = buildCommands(makeContext({
      selectedWorkspaceId: "ws-1",
      selectedSessionId: "sess-1",
      selectedModel: "gpt-5.5",
      selectedModelProvider: "codex",
    }));

    expect(cmds.find((c) => c.id === "toggle-thinking")).toBeUndefined();
  });

  it("keeps the thinking toggle for Claude sessions", () => {
    const cmds = buildCommands(makeContext({
      selectedWorkspaceId: "ws-1",
      selectedSessionId: "sess-1",
    }));

    expect(cmds.find((c) => c.id === "toggle-thinking")).toBeDefined();
  });
});

describe("buildModelCommands — extraUsage icon and description", () => {
  const onSelect = vi.fn();
  const close = vi.fn();
  const cmds = buildModelCommands("opus", onSelect, close);

  // Sonnet 4.6 1M is currently flagged as extra usage; on Max/Team/Enterprise
  // plans Opus 1M is included with the subscription, so it intentionally does
  // not surface the extra-usage indicator.
  it("extra-usage models get BadgeDollarSign icon and description", () => {
    const sonnet1m = cmds.find((c) => c.id === "model:claude-sonnet-4-6[1m]")!;
    expect(sonnet1m.description).toBe("Extra usage: 1M context billed at API rates");
    expect(sonnet1m.icon.displayName ?? sonnet1m.icon.name).toContain("BadgeDollarSign");
  });

  it("non-extra-usage models get Sparkles icon and no description", () => {
    const opus47 = cmds.find((c) => c.id === "model:claude-opus-4-7")!;
    expect(opus47.description).toBeUndefined();
    expect(opus47.icon.displayName ?? opus47.icon.name).toContain("Sparkles");
  });

  it("Opus 1M variants are not flagged as extra usage", () => {
    const opus1m = cmds.find((c) => c.id === "model:opus")!;
    expect(opus1m.description).toBeUndefined();
    expect(opus1m.icon.displayName ?? opus1m.icon.name).toContain("Sparkles");

    const opus46_1m = cmds.find((c) => c.id === "model:claude-opus-4-6[1m]")!;
    expect(opus46_1m.description).toBeUndefined();
    expect(opus46_1m.icon.displayName ?? opus46_1m.icon.name).toContain("Sparkles");
  });

  it("selected model gets checkmark in name", () => {
    const selected = cmds.find((c) => c.id === "model:opus")!;
    expect(selected.name).toContain("✓");
    const notSelected = cmds.find((c) => c.id === "model:claude-opus-4-7")!;
    expect(notSelected.name).not.toContain("✓");
  });
});

describe("buildEffortCommands", () => {
  it("uses Codex intelligence levels without Claude-only auto or max levels", () => {
    const cmds = buildEffortCommands(
      "gpt-5.5",
      "high",
      vi.fn(),
      vi.fn(),
      "codex",
      {
        codexReasoningEffort: "Inteligencia",
        codexSetReasoningEffort: "Establecer inteligencia de Codex",
      },
    );

    expect(cmds.map((cmd) => cmd.id)).toEqual([
      "effort:low",
      "effort:medium",
      "effort:high",
      "effort:xhigh",
    ]);
    expect(cmds.find((cmd) => cmd.id === "effort:high")?.name).toContain("✓");
    expect(cmds.find((cmd) => cmd.id === "effort:high")?.description).toBe(
      "Inteligencia: High",
    );
    expect(cmds.find((cmd) => cmd.id === "effort:high")?.keywords).toContain(
      "establecer inteligencia de codex",
    );
  });
});

describe("buildFileCommands", () => {
  const sampleFiles = [
    { path: "src/main.ts", is_directory: false },
    { path: "src/components/Foo.tsx", is_directory: false },
    { path: "README.md", is_directory: false },
    { path: "src/components", is_directory: true },
    { path: "src", is_directory: true },
  ];

  it("filters out directory entries", () => {
    const cmds = buildFileCommands(sampleFiles, vi.fn(), vi.fn());
    expect(cmds).toHaveLength(3);
    expect(cmds.find((c) => c.id === "file:src/components")).toBeUndefined();
    expect(cmds.find((c) => c.id === "file:src")).toBeUndefined();
  });

  it("uses basename as command name and parent dir as description", () => {
    const cmds = buildFileCommands(sampleFiles, vi.fn(), vi.fn());
    const nested = cmds.find((c) => c.id === "file:src/components/Foo.tsx")!;
    expect(nested.name).toBe("Foo.tsx");
    expect(nested.description).toBe("src/components");

    const root = cmds.find((c) => c.id === "file:README.md")!;
    expect(root.name).toBe("README.md");
    expect(root.description).toBeUndefined();
  });

  it("populates path segments as keywords for fuzzy matching", () => {
    const cmds = buildFileCommands(sampleFiles, vi.fn(), vi.fn());
    const nested = cmds.find((c) => c.id === "file:src/components/Foo.tsx")!;
    expect(nested.keywords).toEqual(["src", "components", "Foo.tsx"]);
  });

  it("execute calls openFile with the path and then close", () => {
    const openFile = vi.fn();
    const close = vi.fn();
    const cmds = buildFileCommands(sampleFiles, openFile, close);
    cmds.find((c) => c.id === "file:src/main.ts")!.execute();
    expect(openFile).toHaveBeenCalledWith("src/main.ts");
    expect(close).toHaveBeenCalled();
  });

  it("returns an empty array when given no files", () => {
    expect(buildFileCommands([], vi.fn(), vi.fn())).toEqual([]);
  });
});

describe("zoom command discoverability via searchScore", () => {
  it("'zoom' query matches zoom-in with high score", () => {
    const score = scoreCommand("Zoom In", "Increase UI font size", ["zoom", "larger", "bigger", "font", "size"], "zoom");
    expect(score).toBeGreaterThan(0);
  });

  it("'font size' query matches zoom-in via keywords", () => {
    const score = scoreCommand("Zoom In", "Increase UI font size", ["zoom", "larger", "bigger", "font", "size"], "font");
    expect(score).toBeGreaterThan(0);
  });

  it("'bigger' query matches zoom-in via keywords", () => {
    const score = scoreCommand("Zoom In", "Increase UI font size", ["zoom", "larger", "bigger", "font", "size"], "bigger");
    expect(score).toBeGreaterThan(0);
  });

  it("'reset' query matches reset-zoom", () => {
    const score = scoreCommand("Reset Zoom", "Reset UI font size to default (13px)", ["zoom", "reset", "actual", "default", "font", "size"], "reset");
    expect(score).toBeGreaterThan(0);
  });
});

describe("groupCommandsByCategory — keyboard navigation invariant", () => {
  // Build a small set spanning multiple categories with the **input order**
  // deliberately different from `CATEGORY_ORDER`. The bug fixed in
  // CommandPalette.tsx was: `selectedIndex` indexed the input-order array
  // while the highlight indexed the rendered (grouped) order. Pressing
  // Enter on row N executed input[N], not rendered[N]. This test pins the
  // invariant that the flattened group order is what callers must index.
  const makeCmd = (id: string, category: Command["category"]): Command => ({
    id,
    name: id,
    category,
    icon: stubIcon,
    execute: () => {},
  });

  const filtered: Command[] = [
    // Input order intentionally mixes categories so grouping must shuffle.
    makeCmd("ws-1", "workspace"),
    makeCmd("nav-1", "navigation"),
    makeCmd("gen-1", "general"),
    makeCmd("ws-2", "workspace"),
    makeCmd("ui-1", "ui"),
    makeCmd("gen-2", "general"),
  ];

  it("orders buckets by CATEGORY_ORDER", () => {
    const groups = groupCommandsByCategory(filtered);
    expect(groups.map((g) => g.category)).toEqual([
      "general",
      "ui",
      "workspace",
      "navigation",
    ]);
  });

  it("preserves input order within each bucket", () => {
    const groups = groupCommandsByCategory(filtered);
    const general = groups.find((g) => g.category === "general")!;
    expect(general.commands.map((c) => c.id)).toEqual(["gen-1", "gen-2"]);
    const workspace = groups.find((g) => g.category === "workspace")!;
    expect(workspace.commands.map((c) => c.id)).toEqual(["ws-1", "ws-2"]);
  });

  it("flattened group order is what arrow keys must index — not the input order", () => {
    const groups = groupCommandsByCategory(filtered);
    const flat = groups.flatMap((g) => g.commands);

    // The visible/rendered order:
    expect(flat.map((c) => c.id)).toEqual([
      "gen-1", "gen-2",   // general bucket first per CATEGORY_ORDER
      "ui-1",             // then ui
      "ws-1", "ws-2",     // then workspace
      "nav-1",            // then navigation
    ]);

    // Sanity check that the input order differs — i.e. without the helper
    // (or with the old `filteredCommands[selectedIndex]` lookup) row 0
    // would execute "ws-1" while the user sees "gen-1" highlighted.
    expect(filtered.map((c) => c.id)[0]).toBe("ws-1");
    expect(flat.map((c) => c.id)[0]).toBe("gen-1");
  });

  it("handles empty filtered list", () => {
    expect(groupCommandsByCategory([])).toEqual([]);
  });

  it("CATEGORY_ORDER includes every declared CommandCategory", () => {
    // Source of truth: CATEGORY_LABELS is keyed by every CommandCategory
    // (TypeScript enforces it via Record<CommandCategory, string>). If a
    // future commit adds a category to the type but forgets to register
    // it in CATEGORY_ORDER, that bucket would be silently dropped from
    // the rendered list — catch that here instead of in the wild.
    const declared = Object.keys(CATEGORY_LABELS);
    for (const cat of declared) {
      expect(CATEGORY_ORDER).toContain(cat);
    }
    // And vice versa — no stale entries in CATEGORY_ORDER.
    for (const cat of CATEGORY_ORDER) {
      expect(declared).toContain(cat);
    }
  });
});
