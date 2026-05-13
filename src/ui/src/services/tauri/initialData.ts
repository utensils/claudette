import { invoke } from "@tauri-apps/api/core";
import type { ChatMessage, Repository, Workspace } from "../../types";
import type { ScmStatusCacheRow } from "../../types/plugin";

export interface InitialData {
  repositories: Repository[];
  workspaces: Workspace[];
  worktree_base_dir: string;
  default_branches: Record<string, string>;
  last_messages: ChatMessage[];
  scm_cache: ScmStatusCacheRow[];
  manual_workspace_order_repo_ids: string[];
}

export function loadInitialData(): Promise<InitialData> {
  return invoke("load_initial_data");
}
