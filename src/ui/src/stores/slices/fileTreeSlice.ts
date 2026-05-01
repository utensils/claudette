import type { StateCreator } from "zustand";
import type { AppState } from "../useAppStore";

export type FileViewerMode = "view" | "edit";
export type FileViewerPreviewMode = "source" | "preview";

/** Per-tab buffer + UI state. Lives in the store keyed by `${wsId}:${path}`
 *  so that switching tabs preserves unsaved edits across the FileViewer's
 *  remounts. The tab strip drives selection; the FileViewer is just a view
 *  onto whichever tab is active. */
export interface FileBufferState {
  /** Last-saved content. Updated on initial load and after each successful
   *  save. The dirty flag is derived as `buffer !== baseline`. */
  baseline: string;
  /** Current editor content. Mirrored back from CodeMirror via `onChange`. */
  buffer: string;
  isBinary: boolean;
  sizeBytes: number;
  truncated: boolean;
  /** Base64 image bytes for image previews. `null` for non-image tabs. */
  imageBytesB64: string | null;
  /** True once the initial load (text or image) has populated this entry.
   *  False entries are still in flight or never started. */
  loaded: boolean;
  loadError: string | null;
  mode: FileViewerMode;
  preview: FileViewerPreviewMode;
}

/** Compose the buffer-state map key. Workspace-scoped because two
 *  workspaces can both have a `src/main.rs` and we don't want to share
 *  buffers across them. */
export function fileBufferKey(workspaceId: string, path: string): string {
  return `${workspaceId}:${path}`;
}

/** Initial buffer state for a freshly-opened tab — no content yet, the
 *  load effect in FileViewer fills it in. */
export function makeUnloadedBuffer(): FileBufferState {
  return {
    baseline: "",
    buffer: "",
    isBinary: false,
    sizeBytes: 0,
    truncated: false,
    imageBytesB64: null,
    loaded: false,
    loadError: null,
    mode: "view",
    preview: "source",
  };
}

export interface FileTreeSlice {
  /** Folder paths (with trailing "/") that are expanded in the All-Files
   *  tree. Persists across tab switches; not across sessions. */
  allFilesExpandedDirs: Record<string, boolean>;
  /** Path of the row focused in the tree (file or folder). */
  allFilesSelectedPath: string | null;

  /** Per-workspace ordered list of open file-tab paths. Tabs are rendered
   *  in this order in the tab strip. */
  fileTabsByWorkspace: Record<string, string[]>;
  /** Per-workspace active file-tab path. `null` means no file tab is
   *  active for that workspace; the workspace falls back to its diff or
   *  chat. */
  activeFileTabByWorkspace: Record<string, string | null>;

  /** Per-`${wsId}:${path}` buffer + UI state for every open file tab. */
  fileBuffers: Record<string, FileBufferState>;

  // Tree
  toggleAllFilesDir: (path: string) => void;
  setAllFilesDirExpanded: (path: string, expanded: boolean) => void;
  setAllFilesSelectedPath: (path: string | null) => void;

  // Tab management
  /** Open a file tab and make it active. If already open, just selects it. */
  openFileTab: (workspaceId: string, path: string) => void;
  /** Switch to an already-open tab (no-op if not in the workspace's tabs). */
  selectFileTab: (workspaceId: string, path: string) => void;
  /** Close a tab. Caller is responsible for any "discard unsaved?" prompt;
   *  this action assumes the close is confirmed. If the closed tab was
   *  active, an adjacent tab takes its place; the workspace falls back to
   *  diff/chat when no tabs remain. */
  closeFileTab: (workspaceId: string, path: string) => void;

  // Per-tab buffer/UI state
  setFileBufferLoaded: (
    workspaceId: string,
    path: string,
    init: Pick<
      FileBufferState,
      "baseline" | "isBinary" | "sizeBytes" | "truncated" | "imageBytesB64"
    >,
  ) => void;
  setFileBufferLoadError: (
    workspaceId: string,
    path: string,
    error: string,
  ) => void;
  setFileBufferContent: (
    workspaceId: string,
    path: string,
    buffer: string,
  ) => void;
  /** Mark the buffer as saved by snapshotting the current buffer as the new
   *  baseline. Clears dirty without touching the buffer (so a save during
   *  active typing doesn't lose the in-flight edit). */
  setFileBufferSaved: (
    workspaceId: string,
    path: string,
    baseline: string,
  ) => void;
  setFileTabMode: (
    workspaceId: string,
    path: string,
    mode: FileViewerMode,
  ) => void;
  setFileTabPreview: (
    workspaceId: string,
    path: string,
    preview: FileViewerPreviewMode,
  ) => void;
}

export const createFileTreeSlice: StateCreator<AppState, [], [], FileTreeSlice> = (
  set,
) => ({
  allFilesExpandedDirs: {},
  allFilesSelectedPath: null,
  fileTabsByWorkspace: {},
  activeFileTabByWorkspace: {},
  fileBuffers: {},

  toggleAllFilesDir: (path) =>
    set((s) => {
      const next = { ...s.allFilesExpandedDirs };
      if (next[path]) delete next[path];
      else next[path] = true;
      return { allFilesExpandedDirs: next };
    }),
  setAllFilesDirExpanded: (path, expanded) =>
    set((s) => {
      const next = { ...s.allFilesExpandedDirs };
      if (expanded) next[path] = true;
      else delete next[path];
      return { allFilesExpandedDirs: next };
    }),
  setAllFilesSelectedPath: (path) => set({ allFilesSelectedPath: path }),

  openFileTab: (workspaceId, path) =>
    set((s) => {
      const existing = s.fileTabsByWorkspace[workspaceId] ?? [];
      const alreadyOpen = existing.includes(path);
      const nextTabs = alreadyOpen
        ? s.fileTabsByWorkspace
        : {
            ...s.fileTabsByWorkspace,
            [workspaceId]: [...existing, path],
          };
      const key = fileBufferKey(workspaceId, path);
      // Seed an unloaded buffer entry so the FileViewer can dispatch a
      // load on mount. Re-opening an already-open tab leaves the buffer
      // intact — that's the whole point of tabs.
      const nextBuffers = s.fileBuffers[key]
        ? s.fileBuffers
        : { ...s.fileBuffers, [key]: makeUnloadedBuffer() };
      return {
        fileTabsByWorkspace: nextTabs,
        activeFileTabByWorkspace: {
          ...s.activeFileTabByWorkspace,
          [workspaceId]: path,
        },
        fileBuffers: nextBuffers,
      };
    }),

  selectFileTab: (workspaceId, path) =>
    set((s) => {
      const tabs = s.fileTabsByWorkspace[workspaceId] ?? [];
      if (!tabs.includes(path)) return s;
      if (s.activeFileTabByWorkspace[workspaceId] === path) return s;
      return {
        activeFileTabByWorkspace: {
          ...s.activeFileTabByWorkspace,
          [workspaceId]: path,
        },
      };
    }),

  closeFileTab: (workspaceId, path) =>
    set((s) => {
      const existing = s.fileTabsByWorkspace[workspaceId] ?? [];
      const idx = existing.indexOf(path);
      if (idx < 0) return s;
      const nextWsTabs = existing.slice(0, idx).concat(existing.slice(idx + 1));
      const wasActive = s.activeFileTabByWorkspace[workspaceId] === path;
      // Pick the previous tab if any, else the next, else null. Mirrors
      // typical IDE behavior — closing the active tab "moves" focus to
      // the adjacent tab on the left.
      let nextActive: string | null = s.activeFileTabByWorkspace[workspaceId] ?? null;
      if (wasActive) {
        if (nextWsTabs.length === 0) {
          nextActive = null;
        } else if (idx > 0) {
          nextActive = nextWsTabs[idx - 1];
        } else {
          nextActive = nextWsTabs[0];
        }
      }
      const key = fileBufferKey(workspaceId, path);
      const { [key]: _dropped, ...remainingBuffers } = s.fileBuffers;
      return {
        fileTabsByWorkspace: {
          ...s.fileTabsByWorkspace,
          [workspaceId]: nextWsTabs,
        },
        activeFileTabByWorkspace: {
          ...s.activeFileTabByWorkspace,
          [workspaceId]: nextActive,
        },
        fileBuffers: remainingBuffers,
      };
    }),

  setFileBufferLoaded: (workspaceId, path, init) =>
    set((s) => {
      const key = fileBufferKey(workspaceId, path);
      const prev = s.fileBuffers[key] ?? makeUnloadedBuffer();
      return {
        fileBuffers: {
          ...s.fileBuffers,
          [key]: {
            ...prev,
            ...init,
            buffer: init.baseline,
            loaded: true,
            loadError: null,
          },
        },
      };
    }),

  setFileBufferLoadError: (workspaceId, path, error) =>
    set((s) => {
      const key = fileBufferKey(workspaceId, path);
      const prev = s.fileBuffers[key] ?? makeUnloadedBuffer();
      return {
        fileBuffers: {
          ...s.fileBuffers,
          [key]: { ...prev, loaded: true, loadError: error },
        },
      };
    }),

  setFileBufferContent: (workspaceId, path, buffer) =>
    set((s) => {
      const key = fileBufferKey(workspaceId, path);
      const prev = s.fileBuffers[key];
      if (!prev) return s;
      if (prev.buffer === buffer) return s;
      return {
        fileBuffers: {
          ...s.fileBuffers,
          [key]: { ...prev, buffer },
        },
      };
    }),

  setFileBufferSaved: (workspaceId, path, baseline) =>
    set((s) => {
      const key = fileBufferKey(workspaceId, path);
      const prev = s.fileBuffers[key];
      if (!prev) return s;
      return {
        fileBuffers: {
          ...s.fileBuffers,
          [key]: { ...prev, baseline },
        },
      };
    }),

  setFileTabMode: (workspaceId, path, mode) =>
    set((s) => {
      const key = fileBufferKey(workspaceId, path);
      const prev = s.fileBuffers[key];
      if (!prev) return s;
      return {
        fileBuffers: {
          ...s.fileBuffers,
          [key]: { ...prev, mode },
        },
      };
    }),

  setFileTabPreview: (workspaceId, path, preview) =>
    set((s) => {
      const key = fileBufferKey(workspaceId, path);
      const prev = s.fileBuffers[key];
      if (!prev) return s;
      return {
        fileBuffers: {
          ...s.fileBuffers,
          [key]: { ...prev, preview },
        },
      };
    }),
});

/** True when the tab's buffer differs from its last-saved baseline. */
export function isFileTabDirty(
  state: AppState,
  workspaceId: string,
  path: string,
): boolean {
  const b = state.fileBuffers[fileBufferKey(workspaceId, path)];
  return !!b && b.buffer !== b.baseline;
}
