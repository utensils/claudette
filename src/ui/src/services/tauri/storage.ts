import { invoke } from "@tauri-apps/api/core";

export interface WorkspaceStorageEntry {
  id: string;
  name: string;
  status: "Active" | "Archived";
  worktree_path: string | null;
  size_bytes: number | null;
}

export interface RepoStorageStats {
  repository_id: string;
  active_bytes: number;
  archived_bytes: number;
  total_bytes: number;
  workspaces: WorkspaceStorageEntry[];
}

export interface OrphanedWorktree {
  path: string;
  size_bytes: number;
  inferred_repo_slug: string;
  inferred_repo_name: string | null;
}

export function computeStorageStats(): Promise<RepoStorageStats[]> {
  return invoke("compute_storage_stats");
}

/**
 * Bytes that would actually free if every workspace in `workspaceIds`
 * were deleted together — dedup-aware. A blob shared between two
 * workspaces in the set still counts once here. Use this for the
 * cleanup dialog's "Delete selected" total, not a client-side sum of
 * per-workspace sole-owned figures.
 */
export function computeReclaimableBytesForWorkspaces(
  workspaceIds: string[],
): Promise<number> {
  return invoke("compute_reclaimable_bytes_for_workspaces", { workspaceIds });
}

export function scanOrphanedWorktrees(): Promise<OrphanedWorktree[]> {
  return invoke("scan_orphaned_worktrees");
}

export function purgeOrphanedWorktree(path: string): Promise<void> {
  return invoke("purge_orphaned_worktree", { path });
}
