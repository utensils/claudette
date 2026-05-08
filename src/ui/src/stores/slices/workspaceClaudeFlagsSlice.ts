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
  invalidateClaudeFlagsForRepo: (repoId: string) => void;
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
    const existing = get().claudeFlagsByWorkspace[workspaceId];
    // Mirror the backend's "already loaded" gate: a sibling consumer
    // (SessionTab + ComposerToolbar both mount at the same time) can race
    // on a missing cache entry. Short-circuit when there's already an
    // in-flight or completed load for this workspace; the entry is wiped
    // by invalidation, returning to the undefined state below.
    if (
      existing &&
      (existing.status === "loading" || existing.status === "ready")
    ) {
      return;
    }
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

  invalidateClaudeFlagsForRepo: (repoId) => {
    const wsList = get().workspaces;
    const target = new Set(
      wsList.filter((w) => w.repository_id === repoId).map((w) => w.id),
    );
    if (target.size === 0) return;
    const current = get().claudeFlagsByWorkspace;
    const next: Record<string, WorkspaceFlagsState> = {};
    for (const [wsId, st] of Object.entries(current)) {
      if (!target.has(wsId)) next[wsId] = st;
    }
    set({ claudeFlagsByWorkspace: next });
  },

  invalidateAllWorkspaceClaudeFlags: () => {
    set({ claudeFlagsByWorkspace: {} });
  },
});
