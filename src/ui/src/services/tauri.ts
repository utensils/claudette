import { invoke } from "@tauri-apps/api/core";
import type {
  Repository,
  Workspace,
  ChatMessage,
  DiffFile,
  FileDiff,
  TerminalTab,
} from "../types";

// -- Data --

export interface InitialData {
  repositories: Repository[];
  workspaces: Workspace[];
  worktree_base_dir: string;
}

export function loadInitialData(): Promise<InitialData> {
  return invoke("load_initial_data");
}

// -- Repository --

export function addRepository(path: string): Promise<Repository> {
  return invoke("add_repository", { path });
}

export function updateRepositorySettings(
  id: string,
  name: string,
  icon: string | null
): Promise<void> {
  return invoke("update_repository_settings", { id, name, icon });
}

export function relinkRepository(id: string, path: string): Promise<void> {
  return invoke("relink_repository", { id, path });
}

export function removeRepository(id: string): Promise<void> {
  return invoke("remove_repository", { id });
}

// -- Workspace --

export function createWorkspace(
  repoId: string,
  name: string
): Promise<Workspace> {
  return invoke("create_workspace", { repoId, name });
}

export function archiveWorkspace(id: string): Promise<void> {
  return invoke("archive_workspace", { id });
}

export function restoreWorkspace(id: string): Promise<string> {
  return invoke("restore_workspace", { id });
}

export function deleteWorkspace(id: string): Promise<void> {
  return invoke("delete_workspace", { id });
}

export function generateWorkspaceName(): Promise<string> {
  return invoke("generate_workspace_name");
}

export function refreshBranches(): Promise<[string, string][]> {
  return invoke("refresh_branches");
}

// -- Chat --

export function loadChatHistory(workspaceId: string): Promise<ChatMessage[]> {
  return invoke("load_chat_history", { workspaceId });
}

export function sendChatMessage(
  workspaceId: string,
  content: string
): Promise<void> {
  return invoke("send_chat_message", { workspaceId, content });
}

export function stopAgent(workspaceId: string): Promise<void> {
  return invoke("stop_agent", { workspaceId });
}

// -- Diff --

export interface DiffFilesResult {
  files: DiffFile[];
  merge_base: string;
}

export function loadDiffFiles(workspaceId: string): Promise<DiffFilesResult> {
  return invoke("load_diff_files", { workspaceId });
}

export function loadFileDiff(
  worktreePath: string,
  mergeBase: string,
  filePath: string
): Promise<FileDiff> {
  return invoke("load_file_diff", { worktreePath, mergeBase, filePath });
}

export function revertFile(
  worktreePath: string,
  mergeBase: string,
  filePath: string,
  status: string
): Promise<void> {
  return invoke("revert_file", { worktreePath, mergeBase, filePath, status });
}

// -- Terminal --

export function createTerminalTab(
  workspaceId: string
): Promise<TerminalTab> {
  return invoke("create_terminal_tab", { workspaceId });
}

export function deleteTerminalTab(id: number): Promise<void> {
  return invoke("delete_terminal_tab", { id });
}

export function listTerminalTabs(
  workspaceId: string
): Promise<TerminalTab[]> {
  return invoke("list_terminal_tabs", { workspaceId });
}

// -- PTY --

export function spawnPty(workingDir: string): Promise<number> {
  return invoke("spawn_pty", { workingDir });
}

export function writePty(ptyId: number, data: number[]): Promise<void> {
  return invoke("write_pty", { ptyId, data });
}

export function resizePty(
  ptyId: number,
  cols: number,
  rows: number
): Promise<void> {
  return invoke("resize_pty", { ptyId, cols, rows });
}

export function closePty(ptyId: number): Promise<void> {
  return invoke("close_pty", { ptyId });
}

// -- Settings --

export function getAppSetting(key: string): Promise<string | null> {
  return invoke("get_app_setting", { key });
}

export function setAppSetting(key: string, value: string): Promise<void> {
  return invoke("set_app_setting", { key, value });
}
