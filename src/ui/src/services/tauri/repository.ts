import { invoke } from "@tauri-apps/api/core";
import type { Repository } from "../../types";
import type { RepoConfigInfo } from "../../types/repository";

export function addRepository(path: string): Promise<Repository> {
  return invoke("add_repository", { path });
}

export function initRepository(parentPath: string, name: string): Promise<Repository> {
  return invoke("init_repository", { parentPath, name });
}

export function updateRepositorySettings(
  id: string,
  name: string,
  icon: string | null,
  setupScript: string | null,
  archiveScript: string | null,
  customInstructions: string | null,
  branchRenamePreferences: string | null,
  setupScriptAutoRun: boolean,
  archiveScriptAutoRun: boolean,
  baseBranch: string | null,
  defaultRemote: string | null
): Promise<void> {
  return invoke("update_repository_settings", {
    id,
    name,
    icon,
    setupScript,
    archiveScript,
    customInstructions,
    branchRenamePreferences,
    setupScriptAutoRun,
    archiveScriptAutoRun,
    baseBranch,
    defaultRemote,
  });
}

export function relinkRepository(id: string, path: string): Promise<void> {
  return invoke("relink_repository", { id, path });
}

export function removeRepository(id: string): Promise<void> {
  return invoke("remove_repository", { id });
}

export function getRepoConfig(repoId: string): Promise<RepoConfigInfo> {
  return invoke("get_repo_config", { repoId });
}

export function getDefaultBranch(repoId: string): Promise<string | null> {
  return invoke("get_default_branch", { repoId });
}

export function listGitRemotes(repoId: string): Promise<string[]> {
  return invoke("list_git_remotes", { repoId });
}

export function listGitRemoteBranches(repoId: string): Promise<string[]> {
  return invoke("list_git_remote_branches", { repoId });
}

export function reorderRepositories(ids: string[]): Promise<void> {
  return invoke("reorder_repositories", { ids });
}

export function setSetupScriptAutoRun(repoId: string, enabled: boolean): Promise<void> {
  return invoke("set_setup_script_auto_run", { repoId, enabled });
}

export function setArchiveScriptAutoRun(repoId: string, enabled: boolean): Promise<void> {
  return invoke("set_archive_script_auto_run", { repoId, enabled });
}
