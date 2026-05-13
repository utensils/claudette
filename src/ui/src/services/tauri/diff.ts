import { invoke } from "@tauri-apps/api/core";
import type { DiffFile, FileDiff } from "../../types";
import type {
  CommitEntry,
  DiffLayer,
  StagedDiffFiles,
} from "../../types/diff";

export interface DiffFilesResult {
  files: DiffFile[];
  merge_base: string;
  staged_files?: StagedDiffFiles | null;
  commits?: CommitEntry[];
}

export function loadDiffFiles(workspaceId: string): Promise<DiffFilesResult> {
  return invoke("load_diff_files", { workspaceId });
}

export function loadFileDiff(
  worktreePath: string,
  mergeBase: string,
  filePath: string,
  diffLayer?: DiffLayer,
): Promise<FileDiff> {
  return invoke("load_file_diff", {
    worktreePath,
    mergeBase,
    filePath,
    diffLayer: diffLayer ?? null,
  });
}

export function loadCommitFileDiff(
  worktreePath: string,
  commitHash: string,
  filePath: string,
): Promise<FileDiff> {
  return invoke("load_commit_file_diff", { worktreePath, commitHash, filePath });
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
