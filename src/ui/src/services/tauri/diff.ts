import { invoke } from "@tauri-apps/api/core";
import type { DiffFile, FileDiff } from "../../types";
import type {
  CommitEntry,
  DiffLayer,
  StagedDiffFiles,
} from "../../types/diff";
import { viaWorkspace } from "./remoteRouting";

export interface DiffFilesResult {
  files: DiffFile[];
  merge_base: string;
  staged_files?: StagedDiffFiles | null;
  commits?: CommitEntry[];
}

export function loadDiffFiles(workspaceId: string): Promise<DiffFilesResult> {
  return viaWorkspace(workspaceId, "load_diff_files", {}, () =>
    invoke("load_diff_files", { workspaceId }),
  );
}

/**
 * Load one file's diff. Pass `workspaceId` so a remote workspace's diff is
 * read on its own machine (the worktree path is a path over there).
 */
export function loadFileDiff(
  worktreePath: string,
  mergeBase: string,
  filePath: string,
  diffLayer?: DiffLayer,
  workspaceId?: string,
): Promise<FileDiff> {
  const local = () =>
    invoke<FileDiff>("load_file_diff", {
      worktreePath,
      mergeBase,
      filePath,
      diffLayer: diffLayer ?? null,
    });
  if (!workspaceId) return local();
  return viaWorkspace(
    workspaceId,
    "load_file_diff",
    {
      worktree_path: worktreePath,
      merge_base: mergeBase,
      file_path: filePath,
      diff_layer: diffLayer ?? null,
    },
    local,
  );
}

/** One file's diff within a commit; `workspaceId` routes it like `loadFileDiff`. */
export function loadCommitFileDiff(
  worktreePath: string,
  commitHash: string,
  filePath: string,
  workspaceId?: string,
): Promise<FileDiff> {
  const local = () =>
    invoke<FileDiff>("load_commit_file_diff", {
      worktreePath,
      commitHash,
      filePath,
    });
  if (!workspaceId) return local();
  return viaWorkspace(
    workspaceId,
    "load_commit_file_diff",
    {
      worktree_path: worktreePath,
      commit_hash: commitHash,
      file_path: filePath,
    },
    local,
  );
}

export function revertFile(
  worktreePath: string,
  mergeBase: string,
  filePath: string,
  status: string
): Promise<void> {
  return invoke("revert_file", { worktreePath, mergeBase, filePath, status });
}

export function computeWorkspaceMergeBase(
  workspaceId: string,
): Promise<string> {
  return invoke("compute_workspace_merge_base", { workspaceId });
}

export function discardFile(
  worktreePath: string,
  filePath: string,
  isUntracked: boolean
): Promise<void> {
  return invoke("discard_file", { worktreePath, filePath, isUntracked });
}

export function stageFile(
  worktreePath: string,
  filePath: string,
): Promise<void> {
  return invoke("stage_file", { worktreePath, filePath });
}

export function unstageFile(
  worktreePath: string,
  filePath: string,
): Promise<void> {
  return invoke("unstage_file", { worktreePath, filePath });
}

export function stageFiles(
  worktreePath: string,
  filePaths: string[],
): Promise<void> {
  return invoke("stage_files", { worktreePath, filePaths });
}

export function unstageFiles(
  worktreePath: string,
  filePaths: string[],
): Promise<void> {
  return invoke("unstage_files", { worktreePath, filePaths });
}

export function discardFiles(
  worktreePath: string,
  tracked: string[],
  untracked: string[],
): Promise<void> {
  return invoke("discard_files", { worktreePath, tracked, untracked });
}
