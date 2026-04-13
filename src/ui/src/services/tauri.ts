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
import type {
  RemoteConnectionInfo,
  DiscoveredServer,
  PairResult,
} from "../types/remote";
import type { DetectedApp } from "../types/apps";
import type { ClaudeCodeUsage } from "../types/usage";

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
  customInstructions: string | null,
  branchRenamePreferences: string | null
): Promise<void> {
  return invoke("update_repository_settings", {
    id,
    name,
    icon,
    setupScript,
    customInstructions,
    branchRenamePreferences,
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

export function reorderRepositories(ids: string[]): Promise<void> {
  return invoke("reorder_repositories", { ids });
}

// -- Workspace --

export function createWorkspace(
  repoId: string,
  name: string,
  skipSetup?: boolean
): Promise<CreateWorkspaceResult> {
  return invoke("create_workspace", { repoId, name, skipSetup: skipSetup ?? false });
}

export function runWorkspaceSetup(
  workspaceId: string
): Promise<import("../types/repository").SetupResult | null> {
  return invoke("run_workspace_setup", { workspaceId });
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

export function openWorkspaceInTerminal(worktreePath: string): Promise<void> {
  return invoke("open_workspace_in_terminal", { worktreePath });
}

// -- Slash Commands --

export interface SlashCommand {
  name: string;
  description: string;
  source: string;
}

export function listSlashCommands(
  projectPath?: string,
  workspaceId?: string,
): Promise<SlashCommand[]> {
  return invoke("list_slash_commands", {
    projectPath: projectPath ?? null,
    workspaceId: workspaceId ?? null,
  });
}

export function recordSlashCommandUsage(
  workspaceId: string,
  commandName: string,
): Promise<void> {
  return invoke("record_slash_command_usage", {
    workspaceId,
    commandName,
  });
}

// -- File Mentions --

export interface FileEntry {
  path: string;
  is_directory: boolean;
}

export function listWorkspaceFiles(
  workspaceId: string,
): Promise<FileEntry[]> {
  return invoke("list_workspace_files", { workspaceId });
}

// -- Chat --

export function loadChatHistory(workspaceId: string): Promise<ChatMessage[]> {
  return invoke("load_chat_history", { workspaceId });
}

export function sendChatMessage(
  workspaceId: string,
  content: string,
  mentionedFiles?: string[],
  permissionLevel?: string,
  model?: string,
  fastMode?: boolean,
  thinkingEnabled?: boolean,
  planMode?: boolean,
  effort?: string,
): Promise<void> {
  return invoke("send_chat_message", {
    workspaceId,
    content,
    mentionedFiles: mentionedFiles ?? null,
    permissionLevel: permissionLevel ?? null,
    model: model ?? null,
    fastMode: fastMode ?? null,
    thinkingEnabled: thinkingEnabled ?? null,
    planMode: planMode ?? null,
    effort: effort ?? null,
  });
}

export function stopAgent(workspaceId: string): Promise<void> {
  return invoke("stop_agent", { workspaceId });
}

export function resetAgentSession(workspaceId: string): Promise<void> {
  return invoke("reset_agent_session", { workspaceId });
}

export function clearAttention(workspaceId: string): Promise<void> {
  return invoke("clear_attention", { workspaceId });
}

// -- Checkpoints --

import type { ConversationCheckpoint } from "../types/checkpoint";

export function listCheckpoints(
  workspaceId: string,
): Promise<ConversationCheckpoint[]> {
  return invoke("list_checkpoints", { workspaceId });
}

export function rollbackToCheckpoint(
  workspaceId: string,
  checkpointId: string,
  restoreFiles: boolean,
): Promise<ChatMessage[]> {
  return invoke("rollback_to_checkpoint", {
    workspaceId,
    checkpointId,
    restoreFiles,
  });
}

export function clearConversation(
  workspaceId: string,
  restoreFiles: boolean,
): Promise<ChatMessage[]> {
  return invoke("clear_conversation", {
    workspaceId,
    restoreFiles,
  });
}

import type { TurnToolActivityData, CompletedTurnData } from "../types/checkpoint";

export function saveTurnToolActivities(
  checkpointId: string,
  messageCount: number,
  activities: TurnToolActivityData[],
): Promise<void> {
  return invoke("save_turn_tool_activities", {
    checkpointId,
    messageCount,
    activities,
  });
}

export function loadCompletedTurns(
  workspaceId: string,
): Promise<CompletedTurnData[]> {
  return invoke("load_completed_turns", { workspaceId });
}

// -- Plan --

export function readPlanFile(path: string): Promise<string> {
  return invoke("read_plan_file", { path });
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

import type { ThemeDefinition } from "../types/theme";

export function listUserThemes(): Promise<ThemeDefinition[]> {
  return invoke("list_user_themes");
}

export function getGitUsername(): Promise<string | null> {
  return invoke("get_git_username");
}

export function listNotificationSounds(): Promise<string[]> {
  return invoke("list_notification_sounds");
}

export function playNotificationSound(sound: string): Promise<void> {
  return invoke("play_notification_sound", { sound });
}

export function runNotificationCommand(
  title: string,
  body: string,
  workspaceId: string,
  workspaceName: string,
): Promise<void> {
  return invoke("run_notification_command", {
    title,
    body,
    workspaceId,
    workspaceName,
  });
}

// -- Remote --

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

import type { RemoteInitialData } from "../types/remote";

export function connectRemote(id: string): Promise<RemoteInitialData | null> {
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

export function sendRemoteCommand(
  connectionId: string,
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  return invoke("send_remote_command", { connectionId, method, params });
}

// -- Local Server --

export interface LocalServerInfo {
  running: boolean;
  connection_string: string | null;
}

export function startLocalServer(): Promise<LocalServerInfo> {
  return invoke("start_local_server");
}

export function stopLocalServer(): Promise<void> {
  return invoke("stop_local_server");
}

export function getLocalServerStatus(): Promise<LocalServerInfo> {
  return invoke("get_local_server_status");
}

// -- Apps --

export function detectInstalledApps(): Promise<DetectedApp[]> {
  return invoke("detect_installed_apps");
}

export function openWorkspaceInApp(appId: string, worktreePath: string): Promise<void> {
  return invoke("open_workspace_in_app", { appId, worktreePath });
}

// -- Usage --

export function getClaudeCodeUsage(): Promise<ClaudeCodeUsage> {
  return invoke("get_claude_code_usage");
}

export function openUsageSettings(): Promise<void> {
  return invoke("open_usage_settings");
}

// -- Debug (dev builds only) --

export function debugEvalJs(js: string): Promise<string> {
  return invoke("debug_eval_js", { js });
}

// Expose invoke on window in dev builds so debug_eval_js can call back.
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__CLAUDETTE_INVOKE__ = invoke;
}
