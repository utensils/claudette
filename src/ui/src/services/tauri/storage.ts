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

export function scanOrphanedWorktrees(): Promise<OrphanedWorktree[]> {
  return invoke("scan_orphaned_worktrees");
}

export function purgeOrphanedWorktree(path: string): Promise<void> {
  return invoke("purge_orphaned_worktree", { path });
}
