import { invoke } from "@tauri-apps/api/core";
import type { Workspace } from "../../types";

export interface DiscoveredWorktree {
  path: string;
  branch_name: string;
  head_sha: string;
  suggested_name: string;
  name_valid: boolean;
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
