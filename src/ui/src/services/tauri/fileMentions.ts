import { invoke } from "@tauri-apps/api/core";
import type { FileStatus, GitFileLayer } from "../../types/diff";

export interface FileEntry {
  path: string;
  is_directory: boolean;
  git_status?: FileStatus | null;
  git_layer?: GitFileLayer | null;
}

export function listWorkspaceFiles(
  workspaceId: string,
): Promise<FileEntry[]> {
  return invoke("list_workspace_files", { workspaceId });
}
