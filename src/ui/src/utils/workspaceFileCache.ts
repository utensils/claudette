import { listWorkspaceFiles, type FileEntry } from "../services/tauri";

interface WorkspaceFilesCacheEntry {
  entries?: FileEntry[];
  entriesRefreshNonce?: number;
  inFlightRefreshNonce?: number;
  promise?: Promise<FileEntry[]>;
}

const MAX_CACHED_WORKSPACES = 20;
const workspaceFilesCache = new Map<string, WorkspaceFilesCacheEntry>();

export function getCachedWorkspaceFiles(
  workspaceId: string,
  refreshNonce: number,
): FileEntry[] | null {
  const cached = workspaceFilesCache.get(workspaceId);
  if (cached?.entriesRefreshNonce !== refreshNonce || !cached.entries) {
    return null;
  }
  refreshLru(workspaceId, cached);
  return cached.entries;
}

export function getStaleWorkspaceFiles(workspaceId: string): FileEntry[] | null {
  const cached = workspaceFilesCache.get(workspaceId);
  if (!cached?.entries) return null;
  refreshLru(workspaceId, cached);
  return cached.entries;
}

export function loadWorkspaceFilesCached(
  workspaceId: string,
  refreshNonce: number,
  options: { forceRefresh?: boolean } = {},
): Promise<FileEntry[]> {
  const cached = workspaceFilesCache.get(workspaceId);
  if (
    !options.forceRefresh &&
    cached?.entriesRefreshNonce === refreshNonce &&
    cached.entries
  ) {
    refreshLru(workspaceId, cached);
    return Promise.resolve(cached.entries);
  }
  if (
    cached?.inFlightRefreshNonce === refreshNonce &&
    cached.promise
  ) {
    refreshLru(workspaceId, cached);
    return cached.promise;
  }

  const nextEntry: WorkspaceFilesCacheEntry = {
    entries: cached?.entries,
    entriesRefreshNonce: cached?.entriesRefreshNonce,
    inFlightRefreshNonce: refreshNonce,
  };
  const promise = listWorkspaceFiles(workspaceId)
    .then((entries) => {
      const current = workspaceFilesCache.get(workspaceId);
      if (current?.promise === promise) {
        workspaceFilesCache.set(workspaceId, {
          entries,
          entriesRefreshNonce: refreshNonce,
        });
        trimWorkspaceFilesCache();
      } else if (current && !current.entries) {
        workspaceFilesCache.set(workspaceId, {
          ...current,
          entries,
          entriesRefreshNonce: refreshNonce,
        });
        trimWorkspaceFilesCache();
      } else if (!current) {
        workspaceFilesCache.set(workspaceId, {
          entries,
          entriesRefreshNonce: refreshNonce,
        });
        trimWorkspaceFilesCache();
      }
      return entries;
    })
    .catch((err) => {
      const current = workspaceFilesCache.get(workspaceId);
      if (current?.promise === promise) {
        if (current.entries) {
          workspaceFilesCache.set(workspaceId, {
            entries: current.entries,
            entriesRefreshNonce: current.entriesRefreshNonce,
          });
        } else {
          workspaceFilesCache.delete(workspaceId);
        }
      }
      throw err;
    });

  nextEntry.promise = promise;
  workspaceFilesCache.set(workspaceId, nextEntry);
  trimWorkspaceFilesCache();
  return promise;
}

export function prewarmWorkspaceFiles(
  workspaceId: string,
  refreshNonce: number,
): void {
  loadWorkspaceFilesCached(workspaceId, refreshNonce).catch((err) => {
    console.debug("[workspaceFileCache] Failed to prewarm workspace files:", err);
  });
}

export function pruneWorkspaceFilesCache(activeWorkspaceIds: Set<string>): void {
  for (const workspaceId of workspaceFilesCache.keys()) {
    if (!activeWorkspaceIds.has(workspaceId)) {
      workspaceFilesCache.delete(workspaceId);
    }
  }
}

function refreshLru(workspaceId: string, entry: WorkspaceFilesCacheEntry): void {
  workspaceFilesCache.delete(workspaceId);
  workspaceFilesCache.set(workspaceId, entry);
}

function trimWorkspaceFilesCache(): void {
  while (workspaceFilesCache.size > MAX_CACHED_WORKSPACES) {
    const oldestKey = workspaceFilesCache.keys().next().value;
    if (!oldestKey) return;
    workspaceFilesCache.delete(oldestKey);
  }
}

export const __testing = {
  reset() {
    workspaceFilesCache.clear();
  },
};
