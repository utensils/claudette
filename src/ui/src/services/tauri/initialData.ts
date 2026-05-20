import { invoke } from "@tauri-apps/api/core";
import type { ChatMessage, Repository, Workspace } from "../../types";
import type { ScmStatusCacheRow, WorkspaceScmLink } from "../../types/plugin";

export interface InitialData {
  repositories: Repository[];
  workspaces: Workspace[];
  worktree_base_dir: string;
  default_branches: Record<string, string>;
  last_messages: ChatMessage[];
  scm_cache: ScmStatusCacheRow[];
  /** Optional: a headless server older than this field omits it over
   *  WSS, and the bundle smoke-test mock does not synthesize it. */
  workspace_scm_links?: WorkspaceScmLink[];
  manual_workspace_order_repo_ids: string[];
}

export function loadInitialData(): Promise<InitialData> {
  return invoke("load_initial_data");
}
