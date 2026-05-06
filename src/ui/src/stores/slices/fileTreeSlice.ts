import type { StateCreator } from "zustand";
import type { AppState } from "../useAppStore";
import type { UnifiedTabEntry } from "../../components/chat/sessionTabsLogic";

export type FileViewerPreviewMode = "source" | "preview";

/** Per-tab buffer + UI state. Lives in the store keyed by `${wsId}:${path}`
 *  so that switching tabs preserves unsaved edits across the FileViewer's
 *  remounts. The tab strip drives selection; the FileViewer is just a view
 *  onto whichever tab is active. */
export interface FileBufferState {
  /** Last-saved content. Updated on initial load and after each successful
   *  save. The dirty flag is derived as `buffer !== baseline`. */
  baseline: string;
  /** Current editor content. Mirrored back from the file viewer's editor
   *  via its `onChange` callback. */
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
  preview: FileViewerPreviewMode;
}

export interface RemovedFilePathSnapshot {
  tabs: string[];
  active: string | null;
  buffers: Record<string, FileBufferState>;
  selected: string | null;
  expanded: Record<string, boolean>;
  tabOrderEntries: UnifiedTabEntry[];
}

export type FilePathUndoOperation =
  | {
      kind: "create";
      path: string;
    }
  | {
      kind: "rename";
      oldPath: string;
      newPath: string;
      isDirectory: boolean;
    }
  | {
      kind: "trash";
      oldPath: string;
      isDirectory: boolean;
      undoToken: string | null;
      snapshot: RemovedFilePathSnapshot;
    };

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
    preview: "source",
  };
}

function stripTrailingSlash(path: string): string {
  return path.replace(/\/+$/g, "");
}

function withTrailingSlash(path: string): string {
  const stripped = stripTrailingSlash(path);
  return stripped === "" ? "" : `${stripped}/`;
}

export function mapPathAfterRename(
  path: string,
  oldPath: string,
  newPath: string,
  isDirectory: boolean,
): string {
  const oldClean = stripTrailingSlash(oldPath);
  const newClean = stripTrailingSlash(newPath);
  if (!isDirectory) return path === oldClean ? newClean : path;
  const oldPrefix = `${oldClean}/`;
  if (path === oldClean) return newClean;
  if (path.startsWith(oldPrefix)) {
    return `${newClean}/${path.slice(oldPrefix.length)}`;
  }
  return path;
}

export function pathMatchesTarget(
  path: string,
  targetPath: string,
  isDirectory: boolean,
): boolean {
  const cleanPath = stripTrailingSlash(path);
  const cleanTarget = stripTrailingSlash(targetPath);
  if (!isDirectory) return cleanPath === cleanTarget;
  return cleanPath === cleanTarget || cleanPath.startsWith(`${cleanTarget}/`);
}

export interface FileTreeSlice {
  /** Per-workspace map of folder paths (with trailing "/") that are
   *  expanded in the All-Files tree. Scoped per workspace so two repos
   *  with overlapping folder names (`src/`, `test/`, …) don't share
   *  expansion state. Persists across tab switches; not across sessions. */
  allFilesExpandedDirsByWorkspace: Record<string, Record<string, boolean>>;
  /** Per-workspace path of the row focused in the tree (file or folder). */
  allFilesSelectedPathByWorkspace: Record<string, string | null>;
  /** Monotonic per-workspace refresh signal for mounted Files panels. */
  fileTreeRefreshNonceByWorkspace: Record<string, number>;

  /** Per-workspace ordered list of open file-tab paths. Tabs are rendered
   *  in this order in the tab strip. */
  fileTabsByWorkspace: Record<string, string[]>;
  /** Per-workspace active file-tab path. `null` means no file tab is
   *  active for that workspace; the workspace falls back to its diff or
   *  chat. */
  activeFileTabByWorkspace: Record<string, string | null>;

  /** Per-`${wsId}:${path}` buffer + UI state for every open file tab. */
  fileBuffers: Record<string, FileBufferState>;
  filePathUndoStackByWorkspace: Record<string, FilePathUndoOperation[]>;

  // Tree (scoped per workspace)
  toggleAllFilesDir: (workspaceId: string, path: string) => void;
  setAllFilesDirExpanded: (
    workspaceId: string,
    path: string,
    expanded: boolean,
  ) => void;
  setAllFilesSelectedPath: (
    workspaceId: string,
    path: string | null,
  ) => void;
  requestFileTreeRefresh: (workspaceId: string) => void;

  // Tab management
  /** Replace the entire ordered list of file tabs for a workspace. Used by
   *  drag-reorder (volatile — not persisted across restarts; see SessionTabs
   *  unified reorder). Caller is responsible for keeping the active tab in
   *  the new list. */
  setFileTabsForWorkspace: (workspaceId: string, paths: string[]) => void;
  /** Open a file tab and make it active. If already open, just selects it. */
  openFileTab: (workspaceId: string, path: string) => void;
  /** Switch to an already-open tab (no-op if not in the workspace's tabs). */
  selectFileTab: (workspaceId: string, path: string) => void;
  /** Close a tab. Caller is responsible for any "discard unsaved?" prompt;
   *  this action assumes the close is confirmed. If the closed tab was
   *  active, an adjacent tab takes its place; the workspace falls back to
   *  diff/chat when no tabs remain. */
  closeFileTab: (workspaceId: string, path: string) => void;
  /** Deactivate the file viewer for this workspace without closing any
   *  tabs. Used when the user selects a chat-session or diff tab in the
   *  shared tab strip — `AppLayout` prioritizes the file viewer whenever
   *  a file tab is active, so we have to explicitly clear the active
   *  pointer for the chat/diff selection to take effect visually. */
  clearActiveFileTab: (workspaceId: string) => void;

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
  setFileTabPreview: (
    workspaceId: string,
    path: string,
    preview: FileViewerPreviewMode,
  ) => void;
  renameFilePathInWorkspace: (
    workspaceId: string,
    oldPath: string,
    newPath: string,
    isDirectory: boolean,
  ) => void;
  removeFilePathFromWorkspace: (
    workspaceId: string,
    path: string,
    isDirectory: boolean,
  ) => void;
  restoreRemovedFilePathInWorkspace: (
    workspaceId: string,
    snapshot: RemovedFilePathSnapshot,
  ) => void;
  pushFilePathUndoOperation: (
    workspaceId: string,
    operation: FilePathUndoOperation,
  ) => void;
  popFilePathUndoOperation: (
    workspaceId: string,
    operation?: FilePathUndoOperation,
  ) => void;
}

export const createFileTreeSlice: StateCreator<AppState, [], [], FileTreeSlice> = (
  set,
) => ({
  allFilesExpandedDirsByWorkspace: {},
  allFilesSelectedPathByWorkspace: {},
  fileTreeRefreshNonceByWorkspace: {},
  fileTabsByWorkspace: {},
  activeFileTabByWorkspace: {},
  fileBuffers: {},
  filePathUndoStackByWorkspace: {},

  toggleAllFilesDir: (workspaceId, path) =>
    set((s) => {
      const wsDirs = s.allFilesExpandedDirsByWorkspace[workspaceId] ?? {};
      const next = { ...wsDirs };
      if (next[path]) delete next[path];
      else next[path] = true;
      return {
        allFilesExpandedDirsByWorkspace: {
          ...s.allFilesExpandedDirsByWorkspace,
          [workspaceId]: next,
        },
      };
    }),
  setAllFilesDirExpanded: (workspaceId, path, expanded) =>
    set((s) => {
      const wsDirs = s.allFilesExpandedDirsByWorkspace[workspaceId] ?? {};
      const next = { ...wsDirs };
      if (expanded) next[path] = true;
      else delete next[path];
      return {
        allFilesExpandedDirsByWorkspace: {
          ...s.allFilesExpandedDirsByWorkspace,
          [workspaceId]: next,
        },
      };
    }),
  setAllFilesSelectedPath: (workspaceId, path) =>
    set((s) => ({
      allFilesSelectedPathByWorkspace: {
        ...s.allFilesSelectedPathByWorkspace,
        [workspaceId]: path,
      },
    })),
  requestFileTreeRefresh: (workspaceId) =>
    set((s) => ({
      fileTreeRefreshNonceByWorkspace: {
        ...s.fileTreeRefreshNonceByWorkspace,
        [workspaceId]: (s.fileTreeRefreshNonceByWorkspace[workspaceId] ?? 0) + 1,
      },
    })),

  setFileTabsForWorkspace: (workspaceId, paths) =>
    set((s) => ({
      fileTabsByWorkspace: {
        ...s.fileTabsByWorkspace,
        [workspaceId]: paths,
      },
    })),

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

  clearActiveFileTab: (workspaceId) =>
    set((s) => {
      if (s.activeFileTabByWorkspace[workspaceId] == null) return s;
      return {
        activeFileTabByWorkspace: {
          ...s.activeFileTabByWorkspace,
          [workspaceId]: null,
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

  renameFilePathInWorkspace: (workspaceId, oldPath, newPath, isDirectory) =>
    set((s) => {
      const oldClean = stripTrailingSlash(oldPath);
      const newClean = stripTrailingSlash(newPath);
      const existingTabs = s.fileTabsByWorkspace[workspaceId] ?? [];
      const nextWsTabs = existingTabs.map((path) =>
        mapPathAfterRename(path, oldClean, newClean, isDirectory),
      );
      const active = s.activeFileTabByWorkspace[workspaceId] ?? null;
      const nextActive =
        active === null
          ? null
          : mapPathAfterRename(active, oldClean, newClean, isDirectory);

      const nextBuffers: Record<string, FileBufferState> = {};
      for (const [key, value] of Object.entries(s.fileBuffers)) {
        const prefix = `${workspaceId}:`;
        if (!key.startsWith(prefix)) {
          nextBuffers[key] = value;
          continue;
        }
        const path = key.slice(prefix.length);
        const mapped = mapPathAfterRename(path, oldClean, newClean, isDirectory);
        nextBuffers[fileBufferKey(workspaceId, mapped)] = value;
      }

      const selected = s.allFilesSelectedPathByWorkspace[workspaceId] ?? null;
      const nextSelected =
        selected === null
          ? null
          : mapPathAfterRename(
              stripTrailingSlash(selected),
              oldClean,
              newClean,
              isDirectory,
            ) + (selected.endsWith("/") ? "/" : "");

      const expanded = s.allFilesExpandedDirsByWorkspace[workspaceId] ?? {};
      const nextExpanded: Record<string, boolean> = {};
      for (const [path, value] of Object.entries(expanded)) {
        // Expanded directory keys are stored with a trailing slash. Strip before
        // mapping so containment checks use the same canonical form as file
        // tabs, then restore the trailing slash for the expanded-dirs map.
        const mapped = mapPathAfterRename(
          stripTrailingSlash(path),
          oldClean,
          newClean,
          isDirectory,
        );
        nextExpanded[withTrailingSlash(mapped)] = value;
      }

      return {
        fileTabsByWorkspace: {
          ...s.fileTabsByWorkspace,
          [workspaceId]: nextWsTabs,
        },
        activeFileTabByWorkspace: {
          ...s.activeFileTabByWorkspace,
          [workspaceId]: nextActive,
        },
        fileBuffers: nextBuffers,
        allFilesSelectedPathByWorkspace: {
          ...s.allFilesSelectedPathByWorkspace,
          [workspaceId]: nextSelected,
        },
        allFilesExpandedDirsByWorkspace: {
          ...s.allFilesExpandedDirsByWorkspace,
          [workspaceId]: nextExpanded,
        },
        tabOrderByWorkspace: {
          ...s.tabOrderByWorkspace,
          [workspaceId]: (s.tabOrderByWorkspace[workspaceId] ?? []).map((entry) =>
            entry.kind === "file"
              ? {
                  ...entry,
                  path: mapPathAfterRename(
                    entry.path,
                    oldClean,
                    newClean,
                    isDirectory,
                  ),
                }
              : entry,
          ),
        },
      };
    }),

  removeFilePathFromWorkspace: (workspaceId, path, isDirectory) =>
    set((s) => {
      const target = stripTrailingSlash(path);
      const existingTabs = s.fileTabsByWorkspace[workspaceId] ?? [];
      const firstRemovedIndex = existingTabs.findIndex((tabPath) =>
        pathMatchesTarget(tabPath, target, isDirectory),
      );
      const nextWsTabs = existingTabs.filter(
        (tabPath) => !pathMatchesTarget(tabPath, target, isDirectory),
      );
      const active = s.activeFileTabByWorkspace[workspaceId] ?? null;
      let nextActive = active;
      if (active !== null && pathMatchesTarget(active, target, isDirectory)) {
        if (nextWsTabs.length === 0) {
          nextActive = null;
        } else if (firstRemovedIndex > 0) {
          nextActive = nextWsTabs[Math.min(firstRemovedIndex - 1, nextWsTabs.length - 1)];
        } else {
          nextActive = nextWsTabs[0];
        }
      }

      const nextBuffers: Record<string, FileBufferState> = {};
      for (const [key, value] of Object.entries(s.fileBuffers)) {
        const prefix = `${workspaceId}:`;
        if (!key.startsWith(prefix)) {
          nextBuffers[key] = value;
          continue;
        }
        const bufferPath = key.slice(prefix.length);
        if (!pathMatchesTarget(bufferPath, target, isDirectory)) {
          nextBuffers[key] = value;
        }
      }

      const selected = s.allFilesSelectedPathByWorkspace[workspaceId] ?? null;
      const nextSelected =
        selected !== null && pathMatchesTarget(selected, target, isDirectory)
          ? null
          : selected;
      const expanded = s.allFilesExpandedDirsByWorkspace[workspaceId] ?? {};
      const nextExpanded = Object.fromEntries(
        Object.entries(expanded).filter(
          ([dir]) => !pathMatchesTarget(dir, target, isDirectory),
        ),
      );

      return {
        fileTabsByWorkspace: {
          ...s.fileTabsByWorkspace,
          [workspaceId]: nextWsTabs,
        },
        activeFileTabByWorkspace: {
          ...s.activeFileTabByWorkspace,
          [workspaceId]: nextActive,
        },
        fileBuffers: nextBuffers,
        allFilesSelectedPathByWorkspace: {
          ...s.allFilesSelectedPathByWorkspace,
          [workspaceId]: nextSelected,
        },
        allFilesExpandedDirsByWorkspace: {
          ...s.allFilesExpandedDirsByWorkspace,
          [workspaceId]: nextExpanded,
        },
        tabOrderByWorkspace: {
          ...s.tabOrderByWorkspace,
          [workspaceId]: (s.tabOrderByWorkspace[workspaceId] ?? []).filter(
            (entry) =>
              entry.kind !== "file" ||
              !pathMatchesTarget(entry.path, target, isDirectory),
          ),
        },
      };
    }),

  restoreRemovedFilePathInWorkspace: (workspaceId, snapshot) =>
    set((s) => {
      const existingTabs = s.fileTabsByWorkspace[workspaceId] ?? [];
      const existingTabSet = new Set(existingTabs);
      const restoredTabs = snapshot.tabs.filter((path) => !existingTabSet.has(path));
      const currentOrder = s.tabOrderByWorkspace[workspaceId] ?? [];
      const currentOrderKeys = new Set(
        currentOrder.map((entry) =>
          entry.kind === "file"
            ? `file:${entry.path}`
            : entry.kind === "diff"
              ? `diff:${entry.path}:${entry.layer ?? ""}`
              : `session:${entry.sessionId}`,
        ),
      );
      const restoredOrder = snapshot.tabOrderEntries.filter((entry) => {
        const key =
          entry.kind === "file"
            ? `file:${entry.path}`
            : entry.kind === "diff"
              ? `diff:${entry.path}:${entry.layer ?? ""}`
              : `session:${entry.sessionId}`;
        return !currentOrderKeys.has(key);
      });
      return {
        fileTabsByWorkspace: {
          ...s.fileTabsByWorkspace,
          [workspaceId]: [...existingTabs, ...restoredTabs],
        },
        activeFileTabByWorkspace: {
          ...s.activeFileTabByWorkspace,
          [workspaceId]: snapshot.active ?? s.activeFileTabByWorkspace[workspaceId] ?? null,
        },
        fileBuffers: {
          ...s.fileBuffers,
          ...snapshot.buffers,
        },
        allFilesSelectedPathByWorkspace: {
          ...s.allFilesSelectedPathByWorkspace,
          [workspaceId]:
            snapshot.selected ?? s.allFilesSelectedPathByWorkspace[workspaceId] ?? null,
        },
        allFilesExpandedDirsByWorkspace: {
          ...s.allFilesExpandedDirsByWorkspace,
          [workspaceId]: {
            ...(s.allFilesExpandedDirsByWorkspace[workspaceId] ?? {}),
            ...snapshot.expanded,
          },
        },
        tabOrderByWorkspace: {
          ...s.tabOrderByWorkspace,
          [workspaceId]: [...currentOrder, ...restoredOrder],
        },
      };
    }),

  pushFilePathUndoOperation: (workspaceId, operation) =>
    set((s) => ({
      filePathUndoStackByWorkspace: {
        ...s.filePathUndoStackByWorkspace,
        [workspaceId]: [
          ...(s.filePathUndoStackByWorkspace[workspaceId] ?? []),
          operation,
        ].slice(-50),
      },
    })),

  popFilePathUndoOperation: (workspaceId, operation) =>
    set((s) => {
      const stack = s.filePathUndoStackByWorkspace[workspaceId] ?? [];
      if (stack.length === 0) return s;
      if (operation && stack.at(-1) !== operation) return s;
      return {
        filePathUndoStackByWorkspace: {
          ...s.filePathUndoStackByWorkspace,
          [workspaceId]: stack.slice(0, -1),
        },
      };
    }),
});

export function snapshotRemovedFilePath(
  state: AppState,
  workspaceId: string,
  path: string,
  isDirectory: boolean,
): RemovedFilePathSnapshot {
  const target = stripTrailingSlash(path);
  const tabs = (state.fileTabsByWorkspace[workspaceId] ?? []).filter((tabPath) =>
    pathMatchesTarget(tabPath, target, isDirectory),
  );
  const active = state.activeFileTabByWorkspace[workspaceId] ?? null;
  const buffers: Record<string, FileBufferState> = {};
  const prefix = `${workspaceId}:`;
  for (const [key, value] of Object.entries(state.fileBuffers)) {
    if (!key.startsWith(prefix)) continue;
    const bufferPath = key.slice(prefix.length);
    if (pathMatchesTarget(bufferPath, target, isDirectory)) {
      buffers[key] = value;
    }
  }
  const selected = state.allFilesSelectedPathByWorkspace[workspaceId] ?? null;
  const expanded = state.allFilesExpandedDirsByWorkspace[workspaceId] ?? {};
  return {
    tabs,
    active:
      active !== null && pathMatchesTarget(active, target, isDirectory)
        ? active
        : null,
    buffers,
    selected:
      selected !== null && pathMatchesTarget(selected, target, isDirectory)
        ? selected
        : null,
    expanded: Object.fromEntries(
      Object.entries(expanded).filter(([dir]) =>
        pathMatchesTarget(dir, target, isDirectory),
      ),
    ),
    tabOrderEntries: (state.tabOrderByWorkspace[workspaceId] ?? []).filter(
      (entry) =>
        entry.kind === "file" && pathMatchesTarget(entry.path, target, isDirectory),
    ),
  };
}

/** True when the tab's buffer differs from its last-saved baseline. */
export function isFileTabDirty(
  state: AppState,
  workspaceId: string,
  path: string,
): boolean {
  const b = state.fileBuffers[fileBufferKey(workspaceId, path)];
  return !!b && b.buffer !== b.baseline;
}
