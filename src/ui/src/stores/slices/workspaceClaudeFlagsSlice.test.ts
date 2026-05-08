import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaudeFlagDef, FlagValue } from "../../services/claudeFlags";
import * as svc from "../../services/claudeFlags";
import { useAppStore } from "../useAppStore";
import {
  hasDangerousFlag,
  resolveEnabledExtraFlags,
  type ResolvedFlag,
} from "./workspaceClaudeFlagsSlice";

const def = (overrides: Partial<ClaudeFlagDef>): ClaudeFlagDef => ({
  name: "--debug",
  short: null,
  takes_value: false,
  value_placeholder: null,
  enum_choices: null,
  description: "Enable debug output",
  is_dangerous: false,
  ...overrides,
});

const fv = (enabled: boolean, value: string | null = null): FlagValue => ({
  enabled,
  value,
});

describe("resolveEnabledExtraFlags", () => {
  it("returns empty when no defs", () => {
    expect(resolveEnabledExtraFlags([], {}, {})).toEqual([]);
  });

  it("uses global state when no repo override", () => {
    const defs = [def({ name: "--debug" })];
    expect(
      resolveEnabledExtraFlags(defs, { "--debug": fv(true) }, {}),
    ).toEqual<ResolvedFlag[]>([
      { name: "--debug", value: undefined, isDangerous: false },
    ]);
  });

  it("repo override wins over global", () => {
    const defs = [def({ name: "--debug" })];
    expect(
      resolveEnabledExtraFlags(
        defs,
        { "--debug": fv(true) },
        { "--debug": fv(false) },
      ),
    ).toEqual([]);
  });

  it("excludes disabled flags", () => {
    const defs = [def({ name: "--debug" })];
    expect(
      resolveEnabledExtraFlags(defs, { "--debug": fv(false) }, {}),
    ).toEqual([]);
  });

  it("emits value for value-taking flag, undefined for boolean", () => {
    const defs = [
      def({ name: "--add-dir", takes_value: true }),
      def({ name: "--debug" }),
    ];
    expect(
      resolveEnabledExtraFlags(
        defs,
        { "--add-dir": fv(true, "/foo"), "--debug": fv(true) },
        {},
      ),
    ).toEqual<ResolvedFlag[]>([
      { name: "--add-dir", value: "/foo", isDangerous: false },
      { name: "--debug", value: undefined, isDangerous: false },
    ]);
  });

  it("treats null value on value-taking flag as empty string", () => {
    const defs = [def({ name: "--add-dir", takes_value: true })];
    const result = resolveEnabledExtraFlags(
      defs,
      { "--add-dir": fv(true, null) },
      {},
    );
    expect(result[0]?.value).toBe("");
  });

  it("propagates is_dangerous from def", () => {
    const defs = [
      def({ name: "--dangerously-skip-permissions", is_dangerous: true }),
    ];
    const result = resolveEnabledExtraFlags(
      defs,
      { "--dangerously-skip-permissions": fv(true) },
      {},
    );
    expect(result[0]?.isDangerous).toBe(true);
  });

  it("ignores defs with no state in either map", () => {
    expect(resolveEnabledExtraFlags([def({ name: "--debug" })], {}, {})).toEqual([]);
  });
});

describe("hasDangerousFlag", () => {
  it("returns true when --dangerously-skip-permissions present", () => {
    expect(
      hasDangerousFlag([
        { name: "--dangerously-skip-permissions", value: undefined, isDangerous: true },
      ]),
    ).toBe(true);
  });

  it("returns false on empty list", () => {
    expect(hasDangerousFlag([])).toBe(false);
  });

  it("returns false when only other flags present", () => {
    expect(
      hasDangerousFlag([
        { name: "--debug", value: undefined, isDangerous: false },
      ]),
    ).toBe(false);
  });

  it("matches by literal name (not isDangerous flag)", () => {
    // Per spec: badge fires only on the literal --dangerously-skip-permissions
    // name. A future --dangerously-foo with isDangerous=true should not trigger.
    expect(
      hasDangerousFlag([
        { name: "--dangerously-foo", value: undefined, isDangerous: true },
      ]),
    ).toBe(false);
  });
});

describe("loadWorkspaceClaudeFlags idempotency (B2)", () => {
  beforeEach(() => {
    useAppStore.setState({ claudeFlagsByWorkspace: {} });
  });

  it("short-circuits a second call while the first is in-flight", async () => {
    let resolveFn!: (v: {
      defs: unknown[];
      state: { global: Record<string, unknown>; repo: Record<string, unknown> };
      resolved: unknown[];
    }) => void;
    const fetchPromise = new Promise<{
      defs: unknown[];
      state: { global: Record<string, unknown>; repo: Record<string, unknown> };
      resolved: unknown[];
    }>((r) => {
      resolveFn = r;
    });
    const spy = vi
      .spyOn(svc, "getResolvedRepoFlags")
      .mockReturnValue(fetchPromise as unknown as ReturnType<typeof svc.getResolvedRepoFlags>);

    const { loadWorkspaceClaudeFlags } = useAppStore.getState();
    const p1 = loadWorkspaceClaudeFlags("ws1", "r1");
    const p2 = loadWorkspaceClaudeFlags("ws1", "r1"); // should short-circuit

    resolveFn({ defs: [], state: { global: {}, repo: {} }, resolved: [] });
    await Promise.all([p1, p2]);

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("re-fetches after invalidation removes the entry", async () => {
    const spy = vi
      .spyOn(svc, "getResolvedRepoFlags")
      .mockResolvedValue({
        defs: [],
        state: { global: {}, repo: {} },
        resolved: [],
      });

    const { loadWorkspaceClaudeFlags, invalidateWorkspaceClaudeFlags } =
      useAppStore.getState();
    await loadWorkspaceClaudeFlags("ws1", "r1");
    invalidateWorkspaceClaudeFlags("ws1");
    await loadWorkspaceClaudeFlags("ws1", "r1");

    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});

describe("invalidateClaudeFlagsForRepo (F1)", () => {
  beforeEach(() => {
    useAppStore.setState({
      claudeFlagsByWorkspace: {},
      workspaces: [
        { id: "wsA", repository_id: "r1", name: "wsA", branch: "b", worktree_path: "/a", agent_status: "Idle", sort_order: 0 } as never,
        { id: "wsB", repository_id: "r1", name: "wsB", branch: "b", worktree_path: "/b", agent_status: "Idle", sort_order: 1 } as never,
        { id: "wsC", repository_id: "r2", name: "wsC", branch: "b", worktree_path: "/c", agent_status: "Idle", sort_order: 2 } as never,
      ],
    });
  });

  it("removes only entries for workspaces in the affected repo", () => {
    const ready = {
      defs: [],
      globalState: {},
      repoState: {},
      resolved: [],
      status: "ready" as const,
    };
    useAppStore.setState({
      claudeFlagsByWorkspace: { wsA: ready, wsB: ready, wsC: ready },
    });

    useAppStore.getState().invalidateClaudeFlagsForRepo("r1");

    const after = useAppStore.getState().claudeFlagsByWorkspace;
    expect(after.wsA).toBeUndefined();
    expect(after.wsB).toBeUndefined();
    expect(after.wsC).toBeDefined(); // different repo — keep
  });
});

describe("loadWorkspaceClaudeFlags state transitions (Coverage 4.5)", () => {
  beforeEach(() => {
    useAppStore.setState({ claudeFlagsByWorkspace: {} });
  });

  it("returns ready+empty when repoId is null", async () => {
    await useAppStore.getState().loadWorkspaceClaudeFlags("ws1", null);
    const state = useAppStore.getState().claudeFlagsByWorkspace["ws1"];
    expect(state).toBeDefined();
    expect(state!.status).toBe("ready");
    expect(state!.defs).toEqual([]);
    expect(state!.resolved).toEqual([]);
  });

  it("transitions loading → ready on success", async () => {
    const spy = vi.spyOn(svc, "getResolvedRepoFlags").mockResolvedValue({
      defs: [],
      state: { global: {}, repo: {} },
      resolved: [],
    });
    await useAppStore.getState().loadWorkspaceClaudeFlags("ws1", "r1");
    expect(useAppStore.getState().claudeFlagsByWorkspace["ws1"]?.status).toBe(
      "ready",
    );
    spy.mockRestore();
  });

  it("transitions loading → error on failure", async () => {
    const spy = vi
      .spyOn(svc, "getResolvedRepoFlags")
      .mockRejectedValue(new Error("boom"));
    await useAppStore.getState().loadWorkspaceClaudeFlags("ws1", "r1");
    expect(useAppStore.getState().claudeFlagsByWorkspace["ws1"]?.status).toBe(
      "error",
    );
    spy.mockRestore();
  });
});
