import type { StateCreator } from "zustand";
import {
  type ClaudeFlagDef,
  type FlagValue,
  getResolvedRepoFlags,
} from "../../services/claudeFlags";
import {
  hasDangerousFlag,
  resolveEnabledExtraFlags,
  type ResolvedFlag,
} from "../../services/claudeFlagsLogic";
import type { AppState } from "../useAppStore";

export type { ResolvedFlag };
export { hasDangerousFlag, resolveEnabledExtraFlags };

export type WorkspaceFlagsStatus = "loading" | "ready" | "error";

export interface WorkspaceFlagsState {
  defs: ClaudeFlagDef[];
  globalState: Record<string, FlagValue>;
  repoState: Record<string, FlagValue>;
  resolved: ResolvedFlag[];
  status: WorkspaceFlagsStatus;
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
