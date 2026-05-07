import type { StateCreator } from "zustand";
import {
  type ClaudeFlagDef,
  type FlagValue,
  getResolvedRepoFlags,
} from "../../services/claudeFlags";
import type { AppState } from "../useAppStore";

export interface ResolvedFlag {
  name: string;
  value?: string;
  isDangerous: boolean;
}

export type WorkspaceFlagsStatus = "loading" | "ready" | "error";

export interface WorkspaceFlagsState {
  defs: ClaudeFlagDef[];
  globalState: Record<string, FlagValue>;
  repoState: Record<string, FlagValue>;
  resolved: ResolvedFlag[];
  status: WorkspaceFlagsStatus;
}

const DANGEROUS_FLAG = "--dangerously-skip-permissions";

/// Mirror of `claudette::claude_flags_store::resolve_for_repo`. Repo state is
/// the entries that have the `:override` sentinel set — the backend already
/// filters by that, so any key present here wins over the matching global
/// entry. Disabled flags are excluded; flags absent from `defs` are skipped;
/// boolean flags emit `undefined` for value even if a stale value persists.
export function resolveEnabledExtraFlags(
  defs: ClaudeFlagDef[],
  globalState: Record<string, FlagValue>,
  repoState: Record<string, FlagValue>,
): ResolvedFlag[] {
  const out: ResolvedFlag[] = [];
  for (const def of defs) {
    const chosen = repoState[def.name] ?? globalState[def.name];
    if (!chosen) continue;
    if (!chosen.enabled) continue;
    out.push({
      name: def.name,
      value: def.takes_value ? (chosen.value ?? "") : undefined,
      isDangerous: def.is_dangerous,
    });
  }
  return out;
}

export function hasDangerousFlag(resolved: ResolvedFlag[]): boolean {
  return resolved.some((f) => f.name === DANGEROUS_FLAG);
}

export interface WorkspaceClaudeFlagsSlice {
  claudeFlagsByWorkspace: Record<string, WorkspaceFlagsState>;
  loadWorkspaceClaudeFlags: (
    workspaceId: string,
    repoId: string | null,
  ) => Promise<void>;
  invalidateWorkspaceClaudeFlags: (workspaceId: string) => void;
  invalidateAllWorkspaceClaudeFlags: () => void;
}

export const createWorkspaceClaudeFlagsSlice: StateCreator<
  AppState,
  [],
  [],
  WorkspaceClaudeFlagsSlice
> = (set, get) => ({
  claudeFlagsByWorkspace: {},

  loadWorkspaceClaudeFlags: async (workspaceId, repoId) => {
    if (!repoId) {
      set((s) => ({
        claudeFlagsByWorkspace: {
          ...s.claudeFlagsByWorkspace,
          [workspaceId]: {
            defs: [],
            globalState: {},
            repoState: {},
            resolved: [],
            status: "ready",
          },
        },
      }));
      return;
    }
    set((s) => ({
      claudeFlagsByWorkspace: {
        ...s.claudeFlagsByWorkspace,
        [workspaceId]: {
          defs: [],
          globalState: {},
          repoState: {},
          resolved: [],
          status: "loading",
        },
      },
    }));
    try {
      const { defs, state, resolved } = await getResolvedRepoFlags(repoId);
      set((s) => ({
        claudeFlagsByWorkspace: {
          ...s.claudeFlagsByWorkspace,
          [workspaceId]: {
            defs,
            globalState: state.global,
            repoState: state.repo,
            resolved,
            status: "ready",
          },
        },
      }));
    } catch {
      set((s) => ({
        claudeFlagsByWorkspace: {
          ...s.claudeFlagsByWorkspace,
          [workspaceId]: {
            defs: [],
            globalState: {},
            repoState: {},
            resolved: [],
            status: "error",
          },
        },
      }));
    }
  },

  invalidateWorkspaceClaudeFlags: (workspaceId) => {
    const current = get().claudeFlagsByWorkspace;
    if (!(workspaceId in current)) return;
    const next = { ...current };
    delete next[workspaceId];
    set({ claudeFlagsByWorkspace: next });
  },

  invalidateAllWorkspaceClaudeFlags: () => {
    set({ claudeFlagsByWorkspace: {} });
  },
});
