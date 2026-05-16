import { invoke } from "@tauri-apps/api/core";

export interface FileContent {
  path: string;
  content: string | null;
  is_binary: boolean;
  size_bytes: number;
  truncated: boolean;
  /** True when the file path is itself a symlink on disk (the viewer
   *  reads through it, so `content` is the resolved target's text).
   *  Drives the git-gutter skip in `useGitGutter` — git stores symlinks
   *  as the literal target string, which would otherwise paint a solid
   *  "modified" stripe down every line. */
  is_symlink: boolean;
}

export interface FileBytesContent {
  path: string;
  bytes_b64: string;
  size_bytes: number;
  truncated: boolean;
}

export function readWorkspaceFile(
  workspaceId: string,
  relativePath: string,
): Promise<FileContent> {
  return invoke("read_workspace_file", { workspaceId, relativePath });
}

export function readWorkspaceFileForViewer(
  workspaceId: string,
  relativePath: string,
): Promise<FileContent> {
  return invoke("read_workspace_file_for_viewer", {
    workspaceId,
    relativePath,
  });
}

/** Replace the watch set for `workspaceId` with `paths`. Idempotent —
 *  the file-viewer hook re-asserts the full open-tab list whenever
 *  files are opened or closed. The backend's `FileWatcher` deduplicates
 *  paths and emits `workspace-file-changed` events on change. */
export function watchWorkspaceFiles(
  workspaceId: string,
  paths: string[],
): Promise<void> {
  return invoke("watch_workspace_files", { workspaceId, paths });
}

/** Drop every file watch belonging to `workspaceId`. Called when a
 *  workspace is deleted or archived; the active-workspace switch path
 *  uses `watchWorkspaceFiles` to install the new set, which implicitly
 *  drops paths the previous workspace cared about. */
export function unwatchWorkspaceFiles(workspaceId: string): Promise<void> {
  return invoke("unwatch_workspace_files", { workspaceId });
}

export function readWorkspaceFileBytes(
  workspaceId: string,
  relativePath: string,
): Promise<FileBytesContent> {
  return invoke("read_workspace_file_bytes", { workspaceId, relativePath });
}

export interface BlobAtRevisionContent {
  path: string;
  revision: string;
  content: string | null;
  exists_at_revision: boolean;
}

export function readWorkspaceFileAtRevision(
  workspaceId: string,
  relativePath: string,
  revision: string,
): Promise<BlobAtRevisionContent> {
  return invoke("read_workspace_file_at_revision", {
    workspaceId,
    relativePath,
    revision,
  });
}

export function writeWorkspaceFile(
  workspaceId: string,
  relativePath: string,
  content: string,
): Promise<void> {
  return invoke("write_workspace_file", {
    workspaceId,
    relativePath,
    content,
  });
}

export interface WorkspacePathMoveResult {
  old_path: string;
  new_path: string;
  is_directory: boolean;
}

export interface WorkspacePathTrashResult {
  old_path: string;
  is_directory: boolean;
  undo_token: string | null;
}

export interface WorkspacePathCreateResult {
  path: string;
}

export interface WorkspacePathRestoreResult {
  restored_path: string;
  is_directory: boolean;
}

export function resolveWorkspacePath(
  workspaceId: string,
  relativePath: string,
): Promise<string> {
  return invoke("resolve_workspace_path", { workspaceId, relativePath });
}

export function openWorkspacePath(
  workspaceId: string,
  relativePath: string,
): Promise<void> {
  return invoke("open_workspace_path", { workspaceId, relativePath });
}

export function revealWorkspacePath(
  workspaceId: string,
  relativePath: string,
): Promise<void> {
  return invoke("reveal_workspace_path", { workspaceId, relativePath });
}

export function createWorkspaceFile(
  workspaceId: string,
  parentRelativePath: string,
  name: string,
): Promise<WorkspacePathCreateResult> {
  return invoke("create_workspace_file", {
    workspaceId,
    parentRelativePath,
    name,
  });
}

export function renameWorkspacePath(
  workspaceId: string,
  relativePath: string,
  newName: string,
): Promise<WorkspacePathMoveResult> {
  return invoke("rename_workspace_path", {
    workspaceId,
    relativePath,
    newName,
  });
}

export function trashWorkspacePath(
  workspaceId: string,
  relativePath: string,
): Promise<WorkspacePathTrashResult> {
  return invoke("trash_workspace_path", { workspaceId, relativePath });
}

export function restoreWorkspacePathFromTrash(
  workspaceId: string,
  relativePath: string,
  undoToken: string | null,
): Promise<WorkspacePathRestoreResult> {
  return invoke("restore_workspace_path_from_trash", {
    workspaceId,
    relativePath,
    undoToken,
  });
}
