import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "../../stores/useAppStore";
import {
  extractClaudetteWorktreeRelativePath,
  parseFilePathTarget,
} from "../../utils/filePathLinks";
import { loadWorkspaceFilesCached } from "../../utils/workspaceFileCache";

export interface WorkspaceFileIndex {
  resolve: (path: string) => string | null;
}

const EMPTY_INDEX: WorkspaceFileIndex = { resolve: () => null };

interface FileIndexData {
  paths: Set<string>;
  uniqueBasenames: Map<string, string | null>;
}

interface FileIndexCacheEntry {
  refreshNonce: number;
  promise: Promise<FileIndexData>;
}

const MAX_CACHED_WORKSPACES = 20;
const indexCache = new Map<string, FileIndexCacheEntry>();

export function useWorkspaceFileIndex(
  workspaceId: string | null | undefined,
): WorkspaceFileIndex {
  const refreshNonce = useAppStore((s) =>
    workspaceId ? (s.fileTreeRefreshNonceByWorkspace[workspaceId] ?? 0) : 0,
  );
  const [data, setData] = useState<FileIndexData | null>(null);

  useEffect(() => {
    if (!workspaceId) {
      setData(null);
      return;
    }
    let cancelled = false;
    const promise = loadWorkspaceFileIndexCached(workspaceId, refreshNonce);
    promise
      .then((next) => {
        if (!cancelled) setData(next);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("Failed to load workspace file index:", err);
        setData(null);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, refreshNonce]);

  return useMemo(() => {
    if (!data) return EMPTY_INDEX;
    return {
      resolve(rawPath: string) {
        const parsed = parseFilePathTarget(rawPath.trim().replace(/^@/, ""));
        const normalized = parsed.path.replace(/\\/g, "/").replace(/^\.\//, "");
        if (!normalized || normalized.startsWith("../")) return null;
        const lineSuffix = formatLineSuffix(parsed);
        if (data.paths.has(normalized)) return `${normalized}${lineSuffix}`;
        // Absolute paths under a Claudette-managed worktree (this one or a
        // sibling worktree of the same repo) collapse to their workspace-
        // relative form. If the collapsed path is tracked in the index, the
        // file lives in this worktree too and can open in Monaco.
        const isAbsolute =
          normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized);
        if (isAbsolute) {
          const fromWorktree = extractClaudetteWorktreeRelativePath(normalized);
          if (fromWorktree && data.paths.has(fromWorktree)) {
            return `${fromWorktree}${lineSuffix}`;
          }
          return null;
        }
        if (normalized.includes("/")) return null;
        const basenamePath = data.uniqueBasenames.get(normalized.toLowerCase());
        return basenamePath ? `${basenamePath}${lineSuffix}` : null;
      },
    };
  }, [data]);
}

function loadWorkspaceFileIndexCached(
  workspaceId: string,
  refreshNonce: number,
): Promise<FileIndexData> {
  const cached = indexCache.get(workspaceId);
  if (cached?.refreshNonce === refreshNonce) {
    refreshIndexCacheLru(workspaceId, cached);
    return cached.promise;
  }
  const promise = loadWorkspaceFilesCached(workspaceId, refreshNonce)
    .then(buildFileIndex)
    .catch((err) => {
      const current = indexCache.get(workspaceId);
      if (current?.promise === promise) {
        indexCache.delete(workspaceId);
      }
      throw err;
    });
  indexCache.set(workspaceId, { refreshNonce, promise });
  trimIndexCache();
  return promise;
}

function refreshIndexCacheLru(
  workspaceId: string,
  entry: FileIndexCacheEntry,
): void {
  indexCache.delete(workspaceId);
  indexCache.set(workspaceId, entry);
}

function trimIndexCache(): void {
  while (indexCache.size > MAX_CACHED_WORKSPACES) {
    const oldestKey = indexCache.keys().next().value;
    if (!oldestKey) return;
    indexCache.delete(oldestKey);
  }
}

function formatLineSuffix(parsed: ReturnType<typeof parseFilePathTarget>): string {
  if (typeof parsed.startLine !== "number") return "";
  let suffix = `:${parsed.startLine}`;
  if (typeof parsed.startColumn === "number") {
    suffix += `:${parsed.startColumn}`;
  }
  if (
    typeof parsed.endLine === "number" &&
    (parsed.endLine !== parsed.startLine ||
      typeof parsed.endColumn === "number")
  ) {
    suffix += `-${parsed.endLine}`;
    if (typeof parsed.endColumn === "number") {
      suffix += `:${parsed.endColumn}`;
    }
  }
  return suffix;
}

function buildFileIndex(
  entries: Awaited<ReturnType<typeof loadWorkspaceFilesCached>>,
): FileIndexData {
  const paths = new Set<string>();
  const uniqueBasenames = new Map<string, string | null>();
  for (const entry of entries) {
    if (entry.is_directory) continue;
    const path = entry.path.replace(/\\/g, "/");
    paths.add(path);
    const basename = path.split("/").pop()?.toLowerCase();
    if (!basename) continue;
    if (!uniqueBasenames.has(basename)) {
      uniqueBasenames.set(basename, path);
    } else if (uniqueBasenames.get(basename) !== path) {
      uniqueBasenames.set(basename, null);
    }
  }
  return { paths, uniqueBasenames };
}
