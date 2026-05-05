import type { StateCreator } from "zustand";
import type {
  DiffFile,
  DiffFileTab,
  FileDiff,
  DiffViewMode,
} from "../../types";
import type {
  CommitEntry,
  DiffLayer,
  DiffSelection,
  StagedDiffFiles,
} from "../../types/diff";
import type { FileContent } from "../../services/tauri";
import type { AppState } from "../useAppStore";

export interface DiffSlice {
  diffFiles: DiffFile[];
  diffMergeBase: string | null;
  diffSelectedFile: string | null;
  diffSelectedLayer: DiffLayer | null;
  diffStagedFiles: StagedDiffFiles | null;
  diffContent: FileDiff | null;
  diffViewMode: DiffViewMode;
  diffLoading: boolean;
  diffError: string | null;
  // Markdown-preview overlay for the active diff tab. Resets to "diff" on
  // every tab switch (no per-tab persistence). Only meaningful when the
  // selected file's extension is .md/.markdown — UI hides the toggle
  // otherwise. Content is the working-tree version (post-edit), fetched
  // separately from the diff so the user sees how their changes will render.
  diffPreviewMode: "diff" | "rendered";
  diffPreviewContent: FileContent | null;
  diffPreviewLoading: boolean;
  diffPreviewError: string | null;
  // Per-workspace open diff-file tabs. Ephemeral — not persisted across
  // restarts. Identity is (path, layer); the same path opened from two
  // different layers produces two distinct tabs because their diff content
  // differs.
  diffTabsByWorkspace: Record<string, DiffFileTab[]>;
  // Which diff tab was active per workspace. Saved on workspace switch,
  // restored (with tab-existence validation) when switching back.
  diffSelectionByWorkspace: Record<string, DiffSelection>;
  commitHistory: CommitEntry[] | null;
  diffSelectedCommitHash: string | null;
  setDiffFiles: (
    files: DiffFile[],
    mergeBase: string,
    stagedFiles?: StagedDiffFiles | null,
    commits?: CommitEntry[] | null,
  ) => void;
  setDiffMergeBase: (sha: string) => void;
  setDiffSelectedFile: (path: string | null, layer?: DiffLayer | null) => void;
  setDiffContent: (content: FileDiff | null) => void;
  setDiffViewMode: (mode: DiffViewMode) => void;
  setDiffLoading: (loading: boolean) => void;
  setDiffError: (error: string | null) => void;
  setCommitHistory: (commits: CommitEntry[] | null) => void;
  setDiffSelectedCommitHash: (hash: string | null) => void;
  setDiffPreviewMode: (mode: "diff" | "rendered") => void;
  setDiffPreviewContent: (content: FileContent | null) => void;
  setDiffPreviewLoading: (loading: boolean) => void;
  setDiffPreviewError: (error: string | null) => void;
  clearDiff: () => void;
  // Replace the entire ordered list of diff tabs for a workspace. Used by
  // drag-reorder (volatile — not persisted across restarts; see SessionTabs
  // unified reorder).
  setDiffTabsForWorkspace: (workspaceId: string, tabs: DiffFileTab[]) => void;
  // Open a diff tab for the given file (deduped by path+layer) and make it
  // the active view. The previously-selected chat session stays selected so
  // closing all diff tabs restores it.
  openDiffTab: (
    workspaceId: string,
    path: string,
    layer?: DiffLayer | null,
  ) => void;
  // Focus an already-open diff tab without mutating the tab list.
  selectDiffTab: (path: string, layer?: DiffLayer | null) => void;
  // Close a diff tab. If it was the active diff, the chat session selected
  // for this workspace becomes active again.
  closeDiffTab: (
    workspaceId: string,
    path: string,
    layer?: DiffLayer | null,
  ) => void;
}

export const createDiffSlice: StateCreator<AppState, [], [], DiffSlice> = (
  set,
) => ({
  diffFiles: [],
  diffMergeBase: null,
  diffSelectedFile: null,
  diffSelectedLayer: null,
  diffStagedFiles: null,
  diffContent: null,
  diffViewMode: "Unified",
  diffLoading: false,
  diffError: null,
  diffPreviewMode: "diff",
  diffPreviewContent: null,
  diffPreviewLoading: false,
  diffPreviewError: null,
  diffTabsByWorkspace: {},
  diffSelectionByWorkspace: {},
  commitHistory: null,
  diffSelectedCommitHash: null,
  setDiffFiles: (files, mergeBase, stagedFiles, commits) =>
    set({
      diffFiles: files,
      diffMergeBase: mergeBase,
      diffStagedFiles: stagedFiles ?? null,
      commitHistory: commits ?? null,
    }),
  setDiffMergeBase: (sha) => set({ diffMergeBase: sha }),
  setDiffSelectedFile: (path, layer) =>
    set({ diffSelectedFile: path, diffSelectedLayer: layer ?? null }),
  setDiffContent: (content) => set({ diffContent: content }),
  setDiffViewMode: (mode) => set({ diffViewMode: mode }),
  setDiffLoading: (loading) => set({ diffLoading: loading }),
  setDiffError: (error) => set({ diffError: error }),
  setCommitHistory: (commits) => set({ commitHistory: commits }),
  setDiffSelectedCommitHash: (hash) => set({ diffSelectedCommitHash: hash }),
  setDiffPreviewMode: (mode) => set({ diffPreviewMode: mode }),
  setDiffPreviewContent: (content) => set({ diffPreviewContent: content }),
  setDiffPreviewLoading: (loading) => set({ diffPreviewLoading: loading }),
  setDiffPreviewError: (error) => set({ diffPreviewError: error }),
  clearDiff: () =>
    set({
      diffFiles: [],
      diffMergeBase: null,
      diffSelectedFile: null,
      diffSelectedLayer: null,
      diffStagedFiles: null,
      diffContent: null,
      diffError: null,
      diffPreviewMode: "diff",
      diffPreviewContent: null,
      diffPreviewLoading: false,
      diffPreviewError: null,
      diffTabsByWorkspace: {},
      diffSelectionByWorkspace: {},
      commitHistory: null,
      diffSelectedCommitHash: null,
    }),
  setDiffTabsForWorkspace: (workspaceId, tabs) =>
    set((s) => ({
      diffTabsByWorkspace: {
        ...s.diffTabsByWorkspace,
        [workspaceId]: tabs,
      },
    })),
  openDiffTab: (workspaceId, path, layer) =>
    set((s) => {
      const normalizedLayer = layer ?? null;
      const existing = s.diffTabsByWorkspace[workspaceId] ?? [];
      const alreadyOpen = existing.some(
        (t) => t.path === path && t.layer === normalizedLayer,
      );
      const nextTabs = alreadyOpen
        ? s.diffTabsByWorkspace
        : {
            ...s.diffTabsByWorkspace,
            [workspaceId]: [...existing, { path, layer: normalizedLayer }],
          };
      // Only clear content when the selection actually changes — clicking the
      // already-active tab must not blank the viewer (the loader effect
      // wouldn't refire on identical deps, leaving the user staring at empty).
      const isSameSelection =
        s.diffSelectedFile === path && s.diffSelectedLayer === normalizedLayer;
      // issue 573: AppLayout gives the file viewer strict precedence over the
      // diff viewer, so opening a diff while a file tab is active would
      // leave the user staring at Monaco. Release the active file pointer
      // for this workspace so the diff actually becomes visible. Only the
      // active pointer is cleared — the file tab itself stays in the strip
      // so the user can switch back. Other workspaces are untouched.
      const wsActiveFile = s.activeFileTabByWorkspace[workspaceId] ?? null;
      const nextActiveFileTabByWorkspace =
        wsActiveFile === null
          ? s.activeFileTabByWorkspace
          : {
              ...s.activeFileTabByWorkspace,
              [workspaceId]: null,
            };
      return {
        diffTabsByWorkspace: nextTabs,
        diffSelectedFile: path,
        diffSelectedLayer: normalizedLayer,
        activeFileTabByWorkspace: nextActiveFileTabByWorkspace,
        ...(isSameSelection
          ? {}
          : {
              diffContent: null,
              diffError: null,
              diffPreviewMode: "diff",
              diffPreviewContent: null,
              diffPreviewLoading: false,
              diffPreviewError: null,
            }),
      };
    }),
  selectDiffTab: (path, layer) =>
    set((s) => {
      const normalizedLayer = layer ?? null;
      const isSameSelection =
        s.diffSelectedFile === path && s.diffSelectedLayer === normalizedLayer;
      if (isSameSelection) return s;
      return {
        diffSelectedFile: path,
        diffSelectedLayer: normalizedLayer,
        diffContent: null,
        diffError: null,
        diffPreviewMode: "diff",
        diffPreviewContent: null,
        diffPreviewLoading: false,
        diffPreviewError: null,
      };
    }),
  closeDiffTab: (workspaceId, path, layer) =>
    set((s) => {
      const normalizedLayer = layer ?? null;
      const existing = s.diffTabsByWorkspace[workspaceId] ?? [];
      const idx = existing.findIndex(
        (t) => t.path === path && t.layer === normalizedLayer,
      );
      if (idx < 0) return s;
      const nextWsTabs = existing.slice(0, idx).concat(existing.slice(idx + 1));
      const wasActive =
        s.diffSelectedFile === path && s.diffSelectedLayer === normalizedLayer;
      const updates: Partial<AppState> = {
        diffTabsByWorkspace: {
          ...s.diffTabsByWorkspace,
          [workspaceId]: nextWsTabs,
        },
      };
      if (wasActive) {
        // Drop active-diff state. AppLayout will fall back to ChatPanel,
        // which renders whichever session is in selectedSessionIdByWorkspaceId.
        updates.diffSelectedFile = null;
        updates.diffSelectedLayer = null;
        updates.diffContent = null;
        updates.diffError = null;
        updates.diffPreviewMode = "diff";
        updates.diffPreviewContent = null;
        updates.diffPreviewLoading = false;
        updates.diffPreviewError = null;
      }
      return updates;
    }),
});
