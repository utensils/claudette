import { invoke } from "@tauri-apps/api/core";
import type { Workspace } from "../../types";

export interface DiscoveredWorktree {
  path: string;
  branch_name: string;
  head_sha: string;
  suggested_name: string;
  name_valid: boolean;
  size_bytes: number | null;
}

export function discoverWorktrees(repoId: string): Promise<DiscoveredWorktree[]> {
  return invoke("discover_worktrees", { repoId });
}

export interface WorktreeImport {
  path: string;
  branch_name: string;
  name: string;
}

export function importWorktrees(
  repoId: string,
  imports: WorktreeImport[]
): Promise<Workspace[]> {
  return invoke("import_worktrees", { repoId, imports });
}

export function purgeStrayWorktree(
  repoId: string,
  path: string
): Promise<void> {
  return invoke("purge_stray_worktree", { repoId, path });
}
