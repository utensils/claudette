import { invoke } from "@tauri-apps/api/core";
import type { Workspace } from "../../types";
import type { CreateWorkspaceResult, SetupResult } from "../../types/repository";
import type { WorkspaceEnvTrustNeededPayload } from "../../types/env";

export function createWorkspace(
  repoId: string,
  name: string,
  skipSetup?: boolean
): Promise<CreateWorkspaceResult> {
  return invoke("create_workspace", { repoId, name, skipSetup: skipSetup ?? false });
}

export interface ForkWorkspaceResult {
  workspace: Workspace;
  session_resumed: boolean;
}

export function forkWorkspaceAtCheckpoint(
  workspaceId: string,
  checkpointId: string
): Promise<ForkWorkspaceResult> {
  return invoke("fork_workspace_at_checkpoint", { workspaceId, checkpointId });
}

export function runWorkspaceSetup(
  workspaceId: string
): Promise<SetupResult | null> {
  return invoke("run_workspace_setup", { workspaceId });
}

export function prepareWorkspaceEnvironment(
  workspaceId: string
): Promise<WorkspaceEnvTrustNeededPayload | null> {
  return invoke("prepare_workspace_environment", { workspaceId });
}

export function archiveWorkspace(id: string, skipArchiveScript?: boolean): Promise<boolean> {
  return invoke("archive_workspace", { id, skipArchiveScript: skipArchiveScript ?? false });
}

export function restoreWorkspace(id: string): Promise<string> {
  return invoke("restore_workspace", { id });
}

export function renameWorkspace(id: string, newName: string): Promise<void> {
  return invoke("rename_workspace", { id, newName });
}

/**
 * Reassign per-repository workspace sort_order to match the supplied id
 * sequence. Backend ignores ids that don't belong to `repositoryId`, so a
 * client bug can't move workspaces across repos.
 */
export function reorderWorkspaces(
  repositoryId: string,
  workspaceIds: string[],
): Promise<void> {
  return invoke("reorder_workspaces", { repositoryId, workspaceIds });
}

export function deleteWorkspace(id: string): Promise<void> {
  return invoke("delete_workspace", { id });
}

export interface BulkDeleteFailure {
  id: string;
  error: string;
}

export interface BulkDeleteResult {
  deleted: string[];
  failed: BulkDeleteFailure[];
}

export function deleteWorkspacesBulk(ids: string[]): Promise<BulkDeleteResult> {
  return invoke("delete_workspaces_bulk", { ids });
}

/**
 * Tell the Rust SCM polling loop which workspace the user is currently
 * viewing. Pass `null` when navigating to the dashboard or a repository
 * overview so the backend drops its hot-tier focus. Selection drives the
 * 30 s polling cadence for the focused workspace and lets idle workspaces
 * back off to longer tier intervals.
 */
export function notifyWorkspaceSelected(workspaceId: string | null): Promise<void> {
  return invoke("notify_workspace_selected", { workspaceId });
}

export interface GeneratedWorkspaceName {
  slug: string;
  display: string;
  message: string | null;
}

export function generateWorkspaceName(): Promise<GeneratedWorkspaceName> {
  return invoke("generate_workspace_name");
}

export function refreshBranches(): Promise<[string, string][]> {
  return invoke("refresh_branches");
}

export function refreshWorkspaceBranch(
  workspaceId: string,
): Promise<string | null> {
  return invoke("refresh_workspace_branch", { workspaceId });
}

export function openWorkspaceInTerminal(worktreePath: string): Promise<void> {
  return invoke("open_workspace_in_terminal", { worktreePath });
}

export function openInEditor(path: string): Promise<void> {
  return invoke("open_in_editor", { path });
}
