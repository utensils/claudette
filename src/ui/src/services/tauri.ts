import { invoke } from "@tauri-apps/api/core";
import type {
  Repository,
  Workspace,
  ChatMessage,
  DiffFile,
  FileDiff,
  TerminalTab,
} from "../types";
import type {
  CreateWorkspaceResult,
  RepoConfigInfo,
} from "../types/repository";

// -- Data --

export interface InitialData {
  repositories: Repository[];
  workspaces: Workspace[];
  worktree_base_dir: string;
  default_branches: Record<string, string>;
  last_messages: ChatMessage[];
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
  icon: string | null,
  setupScript: string | null,
  customInstructions: string | null
): Promise<void> {
  return invoke("update_repository_settings", {
    id,
    name,
    icon,
    setupScript,
    customInstructions,
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

// -- Workspace --

export function createWorkspace(
  repoId: string,
  name: string
): Promise<CreateWorkspaceResult> {
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

export function openWorkspaceInTerminal(worktreePath: string): Promise<void> {
  return invoke("open_workspace_in_terminal", { worktreePath });
}

// -- Chat --

export function loadChatHistory(workspaceId: string): Promise<ChatMessage[]> {
  return invoke("load_chat_history", { workspaceId });
}

export function sendChatMessage(
  workspaceId: string,
  content: string,
  permissionLevel?: string,
  model?: string,
  fastMode?: boolean,
  thinkingEnabled?: boolean,
  planMode?: boolean
): Promise<void> {
  return invoke("send_chat_message", {
    workspaceId,
    content,
    permissionLevel: permissionLevel ?? null,
    model: model ?? null,
    fastMode: fastMode ?? null,
    thinkingEnabled: thinkingEnabled ?? null,
    planMode: planMode ?? null,
  });
}

export function stopAgent(workspaceId: string): Promise<void> {
  return invoke("stop_agent", { workspaceId });
}

export function resetAgentSession(workspaceId: string): Promise<void> {
  return invoke("reset_agent_session", { workspaceId });
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

// -- Remote --

import type {
  RemoteConnectionInfo,
  DiscoveredServer,
  PairResult,
} from "../types/remote";

export function listRemoteConnections(): Promise<RemoteConnectionInfo[]> {
  return invoke("list_remote_connections");
}

export function pairWithServer(
  host: string,
  port: number,
  pairingToken: string
): Promise<PairResult> {
  return invoke("pair_with_server", { host, port, pairingToken });
}

export function connectRemote(id: string): Promise<unknown> {
  return invoke("connect_remote", { id });
}

export function disconnectRemote(id: string): Promise<void> {
  return invoke("disconnect_remote", { id });
}

export function removeRemoteConnection(id: string): Promise<void> {
  return invoke("remove_remote_connection", { id });
}

export function listDiscoveredServers(): Promise<DiscoveredServer[]> {
  return invoke("list_discovered_servers");
}

export function addRemoteConnection(
  connectionString: string
): Promise<PairResult> {
  return invoke("add_remote_connection", { connectionString });
}
