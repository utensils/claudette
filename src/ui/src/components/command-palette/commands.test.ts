import { describe, it, expect, vi } from "vitest";
import type { CommandContext } from "./commands";
import { scoreCommand } from "./searchScore";

import { afterAll } from "vitest";

// buildCommands reads navigator.platform — stub before importing the module.
if (typeof globalThis.navigator === "undefined") {
  vi.stubGlobal("navigator", { platform: "MacIntel", userAgentData: undefined });
}
afterAll(() => { vi.unstubAllGlobals(); });

const { buildCommands, buildModelCommands } = await import("./commands");

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
    close: vi.fn(),
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
    persistSetting: vi.fn(),
    stopAgent: vi.fn(),
    resetAgentSession: vi.fn(),
    clearAgentQuestion: vi.fn(),
    clearPlanApproval: vi.fn(),
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
    // Should contain either Cmd or Ctrl depending on platform
    expect(zoomIn!.shortcut).toMatch(/\+=/);
    expect(zoomOut!.shortcut).toMatch(/\+-/);
  });
});

describe("buildModelCommands — extraUsage icon and description", () => {
  const onSelect = vi.fn();
  const close = vi.fn();
  const cmds = buildModelCommands("opus", onSelect, close);

  it("extra-usage models get BadgeDollarSign icon and description", () => {
    const opus1m = cmds.find((c) => c.id === "model:opus")!;
    expect(opus1m.description).toBe("Extra usage: 1M context billed at API rates");
    expect(opus1m.icon.displayName ?? opus1m.icon.name).toContain("BadgeDollarSign");
  });

  it("non-extra-usage models get Sparkles icon and no description", () => {
    const opus47 = cmds.find((c) => c.id === "model:claude-opus-4-7")!;
    expect(opus47.description).toBeUndefined();
    expect(opus47.icon.displayName ?? opus47.icon.name).toContain("Sparkles");
  });

  it("selected model gets checkmark in name", () => {
    const selected = cmds.find((c) => c.id === "model:opus")!;
    expect(selected.name).toContain("✓");
    const notSelected = cmds.find((c) => c.id === "model:claude-opus-4-7")!;
    expect(notSelected.name).not.toContain("✓");
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
