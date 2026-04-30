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
 * Stable empty-array reference. Subscribers that fall back to "no prompts for
 * this repo yet" must hand the same reference back every render — otherwise
 * useSyncExternalStore (which backs Zustand v5) treats every call as a fresh
 * snapshot and re-renders forever.
 */
export const EMPTY_PINNED_PROMPTS: readonly PinnedPrompt[] = Object.freeze([]);

/**
 * Pure helper: merge repo prompts and globals into the composer-visible list.
 *
 * Repo entries come first (in their `sort_order`), followed by globals whose
 * `display_name` is not already used by a repo prompt — repo entries silently
 * shadow globals with the same display name.
 *
 * NOTE: this allocates a new array, so it MUST NOT be called inside a Zustand
 * selector. Components subscribe to the raw slice arrays and memoize the
 * merge with `useMemo`.
 */
export function mergePinnedPrompts(
  repoPrompts: readonly PinnedPrompt[],
  globalPrompts: readonly PinnedPrompt[],
  repoId: string | null | undefined,
): PinnedPrompt[] {
  if (!repoId) return [...globalPrompts];
  const repoNames = new Set(repoPrompts.map((p) => p.display_name));
  const merged: PinnedPrompt[] = [...repoPrompts];
  for (const g of globalPrompts) {
    if (!repoNames.has(g.display_name)) merged.push(g);
  }
  return merged;
}

/**
 * Convenience wrapper for tests; reads the slice values out of `state` and
 * runs the pure merge. Don't call this from a Zustand selector — see
 * `mergePinnedPrompts`.
 */
export function selectMergedPinnedPrompts(
  state: Pick<AppState, "globalPinnedPrompts" | "repoPinnedPrompts">,
  repoId: string | null | undefined,
): PinnedPrompt[] {
  const repoPrompts = repoId
    ? (state.repoPinnedPrompts[repoId] ?? EMPTY_PINNED_PROMPTS)
    : EMPTY_PINNED_PROMPTS;
  return mergePinnedPrompts(repoPrompts, state.globalPinnedPrompts, repoId);
}
