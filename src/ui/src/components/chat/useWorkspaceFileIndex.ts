import { useEffect, useMemo, useState } from "react";
import { listWorkspaceFiles } from "../../services/tauri";
import { useAppStore } from "../../stores/useAppStore";
import { parseFilePathTarget } from "../../utils/filePathLinks";

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
const dataCache = new Map<string, FileIndexCacheEntry>();

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
    const cached = dataCache.get(workspaceId);
    let promise =
      cached?.refreshNonce === refreshNonce ? cached.promise : undefined;
    if (!promise) {
      promise = listWorkspaceFiles(workspaceId).then(buildFileIndex);
      dataCache.set(workspaceId, { refreshNonce, promise });
      trimFileIndexCache();
    }
    promise
      .then((next) => {
        if (!cancelled) setData(next);
      })
      .catch((err) => {
        const current = dataCache.get(workspaceId);
        if (current?.promise === promise) {
          dataCache.delete(workspaceId);
        }
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
        const parsed = parseFilePathTarget(rawPath.trim());
        const normalized = parsed.path.replace(/\\/g, "/").replace(/^\.\//, "");
        if (!normalized || normalized.startsWith("../")) return null;
        const lineSuffix = formatLineSuffix(parsed);
        if (data.paths.has(normalized)) return `${normalized}${lineSuffix}`;
        if (normalized.includes("/")) return null;
        const basenamePath = data.uniqueBasenames.get(normalized.toLowerCase());
        return basenamePath ? `${basenamePath}${lineSuffix}` : null;
      },
    };
  }, [data]);
}

function trimFileIndexCache(): void {
  while (dataCache.size > MAX_CACHED_WORKSPACES) {
    const oldestKey = dataCache.keys().next().value;
    if (!oldestKey) return;
    dataCache.delete(oldestKey);
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
  entries: Awaited<ReturnType<typeof listWorkspaceFiles>>,
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
