import { invoke } from "@tauri-apps/api/core";
import type { Workspace } from "../../types";
import type { CreateWorkspaceResult, SetupResult } from "../../types/repository";
import type { WorkspaceEnvTrustNeededPayload } from "../../types/env";
import type { RepositoryInputValues } from "../../types/repositoryInput";

export function createWorkspace(
  repoId: string,
  name: string,
  skipSetup?: boolean,
  /** Values for the repo's declared `required_inputs`. Omit when the repo
   *  has no schema (the backend ignores the field in that case). */
  inputValues?: RepositoryInputValues | null,
): Promise<CreateWorkspaceResult> {
  return invoke("create_workspace", {
    repoId,
    name,
    skipSetup: skipSetup ?? false,
    inputValues: inputValues ?? null,
  });
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
  /**
   * IDs that were skipped because the user cancelled mid-batch. These
   * rows are untouched in the DB — re-running cleanup picks them up.
   * Empty when the run finished naturally.
   */
  cancelled: string[];
}

/**
 * `requestId` identifies the run for two purposes: (a) so the backend
 * can emit `bulk-cleanup-progress` events tagged with the same id, which
 * lets the modal filter out unrelated runs; and (b) so `cancelWorkspacesBulk`
 * can target this specific run. Generate a fresh UUID per click —
 * reusing one across clicks would let a stale cancel land on a new run.
 *
 * Pass `null` for headless / CLI-style use (no live progress, no cancel).
 */
export function deleteWorkspacesBulk(
  ids: string[],
  requestId: string | null,
): Promise<BulkDeleteResult> {
  return invoke("delete_workspaces_bulk", { ids, requestId });
}

/**
 * Cooperatively cancel a bulk delete in flight. Idempotent — flipping
 * a flag for an already-completed run is a no-op. Resolves to `true`
 * when a matching run was found and signalled, `false` otherwise.
 */
export function cancelWorkspacesBulk(requestId: string): Promise<boolean> {
  return invoke("cancel_workspaces_bulk", { requestId });
}

/**
 * Per-row payload from the `bulk-cleanup-progress` Tauri event. Emitted
 * once per workspace as the run iterates, in the same order the rows
 * are processed. `status` is one of:
 *   - `"deleted"` — DB row is gone; worktree/branch cleanup happens
 *     asynchronously after the event fires.
 *   - `"failed"` — DB delete refused (raced restore, SQLITE_BUSY, etc.);
 *     `error` carries the message.
 *   - `"cancelled"` — user clicked Cancel before this row was attempted;
 *     the DB is untouched.
 */
export interface BulkCleanupProgress {
  requestId: string;
  workspaceId: string;
  name: string;
  status: "deleted" | "failed" | "cancelled";
  error?: string;
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
