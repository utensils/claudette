import type { StateCreator } from "zustand";
import {
  type PinnedPrompt,
  listPinnedPromptsInScope,
} from "../../services/tauri";
import type { AppState } from "../useAppStore";

export interface PinnedPromptsSlice {
  /** Global prompts (repo_id IS NULL), in user-defined order. */
  globalPinnedPrompts: PinnedPrompt[];
  /** Repo-scoped prompts keyed by repo id, each in user-defined order. */
  repoPinnedPrompts: Record<string, PinnedPrompt[]>;

  setGlobalPinnedPrompts: (prompts: PinnedPrompt[]) => void;
  setRepoPinnedPrompts: (repoId: string, prompts: PinnedPrompt[]) => void;

  /** Insert or replace a prompt by id within its scope. */
  upsertPinnedPrompt: (prompt: PinnedPrompt) => void;
  /** Remove a prompt by id (searches both scopes). */
  removePinnedPromptById: (id: number) => void;

  loadGlobalPinnedPrompts: () => Promise<void>;
  loadRepoPinnedPrompts: (repoId: string) => Promise<void>;
}

export const createPinnedPromptsSlice: StateCreator<
  AppState,
  [],
  [],
  PinnedPromptsSlice
> = (set, get) => ({
  globalPinnedPrompts: [],
  repoPinnedPrompts: {},

  setGlobalPinnedPrompts: (prompts) => set({ globalPinnedPrompts: prompts }),
  setRepoPinnedPrompts: (repoId, prompts) =>
    set((s) => ({
      repoPinnedPrompts: { ...s.repoPinnedPrompts, [repoId]: prompts },
    })),

  upsertPinnedPrompt: (prompt) =>
    set((s) => {
      if (prompt.repo_id === null) {
        const idx = s.globalPinnedPrompts.findIndex((p) => p.id === prompt.id);
        const next =
          idx >= 0
            ? s.globalPinnedPrompts.map((p) => (p.id === prompt.id ? prompt : p))
            : [...s.globalPinnedPrompts, prompt];
        return { globalPinnedPrompts: next };
      }
      const repoId = prompt.repo_id;
      const current = s.repoPinnedPrompts[repoId] ?? [];
      const idx = current.findIndex((p) => p.id === prompt.id);
      const next =
        idx >= 0
          ? current.map((p) => (p.id === prompt.id ? prompt : p))
          : [...current, prompt];
      return {
        repoPinnedPrompts: { ...s.repoPinnedPrompts, [repoId]: next },
      };
    }),

  removePinnedPromptById: (id) =>
    set((s) => {
      const globals = s.globalPinnedPrompts.filter((p) => p.id !== id);
      const nextRepo: Record<string, PinnedPrompt[]> = {};
      let repoChanged = false;
      for (const [k, v] of Object.entries(s.repoPinnedPrompts)) {
        const filtered = v.filter((p) => p.id !== id);
        nextRepo[k] = filtered;
        if (filtered.length !== v.length) repoChanged = true;
      }
      const out: Partial<AppState> = {};
      if (globals.length !== s.globalPinnedPrompts.length) {
        out.globalPinnedPrompts = globals;
      }
      if (repoChanged) {
        out.repoPinnedPrompts = nextRepo;
      }
      return out;
    }),

  loadGlobalPinnedPrompts: async () => {
    const prompts = await listPinnedPromptsInScope(null);
    get().setGlobalPinnedPrompts(prompts);
  },
  loadRepoPinnedPrompts: async (repoId) => {
    const prompts = await listPinnedPromptsInScope(repoId);
    get().setRepoPinnedPrompts(repoId, prompts);
  },
});

/**
 * Pure selector: merge repo prompts and globals into the composer-visible list.
 *
 * Repo entries come first (in their `sort_order`), followed by globals whose
 * `display_name` is not already used by a repo prompt — repo entries silently
 * shadow globals with the same display name.
 */
export function selectMergedPinnedPrompts(
  state: Pick<AppState, "globalPinnedPrompts" | "repoPinnedPrompts">,
  repoId: string | null | undefined,
): PinnedPrompt[] {
  if (!repoId) return state.globalPinnedPrompts;
  const repoPrompts = state.repoPinnedPrompts[repoId] ?? [];
  const repoNames = new Set(repoPrompts.map((p) => p.display_name));
  const merged: PinnedPrompt[] = [...repoPrompts];
  for (const g of state.globalPinnedPrompts) {
    if (!repoNames.has(g.display_name)) merged.push(g);
  }
  return merged;
}
